import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { short_id } = req.body;

    if (!short_id) {
        return res.status(400).json({ error: 'short_id is required' });
    }

    // 1. Extract the user's IP Address (Vercel forwards this automatically)
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';

    // 2. Initialize Supabase securely with SERVICE ROLE KEY
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Backend configuration missing (ENV variables).' });
    }

    // URL Cleanup safeguard
    const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
    const supabase = createClient(cleanUrl, supabaseKey.trim());

    try {
        // 3. Fetch Link Data
        const { data: linkData, error: linkErr } = await supabase.from('links').select('*').eq('short_id', short_id).single();
        if (linkErr || !linkData) {
            return res.status(404).json({ error: 'Link not found' });
        }

        // 4. Fetch Admin Settings
        const { data: adminSettings } = await supabase.from('settings').select('*').limit(1).single();
        const cpm = adminSettings?.cpm || 2.0;
        const restrictHours = adminSettings?.ip_restrict_hours || 24;
        let earn_amount = cpm / 1000;
        
        let grantReward = true;
        let ipMessage = 'Reward added successfully';

        // 5. 🛡️ Check IP Restriction (1 Reward per IP per X Hours)
        if (clientIp !== 'unknown') {
            const { data: ipLog } = await supabase.from('ip_logs').select('*').eq('ip_address', clientIp).single();
            
            if (ipLog) {
                const lastRewardedDate = new Date(ipLog.last_rewarded_at);
                const hoursSince = Math.abs(new Date() - lastRewardedDate) / (1000 * 60 * 60);
                
                if (hoursSince < restrictHours) {
                    grantReward = false;
                    earn_amount = 0; // Prevent earning logic, IP has already claimed within 24hrs
                    ipMessage = `IP restricted. Earning limit reached for this network within ${restrictHours} hours.`;
                } else {
                    // Reset the 24-hour timer to right now
                    await supabase.from('ip_logs').update({ last_rewarded_at: new Date().toISOString() }).eq('ip_address', clientIp);
                }
            } else {
                // First time this IP is earning, log it
                await supabase.from('ip_logs').insert([{ ip_address: clientIp, last_rewarded_at: new Date().toISOString() }]);
            }
        }

        // 6. Update LINK stats (We still count the click/view, even if earnings are 0)
        await supabase.from('links').update({
            clicks: (linkData.clicks || 0) + 1,
            earnings: (linkData.earnings || 0) + earn_amount
        }).eq('id', linkData.id);

        // 7. Update User Balances (Only if IP is clean/granted)
        if (grantReward) {
            const { data: userData } = await supabase.from('users').select('*').eq('id', linkData.user_id).single();
            
            if (userData) {
                await supabase.from('users').update({
                    balance: (userData.balance || 0) + earn_amount,
                    today_earnings: (userData.today_earnings || 0) + earn_amount,
                    total_earnings: (userData.total_earnings || 0) + earn_amount,
                    total_clicks: (userData.total_clicks || 0) + 1,
                    today_clicks: (userData.today_clicks || 0) + 1
                }).eq('id', userData.id);

                // 8. Apply Referral Commission Automatically
                const referPercent = adminSettings?.refer_percent || 10;
                if (referPercent > 0 && userData.telegram_id) {
                    const { data: referralData } = await supabase.from('referrals').select('referrer_tg_id').eq('referred_tg_id', userData.telegram_id).single();
                    
                    if (referralData && referralData.referrer_tg_id) {
                        const { data: referrerData } = await supabase.from('users').select('*').eq('telegram_id', referralData.referrer_tg_id).single();
                        
                        if (referrerData) {
                            const referComm = earn_amount * (referPercent / 100);
                            
                            await supabase.from('users').update({
                                balance: (referrerData.balance || 0) + referComm,
                                total_earnings: (referrerData.total_earnings || 0) + referComm
                            }).eq('id', referrerData.id);
                        }
                    }
                }
            }
        }

        // Return a successful response
        return res.status(200).json({ success: true, message: ipMessage, earned: grantReward });

    } catch (error) {
        console.error('Reward API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
