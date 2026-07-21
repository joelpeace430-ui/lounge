// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC VERSION — What does the AI see?
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'qwen/qwen3.6-27b';

// We ask the AI plain questions to see exactly what its vision processor detects
const PROMPT = `Look closely at this image. Answer these three questions clearly:
1. What type of document is this?
2. What is the full name printed on it?
3. What is the main identification number printed on it?`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { frames } = req.body || {};
    const firstFrame = frames[0]; // Take the very first captured snapshot image

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

    const data = await response.json();
    const aiVisionOutput = data.choices[0].message.content;

    // Send the raw conversational text directly to your frontend screen
    return res.status(200).json({ 
      name: "DIAGNOSTIC MODE", 
      idnum: aiVisionOutput 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
