import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'crypto';

function verifyTelegramInitData(initData, botToken) {
  if (typeof initData !== 'string' || !initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !Number.isFinite(authDate)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 86400) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    const a = Buffer.from(calculatedHash, 'hex');
    const b = Buffer.from(receivedHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch { return null; }

  try {
    const user = JSON.parse(params.get('user') || '{}');
    if (!user.id) return null;
    return { id: String(user.id) };
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!supabaseUrl || !serviceKey || !botToken) {
    return res.status(500).json({ error: 'Backend configuration missing.' });
  }

  const telegramUser = verifyTelegramInitData(req.body?.init_data, botToken);
  if (!telegramUser) return res.status(401).json({ error: 'Telegram session invalid.' });

  const db = createClient(supabaseUrl.trim().replace(/\/$/, ''), serviceKey.trim(), {
    auth: { persistSession: false }
  });

  try {
    // Only return profile names belonging to referrals of the verified Telegram user.
    const { data: referrals, error: referralError } = await db
      .from('referrals')
      .select('referred_tg_id,created_at')
      .eq('referrer_tg_id', telegramUser.id)
      .order('created_at', { ascending: false });
    if (referralError) throw referralError;

    const ids = [...new Set((referrals || []).map(r => String(r.referred_tg_id)))];
    let users = [];
    if (ids.length) {
      const { data, error } = await db
        .from('users')
        .select('telegram_id,first_name,username')
        .in('telegram_id', ids);
      if (error) throw error;
      users = data || [];
    }

    return res.status(200).json({
      success: true,
      referrals: (referrals || []).map(r => {
        const user = users.find(u => String(u.telegram_id) === String(r.referred_tg_id)) || {};
        return {
          referred_tg_id: String(r.referred_tg_id),
          created_at: r.created_at,
          first_name: user.first_name || null,
          username: user.username || null
        };
      })
    });
  } catch (error) {
    console.error('Referral names API error:', error);
    return res.status(500).json({ error: 'Could not load referral names.' });
  }
}
