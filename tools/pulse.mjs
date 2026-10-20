// FinPulse – Market & Economy Pulse data builder. NO AI, NO secrets, public official sources only.
// Primary sources: Bank of Israel (SDMX), NY Fed, US Treasury, BLS, Federal Reserve Board (H.10), ECB.
// Output: pulse.json = indicators (with the DATE OF THE DATA, frequency and source), "actual vs expectation" rows,
// FX block (rates, public forecasts, theoretical forward, drivers), forecast vintages, rule-based signals, general CFO questions.
// Runs locally (web/pulse/build.mjs) and in GitHub Actions (tools/pulse.mjs) – same file, manual data sits next to it.
//   node build.mjs [--out path/to/pulse.json] [--max-age HOURS] [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const firstExisting = (...p) => p.find((f) => existsSync(f));
const readJSON = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// ---------------------------------------------------------------- http + csv helpers
const UA = { 'User-Agent': 'Mozilla/5.0 FinPulse/1.0 (public economic data reader)' };
async function getText(url, { tries = 3, timeout = 45000, pause = 800 } = {}) {
  let last;
  for (let a = 0; a < tries; a++) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { headers: UA, signal: ctl.signal });
      if (!r.ok) throw new Error('http ' + r.status);
      const t = await r.text();
      if (!t || /Verifying your browser|Radware/i.test(t.slice(0, 600))) throw new Error('bot-challenge/empty');
      return t;
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, pause * (a + 1))); } finally { clearTimeout(to); }
  }
  throw last;
}
const parseCsv = (t) => {   // RFC-4180-ish: quoted fields with commas / quotes / newlines
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
};
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- time helpers
// period key → Date at the END of the period (used for freshness only)
function periodEnd(t, freq) {
  if (freq === 'D') return new Date(t + 'T23:59:59Z');
  if (freq === 'M') { const [y, m] = t.split('-').map(Number); return new Date(Date.UTC(y, m, 0, 23, 59, 59)); }
  if (freq === 'Q') { const [y, q] = t.split('-Q').map(Number); return new Date(Date.UTC(y, q * 3, 0, 23, 59, 59)); }
  return new Date(t);
}
const FRESH_DAYS = { D: 6, M: 75, Q: 150 };   // older than this = "stale" (publication lags are ~1-6 weeks)
const ageDays = (t, freq) => Math.max(0, Math.floor((Date.now() - periodEnd(t, freq)) / 864e5));
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);

