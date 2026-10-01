// Emails via Resend (https://resend.com). Without RESEND_API_KEY they are logged and skipped,
// so bookings still work before email is set up.

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

// To the customer, in the language they booked in.
export async function notifyCustomer(env, b) {
  const en = b.lang === "en";
  const when = `${fmtDate(b.date, b.lang)} ${en ? "at" : "a las"} ${fmtTime(b.start_min, b.lang)}`;
  const first = esc(String(b.name).split(" ")[0]);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">
    <h2 style="margin:0 0 8px">${en ? "You're booked." : "Ya está reservado."}</h2>
    <p>${en
      ? `${first}, your diesel delivery is booked for <b>${esc(when)}</b> at ${esc(b.address)}. We'll call you when we're on the way.`
      : `${first}, tu entrega de diésel está reservada para el <b>${esc(when)}</b> en ${esc(b.address)}. Te llamaremos cuando vayamos en camino.`}</p>
    <p style="color:#555">${en
      ? `The $${(b.deposit_cents / 100).toFixed(2)} reservation fee is non-refundable. You pay for the diesel when we fill up.`
      : `La tarifa de reservación de $${(b.deposit_cents / 100).toFixed(2)} no es reembolsable. El diésel se paga cuando se llena el tanque.`}</p>
    <p>Yire Oil Service LLC · (786) 259-7666</p>
  </div>`;
  await send(env, {
    to: b.email,
    subject: en ? `Diesel delivery booked: ${when}` : `Entrega de diésel reservada: ${when}`,
    html
  });
}
