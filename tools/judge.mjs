// Radar Eden – RSS-first Live (no dependencies)
// Every 15 min (Task Scheduler): fetch feeds locally (no Claude) → technical dedup → queue.
// Every ~30 min, if the queue has items: ONE batched Claude call classifies 🔴/🟡/🧠/⚪.
// 🔴 → Live mail now. 🟡/🧠 → candidates for the next Daily. Event-level dedup across channels.
// Public Radar: reads only public feeds; Claude runs with no tools.

import { spawn, execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pilotState, inWindow, buildToday, CLAIM_MIN } from './pilot.mjs';

// Corporate network (SSL inspection): Node must trust the company CA. Relaunch once with it if missing.
const CERTS = join(process.env.USERPROFILE || '', '.radar-certs');
const CA = existsSync(CERTS) ? (readdirSync(CERTS).filter((f) => f.endsWith('.pem')).sort().map((f) => join(CERTS, f))[0] || '') : '';
if (!process.env.NODE_EXTRA_CA_CERTS && existsSync(CA)) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, process.argv.slice(1), { env: { ...process.env, NODE_EXTRA_CA_CERTS: CA }, stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 0);
}

// Cloud-judge pilot (see pilot.mjs): the same file runs in GitHub Actions with RADAR_CLOUD=1 (repo checkout = cwd, public news only).
// On the PC it then runs as 'sync' (the cloud owns the layer) or 'fallback' (the cloud is stale → the PC takes over, as before).
const CLOUD = process.env.RADAR_CLOUD === '1';
const RSS = dirname(fileURLToPath(import.meta.url));
const RADAR = join(RSS, '..');
const REPO = CLOUD ? process.cwd() : join(RADAR, 'web', '.pages');
const STATE = CLOUD ? join(REPO, 'state', 'judge') : join(RSS, 'state');
const REPORTS = join(RADAR, 'דוחות');
const LIVE_DIR = CLOUD ? join(tmpdir(), 'radar-live') : join(REPORTS, 'live');
const DRY = process.env.RADAR_DRYRUN === '1';        // test mode: no mail, writes only under rss/state/dry
const DRYDIR = join(RSS, 'state', 'dry');
if (DRY) mkdirSync(DRYDIR, { recursive: true });
const CANDIDATES = DRY ? join(DRYDIR, 'candidates.md') : CLOUD ? join(STATE, 'candidates.md') : join(REPORTS, 'מועמדים ל-Daily.md');
const SENT = join(REPORTS, 'נשלחו.md');
const RUNLOG = DRY ? join(DRYDIR, 'run.log') : join(RADAR, 'run.log');
const METRICS = join(STATE, 'metrics.csv');
const CLAUDE_EXE = CLOUD ? 'claude' : join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const SANDBOX = CLOUD ? join(tmpdir(), 'radar-sandbox') : join(RSS, '.sandbox');
const JUDGE_EVERY_MIN = 28;          // judge at most ~every 30 min
const MAX_BATCH = 60;
const DAILY_CAP = 40;             // Pareto: max verified items per day in 'נקלט היום'
const FRESH_H = 24;                  // a news item older than this (by its own publication time) is not shown as news
const MAX_AGE_H = 36;                // technical filter: ignore stale items
[STATE, LIVE_DIR, SANDBOX].forEach((d) => mkdirSync(d, { recursive: true }));

const now = new Date();
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 16);
const log = (s) => (CLOUD ? console.log(`[${stamp()}] judge: ${s}`) : appendFileSync(RUNLOG, `[${stamp()}] rss: ${s}\n`, 'utf8'));   // cloud: counts only, never prompts or answers
const loadJSON = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, v) => writeFileSync(f, JSON.stringify(v, null, 1), 'utf8');
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
// pilot measurements (counts and tokens only)
const USAGE = { calls: 0, in: 0, out: 0, cacheR: 0, cacheW: 0, usd: 0, timeouts: 0 };
const HOSTS = {};                                                   // article host → reachable / blocked
const RESULTS = {};                                                 // verified / not_supported / article_blocked / ...

// ---------- lock (avoid overlapping runs) ----------
const LOCK = join(CLOUD ? SANDBOX : STATE, 'lock');
if (existsSync(LOCK) && Date.now() - Number(readFileSync(LOCK, 'utf8') || 0) < 45 * 60000) process.exit(0);
writeFileSync(LOCK, String(Date.now()));
process.on('exit', () => { try { writeFileSync(LOCK, '0'); } catch {} });

// ---------- fetch + parse ----------
const feeds = loadJSON(join(RSS, 'feeds.json'), []);
const UA = { 'User-Agent': 'RadarEden/0.2 (personal research)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' };
const txt = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1];
const normTitle = (t) => t.toLowerCase().replace(/\s[-–|]\s[^-–|]{2,40}$/, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

async function fetchFeed(f) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(f.url, { headers: UA, signal: ctl.signal });
    const x = await r.text();
    const blocks = x.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
    return blocks.map((b) => {
      const link = txt(tag(b, 'link')) || (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const d = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
      const date = d ? new Date(txt(d)) : null;
      return { source: f.name, group: f.group, title: txt(tag(b, 'title')), link, summary: txt(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 280), date: date && !isNaN(date) ? date.toISOString() : null };
    }).filter((i) => i.title && i.link).slice(0, f.maxPerBatch || 100);
  } catch { return null; } finally { clearTimeout(to); }
}

