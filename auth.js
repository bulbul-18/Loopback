const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'loopback_token';
const SALT_ROUNDS = 12;

if (!JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
}

function issueToken(res, userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// Attaches req.userId if the request carries a valid session cookie,
// otherwise responds 401. Every /api/* data route sits behind this.
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired -- please sign in again' });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Brute-force protection: after 8 failed/attempted logins from the same IP
// within 15 minutes, block further attempts for the rest of that window.
// Counts every request (not just failures) so an attacker can't sidestep it
// by mixing in occasional valid-looking requests.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

// Looser limit on registration -- mainly to slow down mass fake-account
// creation, not a real user's normal behavior.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Try again later.' },
});

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/auth/register  { email, password }
// ---------------------------------------------------------------------------
router.post('/register', registerLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, leetcode_username`,
    [email.toLowerCase(), passwordHash]
  );
  const user = inserted.rows[0];
  await pool.query('INSERT INTO sync_state (user_id) VALUES ($1)', [user.id]);

  issueToken(res, user.id);
  res.status(201).json({ user });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login  { email, password }
// ---------------------------------------------------------------------------
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = result.rows[0];

  if (!user || !user.password_hash) {
    // Same generic message whether the account doesn't exist or was
    // Google-only -- don't leak which case it is.
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect email or password' });

  issueToken(res, user.id);
  res.json({ user: { id: user.id, email: user.email, leetcode_username: user.leetcode_username } });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ loggedOut: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me -- who am I, used by the frontend on load to check session
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT id, email, leetcode_username FROM users WHERE id = $1',
    [req.userId]
  );
  if (!result.rows[0]) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: result.rows[0] });
});

// ---------------------------------------------------------------------------
// Google OAuth -- only wired up if credentials are present in .env
// ---------------------------------------------------------------------------
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleEnabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();

          let { rows } = await pool.query('SELECT * FROM users WHERE google_id = $1', [profile.id]);
          let user = rows[0];

          if (!user && email) {
            // Same email already registered via password -- link the
            // Google identity to that existing account instead of
            // creating a duplicate.
            const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
            if (byEmail.rows[0]) {
              user = byEmail.rows[0];
              await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.id, user.id]);
            }
          }

          if (!user) {
            const inserted = await pool.query(
              `INSERT INTO users (email, google_id) VALUES ($1, $2) RETURNING *`,
              [email, profile.id]
            );
            user = inserted.rows[0];
            await pool.query('INSERT INTO sync_state (user_id) VALUES ($1)', [user.id]);
          }

          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );
}

// ---------------------------------------------------------------------------
// GET /api/auth/config -- tells the frontend whether Google sign-in is available
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  res.json({ googleEnabled });
});

module.exports = { router, requireAuth, issueToken, COOKIE_NAME, passport, googleEnabled };