import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anon || !secret) {
    return res.status(500).json({ error: 'Missing Supabase environment variables' });
  }

  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Login required' });

  const auth = createClient(url, anon, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await auth.auth.getUser(token);
  const user = authData?.user;

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid login' });
  }

  const db = createClient(url, secret, { auth: { persistSession: false } });

  try {
    const { data: admin, error: adminError } = await db
      .from('users')
      .select('id,is_admin')
      .or(`auth_id.eq.${user.id},auth_user_id.eq.${user.id}`)
      .maybeSingle();

    if (adminError) throw adminError;
    if (!admin?.is_admin) {
      return res.status(403).json({ error: 'Admin access denied' });
    }

    const { action, id, block, status, data } = req.body || {};

    if (action === 'check') return res.json({ ok: true });

    if (action === 'settings') {
      const { data: settings, error } = await db
        .from('settings')
        .select('*')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return res.json({ data: settings });
    }

    if (action === 'saveSettings') {
      const allowed = [
        'cpm',
        'refer_percent',
        'refer_reward_inr',
        'min_withdraw',
        'ad_timer',
        'ip_restrict_hours',
        'monetag_reward_script',
        'monetag_reward_func',
        'adsbitvex_reward_script',
        'adsbitvex_reward_func',
        'adsbitvex_banner_code',
        'ad_providers',
        'active_reward_ad',
        'telegram_channel_url',
        'payment_methods',
        'withdrawals_enabled',
        'maintenance_mode'
      ];

      const clean = {};
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(data || {}, key)) {
          clean[key] = data[key];
        }
      }

      if (Object.keys(clean).length === 0) {
        return res.status(400).json({ error: 'No recognized settings were provided.' });
      }

      const { data: existing, error: findError } = await db
        .from('settings')
        .select('id')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (findError) throw findError;

      let saved;
      let saveError;

      if (existing?.id !== undefined && existing?.id !== null) {
        const result = await db
          .from('settings')
          .update(clean)
          .eq('id', existing.id)
          .select('*')
          .single();
        saved = result.data;
        saveError = result.error;
      } else {
        const result = await db
          .from('settings')
          .insert(clean)
          .select('*')
          .single();
        saved = result.data;
        saveError = result.error;
      }

      if (saveError) throw saveError;
      if (!saved) throw new Error('Settings update returned no saved row.');

      return res.json({
        ok: true,
        data: saved,
        saved_min_withdraw: saved.min_withdraw
      });
    }

    if (action === 'dashboard_stats') {
      const { count: usersCount, error: usersError } = await db
        .from('users').select('*', { count: 'exact', head: true });
      if (usersError) throw usersError;

      const { count: linksCount, error: linksError } = await db
        .from('links').select('*', { count: 'exact', head: true });
      if (linksError) throw linksError;

      const { data: totalData, error: totalsError } = await db
        .from('users').select('total_clicks,total_earnings');
      if (totalsError) throw totalsError;

      let totalClicks = 0;
      let totalEarnings = 0;
      (totalData || []).forEach(u => {
        totalClicks += Number(u.total_clicks || 0);
        totalEarnings += Number(u.total_earnings || 0);
      });

      const { data: withdrawals, error: withdrawalsError } = await db
        .from('withdrawals').select('status');
      if (withdrawalsError) throw withdrawalsError;

      const wdCounts = { pending: 0, approved: 0, paid: 0, rejected: 0 };
      (withdrawals || []).forEach(w => {
        if (wdCounts[w.status] !== undefined) wdCounts[w.status]++;
      });

      return res.json({
        users: usersCount || 0,
        links: linksCount || 0,
        clicks: totalClicks,
        earnings: totalEarnings,
        withdrawals: wdCounts
      });
    }

    async function addRegisteredEmails(rows) {
      return Promise.all((rows || []).map(async (row) => {
        let email = row.email || '';
        const authId = row.auth_id || row.auth_user_id;
        if (!email && authId) {
          try {
            const { data: authUserData } = await db.auth.admin.getUserById(authId);
            email = authUserData?.user?.email || '';
          } catch (emailError) {
            console.warn('Could not resolve registered email for profile:', row.id, emailError?.message);
          }
        }
        return { ...row, email };
      }));
    }

    if (action === 'users') {
      const r = await db.from('users')
        .select('id,auth_id,auth_user_id,email,telegram_id,first_name,last_name,username,balance,total_earnings,total_clicks,today_clicks,is_blocked,is_admin,created_at')
        .order('created_at', { ascending: false }).limit(1000);
      if (r.error) throw r.error;
      return res.json({ data: await addRegisteredEmails(r.data) });
    }

    if (action === 'block') {
      const r = await db.from('users').update({ is_blocked: !!block }).eq('id', id).eq('is_admin', false).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) throw new Error('User not found or is admin');
      return res.json({ ok: true });
    }

    if (action === 'withdrawals') {
      const r = await db.from('withdrawals').select('*').order('created_at', { ascending: false }).limit(1000);
      if (r.error) throw r.error;
      const userIds = [...new Set((r.data || []).map(w => w.user_id).filter(Boolean))];
      let profiles = [];
      if (userIds.length) {
        const profileResult = await db.from('users')
          .select('id,auth_id,auth_user_id,email,telegram_id,first_name,last_name,username')
          .in('id', userIds);
        if (profileResult.error) throw profileResult.error;
        profiles = await addRegisteredEmails(profileResult.data);
      }
      const profileMap = new Map(profiles.map(profile => [String(profile.id), profile]));
      const enriched = (r.data || []).map(withdrawal => {
        const profile = profileMap.get(String(withdrawal.user_id)) || {};
        const tgName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
        return {
          ...withdrawal,
          user_details: {
            tg_name: tgName || 'N/A',
            email: profile.email || 'N/A',
            username: profile.username ? `@${String(profile.username).replace(/^@/, '')}` : 'N/A'
          }
        };
      });
      return res.json({ data: enriched });
    }

    if (action === 'withdrawal') {
      if (!['approved', 'rejected', 'paid'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const r = await db.rpc('admin_process_withdrawal', {
        p_withdrawal_id: id,
        p_status: status
      });
      if (r.error) throw r.error;
      if (!r.data?.success) throw new Error(r.data?.message || 'Update failed');
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('Admin API error:', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