const seen = loadJSON(join(STATE, 'seen.json'), {});            // linkHash/titleHash -> first seen ms
const queue = loadJSON(join(STATE, 'queue.json'), []);
const events = loadJSON(join(STATE, 'events.json'), []);         // {key, level, first, sentLive, candidate}
const meta = loadJSON(join(STATE, 'meta.json'), { lastJudge: 0, bootstrapped: false });

// ---------- 24/7 cloud queue (GitHub Actions collects while the PC is off; see web/cloud/collect.mjs) ----------
// The cloud writes queue/<stamp>.json (immutable). We import every batch not yet in state/batches.json, mark it there
// (never delete right away – cleanup after 7 days), and fetch locally only what the cloud could not (or everything if the cloud is stale).
const PAGES = REPO;
const gitP = (...a) => execFileSync('git', a, { cwd: PAGES, stdio: 'pipe', windowsHide: true, timeout: 60000 }).toString();
const BATCHES = join(PAGES, 'state', 'batches.json');
const batches = loadJSON(BATCHES, {});
const cloud = { ok: false, files: 0, items: 0, failedFeeds: [] };
const incoming = [];
let MODE = CLOUD ? 'cloud' : 'local', pilot = null;              // local = pilot off (unchanged behaviour)
if (!DRY && existsSync(join(PAGES, '.git'))) {
  if (!CLOUD) try { gitP('pull', '--rebase', '--autostash', '-q', 'origin', 'main'); } catch (e) { log('cloud pull failed: ' + String(e.message).slice(0, 60)); }
  pilot = pilotState(PAGES);
  if (!CLOUD && pilot.enabled) MODE = pilot.cloudOwns ? 'sync' : 'fallback';
  const lastCollect = (existsSync(join(PAGES, 'logs', 'collect.csv')) ? readFileSync(join(PAGES, 'logs', 'collect.csv'), 'utf8').trim().split('\n').at(-1) : '').split(',')[0];
  cloud.ok = /^\d{4}-/.test(lastCollect) && Date.now() - new Date(lastCollect + 'Z') < 45 * 60000;
  if (cloud.ok) cloud.failedFeeds = loadJSON(join(PAGES, 'state', 'feed-status.json'), { failed: [] }).failed || [];
  // pending batches are ALWAYS imported, even when the collector looks stale (only the choice of local feeds depends on that):
  // nothing the cloud already collected may be lost just because its latest run was a while ago
  // sync: the cloud judge imports the batches – the PC must not touch them (each item is processed once)
  const files = MODE !== 'sync' && existsSync(join(PAGES, 'queue')) ? readdirSync(join(PAGES, 'queue')).filter((f) => f.endsWith('.json') && !batches[f]).sort() : [];
  for (const f of files) {
    const b = loadJSON(join(PAGES, 'queue', f), null); if (!b) continue;
    incoming.push(...b.items.map((i) => ({ ...i, fromCloud: f })));
    cloud.files++; cloud.items += b.items.length;
  }
}
// ---------- cloud-judge pilot: gates and hand-overs ----------
if (CLOUD) {
  if (!pilot?.enabled) { log('pilot is off'); process.exit(0); }
  if (pilot.claimActive) {      // the PC took over: stay out of the queue, only show (one tiny call) that the cloud works again
    try { await runClaude('Reply with the single word ok.', 'ok'); beat({ okAt: new Date().toISOString(), lastResult: 'probe-ok', lastError: '' }); log('PC owns the layer; probe ok'); }
    catch (e) { beat({ lastResult: 'probe-failed', lastError: String(e.message).slice(0, 80) }); log('PC owns the layer; probe failed'); }
    saveUsage('probe', null); process.exit(0);
  }
  takeInbox();                  // what the PC handed over: its leftover queue + items from feeds the cloud cannot reach
}
if (MODE === 'fallback') {     // the cloud is stale: the PC takes over, exactly as before the pilot, and tells the cloud to stay out
  mkdirSync(pilot.dir, { recursive: true });
  saveJSON(join(pilot.dir, 'local-claim.json'), { since: pilot.claim.since && pilot.claimActive ? pilot.claim.since : new Date().toISOString(), until: new Date(Date.now() + CLAIM_MIN * 60000).toISOString() });
  takeInbox();
  const cq = loadJSON(join(pilot.dir, 'queue.json'), []);
  if (cq.length) { const have = new Set(queue.map((i) => i.id)); queue.push(...cq.filter((i) => !have.has(i.id))); saveJSON(join(STATE, 'queue.json'), queue); saveJSON(join(pilot.dir, 'queue.json'), []); log(`take-over: ${cq.length} items from the cloud queue`); }
  for (const e of loadJSON(join(pilot.dir, 'events.json'), [])) if (!events.find((x) => x.key === e.key)) events.push(e);
}
function takeInbox() {          // inbox items were already checked for duplicates where they came from → straight into the queue
  const dir = join(pilot.dir, 'inbox'); if (!existsSync(dir)) return;
  const have = new Set(queue.map((i) => i.id)); let n = 0;
  const files = readdirSync(dir).filter((x) => x.endsWith('.json'));
  for (const f of files) for (const it of loadJSON(join(dir, f), { items: [] }).items || []) if (it.id && !have.has(it.id)) { queue.push(it); have.add(it.id); n++; }
  saveJSON(join(STATE, 'queue.json'), queue);                          // safe in the queue first, only then remove the inbox files
  for (const f of files) try { unlinkSync(join(dir, f)); } catch {}
  if (n) log(`inbox: ${n} items`);
}

