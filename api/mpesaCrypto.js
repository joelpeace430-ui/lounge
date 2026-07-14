// ═══════════════════════════════════════════════════════════════════════════
// Shared encrypt/decrypt helper for M-Pesa production credentials.
// AES-256-GCM — the key never leaves the server (Vercel env var), the browser
// never sees plaintext secrets after they're first saved, and even someone
// with read access to the Supabase table sees only ciphertext.
//
// Required environment variable:
//   MPESA_ENCRYPTION_KEY — a 32-byte key, base64-encoded. Generate one with:
//     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   Set it once and never change it — changing it makes every already-saved
//   credential undecryptable (owners would need to re-enter them).
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

function getKey() {
  const raw = process.env.MPESA_ENCRYPTION_KEY;
  if (!raw) throw new Error('MPESA_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MPESA_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

// returns "iv:authTag:ciphertext", all base64 — safe to store as a single text column
export function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decrypt(stored) {
  if (!stored) return '';
  const [ivB64, tagB64, ctB64] = String(stored).split(':');
  if (!ivB64 || !tagB64 || !ctB64) return ''; // not our format (e.g. leftover plaintext from before encryption existed)
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
