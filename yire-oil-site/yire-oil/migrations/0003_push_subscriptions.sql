-- Phones subscribed to Web Push from the driver page (/chofer/).
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,   -- push service URL for that phone/browser
  p256dh     TEXT NOT NULL,      -- browser's public key (base64url)
  auth       TEXT NOT NULL,      -- browser's auth secret (base64url)
  created_at INTEGER NOT NULL    -- epoch ms
);
