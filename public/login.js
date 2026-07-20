let mode = new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login';

const form = document.getElementById('authForm');
const submitBtn = document.getElementById('submitBtn');
const errorEl = document.getElementById('authError');
const passwordHint = document.getElementById('passwordHint');

// Show "Sign in with Google" only if the server has it configured.
fetch('/api/auth/config')
  .then((r) => r.json())
  .then((cfg) => {
    document.getElementById('googleSection').hidden = !cfg.googleEnabled;
  })
  .catch(() => {}); // fine to fail quietly -- Google button just stays hidden

function applyMode() {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  passwordHint.hidden = mode === 'login';
  document.getElementById('forgotPasswordLink').hidden = mode !== 'login';
  errorEl.hidden = true;
}
applyMode();

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    applyMode();
  });
});

// Surface a Google-auth failure redirected back here with ?error=google
if (new URLSearchParams(location.search).get('error') === 'google') {
  errorEl.textContent = 'Google sign-in failed. Try again or use email + password.';
  errorEl.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    location.href = '/app.html'; // signed in -- go to the app
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});