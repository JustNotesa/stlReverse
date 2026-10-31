/**
 * Verdikt: eine Quelle, zwei Ausgaben.
 *
 *   buildVerdict(report, analysis)  → rein, ohne DOM (läuft in Node/Jest)
 *   renderVerdict(v, opts)          → füllt die Verdikt-Karte und den Rohtext
 *   clearVerdict / renderVerdictPending / renderVerdictError → Zustände der Karte
 *
 * `rawText`/`rawDetail` sind wortgleich zu dem, was `setStepWatertightStatus`
 * (popup.js) bisher in `#step-watertight-status` geschrieben hat.
 */

import { formatBytesDe } from './utils.js?v=2';

// Tipps der „Facettiert geblieben“-Box
const TIP_SWEEP = 'im CAD als Sweep (Profil entlang einer Bahn) nachbauen';
const TIP_FALLBACK = 'Kleinste Detailgröße gröber stellen oder „Verrundungen entfernen“ ausschalten';
const TIP_TRIANGLES = '„STEP aus Dreiecken“ ist immer geschlossen, aber nur facettiert';
const TIP_ORGANIC = 'Kleinste Detailgröße gröber stellen oder Freiform-Erkennung ausprobieren; im CAD bleibt das Teil schwer bearbeitbar';

// ── Reiner Teil ───────────────────────────────────────────────────────────────

/**
 * Warum blieb ein gebogener Kanal facettiert? Aus den verworfenen tube-sweep-Kandidaten
 * die echten Ablehnungsgründe heraussuchen (Bohrungs-Pfade & Co. zählen nicht als Kanal).
 */
export function tubeRejectNote(rejected) {
  if (!Array.isArray(rejected) || !rejected.length) return null;
  const map = {
    'Bahn nicht eben': 'Bahn nicht eben (3D)',
    'Profilkreis nicht in Bahn-Ebene': 'Profil schräg zur Bahn-Ebene',
    'Bahn-Fit gescheitert': 'Bahn nicht annäherbar',
    'Bahn-Vereinfachung zu aufwendig': 'Bahn zu komplex',
    'Bogen zu eng': 'Bogen zu eng',
    'Bahn-Abweichung zu groß': 'Bahn weicht ab',
    'Anfangs-Stück erreicht Mündung A nicht': 'Mündung nicht erreicht',
    'End-Stück erreicht Mündung B nicht': 'Mündung nicht erreicht',
    'Mündungskurve nicht bestimmbar': 'Mündung passt nicht',
    'Mündungs-Loop passt nicht': 'Mündung passt nicht',
    'Übergangskreis schneidet Mündungsebene': 'Mündung passt nicht',
    'Profil kippt gegen die Bahn': 'Profil kippt gegen die Bahn',
    'Netz weicht vom Modell ab': 'Netz weicht vom Modell ab',
    'Facette quer zur Bahn zu breit (ebene Abflachung?)': 'unregelmäßige Facetten'
  };
  const reasons = [];
  let n = 0;
  for (const r of rejected) {
    const txt = map[String(r?.why)];
    if (!txt) continue;
    n++;
    if (!reasons.includes(txt)) reasons.push(txt);
  }
  if (!n) return null;
  return `${n} ${n === 1 ? 'Kanal' : 'Kanäle'} facettiert gelassen: ${reasons.join(', ')}`;
}

const finite = (v) => (Number.isFinite(v) ? v : 0);

/** Netz-Bereinigung (Worker, mesh-clean.js): wie viele Mikro-Dreiecke vor der Analyse entfernt wurden. */
function meshCleanNote(analysis) {
  const mc = analysis?.meshClean;
  if (!mc || !(mc.removedTris > 0)) return null;
  return `${mc.removedTris} Mikro-Dreieck${mc.removedTris === 1 ? '' : 'e'} entfernt (Kanten < ${String(mc.minDetailMm).replace('.', ',')} mm)`
    + (mc.shortAfter ? `, ${mc.shortAfter} kürzere Kante${mc.shortAfter === 1 ? '' : 'n'} geschützt (Ecken, scharfe Kanten, Ebenen)` : '');
}

