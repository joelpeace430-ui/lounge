
async function sbFetch(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} failed: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

function calcPrice(elapsedMs, profile) {
  const rate = profile.rate_per_hour || 0;
  if (!rate) return null;
  let mins = elapsedMs / 60000;
  const round = profile.round_mode || 'none';
  if (round !== 'none') {
    const step = parseInt(round);
    mins = Math.ceil(mins / step) * step;
  }
  let price = (mins / 60) * rate;
  if (profile.min_charge > 0 && price < profile.min_charge) price = profile.min_charge;
  return Math.round(price * 100) / 100;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    // this fires at 21:00 UTC = 00:00 Nairobi — so "the day that just ended"
    // in Nairobi terms is (Nairobi's current date) minus one day
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const dateKey = yesterday.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }); // YYYY-MM-DD
    const startUTC = new Date(dateKey + 'T00:00:00+03:00').toISOString();
    const endUTC = new Date(dateKey + 'T23:59:59.999+03:00').toISOString();

    const profiles = await sbFetch('/profiles?select=id,rate_per_hour,min_charge,round_mode,reset_mode');
    const results = [];

    for (const profile of profiles || []) {
      try {
        const existing = await sbFetch(`/daily_totals?owner_id=eq.${profile.id}&date=eq.${dateKey}&select=date`);
        if (existing && existing.length) {
          results.push({ owner: profile.id, skipped: 'already finalized' });
          continue;
        }

        const daySessions = await sbFetch(`/sessions?owner_id=eq.${profile.id}&start_time=gte.${startUTC}&start_time=lte.${endUTC}&select=*`);
        let revenue = 0;
        (daySessions || []).forEach(s => {
          const elapsed = s.signed_out
            ? (new Date(s.sign_out_time) - new Date(s.start_time))
            : (Date.now() - new Date(s.start_time));
          const price = calcPrice(elapsed, profile);
          if (price) revenue += price;
        });
        revenue = Math.round(revenue * 100) / 100;

        await sbFetch('/daily_totals', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({
            owner_id: profile.id, date: dateKey, total: revenue,
            customer_count: (daySessions || []).length, finalized_at: new Date().toISOString(),
          }),
        });

        let cleared = 0;
        if (profile.reset_mode === 'clear' && daySessions && daySessions.length) {
          const debts = await sbFetch(`/debts?owner_id=eq.${profile.id}&select=idnum,amount`);
          const debtByIdnum = {};
          (debts || []).forEach(d => { debtByIdnum[d.idnum] = d.amount; });
          // keep anyone who still owes money — same rule as the in-browser version
          const toDelete = daySessions.filter(s => !(debtByIdnum[s.idnum] > 0.01)).map(s => s.id);
          if (toDelete.length) {
            await sbFetch(`/sessions?id=in.(${toDelete.join(',')})`, { method: 'DELETE' });
            cleared = toDelete.length;
          }
        }

        results.push({ owner: profile.id, revenue, customers: (daySessions || []).length, cleared });
      } catch (ownerErr) {
        console.error('finalize-day failed for owner', profile.id, ':', ownerErr.message);
        results.push({ owner: profile.id, error: ownerErr.message });
      }
    }

    console.log(`finalize-day complete for ${dateKey}:`, JSON.stringify(results));
    return res.status(200).json({ date: dateKey, processed: results.length, results });
  } catch (err) {
    console.error('finalize-day error:', err);
    return res.status(500).json({ error: err.message });
  }
}
