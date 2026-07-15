

const PROMPT = 'This is a Kenyan national ID card photo.\n\nYour job is to READ and COPY text exactly as printed — do NOT guess, infer, or autocorrect anything.\n\nIMPORTANT — there are TWO different numbers on this card and they are easy to mix up:\n1. A short document/serial number — often near the top of the card, sometimes right next to or above the photo. This is NOT what we want.\n2. The actual ID NUMBER — labelled "ID NUMBER" or "NAMBARI YA KITAMBULISHO" (Swahili). This is what we want.\n\nThese two numbers can appear on the SAME row near the top of the card, one on the left and one on the right — do not assume the ID number is whichever one you see first or whichever is more prominent. Find the literal label text "ID NUMBER" / "NAMBARI YA KITAMBULISHO" printed on the card, then read ONLY the digits printed immediately next to or below that specific label. Ignore any other number on the card, no matter where it is positioned.\n\nExtract:\n1. Full name: printed in bold capitals, labelled JINA/NAME. Copy every letter exactly as you see it.\n2. National ID number: exactly 8 digits, found next to the "ID NUMBER"/"NAMBARI YA KITAMBULISHO" label specifically — never the serial/document number.\n\nRules:\n- If you are not 100% certain of a character, write UNKNOWN for that field\n- Never guess or fill in missing characters\n- The ID number must be exactly 8 digits — if what is next to the ID NUMBER label is not 8 digits, write UNKNOWN\n- If you cannot clearly identify which number is labelled as the ID number, write UNKNOWN rather than picking the closest-looking number\n\nReply ONLY in this exact format:\nNAME: <name or UNKNOWN>\nID: <8 digits or UNKNOWN>';

async function readOnce(b64) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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