const localFeeds = CLOUD ? [] : cloud.ok ? feeds.filter((f) => cloud.failedFeeds.includes(f.name)) : feeds;   // fallback: cloud stale → fetch everything here (the cloud judge fetches nothing)
const results = await Promise.all(localFeeds.map(fetchFeed));
let fetched = cloud.items, fresh = 0, failed = 0, already = 0, alreadyCloud = 0;
const newPerBatch = {};
const take = (it, maxAgeH) => {
  const hl = hash(it.link), ht = hash(normTitle(it.title));
  if (seen[hl] || seen[ht]) { already++; if (it.fromCloud) alreadyCloud++; return; }
  seen[hl] = seen[ht] = Date.now();
  if (it.date && Date.now() - new Date(it.date) > maxAgeH * 3600e3) return;   // stale
  if (/sponsored|ממומן|תוכן שיווקי/i.test(it.title)) return;
  if (meta.bootstrapped) { queue.push({ ...it, id: hl }); fresh++; if (it.fromCloud) newPerBatch[it.fromCloud] = (newPerBatch[it.fromCloud] || 0) + 1; }
};
for (const it of incoming) take(it, 72);           // cloud backlog (e.g. after a weekend): keep up to 72h
for (let k = 0; k < localFeeds.length; k++) {
  const items = results[k];
  if (!items) { failed++; continue; }
  fetched += items.length;
  for (const it of items) take(it, MAX_AGE_H);
}
for (const [k, v] of Object.entries(seen)) if (Date.now() - v > 7 * 864e5) delete seen[k];   // prune 7 days
saveJSON(join(STATE, 'seen.json'), seen);

if (MODE === 'sync') {         // the cloud owns the layer: hand over, mirror its results for the Daily, send its 🔴 mails, publish
  if (queue.length) {
    const dir = join(pilot.dir, 'inbox'); mkdirSync(dir, { recursive: true });
    saveJSON(join(dir, `pc-${Date.now()}.json`), { at: new Date().toISOString(), items: queue.map(({ fromCloud, ...i }) => i) });
    log(`sync: ${queue.length} items handed to the cloud judge`); queue.length = 0;
  }
  saveJSON(join(STATE, 'queue.json'), queue);
  try { unlinkSync(join(pilot.dir, 'local-claim.json')); } catch {}
  mirrorCandidates(); sendCloudReds();
  try { const so = execFileSync(process.execPath, [join(RADAR, 'web', 'publish.mjs')], { windowsHide: true, timeout: 300000 }).toString(); if (/published/.test(so)) log('sync: phone page published'); } catch (e) { log('publish FAILED: ' + String(e.message).slice(0, 80)); }
  process.exit(0);
}

if (!meta.bootstrapped) {      // first run: learn what already exists, judge nothing
  meta.bootstrapped = true; saveJSON(join(STATE, 'meta.json'), meta); saveJSON(join(STATE, 'queue.json'), []);
  log(`bootstrap: ${fetched} existing items marked as seen (${feeds.length - failed}/${feeds.length} feeds ok)`);
  process.exit(0);
}
// what looks new must be new: drop items published more than 24h ago (they stay in seen.json, so they never come back),
// and judge the newest first. Undated items count as just published.
const pubMs = (it) => (it.date ? new Date(it.date).getTime() : Date.now());
const staleOut = (q) => { const n = q.length; const keep = q.filter((it) => Date.now() - pubMs(it) <= FRESH_H * 3600e3); m0.stale += n - keep.length; return keep; };
const m0 = { stale: 0 };
queue.splice(0, queue.length, ...staleOut(queue).sort((a, b) => pubMs(b) - pubMs(a)));
saveJSON(join(STATE, 'queue.json'), queue);
// items are now safe in the local queue → mark the cloud batches as imported (files stay for 7 days for review)
for (let k = 0; k < incoming.length; k++) { const f = incoming[k].fromCloud; if (!batches[f]) batches[f] = { imported: stamp(), items: incoming.filter((i) => i.fromCloud === f).length, new: newPerBatch[f] || 0 }; }
if (!DRY && existsSync(join(PAGES, 'queue'))) {
  mkdirSync(join(PAGES, 'state'), { recursive: true });
  for (const [f, b] of Object.entries(batches)) if (Date.now() - new Date(b.imported.replace(' ', 'T')) > 7 * 864e5) {   // periodic cleanup
    try { unlinkSync(join(PAGES, 'queue', f)); } catch {}
    if (Date.now() - new Date(b.imported.replace(' ', 'T')) > 14 * 864e5) delete batches[f];
  }
  saveJSON(BATCHES, batches);
  if (MODE === 'fallback') try {
    gitP('add', 'state/batches.json', 'state/judge');
    if (gitP('status', '--porcelain', 'state').trim()) { gitP('-c', 'user.name=Radar Eden', '-c', 'user.email=radar@localhost', 'commit', '-qm', 'pc take-over'); gitP('pull', '--rebase', '--autostash', '-q', 'origin', 'main'); gitP('push', '-q', 'origin', 'HEAD'); }
  } catch (e) { log('take-over push failed: ' + String(e.message).slice(0, 60)); }
}
if (CLOUD && !inWindow(pilot.cfg) && process.env.RADAR_FORCE !== '1') {   // RADAR_FORCE: a manual test run (workflow_dispatch)
   // same working hours as the PC task (no extra Claude work); items wait, newest first
  saveJSON(join(STATE, 'queue.json'), queue); saveJSON(join(STATE, 'meta.json'), meta);
  finishCloud('idle'); process.exit(0);
}

