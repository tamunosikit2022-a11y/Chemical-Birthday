// POST /api/register  { name, dob, phone, photo, website }
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server is not set up yet.' });
  }

  const b = req.body || {};
  if (b.website) return res.status(200).json({ ok: true }); // honeypot: bots fill this

  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const dob = String(b.dob || '');
  const phone = String(b.phone || '').trim();
  const photo = b.photo ? String(b.photo) : null;

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Please enter your full name.' });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ error: 'Please enter a valid date of birth.' });
  const d = new Date(dob + 'T00:00:00Z');
  const year = d.getUTCFullYear();
  if (isNaN(d) || year < 1950 || d > new Date()) return res.status(400).json({ error: 'That date of birth does not look right.' });

  if (phone && !/^[0-9+\s-]{7,20}$/.test(phone)) return res.status(400).json({ error: 'Please enter a valid phone number.' });

  if (photo && (!photo.startsWith('data:image/jpeg;base64,') || photo.length > 700000)) {
    return res.status(400).json({ error: 'That photo could not be used. Try another one.' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/members`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      // New sb_secret_ keys go in apikey only; old JWT-style keys also need Bearer
      ...(SUPABASE_SERVICE_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ name, dob, phone: phone || null, photo })
  });

  if (!r.ok) return res.status(500).json({ error: 'Could not save. Please try again.' });
  return res.status(200).json({ ok: true });
};