// ---------------------------------------------------------------- source fetchers → [[t, v], ...] sorted ascending
const BOI = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS';
async function boiSeries(flow, code, start) {
  const rows = parseCsv(await getText(`${BOI}/${flow}/1.0/${code}?startperiod=${start}&format=csv`));
  const h = rows[0], ti = h.indexOf('TIME_PERIOD'), vi = h.indexOf('OBS_VALUE');
  if (ti < 0 || vi < 0) throw new Error('boi: unexpected columns for ' + code);
  return rows.slice(1).filter((r) => r.length > vi && r[vi] !== '' && !isNaN(Number(r[vi]))).map((r) => [r[ti], Number(r[vi])]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function nyfedEffr(n = 140) {
  const j = JSON.parse(await getText(`https://markets.newyorkfed.org/api/rates/unsecured/effr/last/${n}.json`));
  const r = j.refRates.map((x) => ({ t: x.effectiveDate, v: x.percentRate, lo: x.targetRateFrom, hi: x.targetRateTo })).sort((a, b) => (a.t < b.t ? -1 : 1));
  return r;
}
async function treasuryYields() {
  const y = new Date().getUTCFullYear(); const out = {};
  for (const yr of [y - 1, y]) {
    const rows = parseCsv(await getText(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`));
    const h = rows[0];
    for (const r of rows.slice(1)) {
      if (!r[0]) continue; const [m, d, yy] = r[0].split('/'); const t = `${yy}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      for (const k of ['3 Mo', '1 Yr', '2 Yr', '10 Yr']) { const v = Number(r[h.indexOf(k)]); if (!isNaN(v) && r[h.indexOf(k)] !== '') (out[k] ||= []).push([t, v]); }
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
async function blsCpiYoy() {   // CPI-U, all items, not seasonally adjusted (index) → year-over-year %
  const y = new Date().getUTCFullYear();
  const j = JSON.parse(await getText(`https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=${y - 2}&endyear=${y}`));
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error('bls: ' + (j.message || []).join(' '));
  const idx = {}; for (const d of j.Results.series[0].data) if (/^M\d\d$/.test(d.period) && d.period !== 'M13') idx[`${d.year}-${d.period.slice(1)}`] = Number(d.value);
  const out = [];
  for (const [k, v] of Object.entries(idx).sort()) { const [yy, mm] = k.split('-'); const prev = idx[`${Number(yy) - 1}-${mm}`]; if (prev) out.push([k, round((v / prev - 1) * 100, 2)]); }
  return out;
}
async function fedBroadDollar(n = 140) {   // Federal Reserve Board H.10: Nominal Broad Dollar Index
  const rows = parseCsv(await getText(`https://www.federalreserve.gov/datadownload/Output.aspx?rel=H10&series=122e3bcb627e8e53f1bf72a1a09cfb81&lastobs=${n}&from=&to=&filetype=csv&label=include&layout=seriescolumn`, { tries: 5, pause: 3000 }));
  return rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[1] && r[1] !== 'ND').map((r) => [r[0], Number(r[1])]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function ecbSeries(path, n) {
  const rows = parseCsv(await getText(`https://data-api.ecb.europa.eu/service/data/${path}?lastNObservations=${n}&format=csvdata`));
  const h = rows[0], ti = h.indexOf('TIME_PERIOD'), vi = h.indexOf('OBS_VALUE');
  return rows.slice(1).filter((r) => r.length > vi && r[vi] !== '').map((r) => [r[ti], Number(r[vi])]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------- series math
const clean = (s) => s.filter(([, v]) => Number.isFinite(v));
const last = (s) => s[s.length - 1];
function atOrBefore(s, t) { let r = null; for (const p of s) { if (p[0] <= t) r = p; else break; } return r; }
const addDays = (t, n) => new Date(new Date(t + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
// change over a window; kind: 'pp' (absolute difference, for rates/levels) or 'pct' (relative %)
function chg(s, freq, back, kind) {
  if (s.length < 2) return null;
  const now = last(s); let ref;
  if (freq === 'D') ref = atOrBefore(s, addDays(now[0], -back));
  else ref = s[s.length - 1 - back];
  if (!ref || ref[0] === now[0]) return null;
  const v = kind === 'pct' ? (now[1] / ref[1] - 1) * 100 : now[1] - ref[1];
  return { v: round(v, 3), from: ref[0], fromValue: round(ref[1], 4) };
}
function mkInd(def, series, extra = {}) {
  const s = clean(series); if (!s.length) throw new Error('no data for ' + def.id);
  const keep = { D: 130, M: 26, Q: 10 }[def.freq];
  const now = last(s);
  const windows = def.windows || (def.freq === 'D' ? [['1W', 7], ['1M', 30], ['3M', 90]] : def.freq === 'M' ? [['1M', 1], ['3M', 3], ['12M', 12]] : [['QoQ', 1], ['YoY', 4]]);
  const changes = {}; for (const [k, b] of windows) { const c = chg(s, def.freq, b, def.changeKind || 'pp'); if (c) changes[k] = c; }
  const age = ageDays(now[0], def.freq);
  return { id: def.id, group: def.group, label: def.label, unit: def.unit, freq: def.freq, decimals: def.decimals ?? 2, source: def.source, note: def.note || '',
    latest: { t: now[0], v: round(now[1], 4) }, prev: s.length > 1 ? { t: s[s.length - 2][0], v: round(s[s.length - 2][1], 4) } : null,
    changeKind: def.changeKind || 'pp', changes, series: s.slice(-keep).map(([t, v]) => [t, round(v, 4)]), ageDays: age, stale: age > FRESH_DAYS[def.freq], ...extra };
}

// ---------------------------------------------------------------- source registry (for transparency on the page)
const SRC = {
  boi: { id: 'boi', name: 'בנק ישראל', url: 'https://www.boi.org.il/en/economic-roles/statistics/' },
  boiCbs: { id: 'boi', name: 'הלמ״ס, כפי שמפורסם במאגר בנק ישראל', url: 'https://www.boi.org.il/en/economic-roles/statistics/' },
  nyfed: { id: 'nyfed', name: 'הפדרל ריזרב של ניו יורק', url: 'https://www.newyorkfed.org/markets/reference-rates/effr' },
  treasury: { id: 'treasury', name: 'משרד האוצר האמריקאי', url: 'https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics' },
  bls: { id: 'bls', name: 'BLS', url: 'https://www.bls.gov/cpi/' },
  fed: { id: 'fed', name: 'מועצת הפדרל ריזרב (H.10)', url: 'https://www.federalreserve.gov/releases/h10/' },
  ecb: { id: 'ecb', name: 'הבנק האירופי (ECB)', url: 'https://data.ecb.europa.eu/' },
};

// ---------------------------------------------------------------- the build
export async function buildPulse({ prev = null, log = () => {} } = {}) {
  const man = readJSON(firstExisting(join(HERE, 'pulse-manual.json')), {});
  const numMan = readJSON(firstExisting(join(HERE, 'numbers-manual.json'), join(HERE, '..', 'numbers-manual.json')), {});
  const ind = {}; const errors = {}; const fetchedAt = new Date().toISOString();
  const jobs = [];
  const add = (id, fn) => jobs.push((async () => { try { ind[id] = await fn(); } catch (e) { errors[id] = String(e.message || e).slice(0, 120); log(`  ✗ ${id}: ${errors[id]}`); } })());

  // ---------- Israel: prices, expectations, rates
  add('cpi_yoy', async () => mkInd({ id: 'cpi_yoy', group: 'prices', label: 'אינפלציה (מדד המחירים לצרכן, שינוי ב-12 חודשים)', unit: '%', freq: 'M', source: SRC.boiCbs, note: 'המדד הכללי' }, await boiSeries('PRI', 'CP_PCHYTY', '2024-06')));
  add('infl_exp_market', async () => mkInd({ id: 'infl_exp_market', group: 'prices', label: 'ציפיות אינפלציה לשנה קדימה, שוק ההון', unit: '%', freq: 'M', source: SRC.boi, note: 'נגזר משוק האג"ח הממשלתי (ממוצע חודשי)' }, await boiSeries('ZCM', 'EXP_EXP_01Y_BI_MA', '2024-06')));
  add('infl_exp_forecasters', async () => mkInd({ id: 'infl_exp_forecasters', group: 'prices', label: 'ציפיות אינפלציה לשנה קדימה, חזאים מקצועיים', unit: '%', freq: 'M', source: SRC.boi, note: 'סקר החזאים המקצועיים של בנק ישראל (ממוצע)' }, await boiSeries('ZCM', 'SPF_FCT_CP_01Y_AVG_MA', '2024-06')));
  add('infl_exp_5y', async () => mkInd({ id: 'infl_exp_5y', group: 'prices', label: 'ציפיות אינפלציה ל-5 שנים, שוק ההון', unit: '%', freq: 'M', source: SRC.boi, note: 'ממוצע חודשי' }, await boiSeries('ZCM', 'EXP_EXB_ZD_5Y_MA', '2024-06')));
  add('infl_target', async () => { const lo = await boiSeries('ZCM', 'INF_MIN_TRGT_D', '2026-01-01'), hi = await boiSeries('ZCM', 'INF_MAX_TRGT_D', '2026-01-01'); return { id: 'infl_target', lo: last(lo)[1], hi: last(hi)[1], asOf: last(lo)[0], source: SRC.boi }; });
  add('boi_rate', async () => {
    const s = clean(await boiSeries('BR', 'MNT_RIB_BOI_D', '2024-06-01'));
    let k = s.length - 1; while (k > 0 && s[k - 1][1] === s[k][1]) k--;           // start of the current level
    const lastChange = k > 0 ? { t: s[k][0], from: s[k - 1][1], to: s[k][1] } : null;
    return mkInd({ id: 'boi_rate', group: 'rates', label: 'ריבית בנק ישראל', unit: '%', freq: 'D', source: SRC.boi, note: 'ריבית המדיניות', windows: [['1M', 30], ['3M', 90], ['12M', 365]] }, s, { lastChange });
  });
  add('il_bill_3m', async () => mkInd({ id: 'il_bill_3m', group: 'rates', label: 'תשואה לפדיון, אג"ח ממשלתי שקלי לא צמוד, 3 חודשים', unit: '%', freq: 'D', source: SRC.boi, note: 'ימי מסחר בלבד' }, (await boiSeries('SECDWH', 'DWH_SRC_0342', '2025-06-01')).filter(([, v]) => v > 0)));
  add('il_bill_12m', async () => mkInd({ id: 'il_bill_12m', group: 'rates', label: 'תשואה לפדיון, אג"ח ממשלתי שקלי לא צמוד, 12 חודשים', unit: '%', freq: 'D', source: SRC.boi, note: 'ימי מסחר בלבד' }, (await boiSeries('SECDWH', 'DWH_SRC_0351', '2025-06-01')).filter(([, v]) => v > 0)));
  for (const [y, code] of [['1', 'ZC_TSB_ZND_01Y_MA'], ['2', 'ZC_TSB_ZND_02Y_MA'], ['5', 'ZC_TSB_ZND_05Y_MA'], ['10', 'ZC_TSB_ZND_10Y_MA']])
    add('curve_' + y + 'y', async () => mkInd({ id: 'curve_' + y + 'y', group: 'rates', label: `עקום תשואות שקלי נומינלי, ${y} שנים`, unit: '%', freq: 'M', source: SRC.boi, note: 'ממוצע חודשי' }, await boiSeries('ZCM', code, '2024-06')));

  // ---------- Israel: activity, labour, external
  add('gdp_yoy', async () => mkInd({ id: 'gdp_yoy', group: 'activity', label: 'צמיחת התוצר, לעומת התקופה המקבילה אשתקד', unit: '%', freq: 'Q', source: SRC.boiCbs, note: 'רבעון מול אותו רבעון אשתקד' }, await boiSeries('NA', 'BI_PCT_GDP_Q_FP', '2023-Q1')));
  add('gdp_qoq', async () => mkInd({ id: 'gdp_qoq', group: 'activity', label: 'צמיחת התוצר, שיעור שנתי (מנוכה עונתיות)', unit: '%', freq: 'Q', source: SRC.boiCbs, note: 'שינוי רבעוני מוצג כקצב שנתי; תנודתי מאוד סביב רבעונים חריגים' }, await boiSeries('NA', 'GDP_Q_FP_SA_ANNPCH', '2023-Q1')));
  add('unemployment', async () => mkInd({ id: 'unemployment', group: 'activity', label: 'שיעור האבטלה (מנוכה עונתיות)', unit: '%', freq: 'M', source: SRC.boiCbs }, await boiSeries('LBM', 'UE_R_M_SA', '2024-06')));
  add('job_openings', async () => mkInd({ id: 'job_openings', group: 'activity', label: 'משרות פנויות (מנוכה עונתיות)', unit: 'משרות', freq: 'M', decimals: 0, changeKind: 'pct', source: SRC.boiCbs }, await boiSeries('LBM', 'LMS_JOB_OPENINGS_TOT_M_SA', '2024-06')));
  add('eai', async () => { const s = await boiSeries('ECON_IND', 'BOI_EAI_M', '2024-06'); const lt = await boiSeries('ECON_IND', 'BOI_EAI_LTAVG_M', '2026-01'); return mkInd({ id: 'eai', group: 'activity', label: 'מדד הפעילות הכלכלית של בנק ישראל (שינוי חודשי)', unit: '%', freq: 'M', source: SRC.boi, note: 'מדד מרכב של אינדיקטורים; מוצג מול הממוצע ארוך הטווח' }, s, { longTermAvg: round(last(lt)[1], 3) }); });
  add('bts', async () => mkInd({ id: 'bts', group: 'activity', label: 'סקר מגמות בעסקים: מאזן נטו משולב, מצב העסקים בהווה (סה"כ המגזר העסקי)', unit: 'נק׳', freq: 'M', decimals: 1, source: SRC.boi }, await boiSeries('BTS_7', 'BTS_921211_M', '2024-06')));
  add('current_account', async () => mkInd({ id: 'current_account', group: 'external', label: 'יתרת החשבון השוטף, % מהתוצר', unit: '%', freq: 'Q', source: SRC.boi, note: 'יתרה חיובית = עודף' }, await boiSeries('BOP', 'BOP_NC1000N3_GDP_R_Q', '2023-Q1')));

  // ---------- FX (Bank of Israel representative rates)
  add('usd_ils', async () => mkInd({ id: 'usd_ils', group: 'fx', label: 'דולר / שקל', unit: '₪', freq: 'D', decimals: 3, changeKind: 'pct', source: SRC.boi, note: 'שער יציג' }, await boiSeries('EXR', 'RER_USD_ILS', '2026-01-01')));
  add('eur_ils', async () => mkInd({ id: 'eur_ils', group: 'fx', label: 'אירו / שקל', unit: '₪', freq: 'D', decimals: 3, changeKind: 'pct', source: SRC.boi, note: 'שער יציג' }, await boiSeries('EXR', 'RER_EUR_ILS', '2026-01-01')));

  // ---------- US / Euro / global
  let effr = null;
  add('fed_rate', async () => {
    effr = await nyfedEffr(260); const s = effr.map((x) => [x.t, x.v]); const l = effr[effr.length - 1];
    return mkInd({ id: 'fed_rate', group: 'global', label: 'ריבית הפדרל ריזרב (Fed Funds אפקטיבית)', unit: '%', freq: 'D', source: SRC.nyfed, note: `טווח היעד: ${l.lo}–${l.hi}%`, windows: [['1M', 30], ['3M', 90]] }, s, { target: [l.lo, l.hi] });
  });
  let ust = null;
  add('ust', async () => { ust = await treasuryYields(); return { id: 'ust', ok: true }; });
  add('us_cpi_yoy', async () => mkInd({ id: 'us_cpi_yoy', group: 'global', label: 'אינפלציה בארה"ב (CPI-U, שינוי ב-12 חודשים)', unit: '%', freq: 'M', source: SRC.bls }, await blsCpiYoy()));
  add('ecb_rate', async () => { const s = await ecbSeries('FM/B.U2.EUR.4F.KR.DFR.LEV', 6); const l = last(s); return { id: 'ecb_rate', group: 'global', label: 'ריבית הפיקדון של ה-ECB', unit: '%', freq: 'D', decimals: 2, source: SRC.ecb, note: 'מוצגים רק מועדי שינוי', latest: { t: l[0], v: l[1] }, prev: s.length > 1 ? { t: s[s.length - 2][0], v: s[s.length - 2][1] } : null, changes: {}, series: s, ageDays: 0, stale: false, sinceChange: true }; });
  add('ea_hicp', async () => mkInd({ id: 'ea_hicp', group: 'global', label: 'אינפלציה באירו (HICP, שינוי ב-12 חודשים)', unit: '%', freq: 'M', source: SRC.ecb }, await ecbSeries('ICP/M.U2.N.000000.4.ANR', 18)));
  add('eur_usd', async () => mkInd({ id: 'eur_usd', group: 'global', label: 'אירו / דולר', unit: '$', freq: 'D', decimals: 4, changeKind: 'pct', source: SRC.ecb, note: 'שער ייחוס של ה-ECB' }, await ecbSeries('EXR/D.USD.EUR.SP00.A', 140)));
  await Promise.all(jobs);
  // The Fed's download server returns an empty body when hit in a burst → fetch it on its own, with a longer back-off
  try { ind.broad_dollar = mkInd({ id: 'broad_dollar', group: 'global', label: 'מדד הדולר הרחב (Nominal Broad Dollar Index)', unit: 'נק׳', freq: 'D', decimals: 2, changeKind: 'pct', source: SRC.fed, note: 'ינואר 1997 = 100' }, await fedBroadDollar(140)); }
  catch (e) { errors.broad_dollar = String(e.message || e).slice(0, 120); log('  ✗ broad_dollar: ' + errors.broad_dollar); }

  // Treasury-derived indicators (need the shared fetch)
  if (ust) {
    for (const [id, k, label] of [['ust_3m', '3 Mo', 'תשואת אג"ח אמריקאי, 3 חודשים'], ['ust_1y', '1 Yr', 'תשואת אג"ח אמריקאי, שנה'], ['ust_2y', '2 Yr', 'תשואת אג"ח אמריקאי, שנתיים'], ['ust_10y', '10 Yr', 'תשואת אג"ח אמריקאי, 10 שנים']])
      if (ust[k]?.length) ind[id] = mkInd({ id, group: 'global', label, unit: '%', freq: 'D', source: SRC.treasury, note: 'עקום תשואות יומי (par)' }, ust[k]);
    delete ind.ust;
  } else delete ind.ust;

  // ---------- carry previous values for sources that failed (the DATA date stays visible → never looks "fresh")
  for (const id of Object.keys(errors)) if (prev?.indicators?.[id]) { ind[id] = { ...prev.indicators[id], carried: true }; }
  for (const id of ['ust_3m', 'ust_1y', 'ust_2y', 'ust_10y']) if (!ind[id] && prev?.indicators?.[id]) ind[id] = { ...prev.indicators[id], carried: true };

  const L = (id) => ind[id]?.latest;
  const V = (id) => ind[id]?.latest?.v;

  // ---------- derived: interest-rate differentials (daily, aligned on dates)
  const diffSeries = (a, b) => { const out = []; for (const [t, v] of a.series) { const w = atOrBefore(b.series, t); if (w && dayDiff(t, w[0]) <= 7) out.push([t, round(v - w[1], 3)]); } return out; };
  if (ind.boi_rate && ind.fed_rate) ind.rate_diff_us = mkInd({ id: 'rate_diff_us', group: 'fx_driver', label: 'פער ריבית: בנק ישראל פחות Fed', unit: 'נק׳ אחוז', freq: 'D', source: { id: 'derived', name: 'חישוב FinPulse מנתוני בנק ישראל ו-NY Fed', url: '' } }, diffSeries(ind.boi_rate, ind.fed_rate));
  if (ind.il_bill_12m && ind.ust_1y) ind.bill_diff_us = mkInd({ id: 'bill_diff_us', group: 'fx_driver', label: 'פער תשואה קצרה: ישראל (12 חודשים) פחות ארה"ב (שנה)', unit: 'נק׳ אחוז', freq: 'D', source: { id: 'derived', name: 'חישוב FinPulse מנתוני בנק ישראל ו-Treasury', url: '' } }, diffSeries(ind.il_bill_12m, ind.ust_1y));
  if (ind.boi_rate && ind.ecb_rate) { const steps = ind.ecb_rate.series; const stepAt = (t) => { let v = null; for (const [d, x] of steps) if (d <= t) v = x; return v; };
    const s = ind.boi_rate.series.map(([t, v]) => [t, stepAt(t)] ).filter(([, e]) => e != null).map(([t, e]) => [t, round(ind.boi_rate.series.find((x) => x[0] === t)[1] - e, 3)]);
    if (s.length) ind.rate_diff_ea = mkInd({ id: 'rate_diff_ea', group: 'fx_driver', label: 'פער ריבית: בנק ישראל פחות ECB', unit: 'נק׳ אחוז', freq: 'D', source: { id: 'derived', name: 'חישוב FinPulse מנתוני בנק ישראל ו-ECB', url: '' } }, s); }
  const monthDiff = (a, b) => { const out = []; for (const [t, v] of a.series) { const w = b.series.find((x) => x[0] === t); if (w) out.push([t, round(v - w[1], 3)]); } return out; };
  if (ind.cpi_yoy && ind.us_cpi_yoy) { const s = monthDiff(ind.cpi_yoy, ind.us_cpi_yoy); if (s.length) ind.infl_diff_us = mkInd({ id: 'infl_diff_us', group: 'fx_driver', label: 'פער אינפלציה: ישראל פחות ארה"ב', unit: 'נק׳ אחוז', freq: 'M', source: { id: 'derived', name: 'חישוב FinPulse מנתוני בנק ישראל ו-BLS', url: '' } }, s); }

  // ---------- theoretical forward (covered interest parity): F = S × (1 + r_ILS·T) / (1 + r_USD·T). NOT a forecast.
  let forward = null;
  if (ind.usd_ils && ind.il_bill_3m && ind.ust_3m && ind.il_bill_12m && ind.ust_1y) {
    const S = V('usd_ils');
    const f = (rIl, rUs, T) => round(S * (1 + (rIl / 100) * T) / (1 + (rUs / 100) * T), 3);
    forward = { spot: S, spotDate: L('usd_ils').t, theoretical3m: f(V('il_bill_3m'), V('ust_3m'), 0.25), theoretical12m: f(V('il_bill_12m'), V('ust_1y'), 1),
      inputs: { il3m: V('il_bill_3m'), us3m: V('ust_3m'), il12m: V('il_bill_12m'), us1y: V('ust_1y') },
      label: 'Forward תיאורטי (נגזר מפערי ריבית, קירוב). לא תחזית שער, לא קונצנזוס ולא ציפיית שוק לשער ה-Spot.' };
  }

  // ---------- forecast vintages + revisions (Bank of Israel staff forecast)
  const sf = man.boiStaffForecast || {};
  const vintages = (sf.vintages || []).slice().sort((a, b) => (a.published < b.published ? -1 : 1));
  const latestV = vintages[vintages.length - 1], priorV = vintages[vintages.length - 2];
  const revisions = latestV ? Object.keys(latestV.values).map((k) => ({ key: k, label: sf.metrics?.[k]?.label || k, now: latestV.values[k], was: priorV?.values?.[k] ?? null, delta: priorV?.values?.[k] != null ? round(latestV.values[k] - priorV.values[k], 2) : null, nowLabel: latestV.label, wasLabel: priorV?.label || null })) : [];

  // ---------- public FX forecasts (curated, with source + date; never a computed "consensus")
  const fxForecasts = (numMan.forecasts || []).map((f) => ({ pair: f.pair, who: f.who, range: f.range, horizon: f.horizon, date: f.date, source: f.source, by: f.by, ageDays: dayDiff(new Date().toISOString().slice(0, 10), f.date), stale: dayDiff(new Date().toISOString().slice(0, 10), f.date) > (f.maxAgeDays || 240) }));

  // ---------- rows: Actual vs Expectation (only where a real, sourced expectation exists)
  const gap = (a, b) => (a != null && b != null ? round(a - b, 2) : null);
  const rows = [];
  if (ind.cpi_yoy) rows.push({ id: 'inflation', title: 'אינפלציה', actual: 'cpi_yoy', trend: ['3M', '12M'],
    target: ind.infl_target ? { lo: ind.infl_target.lo, hi: ind.infl_target.hi } : null,
    expectations: [
      ind.infl_exp_market && { label: 'ציפיית שוק ההון לשנה קדימה', id: 'infl_exp_market', value: V('infl_exp_market'), asOf: L('infl_exp_market').t, freq: 'M', gap: gap(V('cpi_yoy'), V('infl_exp_market')) },
      ind.infl_exp_forecasters && { label: 'חזאים מקצועיים, שנה קדימה', id: 'infl_exp_forecasters', value: V('infl_exp_forecasters'), asOf: L('infl_exp_forecasters').t, freq: 'M', gap: gap(V('cpi_yoy'), V('infl_exp_forecasters')) },
      latestV?.values?.infl2026 != null && { label: `תחזית צוות בנק ישראל לשנת 2026 (${latestV.label})`, value: latestV.values.infl2026, asOf: latestV.published, freq: 'F', gap: null, was: priorV?.values?.infl2026 ?? null },
    ].filter(Boolean) });
  if (ind.boi_rate) rows.push({ id: 'rate', title: 'ריבית', actual: 'boi_rate', trend: ['3M', '12M'], lastChange: ind.boi_rate.lastChange,
    expectations: [
      ind.il_bill_12m && { label: 'תשואת אג"ח ממשלתי ל-12 חודשים (אינדיקציה לתמחור, לא תחזית ריבית)', id: 'il_bill_12m', value: V('il_bill_12m'), asOf: L('il_bill_12m').t, freq: 'D', gap: gap(V('boi_rate'), V('il_bill_12m')) },
      latestV?.snapshot?.rateQ2_2027 && { label: `שוק ההון (SHIR), ממוצע ריבית ברבעון 2 2027, ליום ${latestV.snapshot.asOf}`, value: latestV.snapshot.rateQ2_2027.capitalMarkets, asOf: latestV.snapshot.asOf, freq: 'F', gap: gap(V('boi_rate'), latestV.snapshot.rateQ2_2027.capitalMarkets) },
      latestV?.snapshot?.rateQ2_2027 && { label: `חזאים מקצועיים, אותו אופק, ליום ${latestV.snapshot.asOf} (טווח ${latestV.snapshot.rateQ2_2027.forecastersRange.join('–')})`, value: latestV.snapshot.rateQ2_2027.forecasters, asOf: latestV.snapshot.asOf, freq: 'F', gap: gap(V('boi_rate'), latestV.snapshot.rateQ2_2027.forecasters) },
      latestV?.values?.rateQ2_2027 != null && { label: `תחזית צוות בנק ישראל, אותו אופק (${latestV.label})`, value: latestV.values.rateQ2_2027, asOf: latestV.published, freq: 'F', gap: gap(V('boi_rate'), latestV.values.rateQ2_2027) },
    ].filter(Boolean) });
  if (ind.gdp_yoy) rows.push({ id: 'growth', title: 'צמיחה', actual: 'gdp_yoy', also: ['gdp_qoq'], trend: ['QoQ', 'YoY'],
    expectations: [
      latestV?.values?.gdp2026 != null && { label: `תחזית צוות בנק ישראל לשנת 2026 (${latestV.label})`, value: latestV.values.gdp2026, asOf: latestV.published, freq: 'F', gap: null, was: priorV?.values?.gdp2026 ?? null },
      latestV?.values?.gdp2027 != null && { label: `תחזית צוות בנק ישראל לשנת 2027 (${latestV.label})`, value: latestV.values.gdp2027, asOf: latestV.published, freq: 'F', gap: null, was: priorV?.values?.gdp2027 ?? null },
    ].filter(Boolean) });

  // ---------- rule-based signals ("what's interesting here?") – neutral wording, each ends with a question for Eden
  const signals = [];
  const sig = (id, title, detail, question, ctx) => signals.push({ id, title, detail, question, ctx });
  const f1 = (x) => (x == null ? '—' : Number(x).toFixed(2).replace(/\.?0+$/, ''));
  if (ind.cpi_yoy && ind.infl_target) { const v = V('cpi_yoy'), t = ind.infl_target; if (v < t.lo + 0.3 || v > t.hi - 0.3) sig('infl_band', `האינפלציה (${f1(v)}%) קרובה לגבול של יעד האינפלציה (${t.lo}–${t.hi}%)`, `נתון ${L('cpi_yoy').t}. ציפיית שוק לשנה: ${f1(V('infl_exp_market'))}%, חזאים: ${f1(V('infl_exp_forecasters'))}%.`, 'מה לדעתך משמעות הקרבה לגבול היעד, ואילו הנחות בתקציב נשענות על רמת מחירים או ריבית?', `אינפלציה בישראל ${f1(v)}% (${L('cpi_yoy').t}), יעד ${t.lo}-${t.hi}%. ציפיית שוק לשנה ${f1(V('infl_exp_market'))}%, חזאים ${f1(V('infl_exp_forecasters'))}%.`); }
  if (ind.boi_rate && ind.il_bill_12m) { const g = V('boi_rate') - V('il_bill_12m'); if (Math.abs(g) >= 0.12) sig('rate_vs_bill', `הריבית (${f1(V('boi_rate'))}%) ${g > 0 ? 'גבוהה' : 'נמוכה'} ב-${f1(Math.abs(g))} נק׳ אחוז מתשואת אג"ח ל-12 חודשים (${f1(V('il_bill_12m'))}%)`, 'פער כזה יכול לשקף ציפיות לשינוי ריבית, אבל גם פרמיות סיכון ונזילות.', 'איזו אפשרות נראית לך סבירה, ומה היית בודקת כדי להבדיל ביניהן?', `ריבית בנק ישראל ${f1(V('boi_rate'))}%, תשואה ל-12 חודשים ${f1(V('il_bill_12m'))}% (${L('il_bill_12m').t}). תחזית BoI לריבית ברבעון 2 2027: ${latestV?.values?.rateQ2_2027 ?? '—'}% (${latestV?.label || ''}).`); }
  if (ind.usd_ils && ind.broad_dollar) { const a = ind.usd_ils.changes['1M']?.v, b = ind.broad_dollar.changes['1M']?.v; if (a != null && b != null && Math.sign(a) !== Math.sign(b) && Math.abs(a) >= 0.5 && Math.abs(b) >= 0.3) sig('fx_vs_dollar', `דולר/שקל ${a < 0 ? 'ירד' : 'עלה'} ב-${f1(Math.abs(a))}% בחודש, בעוד מדד הדולר הרחב ${b < 0 ? 'ירד' : 'עלה'} ב-${f1(Math.abs(b))}%`, 'התנועות בכיוונים שונים: הגורמים הישראליים והגלובליים לא מסבירים את אותה תנועה.', 'אילו גורמים ספציפיים לישראל (ריבית, אינפלציה, פעילות, חשבון שוטף, תזרימים) עשויים להסביר את הפער?', `דולר/שקל ${f1(a)}% ב-1M, מדד הדולר הרחב ${f1(b)}% ב-1M, פער ריבית ישראל-ארה"ב ${f1(V('rate_diff_us'))} נק' אחוז.`); }
  if (ind.unemployment) { const c = ind.unemployment.changes['3M']?.v; if (c != null && Math.abs(c) >= 0.3) sig('unemp', `שיעור האבטלה ${c > 0 ? 'עלה' : 'ירד'} ב-${f1(Math.abs(c))} נק׳ אחוז ב-3 חודשים (${f1(V('unemployment'))}%)`, `משרות פנויות: ${Math.round(V('job_openings') || 0).toLocaleString('en-US')} (${L('job_openings')?.t}).`, 'מה זה אומר על זמינות עובדים ועל לחץ שכר בענפים שלנו?', `אבטלה ${f1(V('unemployment'))}% (${L('unemployment').t}), שינוי 3 חודשים ${f1(c)}; משרות פנויות ${Math.round(V('job_openings') || 0)}.`); }
  if (ind.eai && ind.eai.longTermAvg != null) { const v = V('eai'), a = ind.eai.longTermAvg; if (v - a > 0.5 && ind.il_bill_12m && V('boi_rate') - V('il_bill_12m') > 0.1) sig('activity_rates', 'מדד הפעילות מעל הממוצע ארוך הטווח, וגם תשואת 12 חודשים מתחת לריבית', `מדד הפעילות ${f1(v)}% מול ממוצע ארוך טווח ${f1(a)}%; תשואת 12 חודשים ${f1(V('il_bill_12m'))}% מול ריבית ${f1(V('boi_rate'))}%.`, 'האם שני הנתונים מספרים אותו סיפור? מה היית בודקת כדי לדעת?', `מדד פעילות ${f1(v)}% (ממוצע ${f1(a)}%), ריבית ${f1(V('boi_rate'))}%, תשואה 12 חודשים ${f1(V('il_bill_12m'))}%.`); }
  for (const r of revisions) if (r.delta != null && Math.abs(r.delta) >= 0.3 && !String(r.key).startsWith('deficit')) sig('rev_' + r.key, `${r.label}: ${r.wasLabel} ${f1(r.was)}% ← ${r.nowLabel} ${f1(r.now)}%`, 'עדכון תחזית של בנק ישראל.', 'מה שינה את התחזית לדעתך, ואיזו הנחה שלנו הושפעה מכך?', `${r.label}: ${r.was}% ← ${r.now}%`);
  const sigTop = signals.slice(0, 4);

  const out = {
    version: 1, builtAt: fetchedAt, builtBy: 'finpulse-pulse-builder',
    freshnessRule: { D: 'יומי: עד 6 ימים', M: 'חודשי: עד 75 יום', Q: 'רבעוני: עד 150 יום' },
    indicators: ind, rows, fx: { forecasts: fxForecasts, forward, forecastsNote: 'תחזיות שפורסמו בגלוי בלבד, עם שם, אופק, תאריך ומקור. אין קונצנזוס מחושב: אין לנו מקור נתונים אמיתי שמאפשר זאת.' },
    revisions: { source: sf.source || null, vintages: vintages.map((v) => ({ id: v.id, label: v.label, published: v.published, url: v.url, derived: !!v.derived, note: v.note || '', values: v.values })), latest: revisions },
    signals: sigTop,
    cfoQuestions: ['איזו הנחת תקציב הנתון הזה יכול לאתגר: ריבית, מט"ח, אינפלציה, שכר או ביקוש?', 'איפה מנהל כספים היה בודק השפעה: מימון, עלויות, ביקוש, תמחור או חשיפה למט"ח?', 'מה היה צריך לקרות כדי שהתמונה תשתנה, ואיזה נתון היה מאותת על כך מוקדם?', 'מה אנחנו מניחים היום, ומה הנתונים האלה אומרים על ההנחה?'],
    notAvailable: [
      { what: 'מדד ת"א 35', why: 'אין מקור רשמי חינמי ואוטומטי; נתוני הבורסה דורשים רישום ורישיון' },
      { what: 'CDS ישראל ומדדי סיכון (VIX)', why: 'אין מקור רשמי חינמי' },
      { what: 'קונצנזוס FX וסקירות בנק-בנק', why: 'שירות בתשלום (בלומברג). מוצגות רק תחזיות שפורסמו בגלוי' },
      { what: 'הלמ"ס ישירות', why: 'השרת של הלמ"ס מנתק חיבורים ממחשבים בענן וממשרדי החברה (נבדק); הסדרות נלקחות ממאגר בנק ישראל, שמפרסם אותן' },
      { what: 'אינפלציה עדכנית באירו', why: 'המקורות הרשמיים (ECB ו-Eurostat) מחזירים נתון אחרון מדצמבר 2025' },
    ],
    extensions: { leading: [], business: [], note: 'מקום שמור להרחבה: PMI, שכר, השקעות, יבוא ציוד, בנייה ותשתיות, תקציב המדינה, מכרזים, אשראי עסקי, מחירי תשומות, אנרגיה, שילוח' },
    errors,
  };
  return out;
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && /[\\/]build\.mjs$|[\\/]pulse\.mjs$/.test(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
  const outPath = arg('--out') || firstExisting(join(HERE, '..', '.pages', 'data')) && join(HERE, '..', '.pages', 'data', 'pulse.json') || join(HERE, 'pulse.json');
  const maxAge = Number(arg('--max-age') || 0);
  const prev = readJSON(outPath, null);
  if (!process.argv.includes('--force') && maxAge && prev?.builtAt && (Date.now() - new Date(prev.builtAt)) < maxAge * 3600e3) { console.log(`pulse: fresh (${prev.builtAt}), skipping`); process.exit(0); }
  const t0 = Date.now();
  const p = await buildPulse({ prev, log: (s) => console.log(s) });
  const n = Object.keys(p.indicators).length;
  if (n < 10) { console.error('pulse: too few indicators (' + n + '), keeping the previous file'); process.exit(1); }
  mkdirSync(dirname(outPath), { recursive: true });
  const next = JSON.stringify(p);
  const same = prev && JSON.stringify({ ...prev, builtAt: 0 }) === JSON.stringify({ ...p, builtAt: 0 });
  if (!same) writeFileSync(outPath, next, 'utf8');
  console.log(`pulse: ${n} indicators, ${p.rows.length} rows, ${p.signals.length} signals, ${Object.keys(p.errors).length} errors, ${Math.round((Date.now() - t0) / 1000)}s, ${same ? 'no change' : 'written to ' + outPath}`);
}