// ---------- judge (batched; a backlog is worked through in several rounds, up to ~20 min per run) ----------
const minutesSinceJudge = (Date.now() - meta.lastJudge) / 60000;
let m = { unverified: 0, toClaude: 0, red: 0, yellow: 0, learn: 0, noise: 0, live: 0, cand: 0, secs: 0, err: '', rounds: 0, dropped: 0 };
const VERDICTS = join(PAGES, 'data', 'verdicts.json');            // per raw item: ok / noise / drop (for "📡 עכשיו בחדשות")
const verdicts = loadJSON(VERDICTS, {});
const START = Date.now();
for (let round = 0; queue.length && (round === 0 ? (minutesSinceJudge >= JUDGE_EVERY_MIN || queue.length > 100) : Date.now() - START < (CLOUD ? 12 : 20) * 60000); round++) {
  queue.splice(0, queue.length, ...staleOut(queue));                   // a long run: items can age past 24h while waiting
  if (!queue.length) break;
  const batch = queue.splice(0, MAX_BATCH);
  m.toClaude += batch.length; m.rounds++;
  const known = events.filter((e) => Date.now() - e.first < 4 * 864e5).map((e) => e.key);
  const sentRows = existsSync(SENT) ? readFileSync(SENT, 'utf8').split('\n').filter((l) => l.startsWith('| S-')).slice(-60).map((l) => l.split('|')[2]?.trim()).filter(Boolean) : [];
  const input = `אירועים ידועים שכבר טופלו (event keys):\n${[...new Set([...known, ...sentRows])].map((k) => '- ' + k).join('\n') || '(אין)'}\n\n` +
    `פריטים חדשים (${batch.length}):\n` + batch.map((it, i) => `[${i}] (${it.source}${it.date ? ', ' + new Date(it.date).toLocaleString('sv-SE').slice(0, 16) + ' (שעון ישראל)' : ''}) ${it.title}${it.summary ? ' — ' + it.summary : ''}\n    ${it.link}`).join('\n');
  const t0 = Date.now();
  try {
    const out = await runClaude(readFileSync(join(RSS, 'judge-prompt.txt'), 'utf8'), input);
    m.secs += Math.round((Date.now() - t0) / 1000);
    const evs = parseArr(out);
    const flagged = new Set(evs.flatMap((e) => e.items || []));
    m.noise += batch.length - flagged.size;
    const vid = (i) => batch[i]?.id || (batch[i] ? hash(batch[i].link) : null);
    batch.forEach((_, i) => { if (!flagged.has(i)) verdicts[vid(i)] = { s: 'noise', t: Date.now() }; });
    // backlog older than 24h: only the stronger items go on to verification
    const isOld = (e) => (e.items || []).length && (e.items || []).every((i) => batch[i]?.date && Date.now() - new Date(batch[i].date) > 24 * 3600e3);
    const reds = [];
    // ---- verification: open the real article and check every item against it (nothing unverified gets through) ----
    // DAILY_CAP is a DISPLAY limit (site shows the best 40 of the last 24h). When it is full, a new event is verified
    // only if it ranks above the weakest one shown – then it can replace it (the weaker one moves to the archive). 🔴 always passes.
    const floor = displayFloor();
    const reason = {};                                                 // event_key -> why it stopped (week-1 funnel)
    const keep = evs.filter((e) => ['red', 'yellow', 'learn'].includes(e.level))
      .filter((e) => { const ex = events.find((x) => x.key === e.event_key); if (ex && !e.development) reason[e.event_key] = 'known_event'; return !ex || e.development; })
      .sort((a, b) => (b.level === 'red') - (a.level === 'red') || (b.score || 0) - (a.score || 0))
      .filter((e) => { const ok = e.level === 'red' || (e.score || 0) >= (isOld(e) ? 6 : 4); if (!ok) reason[e.event_key] = isOld(e) ? 'low_score_old' : 'low_score'; return ok; })
      .filter((e) => { const ok = e.level === 'red' || rankOf(e) > floor; if (!ok) reason[e.event_key] = 'below_display_floor'; return ok; });
    const verified = await verifyEvents(keep, reason);
    funnel({ type: 'judge', round: m.rounds, items: batch.length, chars: input.length, flagged: evs.length, noise: batch.length - flagged.size });
    const okSet = new Set(verified.map((e) => e.event_key));
    for (const e of evs) funnel({ type: 'event', round: m.rounds, key: e.event_key, level: e.level, score: e.score, impact: e.impact, sent: keep.includes(e) ? 1 : 0,
      result: okSet.has(e.event_key) ? 'verified' : (reason[e.event_key] || 'other'), chars: e._chars || 0, title: e.title });
    for (const e of evs) { const r = okSet.has(e.event_key) ? 'verified' : (reason[e.event_key] || 'other'); RESULTS[r] = (RESULTS[r] || 0) + 1; }
    m.unverified += keep.length - verified.length;
    const okKeys = new Set(verified.map((e) => e.event_key));
    for (const e of evs) for (const i of e.items || []) verdicts[vid(i)] = { s: okKeys.has(e.event_key) ? 'ok' : 'drop', t: Date.now() };
    // A/B dataset (local, kept): every item Claude saw + Claude's decision on it, so a future classifier can be tested on the same items
    if (!DRY && !CLOUD) { const evOf = {}; evs.forEach((e) => (e.items || []).forEach((i) => { evOf[i] = e; }));
      appendFileSync(join(STATE, 'dataset.jsonl'), batch.map((it, i) => { const e = evOf[i];
        return JSON.stringify({ t: stamp(), id: vid(i), source: it.source, group: it.group, date: it.date, title: it.title, summary: it.summary, link: it.link,
          claude: e ? { level: e.level, score: e.score, impact: e.impact, category: e.category, event_key: e.event_key, result: okKeys.has(e.event_key) ? 'verified' : (reason[e.event_key] || 'other') } : { level: 'noise' } }); }).join('\n') + '\n', 'utf8'); }
    m.dropped += evs.length - verified.length;
    for (const e of verified) {
      const ds = (e.items || []).map((i) => batch[i]?.date).filter(Boolean).map((x) => new Date(x).getTime()).filter(Number.isFinite);
      e.pub = ds.length ? new Date(Math.max(...ds)).toISOString() : '';
      m[e.level]++;
      const existing = events.find((x) => x.key === e.event_key);
      if (existing && !e.development) continue;                       // event-level dedup
      if (!existing) events.push({ key: e.event_key, level: e.level, first: Date.now(), sentLive: false, candidate: false });
      const ev = events.find((x) => x.key === e.event_key);
      if (e.level === 'red') { reds.push(e); ev.sentLive = true; }
      else { appendCandidate(e); ev.candidate = true; m.cand++; }
    }
    if (reds.length) { sendLive(reds); m.live += reds.length; }
    meta.lastJudge = Date.now();
  } catch (err) {
    queue.unshift(...batch);                                          // retry next time
    m.err = String(err.message || err).slice(0, 80);
    saveJSON(join(STATE, 'queue.json'), queue);
    break;
  }
  saveJSON(join(STATE, 'queue.json'), queue);
  saveJSON(join(STATE, 'events.json'), events.filter((e) => Date.now() - e.first < 14 * 864e5));
  if (MODE === 'fallback') saveJSON(join(pilot.dir, 'events.json'), events.filter((e) => Date.now() - e.first < 14 * 864e5));
  saveJSON(join(STATE, 'meta.json'), meta);
}

