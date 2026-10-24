// Node-Variante der Worker-Pipeline (parseStl → buildNormalGroups → unifyCoplanarGroups →
// recognizePrimitives → detectTubes → buildVolumeStepBrepV2) für Tests ohne Browser. Nutzt dieselben
// Module wie analysis-worker.js — keine Kopien mehr (die liefen früher auseinander).
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

// Gemeinsames Modul wie im Worker (Node ≥ 22 lädt ES-Module per require).
const { buildNormalGroups } = require(path.join(ROOT, 'region-growing.js'));

// analyze('block_with_hole.stl') → { groups, recogStats, primitives, res:{step,report}|null }
async function analyze(sampleFile, { withExport = true } = {}) {
  const { parseStl } = await import(path.join(ROOT, 'analysis-core.js'));
  const { unifyCoplanarGroups } = await import(path.join(ROOT, 'face-unification.js'));
  const { recognizePrimitives } = await import(path.join(ROOT, 'primitive-recognition.js'));
  const buf = fs.readFileSync(path.join(ROOT, 'samples', sampleFile));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const mesh = parseStl(ab, () => {});
  let groups = buildNormalGroups(mesh);
  const { unified } = unifyCoplanarGroups(groups);
  groups = unified.sort((a, b) => b.vertices.length - a.vertices.length);
  const { primitives, stats } = recognizePrimitives(groups);
  const { detectTubes } = await import(path.join(ROOT, 'tube-sweep.js'));
  const { stats: tubeStats } = detectTubes(groups);
  let res = null;
  if (withExport) {
    const { buildVolumeStepBrepV2 } = await import(path.join(ROOT, 'exporters.js'));
    res = buildVolumeStepBrepV2({ normalGroups: groups });
  }
  return { groups, recogStats: stats, tubeStats, primitives, res };
}

module.exports = { analyze, buildNormalGroups };
