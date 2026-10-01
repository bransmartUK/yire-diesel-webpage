-- Bookings. status: pending (held while paying) | confirmed (paid) | expired (hold ran out unpaid)
--                   | cancelled | conflict (paid after the hold expired and someone else took the time)
CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,          -- random UUID, also used in the return URL
  date              TEXT NOT NULL,             -- 'YYYY-MM-DD', America/New_York
  start_min         INTEGER NOT NULL,          -- minutes after midnight, 600 = 10:00 AM
  zip               TEXT NOT NULL,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  status            TEXT NOT NULL,
  hold_expires      INTEGER,                   -- epoch ms, for pending rows
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  email             TEXT NOT NULL,
  address           TEXT NOT NULL,
  equipment         TEXT NOT NULL,
  gallons           INTEGER,
  details           TEXT NOT NULL,
  notes             TEXT,
  lang              TEXT NOT NULL DEFAULT 'es',
  deposit_cents     INTEGER NOT NULL,
  square_link_id    TEXT,
  square_order_id   TEXT,
  square_payment_id TEXT,
  created_at        INTEGER NOT NULL,          -- epoch ms
  confirmed_at      INTEGER
);
CREATE INDEX idx_bookings_date  ON bookings (date, status);
CREATE INDEX idx_bookings_order ON bookings (square_order_id);

-- Time the driver blocks off (lunch, day off, breakdown). The driver page will write these;
-- until then: npx wrangler d1 execute yire-oil --remote --command "INSERT INTO blocks ..."
CREATE TABLE blocks (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,                 -- exclusive; 1440 = end of day
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_blocks_date ON blocks (date);
