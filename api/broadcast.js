export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { chat_ids, image_url, caption, use_button, mini_app_url } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN; 

    // Security check for Bot Token
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
    const finalUrl = mini_app_url || "https://tgshorturl.vercel.app/";
    
    // If the link is a t.me link, use normal 'url', otherwise open as an inside-Telegram 'web_app'
    if (finalUrl.includes('t.me')) {
        buttonConfig = { url: finalUrl };
    } else {
        buttonConfig = { web_app: { url: finalUrl } };
    }

    // Default to showing the button unless explicitly disabled
    const showButton = use_button !== false; 
    const reply_markup = showButton ? {
        inline_keyboard: [[{ 
            text: "👉 Open TGShortUrl 👈", 
            ...buttonConfig 
        }]]
    } : undefined;
    // -------------------------

    // Determine if sending a text message or a photo message
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

            // Telegram API limits bots to ~30 messages per second. 
            // 35ms delay = approx 28 messages per second to keep you safe from bans.
            await new Promise(resolve => setTimeout(resolve, 35));

        } catch (error) {
            failed++;
        }
    }

    return res.status(200).json({ sent, failed });
}