// verdicts for the site (last 3 days only)
if (!DRY && existsSync(join(PAGES, 'data'))) { for (const [k, v] of Object.entries(verdicts)) if (!k || k === 'null' || Date.now() - v.t > 3 * 864e5) delete verdicts[k]; saveJSON(VERDICTS, verdicts); }

// ---------- week-1 log in the public repo (counts only): what came from the cloud, what waited, what Claude did ----------
if (!DRY && existsSync(join(PAGES, '.git')) && (cloud.files || m.toClaude || m.err || !cloud.ok)) {
  const PLOG = join(PAGES, 'logs', 'process.csv');
  mkdirSync(join(PAGES, 'logs'), { recursive: true });
  if (!existsSync(PLOG)) writeFileSync(PLOG, 'time_local,source,cloud_batches,cloud_items,already_seen,new_to_queue,claude_rounds,to_claude,red,yellow,learn,noise,dropped,published,queue_left,claude_secs,error,local_items,seen_from_cloud,seen_from_local\n', 'utf8');
  appendFileSync(PLOG, [stamp(), CLOUD ? 'cloud-judge' : MODE === 'fallback' ? 'pc-takeover' : cloud.ok ? 'cloud' : 'local-fallback', cloud.files, cloud.items, already, fresh, m.rounds, m.toClaude, m.red, m.yellow, m.learn, m.noise, m.dropped, m.cand + m.live, queue.length, m.secs, m.err.replace(/,/g, ';'), fetched - cloud.items, alreadyCloud, already - alreadyCloud].join(',') + '\n', 'utf8');
}

// ---------- metrics (week-1 review) ----------
if (!existsSync(METRICS)) writeFileSync(METRICS, 'time,feeds_ok,fetched,new_items,queue_left,to_claude,red,yellow,learn,noise,live_sent,candidates,judge_secs,error\n', 'utf8');
appendFileSync(METRICS, [stamp(), feeds.length - failed, fetched, fresh, queue.length, m.toClaude, m.red, m.yellow, m.learn, m.noise, m.live, m.cand, m.secs, m.err.replace(/,/g, ';')].join(',') + '\n', 'utf8');
if (m.toClaude || m.err) log(`new=${fresh} to_claude=${m.toClaude} 🔴${m.red} 🟡${m.yellow} 🧠${m.learn} ⚪${m.noise} live=${m.live} candidates=${m.cand} dropped_unverified=${m.unverified} (${m.secs}s)${m.err ? ' ERROR ' + m.err : ''}`);

if (CLOUD) { saveUsage('judge', m); finishCloud(m.err ? 'error' : 'ok', m.err); }

