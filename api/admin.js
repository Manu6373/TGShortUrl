import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !secret) return res.status(500).json({error:'Missing Supabase env vars'});
  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({error:'Login required'});
  
  const auth = createClient(url, anon, {auth:{persistSession:false}});
  const {data:{user},error:authError} = await auth.auth.getUser(token);
  if (authError || !user) return res.status(401).json({error:'Invalid login'});
  
  const db = createClient(url, secret, {auth:{persistSession:false}});
  const {data:admin,error:adminError}=await db.from('users').select('id,is_admin').or(`auth_id.eq.${user.id},auth_user_id.eq.${user.id}`).maybeSingle();
  if (adminError || !admin?.is_admin) return res.status(403).json({error:'Admin access denied'});
  
  const {action,id,block,status,data,caption,image_url,use_button,mini_app_url}=req.body||{};
  
  try {
    if(action==='check') return res.json({ok:true});
    
    if(action==='dashboard_stats') {
        const { count: usersCount } = await db.from('users').select('*', { count: 'exact', head: true });
        const { count: linksCount } = await db.from('links').select('*', { count: 'exact', head: true });
        const { data: totalData } = await db.from('users').select('total_clicks,total_earnings');
        let totalClicks = 0, totalEarnings = 0;
        totalData?.forEach(u => { totalClicks += (u.total_clicks||0); totalEarnings += (u.total_earnings||0); });
        const { data: withdrawals } = await db.from('withdrawals').select('status');
        const wdCounts = { pending:0, approved:0, paid:0, rejected:0 };
        withdrawals?.forEach(w => { if(wdCounts[w.status]!==undefined) wdCounts[w.status]++; });
        
        return res.json({
            users: usersCount||0, links: linksCount||0, clicks: totalClicks, earnings: totalEarnings,
            withdrawals: wdCounts
        });
    }

    if(action==='users') {const r=await db.from('users').select('*').order('created_at',{ascending:false}).limit(1000);if(r.error)throw r.error;return res.json({data:r.data})}
    
    if(action==='block') {const r=await db.from('users').update({is_blocked:!!block}).eq('id',id).eq('is_admin',false).select('id');if(r.error)throw r.error;if(!r.data?.length)throw Error('User not found or is admin');return res.json({ok:true})}
    
    if(action==='withdrawals') {const r=await db.from('withdrawals').select('*').order('created_at',{ascending:false}).limit(1000);if(r.error)throw r.error;return res.json({data:r.data})}
    
    if(action==='withdrawal') {
        if(!['approved','rejected','paid'].includes(status)) return res.status(400).json({error:'Invalid status'});
        const r = await db.rpc('admin_process_withdrawal',{p_withdrawal_id:id,p_status:status});
        if(r.error) throw r.error;
        if(!r.data?.success) throw Error(r.data?.message || 'Update failed');
        return res.json({ok:true});
    }
    
    if(action==='settings') {const r=await db.from('settings').select('*').limit(1).maybeSingle();if(r.error)throw r.error;return res.json({data:r.data})}
    
    if(action==='saveSettings') {
        const allowed=['cpm','refer_percent','refer_reward_inr','min_withdraw','ad_timer','ip_restrict_hours','monetag_reward_script','monetag_reward_func','telegram_channel_url','payment_methods','withdrawals_enabled','maintenance_mode'];
        const clean={};
        for(const key of allowed) if(Object.prototype.hasOwnProperty.call(data||{},key)) clean[key]=data[key];
        if (!Object.keys(clean).length) throw Error('No settings supplied');
        const existing=await db.from('settings').select('id').limit(1).maybeSingle();
        if(existing.error)throw existing.error;
        const r = existing.data ? await db.from('settings').update(clean).eq('id',existing.data.id) : await db.from('settings').insert(clean);
        if(r.error)throw r.error;
        return res.json({ok:true});
    }
    
    // Broadcast unchanged...
    return res.status(400).json({error:'Unknown action'});
  } catch(e) {
      console.error('Admin API error',e); return res.status(500).json({error:e.message||'Server error'})
  }
}