/** Berührflächen-Reparatur (Worker, mesh-repair.js): ehrliche Zahlen zur Kontaktflächen-Reparatur. */
function contactNote(analysis) {
  const r = analysis?.meshClean?.repair;
  if (!r) return null;
  const k = r.removedTris || 0;                       // tatsächlich entfernte Doppel-Dreiecke
  if (!(k > 0)) return null;                          // ohne Entfernung gibt es nichts zu melden
  const n = (r.nonManifoldEdges || 0) - (r.nonManifoldEdgesAfter || 0);   // reparierte Kanten
  const rest = r.nonManifoldEdgesAfter || 0;          // bleibende non-manifold Kanten
  let txt = `${n} non-manifold-Kante${n === 1 ? '' : 'n'} an Berührflächen repariert `
    + `(${k} doppelte${k === 1 ? 's' : ''} Dreieck${k === 1 ? '' : 'e'} entfernt)`;
  if (rest > 0) txt += `; ${rest} bleib${rest === 1 ? 't' : 'en'} (Körper berühren sich nur an Kante/Ecke)`;
  return txt;
}

/** Kanten-Phrasen („4 offene Kanten, 1 non-manifold-Kante“) — Wortlaut wie heute. */
function edgePhrases(report) {
  const parts = [];
  if (report.boundaryEdges)      parts.push(`${report.boundaryEdges} offene Kante${report.boundaryEdges === 1 ? '' : 'n'}`);
  if (report.nonManifoldEdges)   parts.push(`${report.nonManifoldEdges} non-manifold-Kante${report.nonManifoldEdges === 1 ? '' : 'n'}`);
  if (report.orientationDefects) parts.push(`${report.orientationDefects} fehlorientierte Kante${report.orientationDefects === 1 ? '' : 'n'}`);
  return parts;
}

/**
 * Baut das Verdikt aus dem V2-Export-Befund.
 * @param {object|null} report   Befund von buildVolumeStepBrepV2
 * @param {object|null} analysis Analyseergebnis (für meshClean, tubeStats, meta.triangles, boundingBox)
 * @param {{defeature?: boolean}} opts
 */
