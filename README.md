# LoopBack

A multi-user spaced-repetition revision tracker for LeetCode. Solve a problem,
tag *how* you solved it, and LoopBack schedules when you should re-solve it
from memory — the same underlying idea as Anki, applied to LeetCode problems.

This version supports multiple accounts (email/password or Google sign-in),
each with fully isolated data, backed by Postgres.

## How it works

1. Create an account (email + password, or "Continue with Google").
2. Set your LeetCode username under **Settings**.
3. Click **Sync** — LoopBack pulls your recently *accepted* LeetCode
   submissions into the **Tag queue**.
4. Tag each new solve (solved it yourself / needed a hint / learned then
   implemented / looked up the solution) — that sets the first revision gap.
5. When a problem comes due, it shows up under **Due for revision**. Re-solve
   it from memory, then rate your recall (nailed it / shaky / forgot).
6. After 3+ revisions with strong recent recall, **Mark mastered** unlocks —
   the problem moves to the searchable **Mastered** archive.

## Setup

**Requirements:** Node.js 18+, a Postgres database (local or hosted)

```bash
cd loopback
npm install
cp .env.example .env
```

### 1. Database

Point `DATABASE_URL` in `.env` at a Postgres database. Locally:

```bash
createdb loopback
```
```
DATABASE_URL=postgres://localhost:5432/loopback
```

Or use a free hosted instance (Render, Railway, Supabase, Neon) — they'll
give you a full connection string to paste in. Hosted providers usually need:
```
DATABASE_SSL=true
```

The schema (tables, indexes) is created automatically on first server start —
no separate migration step.

### 2. Auth secret

Generate a random secret used to sign login sessions:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste the output into `.env`:
```
JWT_SECRET=<paste it here>
```

### 3. Google sign-in (optional)

Leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` blank to skip this — the
app works fine with email/password only, and the Google button just won't
show up.

To enable it:
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth Client ID (type: Web application)
3. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI
4. Copy the Client ID and Secret into `.env`

### 4. Start it

```bash
npm start
```

Visit **http://localhost:3000** — you'll land on the sign-in page first.

## Notes on the LeetCode sync

`POST /api/sync` calls LeetCode's public GraphQL endpoint
(`recentAcSubmissionList`), which only returns *accepted* submissions. It
only fetches problems accepted after your `sync_state.last_synced_at`, and
only advances that timestamp once every insert succeeds, so a failed sync is
safe to retry without missing or double-counting a solve. Per-problem detail
lookups (difficulty, numeric ID) retry with backoff and are spaced 250ms
apart to stay polite to LeetCode's unauthenticated endpoint.

## Auth model

- Sessions are a JWT stored in an httpOnly cookie (30-day expiry) — not
  server-side session storage, so there's nothing extra to run.
- Passwords are hashed with bcrypt (12 rounds), never stored in plain text.
- Signing in with Google using an email that already has a password account
  links the two — same account, either sign-in method works after that.
- All data (`problems`, `revisions`, `sync_state`) is scoped by `user_id`,
  enforced at the query level on every route.

## Project structure

```
loopback/
├── server.js          # Express app + all data API routes (auth-protected)
├── auth.js             # Register/login/logout/me, JWT middleware, Google OAuth
├── leetcode.js          # LeetCode GraphQL client (sync source)
├── db/
│   ├── schema.sql       # Table definitions (Postgres)
│   └── index.js         # Postgres pool + auto schema init on boot
└── public/
    ├── index.html        # Main app (dashboard, queues, settings)
    ├── login.html         # Sign in / register page
    ├── login.js
    ├── app.js
    └── style.css
```

## API reference

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create an account |
| POST | `/api/auth/login` | — | Sign in |
| POST | `/api/auth/logout` | — | Clear session |
| GET | `/api/auth/me` | ✓ | Current user (used for the auth guard) |
| GET | `/api/auth/config` | — | Whether Google sign-in is enabled |
| GET | `/auth/google` | — | Start Google OAuth flow |
| POST | `/api/sync` | ✓ | Pull new accepted solves from LeetCode |
| GET | `/api/queue/tag` | ✓ | Problems awaiting a solve-method tag |
| POST | `/api/problems/:id/tag` | ✓ | Tag a problem, starts its revision schedule |
| GET | `/api/queue/revision` | ✓ | Problems due for revision today |
| POST | `/api/problems/:id/revise` | ✓ | Submit a recall rating, reschedules next gap |
| POST | `/api/problems/:id/master` | ✓ | Move a problem to the mastered archive |
| POST | `/api/problems/:id/unmaster` | ✓ | Pull a mastered problem back into rotation |
| GET | `/api/mastered?q=` | ✓ | Search the mastered archive |
| GET | `/api/dashboard` | ✓ | Summary counts for the dashboard |
| PATCH | `/api/account` | ✓ | Update LeetCode username |
| POST | `/api/account/reset` | ✓ | Wipe this account's problems/revisions |

## Roadmap (not yet built)

- UI redesign pass (current UI is functional, not polished)
- Tests
- Deployment (Render/Railway/Fly.io + hosted Postgres)
- Background/cron sync instead of on-demand
- Personalized interval algorithm (vs. the current fixed multiplier)
