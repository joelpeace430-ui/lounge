// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — ID card reading backend (Vercel Serverless Function)
// ═══════════════════════════════════════════════════════════════════════════
// This file executes securely server-side to hide vendor parameters, prompts,
// and private API keys from the browser network inspector window.
// ═══════════════════════════════════════════════════════════════════════════

// Using the recommended vision-capable model currently supported in Groq's ecosystem
const MODEL = 'qwen/qwen3.6-27b';

// Force the model to output a strict JSON structure matching your schema expectations
const PROMPT = `You are a precise automated identity data parser.
Analyze this image of a national ID card. Extract only the full name and the main national ID number.
The main national ID number is typically a sequence of 8 digits. Ignore serial numbers, document numbers, or dates.
You must output your findings strictly as a valid JSON object matching this exact structure:
{
  "name": "EXTRACTED_FULL_NAME",
  "idnum": "EXTRACTED_8_DIGIT_NUMBER"
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a single base64 image frame to Groq with native JSON enforcement.
 * Includes automated retry handling on 429 rate limit errors.
 */
async function readOnce(b64, attempt = 0) {
  const res = await fetch('https://groq.com', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY 
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 0 forces deterministic, factual extraction
      response_format: { type: "json_object" }, // Ensures model cannot respond with conversational text
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error(`Vendor API error (status ${res.status}, image ~${Math.ceil(b64.length*0.75/1024)}KB):`, t);

    // Auto-retry on rate limitations (429) using Groq's exact wait hint
    if (res.status === 429 && attempt  r.idnum);
    const idCounts = {};
    ids.forEach(id => { if (id !== 'UNKNOWN') idCounts[id] = (idCounts[id] || 0) + 1; });
    const majorityId = Object.entries(idCounts).find(([, c]) => c >= 2)?.[0] || 'UNKNOWN';

    // Majority vote consolidation layer for the User Full Name
    const names = results.map(r => r.name).filter(n => n !== 'UNKNOWN');
    const nameCounts = {};
    names.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const majorityName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';

    return res.status(200).json({ name: majorityName, idnum: majorityId });
  } catch (err) {
    console.error('scan-id route level error execution context:', err);
    return res.status(500).json({ error: 'Could not read card — try again' });
  }
}
