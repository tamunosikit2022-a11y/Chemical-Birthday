// Shared helpers for sending web-push alerts (not a route: file name starts with _)
const webpush = require('web-push');
const { SUPABASE_URL, SUPABASE_SERVICE_KEY: KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;

const sb = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: KEY,
    ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }),
    'Content-Type': 'application/json',
    ...(init.headers || {})
  }
});

let configured = false;
function ready() {
  if (configured) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://chemica.vercel.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return (configured = true);
}

async function sendAll(payload) {
  const r = await sb('push_subs?select=endpoint,sub');
  if (!r.ok) throw new Error('Could not read subscriptions');
  const subs = await r.json();
  let sent = 0, removed = 0, failed = 0;
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 43200, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        removed++;
        await sb(`push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } else failed++;
    }
  }));
  return { subscribers: subs.length, sent, removed, failed };
}

module.exports = { sb, ready, sendAll };
