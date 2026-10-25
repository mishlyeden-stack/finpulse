// Cloud-judge pilot (from 25.10.2026): who runs the smart news layer (filter → rank → verify) right now –
// the GitHub runner (Eden's own Claude subscription via the official Claude Code CLI) or this PC.
// Shared files, all under <repo>/state/judge/ and public news only:
//   config.json       {enabled, days, hours}           – the switch (rollback = enabled:false)
//   heartbeat.json    {okAt, lastResult, ...}          – written by the cloud after every good run
//   local-claim.json  {since, until}                   – the PC took over (cloud stale); the cloud stays out meanwhile
//   inbox/*.json      items the PC hands to the cloud  – its leftover queue + feeds the cloud cannot reach
//   reds/*.json       🔴 events found in the cloud     – the PC sends the Live mail (mails stay local)
//   candidates.md     the canonical candidate rows    – today.json is built from it; mirrored into the local Daily file
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const OWN_MIN = 75;       // the cloud owns the layer while its last good run is younger than this
export const CLAIM_MIN = 40;     // a local take-over is renewed on every local run (every 15 min)
const load = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

export function pilotState(repo) {
  const dir = join(repo, 'state', 'judge');
  const cfg = load(join(dir, 'config.json'), { enabled: false });
  const hb = load(join(dir, 'heartbeat.json'), {});
  const claim = load(join(dir, 'local-claim.json'), {});
  const okAge = hb.okAt ? (Date.now() - new Date(hb.okAt)) / 60000 : Infinity;
  const enabled = cfg.enabled === true;
  return { dir, cfg, hb, claim, enabled, okAge, cloudOwns: enabled && okAge < OWN_MIN, claimActive: !!claim.until && Date.now() < new Date(claim.until).getTime() };
}

// same working window as the local task (Sun–Thu 06:00–17:00 Israel time) – the move must not create extra Claude work
export function inWindow(cfg, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), h = Number(p.hour);
  const days = cfg.days || [0, 1, 2, 3, 4], [h0, h1] = cfg.hours || [6, 17];
  return days.includes(day) && h >= h0 && h < h1;
}

// "נקלט במהלך היום" (data/today.json) from a candidates file – one implementation for the PC (publish.mjs) and the cloud judge.
// Age and the displayed time come from the publication time (column 16), not from when the item was checked.
const pubOf = (c) => { const v = String(c[15] || '').replace(/[|\s]/g, ''); return /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : null; };
export function buildToday(candFile, mFile) {
  const d = new Date().toLocaleString('sv-SE').slice(0, 10);
  const items = existsSync(candFile) ? readFileSync(candFile, 'utf8').split('\n').filter((l) => { const m = l.match(/^\| (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/); if (!m) return false; const pub = pubOf(l.split(' | ')); return Date.now() - (pub ? new Date(pub) : new Date(m[1] + "T" + m[2])) < 24 * 3600e3; }).map((l) => {
    const c = l.split(' | ').map((x) => x.replace(/^\|\s*|\s*\|$/g, '').trim());
    const pub = pubOf(c); const pl = pub ? new Date(pub).toLocaleString('sv-SE').slice(0, 16) : c[0];
    return { time: (pl.slice(0, 10) === d ? "" : "אתמול ") + pl.slice(11), ts: c[0], pub: pub || '', level: c[1], title: c[3], what: c[4], why: c[5], who: c[6], link: c[7], source: c[8], topic: c[9] || '', verified: (c[10] || '').includes('✓'), category: (c[11] || '').trim(), impact: Number(c[12]) || 0, question: (c[13] || '').trim(), score: Number(c[14]) || 0 };
  }).filter((i) => i.verified).reverse() : [];
  // display limit: the site shows the best 40 (impact, then score); weaker ones move to the archive, so a better item can replace them
  [...items].sort((x, y) => ((y.impact || 0) * 100 + (y.score || 0)) - ((x.impact || 0) * 100 + (x.score || 0))).slice(40).forEach((i) => { i.archive = true; });
  const rows = existsSync(mFile) ? readFileSync(mFile, 'utf8').split('\n').filter((l) => l.startsWith(d)).map((l) => l.split(',')) : [];
  const sum = (i) => rows.reduce((a, r) => a + (Number(r[i]) || 0), 0);
  const stats = rows.length ? { runs: rows.length, feeds: rows.at(-1)[1], newItems: sum(3), judged: sum(5), red: sum(6), yellow: sum(7), learn: sum(8), noise: sum(9), live: sum(10), waiting: rows.at(-1)[4], last: rows.at(-1)[0].slice(11) } : null;
  return { date: d, items, stats };
}
