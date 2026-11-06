-- Tempo schema v1
-- All timestamps are UTC ISO-8601 strings. Money is stored in minor units (cents) as INTEGER.

-- People who can sign in. Teachers sign in with Google; students have no email or password.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('teacher','student')),
  display_name  TEXT NOT NULL,
  email         TEXT UNIQUE,            -- teachers only
  google_sub    TEXT UNIQUE,            -- teachers only
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A studio is one teacher's private space. One teacher can own several (modular),
-- the UI starts with one.
CREATE TABLE studios (
  id                    TEXT PRIMARY KEY,
  owner_user_id         TEXT NOT NULL REFERENCES users(id),
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,          -- used in the studio link /s/<slug>
  join_code             TEXT NOT NULL UNIQUE,          -- typed into the installed app
  join_open             INTEGER NOT NULL DEFAULT 1,
  timezone              TEXT NOT NULL DEFAULT 'Asia/Singapore',
  default_currency      TEXT NOT NULL DEFAULT 'SGD',
  change_notice_hours   INTEGER NOT NULL DEFAULT 24,   -- students can cancel/move up to this many hours before
  booking_horizon_days  INTEGER NOT NULL DEFAULT 28,
  booking_notice_hours  INTEGER NOT NULL DEFAULT 12,  -- earliest a student can book ahead
  student_cancel_credit INTEGER NOT NULL DEFAULT 1,   -- on-time student cancellation earns a make-up credit
  makeup_expiry_days    INTEGER,                      -- null = credits never expire
  ical_url              TEXT,                          -- phase 2: Google Calendar busy times
  studio_address        TEXT,                          -- where physical classes happen
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A user's place in a studio. For students this is the shared or individual account.
CREATE TABLE memberships (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL CHECK (role IN ('teacher','student')),
  username       TEXT,                  -- students: full name used to sign in
  username_norm  TEXT,                  -- lower-cased, single-spaced, for uniqueness
  is_shared      INTEGER NOT NULL DEFAULT 0,   -- siblings / group sharing one account
  currency       TEXT,                  -- set by the teacher after onboarding
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','removed')),
  phone          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at    TEXT,
  UNIQUE (studio_id, user_id)
);
CREATE UNIQUE INDEX memberships_username ON memberships(studio_id, username_norm) WHERE username_norm IS NOT NULL AND status <> 'removed';

-- Each person who actually learns. A shared account has several learners.
CREATE TABLE learners (
  id             TEXT PRIMARY KEY,
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  name           TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX learners_membership ON learners(membership_id);

-- The teacher's rules for each learner.
CREATE TABLE learner_rules (
  learner_id          TEXT PRIMARY KEY REFERENCES learners(id),
  max_class_minutes   INTEGER NOT NULL DEFAULT 60,   -- in 30-minute blocks
  classes_per_week    INTEGER NOT NULL DEFAULT 1,    -- 0 = no limit
  fee_minor           INTEGER NOT NULL DEFAULT 0,
  fee_basis           TEXT NOT NULL DEFAULT 'per_class' CHECK (fee_basis IN ('per_class','per_30min')),
  group_eligible      INTEGER NOT NULL DEFAULT 0,
  can_reschedule      INTEGER NOT NULL DEFAULT 1,    -- may move classes the teacher scheduled
  can_book_extra      INTEGER NOT NULL DEFAULT 1,    -- may book extra classes (charged as normal)
  can_book_makeup     INTEGER NOT NULL DEFAULT 1,    -- may redeem make-up credits
  allowed_modes       TEXT NOT NULL DEFAULT 'physical,virtual',  -- which class modes this learner may book
  default_mode        TEXT NOT NULL DEFAULT 'physical' CHECK (default_mode IN ('physical','virtual')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Virtual classrooms. Two families:
--  * generated: Tempo creates a fresh meeting per class through the teacher's connected account
--    (zoom, google_meet, teams); tokens are stored encrypted with a Worker secret.
--  * fixed: a link the teacher pastes once (her personal meeting room, or a dedicated classroom
--    she created in any app) that is reused for every class.
CREATE TABLE meeting_rooms (
  id            TEXT PRIMARY KEY,
  studio_id     TEXT NOT NULL REFERENCES studios(id),
  provider      TEXT NOT NULL CHECK (provider IN ('zoom','google_meet','teams','fixed_link')),
  kind          TEXT NOT NULL CHECK (kind IN ('generated','fixed')),
  label         TEXT NOT NULL,         -- e.g. "Zoom (auto)", "My Meet room", "SuSwara classroom"
  url           TEXT,                  -- fixed rooms only
  passcode      TEXT,                  -- fixed rooms only, optional
  account_email TEXT,                  -- generated rooms: which account is connected
  token_enc     TEXT,                  -- generated rooms: encrypted OAuth refresh token
  is_default    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Optional per-learner room override (e.g. one family always on Teams).
CREATE TABLE learner_rooms (
  learner_id  TEXT PRIMARY KEY REFERENCES learners(id),
  room_id     TEXT NOT NULL REFERENCES meeting_rooms(id)
);

-- Weekly free time, in the studio's local time.
CREATE TABLE availability (
  id         TEXT PRIMARY KEY,
  studio_id  TEXT NOT NULL REFERENCES studios(id),
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  start_min  INTEGER NOT NULL,   -- minutes after local midnight
  end_min    INTEGER NOT NULL,
  CHECK (end_min > start_min)
);

CREATE TABLE time_off (
  id         TEXT PRIMARY KEY,
  studio_id  TEXT NOT NULL REFERENCES studios(id),
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  reason     TEXT
);

-- Individual classes. Overlaps are impossible because every 30-minute block
-- a booking covers is claimed in booking_blocks (primary key per studio + block).
CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  learner_id     TEXT NOT NULL REFERENCES learners(id),
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  minutes        INTEGER NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','extra','makeup')),
  series_id      TEXT REFERENCES class_series(id),   -- set when generated from a recurring slot
  moved_from     TEXT,                 -- original start time if a student or teacher moved it
  makeup_credit_id TEXT,               -- the credit this make-up class used
  mode           TEXT NOT NULL DEFAULT 'physical' CHECK (mode IN ('physical','virtual')),
  location       TEXT,                 -- physical: address shown to the student
  room_id        TEXT REFERENCES meeting_rooms(id),  -- virtual: which room/provider was used
  meeting_url    TEXT,                 -- virtual: join link (generated or fixed)
  meeting_ext_id TEXT,                 -- provider meeting/event id, so moves and cancels update it
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','completed','cancelled','no_show')),
  cancelled_by   TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT
);
CREATE INDEX bookings_studio_time ON bookings(studio_id, starts_at);
CREATE INDEX bookings_learner ON bookings(learner_id, starts_at);

-- The teacher's timetable: recurring classes they schedule for each learner.
-- Tempo generates individual bookings from these a few weeks ahead.
CREATE TABLE class_series (
  id            TEXT PRIMARY KEY,
  studio_id     TEXT NOT NULL REFERENCES studios(id),
  learner_id    TEXT NOT NULL REFERENCES learners(id),
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min     INTEGER NOT NULL,      -- local minutes after midnight, multiple of 30
  minutes       INTEGER NOT NULL,      -- multiple of 30
  mode          TEXT NOT NULL DEFAULT 'physical' CHECK (mode IN ('physical','virtual')),
  room_id       TEXT,
  starts_on     TEXT NOT NULL,         -- YYYY-MM-DD local
  ends_on       TEXT,                  -- null = until stopped (e.g. end of term)
  generated_to  TEXT,                  -- last date bookings were generated for
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Make-up credits: issued when the teacher cancels, or when a student cancels within policy.
CREATE TABLE makeup_credits (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  learner_id     TEXT NOT NULL REFERENCES learners(id),
  source_booking TEXT,                 -- the cancelled class
  reason         TEXT,
  expires_on     TEXT,                 -- null = never
  used_booking   TEXT,                 -- the make-up class that used it
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','used','expired','void')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX makeup_learner ON makeup_credits(learner_id, status);

CREATE TABLE booking_blocks (
  studio_id    TEXT NOT NULL,
  block_start  TEXT NOT NULL,
  booking_id   TEXT,          -- set for 1:1 classes
  group_id     TEXT,          -- set for group classes
  PRIMARY KEY (studio_id, block_start)
);

-- Group classes. No seat limit; who may join is decided by learner_rules.group_eligible
-- or an explicit invite list.
CREATE TABLE group_classes (
  id          TEXT PRIMARY KEY,
  studio_id   TEXT NOT NULL REFERENCES studios(id),
  title       TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  notes       TEXT,
  mode        TEXT NOT NULL DEFAULT 'physical' CHECK (mode IN ('physical','virtual')),
  location    TEXT,
  room_id     TEXT,
  meeting_url TEXT,
  eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (eligibility IN ('eligible','invited')),
  fee_minor   INTEGER,        -- optional flat fee per learner; null = free / included
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE group_invites (
  group_id    TEXT NOT NULL REFERENCES group_classes(id),
  learner_id  TEXT NOT NULL REFERENCES learners(id),
  PRIMARY KEY (group_id, learner_id)
);
CREATE TABLE group_signups (
  group_id    TEXT NOT NULL REFERENCES group_classes(id),
  learner_id  TEXT NOT NULL REFERENCES learners(id),
  status      TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','left')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, learner_id)
);

-- Fees. Balance = charges - payments, per account and currency.
CREATE TABLE ledger (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  learner_id     TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('charge','payment','adjustment')),
  amount_minor   INTEGER NOT NULL,     -- always positive; kind gives the direction (adjustment can be +/-)
  currency       TEXT NOT NULL,
  booking_id     TEXT UNIQUE,          -- one charge per class
  group_ref      TEXT,                 -- group_id:learner_id for group charges
  method         TEXT,                 -- cash, PayNow, bank transfer...
  note           TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ledger_membership ON ledger(membership_id, created_at);
CREATE UNIQUE INDEX ledger_group_ref ON ledger(group_ref) WHERE group_ref IS NOT NULL;

-- Daily practice. Readable only by the teacher and the account it belongs to.
CREATE TABLE practice_logs (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  learner_id     TEXT NOT NULL REFERENCES learners(id),
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  day            TEXT NOT NULL,        -- YYYY-MM-DD, studio local date
  minutes        INTEGER NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
  notes          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (learner_id, day)
);

-- Events: lecdems, competitions, presentations...
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  studio_id       TEXT NOT NULL REFERENCES studios(id),
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('lecdem','competition','presentation','concert','other')),
  starts_at       TEXT NOT NULL,
  ends_at         TEXT,
  location        TEXT,
  description     TEXT,
  collect_rsvp    INTEGER NOT NULL DEFAULT 1,
  collect_pieces  INTEGER NOT NULL DEFAULT 0,
  piece_fields    TEXT NOT NULL DEFAULT '["composition","raga","tala","composer"]',
  audience        TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','group_eligible')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE event_responses (
  event_id    TEXT NOT NULL REFERENCES events(id),
  learner_id  TEXT NOT NULL REFERENCES learners(id),
  attending   TEXT CHECK (attending IN ('yes','no','maybe')),
  piece       TEXT,          -- JSON object keyed by piece_fields
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, learner_id)
);

-- In-app notifications (always) + Web Push subscriptions (when the device allows).
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  studio_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Device sessions. Students never have passwords: a session is created on the
-- installed app at onboarding, or when the teacher approves a sign-in request.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  device      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL
);

CREATE TABLE signin_requests (
  id             TEXT PRIMARY KEY,
  studio_id      TEXT NOT NULL REFERENCES studios(id),
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  secret_hash    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','used')),
  device         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