export function buildVerdict(report, analysis, { defeature = false } = {}) {   // Standard wie UI: „Verrundungen entfernen“ AUS
  if (!report) return null;

  const { watertight, boundaryEdges, nonManifoldEdges, orientationDefects, edgeCount, faceCount } = report;
  const solids = finite(report.solids);
  const opens = finite(report.openShells);
  const cleanNote = meshCleanNote(analysis);
  const contactTxt = contactNote(analysis);

  // ── Rohtext: wortgleich zu `setStepWatertightStatus` ─────────────────────────
  let rawText = '';
  let rawDetail = '';
  if (watertight) {
    rawText = `✓ Wasserdicht: ${faceCount} Flächen, alle ${edgeCount} Kanten genau 1× vor- und 1× rückwärts genutzt → geschlossener Körper.`;
    // Was die Rekonstruktion gemacht hat (nur wenn etwas passiert ist): echte CAD-Flächen statt
    // Facetten und entfernte Verrundungen — sonst sieht man dem Verdikt nicht an, warum die
    // Flächenzahl mit „Verrundungen entfernen“ so viel kleiner ist.
    const done = [];
    if (cleanNote) done.push(cleanNote);
    if (contactTxt) done.push(contactTxt);
    if (finite(report.boresConverted)) done.push(`${report.boresConverted} Bohrung${report.boresConverted === 1 ? '' : 'en'} als echter Zylinder`);
    if (finite(report.mantlesConverted)) done.push(`${report.mantlesConverted} ${report.mantlesConverted === 1 ? 'Außenmantel' : 'Außenmäntel'} als echter Zylinder`);
    if (finite(report.mantleConesConverted)) done.push(`${report.mantleConesConverted} ${report.mantleConesConverted === 1 ? 'Kegelmantel' : 'Kegelmäntel'} als echter Kegel`);
    if (finite(report.mantleChamfersConverted)) done.push(`${report.mantleChamfersConverted} ${report.mantleChamfersConverted === 1 ? 'Fase/Spitze' : 'Fasen/Spitzen'} am Außenmantel als echter Kegel`);
    if (finite(report.tubesConverted)) done.push(`${report.tubesConverted} gebogene${report.tubesConverted === 1 ? 'r Kanal' : ' Kanäle'} als exakte Fläche (${report.tubePieces} Stück)`);
    // Freiform-Pfad (fit-basierte Segmentierung): eigene analytische Flächen statt Facetten
    if (report.freeform?.used) {
      const ff = report.freeform.faces || {};
      const analytisch = finite(ff.plane) + finite(ff.cylinder) + finite(ff.cone) + finite(ff.sphere) + finite(ff.torus);
      done.push(`Freiform: ${analytisch} analytische Flächen (Kugeln ${finite(ff.sphere)}, Tori ${finite(ff.torus)}), ${finite(ff.facet)} Facetten`);
    }
    // Warum blieb ein Kanal facettiert? Nur wenn der Rückfall nicht schon alles facettiert hat.
    if (!report.fallbackStage) {
      const tubeNote = tubeRejectNote(analysis?.tubeStats?.rejected);
      if (tubeNote) done.push(tubeNote);
    }
    // Schalen-Befunde (assembleSolids): Hohlräume, umgestülpte Eingabe, verworfene Finnen
    if (finite(report.voids)) done.push(report.voids === 1 ? '1 innerer Hohlraum als echter Hohlraum im Körper' : `${report.voids} innere Hohlräume als echte Hohlräume im Körper`);
    if (finite(report.invertedShells)) done.push('Eingabe-Netz war innen-außen gestülpt — Flächen umgedreht');
    if (finite(report.droppedShells)) done.push(`${report.droppedShells} hauchdünne Schale${report.droppedShells === 1 ? '' : 'n'} (Finne/Mini-Tasche) verworfen`);
    const rounds = [];
    if (finite(report.bandsDefeatured))   rounds.push(`${report.bandsDefeatured} ${report.bandsDefeatured === 1 ? 'Rundungsband' : 'Rundungsbänder'} an Deckflächen`);
    if (finite(report.cornersDefeatured)) rounds.push(`${report.cornersDefeatured} gerundete Profilecke${report.cornersDefeatured === 1 ? '' : 'n'}`);
    if (finite(report.filletsDefeatured)) rounds.push(`${report.filletsDefeatured} Kanten-Verrundung${report.filletsDefeatured === 1 ? '' : 'en'}`);
    if (rounds.length) done.push(`scharf gemacht: ${rounds.join(', ')}`);
    // Sicherheits-Rückfall (Hülle offen oder Orientierung einer CAD-Fläche unstimmig): sagen, warum
    // weniger umgewandelt wurde als erkannt
    if (report.fallbackStage === 1) done.push('Sicherheits-Rückfall: Bohrungen, Mäntel, Kegel und Kanäle facettiert gelassen');
    else if (report.fallbackStage === 2) done.push('Sicherheits-Rückfall: komplett facettiert');
    rawDetail = done.length ? done.join(' · ') : '';
  } else {
    const parts = edgePhrases(report);
    // Seit dem Dicht-Urteil je Schale können dichte Körper NEBEN offenen Schalen stehen —
    // dann ist nur ein Teil offen, die Körper sind trotzdem echte Volumen.
    if (solids > 0) {
      rawText = `⚠ Teilweise offen: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) — ${solids} geschlossene${solids === 1 ? 'r' : ''} Körper als Volumen exportiert, ${opens} offene Schale${opens === 1 ? '' : 'n'} als Flächenmodell beigelegt.`;
    } else {
      rawText = `⚠ Nicht wasserdicht: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) → offene Hülle, kein Solid.`;
    }
    rawDetail = [cleanNote, contactTxt].filter(Boolean).join(' · ');
  }

  // ── Zustand ─────────────────────────────────────────────────────────────────
  const state = watertight ? 'ok' : (solids > 0 ? 'partial' : 'open');

  // ── Rundungen: weg (scharf gemacht) vs. erhalten (echte Teil-Zylinder/-Kegel) ──
  // `coneBandsDefeatured` steckt schon in `bandsDefeatured` — nicht doppelt zählen.
  // Lochrand-Rundungen zählen hier NICHT: sie werden in der Bohrungs-/Mantel-Umwandlung als
  // Fase (Kegel) geschrieben — dafür gibt es `rimToChamfer` (Rundung → Fase). Sie wurden also
  // nicht „scharf gemacht“, sondern in eine Fase umgewandelt.
  const roundsRemoved = finite(report.bandsDefeatured) + finite(report.cornersDefeatured) + finite(report.filletsDefeatured);
  const roundsKept = finite(report.arcCylinders) + finite(report.arcCones);
  // Randbänder am Lochrand: `rimFilletsToChamfer` = Rundungen, die als Fase (Kegel) geschrieben
  // wurden; `rimChamfersKept` = echte Fasen, die als Kegel erhalten bleiben (Fasen sind keine
  // Verrundungen).
  const rimToChamfer = finite(report.rimFilletsToChamfer);
  const rimChamfersKept = finite(report.rimChamfersKept);

  // ── Überwiegend facettiert? ─────────────────────────────────────────────────
  // Heißt: der Körper ist geschlossen, aber seine Flächen sind (fast) nur Dreiecke —
  // im CAD dann schwer zu bearbeiten. Zwei Heuristiken:
  //   1) viele Flächen im Verhältnis zu den Dreiecken (≥ 100 Flächen, ≥ 50 % Quote)
  //   2) Freiform-Pfad: mehr als die Hälfte der Flächen sind gebliebene Facetten
  const faces = finite(faceCount);
  const triangles = analysis?.meta?.triangles;
  const triCount = Number.isFinite(triangles) ? triangles : null;
  const ffUsed = !!report.freeform?.used;
  const ffFaces = ffUsed ? (report.freeform.faces || {}) : null;
  const ffFacet = ffFaces ? finite(ffFaces.facet) : 0;
  const mostlyFaceted = (
    state === 'ok' && triCount != null && faces >= 100 && faces / triCount >= 0.5
  ) || (
    ffUsed && ffFacet > faces / 2
  );

  // ── Einteilung: was umgewandelt wurde / was facettiert blieb / Hinweise ─────
  const converted = [];
  if (finite(report.boresConverted)) converted.push(`${report.boresConverted} Bohrung${report.boresConverted === 1 ? '' : 'en'} als echter Zylinder`);
  if (finite(report.mantlesConverted)) converted.push(`${report.mantlesConverted} ${report.mantlesConverted === 1 ? 'Außenmantel' : 'Außenmäntel'} als echter Zylinder`);
  if (finite(report.mantleConesConverted)) converted.push(`${report.mantleConesConverted} ${report.mantleConesConverted === 1 ? 'Kegelmantel' : 'Kegelmäntel'} als echter Kegel`);
  if (finite(report.mantleChamfersConverted)) converted.push(`${report.mantleChamfersConverted} ${report.mantleChamfersConverted === 1 ? 'Fase/Spitze' : 'Fasen/Spitzen'} am Außenmantel als echter Kegel`);
  if (finite(report.tubesConverted)) converted.push(`${report.tubesConverted} gebogene${report.tubesConverted === 1 ? 'r Kanal' : ' Kanäle'} als exakte Fläche (${report.tubePieces} Stück)`);
  if (report.freeform?.used) {
    const ff = report.freeform.faces || {};
    const analytisch = finite(ff.plane) + finite(ff.cylinder) + finite(ff.cone) + finite(ff.sphere) + finite(ff.torus);
    converted.push(`Freiform: ${analytisch} analytische Flächen (Kugeln ${finite(ff.sphere)}, Tori ${finite(ff.torus)}), ${finite(ff.facet)} Facetten`);
  }
  if (finite(report.voids)) converted.push(report.voids === 1 ? '1 innerer Hohlraum als echter Hohlraum im Körper' : `${report.voids} innere Hohlräume als echte Hohlräume im Körper`);
  const rounds = [];
  if (finite(report.bandsDefeatured))   rounds.push(`${report.bandsDefeatured} ${report.bandsDefeatured === 1 ? 'Rundungsband' : 'Rundungsbänder'} an Deckflächen`);
  if (finite(report.cornersDefeatured)) rounds.push(`${report.cornersDefeatured} gerundete Profilecke${report.cornersDefeatured === 1 ? '' : 'n'}`);
  if (finite(report.filletsDefeatured)) rounds.push(`${report.filletsDefeatured} Kanten-Verrundung${report.filletsDefeatured === 1 ? '' : 'en'}`);
  if (rounds.length) converted.push(`scharf gemacht: ${rounds.join(', ')}`);
  // Randbänder am Lochrand — eigene Chips, NICHT im „scharf gemacht:“-Text: eine Rundung wurde
  // als Fase (Kegel) geschrieben, eine echte Fase blieb Kegel (Fasen sind keine Verrundungen).
  if (rimToChamfer > 0) converted.push(`${rimToChamfer} ${rimToChamfer === 1 ? 'Lochrand-Rundung' : 'Lochrand-Rundungen'} als Fase (Kegel) geschrieben`);
  if (rimChamfersKept > 0) converted.push(`${rimChamfersKept} ${rimChamfersKept === 1 ? 'Fase' : 'Fasen'} als echte${rimChamfersKept === 1 ? 'r' : ''} Kegel`);

  const info = [];
  if (cleanNote) info.push(cleanNote);
  if (contactTxt) info.push(contactTxt);
  if (finite(report.invertedShells)) info.push('Eingabe-Netz war innen-außen gestülpt — Flächen umgedreht');
  if (finite(report.droppedShells)) info.push(`${report.droppedShells} hauchdünne Schale${report.droppedShells === 1 ? '' : 'n'} (Finne/Mini-Tasche) verworfen`);

  const faceted = [];
  if (mostlyFaceted) {
    // Organische Form: der Körper ist zu, besteht aber aus lauter Einzel-Flächen.
    if (ffUsed && ffFacet > 0) {
      faceted.push({
        text: `${ffFacet} von ${faces} Flächen bleiben einzelne Facetten (organische Form, keine erkennbare Geometrie)`,
        tip: TIP_ORGANIC
      });
    } else if (triCount != null) {
      faceted.push({
        text: `${faces} von ${triCount} Dreiecken blieben einzelne Flächen (organische Form, keine erkennbare Geometrie)`,
        tip: TIP_ORGANIC
      });
    }
  }
  if (!report.fallbackStage) {
    const tubeNote = tubeRejectNote(analysis?.tubeStats?.rejected);
    if (tubeNote) faceted.push({ text: tubeNote, tip: TIP_SWEEP });
  }
  if (report.fallbackStage === 1) {
    faceted.push({ text: 'Sicherheits-Rückfall: Bohrungen, Mäntel, Kegel und Kanäle facettiert gelassen', tip: TIP_FALLBACK });
  } else if (report.fallbackStage === 2) {
    faceted.push({ text: 'Sicherheits-Rückfall: komplett facettiert', tip: TIP_FALLBACK });
  }
  if (state === 'partial') {
    faceted.push({ text: `${opens} offene Schale${opens === 1 ? '' : 'n'} als Flächenmodell beigelegt`, tip: TIP_TRIANGLES });
  } else if (state === 'open') {
    faceted.push({ text: `offene Hülle: ${edgePhrases(report).join(', ')}`, tip: TIP_TRIANGLES });
  }

  const bbox = analysis?.boundingBox;
  return {
    state,
    faceCount,
    edgeCount,
    solids,
    openShells: opens,
    boundaryEdges,
    nonManifoldEdges,
    orientationDefects,
    triangles: triangles ?? null,
    size: bbox ? { w: bbox.width, d: bbox.depth, h: bbox.height } : null,
    converted,
    faceted,
    info,
    filletsRemoved: roundsRemoved,
    roundsRemoved,
    roundsKept,
    rimToChamfer,
    rimChamfersKept,
    mostlyFaceted,
    defeature: !!defeature,
    freeformUsed: !!report.freeform?.used,
    rawText,
    rawDetail
  };
}

