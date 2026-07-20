// ---------- auth guard ----------
// Every page load checks the session first. No valid cookie -> bounce to login
// before any data panels try to render.
let currentUser = null;
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('not signed in');
    const data = await res.json();
    currentUser = data.user;
  } catch {
    location.href = '/login.html';
    throw new Error('redirecting to login');
  }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// Local (browser) date in YYYY-MM-DD -- sent to the server so "today" always
// matches the user's actual timezone, not the server's.
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const api = {
  get: (url) => fetch(url).then((r) => r.json()),
  post: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(body || {}), client_today: localToday() }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Request failed');
      return data;
    }),
};

// ---------- toast notifications (replaces alert()) ----------
function showToast(message, kind = 'error') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-out'), 3200);
  setTimeout(() => toast.remove(), 3600);
}

// Wraps a button's click handler so a slow/duplicate click can't fire the
// same request twice, and shows a lightweight loading state meanwhile.
function withLoading(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return; // already in flight -- ignore repeat clicks
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  };
}

const SOLVE_METHODS = [
  { key: 'self_solved', label: 'Solved it myself' },
  { key: 'hint_assisted', label: 'Needed a hint' },
  { key: 'learned_then_implemented', label: 'Learned, then implemented' },
  { key: 'looked_up_solution', label: 'Looked up the solution' },
];

// ---------- tab switching ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- sync ----------
const syncBtn = document.getElementById('syncBtn');
syncBtn.addEventListener(
  'click',
  withLoading(syncBtn, async () => {
    const status = document.getElementById('syncStatus');
    status.textContent = 'syncing…';
    try {
      const result = await api.post('/api/sync');
      status.textContent = `synced — ${result.newProblems} new`;
      if (result.detailsSkipped) {
        showToast(`Synced, but ${result.detailsSkipped} problem(s) are missing difficulty info — LeetCode was slow to respond. Sync again later to fill it in.`, 'warn');
      }
      await refreshAll();
    } catch (e) {
      status.textContent = 'sync failed';
      throw e; // let withLoading show the toast
    }
  })
);

// ---------- dashboard ----------
async function loadDashboard() {
  const d = await api.get('/api/dashboard?date=' + localToday());
  document.getElementById('dueTodayBig').textContent = d.dueToday;
  document.getElementById('statPending').textContent = d.pendingTag;
  document.getElementById('statActive').textContent = d.activeTotal;
  document.getElementById('statMastered').textContent = d.masteredTotal;
  document.getElementById('tagCount').textContent = d.pendingTag || '';
  document.getElementById('dueCount').textContent = d.dueToday || '';
  document.getElementById('syncStatus').textContent = d.lastSynced
    ? 'last synced ' + timeAgo(d.lastSynced)
    : 'not synced yet';
  document.getElementById('weekRevisions').textContent = d.revisionsLast7Days;
  document.getElementById('weekTagged').textContent = d.taggedLast7Days;

  const overdueNote = document.getElementById('overdueNote');
  if (d.overdue > 0) {
    overdueNote.textContent = `(${d.overdue} overdue)`;
    overdueNote.hidden = false;
  } else {
    overdueNote.hidden = true;
  }
}

// ---------- greeting + quote (dashboard header, no backend needed) ----------
function renderGreeting() {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const name = currentUser?.email ? currentUser.email.split('@')[0] : 'there';
  document.getElementById('greetingTitle').textContent = `Good ${timeOfDay}, ${name}`;
}

const QUOTES = [
  'Revision today, recall tomorrow.',
  'You already solved it once — trust that.',
  'Forgetting is normal. Revisiting is the whole point.',
  'Slow recall now beats no recall in an interview.',
  'A problem isn\u2019t learned until you\u2019ve forgotten it and found it again.',
];
function renderQuote() {
  // Deterministic per day, not random per reload -- feels intentional, not flickery.
  const dayIndex = Math.floor(Date.now() / 86400000);
  document.getElementById('quoteBox').textContent = '"' + QUOTES[dayIndex % QUOTES.length] + '"';
}

// ---------- dashboard preview lists (top 5 of real queue data, no new endpoints) ----------
function renderPreviewList(containerId, items, kind) {
  const container = document.getElementById(containerId);
  const tmpl = document.getElementById('previewRowTemplate');
  container.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'preview-empty';
    empty.textContent = kind === 'revision' ? 'Nothing due right now.' : 'Nothing waiting to be tagged.';
    container.appendChild(empty);
    return;
  }

  items.slice(0, 5).forEach((p) => {
    const node = tmpl.content.cloneNode(true);
    node.querySelector('.preview-row-title').textContent = p.title;

    if (kind === 'revision') {
      const isOverdue = p.next_revision_date < localToday();
      const isToday = p.next_revision_date === localToday();
      const dot = node.querySelector('.preview-dot');
      if (!isOverdue) dot.classList.add(isToday ? 'due-soon' : 'due-later');
      node.querySelector('.preview-row-meta').textContent = p.difficulty || '';
      node.querySelector('.preview-row-right').textContent = isOverdue ? 'Overdue' : isToday ? 'Today' : p.next_revision_date;
    } else {
      node.querySelector('.preview-dot').classList.add('due-later');
      node.querySelector('.preview-row-meta').textContent = p.difficulty || '';
      node.querySelector('.preview-row-right').textContent = timeAgo(p.solved_at);
    }

    container.appendChild(node);
  });
}

// "View all" links jump to the relevant tab
document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetTab = document.querySelector(`.tab[data-tab="${btn.dataset.goto}"]`);
    if (targetTab) targetTab.click();
  });
});

