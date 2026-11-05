// GET /api/notify?when=today|tomorrow  -- called by Vercel Cron (needs CRON_SECRET)
const crypto = require('crypto');
const { sb, ready, sendAll } = require('./_push');

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const title = s => s.toLowerCase().replace(/(^|[\s\-'’])([a-z])/g, (m, a, b) => a + b.toUpperCase());

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not set.' });
  if (!same(req.headers.authorization || '', `Bearer ${secret}`)) return res.status(401).end();
  if (!ready()) return res.status(500).json({ error: 'Alert keys are not set.' });

  try {
    const when = req.query.when === 'tomorrow' ? 'tomorrow' : 'today';
    // Nigeria is UTC+1 all year, so shift the clock by one hour to get the local date
    const wat = new Date(Date.now() + 3600e3);
    const t = new Date(Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), wat.getUTCDate() + (when === 'tomorrow' ? 1 : 0)));
    const m = t.getUTCMonth() + 1, d = t.getUTCDate(), y = t.getUTCFullYear();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

    const r = await sb('members?select=id,name,dob');
    if (!r.ok) return res.status(500).json({ error: 'Could not read members.' });
    const hits = (await r.json()).filter(x => {
      const [, mm, dd] = x.dob.split('-').map(Number);
      return (mm === m && dd === d) || (!leap && m === 3 && d === 1 && mm === 2 && dd === 29);
    });
    if (!hits.length) return res.json({ when, matches: 0 });

    const names = hits.map(h => title(h.name));
    const one = hits.length === 1;
    const first = names[0].split(' ')[0];
    const payload = when === 'today'
      ? { title: `🎂 Birthday today: ${names.join(', ')}`, body: one ? `It is ${first}’s birthday today. Tap to make the flyer.` : 'Tap to open the list and make the flyers.' }
      : { title: `🎁 Birthday tomorrow: ${names.join(', ')}`, body: one ? `Get ${first}’s flyer ready. Tap to open it.` : 'Tap to open the list and get the flyers ready.' };
    payload.url = one ? `/flyer?id=${hits[0].id}` : '/admin';
    payload.tag = `birthday-${when}-${y}-${m}-${d}`;
    payload.renotify = false; // a duplicate cron delivery replaces the first alert instead of ringing twice

    const out = await sendAll(payload);
    return res.json({ when, matches: hits.length, ...out });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
