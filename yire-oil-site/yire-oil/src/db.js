// Queries shared by checkout, the webhook, booking changes and the driver page.

// Bookings that occupy the truck: paid, conflict (paid, needs a call), completed by the driver,
// or held and still within the hold.
export async function activeBookings(env, fromDate, toDate, { excludeId = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT id, date, start_min, lat, lng, status, created_at FROM bookings
     WHERE date BETWEEN ?1 AND ?2
       AND (status IN ('confirmed','conflict','completed') OR (status = 'pending' AND hold_expires > ?3))
       AND (?4 IS NULL OR id <> ?4)`
  ).bind(fromDate, toDate, Date.now(), excludeId).all();
  return results;
}

// One row per thing that happened to a booking (driver page bell). Never breaks the caller,
// e.g. if the activity migration hasn't been applied yet.
export async function logActivity(env, kind, actor, b, from = null) {
  try {
    await env.DB.prepare(
      `INSERT INTO activity (at, kind, actor, booking_id, name, date, start_min, from_date, from_start)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(Date.now(), kind, actor, b.id, b.name, b.date, b.start_min, from?.date ?? null, from?.start_min ?? null).run();
  } catch (error) {
    console.error("activity log failed:", error?.message || error);
  }
}

export async function blocksBetween(env, fromDate, toDate) {
  const { results } = await env.DB.prepare(
    `SELECT date, start_min, end_min FROM blocks WHERE date BETWEEN ?1 AND ?2`
  ).bind(fromDate, toDate).all();
  return results;
}
