// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — payment backend (M-Pesa)
// ═══════════════════════════════════════════════════════════════════════════
// This file: the ONLY part of the app that talks to Safaricom + holds secret
// keys. Everything else (UI, camera, sessions, etc.) lives in index.html.
//
// Handles BOTH sides of an M-Pesa payment in one file:
//   POST /api/mpesa                  → called by index.html to send an STK push
//   POST /api/mpesa?action=callback  → called by Safaricom to confirm the result
//
// Why this can't be merged into index.html:
//   1. Vercel only turns files inside an "api/" folder into live server
//      addresses — merged into the HTML, this would just be inert text.
//   2. It holds secret keys (Daraja Consumer Secret, Supabase service_role
//      key) that would be stolen instantly if they were in the browser's HTML.
//
// Deploy alongside (same folder structure):
//   /index.html
//   /api/mpesa.js   (this file)
//   /package.json
//
// Required environment variables (Vercel → Project → Settings → Environment Variables):
//   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET   — from your Daraja app
//   MPESA_SHORTCODE, MPESA_PASSKEY              — your Till/Paybill + passkey
//   MPESA_ENV                                   — "sandbox" or "production"
//   SUPABASE_URL                                — same URL used in the frontend
//   SUPABASE_ANON_KEY                           — same anon key used in the frontend
//   SUPABASE_SERVICE_ROLE_KEY                   — Supabase → Settings → API → service_role key (secret — never used in the frontend)
//   PUBLIC_BASE_URL                             — your deployed site's URL, e.g. https://your-app.vercel.app
// ═══════════════════════════════════════════════════════════════════════════

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

function calcPrice(elapsedMs, profile) {
  const rate = profile.rate_per_hour || 0;
  if (!rate) return null;
  let mins = elapsedMs / 60000;
  const round = profile.round_mode || 'none';
  if (round !== 'none') {
    const step = parseInt(round);
    mins = Math.ceil(mins / step) * step;
  }
  let price = (mins / 60) * rate;
  if (profile.min_charge > 0 && price < profile.min_charge) price = profile.min_charge;
  return Math.round(price * 100) / 100;
}