// ── DOM-Teil ──────────────────────────────────────────────────────────────────

const $ = (doc, id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);

const fmtInt = (n) => Number(n).toLocaleString('de-DE');
const fmtDim = (n) => (Number.isFinite(n)
  ? new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(Math.round(n * 10) / 10)
  : '–');

/** Kanten-Phrasen aus dem Verdikt (Wortlaut wie heute). */
function verdictEdgePhrases(v) {
  const parts = [];
  if (v.boundaryEdges)      parts.push(`${v.boundaryEdges} offene Kante${v.boundaryEdges === 1 ? '' : 'n'}`);
  if (v.nonManifoldEdges)   parts.push(`${v.nonManifoldEdges} non-manifold-Kante${v.nonManifoldEdges === 1 ? '' : 'n'}`);
  if (v.orientationDefects) parts.push(`${v.orientationDefects} fehlorientierte Kante${v.orientationDefects === 1 ? '' : 'n'}`);
  return parts;
}

/**
 * Text der Kachel „Verrundungen“ — ehrlich getrennt:
 *   „<r> entfernt“  = Bänder/Profilecken/Kanten-Verrundungen, die wirklich entfernten Rundungen
 *   „<n> → Fase“   = Lochrand-Rundungen, die als Fase (Kegel) geschrieben wurden
 *   „<k> bleiben rund“ = erhaltene Teil-Zylinder/-Kegel
 * Echte Fasen (`rimChamfersKept`) zählen NICHT als Verrundung — sie tauchen hier nicht auf.
 */
