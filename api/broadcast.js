import { createClient } from '@supabase/supabase-js';

const BATCH_SIZE = 50;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.BOT_TOKEN;

  if (!url || !anon || !serviceKey || !botToken) {
    return res.status(500).json({ error: 'Server configuration is incomplete.' });
  }

  // Authenticate the caller and verify admin status on the server for every batch.
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Login required.' });

  const authClient = createClient(url, anon, {
    auth: { persistSession: false }
  });

  const { data: authData, error: authError } = await authClient.auth.getUser(token);

  if (authError || !authData?.user) {
    return res.status(401).json({ error: 'Invalid login.' });
  }

  // Verify MFA assurance level.
  let tokenClaims;

  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    tokenClaims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }

  if (tokenClaims.aal !== 'aal2') {
    return res.status(403).json({
      error: 'Two-factor authentication required.'
    });
  }

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false }
  });

  const { data: admin, error: adminError } = await db
    .from('users')
    .select('id,is_admin')
    .or(`auth_id.eq.${authData.user.id},auth_user_id.eq.${authData.user.id}`)
    .maybeSingle();

  if (adminError) {
    return res.status(500).json({
      error: 'Could not verify admin access.'
    });
  }

  if (!admin?.is_admin) {
    return res.status(403).json({
      error: 'Admin access denied.'
    });
  }

  const body = req.body || {};
  const offset = Number(body.offset ?? 0);
  const imageUrl = typeof body.image_url === 'string'
    ? body.image_url.trim()
    : '';
  const message = typeof body.message === 'string'
    ? body.message.trim()
    : '';
  const useButton = body.use_button !== false;

  if (!Number.isSafeInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'Invalid batch offset.' });
  }

  if (!message) {
    return res.status(400).json({
      error: 'Enter a message or photo caption.'
    });
  }

  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);

      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error('Invalid URL');
      }
    } catch {
      return res.status(400).json({
        error: 'Image URL must be a valid public HTTPS URL.'
      });
    }

    if (message.length > 1024) {
      return res.status(400).json({
        error: 'Photo caption must be 1,024 characters or fewer.'
      });
    }
  } else if (message.length > 4096) {
    return res.status(400).json({
      error: 'Text message must be 4,096 characters or fewer.'
    });
  }

  const {
    data: recipients,
    count,
    error: usersError
  } = await db
    .from('users')
    .select('telegram_id', { count: 'exact' })
    .not('telegram_id', 'is', null)
    .order('id', { ascending: true })
    .range(offset, offset + BATCH_SIZE - 1);

  if (usersError) {
    return res.status(500).json({
      error: 'Could not load registered Telegram users.'
    });
  }

  const chatIds = [...new Set(
    (recipients || [])
      .map(row => String(row.telegram_id || '').trim())
      .filter(value => /^-?\d+$/.test(value))
  )];

  const replyMarkup = useButton ? {
    inline_keyboard: [[
      {
        text: '👉 Open TGShortUrl 👈',
        web_app: {
          url: 'https://tgshorturl.vercel.app/'
        }
      }
    ]]
  } : undefined;

  let sent = 0;
  let failed = 0;

  const endpoint = imageUrl ? 'sendPhoto' : 'sendMessage';

  for (const chatId of chatIds) {
    const payload = { chat_id: chatId };

    if (imageUrl) {
      payload.photo = imageUrl;
      payload.caption = message;
    } else {
      payload.text = message;
    }

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    try {
      let response = await fetch(
        `https://api.telegram.org/bot${botToken}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );

      let result = await response.json();

      // Respect Telegram's retry_after response for rate limiting.
      if (
        !result.ok &&
        response.status === 429 &&
        Number(result.parameters?.retry_after) > 0
      ) {
        await delay(
          Math.min(Number(result.parameters.retry_after) * 1000, 5000)
        );

        response = await fetch(
          `https://api.telegram.org/bot${botToken}/${endpoint}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );

        result = await response.json();
      }

      if (result.ok) {
        sent++;
      } else {
        failed++;
        console.warn(
          'Broadcast delivery failed:',
          chatId,
          result.description || response.status
        );
      }
    } catch (error) {
      failed++;
      console.warn(
        'Broadcast request failed:',
        error?.message || error
      );
    }

    await delay(40);
  }

  const nextOffset = offset + (recipients || []).length;

  return res.status(200).json({
    ok: true,
    sent,
    failed,
    processed: (recipients || []).length,
    total: count || 0,
    next_offset: nextOffset,
    done:
      nextOffset >= (count || 0) ||
      (recipients || []).length === 0
  });
}