// ── STK push initiation — called from the browser ──────────────────────────────
async function handleInitiate(req, res) {
  try {
    const { phone, amount, sessionId, idnum, accessToken } = req.body || {};
    if (!phone || !amount || !idnum || !accessToken) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // verify the caller is actually a logged-in owner (don't trust the client blindly)
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session — please log in again' });
    const user = await userRes.json();
    const ownerId = user.id;

    // fail fast with a clear message if any required env var is missing —
    // this is the #1 cause of the cryptic "Unexpected end of JSON input" crash
    // (Safaricom returns an empty body when the auth header is malformed)
    const required = ['MPESA_CONSUMER_KEY','MPESA_CONSUMER_SECRET','MPESA_SHORTCODE','MPESA_PASSKEY','PUBLIC_BASE_URL'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) {
      console.error('Missing environment variables:', missing.join(', '));
      return res.status(500).json({ error: 'Server is missing M-Pesa config: ' + missing.join(', ') + ' — set these in Vercel → Settings → Environment Variables, then redeploy.' });
    }

    // normalize the phone number to 2547XXXXXXXX
    let phoneDigits = String(phone).replace(/\D/g, '');
    if (phoneDigits.startsWith('0')) phoneDigits = '254' + phoneDigits.slice(1);
    else if (phoneDigits.startsWith('7') || phoneDigits.startsWith('1')) phoneDigits = '254' + phoneDigits;
    if (!/^254(7|1)\d{8}$/.test(phoneDigits)) {
      return res.status(400).json({ error: "That phone number doesn't look valid for M-Pesa" });
    }

    const baseUrl = process.env.MPESA_ENV === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    // get a Daraja OAuth token
    const authStr = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const tokenRes = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${authStr}` },
    });
    const tokenRawText = await tokenRes.text();
    let tokenData;
    try { tokenData = JSON.parse(tokenRawText); }
    catch (e) {
      console.error('Daraja auth returned non-JSON. Status:', tokenRes.status, 'Body:', tokenRawText);
      return res.status(502).json({ error: `M-Pesa auth failed (HTTP ${tokenRes.status}): ${tokenRawText || 'empty response — check MPESA_CONSUMER_KEY/SECRET are correct'}` });
    }
    if (!tokenData.access_token) {
      console.error('Daraja auth failed:', tokenData);
      return res.status(502).json({ error: tokenData.error_description || tokenData.errorMessage || 'Could not authenticate with M-Pesa — check your Daraja credentials' });
    }

    // build and send the STK push request
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenData.access_token}` },
      body: JSON.stringify({
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.max(1, Math.round(amount)),
        PartyA: phoneDigits,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: phoneDigits,
        CallBackURL: `${process.env.PUBLIC_BASE_URL}/api/mpesa?action=callback`,
        AccountReference: idnum,
        TransactionDesc: 'Lounge payment',
      }),
    });
    const stkRawText = await stkRes.text();
    let stkData;
    try { stkData = JSON.parse(stkRawText); }
    catch (e) {
      console.error('STK push returned non-JSON. Status:', stkRes.status, 'Body:', stkRawText);
      return res.status(502).json({ error: `M-Pesa STK push failed (HTTP ${stkRes.status}): ${stkRawText || 'empty response'}` });
    }

    if (stkData.ResponseCode !== '0') {
      console.error('STK push rejected:', stkData);
      return res.status(502).json({ error: stkData.errorMessage || stkData.ResponseDescription || 'M-Pesa declined the request' });
    }

    // save a pending transaction row so the callback can find it later
    const insertRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mpesa_transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        owner_id: ownerId,
        session_id: sessionId || null,
        idnum,
        phone: phoneDigits,
        amount,
        checkout_request_id: stkData.CheckoutRequestID,
        merchant_request_id: stkData.MerchantRequestID,
        status: 'pending',
      }),
    });
    if (!insertRes.ok) {
      console.error('Failed to save pending transaction:', await insertRes.text());
    }

    return res.status(200).json({ checkoutRequestId: stkData.CheckoutRequestID });
  } catch (err) {
    console.error('mpesa initiate error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

// ── Safaricom's payment confirmation — called by Safaricom, not the browser ───
async function handleCallback(req, res) {
  // Safaricom just needs a fast 200 — always ack, even on our own errors,
  // so it doesn't endlessly retry a callback we've already given up on.
  const ack = () => res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) return ack();

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    const txRows = await sbFetch(`/mpesa_transactions?checkout_request_id=eq.${checkoutRequestId}&select=*`);
    const tx = txRows && txRows[0];
    if (!tx) return ack();

    if (resultCode !== 0) {
      // customer cancelled, entered wrong PIN, or it timed out
      await sbFetch(`/mpesa_transactions?id=eq.${tx.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed' }),
      });
      return ack();
    }

    // success — pull the confirmed amount + receipt from Safaricom's own data
    const items = stkCallback.CallbackMetadata?.Item || [];
    const get = (name) => items.find((i) => i.Name === name)?.Value;
    const amountPaid = Number(get('Amount')) || Number(tx.amount);
    const receipt = get('MpesaReceiptNumber') || '';

    await sbFetch(`/mpesa_transactions?id=eq.${tx.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'success', mpesa_receipt: receipt, amount: amountPaid }),
    });

    if (!tx.session_id) {
      // this was a "Settle up" payment against an existing debt, not a sign-out
      const debtRows = await sbFetch(`/debts?owner_id=eq.${tx.owner_id}&idnum=eq.${tx.idnum}&select=*`);
      const owed = (debtRows && debtRows[0]?.amount) || 0;
      const newDebt = Math.round((owed - amountPaid) * 100) / 100;
      if (Math.abs(newDebt) < 0.01) {
        await sbFetch(`/debts?owner_id=eq.${tx.owner_id}&idnum=eq.${tx.idnum}`, { method: 'DELETE' });
      } else {
        await sbFetch(`/debts`, {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({ owner_id: tx.owner_id, idnum: tx.idnum, amount: newDebt, updated_at: new Date().toISOString() }),
        });
      }
      return ack();
    }

    const sessRows = await sbFetch(`/sessions?id=eq.${tx.session_id}&select=*`);
    const session = sessRows && sessRows[0];
    if (!session || session.signed_out) return ack(); // already handled, or session vanished

    const [profRows, debtRows] = await Promise.all([
      sbFetch(`/profiles?id=eq.${tx.owner_id}&select=*`),
      sbFetch(`/debts?owner_id=eq.${tx.owner_id}&idnum=eq.${tx.idnum}&select=*`),
    ]);
    const profile = (profRows && profRows[0]) || {};
    const prevDebt = (debtRows && debtRows[0]?.amount) || 0;

    const signOutTime = new Date();
    const elapsed = signOutTime - new Date(session.start_time);
    const cost = calcPrice(elapsed, profile) || 0;
    const totalDue = Math.round((cost + prevDebt) * 100) / 100;
    const newDebt = Math.round((totalDue - amountPaid) * 100) / 100;

    await sbFetch(`/sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        signed_out: true,
        sign_out_time: signOutTime.toISOString(),
        amount_paid: amountPaid,
        debt_after: newDebt,
        debt_before: prevDebt,
      }),
    });

    if (Math.abs(newDebt) < 0.01) {
      await sbFetch(`/debts?owner_id=eq.${tx.owner_id}&idnum=eq.${tx.idnum}`, { method: 'DELETE' });
    } else {
      await sbFetch(`/debts`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ owner_id: tx.owner_id, idnum: tx.idnum, amount: newDebt, updated_at: new Date().toISOString() }),
      });
    }

    return ack();
  } catch (err) {
    console.error('mpesa callback error:', err);
    return ack();
  }
}

// ── router ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.query.action === 'callback') return handleCallback(req, res);
  return handleInitiate(req, res);
}