export function filletTileText(v) {
  const roundsRemoved = finite(v.roundsRemoved ?? v.filletsRemoved);
  const roundsKept = finite(v.roundsKept);
  const rimToChamfer = finite(v.rimToChamfer);
  if (!v.defeature) return roundsKept > 0 ? `aus – ${roundsKept} bleiben rund` : 'aus';
  const parts = [];
  if (roundsRemoved > 0) parts.push(`${roundsRemoved} entfernt`);
  if (rimToChamfer > 0) parts.push(`${rimToChamfer} → Fase`);
  if (roundsKept > 0) parts.push(`${roundsKept} bleiben rund`);
  return parts.length ? parts.join(', ') : 'keine gezählt';
}

function setKpi(doc, id, text, tone = '') {
  const li = $(doc, id);
  if (!li) return;
  const value = li.querySelector('.kpi__value');
  if (value) value.textContent = text;
  li.dataset.tone = tone;
}

function fillChips(doc, id, items, headId) {
  const list = Array.isArray(items) ? items : [];
  // Überschrift nur zeigen, wenn darunter wirklich etwas steht
  const head = headId ? $(doc, headId) : null;
  if (head) head.hidden = list.length === 0;
  const ul = $(doc, id);
  if (!ul) return;
  ul.textContent = '';
  for (const text of list) {
    const li = doc.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  }
}

