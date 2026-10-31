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
    return { id: String(user.id), authDate };
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!supabaseUrl || !serviceKey || !botToken) {
    return res.status(500).json({ error: 'Backend configuration missing. Set Supabase service role and Telegram bot token in Vercel.' });
  }

  const { short_id, init_data, ad_provider } = req.body || {};
  if (!short_id || !init_data) return res.status(400).json({ error: 'short_id and Telegram init_data are required.' });
  if (!['monetag', 'adsbitvex'].includes(ad_provider)) return res.status(400).json({ error: 'Invalid ad provider.' });

  const telegramUser = verifyTelegramInitData(init_data, botToken);
  if (!telegramUser) return res.status(401).json({ error: 'Telegram session could not be verified. Reopen the Mini App and try again.' });

  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = forwarded ? String(forwarded).split(',')[0].trim() : req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  const cleanUrl = supabaseUrl.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const db = createClient(cleanUrl, serviceKey.trim(), { auth: { persistSession: false } });

  try {
    const { data: link, error: linkError } = await db.from('links').select('*').eq('short_id', short_id).maybeSingle();
    if (linkError || !link) return res.status(404).json({ error: 'Link not found.' });

    const { data: owner, error: ownerError } = await db.from('users').select('id,telegram_id,balance,today_earnings,total_earnings,total_clicks,today_clicks').eq('id', link.user_id).maybeSingle();
    if (ownerError || !owner) return res.status(404).json({ error: 'Link owner not found.' });

    // A publisher cannot earn from their own link. Compare against signed Telegram identity.
    if (String(owner.telegram_id) === telegramUser.id) {
      return res.status(403).json({ error: 'Self-clicks are not eligible for rewards.' });
    }

    const now = new Date();
    const rewardDate = now.toISOString().slice(0, 10);
    // Prevent the same Telegram account from earning repeatedly on the same link in one day.
    const { error: claimError } = await db.from('reward_claims').insert({
      short_id,
      clicker_tg_id: telegramUser.id,
      ip_address: clientIp,
      reward_date: rewardDate
    });
    if (claimError) {
      if (claimError.code === '23505') return res.status(200).json({ success: true, earned: false, duplicate: true, message: 'This Telegram account has already used this link for a reward today.' });
      console.error('Reward claim insert error:', claimError);
      return res.status(500).json({ error: 'Could not register this reward attempt.' });
    }

    const { data: settings } = await db.from('settings').select('cpm,refer_percent,ip_restrict_hours').limit(1).maybeSingle();
    const cpm = Math.max(0, Number(settings?.cpm) || 0);
    const restrictHours = Math.max(0, Number(settings?.ip_restrict_hours) || 24);
    const earnAmount = cpm / 1000;
    let grantReward = true;
    let reason = 'Reward added successfully.';

    // Network-level restriction. This is an abuse deterrent, not a unique-person identifier.
    if (clientIp !== 'unknown' && restrictHours > 0) {
      const { data: ipLog, error: ipReadError } = await db.from('ip_logs').select('ip_address,last_rewarded_at').eq('ip_address', clientIp).maybeSingle();
      if (ipReadError) throw ipReadError;
      if (ipLog?.last_rewarded_at) {
        const hoursSince = (now.getTime() - new Date(ipLog.last_rewarded_at).getTime()) / 3600000;
        if (hoursSince >= 0 && hoursSince < restrictHours) {
          grantReward = false;
          reason = `This network has reached its reward limit. Try again after ${restrictHours} hours.`;
        } else {
          const { error } = await db.from('ip_logs').update({ last_rewarded_at: now.toISOString() }).eq('ip_address', clientIp);
          if (error) throw error;
        }
      } else {
        const { error } = await db.from('ip_logs').insert({ ip_address: clientIp, last_rewarded_at: now.toISOString() });
        if (error && error.code !== '23505') throw error;
      }
    }

    // Count each accepted unique attempt once. Earnings are applied only if both account and IP checks pass.
    const { error: clickUpdateError } = await db.from('links').update({ clicks: (Number(link.clicks) || 0) + 1 }).eq('id', link.id);
    if (clickUpdateError) throw clickUpdateError;

    if (grantReward) {
      const { error: userUpdateError } = await db.from('users').update({
        balance: (Number(owner.balance) || 0) + earnAmount,
        today_earnings: (Number(owner.today_earnings) || 0) + earnAmount,
        total_earnings: (Number(owner.total_earnings) || 0) + earnAmount,
        total_clicks: (Number(owner.total_clicks) || 0) + 1,
        today_clicks: (Number(owner.today_clicks) || 0) + 1
      }).eq('id', owner.id);
      if (userUpdateError) throw userUpdateError;

      const { error: linkEarnError } = await db.from('links').update({ earnings: (Number(link.earnings) || 0) + earnAmount }).eq('id', link.id);
      if (linkEarnError) throw linkEarnError;

      const referPercent = Math.max(0, Number(settings?.refer_percent) || 0);
      if (referPercent > 0 && owner.telegram_id) {
        const { data: referral } = await db.from('referrals').select('referrer_tg_id').eq('referred_tg_id', owner.telegram_id).maybeSingle();
        if (referral?.referrer_tg_id) {
          const { data: referrer } = await db.from('users').select('id,balance,total_earnings').eq('telegram_id', referral.referrer_tg_id).maybeSingle();
          if (referrer) {
            const commission = earnAmount * referPercent / 100;
            const { error } = await db.from('users').update({
              balance: (Number(referrer.balance) || 0) + commission,
              total_earnings: (Number(referrer.total_earnings) || 0) + commission
            }).eq('id', referrer.id);
            if (error) throw error;
          }
        }
      }
    }

    return res.status(200).json({ success: true, earned: grantReward, amount: grantReward ? earnAmount : 0, message: reason, verification: 'telegram_identity_and_abuse_checks_only' });
  } catch (error) {
    console.error('Reward API Error:', error);
    return res.status(500).json({ error: error.message || 'Reward processing failed.' });
  }
}
