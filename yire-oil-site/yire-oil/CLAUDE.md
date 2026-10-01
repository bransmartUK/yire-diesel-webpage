# Yire Oil Service — booking site

Booking website for **Yire Oil Service LLC**, my stepdad's diesel delivery business in South Florida (owner/driver: Livan Miranda, (786) 259-7666, USDOT 4600167). Customers book a delivery time, pay a **$50 non-refundable reservation fee** through **Square**, and he drives a 2,500-gal tank truck to them. Main customers: dump trucks, semis, RVs, and boats at marinas. Diesel only.

I'm Bran, a developer (Java/JS background). I want direct, concrete code changes with a short explanation of *why* — not long write-ups or generated report files.

## Stack

- **Cloudflare Worker** (`yire-oil`) serving static assets from `public/` + an API under `/api/*` (`run_worker_first: ["/api/*"]`).
- **D1** database `yire-oil` (binding `DB`), migrations in `migrations/`.
- **Square Checkout API** (payment links) for the $50 deposit (`depositCents` in config.js + `depositUSD` in index.html); **webhook** `payment.updated` confirms bookings.
- **Resend** for email (optional; skipped with a log line if `RESEND_API_KEY` is unset).
- **Cron** every 5 min releases unpaid holds.
- Live at `https://yire-oil.skywayhighwaygames.workers.dev` and **`https://yireoilservices.com`** (zone on Cloudflare, apex already serves this Worker; no `www` record, no MX yet). `SITE_URL` still points at workers.dev, so Square redirects/webhooks use that.
- I'm on **Windows / PowerShell**. Use `npx wrangler ...` (or `npx.cmd` if execution policy complains).

## Files

```
public/index.html      Single-page site (hero, mission/contact, 3-step booking). All JS/CSS inline.
public/logo.jpg        Yire Oil logo (black background)
public/truck.jpg       Hero photo of the truck
src/index.js           Router: /api/availability, /api/checkout, /api/square-webhook, /api/booking/:id,
                       /api/mock-pay (mock mode only), scheduled() cleanup
src/schedule.js        Availability engine (time zone, drive-time estimate, open slots)
src/config.js          Server-side business rules (source of truth)
src/square.js          createPaymentLink, deletePaymentLink, verifySquareSignature
src/email.js           notifyDriver (always Spanish), notifyCustomer (customer's language)
src/zips.js            193 South Florida ZIP centroids (Miami-Dade, Broward, Palm Beach, Monroe)
migrations/0001_init.sql   bookings + blocks tables
wrangler.jsonc         Config, vars, D1 binding, cron
.dev.vars.example      Local dev: SQUARE_ENV=mock
```

## How booking works

1. Customer enters ZIP → `GET /api/availability?zip=` returns `{zip, city, today, days: {'YYYY-MM-DD': [startMin...]}}` for the next 60 days. Out-of-area ZIP → 400 `out_of_area`.
2. Picks day/time, fills form (name, phone, email, address/marina, equipment type, approx gallons, details, notes, non-refundable checkbox).
3. `POST /api/checkout` → validates, re-checks slot, inserts a **pending hold** (30 min), re-checks against earlier holds (race guard; later one gets 409 `slot_taken`), creates a Square payment link (quick_pay, $50, `redirect_url = SITE_URL/?booking=<id>`), returns `{url}`. Browser redirects to Square.
4. Square calls `POST /api/square-webhook` (HMAC-SHA256 of `notificationUrl + rawBody`, header `x-square-hmacsha256-signature`). On `COMPLETED`, booking → `confirmed`, emails sent. Idempotent for duplicate webhooks.
5. Customer returns to `/?booking=<id>`; the page polls `GET /api/booking/:id` (returns only status, date, start, first name, lang — no PII) and shows "Ya está reservado."
6. Cron: pending holds past `hold_expires` → `expired`, Square link deleted.
7. Paid after expiry: confirmed if the slot is still free, else `conflict` + "⚠ CONFLICTO" email to the driver (call customer / refund in Square).

Booking statuses: `pending | confirmed | expired | cancelled | conflict | completed` (set by the driver page). Active (occupies the truck) = confirmed, conflict, completed, or pending with an unexpired hold.

## Scheduling rules (src/config.js)

- Base ZIP **33182** (West Miami). Open **24/7**: `openDays` all 7, slots `00:00`–`23:30` every **30 min**, book up to **60 days** ahead, **60 min** minimum lead time. Time zone `America/New_York` (Workers run in UTC — always use `nowLocal()`).
- **serviceMin 30**: time at a stop until he's ready for the next one.
- Drive time estimate between ZIP centroids: `overheadMin(10) + haversineMiles × roadFactor(1.25) / avgMph(45) × 60`, rounded up to 5 min.
- Slot S at location L is open iff for every active booking B that day: if B is before S, `B.start + 30 + drive(B→L) ≤ S`; if after, `S + 30 + drive(L→B) ≤ B.start`. Plus no overlap with `blocks` (driver time off).
- `departBaseAt` (null) optionally requires the first stop to be reachable from base by a set time.
- **public/index.html has its own `CONFIG` with the same values for display.** If hours/timing change, change both files.