/**
 * Füllt die Verdikt-Karte und den Rohtext `#step-watertight-status`.
 * @param {object|null} v    Verdikt aus buildVerdict
 * @param {{res?: object|null, fileBase?: string, doc?: Document}} opts
 */
export function renderVerdict(v, { res = null, fileBase = 'model', doc = document } = {}) {
  if (!v) {
    clearVerdict(doc);
    return;
  }

  if (doc.body) {
    doc.body.dataset.verdict = v.state;
    // Qualitäts-Marker: 'faceted' = geschlossen, aber überwiegend Facetten
    doc.body.dataset.quality = v.mostlyFaceted ? 'faceted' : '';
  }

  const icon = $(doc, 'verdict-icon');
  if (icon) icon.textContent = v.state === 'ok' ? '✓' : v.state === 'partial' ? '!' : '✕';

  const title = $(doc, 'verdict-title');
  if (title) {
    title.textContent = v.state === 'ok'
      ? (v.mostlyFaceted ? 'Wasserdicht – aber überwiegend facettiert' : 'Wasserdicht – bereit fürs CAD')
      : v.state === 'partial'
        ? 'Teilweise offen – trotzdem nutzbar'
        : 'Nicht wasserdicht – nur Flächenmodell';
  }

  const sub = $(doc, 'verdict-sub');
  if (sub) {
    sub.textContent = '';
    if (v.state === 'ok') {
      sub.append('Geschlossener ');
      const abbr = doc.createElement('abbr');
      abbr.setAttribute('title', 'ein Körper mit Innen und Außen, kein reines Flächenmodell');
      abbr.textContent = 'Volumenkörper';
      sub.append(abbr);
      if (v.mostlyFaceted) {
        sub.append(', aber die Flächen sind überwiegend kleine Facetten (Dreiecks-Flächen) – im CAD schwer zu bearbeiten.');
      } else {
        sub.append(` aus ${fmtInt(v.faceCount)} echten CAD-Flächen.`);
      }
    } else if (v.state === 'partial') {
      const solids = finite(v.solids);
      const opens = finite(v.openShells);
      sub.append(`${solids} geschlossene${solids === 1 ? 'r' : ''} Körper als Volumen, ${opens} offene `);
      const abbr = doc.createElement('abbr');
      abbr.setAttribute('title', 'Hülle mit Lücke');
      abbr.textContent = opens === 1 ? 'Schale' : 'Schalen';
      sub.append(abbr);
      sub.append(' als Flächenmodell beigelegt.');
    } else {
      sub.append(`${verdictEdgePhrases(v).join(', ')} von ${v.edgeCount} Kanten (${fmtInt(v.faceCount)} Flächen) – kein geschlossener Körper.`);
    }
  }

  // KPI-Kacheln
  const triangles = Number.isFinite(v.triangles) ? v.triangles : null;
  setKpi(doc, 'kpi-faces', triangles == null
    ? `${fmtInt(v.faceCount)} CAD-Flächen`
    : `${fmtInt(triangles)} Dreiecke → ${fmtInt(v.faceCount)} CAD-Flächen`);
  if (v.state === 'ok') {
    setKpi(doc, 'kpi-watertight', 'Ja', 'ok');
  } else if (v.state === 'partial') {
    const solids = finite(v.solids);
    const opens = finite(v.openShells);
    setKpi(doc, 'kpi-watertight', `Teilweise (${solids} Körper + ${opens} ${opens === 1 ? 'Schale' : 'Schalen'})`, 'warn');
  } else {
    setKpi(doc, 'kpi-watertight', 'Nein', 'err');
  }
  setKpi(doc, 'kpi-size', v.size ? `${fmtDim(v.size.w)} × ${fmtDim(v.size.d)} × ${fmtDim(v.size.h)}` : '–');
  // Verrundungen ehrlich zählen: weg (scharf gemacht), als Fase geschrieben, erhalten (bleibt rund)
  const filletsText = filletTileText(v);
  setKpi(doc, 'kpi-fillets', filletsText);
  const filletsLi = $(doc, 'kpi-fillets');
  if (filletsLi) {
    if (filletsText === 'keine gezählt' && v.rimChamfersKept > 0) {
      filletsLi.setAttribute('title', 'Echte Fasen zählen nicht als Verrundung — sie stehen als Chip unter „Was umgewandelt wurde“.');
    } else {
      filletsLi.removeAttribute('title');
    }
  }

  // Chips (mit Überschriften, die nur bei Inhalt erscheinen)
  fillChips(doc, 'verdict-converted', v.converted, 'verdict-converted-head');
  fillChips(doc, 'verdict-info', v.info, 'verdict-info-head');

  // „Facettiert geblieben“
  const facetedBox = $(doc, 'verdict-faceted');
  const facetedItems = Array.isArray(v.faceted) ? v.faceted : [];
  if (facetedBox) {
    facetedBox.textContent = '';
    if (!facetedItems.length) {
      facetedBox.hidden = true;
    } else {
      facetedBox.hidden = false;
      const head = doc.createElement('strong');
      head.textContent = 'Facettiert geblieben:';
      facetedBox.appendChild(head);
      const ul = doc.createElement('ul');
      for (const item of facetedItems) {
        const li = doc.createElement('li');
        li.textContent = `${item.text} – Tipp: ${item.tip}`;
        ul.appendChild(li);
      }
      facetedBox.appendChild(ul);
    }
  }

  // Zweitknopf „STEP aus Dreiecken“
  let triBtn = $(doc, 'verdict-tri-button');
  if (!triBtn) {
    triBtn = doc.createElement('button');
    triBtn.id = 'verdict-tri-button';
    triBtn.type = 'button';
    triBtn.className = 'btn';
    triBtn.textContent = 'STEP aus Dreiecken (immer geschlossen)';
    triBtn.addEventListener('click', () => {
      $(doc, 'step-export-triangles-button')?.click();
    });
    const anchor = $(doc, 'step-export-button');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(triBtn, anchor.nextSibling);
    else if (doc.body) doc.body.appendChild(triBtn);
  }
  const triTarget = $(doc, 'step-export-triangles-button');
  triBtn.hidden = !(v.state === 'partial' || v.state === 'open');
  triBtn.disabled = triTarget ? triTarget.disabled : true;

  // Fehlerzeile leeren (der Fehlerzustand setzt sie selbst)
  const errorBox = $(doc, 'verdict-error');
  if (errorBox) errorBox.hidden = true;

  // Datei-Hinweis
  const hint = $(doc, 'export-file-hint');
  if (hint) hint.textContent = res?.step ? `${fileBase}-volume.step · ca. ${formatBytesDe(res.step.length)}` : '';

  // Rohtext (Expertenansicht) — wortgleich zu heute
  const raw = $(doc, 'step-watertight-status');
  if (raw) {
    raw.textContent = v.rawText || '';
    raw.dataset.state = v.state === 'ok' ? 'ok' : 'warn';
    if (v.rawDetail) {
      const detail = doc.createElement('span');
      detail.className = 'watertight-detail';
      detail.textContent = v.rawDetail;
      raw.append(doc.createElement('br'), detail);
    }
  }
}

