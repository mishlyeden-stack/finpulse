// FinPulse cloud Daily (from 25.10.2026, Eden's decision): the morning brief for the SITE, on Eden's own Claude subscription
// (official Claude Code CLI + CLAUDE_CODE_OAUTH_TOKEN). No mail from the cloud – the PC sends it when it is on.
// Public Radar, Private Company: Claude works in an isolated folder (/tmp/ws) that holds only the radar's public material
// (skill + public context + source map from GitHub secrets, candidates / sent log / events / numbers from this repo).
// It can read and write only there (no shell). Only public outputs come back to the repo. Logs: counts only.
//   node tools/daily-cloud.mjs due       → due=true|false (GITHUB_OUTPUT)
//   node tools/daily-cloud.mjs prepare   → builds /tmp/ws
//   node tools/daily-cloud.mjs collect   → copies the outputs into the repo
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const P = (...a) => join(ROOT, ...a);
const WS = '/tmp/ws', R = join(WS, '07 רדאר עסקי');
const load = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1), 'utf8'); };
const today = new Date().toLocaleString('sv-SE').slice(0, 10);          // TZ=Asia/Jerusalem in the workflow
const STATUS = P('state', 'daily', 'status.json');
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/) : []);
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); console.log(`${k}=${v}`); };

const cmd = process.argv[2];

if (cmd === 'due') {
  const cfg = load(P('state', 'judge', 'config.json'), {});
  const st = load(STATUS, {});
  const d = new Date(); const day = d.getDay(), min = d.getHours() * 60 + d.getMinutes();
  const force = process.env.DAILY_FORCE === '1';
  let why = '';
  if (!(cfg.enabled === true && cfg.daily === true)) why = 'off';
  else if (!force && existsSync(P('data', `daily-${today}.json`))) why = 'done';
  else if (!force && !(day >= 0 && day <= 4)) why = 'weekend';
  else if (!force && (min < 6 * 60 + 30 || min >= 12 * 60)) why = 'hours';
  else if (st.date === today && (st.tries || 0) >= 2) why = 'tries';
  out('due', why ? 'false' : 'true'); if (why) console.log('not due: ' + why);
  process.exit(0);
}

