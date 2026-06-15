// occt-import-js Node-Harness: STEP-Strings/Dateien gegen den ECHTEN occt-Parser prüfen
// (derselbe Parser wie Panel 4). .cjs, weil das Projekt "type":"module" ist und dieser Helfer
// CommonJS braucht. Das Emscripten-Modul exportiert per `var occtimportjs = IIFE()` + module.exports,
// was direktes require() leer zurückgibt — daher Laden über einen CommonJS-Function-Wrapper.
//
// Nutzung (aus einem CJS-Kontext, z. B. `node -e` oder einer .cjs-Datei):
//   const { parseStep, summarize } = require('./tests/occt-check.cjs');
//   const r = await parseStep(stepString);   // r.success, r.meshes[].index.array, r.meshes[].brep_faces
const fs = require('fs');
const path = require('path');

const OCCT_DIR = path.join(__dirname, '..', 'libs', 'occt');
let _occt = null;

async function getOcct() {
  if (_occt) return _occt;
  const code = fs.readFileSync(path.join(OCCT_DIR, 'occt-import-js.js'), 'utf8');
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', 'require', '__dirname', '__filename',
    code + '\nreturn module.exports;');
  const factory = fn(mod, mod.exports, require, OCCT_DIR, path.join(OCCT_DIR, 'occt-import-js.js'));
  _occt = await factory({ locateFile: (p) => path.join(OCCT_DIR, p) });
  return _occt;
}

async function parseStep(stepStringOrBuffer) {
  const occt = await getOcct();
  const buf = Buffer.isBuffer(stepStringOrBuffer)
    ? stepStringOrBuffer
    : Buffer.from(String(stepStringOrBuffer), 'utf8');
  return occt.ReadFile('step', new Uint8Array(buf), null);
}

// Kurzreport: parsebar? wie viele Meshes/Dreiecke/brep_faces?
function summarize(result) {
  if (!result || !result.success) return { success: false };
  const meshes = result.meshes || [];
  let tris = 0, faces = 0;
  for (const m of meshes) {
    tris += (m.index?.array?.length || 0) / 3 | 0;
    faces += m.brep_faces?.length || 0;
  }
  return { success: true, meshes: meshes.length, triangles: tris, brepFaces: faces };
}

module.exports = { getOcct, parseStep, summarize };
