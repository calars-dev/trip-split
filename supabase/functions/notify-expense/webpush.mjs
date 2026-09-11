// Web Push with nothing but WebCrypto — no push library.
//
// A port of review_hub/push.py, which already delivers to real iPhones:
//   · RFC 8291 aes128gcm — the message is encrypted for one phone only, so the
//     push service (Apple's, Google's, Mozilla's) relays ciphertext it cannot read.
//   · RFC 8292 VAPID — a short ES256 token tells the push service who is sending.
//
// Runs unchanged in Deno (the Edge Function) and in Node (the test), because both
// expose the same `crypto.subtle`. test/webpush.test.js holds this to push.py
// byte for byte on a fixed vector.

const enc = new TextEncoder();
export const RECORD_SIZE = 4096;

export function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// The 65-byte uncompressed point Web Push passes around, split into JWK x/y.
function jwkFromPoint(point, d) {
  const jwk = { kty: "EC", crv: "P-256", x: b64u(point.slice(1, 33)), y: b64u(point.slice(33, 65)), ext: true };
  if (d) jwk.d = d;
  return jwk;
}

// RFC 8291 body for one subscription. `salt` and `sender` ({d, x, y} as base64url)
// are injectable so a test can reproduce push.py exactly; in use both are random.
export async function encrypt(payload, p256dh, authSecret, opts = {}) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);

  let senderPriv, senderPublic;
  if (opts.sender) {
    senderPriv = await crypto.subtle.importKey("jwk",
      { kty: "EC", crv: "P-256", d: opts.sender.d, x: opts.sender.x, y: opts.sender.y, ext: true },
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    senderPublic = concat(new Uint8Array([4]), unb64u(opts.sender.x), unb64u(opts.sender.y));
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    senderPriv = pair.privateKey;
    senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, senderPriv, 256));

  const ikm = await hmac(await hmac(auth, shared),
    concat(enc.encode("WebPush: info\0"), uaPublic, senderPublic, new Uint8Array([1])));
  const salt = opts.salt ? unb64u(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // \x02 marks the last (and only) record
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes,
    concat(payload, new Uint8Array([2]))));

  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, RECORD_SIZE);
  head[20] = senderPublic.length;
  return concat(head, senderPublic, body);
}

// The Authorization header: a 12-hour ES256 token scoped to this push service.
// WebCrypto's ECDSA signature is already the raw r||s that JWT wants.
export async function vapidAuth(endpoint, subject, publicKey, privateD, exp) {
  const u = new URL(endpoint);
  const claims = { aud: `${u.protocol}//${u.host}`, exp: exp ?? Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const signing = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "."
    + b64u(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("jwk", jwkFromPoint(unb64u(publicKey), privateD),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signing)));
  return `vapid t=${signing}.${b64u(sig)}, k=${publicKey}`;
}

// One notification to one phone. { ok, status } — 404/410 means the phone
// unsubscribed or the app was removed, and the caller should forget it.
export async function sendPush(sub, message, vapid) {
  const body = await encrypt(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth_key);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "normal",
      "Authorization": await vapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateD),
    },
    body,
  });
  try { await res.body?.cancel(); } catch (_) { /* nothing to read */ }
  return { ok: res.ok, status: res.status };
}
