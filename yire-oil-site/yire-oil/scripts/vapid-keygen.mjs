// Prints a new VAPID private key (JWK) for Web Push. Pipe it straight into the secret so it never shows on screen:
//   node scripts/vapid-keygen.mjs | npx.cmd wrangler secret put VAPID_PRIVATE_JWK
// Replacing the key later means the driver has to tap "Activar avisos" again.
const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
process.stdout.write(JSON.stringify({ kty, crv, x, y, d }));
