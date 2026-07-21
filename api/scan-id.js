// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — ID card reading backend (Vercel Serverless Function)
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'qwen/qwen3.6-27b';

// We ask the AI to return an array of all text snippets found on the card.
// This strips away label constraints completely.
const PROMPT = `You are a raw data extractor. Scan the provided identity document.
Extract every individual piece of text, name, and number string you see printed on the card.
You must output your findings strictly as a valid JSON array of strings matching this exact structure:
[
  "TEXT_STRING_1",
  "TEXT_STRING_2",
  "TEXT_STRING_3"
]`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readOnce(b64, attempt = 0) {
  const res = await fetch('https://groq.com', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY 
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" }, 
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error(`Vendor API error (status ${res.status}):`, t);

    if (res.status === 429 && attempt < 2) {
      const match = t.match(/try again in ([\d.]+)s/i);
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 250 : 3000 * (attempt + 1);
      await sleep(waitMs);
      return readOnce(b64, attempt + 1);
    }
    throw new Error('read failed');
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || '';

  let finalName = 'UNKNOWN';
  let finalId = 'UNKNOWN';

  try {
    // Parse the raw JSON payload (which could be an object or an array depending on AI interpretation)
    const parsedData = JSON.parse(rawContent);
    let textArray = [];

    if (Array.isArray(parsedData)) {
      textArray = parsedData;
    } else if (typeof parsedData === 'object' && parsedData !== null) {
      // Fallback: If the AI still returned an object, grab all its values
      textArray = Object.values(parsedData);
    }

    // Loop through the strings extracted by the AI to classify them using regular expressions
    for (let str of textArray) {
      if (!str || typeof str !== 'string') continue;
      let cleanStr = str.trim();

      // 1. Look for the ID Number: A string containing a block of 7 to 9 consecutive digits
      const idMatch = cleanStr.replace(/\s/g, '').match(/\b\d{7,9}\b/);
      if (idMatch && finalId === 'UNKNOWN') {
        finalId = idMatch[0];
        continue;
      }

      // 2. Look for the Name: Discard strings containing known labels or short codes
      const upperStr = cleanStr.toUpperCase();
      if (
        upperStr.includes('KENYA') || 
        upperStr.includes('IDENTITY') || 
        upperStr.includes('CARD') ||
        upperStr.includes('MALE') ||
        upperStr.includes('FEMALE') ||
        upperStr.includes('REPUBLIC') ||
        cleanStr.length < 3 ||
        /\d/.test(cleanStr) // Names shouldn't contain digits
      ) {
        continue;
      }

      // First clean string that isn't a country name or code label is highly likely the user's name
      if (finalName === 'UNKNOWN') {
        finalName = cleanStr.replace(/[*#]/g, '');
      }
    }

  } catch (parseError) {
    console.error("Advanced extraction parsing step fallback:", parseError);
  }

  return { name: finalName, idnum: finalId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames, accessToken } = req.body || {};
    if (!accessToken) return res.status(401).json({ error: 'Please log in again' });
    if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'No image data received' });
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'ID reading is not configured on the server yet' });
    }

    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session — please log in again' });

    const results = [];
    for (const b64 of frames.slice(0, 3)) {
      try {
        const singleScan = await readOnce(b64);
        results.push(singleScan);
      } catch (scanErr) {
        results.push({ name: 'UNKNOWN', idnum: 'UNKNOWN' });
      }
      await sleep(350); 
    }

    // Consolidated voting logic layer
    const ids = results.map(r => r.idnum).filter(id => id !== 'UNKNOWN');
    const idCounts = {};
    ids.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
    const majorityIdEntry = Object.entries(idCounts).find(([, c]) => c >= 2);
    const majorityId = majorityIdEntry ? majorityIdEntry[0] : (ids[0] || 'UNKNOWN');

    const names = results.map(r => r.name).filter(n => n !== 'UNKNOWN');
    const nameCounts = {};
    names.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const sortedNames = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]);
    const majorityName = sortedNames.length > 0 ? sortedNames[0][0] : (names[0] || 'UNKNOWN');

    return res.status(200).json({ name: majorityName, idnum: majorityId });
  } catch (err) {
    console.error('scan-id fallback handler level error:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
