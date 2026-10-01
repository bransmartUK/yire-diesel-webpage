import { CONFIG } from "./config.js";

const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// Current date and minute-of-day in the business's time zone (Workers run in UTC).
export function nowLocal(tz = CONFIG.tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dayOfWeek(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function milesBetween(a, b) {
  const R = 3958.8, r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Estimated drive minutes, rounded up to 5.
export function travelMin(a, b) {
  const miles = milesBetween(a, b) * CONFIG.roadFactor;
  return Math.ceil((CONFIG.overheadMin + (miles / CONFIG.avgMph) * 60) / 5) * 5;
}

/* Open start times on `date` for a stop at `loc`.
   For every booking B that day:
     B before S:  B.start + service + drive(B -> loc) <= S
     B after  S:  S + service + drive(loc -> B) <= B.start
   Blocks are plain time windows the service time can't overlap. */
export function openSlots(date, loc, dayBookings, dayBlocks, now, base) {
  const isToday = date === now.date;
  const earliestFromBase = CONFIG.departBaseAt ? toMin(CONFIG.departBaseAt) + travelMin(base, loc) : 0;
  const out = [];
  for (let s = toMin(CONFIG.firstStart); s <= toMin(CONFIG.lastStart); s += CONFIG.slotStepMin) {
    if (isToday && s < now.min + CONFIG.minLeadMin) continue;
    if (s < earliestFromBase) continue;
    const e = s + Math.max(CONFIG.serviceMin, 1);
    if (dayBlocks.some((bl) => s < bl.end_min && e > bl.start_min)) continue;
    const fits = dayBookings.every((b) => {
      const bl = { lat: b.lat, lng: b.lng };
      return b.start_min <= s
        ? b.start_min + CONFIG.serviceMin + travelMin(bl, loc) <= s
        : s + CONFIG.serviceMin + travelMin(loc, bl) <= b.start_min;
    });
    if (fits) out.push(s);
  }
  return out;
}

// { 'YYYY-MM-DD': [startMin, ...] } for every bookable day in the window (days with no slots omitted).
export function availabilityMap(loc, bookings, blocks, now, base) {
  const byDate = (rows) => rows.reduce((m, r) => ((m[r.date] ||= []).push(r), m), {});
  const bk = byDate(bookings), bl = byDate(blocks);
  const out = {};
  for (let i = 0; i <= CONFIG.bookAheadDays; i++) {
    const date = addDays(now.date, i);
    if (!CONFIG.openDays.includes(dayOfWeek(date))) continue;
    const slots = openSlots(date, loc, bk[date] || [], bl[date] || [], now, base);
    if (slots.length) out[date] = slots;
  }
  return out;
}

export const windowEnd = (now) => addDays(now.date, CONFIG.bookAheadDays);
export const isValidStart = (s) =>
  Number.isInteger(s) && s >= toMin(CONFIG.firstStart) && s <= toMin(CONFIG.lastStart) &&
  (s - toMin(CONFIG.firstStart)) % CONFIG.slotStepMin === 0;
