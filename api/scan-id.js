// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — Gemini Flash ID Reading Backend (Vercel)
// ═══════════════════════════════════════════════════════════════════════════
// INSTRUCTIONS: Go to Vercel -> Project Settings -> Environment Variables
// and make sure you add: GEMINI_API_KEY (Get a free key from ://google.com)
// ═══════════════════════════════════════════════════════════════════════════

// Using the recommended fast vision model for structured JSON data extraction
const MODEL = 'gemini-2.5-flash';

const PROMPT = `You are a high-accuracy document parsing system.
Analyze this image of a Kenyan national identity card. 
Extract the person's full name and the main national ID number.
The main identity number is typically 8 or 9 digits long. Ignore serial numbers or dates.
You must return your findings strictly matching this schema:
{
  "name": "THE_FULL_NAME_HERE",
  "idnum": "THE_ID_NUMBER_HERE"
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readOnce(b64) {
  // Use Google's standard beta API endpoint to pass structured requests from Vercel
  const url = `https://googleapis.com{MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: b64 } },
        { text: PROMPT }
      ]
    }],
    generationConfig: {
      // Force Gemini to output a strict code format so it cannot append conversational text fluff
      responseMimeType: "application/json"
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`Gemini API error (status ${res.status}):`, errorText);
    throw new Error('Gemini call failed');
  }

  const data = await res.json();
  const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  try {
    const parsedJson = JSON.parse(rawContent.trim());
    
    // Clean up training symbols and asterisks
    let finalName = parsedJson.name ? parsedJson.name.replace(/[*#]/g, '').trim().toUpperCase() : 'UNKNOWN';
    let finalId = parsedJson.idnum ? parsedJson.idnum.toString().replace(/\D/g, '').trim() : 'UNKNOWN';

    // Validate that the ID length matches standard Kenyan document constraints (7 to 9 digits)
    if (finalId.length < 7 || finalId.length > 9) {
      finalId = 'UNKNOWN';
    }

    return { name: finalName, idnum: finalId };

  } catch (parseError) {
    console.error("Gemini output JSON parsing failed:", rawContent);
    return { name: 'UNKNOWN', idnum: 'UNKNOWN' };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames, accessToken } = req.body || {};
    if (!accessToken) return res.status(401).json({ error: 'Please log in again' });
    if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'No image data received' });
    
    if (!process.env.GEMINI_API_KEY) {
      console.error('Missing environment variable: GEMINI_API_KEY');
      return res.status(500).json({ error: 'Gemini API key is missing on the server' });
    }

    // Verify session token authenticity directly against your Supabase Auth layer
    const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: process.env.SUPABASE_ANON_KEY },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session — please log in again' });

    const results = [];
    // Process up to 3 frames sequentially to maintain majority voting logic integrity
    for (const b64 of frames.slice(0, 3)) {
      try {
        const singleScan = await readOnce(b64);
        results.push(singleScan);
      } catch (scanErr) {
        results.push({ name: 'UNKNOWN', idnum: 'UNKNOWN' });
      }
      await sleep(200); 
    }

    // Aggregate ID majority votes
    const ids = results.map(r => r.idnum).filter(id => id !== 'UNKNOWN');
    const idCounts = {};
    ids.forEach(id => { idCounts[id] = (idCounts[id] || 0) + 1; });
    const majorityIdEntry = Object.entries(idCounts).find(([, c]) => c >= 2);
    const majorityId = majorityIdEntry ? majorityIdEntry[0] : (ids[0] || 'UNKNOWN');

    // Aggregate Name majority votes
    const names = results.map(r => r.name).filter(n => n !== 'UNKNOWN');
    const nameCounts = {};
    names.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const sortedNames = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]);
    const majorityName = sortedNames.length > 0 ? sortedNames[0][0] : (names[0] || 'UNKNOWN');

    return res.status(200).json({ name: majorityName, idnum: majorityId });

  } catch (err) {
    console.error('scan-id handler level execution exception:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
