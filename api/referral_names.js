import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST only' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ success: false, error: 'Backend configuration missing.' });
  }

  // Verify the real Supabase login session; do not trust a user ID from the browser.
  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!accessToken) {
    return res.status(401).json({ success: false, error: 'Supabase login session missing. Please log in again.' });
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(accessToken);
  if (authError || !authData?.user?.id) {
    return res.status(401).json({ success: false, error: 'Supabase login session is invalid or expired.' });
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const authId = authData.user.id;
    let { data: profile, error: profileError } = await db
      .from('users').select('id, telegram_id').eq('auth_id', authId).maybeSingle();
    if (profileError) throw profileError;

    // Backward compatibility for older profiles.
    if (!profile) {
      const legacy = await db
        .from('users').select('id, telegram_id').eq('auth_user_id', authId).maybeSingle();
      if (legacy.error) throw legacy.error;
      profile = legacy.data;
    }

    if (!profile?.telegram_id) {
      return res.status(404).json({ success: false, error: 'Your TGShortUrl profile was not found for this login.' });
    }

    const referrerId = String(profile.telegram_id);
    const { data: referrals, error: referralError } = await db
      .from('referrals').select('referred_tg_id, created_at')
      .eq('referrer_tg_id', referrerId).order('created_at', { ascending: false });
    if (referralError) throw referralError;

    const ids = [...new Set((referrals || []).map(r => String(r.referred_tg_id)))];
    let users = [];
    if (ids.length) {
      const { data, error } = await db.from('users')
        .select('telegram_id, first_name, username').in('telegram_id', ids);
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
    return res.status(500).json({ success: false, error: 'Could not load referral names.' });
  }
}
