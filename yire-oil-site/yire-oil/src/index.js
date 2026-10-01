import { CONFIG } from "./config.js";
import { ZIP_INDEX } from "./zips.js";
import { nowLocal, availabilityMap, openSlots, windowEnd, isValidStart, dayOfWeek } from "./schedule.js";
import { createPaymentLink, deletePaymentLink, verifySquareSignature } from "./square.js";
import { notifyDriver, notifyCustomer, fmtDate, fmtTime } from "./email.js";
import { handleDriverApi, verifyAccessRequest } from "./driver.js";
import { b64uEncode, notifyDriverPush } from "./push.js";
import { activeBookings, blocksBetween } from "./db.js";
import { handleManageApi } from "./manage.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const BASE = () => ZIP_INDEX[CONFIG.baseZip];
const EQUIPMENT = ["Dump truck", "Semi / tractor-trailer", "RV / motorhome", "Boat", "Other"];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/availability" && req.method === "GET") return await availability(url, env);
      if (url.pathname === "/api/checkout" && req.method === "POST") return await checkout(req, env);
      if (url.pathname === "/api/square-webhook" && req.method === "POST") return await webhook(req, env, ctx);
      if (url.pathname.startsWith("/api/driver/")) return await handleDriverApi(req, env, ctx);
      if (url.pathname.startsWith("/api/manage/")) return await handleManageApi(req, env, ctx);
      if (/^\/chofer(?:\/|$)/.test(url.pathname)) {
        if (!(await verifyAccessRequest(req, env))) return json({ error: "unauthorized" }, 401);
        // Assets serve /chofer/ as index.html; asking for /chofer/index.html directly would 307 back to /chofer/.
        return env.ASSETS.fetch(req);
      }
      const m = url.pathname.match(/^\/api\/booking\/([0-9a-f-]{36})$/);
      if (m && req.method === "GET") return await bookingStatus(m[1], env);
      if (url.pathname === "/api/mock-pay" && env.SQUARE_ENV === "mock") return await mockPay(url, env, ctx);
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error(err?.stack || err);
      return json({ error: "server_error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(releaseExpiredHolds(env));
  }
};

/* ---------------- GET /api/availability?zip=33186 ---------------- */

async function availability(url, env) {
  const zip = (url.searchParams.get("zip") || "").trim();
  const loc = ZIP_INDEX[zip];
  if (!/^\d{5}$/.test(zip) || !loc) return json({ error: "out_of_area" }, 400);
  const now = nowLocal();
  const end = windowEnd(now);
  const [bookings, blocks] = await Promise.all([activeBookings(env, now.date, end), blocksBetween(env, now.date, end)]);
  return json({ zip, city: loc.city, today: now.date, days: availabilityMap(loc, bookings, blocks, now, BASE()) });
}

/* ---------------- POST /api/checkout ---------------- */

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function checkout(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const zip = str(body.zip, 5);
  const loc = ZIP_INDEX[zip];
  const now = nowLocal();
  const booking = {
    id: crypto.randomUUID(),
    date: str(body.date, 10),
    start_min: Number(body.start),
    zip,
    lat: loc?.lat, lng: loc?.lng,
    name: str(body.name, 100),
    phone: str(body.phone, 30),
    email: str(body.email, 200),
    address: str(body.address, 300),
    equipment: EQUIPMENT.includes(body.equipment) ? body.equipment : "Other",
    gallons: Number.isFinite(Number(body.gallons)) && Number(body.gallons) > 0 ? Math.min(Math.round(Number(body.gallons)), 100000) : null,
    details: str(body.details, 300),
    notes: str(body.notes, 1000),
    lang: body.lang === "en" ? "en" : "es",
    deposit_cents: CONFIG.depositCents,
    // Secret for the "change or cancel" link; only ever sent in the customer's emails.
    manage_token: b64uEncode(crypto.getRandomValues(new Uint8Array(24)))
  };

  if (!loc) return json({ error: "out_of_area" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.date) || booking.date < now.date || booking.date > windowEnd(now)
      || !CONFIG.openDays.includes(dayOfWeek(booking.date)) || !isValidStart(booking.start_min)) {
    return json({ error: "bad_slot" }, 400);
  }
  if (!booking.name || !booking.phone || !booking.address || !booking.details || !/^\S+@\S+\.\S+$/.test(booking.email)) {
    return json({ error: "missing_fields" }, 400);
  }

  // 1. Is the slot open right now?
  if (!(await slotIsOpen(env, booking, now))) return json({ error: "slot_taken" }, 409);

  // 2. Hold it.
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO bookings (id, date, start_min, zip, lat, lng, status, hold_expires, name, phone, email, address,
       equipment, gallons, details, notes, lang, deposit_cents, created_at, manage_token)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
  ).bind(booking.id, booking.date, booking.start_min, zip, loc.lat, loc.lng,
         createdAt + CONFIG.holdMinutes * 60_000, booking.name, booking.phone, booking.email, booking.address,
         booking.equipment, booking.gallons, booking.details, booking.notes || null, booking.lang,
         booking.deposit_cents, createdAt, booking.manage_token).run();

  // 3. Two people can pass step 1 at the same moment. Re-check against holds created before ours;
  //    the later one backs off.
  const earlier = (await activeBookings(env, booking.date, booking.date, { excludeId: booking.id }))
    .filter((b) => b.created_at < createdAt || (b.created_at === createdAt && b.id < booking.id));
  const blocks = await blocksBetween(env, booking.date, booking.date);
  if (!openSlots(booking.date, loc, earlier, blocks, now, BASE()).includes(booking.start_min)) {
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?1`).bind(booking.id).run();
    return json({ error: "slot_taken" }, 409);
  }

  // 4. Square payment link.
  let link;
  try {
    link = await createPaymentLink(env, booking, {
      itemName: booking.lang === "en" ? "Diesel delivery reservation" : "Reservación de entrega de diésel",
      note: `Yire Oil · ${fmtDate(booking.date, "es")} ${fmtTime(booking.start_min, "es")} · ${booking.name} · ${booking.id}`
    });
  } catch (err) {
    console.error(err?.stack || err);
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?1`).bind(booking.id).run();
    return json({ error: "payment_unavailable" }, 502);
  }
  await env.DB.prepare(`UPDATE bookings SET square_link_id = ?1, square_order_id = ?2 WHERE id = ?3`)
    .bind(link.id, link.orderId, booking.id).run();

  return json({ id: booking.id, url: link.url });
}

