// Emails via Resend (https://resend.com). Without RESEND_API_KEY they are logged and skipped,
// so bookings still work before email is set up.
import { CONFIG } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtTime(min, lang) {
  let h = Math.floor(min / 60); const m = min % 60;
  const pm = h >= 12; h = h % 12 || 12;
  const ap = lang === "en" ? (pm ? "PM" : "AM") : (pm ? "p. m." : "a. m.");
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
export function fmtDate(ymd, lang) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(lang === "en" ? "en-US" : "es-US",
    { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

const EQUIP_ES = { "Dump truck": "Camión de volteo", "Semi / tractor-trailer": "Tractocamión / rastra",
  "RV / motorhome": "RV / casa rodante", Boat: "Bote", Other: "Otro" };

async function send(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY || !to || to.startsWith("REPLACE")) {
    console.log(`[email skipped] to=${to} subject=${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, reply_to: replyTo })
  });
  if (!res.ok) console.error(`Resend ${res.status}: ${await res.text()}`);
}

const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${k}</td><td style="padding:4px 0;font-weight:600">${v}</td></tr>`;

// To the driver, always in Spanish.
export async function notifyDriver(env, b, { conflict = false } = {}) {
  const when = `${fmtDate(b.date, "es")}, ${fmtTime(b.start_min, "es")}`;
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(b.address)}`;
  const banner = conflict
    ? `<p style="background:#fde8e8;border-left:4px solid #D21F26;padding:10px 12px;margin:0 0 16px">
         <b>Atención:</b> este cliente pagó después de que su reserva expiró y esa hora ya estaba tomada.
         Llámalo para buscar otra hora o reembolsar los $${(b.deposit_cents / 100).toFixed(2)} desde Square.</p>`
    : "";
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">
    ${banner}
    <h2 style="margin:0 0 4px">Nueva entrega: ${esc(when)}</h2>
    <p style="margin:0 0 16px;color:#555">Depósito de $${(b.deposit_cents / 100).toFixed(2)} pagado con Square.</p>
    <table style="border-collapse:collapse">
      ${row("Cliente", esc(b.name))}
      ${row("Teléfono", `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>`)}
      ${row("Dirección", `<a href="${maps}">${esc(b.address)}</a> (${esc(b.zip)})`)}
      ${row("Equipo", esc(EQUIP_ES[b.equipment] || b.equipment))}
      ${row("Galones", b.gallons ? esc(b.gallons) : "—")}
      ${row("Detalles", esc(b.details))}
      ${row("Notas", b.notes ? esc(b.notes) : "—")}
      ${row("Correo", esc(b.email))}
    </table>
    <p style="margin:20px 0 0"><a href="${maps}" style="background:#D21F26;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Abrir en Google Maps</a></p>
  </div>`;
  await send(env, {
    to: env.NOTIFY_EMAIL,
    subject: `${conflict ? "⚠ CONFLICTO · " : ""}Entrega ${when} · ${b.name}`,
    html,
    replyTo: b.email
  });
}

const money = (b) => `$${(b.deposit_cents / 100).toFixed(2)}`;
const customerWhen = (b, en) => `${fmtDate(b.date, b.lang)} ${en ? "at" : "a las"} ${fmtTime(b.start_min, b.lang)}`;
const wrap = (inner) => `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">${inner}
    <p>Yire Oil Service LLC · (786) 259-7666</p>
  </div>`;

// "Change or cancel" link. The token lives in the #fragment so it never reaches server logs.
function manageBlock(env, b, en, { conflict = false } = {}) {
  if (!b.manage_token) return "";
  const url = `${env.SITE_URL}/reserva/#${b.id}.${b.manage_token}`;
  const left = Math.max(CONFIG.maxReschedules - (b.reschedule_count || 0), 0);
  const text = conflict
    ? (en ? "Pick a new time at no cost:" : "Escoge otra hora sin costo:")
    : left > 0
      ? (en ? `Change of plans? You can move your time for free up to ${CONFIG.rescheduleCutoffHours} hours before (${left} change${left === 1 ? "" : "s"} left), or cancel:`
            : `¿Cambio de planes? Puedes cambiar la hora gratis hasta ${CONFIG.rescheduleCutoffHours} horas antes (${left === 1 ? "te queda 1 cambio" : `te quedan ${left} cambios`}), o cancelar:`)
      : (en ? "Need to cancel? Use this link, or call us to change the time:"
            : "¿Necesitas cancelar? Usa este enlace, o llámanos para cambiar la hora:");
  return `<p>${text}<br><a href="${esc(url)}" style="display:inline-block;margin-top:8px;background:#D21F26;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${
    conflict ? (en ? "Pick a new time" : "Escoger otra hora") : (en ? "Change or cancel my booking" : "Cambiar o cancelar mi reserva")}</a></p>`;
}

// To the customer, in the language they booked in. Paid after the time was taken -> conflict version.
export async function notifyCustomer(env, b) {
  const en = b.lang === "en";
  const when = customerWhen(b, en);
  const first = esc(String(b.name).split(" ")[0]);
  const conflict = b.status === "conflict";
  const html = wrap(conflict
    ? `<h2 style="margin:0 0 8px">${en ? "We got your payment." : "Recibimos tu pago."}</h2>
    <p>${en
      ? `${first}, the time you picked (<b>${esc(when)}</b>) was taken while you were paying.`
      : `${first}, la hora que escogiste (<b>${esc(when)}</b>) se ocupó mientras pagabas.`}</p>
    ${manageBlock(env, b, en, { conflict: true })}
    <p style="color:#555">${en ? "Or call us and we'll find one together." : "O llámanos y buscamos una juntos."}</p>`
    : `<h2 style="margin:0 0 8px">${en ? "You're booked." : "Ya está reservado."}</h2>
    <p>${en
      ? `${first}, your diesel delivery is booked for <b>${esc(when)}</b> at ${esc(b.address)}. We'll call you when we're on the way.`
      : `${first}, tu entrega de diésel está reservada para el <b>${esc(when)}</b> en ${esc(b.address)}. Te llamaremos cuando vayamos en camino.`}</p>
    <p style="color:#555">${en
      ? `The ${money(b)} reservation fee is non-refundable. You pay for the diesel when we fill up.`
      : `La tarifa de reservación de ${money(b)} no es reembolsable. El diésel se paga cuando se llena el tanque.`}</p>
    ${manageBlock(env, b, en)}`);
  await send(env, {
    to: b.email,
    subject: conflict
      ? (en ? "Pick a new time for your diesel delivery" : "Escoge otra hora para tu entrega de diésel")
      : (en ? `Diesel delivery booked: ${when}` : `Entrega de diésel reservada: ${when}`),
    html
  });
}

// Customer: their booking moved to a new time, or was cancelled (by them or by the driver).
export async function notifyCustomerUpdate(env, b, { by }) {
  const en = b.lang === "en";
  const when = customerWhen(b, en);
  const first = esc(String(b.name).split(" ")[0]);
  if (b.status === "cancelled") {
    const html = wrap(`<h2 style="margin:0 0 8px">${en ? "Your booking is cancelled." : "Tu reserva está cancelada."}</h2>
    <p>${en
      ? `${first}, your delivery for <b>${esc(when)}</b> is cancelled.`
      : `${first}, tu entrega del <b>${esc(when)}</b> está cancelada.`}</p>
    <p style="color:#555">${by === "customer"
      ? (en ? `As agreed when booking, the ${money(b)} reservation fee is non-refundable.`
            : `Como se acordó al reservar, la tarifa de reservación de ${money(b)} no es reembolsable.`)
      : (en ? "Questions? Give us a call." : "¿Preguntas? Llámanos.")}</p>`);
    await send(env, { to: b.email, subject: en ? `Booking cancelled: ${when}` : `Reserva cancelada: ${when}`, html });
    return;
  }
  const html = wrap(`<h2 style="margin:0 0 8px">${en ? "Your new time" : "Tu nueva hora"}</h2>
    <p>${en
      ? `${first}, your diesel delivery is now <b>${esc(when)}</b> at ${esc(b.address)}.`
      : `${first}, tu entrega de diésel ahora es el <b>${esc(when)}</b> en ${esc(b.address)}.`}</p>
    ${manageBlock(env, b, en)}`);
  await send(env, { to: b.email, subject: en ? `New delivery time: ${when}` : `Nueva hora de entrega: ${when}`, html });
}

// Driver: the customer moved or cancelled online. (When the driver does it himself, no email.)
export async function notifyDriverUpdate(env, b, { from }) {
  const when = `${fmtDate(b.date, "es")}, ${fmtTime(b.start_min, "es")}`;
  const cancelled = b.status === "cancelled";
  const before = from ? `${fmtDate(from.date, "es")}, ${fmtTime(from.start_min, "es")}` : "";
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">
    <h2 style="margin:0 0 8px">${cancelled ? `Cancelada: ${esc(when)}` : `Cambio de hora: ${esc(when)}`}</h2>
    <p>${cancelled
      ? `${esc(b.name)} canceló su entrega del <b>${esc(when)}</b>. La reservación de ${money(b)} no se devuelve; esa hora ya está libre.`
      : `${esc(b.name)} cambió su entrega del ${esc(before)} al <b>${esc(when)}</b>.`}</p>
    <table style="border-collapse:collapse">
      ${row("Teléfono", `<a href="tel:${esc(b.phone)}">${esc(b.phone)}</a>`)}
      ${row("Dirección", `${esc(b.address)} (${esc(b.zip)})`)}
      ${row("Equipo", esc(EQUIP_ES[b.equipment] || b.equipment))}
    </table>
  </div>`;
  await send(env, {
    to: env.NOTIFY_EMAIL,
    subject: cancelled ? `Cancelada · ${when} · ${b.name}` : `Cambio de hora · ${when} · ${b.name}`,
    html,
    replyTo: b.email
  });
}