// ---------- cloud-judge pilot helpers ----------
function beat(patch) { const f = join(STATE, 'heartbeat.json'); saveJSON(f, { ...loadJSON(f, {}), ...patch, at: new Date().toISOString() }); }
function finishCloud(result, err = '') {   // heartbeat + the site's news layer (same builder as publish.mjs)
  const hb = loadJSON(join(STATE, 'heartbeat.json'), {});
  const good = result === 'ok' || (result === 'idle' && ['ok', 'idle', 'probe-ok'].includes(hb.lastResult));
  beat({ okAt: good ? new Date().toISOString() : hb.okAt, lastResult: result === 'idle' && !good ? hb.lastResult : result, lastError: result === 'error' ? String(err).slice(0, 80) : '', queue: queue.length });
  mkdirSync(join(PAGES, 'data'), { recursive: true });
  writeFileSync(join(PAGES, 'data', 'today.json'), JSON.stringify(buildToday(CANDIDATES, METRICS)), 'utf8');
  const rd = join(STATE, 'reds'); if (existsSync(rd)) for (const f of readdirSync(rd)) if (Date.now() - Number(f.split('.')[0]) > 2 * 864e5) try { unlinkSync(join(rd, f)); } catch {}
}
function saveUsage(kind, m) {               // what the pilot measures (counts and tokens only)
  const F = join(STATE, 'usage.csv');
  if (!existsSync(F)) writeFileSync(F, 'time,kind,claude_calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_equiv_usd_not_billed,timeouts,claude_secs,to_claude,verified,not_supported,article_blocked,source_unreachable,no_answer,other_dropped,queue_left,run_secs,error\n', 'utf8');
  const R = RESULTS, k = ['verified', 'not_supported', 'article_blocked', 'source_unreachable', 'no_answer'];
  const other = Object.entries(R).filter(([x]) => !k.includes(x)).reduce((a, [, v]) => a + v, 0);
  appendFileSync(F, [stamp(), kind, USAGE.calls, USAGE.in, USAGE.out, USAGE.cacheR, USAGE.cacheW, USAGE.usd.toFixed(4), USAGE.timeouts, m?.secs || 0, m?.toClaude || 0, ...k.map((x) => R[x] || 0), other, queue.length, Math.round((Date.now() - now) / 1000), String(m?.err || '').replace(/,/g, ';')].join(',') + '\n', 'utf8');
  const B = join(STATE, 'blocked.json'); const b = loadJSON(B, {});
  for (const [h, v] of Object.entries(HOSTS)) { b[h] = b[h] || { ok: 0, blocked: 0 }; b[h].ok += v.ok; b[h].blocked += v.blocked; }
  saveJSON(B, b);
}
function mirrorCandidates() {           // the Daily (local) reads the local candidates file → append the cloud rows it does not have yet
  const src = join(pilot.dir, 'candidates.md'); if (!existsSync(src)) return;
  const have = new Set(existsSync(CANDIDATES) ? readFileSync(CANDIDATES, 'utf8').split('\n') : []);
  const add = readFileSync(src, 'utf8').split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/.test(l) && !have.has(l));
  if (add.length) { appendFileSync(CANDIDATES, add.join('\n') + '\n', 'utf8'); log(`sync: ${add.length} candidates from the cloud`); }
}
function sendCloudReds() {              // 🔴 found in the cloud → Live mail from the PC (mails stay local); older than 6h → not sent
  const dir = join(pilot.dir, 'reds'); if (!existsSync(dir)) return;
  const REG = join(STATE, 'reds-sent.json'); const reg = loadJSON(REG, {});
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && !reg[x])) {
    const r = loadJSON(join(dir, f), null); reg[f] = Date.now();
    if (r?.events?.length && Date.now() - Number(f.split('.')[0]) < 6 * 3600e3) sendLive(r.events);
  }
  for (const [k, v] of Object.entries(reg)) if (Date.now() - v > 7 * 864e5) delete reg[k];
  saveJSON(REG, reg);
}

