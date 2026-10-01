-- Customer self-service changes (secret link in the confirmation email) and cancellations.
ALTER TABLE bookings ADD COLUMN manage_token TEXT;                          -- random, only in the customer's emails
ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0; -- online time changes used
ALTER TABLE bookings ADD COLUMN cancelled_at INTEGER;                        -- epoch ms
