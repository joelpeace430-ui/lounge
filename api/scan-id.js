// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — ID card reading backend (Fixed for Maisha Cards & Groq Vision)
// ═══════════════════════════════════════════════════════════════════════════
// This file exists so the browser never sees which AI vendor/model reads the
// ID cards, what the prompt is, or any API key.
//
// Required environment variable (Vercel → Project → Settings → Environment Variables):
//   GROQ_API_KEY       — your Groq key, from ://groq.com
//   SUPABASE_URL        — same URL used in the frontend
//   SUPABASE_ANON_KEY   — same anon key used in the frontend
// ═══════════════════════════════════════════════════════════════════════════

const PROMPT = 'This is a Kenyan national ID card or Maisha Card. Read the full name and the ID number (or Maisha Namba) exactly as printed. If you are not sure of a character, write UNKNOWN for that field instead of guessing.\n\nReply ONLY in this exact format:\nNAME: <name or UNKNOWN>\nID: <digits or UNKNOWN>';

async function readOnce(b64) {
  const res = await fetch('https://groq.com', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY 
    },
    body: JSON.stringify({
      // Using Groq's stable production-grade vision model instead of qwen preview 
      model: 'llama-3.2-11b-vision-preview',
      max_tokens: 60,
      temperature: 0,
      messages: [{ 
        role: 'user', 
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
          { type: 'text', text: PROMPT },
        ] 
      }],
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
  // FIX: Changed from \d{8} to \d{7,9} to support standard 8-digit IDs and 9-digit Maisha Cards [1]
  const id = txt.match(/ID:\s*(\d{7,9})/i); 

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

    // Verify user session against Supabase backend
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 
        Authorization: `Bearer ${accessToken}`, 
        apikey: process.env.SUPABASE_ANON_KEY 
      },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session — please log in again' });

    // Multi-frame majority-vote processing
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
