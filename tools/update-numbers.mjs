// Runs in GitHub Actions: refreshes the official numbers (Bank of Israel) without the PC. No Claude, no secrets.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { buildNumbers } from './numbers.mjs';
const n = await buildNumbers();
delete n.updated;
if (!n.numbers.some((x) => x.key === 'boi')) { console.log('BOI unreachable, keeping previous file'); process.exit(0); }
const next = JSON.stringify(n);
const f = new URL('../data/numbers.json', import.meta.url);
if (!existsSync(f) || readFileSync(f, 'utf8') !== next) { writeFileSync(f, next, 'utf8'); console.log('numbers updated'); } else console.log('no changes');
