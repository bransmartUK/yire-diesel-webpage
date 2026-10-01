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

export async function blocksBetween(env, fromDate, toDate) {
  const { results } = await env.DB.prepare(
    `SELECT date, start_min, end_min FROM blocks WHERE date BETWEEN ?1 AND ?2`
  ).bind(fromDate, toDate).all();
  return results;
}
