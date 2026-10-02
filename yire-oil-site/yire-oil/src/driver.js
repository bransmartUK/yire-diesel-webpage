import { CONFIG } from "./config.js";
import { ZIP_INDEX } from "./zips.js";
import { addDays, nowLocal, travelMin } from "./schedule.js";
import { b64uDecode, bookingMessage, sendPush, updateMessage, vapidPublicKey } from "./push.js";
import { cancelBooking, isChangeable, moveBooking, slotsOn } from "./manage.js";
import { notifyCustomerUpdate } from "./email.js";
import { logActivity } from "./db.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

let cachedKeys = null;
let cachedIssuer = "";
let keysExpireAt = 0;

function accessIssuer(env) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || "").trim()
    .replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+\.cloudflareaccess\.com$/i.test(domain)) return null;
  return `https://${domain.toLowerCase()}`;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeJsonSegment(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function loadAccessKeys(issuer, force = false) {
  if (!force && cachedKeys && cachedIssuer === issuer && Date.now() < keysExpireAt) return cachedKeys;
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Access certificates returned ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.keys)) throw new Error("Access certificates response was invalid");
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1] || 300);
  cachedKeys = data.keys;
  cachedIssuer = issuer;
  keysExpireAt = Date.now() + Math.min(Math.max(maxAge, 60), 3600) * 1000;
  return cachedKeys;
}

// Returns { email } for a valid Access login, or null.
export async function verifyAccessRequest(req, env) {
  const issuer = accessIssuer(env);
  const audience = String(env.ACCESS_AUD || "").trim();
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!issuer || !audience || !token) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeJsonSegment(parts[0]);
    const claims = decodeJsonSegment(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || !aud.includes(audience) || typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 60)) return null;

    let keys = await loadAccessKeys(issuer);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      keys = await loadAccessKeys(issuer, true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA") return null;
    const key = await crypto.subtle.importKey("jwk", jwk, {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
    }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, decodeBase64Url(parts[2]), signed))) return null;
    return { email: typeof claims.email === "string" ? claims.email.toLowerCase() : "" };
  } catch (error) {
    console.error("Access JWT verification failed:", error?.message || error);
    return null;
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readDay(date, env) {
  const { results: bookings } = await env.DB.prepare(
    `SELECT id, date, start_min, status, name, phone, address, zip, lat, lng, equipment,
       gallons, details, notes FROM bookings
     WHERE date = ?1 AND status IN ('confirmed','conflict','completed')
     ORDER BY start_min, id`
  ).bind(date).all();
  const { results: blocks } = await env.DB.prepare(
    `SELECT id, date, start_min, end_min, note FROM blocks WHERE date = ?1 ORDER BY start_min`
  ).bind(date).all();

  let previous = ZIP_INDEX[CONFIG.baseZip];
  const stops = bookings.map((booking) => {
    const location = { lat: booking.lat, lng: booking.lng };
    const stop = { ...booking, drive_min: travelMin(previous, location) };
    previous = location;
    return stop;
  });
  return json({ date, stops, blocks });
}

// Every paid stop from now on (next 60 days), so he can see what's coming without picking each day.
// A stop that started less than serviceMin ago still counts: he may be there right now.
const UPCOMING_LIMIT = 50;
async function readUpcoming(env) {
  const now = nowLocal();
  const { results } = await env.DB.prepare(
    `SELECT id, date, start_min, status, name, zip, equipment FROM bookings
     WHERE status IN ('confirmed','conflict') AND (date > ?1 OR (date = ?1 AND start_min >= ?2))
     ORDER BY date, start_min LIMIT ?3`
  ).bind(now.date, now.min - CONFIG.serviceMin, UPCOMING_LIMIT).all();
  return json({
    today: now.date,
    stops: results.map((b) => ({ ...b, city: ZIP_INDEX[b.zip]?.city || b.zip })),
    more: results.length === UPCOMING_LIMIT
  });
}

async function completeStop(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: "bad_request" }, 400);
  const result = await env.DB.prepare(
    `UPDATE bookings SET status = 'completed', completed_at = ?1
     WHERE id = ?2 AND status IN ('confirmed','conflict')`
  ).bind(Date.now(), body.id).run();
  if (!result.meta.changes) return json({ error: "stop_not_found_or_completed" }, 404);
  return json({ ok: true });
}

