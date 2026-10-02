-- What happened to bookings, for the driver page's bell / activity list. One row per event.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,   -- epoch ms
  kind       TEXT NOT NULL,      -- new | conflict | moved | cancelled
  actor      TEXT NOT NULL,      -- 'customer', or the driver's Access email
  booking_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  date       TEXT NOT NULL,      -- booking date/time after the event
  start_min  INTEGER NOT NULL,
  from_date  TEXT,               -- moved: the old date/time
  from_start INTEGER
);
CREATE INDEX idx_activity_at ON activity (at);