## Frontend (public/index.html)

- **Spanish by default** (`CONFIG.defaultLang: "es"`), toggle Español/English top right, choice saved in localStorage. All copy lives in the `I18N` object (`es` / `en`); static text uses `data-i18n`, `data-i18n-aria`, `data-i18n-ph`, `data-i18n-alt`.
- **Spanish uses tú, not usted** (tu/tus, reserva, escoge, llama, etc.). Keep it that way.
- **Live vs demo mode:** on load it probes `/api/availability`; if JSON comes back it uses the server (`API = true`), otherwise it falls back to a local demo (bookings in localStorage, no payment). The demo is what the Claude preview artifact uses.
- Brand: black/red/white from the logo (`--red: #D21F26`), Barlow + Barlow Condensed, red/white reflective-tape stripe under the header. Hero = logo bar + truck photo.
- Stored values stay in English (equipment `"Dump truck"`, etc.); display is translated.
- Placeholder still in the page: contact email `hello@yireoil.com`.

## Commands

```powershell
npm install
npm run dev                 # local, with .dev.vars (copy .dev.vars.example); SQUARE_ENV=mock fakes payment
npm run db:migrate:local
npm run db:migrate          # remote D1
npm run deploy              # = npx wrangler deploy
npm run logs                # = npx wrangler tail
npx wrangler secret list
npx wrangler d1 execute yire-oil --remote --command "SELECT date, start_min, status, name FROM bookings"
```

Secrets (set with `npx wrangler secret put NAME`, never in files or chat): `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `RESEND_API_KEY`.
Vars in wrangler.jsonc: `SQUARE_ENV` (`sandbox` | `production` | `mock`), `SITE_URL`, `NOTIFY_EMAIL`, `FROM_EMAIL`. Optional: `SQUARE_VERSION`, `SQUARE_WEBHOOK_URL` (if it must differ from `SITE_URL/api/square-webhook`).

## Status (as of 2026-10-01)

- ✅ Deployed with D1 + cron. Square **sandbox** end-to-end test passed (checkout → webhook 200 → confirmed → return page).
- ✅ Square sandbox app is under **my** Square account (fine for testing).
- ✅ `RESEND_API_KEY` is configured. A synthetic Spanish booking notification to `NOTIFY_EMAIL` was accepted by Resend (HTTP 200); check inbox/spam for delivery. `onboarding@resend.dev` only delivers to the Resend account owner; verify a domain before emailing my stepdad.
- ⏳ **Production Square** must be set up **signed in as my stepdad** (his seller account) so deposits go to him: create app → Production access token + Location ID → webhook subscription (`payment.updated`, exact URL) → set the 3 secrets → `SQUARE_ENV: "production"` → deploy. Don't use OAuth; one-business setup.
- ⏳ Custom domain `yireoilservices.com` is attached. Still to do: switch `SITE_URL` + Square webhook subscription URL together (or set `SQUARE_WEBHOOK_URL` to the old URL meanwhile), verify the domain in Resend + `FROM_EMAIL`, real contact email (needs MX), then consider disabling workers.dev.
- 🧹 A sandbox test booking (name "vewv", Fri Oct 2 1:00 AM) may still be blocking that slot — cancel with `UPDATE bookings SET status='cancelled' WHERE name='vewv'`.

## Driver page

- Implemented at `/chofer/` in `public/chofer/index.html`; Spanish-first, phone-sized controls, and a home-screen manifest.
- `/api/driver/*` is in `src/driver.js`: day stops and drive estimates, mark complete, and create/delete time blocks. Conflicting paid or unexpired held bookings prevent a new block.
- Before deploying, create a Cloudflare Access self-hosted application protecting `/chofer*` and `/api/driver/*`, with an email one-time-code allow policy. Self-hosted apps can target the workers.dev hostname + path (no custom domain needed). Do **not** use Worker-level or account-wide Access — that locks the whole site and the Square webhook. Set `ACCESS_TEAM_DOMAIN` to the Access team hostname (for example, `team.cloudflareaccess.com`) and `ACCESS_AUD` to the app's audience tag in `wrangler.jsonc`. The Worker verifies the JWT signature, issuer, audience, and expiry; unset values deny access.
- Apply `migrations/0002_driver_completion.sql` before deploying the Worker; it adds `completed_at`. Use `npm run db:migrate:local` for the local database. Ask before applying remote migrations or deploying.
- Later ideas: add each confirmed booking to his Google Calendar; 7 AM daily summary email; SMS needs A2P 10DLC registration first.

## Gotchas

- `wrangler tail` fails with "Cannot tail a Worker which only has assets" if the deployed version has no `main` script — redeploy.
- Webhook URL in Square must match `SITE_URL/api/square-webhook` exactly (https, no trailing slash) or signatures fail (401).
- Sandbox vs Production in Square have separate tokens, locations, and webhook subscriptions/keys.
- Square online processing on his free plan: 3.3% + 30¢ (~$1.95 per $50 deposit).
