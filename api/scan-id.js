// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — ID card reading backend
// ═══════════════════════════════════════════════════════════════════════════
// This file exists so the browser never sees which AI vendor/model reads the
// ID cards, what the prompt is, or any API key. Previously the frontend
// called the vendor's API directly with a per-owner key pasted into Settings
// — anyone could open dev tools → Network tab and see exactly which service
// and model was being used. Now the browser only ever talks to YOUR domain
// (/api/scan-id), and this file does the actual vendor call server-side.
//
// One shared key for the whole app (not per-owner) — set as a Vercel env var,
// never exposed to any browser.
//
// Deploy alongside:
//   /index.html
//   /api/mpesa.js
//   /api/scan-id.js   (this file)
//   /package.json
//
// Required environment variable (Vercel → Project → Settings → Environment Variables):
//   GROQ_API_KEY       — your Groq key, from console.groq.com/keys
//   SUPABASE_URL        — same URL used in the frontend
//   SUPABASE_ANON_KEY   — same anon key used in the frontend
// ═══════════════════════════════════════════════════════════════════════════

// meta-llama/llama-4-scout-17b-16e-instruct and meta-llama/llama-4-maverick-17b-128e-instruct
// were both deprecated by Groq (June 17, 2026 and Feb 20, 2026 respectively). Groq's official
// migration target for both is openai/gpt-oss-120b — but that model is TEXT-ONLY, no image
// input. qwen/qwen3.6-27b is currently the only vision-capable model in Groq's lineup.
// It's served as a preview model, so it could move again — if reading ever breaks the same
// way, check console.groq.com/docs/vision for the current vision-capable model before
// assuming it's the same bug.
const MODEL = 'qwen/qwen3.6-27b';

// Explicit two-line format so the regexes below can reliably parse the response.
const PROMPT = 'Extract only the  ID name   and ID number';

async function readOnce(b64) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 60,
      temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`Vendor API error (status ${res.status}, image ~${Math.ceil(b64.length*0.75/1024)}KB):`, t);
    throw new Error('read failed');
  }
  const data = await res.json();
  const txt = data.choices?.[0]?.message?.content || '';
  const nm = txt.match(/NAME:\s*(.+)/i);
  const id = txt.match(/ID:\s*(\d{8})/i); // must be exactly 8 digits
  return {
    name: nm ? nm[1].trim() : 'UNKNOWN',
    idnum: id ? id[1].trim() : 'UNKNOWN',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames, accessToken } = req.body || {};
    if (!accessToken) return res.status(401).json({ error: 'Please log in again' });
    if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'No image data received' });
    if (!process.env.GROQ_API_KEY) {
      console.error('Missing environment variable: GROQ_API_KEY');
      return res.status(500).json({ error: 'ID reading is not configured on the server yet' });
    }

    // verify the caller is actually a logged-in owner — this is a shared key
    // now, so an unauthenticated request should never be able to spend it
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session — please log in again' });

    // same 3-frame majority-vote logic that used to live in the browser —
    // moved here too, so the strategy itself isn't visible in page source either
    const results = await Promise.all(frames.slice(0, 3).map(b64 => readOnce(b64)));

    const ids = results.map(r => r.idnum);
    const idCounts = {};
    ids.forEach(id => { if (id !== 'UNKNOWN') idCounts[id] = (idCounts[id] || 0) + 1; });
    const majorityId = Object.entries(idCounts).find(([, c]) => c >= 2)?.[0] || 'UNKNOWN';

    const names = results.map(r => r.name).filter(n => n !== 'UNKNOWN');
    const nameCounts = {};
    names.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const majorityName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';

    return res.status(200).json({ name: majorityName, idnum: majorityId });
  } catch (err) {
    console.error('scan-id error:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