async function slotIsOpen(env, booking, now, { excludeId = null } = {}) {
  const loc = { lat: booking.lat, lng: booking.lng };
  const [others, blocks] = await Promise.all([
    activeBookings(env, booking.date, booking.date, { excludeId }),
    blocksBetween(env, booking.date, booking.date)
  ]);
  return openSlots(booking.date, loc, others, blocks, now, BASE()).includes(booking.start_min);
}

/* ---------------- POST /api/square-webhook ---------------- */

async function webhook(req, env, ctx) {
  const raw = await req.text();
  const notificationUrl = env.SQUARE_WEBHOOK_URL || `${env.SITE_URL}/api/square-webhook`;
  const ok = await verifySquareSignature(env.SQUARE_WEBHOOK_SIGNATURE_KEY, notificationUrl, raw,
                                         req.headers.get("x-square-hmacsha256-signature"));
  if (!ok) return json({ error: "bad_signature" }, 401);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "bad_request" }, 400); }

  if (event.type === "payment.created" || event.type === "payment.updated") {
    const payment = event.data?.object?.payment;
    if (payment?.status === "COMPLETED" && payment.order_id) {
      await confirmPaid(env, ctx, payment.order_id, payment.id);
    }
  }
  return json({ ok: true }); // always 200 for handled/ignored events so Square doesn't retry
}

async function confirmPaid(env, ctx, orderId, paymentId) {
  const b = await env.DB.prepare(`SELECT * FROM bookings WHERE square_order_id = ?1`).bind(orderId).first();
  // Unknown order, or already handled. Square also sends payment.updated for refunds, so a completed
  // stop must not fall through and get flipped back to confirmed.
  if (!b || ["confirmed", "conflict", "completed"].includes(b.status)) return;

  let next = "confirmed";
  if (b.status !== "pending" || b.hold_expires <= Date.now()) {
    // Paid after the hold ran out: keep it if the time is still free, otherwise flag it for a call.
    const now = nowLocal();
    next = (await slotIsOpen(env, b, now, { excludeId: b.id })) ? "confirmed" : "conflict";
  }
  const res = await env.DB.prepare(
    `UPDATE bookings SET status = ?1, square_payment_id = ?2, confirmed_at = ?3, hold_expires = NULL
     WHERE id = ?4 AND status = ?5`
  ).bind(next, paymentId, Date.now(), b.id, b.status).run();
  if (!res.meta.changes) return; // a duplicate webhook got here first

  const updated = { ...b, status: next };
  ctx.waitUntil(Promise.all([
    notifyDriver(env, updated, { conflict: next === "conflict" }),
    notifyDriverPush(env, updated, { conflict: next === "conflict" }),
    // Conflict customers get the change link too, so they can pick a new time themselves.
    notifyCustomer(env, updated)
  ]).catch((e) => console.error(e)));
}

/* ---------------- GET /api/booking/:id (return page after Square) ---------------- */

async function bookingStatus(id, env) {
  const b = await env.DB.prepare(`SELECT status, date, start_min, name, lang FROM bookings WHERE id = ?1`).bind(id).first();
  if (!b) return json({ error: "not_found" }, 404);
  // Only what the confirmation screen needs; no phone, email or address.
  return json({ status: b.status, date: b.date, start: b.start_min, firstName: String(b.name).split(" ")[0], lang: b.lang });
}

/* ---------------- cron: release unpaid holds ---------------- */

async function releaseExpiredHolds(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, square_link_id FROM bookings WHERE status = 'pending' AND hold_expires <= ?1`
  ).bind(Date.now()).all();
  for (const r of results) {
    const res = await env.DB.prepare(`UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status = 'pending'`)
      .bind(r.id).run();
    if (res.meta.changes) {
      try { await deletePaymentLink(env, r.square_link_id); } catch (e) { console.error(e?.message || e); }
    }
  }
  if (results.length) console.log(`released ${results.length} expired hold(s)`);
}

/* ---------------- local testing only (SQUARE_ENV = "mock") ---------------- */

async function mockPay(url, env, ctx) {
  const order = url.searchParams.get("order");
  const booking = url.searchParams.get("booking");
  await confirmPaid(env, ctx, order, `mock-payment-${crypto.randomUUID()}`);
  return Response.redirect(`${env.SITE_URL}/?booking=${booking}`, 302);
}
