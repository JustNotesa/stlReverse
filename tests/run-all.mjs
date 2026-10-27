// ─────────────────────────────────────────────────────────────────────────────
// npm test — alle SCHNELLEN Regressionen nacheinander, mit Zusammenfassung.
//
// Suiten (gleiche Kommandos wie die einzelnen npm-run-Skripte):
//   unit (Jest)  tests/*.test.js            — API-/Pipeline-Unit-Tests
//   golden       golden-regression.mjs      — Kennzahlen je Sample vs. golden.json
//   v2 (quick)   fixtures-v2/check.mjs      — Härtetest-Kurzlauf
//   ebike        ebike-scorecard.mjs        — verrundetes eBike, 47 Flächen
//   tube         tube-regression.mjs        — 6 Synthetik-Kanäle
//   bore         bore-analytic-regression.mjs — Dünnplatten-Bohrungen
//   mantel       mantle-regression.mjs      — Außenmäntel, Bohrungs-Funde, Fallback
//   collinear    collinear-regression.mjs   — kollineare Kantenpunkte
//   strict       step-strict.mjs            — STEP ohne Heilung (strikte Importer wie CST/ACIS),
//                                             alle Samples Toggle AN und AUS
//   orient       orientation-guard.mjs      — Orientierungs-Wächter: kein Fehlalarm, Verdrehungen
//                                             gefangen, sauberer Rückfall
//   schalen      shell-regression.mjs       — Hohlräume, invertierte Netze, Finnen, berührende Körper,
//                                             offene Fremdteile, Freigang der Kreis-Umwandlung
//
// Jede Suite läuft als eigener Prozess (Ausgabe durchgereicht); es laufen ALLE,
// auch wenn eine scheitert — am Ende Zusammenfassung mit Laufzeiten und
// Exit ≠ 0, sobald mindestens eine rot war. E2E (Puppeteer) läuft bewusst
// NICHT mit: npm run test:e2e.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: 'unit (Jest)', args: ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js'] },
  { name: 'golden',      args: ['tests/golden-regression.mjs'] },
  { name: 'v2 (quick)',  args: ['tests/fixtures-v2/check.mjs', '--quick'] },
  { name: 'ebike',       args: ['tests/ebike-scorecard.mjs'] },
  { name: 'tube',        args: ['tests/tube-regression.mjs'] },
  { name: 'bore',        args: ['tests/bore-analytic-regression.mjs'] },
  { name: 'mantel',      args: ['tests/mantle-regression.mjs'] },
  { name: 'collinear',   args: ['tests/collinear-regression.mjs'] },
  { name: 'strict',      args: ['tests/step-strict.mjs'] },
  { name: 'orient',      args: ['tests/orientation-guard.mjs'] },
  { name: 'schalen',     args: ['tests/shell-regression.mjs'] },
];

const results = [];
for (const suite of SUITES) {
  console.log(`\n════════ ${suite.name} ════════`);
  const t0 = performance.now();
  const r = spawnSync(process.execPath, suite.args, { cwd: ROOT, stdio: 'inherit' });
  const sec = (performance.now() - t0) / 1000;
  const ok = !r.error && r.status === 0;
  const why = r.error ? r.error.message : (r.status === null ? `Signal ${r.signal}` : `Exit ${r.status}`);
  results.push({ name: suite.name, ok, sec, why });
}

console.log('\n════════ Zusammenfassung ════════');
let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(12)} ${r.sec.toFixed(1).padStart(6)} s${r.ok ? '' : `  (${r.why})`}`);
  if (!r.ok) failed++;
}
const total = results.reduce((acc, r) => acc + r.sec, 0);
console.log(`  ${results.length} Suiten, ${failed} rot, ${total.toFixed(1)} s gesamt`);
process.exit(failed ? 1 : 0);