async function createBlock(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { date, start_min, end_min } = body;
  if (!validDate(date) || !Number.isInteger(start_min) || !Number.isInteger(end_min)
      || start_min < 0 || start_min >= 1440 || end_min <= start_min || end_min > 1440) {
    return json({ error: "bad_block" }, 400);
  }
  const overlap = await env.DB.prepare(
    `SELECT id FROM bookings WHERE date = ?1
       AND (status IN ('confirmed','conflict') OR (status = 'pending' AND hold_expires > ?5))
       AND start_min < ?3 AND start_min + ?4 > ?2 LIMIT 1`
  ).bind(date, start_min, end_min, CONFIG.serviceMin, Date.now()).first();
  if (overlap) return json({ error: "block_conflicts_with_booking" }, 409);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO blocks (id, date, start_min, end_min, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(id, date, start_min, end_min, typeof body.note === "string" ? body.note.trim().slice(0, 200) || null : null, Date.now()).run();
  return json({ id }, 201);
}

// Only real browser push services, so the Worker never POSTs to arbitrary URLs.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/i;

function decodedLength(value) {
  try { return typeof value === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(value) ? b64uDecode(value).length : 0; }
  catch { return 0; }
}

async function savePushSubscription(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  let host = "";
  try { const url = new URL(endpoint); if (url.protocol === "https:") host = url.hostname; } catch {}
  const { p256dh, auth } = body.keys || {};
  if (!PUSH_HOSTS.test(host) || endpoint.length > 1000 || decodedLength(p256dh) !== 65 || decodedLength(auth) !== 16) {
    return json({ error: "bad_subscription" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(endpoint, p256dh, auth, Date.now()).run();
  return json({ ok: true });
}

async function loadStop(env, id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1`).bind(id).first();
}

// The driver moves a stop (phone request). No cutoff or change limit, but the time must still be open.
async function moveStop(req, env, ctx, who) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const b = await loadStop(env, body.id);
  if (!b) return json({ error: "stop_not_found" }, 404);
  if (!isChangeable(b)) return json({ error: "not_changeable" }, 409);
  const result = await moveBooking(env, b, body.date, body.start_min, { countsAsChange: false });
  if (result !== "ok") return json({ error: result }, result === "bad_slot" || result === "same_slot" ? 400 : 409);
  const updated = { ...b, date: body.date, start_min: body.start_min, status: "confirmed" };
  ctx.waitUntil(Promise.all([
    notifyCustomerUpdate(env, updated, { by: "driver" }),
    logActivity(env, "moved", who.email || "driver", updated, b)
  ]).catch((e) => console.error(e)));
  return json({ ok: true });
}

async function cancelStop(req, env, ctx, who) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const b = await loadStop(env, body.id);
  if (!b || !(await cancelBooking(env, b))) return json({ error: "not_changeable" }, 409);
  const updated = { ...b, status: "cancelled" };
  ctx.waitUntil(Promise.all([
    notifyCustomerUpdate(env, updated, { by: "driver" }),
    logActivity(env, "cancelled", who.email || "driver", updated)
  ]).catch((e) => console.error(e)));
  return json({ ok: true });
}

// Last 30 events for the bell. `me` lets each phone skip its own actions when counting what's new.
async function readActivity(env, who) {
  const { results } = await env.DB.prepare(
    `SELECT at, kind, actor, booking_id, name, date, start_min, from_date, from_start
     FROM activity ORDER BY at DESC, id DESC LIMIT 30`
  ).all();
  return json({ me: who.email, events: results });
}

// "Probar aviso" options: the real message builders with sample data, sent only to the tapping phone.
// Nothing is written to the database and no email is sent.
const TEST_KINDS = ["new", "moved", "cancelled", "conflict"];
function testMessage(kind) {
  if (!TEST_KINDS.includes(kind)) {
    return { title: "Prueba de avisos", body: "Los avisos de Yire Oil funcionan en este teléfono.", url: "/chofer/", tag: "test" };
  }
  const today = nowLocal().date;
  const sample = { id: `prueba-${kind}`, date: addDays(today, 3), start_min: 600, zip: CONFIG.baseZip,
    name: "Cliente de prueba", status: kind === "cancelled" ? "cancelled" : "confirmed" };
  if (kind === "moved") return updateMessage(sample, { from: { date: addDays(today, 2), start_min: 840 } });
  if (kind === "cancelled") return updateMessage(sample);
  return bookingMessage(sample, { conflict: kind === "conflict" });
}

export async function handleDriverApi(req, env, ctx) {
  const who = await verifyAccessRequest(req, env);
  if (!who) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  if (req.method !== "GET" && req.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);

  if (url.pathname === "/api/driver/day" && req.method === "GET") {
    const date = url.searchParams.get("date") || nowLocal().date;
    if (!validDate(date)) return json({ error: "bad_date" }, 400);
    return readDay(date, env);
  }
  if (url.pathname === "/api/driver/upcoming" && req.method === "GET") return readUpcoming(env);
  if (url.pathname === "/api/driver/activity" && req.method === "GET") return readActivity(env, who);
  // Changes with every deploy; the page shows "Hay una versión nueva" when it differs from what it loaded with.
  if (url.pathname === "/api/driver/version" && req.method === "GET") return json({ id: env.CF_VERSION_METADATA?.id || "dev" });
  if (url.pathname === "/api/driver/complete" && req.method === "POST") return completeStop(req, env);
  if (url.pathname === "/api/driver/slots" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!validDate(date)) return json({ error: "bad_date" }, 400);
    const b = await loadStop(env, url.searchParams.get("id"));
    if (!b || !isChangeable(b)) return json({ error: "not_changeable" }, 409);
    return json({ date, slots: await slotsOn(env, b, date) });
  }
  if (url.pathname === "/api/driver/move" && req.method === "POST") return moveStop(req, env, ctx, who);
  if (url.pathname === "/api/driver/cancel" && req.method === "POST") return cancelStop(req, env, ctx, who);
  if (url.pathname === "/api/driver/blocks" && req.method === "POST") return createBlock(req, env);
  if (url.pathname === "/api/driver/push/key" && req.method === "GET") {
    const key = await vapidPublicKey(env);
    return key ? json({ key }) : json({ error: "push_not_configured" }, 503);
  }
  if (url.pathname === "/api/driver/push/subscribe" && req.method === "POST") return savePushSubscription(req, env);
  if (url.pathname === "/api/driver/push/test" && req.method === "POST") {
    if (!(await vapidPublicKey(env))) return json({ error: "push_not_configured" }, 503);
    // Only the phone that tapped "Probar aviso", so each phone proves its own setup.
    let body = {};
    try { body = await req.json(); } catch {}
    if (typeof body.endpoint !== "string" || !body.endpoint) return json({ error: "bad_subscription" }, 400);
    return json(await sendPush(env, testMessage(body.kind), { endpoint: body.endpoint }));
  }
  const blockMatch = url.pathname.match(/^\/api\/driver\/blocks\/([0-9a-f-]{36})$/i);
  if (blockMatch && req.method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM blocks WHERE id = ?1`).bind(blockMatch[1]).run();
    if (!result.meta.changes) return json({ error: "block_not_found" }, 404);
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}