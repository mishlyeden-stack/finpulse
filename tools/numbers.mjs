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
  // unemployment: the SAME official series the Pulse tab uses (Bank of Israel SDMX LBM/UE_R_M_SA, seasonally adjusted) – no manual / news-sourced value
  try {
    const from = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 7);
    const url = `https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/LBM/1.0/UE_R_M_SA?startperiod=${from}&format=csv`;
    const t = await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const lines = t.trim().split(/\r?\n/);
    const head = lines[0].split(','), ti = head.indexOf('TIME_PERIOD'), vi = head.indexOf('OBS_VALUE');   // this series has no quoted fields
    const s = lines.slice(1).map((l) => l.split(',')).filter((r) => r.length > vi && r[vi] !== '' && !isNaN(Number(r[vi]))).map((r) => [r[ti], Number(r[vi])]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const [ly, lm] = s.at(-1)[0].split('-').map(Number);
    const ageDays = (Date.now() - new Date(Date.UTC(ly, lm, 0))) / 864e5;
    if (s.length > 1 && ageDays <= 75) {
      const diff = s.at(-1)[1] - s.at(-2)[1];
      const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
      live.push({ key: 'unemp', label: 'אבטלה', value: s.at(-1)[1].toFixed(2) + '%', change: (diff > 0 ? '+' : diff < 0 ? '-' : '') + Math.abs(diff).toFixed(2), note: MONTHS[lm - 1] + ' ' + ly + ' · מנוכה עונתיות', source: 'https://www.boi.org.il/en/economic-roles/statistics/', by: 'בנק ישראל (נתוני הלמ״ס) · רשמי, אוטומטי' });
    }
  } catch {}
  // stale data is worse than no data: hide manual values whose asOf date is older than maxAgeDays (default 10)
  const fresh = (n) => !n.asOf || (Date.now() - new Date(n.asOf)) / 864e5 <= (n.maxAgeDays || 10);
  const order = { USD: 0, EUR: 1, boi: 2, prime: 3, unemp: 4 };   // exchange rates first: equipment costs and contracts depend on them
  live.sort((x, y) => (order[x.key] ?? 9) - (order[y.key] ?? 9));
  const numbers = [...live, ...manual.numbers.filter((n) => n.value && fresh(n))];   // unverified/stale values are not shown
  const forecasts = (manual.forecasts || []).filter(fresh);
  return { updated: new Date().toISOString(), numbers, events: manual.events || [], forecasts, forecastsNote: manual.forecastsNote || '' };
}

if (process.argv[1] && /[\\/]numbers\.mjs$/.test(process.argv[1])) console.log(JSON.stringify(await buildNumbers(), null, 1));