document.getElementById('quickSyncBtn').addEventListener('click', () => syncBtn.click());

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------- tag queue ----------
async function loadTagQueue() {
  const items = await api.get('/api/queue/tag');
  const list = document.getElementById('tagList');
  const tmpl = document.getElementById('tagCardTemplate');
  list.innerHTML = '';
  document.getElementById('tagEmpty').hidden = items.length > 0;

  renderPreviewList('previewTagList', items, 'tag');

  items.forEach((p) => {
    const node = tmpl.content.cloneNode(true);
    node.querySelector('.card-title').textContent = p.title;
    node.querySelector('.card-meta').innerHTML =
      (p.difficulty ? `<span class="difficulty ${p.difficulty}">${p.difficulty}</span>` : '') +
      new Date(p.solved_at).toLocaleDateString();

    const row = node.querySelector('.method-row');
    SOLVE_METHODS.forEach((m) => {
      const btn = document.createElement('button');
      btn.className = 'method-btn';
      btn.textContent = m.label;
      btn.addEventListener(
        'click',
        withLoading(btn, async () => {
          await api.post(`/api/problems/${p.id}/tag`, { solve_method: m.key });
          await refreshAll();
        })
      );
      row.appendChild(btn);
    });

    list.appendChild(node);
  });
}

// ---------- revision queue ----------
async function loadRevisionQueue() {
  const items = await api.get('/api/queue/revision?date=' + localToday());
  const list = document.getElementById('revisionList');
  const tmpl = document.getElementById('revisionCardTemplate');
  list.innerHTML = '';
  document.getElementById('revisionEmpty').hidden = items.length > 0;

  renderPreviewList('previewRevisionList', items, 'revision');

  items.forEach((p) => {
    const node = tmpl.content.cloneNode(true);
    node.querySelector('.card-title').textContent = p.title;
    const isOverdue = p.next_revision_date < localToday();
    node.querySelector('.card-meta').innerHTML =
      (p.difficulty ? `<span class="difficulty ${p.difficulty}">${p.difficulty}</span>` : '') +
      `revision #${p.revision_count + 1} · last gap ${p.current_interval_days}d` +
      (isOverdue ? ` <span class="stamp">overdue</span>` : '');

    node.querySelectorAll('.rate-btn').forEach((btn) => {
      btn.addEventListener(
        'click',
        withLoading(btn, async () => {
          await api.post(`/api/problems/${p.id}/revise`, { rating: btn.dataset.rating });
          await refreshAll();
        })
      );
    });

    const masterBtn = node.querySelector('.master-btn');
    if (p.mastered_eligible) {
      masterBtn.hidden = false;
      masterBtn.addEventListener(
        'click',
        withLoading(masterBtn, async () => {
          await api.post(`/api/problems/${p.id}/master`);
          await refreshAll();
        })
      );
    }

    list.appendChild(node);
  });
}

// ---------- mastered archive ----------
async function loadMastered(query = '') {
  const items = await api.get('/api/mastered?q=' + encodeURIComponent(query));
  const list = document.getElementById('masteredList');
  const tmpl = document.getElementById('masteredCardTemplate');
  list.innerHTML = '';
  document.getElementById('masteredEmpty').hidden = items.length > 0;

  items.forEach((p) => {
    const node = tmpl.content.cloneNode(true);
    node.querySelector('.card-title').textContent = p.title;
    node.querySelector('.card-meta').innerHTML =
      (p.difficulty ? `<span class="difficulty ${p.difficulty}">${p.difficulty}</span>` : '') +
      new Date(p.mastered_at).toLocaleDateString() +
      ` <span class="stamp stamp-success">mastered</span>`;

    const unmasterBtn = node.querySelector('.unmaster-btn');
    unmasterBtn.addEventListener(
      'click',
      withLoading(unmasterBtn, async () => {
        await api.post(`/api/problems/${p.id}/unmaster`);
        await refreshAll();
      })
    );

    list.appendChild(node);
  });
}

let searchDebounceTimer;
document.getElementById('masteredSearch').addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  const value = e.target.value;
  searchDebounceTimer = setTimeout(() => loadMastered(value), 250);
});

// ---------- settings ----------
function loadSettingsPanel() {
  document.getElementById('settingsEmail').textContent = currentUser?.email || '';
  document.getElementById('leetcodeUsernameInput').value = currentUser?.leetcode_username || '';
}

const saveUsernameBtn = document.getElementById('saveUsernameBtn');
saveUsernameBtn.addEventListener(
  'click',
  withLoading(saveUsernameBtn, async () => {
    const value = document.getElementById('leetcodeUsernameInput').value.trim();
    const res = await fetch('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leetcode_username: value }),
    });
    if (!res.ok) throw new Error('Could not save username');
    currentUser.leetcode_username = value;
    showToast('LeetCode username saved', 'success');
  })
);

const resetAccountBtn = document.getElementById('resetAccountBtn');
resetAccountBtn.addEventListener(
  'click',
  withLoading(resetAccountBtn, async () => {
    const confirmed = confirm(
      'This permanently deletes every problem, tag, and revision you\'ve recorded. This cannot be undone. Continue?'
    );
    if (!confirmed) return;
    await api.post('/api/account/reset');
    showToast('Account reset — starting fresh', 'success');
    await refreshAll();
  })
);

async function refreshAll() {
  try {
    renderGreeting();
    renderQuote();
    await Promise.all([loadDashboard(), loadTagQueue(), loadRevisionQueue(), loadMastered()]);
    loadSettingsPanel();
  } catch (err) {
    console.error(err);
    showToast('Could not load data from the server. Is it still running?', 'error');
  }
}

checkAuth().then(refreshAll);