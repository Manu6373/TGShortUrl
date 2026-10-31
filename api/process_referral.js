export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { referrer_id, new_user } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;

    // Security check for Bot Token
    if (!BOT_TOKEN) {
        return res.status(500).json({ error: 'BOT_TOKEN missing on server.' });
    }

    if (!referrer_id) {
        return res.status(400).json({ error: 'referrer_id is required.' });
    }

    try {
        const firstName = new_user?.first_name || 'A new user';
        
        // Formatted message for the referrer
        const messageText = `🎉 <b>New Referral Joined!</b>\n\n👤 <b>${firstName}</b> successfully registered on TGShortUrl using your link.\n\nYou will earn a lifetime commission from their earnings!`;
        
        // Send message via Telegram Bot API
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: referrer_id,
                text: messageText,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ 
                        text: "👥 View Referrals", 
                        url: "https://t.me/TGShortUrlBot/tgshorturlvercel" 
                    }]]
                }
            })
        });

        const data = await response.json();
        
        if (!response.ok || !data.ok) {
            console.error("Telegram API Error:", data);
            return res.status(500).json({ error: 'Failed to send Telegram message' });
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("Referral process error:", error);
        return res.status(500).json({ error: error.message });
    }
}
