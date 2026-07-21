// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — ID card reading backend (Vercel Serverless Function)
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'qwen/qwen3.6-27b';

const PROMPT = `You are a precise automated identity data parser.
Analyze this image of a Kenyan national ID card. Extract only the full name and the main national ID number.
The national ID number is a sequence of 7 to 9 digits found on the card face. Ignore serial numbers or dates.
You must output your findings strictly as a valid JSON object matching this exact structure:
{
  "name": "EXTRACTED_FULL_NAME",
  "idnum": "EXTRACTED_ID_NUMBER"
}`;

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
      console.error(`Rate limited — retrying in ${waitMs}ms (attempt ${attempt + 1}/2)`);
      await sleep(waitMs);
      return readOnce(b64, attempt + 1);
    }
    throw new Error('read failed');
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || '';

  try {
    const parsedJson = JSON.parse(rawContent);
    
    let finalName = parsedJson.name ? parsedJson.name.replace(/[*#]/g, '').trim() : 'UNKNOWN';
    let finalId = parsedJson.idnum ? parsedJson.idnum.toString().replace(/\D/g, '').trim() : 'UNKNOWN';

    // UPDATED: Dynamically accept common Kenyan ID sizes (7 to 9 digits long)
    if (finalId.length < 7 || finalId.length > 9) {
      finalId = 'UNKNOWN';
    }

    return {
      name: finalName || 'UNKNOWN',
      idnum: finalId || 'UNKNOWN'
    };

  } catch (parseError) {
    console.error("JSON parsing step failed. Falling back to regex:", rawContent);
    
    const nm = rawContent.match(/["'*#]*name["'*#]*\s*:\s*["']*(.+?)["']/i);
    const id = rawContent.match(/["'*#]*idnum["'*#]*\s*:\s*["']*(\d{7,9})["']/i);

    return {
      name: nm ? nm[1].replace(/[*#]/g, '').trim() : 'UNKNOWN',
      idnum: id ? id[1].trim() : 'UNKNOWN',
    };
  }
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
        console.error("Single frame pass failed extraction:", scanErr);
        results.push({ name: 'UNKNOWN', idnum: 'UNKNOWN' });
      }
      await sleep(350); 
    }

    // FIXED: Cleaned up truncated syntactic expressions safely
    const ids = results.map(r => r.idnum);
    const idCounts = {};
    ids.forEach(id => { if (id !== 'UNKNOWN') idCounts[id] = (idCounts[id] || 0) + 1; });
    
    // Find the item with a majority vote, otherwise default cleanly
    const majorityIdEntry = Object.entries(idCounts).find(([, c]) => c >= 2);
    const majorityId = majorityIdEntry ? majorityIdEntry[0] : 'UNKNOWN';

    const names = results.map(r => r.name).filter(n => n !== 'UNKNOWN');
    const nameCounts = {};
    names.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    
    // Sort and safely read the zero index object array entry
    const sortedNames = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]);
    const majorityName = sortedNames.length > 0 ? sortedNames[0][0] : 'UNKNOWN';

    return res.status(200).json({ name: majorityName, idnum: majorityId });
  } catch (err) {
    console.error('scan-id route level error execution context:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
