// POST /api/admin  { action: status|setup|login|logout|list|photo|delete, ... }
// GET  /api/admin?photo=ID  -> member photo (admin only)
const crypto = require('crypto');
const { SUPABASE_URL, SUPABASE_SERVICE_KEY: KEY, SETUP_CODE } = process.env;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sb = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: KEY,
    ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }),
    'Content-Type': 'application/json',
    ...(init.headers || {})
  }
});
const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hashPw = pw => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const verifyPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  return !!salt && !!h && eq(crypto.scryptSync(pw, salt, 64).toString('hex'), h);
};
// Session token is signed with a secret derived from the server key + password hash,
// so changing the password signs everyone out.
const tokenFor = (hash, exp) => {
  const secret = crypto.createHash('sha256').update(KEY + hash).digest();
  return `${exp}.${crypto.createHmac('sha256', secret).update(String(exp)).digest('hex')}`;
};
const COOKIE = 'HttpOnly; Secure; SameSite=Strict; Path=/';
const setCookie = (res, hash) =>
  res.setHeader('Set-Cookie', `session=${tokenFor(hash, Date.now() + 30 * 864e5)}; ${COOKIE}; Max-Age=${30 * 86400}`);
const authed = (req, hash) => {
  if (!hash) return false;
  const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && !!sig && Date.now() <= Number(exp) && eq(tokenFor(hash, exp), m[1]);
};
const validPhoto = p => typeof p === 'string' && p.startsWith('data:image/jpeg;base64,') && p.length <= 700000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: 'Server is not set up yet.' });
  try {
    const hr = await sb('admin?select=password_hash&id=eq.1');
    if (!hr.ok) return res.status(500).json({ error: 'Database is not ready. Did you run step2.sql?' });
    const hash = ((await hr.json())[0] || {}).password_hash || null;
    const ok = authed(req, hash);

    if (req.method === 'GET') {
      if (!ok) return res.status(401).end();
      const id = parseInt(req.query.photo, 10);
      if (!id) return res.status(400).end();
      const rows = await (await sb(`members?select=photo&id=eq.${id}`)).json();
      const p = rows[0] && rows[0].photo;
      if (!p) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(Buffer.from(p.split(',')[1], 'base64'));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const b = req.body || {};
    switch (b.action) {
      case 'status':
        return res.json({ setup: !!hash, loggedIn: ok });

      case 'setup': {
        if (hash) return res.status(400).json({ error: 'A password has already been created.' });
        if (!SETUP_CODE) return res.status(500).json({ error: 'The setup code has not been added to Vercel yet.' });
        if (!eq(b.code || '', SETUP_CODE)) { await sleep(700); return res.status(403).json({ error: 'That setup code is not correct.' }); }
        const pw = String(b.password || '');
        if (pw.length < 8 || pw.length > 100) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
        const h = hashPw(pw);
        const r = await sb('admin', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: 1, password_hash: h }) });
        if (!r.ok) return res.status(400).json({ error: 'Could not save the password. Try again.' });
        setCookie(res, h);
        return res.json({ ok: true });
      }

      case 'login':
        if (!hash) return res.status(400).json({ error: 'No password has been created yet.' });
        if (!verifyPw(String(b.password || ''), hash)) { await sleep(700); return res.status(401).json({ error: 'Wrong password.' }); }
        setCookie(res, hash);
        return res.json({ ok: true });

      case 'logout':
        res.setHeader('Set-Cookie', `session=; ${COOKIE}; Max-Age=0`);
        return res.json({ ok: true });
    }

    if (!ok) return res.status(401).json({ error: 'Please log in.' });

    if (b.action === 'list') {
      const r = await sb('members?select=id,name,dob,phone,has_photo,created_at&order=name.asc');
      if (!r.ok) return res.status(500).json({ error: 'Could not load members.' });
      return res.json({ members: await r.json() });
    }
    if (b.action === 'vapid') return res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
    if (b.action === 'subscribe') {
      const x = b.sub;
      if (!x || !String(x.endpoint || '').startsWith('https://') || !x.keys || !x.keys.p256dh || !x.keys.auth) return res.status(400).json({ error: 'Invalid subscription.' });
      const r = await sb('push_subs?on_conflict=endpoint', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ endpoint: x.endpoint, sub: { endpoint: x.endpoint, keys: x.keys } }) });
      return r.ok ? res.json({ ok: true }) : res.status(500).json({ error: 'Could not save. Did you run step4.sql?' });
    }
    if (b.action === 'unsubscribe') {
      await sb(`push_subs?endpoint=eq.${encodeURIComponent(String(b.endpoint || ''))}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.json({ ok: true });
    }
    if (b.action === 'test') {
      const push = require('./_push');
      if (!push.ready()) return res.status(500).json({ error: 'The alert keys are not set in Vercel yet.' });
      const out = await push.sendAll({ title: '🔔 Test alert', body: 'Birthday alerts are working on this phone.', url: '/admin', tag: 'test-' + Date.now(), renotify: true });
      return out.sent ? res.json({ ok: true, ...out }) : res.status(400).json({ error: 'Nothing was delivered. Turn alerts on for this phone first.' });
    }
    const id = parseInt(b.id, 10);
    if (!id) return res.status(400).json({ error: 'Missing member.' });
    if (b.action === 'photo') {
      if (!validPhoto(b.photo)) return res.status(400).json({ error: 'That photo could not be used.' });
      const r = await sb(`members?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ photo: b.photo }) });
      return r.ok ? res.json({ ok: true }) : res.status(500).json({ error: 'Could not save the photo.' });
    }
    if (b.action === 'delete') {
      const r = await sb(`members?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return r.ok ? res.json({ ok: true }) : res.status(500).json({ error: 'Could not delete.' });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
