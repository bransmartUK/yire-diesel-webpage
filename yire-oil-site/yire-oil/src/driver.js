import { CONFIG } from "./config.js";
import { ZIP_INDEX } from "./zips.js";
import { nowLocal, travelMin } from "./schedule.js";

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

export async function verifyAccessRequest(req, env) {
  const issuer = accessIssuer(env);
  const audience = String(env.ACCESS_AUD || "").trim();
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!issuer || !audience || !token) return false;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = decodeJsonSegment(parts[0]);
    const claims = decodeJsonSegment(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer || !aud.includes(audience) || typeof claims.exp !== "number" || claims.exp <= now) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 60)) return false;

    let keys = await loadAccessKeys(issuer);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      keys = await loadAccessKeys(issuer, true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA") return false;
    const key = await crypto.subtle.importKey("jwk", jwk, {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
    }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, decodeBase64Url(parts[2]), signed);
  } catch (error) {
    console.error("Access JWT verification failed:", error?.message || error);
    return false;
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

export async function handleDriverApi(req, env) {
  if (!(await verifyAccessRequest(req, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  if (req.method !== "GET" && req.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);

  if (url.pathname === "/api/driver/day" && req.method === "GET") {
    const date = url.searchParams.get("date") || nowLocal().date;
    if (!validDate(date)) return json({ error: "bad_date" }, 400);
    return readDay(date, env);
  }
  if (url.pathname === "/api/driver/complete" && req.method === "POST") return completeStop(req, env);
  if (url.pathname === "/api/driver/blocks" && req.method === "POST") return createBlock(req, env);
  const blockMatch = url.pathname.match(/^\/api\/driver\/blocks\/([0-9a-f-]{36})$/i);
  if (blockMatch && req.method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM blocks WHERE id = ?1`).bind(blockMatch[1]).run();
    if (!result.meta.changes) return json({ error: "block_not_found" }, 404);
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}