// FinPulse cloud collector – runs in GitHub Actions every 15 min, 24/7. NO AI, NO secrets, public news only.
// fetch RSS → light technical filter (duplicates, stale, sponsored, obvious non-business sections) → queue/<stamp>.json
// + data/raw.json ("📡 עכשיו בחדשות", last 24h) + logs/collect.csv.
// Single writer: this script is the only one that writes queue/, state/seen.json, state/feed-status.json, data/raw.json, logs/collect.csv.
// The local PC (Claude via Eden's subscription) reads the queue and writes state/batches.json – it never edits these files.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...a) => join(ROOT, ...a);
['queue', 'state', 'data', 'logs'].forEach((d) => mkdirSync(P(d), { recursive: true }));
const loadJSON = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const MAX_AGE_H = 48;

// same parsing + dedup keys as the local rss-poll.mjs (so both sides agree on what is "the same item")
const UA = { 'User-Agent': 'FinPulse/1.0 (public news reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' };
const txt = (s) => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const tag = (x, t) => (x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1];
const normTitle = (t) => t.toLowerCase().replace(/\s[-–|]\s[^-–|]{2,40}$/, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

async function fetchFeed(f) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(f.url, { headers: UA, signal: ctl.signal });
    if (!r.ok) return null;
    const x = await r.text();
    const blocks = x.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
    if (!blocks.length) return null;
    return blocks.map((b) => {
      const link = txt(tag(b, 'link')) || (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
      const d = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
      const date = d ? new Date(txt(d)) : null;
      return { source: f.name, group: f.group, title: txt(tag(b, 'title')), link, summary: txt(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 280), date: date && !isNaN(date) ? date.toISOString() : null };
    }).filter((i) => i.title && i.link).slice(0, f.maxPerBatch || 100);
  } catch { return null; } finally { clearTimeout(to); }
}

// light filter only – FinPulse must still discover things nobody searched for. No keyword whitelist.
const SPONSORED = /sponsored|ממומן|תוכן שיווקי|בשיתוף|advertorial|promoted/i;
const OFFTOPIC_PATH = /\/(sport|sports|ספורט|celebs?|gossip|entertainment|lifestyle|food|horoscope|music|tv|culture|travel)\//i;

const feeds = loadJSON(join(ROOT, 'tools', 'feeds.json'), []);
const seen = loadJSON(P('state', 'seen.json'), {});
const now = Date.now();
const results = await Promise.all(feeds.map(fetchFeed));
const c = { feedsOk: 0, fetched: 0, dup: 0, old: 0, spam: 0, offtopic: 0, queued: 0 };
const failed = [];
const fresh = [];
results.forEach((items, k) => {
  if (!items) { failed.push(feeds[k].name); return; }
  c.feedsOk++; c.fetched += items.length;
  for (const it of items) {
    const hl = hash(it.link), ht = hash(normTitle(it.title));
    if (seen[hl] || seen[ht]) { c.dup++; continue; }
    seen[hl] = seen[ht] = now;
    if (it.date && now - new Date(it.date) > MAX_AGE_H * 3600e3) { c.old++; continue; }
    if (SPONSORED.test(it.title)) { c.spam++; continue; }
    if (OFFTOPIC_PATH.test(it.link)) { c.offtopic++; continue; }
    fresh.push({ id: hl, ...it, fetched: new Date(now).toISOString() });
  }
});
for (const [k, v] of Object.entries(seen)) if (now - v > 7 * 864e5) delete seen[k];   // prune 7 days
writeFileSync(P('state', 'seen.json'), JSON.stringify(seen));
writeFileSync(P('state', 'feed-status.json'), JSON.stringify({ at: new Date(now).toISOString(), failed }, null, 1));

// queue: one immutable file per run (never edited afterwards → no merge conflicts with the PC)
const stampIso = new Date(now).toISOString().slice(0, 16).replace(':', '');
if (fresh.length) { writeFileSync(P('queue', `${stampIso}.json`), JSON.stringify({ batch: stampIso, created: new Date(now).toISOString(), items: fresh }, null, 1)); c.queued = fresh.length; }

// "📡 עכשיו בחדשות": last 24h, newest first
const raw = loadJSON(P('data', 'raw.json'), { items: [] });
const keep = (i) => now - new Date(i.date || i.fetched) < 24 * 3600e3;
const items = [...fresh.map(({ summary, group, ...r }) => r), ...raw.items].filter(keep)
  .sort((a, b) => String(b.date || b.fetched).localeCompare(String(a.date || a.fetched))).slice(0, 400);
writeFileSync(P('data', 'raw.json'), JSON.stringify({ updated: new Date(now).toISOString(), items }));

// week-1 log: how much was collected, how much waits for the PC
const done = loadJSON(P('state', 'batches.json'), {});
const pendingFiles = readdirSync(P('queue')).filter((f) => f.endsWith('.json') && !done[f]);
const pendingItems = pendingFiles.reduce((a, f) => a + (loadJSON(P('queue', f), { items: [] }).items.length), 0);
const LOG = P('logs', 'collect.csv');
if (!existsSync(LOG)) writeFileSync(LOG, 'time_utc,feeds_ok,feeds_total,fetched,duplicates,stale,sponsored,offtopic,queued,pending_files,pending_items,failed_feeds\n');
appendFileSync(LOG, [new Date(now).toISOString().slice(0, 16), c.feedsOk, feeds.length, c.fetched, c.dup, c.old, c.spam, c.offtopic, c.queued, pendingFiles.length, pendingItems, failed.join(';').replace(/,/g, ' ')].join(',') + '\n');
console.log(JSON.stringify({ ...c, failed: failed.length, pendingFiles: pendingFiles.length, pendingItems }));
