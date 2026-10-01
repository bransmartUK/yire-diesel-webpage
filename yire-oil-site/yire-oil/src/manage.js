// Changing or cancelling a paid booking, by the customer (secret link in their emails, /reserva/)
// or by the driver (/chofer/). The deposit stays with the booking when the time moves; cancelling forfeits it.
import { CONFIG } from "./config.js";
import { ZIP_INDEX } from "./zips.js";
import { nowLocal, openSlots, availabilityMap, windowEnd, isValidStart, dayOfWeek } from "./schedule.js";
import { activeBookings, blocksBetween } from "./db.js";
import { notifyCustomerUpdate, notifyDriverUpdate } from "./email.js";
import { notifyDriverPushUpdate } from "./push.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const BASE = () => ZIP_INDEX[CONFIG.baseZip];
export const isChangeable = (b) => b.status === "confirmed" || b.status === "conflict";

// Minutes from now until the delivery starts (local time; ignores the DST hour, which is fine for a 12 h cutoff).
function minutesUntil(b, now) {
  const days = (Date.parse(`${b.date}T00:00:00Z`) - Date.parse(`${now.date}T00:00:00Z`)) / 86_400_000;
  return days * 1440 + b.start_min - now.min;
}

// What the customer may do online right now. A conflict booking (paid after its time was taken)
// can always pick a new time, and that move doesn't count against the limit.
function customerRules(b, now) {
  const until = minutesUntil(b, now);
  const changesLeft = Math.max(CONFIG.maxReschedules - (b.reschedule_count || 0), 0);
  let changeBlocked = null;
  if (!isChangeable(b) || until <= 0) changeBlocked = "status";
  else if (b.status === "confirmed" && until < CONFIG.rescheduleCutoffHours * 60) changeBlocked = "cutoff";
  else if (b.status === "confirmed" && changesLeft === 0) changeBlocked = "limit";
  return { changesLeft, changeBlocked, canCancel: isChangeable(b) && until > 0 };
}

async function slotFree(env, b, date, start, now) {
  const [others, blocks] = await Promise.all([
    activeBookings(env, date, date, { excludeId: b.id }),
    blocksBetween(env, date, date)
  ]);
  return openSlots(date, { lat: b.lat, lng: b.lng }, others, blocks, now, BASE()).includes(start);
}

// Open start times on one day for this booking's location, as if it weren't on the calendar.
export async function slotsOn(env, b, date) {
  const [others, blocks] = await Promise.all([
    activeBookings(env, date, date, { excludeId: b.id }),
    blocksBetween(env, date, date)
  ]);
  return openSlots(date, { lat: b.lat, lng: b.lng }, others, blocks, nowLocal(), BASE());
}

async function daysFor(env, b) {
  const now = nowLocal();
  const end = windowEnd(now);
  const [others, blocks] = await Promise.all([
    activeBookings(env, now.date, end, { excludeId: b.id }),
    blocksBetween(env, now.date, end)
  ]);
  return availabilityMap({ lat: b.lat, lng: b.lng }, others, blocks, now, BASE());
}

// Moves a paid booking to a new open time.
// Returns "ok" | "bad_slot" | "same_slot" | "slot_taken" | "not_changeable".
export async function moveBooking(env, b, date, start, { countsAsChange }) {
  const now = nowLocal();
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < now.date || date > windowEnd(now)
      || !CONFIG.openDays.includes(dayOfWeek(date)) || !isValidStart(start)) return "bad_slot";
  if (date === b.date && start === b.start_min) return "same_slot";
  if (!(await slotFree(env, b, date, start, now))) return "slot_taken";

  const step = countsAsChange ? 1 : 0;
  const moved = await env.DB.prepare(
    `UPDATE bookings SET date = ?1, start_min = ?2, status = 'confirmed', reschedule_count = reschedule_count + ?3
     WHERE id = ?4 AND date = ?5 AND start_min = ?6 AND status = ?7`
  ).bind(date, start, step, b.id, b.date, b.start_min, b.status).run();
  if (!moved.meta.changes) return "not_changeable"; // changed or cancelled by someone else meanwhile

  // A checkout or another move may have taken the same time in the same instant; if so, back out.
  // (Checkout does the same re-check, so at worst both back off and nobody is double-booked.)
  if (!(await slotFree(env, b, date, start, now))) {
    await env.DB.prepare(
      `UPDATE bookings SET date = ?1, start_min = ?2, status = ?3, reschedule_count = reschedule_count - ?4
       WHERE id = ?5 AND date = ?6 AND start_min = ?7`
    ).bind(b.date, b.start_min, b.status, step, b.id, date, start).run();
    return "slot_taken";
  }
  return "ok";
}

export async function cancelBooking(env, b) {
  const result = await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?1 WHERE id = ?2 AND status IN ('confirmed','conflict')`
  ).bind(Date.now(), b.id).run();
  return result.meta.changes > 0;
}

/* ---------------- customer API: POST /api/manage/{get,move,cancel} with {id, token} ---------------- */

async function loadByToken(env, body) {
  if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return null;
  if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.token)) return null;
  return env.DB.prepare(`SELECT * FROM bookings WHERE id = ?1 AND manage_token = ?2`).bind(body.id, body.token).first();
}

// Only what the page needs; the token holder is the customer, so their own address is fine.
async function customerView(env, b) {
  const rules = customerRules(b, nowLocal());
  return {
    status: b.status, date: b.date, start: b.start_min, lang: b.lang,
    firstName: String(b.name).split(" ")[0], address: b.address,
    deposit: b.deposit_cents / 100, cutoffHours: CONFIG.rescheduleCutoffHours, maxChanges: CONFIG.maxReschedules,
    ...rules,
    days: rules.changeBlocked ? {} : await daysFor(env, b)
  };
}

const notifyAll = (ctx, promises) => ctx.waitUntil(Promise.all(promises).catch((e) => console.error(e)));

export async function handleManageApi(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const b = await loadByToken(env, body);
  if (!b) return json({ error: "not_found" }, 404);

  if (url.pathname === "/api/manage/get") return json(await customerView(env, b));

  if (url.pathname === "/api/manage/move") {
    const { changeBlocked } = customerRules(b, nowLocal());
    if (changeBlocked) return json({ error: "change_blocked", reason: changeBlocked }, 409);
    const result = await moveBooking(env, b, body.date, body.start, { countsAsChange: b.status === "confirmed" });
    if (result !== "ok") return json({ error: result }, result === "bad_slot" || result === "same_slot" ? 400 : 409);
    const updated = { ...b, date: body.date, start_min: body.start, status: "confirmed",
      reschedule_count: (b.reschedule_count || 0) + (b.status === "confirmed" ? 1 : 0) };
    notifyAll(ctx, [
      notifyCustomerUpdate(env, updated, { by: "customer" }),
      notifyDriverUpdate(env, updated, { from: b }),
      notifyDriverPushUpdate(env, updated, { from: b })
    ]);
    return json(await customerView(env, updated));
  }

  if (url.pathname === "/api/manage/cancel") {
    if (!customerRules(b, nowLocal()).canCancel || !(await cancelBooking(env, b))) {
      return json({ error: "not_cancellable" }, 409);
    }
    const updated = { ...b, status: "cancelled" };
    notifyAll(ctx, [
      notifyCustomerUpdate(env, updated, { by: "customer" }),
      notifyDriverUpdate(env, updated, {}),
      notifyDriverPushUpdate(env, updated, {})
    ]);
    return json(await customerView(env, updated));
  }

  return json({ error: "not_found" }, 404);
}
