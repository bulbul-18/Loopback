require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, initSchema } = require('./db');
const { fetchRecentAccepted, fetchProblemDetailsWithRetry, sleep } = require('./leetcode');
const { router: authRouter, requireAuth, issueToken, passport, googleEnabled } = require('./auth');

const app = express();

// When deployed behind a reverse proxy (Render, Railway, etc.), this tells
// Express to read the real client IP from X-Forwarded-For instead of seeing
// every request as coming from the proxy -- otherwise rate limiting below
// would lump all users together as one "IP".
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MIN_REVISIONS_FOR_MASTERY = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const today = () => new Date().toISOString().slice(0, 10);
const resolveToday = (clientDate) => (clientDate && DATE_RE.test(clientDate) ? clientDate : today());
const addDays = (dateStr, days) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Auth routes (register / login / logout / me) -- unprotected by design
// ---------------------------------------------------------------------------
app.use('/api/auth', authRouter);

// Google OAuth entry + callback (only mounted if credentials are configured)
if (googleEnabled) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
  app.get(
    '/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login.html?error=google' }),
    (req, res) => {
      issueToken(res, req.user.id);
      res.redirect('/app.html'); // back to the app, now signed in
    }
  );
}

// Everything below this line requires a signed-in user.
app.use('/api/sync', requireAuth);
app.use('/api/queue', requireAuth);
app.use('/api/problems', requireAuth);
app.use('/api/mastered', requireAuth);
app.use('/api/dashboard', requireAuth);
app.use('/api/account', requireAuth);

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------
app.post('/api/sync', async (req, res) => {
  const userResult = await pool.query('SELECT leetcode_username FROM users WHERE id = $1', [req.userId]);
  const username = userResult.rows[0]?.leetcode_username;

  if (!username) {
    return res.status(400).json({
      error: 'Set your LeetCode username under Settings before syncing.',
    });
  }

  try {
    const stateResult = await pool.query('SELECT last_synced_at FROM sync_state WHERE user_id = $1', [req.userId]);
    const lastSyncedAt = stateResult.rows[0]?.last_synced_at ? new Date(stateResult.rows[0].last_synced_at) : null;

    const recent = await fetchRecentAccepted(username, 40);
    const newOnes = recent.filter((s) => !lastSyncedAt || s.acceptedAt > lastSyncedAt);

    let inserted = 0;
    let skipped = 0;
    for (const s of newOnes) {
      const exists = await pool.query(
        'SELECT 1 FROM problems WHERE user_id = $1 AND title_slug = $2',
        [req.userId, s.titleSlug]
      );
      if (exists.rows.length) continue; // already tracked

      let details = { leetcodeId: null, difficulty: null };
      try {
        details = await fetchProblemDetailsWithRetry(s.titleSlug);
      } catch (err) {
        console.warn(`Could not fetch details for "${s.titleSlug}":`, err.message);
        skipped += 1;
      }

      await pool.query(
        `INSERT INTO problems (user_id, leetcode_id, title_slug, title, url, difficulty, solved_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_tag')
         ON CONFLICT (user_id, title_slug) DO NOTHING`,
        [req.userId, details.leetcodeId, s.titleSlug, s.title, `https://leetcode.com/problems/${s.titleSlug}/`, details.difficulty, s.acceptedAt.toISOString()]
      );
      inserted += 1;

      await sleep(250); // stay polite to LeetCode's unauthenticated endpoint
    }

    await pool.query(
      `INSERT INTO sync_state (user_id, last_synced_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET last_synced_at = EXCLUDED.last_synced_at`,
      [req.userId, new Date().toISOString()]
    );

    res.json({ synced: true, newProblems: inserted, detailsSkipped: skipped });
  } catch (err) {
    console.error('Sync failed:', err);
    res.status(502).json({ error: 'Sync with LeetCode failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/queue/tag
// ---------------------------------------------------------------------------
app.get('/api/queue/tag', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM problems WHERE user_id = $1 AND status = 'pending_tag' ORDER BY solved_at DESC`,
    [req.userId]
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------------
// POST /api/problems/:id/tag  { solve_method }
// ---------------------------------------------------------------------------
app.post('/api/problems/:id/tag', async (req, res) => {
  const { solve_method, client_today } = req.body;
  const methodResult = await pool.query('SELECT * FROM solve_method_intervals WHERE solve_method = $1', [solve_method]);
  const method = methodResult.rows[0];
  if (!method) return res.status(400).json({ error: 'Unknown solve_method' });

  const problemResult = await pool.query('SELECT * FROM problems WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const problem = problemResult.rows[0];
  if (!problem) return res.status(404).json({ error: 'Problem not found' });

  const interval = method.initial_interval_days;
  const nextDate = addDays(resolveToday(client_today), interval);

  await pool.query(
    `UPDATE problems SET
       solve_method = $1, tagged_at = now(),
       current_interval_days = $2, next_revision_date = $3,
       status = 'active', updated_at = now()
     WHERE id = $4`,
    [solve_method, interval, nextDate, problem.id]
  );

  const updated = await pool.query('SELECT * FROM problems WHERE id = $1', [problem.id]);
  res.json(updated.rows[0]);
});

// ---------------------------------------------------------------------------
// GET /api/queue/revision?date=YYYY-MM-DD
// ---------------------------------------------------------------------------
app.get('/api/queue/revision', async (req, res) => {
  const date = resolveToday(req.query.date);
  const result = await pool.query(
    `SELECT * FROM problems
     WHERE user_id = $1 AND status = 'active' AND next_revision_date <= $2
     ORDER BY next_revision_date ASC`,
    [req.userId, date]
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------------
// POST /api/problems/:id/revise  { rating }
// ---------------------------------------------------------------------------
app.post('/api/problems/:id/revise', async (req, res) => {
  const { rating, client_today } = req.body;
  if (!['nailed_it', 'shaky', 'forgot'].includes(rating)) {
    return res.status(400).json({ error: 'rating must be nailed_it, shaky, or forgot' });
  }

  const problemResult = await pool.query('SELECT * FROM problems WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const problem = problemResult.rows[0];
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  if (problem.status !== 'active') return res.status(400).json({ error: 'Problem is not in active revision' });

  const before = problem.current_interval_days || 1;
  let after;
  if (rating === 'nailed_it') after = before * 2;
  else if (rating === 'shaky') after = before + 1;
  else after = 1;

  const revisionCount = problem.revision_count + 1;

  const priorResult = await pool.query(
    'SELECT rating FROM revisions WHERE problem_id = $1 ORDER BY revised_at DESC LIMIT 1',
    [problem.id]
  );
  const lastTwoNailed = rating === 'nailed_it' && priorResult.rows[0]?.rating === 'nailed_it';
  const masteredEligible = revisionCount >= MIN_REVISIONS_FOR_MASTERY && lastTwoNailed;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO revisions (problem_id, rating, interval_before_days, interval_after_days)
       VALUES ($1, $2, $3, $4)`,
      [problem.id, rating, before, after]
    );
    await client.query(
      `UPDATE problems SET
         revision_count = $1, current_interval_days = $2, next_revision_date = $3,
         mastered_eligible = CASE WHEN $4 THEN TRUE ELSE mastered_eligible END,
         updated_at = now()
       WHERE id = $5`,
      [revisionCount, after, addDays(resolveToday(client_today), after), masteredEligible, problem.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await pool.query('SELECT * FROM problems WHERE id = $1', [problem.id]);
  res.json(updated.rows[0]);
});

// ---------------------------------------------------------------------------
// POST /api/problems/:id/master
// ---------------------------------------------------------------------------
app.post('/api/problems/:id/master', async (req, res) => {
  const problemResult = await pool.query('SELECT * FROM problems WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const problem = problemResult.rows[0];
  if (!problem) return res.status(404).json({ error: 'Problem not found' });
  if (!problem.mastered_eligible) {
    return res.status(400).json({
      error: `Needs at least ${MIN_REVISIONS_FOR_MASTERY} revisions with recent "nailed it" ratings before it can be mastered.`,
    });
  }

  await pool.query(
    `UPDATE problems SET status = 'mastered', mastered_at = now(), updated_at = now() WHERE id = $1`,
    [problem.id]
  );
  const updated = await pool.query('SELECT * FROM problems WHERE id = $1', [problem.id]);
  res.json(updated.rows[0]);
});

// ---------------------------------------------------------------------------
// POST /api/problems/:id/unmaster
// ---------------------------------------------------------------------------
app.post('/api/problems/:id/unmaster', async (req, res) => {
  const problemResult = await pool.query('SELECT * FROM problems WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const problem = problemResult.rows[0];
  if (!problem) return res.status(404).json({ error: 'Problem not found' });

  await pool.query(
    `UPDATE problems SET
       status = 'active', mastered_at = NULL, mastered_eligible = FALSE,
       next_revision_date = $1, current_interval_days = 1, updated_at = now()
     WHERE id = $2`,
    [resolveToday(req.body.client_today), problem.id]
  );
  const updated = await pool.query('SELECT * FROM problems WHERE id = $1', [problem.id]);
  res.json(updated.rows[0]);
});

// ---------------------------------------------------------------------------
// GET /api/mastered?q=
// ---------------------------------------------------------------------------
app.get('/api/mastered', async (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%';
  const result = await pool.query(
    `SELECT * FROM problems WHERE user_id = $1 AND status = 'mastered' AND title ILIKE $2 ORDER BY mastered_at DESC`,
    [req.userId, q]
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------------
// GET /api/dashboard?date=
// ---------------------------------------------------------------------------
app.get('/api/dashboard', async (req, res) => {
  const date = resolveToday(req.query.date);
  const [due, overdue, pending, active, mastered, sync, account, revisions7d, tagged7d] = await Promise.all([
    pool.query(`SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND status = 'active' AND next_revision_date <= $2`, [req.userId, date]),
    pool.query(`SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND status = 'active' AND next_revision_date < $2`, [req.userId, date]),
    pool.query(`SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND status = 'pending_tag'`, [req.userId]),
    pool.query(`SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND status = 'active'`, [req.userId]),
    pool.query(`SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND status = 'mastered'`, [req.userId]),
    pool.query(`SELECT last_synced_at FROM sync_state WHERE user_id = $1`, [req.userId]),
    pool.query(`SELECT leetcode_username FROM users WHERE id = $1`, [req.userId]),
    pool.query(
      `SELECT COUNT(*) c FROM revisions r JOIN problems p ON p.id = r.problem_id
       WHERE p.user_id = $1 AND r.revised_at >= now() - interval '7 days'`,
      [req.userId]
    ),
    pool.query(
      `SELECT COUNT(*) c FROM problems WHERE user_id = $1 AND tagged_at >= now() - interval '7 days'`,
      [req.userId]
    ),
  ]);

  res.json({
    dueToday: Number(due.rows[0].c),
    overdue: Number(overdue.rows[0].c),
    pendingTag: Number(pending.rows[0].c),
    activeTotal: Number(active.rows[0].c),
    masteredTotal: Number(mastered.rows[0].c),
    lastSynced: sync.rows[0]?.last_synced_at || null,
    revisionsLast7Days: Number(revisions7d.rows[0].c),
    taggedLast7Days: Number(tagged7d.rows[0].c),
    leetcodeUsername: account.rows[0]?.leetcode_username || null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/account/reset -- wipes this user's problems/revisions, keeps login
// ---------------------------------------------------------------------------

app.patch('/api/account', async (req, res) => {
  const { leetcode_username } = req.body;
  await pool.query('UPDATE users SET leetcode_username = $1 WHERE id = $2', [leetcode_username || null, req.userId]);
  res.json({ leetcode_username: leetcode_username || null });
});

app.post('/api/account/reset', async (req, res) => {
  await pool.query('DELETE FROM problems WHERE user_id = $1', [req.userId]); // revisions cascade
  await pool.query('UPDATE sync_state SET last_synced_at = NULL WHERE user_id = $1', [req.userId]);
  res.json({ reset: true });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`LoopBack running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err.message);
    process.exit(1);
  });
