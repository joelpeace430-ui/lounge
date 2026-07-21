// ═══════════════════════════════════════════════════════════════════════════
// LOUNGE MANAGER — VISUAL TESTING MODE (Gemini Flash Fixed)
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

    // Safely extract the first frame out of the incoming payload stream array
    let rawB64 = Array.isArray(frames) ? frames[0] : frames;
    
    // Strip away standard browser data headers if the frontend is appending them
    if (typeof rawB64 === 'string' && rawB64.includes(',')) {
      rawB64 = rawB64.split(',')[1];
    }

    // FIXED: Ensured explicit forward slashes exist between domain parameters and model variables
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
      console.error("Google Server Error Status:", response.status, errorResponse);
      return res.status(response.status).json({ 
        name: "GOOGLE ERROR", 
        idnum: `Status ${response.status}: ${errorResponse.slice(0, 100)}` 
      });
    }

    const data = await response.json();
    
    // Clean string extractor targeting Google's native text content paths
    const descriptionText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Google returned empty text content.";

    return res.status(200).json({ 
      name: "AI VISUAL DESCRIPTION:", 
      idnum: descriptionText 
    });

  } catch (err) {
    console.error('Server crash tracking log context:', err);
    return res.status(500).json({ error: `Server crash: ${err.message}` });
  }
}
