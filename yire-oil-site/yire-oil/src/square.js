// Square Checkout API (payment links) + webhook signature check.
// SQUARE_ENV: "sandbox" | "production" | "mock" (local testing only: no network, fake checkout page).

const baseUrl = (env) =>
  env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";

async function squareFetch(env, path, init = {}) {
  const headers = {
    Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };
  if (env.SQUARE_VERSION) headers["Square-Version"] = env.SQUARE_VERSION; // else the app's default version
  const res = await fetch(baseUrl(env) + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Square ${res.status} ${path}: ${JSON.stringify(body.errors || body)}`);
  return body;
}

// Square wants E.164; skip the field rather than fail checkout on an odd number.
function toE164(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

// Returns { id, url, orderId }.
export async function createPaymentLink(env, booking, { itemName, note }) {
  if (env.SQUARE_ENV === "mock") {
    const orderId = `mock-order-${crypto.randomUUID()}`;
    return {
      id: `mock-link-${crypto.randomUUID()}`,
      orderId,
      url: `${env.SITE_URL}/api/mock-pay?order=${orderId}&booking=${booking.id}`
    };
  }
  const prePopulated = { buyer_email: booking.email };
  const phone = toE164(booking.phone);
  if (phone) prePopulated.buyer_phone_number = phone;

  const body = await squareFetch(env, "/v2/online-checkout/payment-links", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: booking.id,
      quick_pay: {
        name: itemName,
        price_money: { amount: booking.deposit_cents, currency: "USD" },
        location_id: env.SQUARE_LOCATION_ID
      },
      checkout_options: {
        redirect_url: `${env.SITE_URL}/?booking=${booking.id}`,
        ask_for_shipping_address: false
      },
      pre_populated_data: prePopulated,
      payment_note: note
    })
  });
  const link = body.payment_link;
  return { id: link.id, url: link.url, orderId: link.order_id };
}

export async function deletePaymentLink(env, linkId) {
  if (!linkId || env.SQUARE_ENV === "mock") return;
  await squareFetch(env, `/v2/online-checkout/payment-links/${linkId}`, { method: "DELETE" });
}

// Square signs: base64(HMAC-SHA256(signatureKey, notificationUrl + rawBody)) in x-square-hmacsha256-signature.
export async function verifySquareSignature(signatureKey, notificationUrl, rawBody, signature) {
  if (!signatureKey || !signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signatureKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(notificationUrl + rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
