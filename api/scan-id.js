// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC VERSION — Exactly what text does the AI see?
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'qwen/qwen3.6-27b';

const PROMPT = `Look closely at this image. Answer these three questions clearly:
1. What type of document is this?
2. What is the full name printed on it?
3. What is the main identification number printed on it?`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames } = req.body || {};
    if (!Array.isArray(frames) || !frames.length) {
      return res.status(400).json({ error: 'No image data received' });
    }

    const firstFrame = frames[0]; // Take the very first captured snapshot safely

    const response = await fetch('https://groq.com', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY 
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + firstFrame } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API configuration error status:", response.status, errorText);
      return res.status(response.status).json({ error: `Groq error: ${response.status}` });
    }

    const data = await response.json();
    
    // VERIFIED SYNTAX: Perfect native array destructuring chain mapping
    const aiVisionOutput = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : 'NO CONTENT';

    // Send the raw conversational text directly to your frontend screen safely
    return res.status(200).json({ 
      name: "DIAGNOSTIC MODE", 
      idnum: aiVisionOutput 
    });

  } catch (err) {
    console.error("Internal Server Crash Stack:", err);
    return res.status(500).json({ error: err.message });
  }
}
