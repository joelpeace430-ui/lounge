// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — M-Pesa settings backend
// ═══════════════════════════════════════════════════════════════════════════
// Handles saving and checking an owner's M-Pesa configuration:
//   POST /api/mpesa-settings?action=save    → encrypts + stores production credentials
//   POST /api/mpesa-settings?action=status  → tells the browser WHETHER production
//                                               credentials are set, never WHAT they are
//
// SANDBOX is intentionally invisible here — it doesn't touch this file at all.
// An owner on Sandbox uses YOUR OWN server-side Daraja test credentials
// automatically (handled entirely inside api/mpesa.js using env vars), so
// there's nothing for them to see, set, or save. Only switching to Production
// brings this endpoint into play, and only then does the owner type in their
// own real credentials.
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  — same as mpesa.js
//   MPESA_ENCRYPTION_KEY                                        — see lib/mpesaCrypto.js
// ═══════════════════════════════════════════════════════════════════════════

import { encrypt } from '../lib/mpesaCrypto.js';

async function sbFetch(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} failed: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function verifyOwner(accessToken) {
  if (!accessToken) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  return user.id;
}

async function handleSave(req, res) {
  try {
    const { accessToken, env, shortcode, consumerKey, consumerSecret, passkey, name } = req.body || {};
    const ownerId = await verifyOwner(accessToken);
    if (!ownerId) return res.status(401).json({ error: 'Please log in again' });
    if (!process.env.MPESA_ENCRYPTION_KEY) {
      console.error('Missing environment variable: MPESA_ENCRYPTION_KEY');
      return res.status(500).json({ error: 'Server is missing its encryption key — set MPESA_ENCRYPTION_KEY in Vercel, then redeploy.' });
    }

    const payload = { id: ownerId, name: name || 'Owner', mpesa_env: env === 'production' ? 'production' : 'sandbox' };

    if (env === 'production') {
      // real credentials — encrypted before they ever touch the database.
      // IMPORTANT: only set a column if the client actually sent that field.
      // The frontend omits consumerKey/consumerSecret/passkey entirely when
      // they're still masked/collapsed (owner didn't click "Change credentials")
      // — if we defaulted those to '' here, just changing the Till number would
      // silently wipe out already-saved credentials. Only overwrite what was
      // actually sent.
      payload.mpesa_shortcode = shortcode || '';
      if (consumerKey !== undefined) payload.mpesa_consumer_key = consumerKey ? encrypt(consumerKey) : '';
      if (consumerSecret !== undefined) payload.mpesa_consumer_secret = consumerSecret ? encrypt(consumerSecret) : '';
      if (passkey !== undefined) payload.mpesa_passkey = passkey ? encrypt(passkey) : '';
    } else {
      // switching back to sandbox — clear out any stored production credentials
      // rather than leaving stale encrypted values sitting around unused
      payload.mpesa_shortcode = '';
      payload.mpesa_consumer_key = '';
      payload.mpesa_consumer_secret = '';
      payload.mpesa_passkey = '';
    }

    await sbFetch('/profiles', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(payload),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('mpesa-settings save error:', err);
    return res.status(500).json({ error: 'Could not save: ' + err.message });
  }
}

async function handleStatus(req, res) {
  try {
    const { accessToken } = req.body || {};
    const ownerId = await verifyOwner(accessToken);
    if (!ownerId) return res.status(401).json({ error: 'Please log in again' });

    const rows = await sbFetch(`/profiles?id=eq.${ownerId}&select=mpesa_env,mpesa_shortcode,mpesa_consumer_key,mpesa_consumer_secret,mpesa_passkey`);
    const p = (rows && rows[0]) || {};

    // booleans and the (non-secret) till number only — never the actual key/secret/passkey
    return res.status(200).json({
      env: p.mpesa_env || 'sandbox',
      shortcode: p.mpesa_shortcode || '',
      hasConsumerKey: !!p.mpesa_consumer_key,
      hasConsumerSecret: !!p.mpesa_consumer_secret,
      hasPasskey: !!p.mpesa_passkey,
    });
  } catch (err) {
    console.error('mpesa-settings status error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.query.action === 'status') return handleStatus(req, res);
  return handleSave(req, res);
}
