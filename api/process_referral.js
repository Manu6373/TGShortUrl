export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { referrer_id, new_user } = req.body;
    const BOT_TOKEN = process.env.BOT_TOKEN;

    if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN missing' });

    try {
        const messageText = `🎉 <b>New Referral Joined!</b>\n\n👤 <b>${new_user.first_name || 'User'}</b> successfully registered using your link.\n\nYou will earn lifetime commission from their earnings!`;
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: referrer_id,
                text: messageText,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: "👥 View Referrals", url: "https://t.me/TGShortUrlBot" }]]
                }
            })
        });

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
