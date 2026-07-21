// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — Label-Free Identity Reading Backend (Vercel)
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'qwen/qwen3.6-27b';

const PROMPT = `You are an absolute raw visual data extractor. Scan this identity card.
Find and read every text phrase, name, and block of numbers printed across the card face.
Return your extraction strictly as a valid JSON array of text strings. Do not use custom key labels.
Example Output Format:
[
  "LINE OF TEXT 1",
  "LINE OF TEXT 2",
  "LINE OF TEXT 3"
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
  
  // FIXED: Standard array retrieval notation without corrupted optional chain typos
  const rawContent = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';

  let extractedName = 'UNKNOWN';
  let extractedId = 'UNKNOWN';

  try {
    const parsedData = JSON.parse(rawContent);
    let rawLines = [];

    if (Array.isArray(parsedData)) {
      rawLines = parsedData;
    } else if (typeof parsedData === 'object' && parsedData !== null) {
      rawLines = Object.values(parsedData);
    }

    for (let rawLine of rawLines) {
      if (!rawLine || typeof rawLine !== 'string') continue;
      let cleanLine = rawLine.trim();

      // Isolate the ID number: Check for 7 to 9 digits (handles Maisha 9-digit layout seamlessly)
      const digitsOnly = cleanLine.replace(/\s/g, '');
      const serialMatch = digitsOnly.match(/\d{7,9}/);
      
      if (serialMatch && extractedId === 'UNKNOWN') {
        extractedId = serialMatch[0];
        continue; 
      }

      // Filter metadata blocks to capture user name strings
      const normalUpper = cleanLine.toUpperCase();
      if (
        normalUpper.includes('KENYA') || 
        normalUpper.includes('IDENTITY') || 
        normalUpper.includes('CARD') ||
        normalUpper.includes('REPUBLIC') ||
        normalUpper.includes('MALE') ||
        normalUpper.includes('FEMALE') ||
        normalUpper.includes('SEX') ||
        normalUpper.includes('DATE') ||
        normalUpper.includes('NATIONALITY') ||
        cleanLine.length < 3 ||
        /\d/.test(cleanLine)
      ) {
        continue; 
      }

      if (extractedName === 'UNKNOWN') {
        extractedName = cleanLine.replace(/[*#]/g, '').toUpperCase();
      }
    }

  } catch (parseError) {
    console.error("String normalization parser failure fallback:", parseError);
  }

  return { name: extractedName, idnum: extractedId };
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

    // Voting aggregation mapping filter array parameters
    const finalIdsList = results.map(r => r.idnum).filter(id => id !== 'UNKNOWN');
    const trackedIdCounts = {};
    finalIdsList.forEach(id => { trackedIdCounts[id] = (trackedIdCounts[id] || 0) + 1; });
    
    // FIXED: Correct explicit array indexing matching logic
    const matchIdEntry = Object.entries(trackedIdCounts).find(([, countValue]) => countValue >= 2);
    const majorityId = matchIdEntry ? matchIdEntry[0] : (finalIdsList[0] || 'UNKNOWN');

    const finalNamesList = results.map(r => r.name).filter(nameString => nameString !== 'UNKNOWN');
    const trackedNameCounts = {};
    finalNamesList.forEach(name => { trackedNameCounts[name] = (trackedNameCounts[name] || 0) + 1; });
    
    // FIXED: Clear syntax multi-dimensional sorting logic values
    const sortedNamesArray = Object.entries(trackedNameCounts).sort((a, b) => b[1] - a[1]);
    const majorityName = sortedNamesArray.length > 0 ? sortedNamesArray[0][0] : (finalNamesList[0] || 'UNKNOWN');

    return res.status(200).json({ name: majorityName, idnum: majorityId });
  } catch (err) {
    console.error('scan-id main handler execution level error context:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
