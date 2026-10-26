export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { chat_ids, image_url, caption, use_button, mini_app_url } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN; 

    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'BOT_TOKEN is missing on server.' });
    }

    if (!chat_ids || !Array.isArray(chat_ids)) {
        return res.status(400).json({ error: 'Invalid chat_ids array.' });
    }

    let sent = 0;
    let failed = 0;

    // --- SMART BUTTON LOGIC ---
    let buttonConfig = {};
    // Updated fallback URL to your live Vercel domain
    const finalUrl = mini_app_url || "https://my-app.vercel.app";
    
    // Agar t.me link hai toh normal 'url' button banayega, warna 'web_app' button banayega
    if (finalUrl.includes('t.me')) {
        buttonConfig = { url: finalUrl };
    } else {
        buttonConfig = { web_app: { url: finalUrl } };
    }

    const reply_markup = use_button ? {
        inline_keyboard: [[{ 
            text: "👉 Open now 👈", 
            ...buttonConfig 
        }]]
    } : undefined;
    // -------------------------

    const endpoint = image_url ? 'sendPhoto' : 'sendMessage';

    for (const chat_id of chat_ids) {
        try {
            const payload = {
                chat_id: chat_id,
                parse_mode: 'HTML',
                reply_markup: reply_markup
            };

            if (image_url) {
                payload.photo = image_url;
                payload.caption = caption || '';
            } else {
                payload.text = caption || '';
            }

            const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (data.ok) {
                sent++;
            } else {
                failed++;
                console.error(`Error for ${chat_id}:`, data.description);
            }

            // Rate limit bachane ke liye delay
            await new Promise(resolve => setTimeout(resolve, 35));

        } catch (error) {
            failed++;
        }
    }

    res.status(200).json({ sent, failed });
              }
