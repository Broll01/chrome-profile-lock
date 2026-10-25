/*
 * Crypto helpers (used by the background service worker only).
 * Secrets are stored as salted PBKDF2-SHA256 hashes.
 * sha256() is kept only to verify the PIN saved by version 1.0.
 */

const PBKDF2_ITERATIONS = 150000;

function toB64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Legacy (v1.0) unsalted hash, hex encoded.
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashSecret(secret, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64
    ? fromB64(saltB64)
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );

  return { salt: toB64(salt), hash: toB64(bits), iter: iterations };
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function verifySecret(secret, entry) {
  if (!entry || !entry.hash || !entry.salt) return false;
  const computed = await hashSecret(secret, entry.salt, entry.iter);
  return timingSafeEqual(computed.hash, entry.hash);
}
