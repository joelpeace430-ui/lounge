// ═══════════════════════════════════════════════════════════════════════════
// DEBUG BACKEND — Exposes Groq Output Directly
// ═══════════════════════════════════════════════════════════════════════════

const PROMPT = 'This is a Kenyan national ID card or Maisha Card. Read the full name and the ID number (or Maisha Namba) exactly as printed. If you are not sure of a character, write UNKNOWN for that field instead of guessing.\n\nReply ONLY in this exact format:\nNAME: <name or UNKNOWN>\nID: <digits or UNKNOWN>';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames } = req.body || {};
    if (!Array.isArray(frames) || !frames.length) return res.status(400).json({ error: 'No image data received' });

    // Send the very first frame to Groq
    const groqRes = await fetch('https://groq.com', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY 
      },
      body: JSON.stringify({
        model: 'llama-3.2-11b-vision-preview',
        max_tokens: 150, // Slightly expanded to catch filler conversational text
        temperature: 0,
        messages: [{ 
          role: 'user', 
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + frames[0] } },
            { type: 'text', text: PROMPT },
          ] 
        }],
      }),
    });

    const data = await groqRes.json();
    const rawTxt = data.choices?.[0]?.message?.content || 'EMPTY_RESPONSE';

    // TEST 1: Check if regex finds anything
    const nm = rawTxt.match(/NAME:\s*(.+)/i);
    const id = rawTxt.match(/ID:\s*(\d{7,9})/i);

    // Force the server to return a 200 payload containing the diagnostic autopsy data
    return res.status(200).json({ 
      debug: true,
      rawGroqText: rawTxt, 
      regexParsedName: nm ? nm[1] : "REGEX_FAILED",
      regexParsedId: id ? id[1] : "REGEX_FAILED"
    });

  } catch (err) {
    return res.status(500).json({ error: 'System Exception', trace: err.message });
  }
}
