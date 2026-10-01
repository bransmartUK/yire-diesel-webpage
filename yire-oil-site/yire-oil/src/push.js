// Web Push to the driver's phone (subscribed from /chofer/). Standard VAPID + aes128gcm (RFC 8291/8292)
// with WebCrypto, no libraries. Without the VAPID_PRIVATE_JWK secret, pushes are logged and skipped.
import { ZIP_INDEX } from "./zips.js";
import { fmtDate, fmtTime } from "./email.js";

const enc = new TextEncoder();

export function b64uEncode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

let vapidCache = null;
async function vapid(env) {
  const raw = String(env.VAPID_PRIVATE_JWK || "").trim();
  if (!raw) return null;
  if (vapidCache?.raw === raw) return vapidCache;
  const { x, y, d } = JSON.parse(raw);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapidCache = { raw, key, publicKey: b64uEncode(concat([4], b64uDecode(x), b64uDecode(y))) };
  return vapidCache;
}

// Public key the browser needs as applicationServerKey, or null if push isn't configured.
export async function vapidPublicKey(env) {
  return (await vapid(env))?.publicKey || null;
}

async function vapidAuthorization(endpoint, env, v) {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || env.SITE_URL
  })));
  // WebCrypto ECDSA signatures are already raw r||s, which is what ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64uEncode(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// RFC 8291 aes128gcm body: salt(16) | record size(4) | key id length(1) | sender public key(65) | ciphertext.
export async function encryptPayload(sub, plaintext) {
  const uaPublic = b64uDecode(sub.p256dh);
  const authSecret = b64uDecode(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (only) record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes,
    concat(enc.encode(plaintext), [2])));

  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// Sends to every subscribed phone; drops subscriptions the push service says are gone.
export async function sendPush(env, message) {
  const v = await vapid(env);
  if (!v) {
    console.log(`[push skipped] ${message.title}`);
    return { sent: 0, removed: 0 };
  }
  const { results } = await env.DB.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`).all();
  const body = JSON.stringify(message);
  let sent = 0, removed = 0;
  await Promise.all(results.map(async (sub) => {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuthorization(sub.endpoint, env, v),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
          urgency: "high"
        },
        body: await encryptPayload(sub, body)
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(sub.endpoint).run();
        removed++;
      } else if (!res.ok) {
        console.error(`push ${new URL(sub.endpoint).host} ${res.status}: ${await res.text()}`);
      } else {
        sent++;
      }
    } catch (error) {
      console.error("push failed:", error?.message || error);
    }
  }));
  return { sent, removed };
}

// The customer moved or cancelled online.
export function notifyDriverPushUpdate(env, b, { from }) {
  const at = (x) => `${fmtDate(x.date, "es")}, ${fmtTime(x.start_min, "es")}`;
  const cancelled = b.status === "cancelled";
  return sendPush(env, {
    title: cancelled ? "Reserva cancelada" : "Cambio de hora",
    body: cancelled ? `${at(b)} · ${b.name}` : `${at(from)} → ${at(b)} · ${b.name}`,
    url: `/chofer/?date=${b.date}`,
    tag: b.id
  });
}

// New paid booking (or a conflict) -> notification that opens the driver page on that day.
export function notifyDriverPush(env, b, { conflict = false } = {}) {
  return sendPush(env, {
    title: conflict ? "⚠ Conflicto de reserva" : "Nueva entrega reservada",
    body: [`${fmtDate(b.date, "es")}, ${fmtTime(b.start_min, "es")}`, ZIP_INDEX[b.zip]?.city, b.name]
      .filter(Boolean).join(" · "),
    url: `/chofer/?date=${b.date}`,
    tag: b.id
  });
}