/** Leert die Verdikt-Karte (Skelett / Ausgangszustand). */
export function clearVerdict(doc = document) {
  if (doc.body) {
    doc.body.dataset.verdict = '';
    doc.body.dataset.quality = '';
  }
  const icon = $(doc, 'verdict-icon');
  if (icon) icon.textContent = '';
  const title = $(doc, 'verdict-title');
  if (title) title.textContent = '';
  const sub = $(doc, 'verdict-sub');
  if (sub) sub.textContent = '';

  const kpis = $(doc, 'verdict-kpis');
  if (kpis) {
    const values = kpis.querySelectorAll('.kpi__value');
    for (const value of values) value.textContent = '–';
    const items = kpis.querySelectorAll('li');
    for (const li of items) li.dataset.tone = '';
  }

  fillChips(doc, 'verdict-converted', [], 'verdict-converted-head');
  fillChips(doc, 'verdict-info', [], 'verdict-info-head');

  const facetedBox = $(doc, 'verdict-faceted');
  if (facetedBox) {
    facetedBox.textContent = '';
    facetedBox.hidden = true;
  }

  const errorBox = $(doc, 'verdict-error');
  if (errorBox) errorBox.hidden = true;

  const triBtn = $(doc, 'verdict-tri-button');
  if (triBtn) triBtn.hidden = true;

  const hint = $(doc, 'export-file-hint');
  if (hint) hint.textContent = '';

  const raw = $(doc, 'step-watertight-status');
  if (raw) {
    raw.textContent = '';
    raw.dataset.state = '';
  }
}

/** Zustand „wird analysiert …“ */
export function renderVerdictPending(doc = document) {
  clearVerdict(doc);
  const icon = $(doc, 'verdict-icon');
  if (icon) icon.textContent = '…';
  const title = $(doc, 'verdict-title');
  if (title) title.textContent = 'Wird analysiert …';
  const sub = $(doc, 'verdict-sub');
  if (sub) sub.textContent = 'Das Ergebnis erscheint hier, sobald die Analyse fertig ist.';
}

/** Zustand „Datei konnte nicht umgewandelt werden“ */
export function renderVerdictError(message, stepText = '', doc = document) {
  clearVerdict(doc);
  const icon = $(doc, 'verdict-icon');
  if (icon) icon.textContent = '✕';
  const title = $(doc, 'verdict-title');
  if (title) title.textContent = 'Datei konnte nicht umgewandelt werden';
  const sub = $(doc, 'verdict-sub');
  if (sub) sub.textContent = stepText;
  const errorBox = $(doc, 'verdict-error');
  if (errorBox) errorBox.hidden = false;
  const errorText = $(doc, 'verdict-error-text');
  if (errorText) errorText.textContent = message;
}