// ---------- verification helpers ----------
async function decodeGN(url) {   // Google News RSS link → real publisher URL
  const id = new URL(url).pathname.split('/').pop();
  const page = await (await fetch(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1], ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error('gn sig');
  const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]), null, 'generic']]];
  const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' }, body: 'f.req=' + encodeURIComponent(JSON.stringify(req)) });
  const m = (await r.text()).match(/\\"garturlres\\",\\"(.*?)\\"/);
  if (!m) throw new Error('gn decode');
  return m[1].replace(/\\\\u003d/g, '=').replace(/\\\\u0026/g, '&');
}
async function articleText(url) {   // fetch the article and extract readable text locally (no Claude)
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'he,en;q=0.8' }, signal: ctl.signal });
    if (!r.ok) return '';
    let h = await r.text();
    h = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ');
    const art = h.match(/<article[\s\S]*?<\/article>/i)?.[0] || h;
    const paras = (art.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(txt).filter((p) => p.length > 40);
    return (paras.length ? paras.join('\n') : txt(art)).slice(0, 3500);
  } catch { return ''; } finally { clearTimeout(to); }
}
async function verifyEvents(evs, reason = {}) {
  if (!evs.length) return [];
  const prepared = [];
  for (const e of evs) {
    let link = e.link || '';
    try { if (/news\.google\.com/.test(link)) link = await decodeGN(link); } catch { reason[e.event_key] = 'source_unreachable'; hostCount('news.google.com', false); continue; }   // can't reach the source → not verified
    const text = await articleText(link);
    if (text.length < 400) { reason[e.event_key] = 'article_blocked'; hostCount(link, false); continue; }   // paywall / blocked → not verified (never bypassed)
    hostCount(link, true);
    e._chars = text.length;
    reason[e.event_key] = 'not_supported';                            // overwritten below if the article supports it
    prepared.push({ e: { ...e, link }, text });
  }
  if (!prepared.length) return [];
  const ok = [];
  const sys = readFileSync(join(RSS, 'verify-prompt.txt'), 'utf8');
  for (let s = 0; s < prepared.length; s += 6) {                      // small batches → reliable answers
    const chunk = prepared.slice(s, s + 6);
    const input = chunk.map((p, i) => `### [${i}]\nכותרת: ${p.e.title}\nמה קרה: ${p.e.what}\nלמה מעניין: ${p.e.why}\n--- טקסט הכתבה ---\n${p.text}`).join('\n\n');
    let res = [];
    for (let attempt = 0; attempt < 2 && !res.length; attempt++) {
      try { res = parseArr(await runClaude(sys, input)); } catch (e) { log('verify call failed: ' + String(e.message).slice(0, 60)); }
    }
    if (!res.length) log(`verify: no parsable answer for ${chunk.length} items`);
    if (!res.length) chunk.forEach((p) => { reason[p.e.event_key] = 'no_answer'; });
    for (const v of res) {
      const p = chunk[v.i]; if (!p || !v.verified) continue;
      ok.push({ ...p.e, title: v.title || p.e.title, what: v.what || p.e.what, why: v.why || p.e.why, verified: true });
    }
  }
  return ok;
}

// ---------- helpers ----------
function hostCount(url, ok) { let h = url; try { h = new URL(url).hostname.replace(/^www\./, ''); } catch {} HOSTS[h] = HOSTS[h] || { ok: 0, blocked: 0 }; HOSTS[h][ok ? 'ok' : 'blocked']++; }
function parseArr(out) {   // tolerant: take the outermost JSON array, ignore any prose around it
  const t = String(out).replace(/```json|```/g, '');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return []; }
}
function runClaude(system, input) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--tools', '', '--model', 'sonnet', '--system-prompt', system];
    if (CLOUD) args.push('--output-format', 'json');
    const p = spawn(CLAUDE_EXE, args, { cwd: SANDBOX, windowsHide: true, env: { ...process.env, MAX_THINKING_TOKENS: '0' } });
    let out = '', errOut = '';
    const to = setTimeout(() => { USAGE.timeouts++; p.kill(); reject(new Error('judge timeout')); }, 360000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (errOut += d));
    p.on('exit', (c) => {
      clearTimeout(to);
      if (!CLOUD) return c === 0 ? resolve(out) : reject(new Error('claude exit ' + c + ' ' + errOut.slice(0, 60)));
      let j = null; try { j = JSON.parse(out); } catch {}
      if (j) { const u = j.usage || {}; USAGE.calls++; USAGE.in += u.input_tokens || 0; USAGE.out += u.output_tokens || 0; USAGE.cacheR += u.cache_read_input_tokens || 0; USAGE.cacheW += u.cache_creation_input_tokens || 0; USAGE.usd += j.total_cost_usd || 0; }
      if (c !== 0 || !j || j.is_error) return reject(new Error('claude exit ' + c + ' ' + (j?.subtype || 'no json') + (j?.is_error ? ': ' + String(j.result || '').replace(/s+/g, ' ').slice(0, 90) : '')));   // an error message only – never echo an answer
      resolve(String(j.result ?? ''));
    });
    p.stdin.end(input);
  });
}

// ---------- display ranking (DAILY_CAP = how many the site shows, not "the first 40 of the day") ----------
// rank = impact on a group like ours first, then the professional score. Same formula as server.mjs / publish.mjs.
function rankOf(e) { return (Number(e.impact) || 0) * 100 + (Number(e.score) || 0); }
function displayFloor() {   // rank of the weakest item currently shown (last 24h, verified); -1 while there is room
  if (!existsSync(CANDIDATES)) return -1;
  const ranks = readFileSync(CANDIDATES, 'utf8').split('\n').filter((l) => l.includes('| ✓ |')).map((l) => {
    const c = l.split(' | ').map((x) => x.replace(/^\|\s*|\s*\|$/g, '').trim());
    const t = (c[0].match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/) || []);
    const pub = /^\d{4}-\d{2}-\d{2}T/.test(c[15] || '') ? new Date(c[15]) : null;
    return t[1] && Date.now() - (pub || new Date(t[1] + 'T' + t[2])) < FRESH_H * 3600e3 ? rankOf({ impact: c[12], score: c[14] }) : null;
  }).filter((r) => r !== null).sort((a, b) => b - a);
  return ranks.length >= DAILY_CAP ? ranks[DAILY_CAP - 1] : -1;
}
// ---------- week-1 funnel: one row per classified event + one per Claude classification call (local only) ----------
function funnel(r) {
  if (DRY) return;
  const F = join(STATE, 'funnel.csv');
  if (!existsSync(F)) writeFileSync(F, 'time,type,round,items_in_call,input_chars,flagged,noise,event_key,level,score,impact,sent_to_verify,result,article_chars,title\n', 'utf8');
  const c = (s) => String(s ?? '').replace(/[,\r\n]/g, ' ');
  appendFileSync(F, [stamp(), r.type, r.round, r.items ?? '', r.type === 'judge' ? r.chars : '', r.flagged ?? '', r.noise ?? '', c(r.key), r.level ?? '', r.score ?? '', r.impact ?? '', r.sent ?? '', r.result ?? '', r.type === 'event' ? r.chars : '', c(r.title)].join(',') + '\n', 'utf8');
}

