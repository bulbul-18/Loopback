-- LoopBack schema (PostgreSQL dialect) -- multi-user version

CREATE TABLE IF NOT EXISTS users (
    id                  SERIAL PRIMARY KEY,
    email               TEXT UNIQUE NOT NULL,
    password_hash       TEXT,               -- NULL if the user only ever signed in with Google
    google_id           TEXT UNIQUE,
    leetcode_username   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS solve_method_intervals (
    solve_method            TEXT PRIMARY KEY,
    label                   TEXT NOT NULL,
    initial_interval_days   INTEGER NOT NULL
);

INSERT INTO solve_method_intervals (solve_method, label, initial_interval_days) VALUES
    ('self_solved',              'Solved it myself',            4),
    ('hint_assisted',             'Needed a hint',                2),
    ('learned_then_implemented',  'Learned, then implemented',    1),
    ('looked_up_solution',        'Looked up the full solution',  1)
ON CONFLICT (solve_method) DO NOTHING;

CREATE TABLE IF NOT EXISTS problems (
    id                      SERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    leetcode_id             INTEGER,
    title_slug              TEXT NOT NULL,
    title                   TEXT NOT NULL,
    url                     TEXT,
    difficulty              TEXT CHECK (difficulty IN ('Easy','Medium','Hard')),
    solved_at               TIMESTAMPTZ NOT NULL,

    solve_method            TEXT REFERENCES solve_method_intervals(solve_method),
    tagged_at               TIMESTAMPTZ,

    revision_count          INTEGER NOT NULL DEFAULT 0,
    current_interval_days   INTEGER,
    next_revision_date      DATE,

    status                  TEXT NOT NULL DEFAULT 'pending_tag'
                             CHECK (status IN ('pending_tag','active','mastered')),
    mastered_eligible        BOOLEAN NOT NULL DEFAULT FALSE,
    mastered_at              TIMESTAMPTZ,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (user_id, title_slug)
);

CREATE INDEX IF NOT EXISTS idx_problems_user_status ON problems(user_id, status);
CREATE INDEX IF NOT EXISTS idx_problems_user_next_revision ON problems(user_id, next_revision_date);

CREATE TABLE IF NOT EXISTS revisions (
    id                      SERIAL PRIMARY KEY,
    problem_id              INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    revised_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    rating                   TEXT NOT NULL CHECK (rating IN ('nailed_it','shaky','forgot')),
    interval_before_days     INTEGER,
    interval_after_days      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_revisions_problem_id ON revisions(problem_id);

-- One row per user, tracks their last successful LeetCode pull
CREATE TABLE IF NOT EXISTS sync_state (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_synced_at    TIMESTAMPTZ
);
