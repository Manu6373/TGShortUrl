import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST only'});
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !secret) return res.status(500).json({error:'Missing Supabase environment variables'});
  const token = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({error:'Login required'});
  const auth = createClient(url, anon, {auth:{persistSession:false}});
  const {data:{user},error:authError} = await auth.auth.getUser(token);
  if (authError || !user) return res.status(401).json({error:'Invalid login'});
  const db = createClient(url, secret, {auth:{persistSession:false}});
  const {data:admin,error:adminError}=await db.from('users').select('id,is_admin').eq('auth_id',user.id).maybeSingle();
  if (adminError || !admin?.is_admin) return res.status(403).json({error:'Admin access denied'});
  const {action,id,block,status,data,caption,image_url,use_button,mini_app_url}=req.body||{};
  try {
    if(action==='check') return res.json({ok:true});
    if(action==='users') {const r=await db.from('users').select('id,email,telegram_id,first_name,balance,is_blocked,created_at').order('created_at',{ascending:false}).limit(1000);if(r.error)throw r.error;return res.json({data:r.data})}
    if(action==='block') {const r=await db.from('users').update({is_blocked:!!block}).eq('id',id).eq('is_admin',false).select('id');if(r.error)throw r.error;if(!r.data?.length)throw Error('User not found or is admin');return res.json({ok:true})}
    if(action==='withdrawals') {const r=await db.from('withdrawals').select('*').order('created_at',{ascending:false}).limit(1000);if(r.error)throw r.error;return res.json({data:r.data})}
    if(action==='withdrawal') {if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Invalid status'});const r=await db.rpc('admin_process_withdrawal',{p_withdrawal_id:id,p_status:status});if(r.error)throw r.error;return res.json({ok:true})}
    if(action==='settings') {const r=await db.from('settings').select('*').limit(1).maybeSingle();if(r.error)throw r.error;return res.json({data:r.data})}
    if(action==='saveSettings') {const allowed=['cpm','refer_percent','min_withdraw','ad_timer','ip_restrict_hours','active_reward_ad','active_banner_ad','monetag_reward_script','monetag_reward_func','adsbitvex_reward_script','adsbitvex_reward_func','adsbitvex_banner_code','payment_methods','maintenance_mode'];const clean={};for(const key of allowed)if(Object.prototype.hasOwnProperty.call(data||{},key))clean[key]=data[key];const existing=await db.from('settings').select('id').limit(1).maybeSingle();if(existing.error)throw existing.error;const r=existing.data?await db.from('settings').update(clean).eq('id',existing.data.id):await db.from('settings').insert(clean);if(r.error)throw r.error;return res.json({ok:true})}
    if(action==='broadcast') {
      if(!process.env.BOT_TOKEN)throw Error('BOT_TOKEN missing');
      if(!caption&&!image_url)return res.status(400).json({error:'Message or image required'});
      if(caption?.length>(image_url?1024:4096))return res.status(400).json({error:'Message too long'});
      const target=mini_app_url||'https://tgshorturl.vercel.app/';
      let parsed;try{parsed=new URL(target);if(parsed.protocol!=='https:')throw Error()}catch{return res.status(400).json({error:'Valid HTTPS button URL required'})}
      const {data:users,error}=await db.from('users').select('telegram_id').not('telegram_id','is',null).limit(1000);if(error)throw error;
      const reply_markup=use_button===false?undefined:{inline_keyboard:[[{text:'👉 Open TGShortUrl 👈',...(parsed.hostname==='t.me'?{url:target}:{web_app:{url:target}})}]]};
      let sent=0,failed=0;
      for(const u of users){try{const payload={chat_id:u.telegram_id,parse_mode:'HTML',reply_markup,...(image_url?{photo:image_url,caption:caption||''}:{text:caption})};const response=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${image_url?'sendPhoto':'sendMessage'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.json();if(body.ok)sent++;else failed++}catch{failed++}await new Promise(r=>setTimeout(r,40))}
      return res.json({sent,failed,total:users.length,note:users.length===1000?'Limited to first 1000 users per request':''});
    }
    return res.status(400).json({error:'Unknown action'});
  }catch(e){console.error('Admin API error',e);return res.status(500).json({error:e.message||'Server error'})}
}