function appendCandidate(e) {
  if (MODE === 'fallback') appendFileSync(join(pilot.dir, 'candidates.md'), candidateRow(e), 'utf8');
  if (!existsSync(CANDIDATES)) writeFileSync(CANDIDATES, '# מועמדים ל-Daily (מ-RSS ו-Web)\n\nפריטים 🟡 ו-🧠 שלא הצדיקו Live. ה-Daily הבא קורא את אלה מ-24 השעות האחרונות.\n\n| זמן | רמה | event_key | כותרת | מה קרה | למה מעניין | רלוונטי ל | קישור | מקור |\n|---|---|---|---|---|---|---|---|---|\n', 'utf8');
  appendFileSync(CANDIDATES, candidateRow(e), 'utf8');
}
function candidateRow(e) {
  const c = (s) => String(s || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
  return `| ${stamp()} | ${e.level === 'learn' ? '🧠' : '🟡'} | ${c(e.event_key)} | ${c(e.title)} | ${c(e.what)} | ${c(e.why)} | ${c(e.who)} | ${c(e.link)} | ${c(e.source)}${/news.google.com/.test(e.link || '') ? ' (Google News: לאתר ולאמת את הכתבה המקורית)' : ''}${e.development ? ' (התפתחות)' : ''} | ${c(e.topic)} | ${e.verified ? '✓' : ''} | ${c(e.category)} | ${Number(e.impact) || ''} | ${c(e.question)} | ${Number(e.score) || ''} | ${e.pub || ''} |\n`;
}

function sendLive(reds) {
  if (CLOUD) { mkdirSync(join(STATE, 'reds'), { recursive: true }); saveJSON(join(STATE, 'reds', `${Date.now()}.json`), { events: reds }); log(`🔴 ${reds.length} for the PC to mail`); return; }
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const hhmm = new Date().toTimeString().slice(0, 5);
  const cards = reds.map((e) => `
<tr><td style="padding:8px 24px;text-align:right;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-right:4px solid #dc2626;background:#fef2f2;border-radius:4px;"><tr><td style="padding:12px 16px;text-align:right;font-size:14px;line-height:1.6;">
<div style="font-size:16px;font-weight:bold;margin-bottom:6px;">🔴 ${esc(e.title)}</div>
<div><b>מה קרה:</b> ${esc(e.what)}</div>
<div><b>מתי פורסם:</b> ${esc(e.published)}</div>
<div><b>למה זה רלוונטי:</b> ${esc(e.why)}</div>
<div><b>לאיזו חברה או פעילות:</b> ${esc(e.who)}</div>
<div><b>למה לדעת עכשיו:</b> ${esc(e.why_now)}</div>
<div style="margin-top:6px;"><a href="${esc(e.link)}" style="color:#1d4ed8;">${esc(e.source || 'מקור')} ←</a></div>
</td></tr></table></td></tr>`).join('');
  const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>⚡ FinPulse | ${hhmm} · ${esc(reds[0].title)}</title></head>
<body dir="rtl" style="margin:0;background:#f4f5f7;font-family:Arial,'Segoe UI',sans-serif;color:#1f2933;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;" dir="rtl">
<tr><td style="padding:16px 24px 4px 24px;text-align:right;font-size:13px;color:#6b7280;">FinPulse · Live · ${hhmm}</td></tr>${cards}
<tr><td style="padding:10px 24px 18px 24px;text-align:right;font-size:12px;color:#6b7280;"><a href="https://mishlyeden-stack.github.io/finpulse/" style="color:#1d4ed8;">פתחי ב-FinPulse ←</a> · רדאר ציבורי בלבד</td></tr>
</table></td></tr></table></body></html>`;
  const f = join(DRY ? DRYDIR : LIVE_DIR, `${new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[-: ]/g, '')}-rss-mail.html`);
  writeFileSync(f, html, 'utf8');
  if (DRY) { log(`DRY live (not sent): ${reds.map((r) => r.title).join(' / ')}`); return; }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const [n, e] of reds.entries()) appendFileSync(SENT, `| S-${day}-R${hash(e.event_key).slice(0, 4)} | ${String(e.event_key).replace(/\|/g, '\\|')} | ${e.link} | Live RSS ${stamp()} | ${e.development ? 'התפתחות' : '—'} | 🔴 |\n`, 'utf8');
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(RSS, 'send-mail.ps1'), '-MailFile', f], { windowsHide: true },
    (err) => log(err ? `live mail FAILED: ${err.message.slice(0, 80)}` : `live mail sent: ${reds.map((r) => r.title).join(' / ')}`));
}

// ---------- publish the public phone copy (GitHub Pages) – only pushes if web/.pages is a git clone ----------
if (!DRY && !CLOUD) execFile(process.execPath, [join(RADAR, 'web', 'publish.mjs')], { windowsHide: true },
  (err, so) => { if (err) log('publish FAILED: ' + err.message.slice(0, 80)); else if (/published/.test(so)) log('phone page published'); });