if (cmd === 'prepare') {
  const need = { DAILY_SKILL: join(WS, '.claude', 'skills', 'radar-daily', 'SKILL.md'), RADAR_CONTEXT: join(R, '00א הקשר ציבורי.md'), RADAR_MAP: join(R, '02 רדאר.md'), MAIL_TEMPLATE: join(R, 'תבניות', 'מייל v2.html') };
  for (const [k, f] of Object.entries(need)) { if (!process.env[k]) { console.log('missing secret ' + k); process.exit(1); } save(f, process.env[k]); }
  // candidates (last 3 days), the sent log (PC + cloud), known events, the manual numbers
  const rows = lines(P('state', 'judge', 'candidates.md')).filter((l) => { const m = l.match(/^\| (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \|/); return m && Date.now() - new Date(m[1] + 'T' + m[2]) < 3 * 864e5; });
  save(join(R, 'דוחות', 'מועמדים ל-Daily.md'), '# מועמדים ל-Daily (מ-RSS ו-Web)\n\n| זמן | רמה | event_key | כותרת | מה קרה | למה מעניין | רלוונטי ל | קישור | מקור |\n|---|---|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n');
  const sent = [...lines(P('state', 'daily', 'sent.md')), ...lines(P('state', 'daily', 'sent-cloud.md')).filter((l) => l.startsWith('| S-'))];
  save(join(R, 'דוחות', 'נשלחו.md'), sent.join('\n') + '\n');
  save(join(WS, '.sent-baseline'), String(sent.length + 1));
  save(join(R, 'rss', 'state', 'events.json'), readFileSync(P('state', 'judge', 'events.json'), 'utf8'));
  if (existsSync(P('tools', 'numbers-manual.json'))) save(join(R, 'web', 'numbers-manual.json'), readFileSync(P('tools', 'numbers-manual.json'), 'utf8'));
  mkdirSync(join(R, 'דוחות', 'יומי'), { recursive: true });
  // least privilege: read/write only inside the workspace, web search + fetch, the skill. No shell.
  save(join(WS, 'settings.json'), { permissions: { defaultMode: 'dontAsk', allow: ['WebSearch', 'WebFetch', 'Skill', 'Glob', 'Grep', `Read(/${WS}/**)`, `Edit(/${WS}/**)`, `Write(/${WS}/**)`], deny: ['Bash', 'NotebookEdit', 'Read(//proc/**)', 'Read(//home/**)', 'Read(//etc/**)', 'Read(//root/**)'] } });
  const st = load(STATUS, {}); if (process.env.DAILY_FORCE !== '1') save(STATUS, { date: today, tries: st.date === today ? (st.tries || 0) + 1 : 1, result: 'running', at: new Date().toISOString() });
  console.log(`prepared: candidates ${rows.length}, sent log ${sent.length}`);
  process.exit(0);
}

if (cmd === 'collect' && process.env.DAILY_FORCE === '1') {   // test run: the result goes to state/daily/test/ only – not to the site, the sent log or the numbers
  const jf = join(R, 'דוחות', 'יומי', `${today}.json`); const daily = load(jf, null);
  if (daily) { save(P('state', 'daily', 'test', `${today}.json`), readFileSync(jf, 'utf8')); const mf = join(R, 'דוחות', 'יומי', `${today}-mail.html`); if (existsSync(mf)) copyFileSync(mf, P('state', 'daily', 'test', `${today}-mail.html`)); }
  console.log(`test daily: ${daily ? (daily.empty ? 'empty' : 'written') : 'no valid json'}`); process.exit(0);
}
if (cmd === 'collect') {
  const st = load(STATUS, { date: today, tries: 1 });
  const jf = join(R, 'דוחות', 'יומי', `${today}.json`);
  const daily = load(jf, null);
  if (!daily || daily.date !== today) { save(STATUS, { ...st, result: 'failed', at: new Date().toISOString() }); console.log('no valid daily json'); process.exit(0); }
  save(P('data', `daily-${today}.json`), readFileSync(jf, 'utf8'));
  const days = [...new Set([...readdirSync(P('data')).filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(6, 16))])].sort().reverse().slice(0, 14);
  save(P('data', 'days.json'), JSON.stringify(days));
  for (const f of [`${today}.md`, `${today}-mail.html`]) if (existsSync(join(R, 'דוחות', 'יומי', f))) copyFileSync(join(R, 'דוחות', 'יומי', f), P('state', 'daily', f));
  const base = Number(readFileSync(join(WS, '.sent-baseline'), 'utf8')) || 0;
  const added = lines(join(R, 'דוחות', 'נשלחו.md')).slice(base - 1).filter((l) => l.startsWith('| S-'));
  if (added.length) appendFileSync(P('state', 'daily', 'sent-cloud.md'), added.join('\n') + '\n', 'utf8');
  const nm = join(R, 'web', 'numbers-manual.json');
  if (existsSync(nm) && load(nm, null) && readFileSync(nm, 'utf8') !== (existsSync(P('tools', 'numbers-manual.json')) ? readFileSync(P('tools', 'numbers-manual.json'), 'utf8') : '')) copyFileSync(nm, P('tools', 'numbers-manual.json'));
  save(STATUS, { ...st, result: daily.empty ? 'empty' : 'ok', mail: existsSync(P('state', 'daily', `${today}-mail.html`)), at: new Date().toISOString() });
  console.log(`daily ${today}: ${daily.empty ? 'empty' : 'written'}, sent log +${added.length}`);
  process.exit(0);
}
console.log('usage: due | prepare | collect'); process.exit(1);
