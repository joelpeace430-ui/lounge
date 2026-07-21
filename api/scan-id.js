// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — VISUAL TESTING MODE (Gemini Flash)
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'gemini-2.5-flash';

const PROMPT = "Describe exactly what you see in this image. If it is an ID card, list out every name, word, and number you can read on it.";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames } = req.body || {};
    
    if (!frames || !frames.length) {
      return res.status(400).json({ error: 'Backend error: No images received from camera' });
    }

    let rawB64 = Array.isArray(frames) ? frames[0] : frames;
    if (rawB64.includes(',')) {
      rawB64 = rawB64.split(',')[1];
    }

    // FIXED: Formatted using an absolute string configuration to prevent variable parsing glitches
    const url = "https://googleapis.com" + MODEL + ":generateContent?key=" + process.env.GEMINI_API_KEY;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: rawB64 } },
            { text: PROMPT }
          ]
        }]
      }),
    });

    if (!response.ok) {
      const errorResponse = await response.text();
      console.error("Google Server Error:", errorResponse);
      return res.status(response.status).json({ 
        name: "GOOGLE ERROR", 
        idnum: `Status ${response.status}: ${errorResponse.slice(0, 100)}` 
      });
    }

    const data = await response.json();
    
    // Extracted target data from standard response template mapping arrays
    const descriptionText = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] ? data.candidates[0].content.parts[0].text : "Google returned empty text content.";

    return res.status(200).json({ 
      name: "AI VISUAL DESCRIPTION:", 
      idnum: descriptionText 
    });

  } catch (err) {
    console.error('Server crash tracking log:', err);
    return res.status(500).json({ error: `Server crash: ${err.message}` });
  }
}
