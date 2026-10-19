// FinPulse – "המספרים של היום": live official data (Bank of Israel public API) + verified manual file
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = dirname(fileURLToPath(import.meta.url));
const pct = (x) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x).toFixed(2)}%`;
const dmy = (iso) => { const d = new Date(iso); return `${d.getDate()}.${d.getMonth() + 1}`; };

async function boi(path) {
  const r = await fetch(`https://boi.org.il/PublicApi/${path}?asJson=true`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('boi ' + r.status);
  return r.json();
}

export async function buildNumbers() {
  const manual = existsSync(join(WEB, 'numbers-manual.json')) ? JSON.parse(readFileSync(join(WEB, 'numbers-manual.json'), 'utf8')) : { numbers: [], events: [] };
  const live = [];
  try {
    const i = await boi('GetInterest');
    // direction: last change + level a year ago, from the official daily series (SDMX)
    let trend = '', change = '';
    try {
      const from = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
      const csv = await (await fetch(`https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/BR/1.0/MNT_RIB_BOI_D?startperiod=${from}&format=csv`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
      const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',')).map((c) => ({ d: c[9], v: Number(c[10]) })).filter((r) => r.d && !isNaN(r.v));
      const cur = i.currentInterest;
      const k = rows.findLastIndex((r) => r.v !== cur);
      if (k >= 0) { const diff = cur - rows[k].v; change = `${diff > 0 ? '+' : '-'}${Math.abs(diff).toFixed(2)}`; const dt = new Date(rows[k + 1].d); trend = `${diff < 0 ? 'הורדה' : 'העלאה'} מ-${rows[k].v}% ב-${dt.getDate()}.${dt.getMonth() + 1}.${String(dt.getFullYear()).slice(2)}`; }
      const yearAgo = rows.filter((r) => r.d <= new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)).at(-1);
      if (yearAgo) trend += `${trend ? ' · ' : ''}לפני שנה ${yearAgo.v}%`;
    } catch {}
    live.push({ key: 'boi', label: 'ריבית בנק ישראל', value: `${i.currentInterest}%`, change, note: `${trend ? trend + ' · ' : ''}החלטה הבאה: ${dmy(i.nextInterestDate)}`, source: 'https://www.boi.org.il', by: 'בנק ישראל · רשמי, אוטומטי' });
    live.push({ key: 'prime', label: 'פריים', value: `${(i.currentInterest + 1.5).toFixed(2)}%`, change: '', note: 'ריבית בנק ישראל + 1.5', source: 'https://www.boi.org.il', by: 'בנק ישראל · רשמי, אוטומטי' });
  } catch {}
  try {
    const fx = (await boi('GetExchangeRates')).exchangeRates;
    for (const [k, label] of [['USD', 'דולר / שקל'], ['EUR', 'אירו / שקל']]) {
      const x = fx.find((e) => e.key === k); if (!x) continue;
      // weekly & monthly change from the official BOI series (SDMX)
      let trend = '';
      try {
        const from = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
        const csv = await (await fetch(`https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_${k}_ILS?startperiod=${from}&format=csv`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
        const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',')).map((c) => ({ d: c[12], v: Number(c[13]) })).filter((r) => r.v);
        const now = x.currentExchangeRate;
        const at = (days) => { const t = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10); const r = rows.filter((r) => r.d <= t).at(-1); return r ? r.v : null; };
        const w = at(7), m = at(30);
        if (w) trend = `שבוע ${pct((now / w - 1) * 100)}`; if (m) trend += ` · חודש ${pct((now / m - 1) * 100)}`;
      } catch {}
      live.push({ key: k, label, value: x.currentExchangeRate.toFixed(3), change: pct(x.currentChange), note: `שער יציג · ${dmy(x.lastUpdate)}${trend ? ' · ' + trend : ''}`, source: 'https://www.boi.org.il', by: 'בנק ישראל · רשמי, אוטומטי' });
    }
  } catch {}
  // stale data is worse than no data: hide manual values whose asOf date is older than maxAgeDays (default 10)
  const fresh = (n) => !n.asOf || (Date.now() - new Date(n.asOf)) / 864e5 <= (n.maxAgeDays || 10);
  const numbers = [...live, ...manual.numbers.filter((n) => n.value && fresh(n))];   // unverified/stale values are not shown
  const forecasts = (manual.forecasts || []).filter(fresh);
  return { updated: new Date().toISOString(), numbers, events: manual.events || [], forecasts, forecastsNote: manual.forecastsNote || '' };
}

if (process.argv[1] && /[\\/]numbers\.mjs$/.test(process.argv[1])) console.log(JSON.stringify(await buildNumbers(), null, 1));
