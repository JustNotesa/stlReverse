import { buildVerdict, tubeRejectNote } from '../verdict.js';

/**
 * Wortgleiche Kopie der heutigen String-Logik aus popup.js (`setStepWatertightStatus`),
 * ohne DOM. Dient als Referenz für `buildVerdict(...).rawText` / `.rawDetail`.
 */
function legacy(report, lastAnalysis) {
  if (!report) return { text: '', detail: '' };
  const { watertight, boundaryEdges, nonManifoldEdges, orientationDefects, edgeCount, faceCount } = report;
  // Netz-Bereinigung (Worker, mesh-clean.js): wie viele Mikro-Dreiecke vor der Analyse entfernt wurden
  const mc = lastAnalysis?.meshClean;
  const cleanNote = mc && mc.removedTris > 0
    ? `${mc.removedTris} Mikro-Dreieck${mc.removedTris === 1 ? '' : 'e'} entfernt (Kanten < ${String(mc.minDetailMm).replace('.', ',')} mm)`
      + (mc.shortAfter ? `, ${mc.shortAfter} kürzere Kante${mc.shortAfter === 1 ? '' : 'n'} geschützt (Ecken, scharfe Kanten, Ebenen)` : '')
    : null;
  if (watertight) {
    const text = `✓ Wasserdicht: ${faceCount} Flächen, alle ${edgeCount} Kanten genau 1× vor- und 1× rückwärts genutzt → geschlossener Körper.`;
    const n = (v) => (Number.isFinite(v) ? v : 0);
    const done = [];
    if (cleanNote) done.push(cleanNote);
    if (n(report.boresConverted)) done.push(`${report.boresConverted} Bohrung${report.boresConverted === 1 ? '' : 'en'} als echter Zylinder`);
    if (n(report.mantlesConverted)) done.push(`${report.mantlesConverted} ${report.mantlesConverted === 1 ? 'Außenmantel' : 'Außenmäntel'} als echter Zylinder`);
    if (n(report.mantleConesConverted)) done.push(`${report.mantleConesConverted} ${report.mantleConesConverted === 1 ? 'Kegelmantel' : 'Kegelmäntel'} als echter Kegel`);
    if (n(report.mantleChamfersConverted)) done.push(`${report.mantleChamfersConverted} ${report.mantleChamfersConverted === 1 ? 'Fase/Spitze' : 'Fasen/Spitzen'} am Außenmantel als echter Kegel`);
    if (n(report.tubesConverted)) done.push(`${report.tubesConverted} gebogene${report.tubesConverted === 1 ? 'r Kanal' : ' Kanäle'} als exakte Fläche (${report.tubePieces} Stück)`);
    // Freiform-Pfad (fit-basierte Segmentierung): eigene analytische Flächen statt Facetten
    if (report.freeform?.used) {
      const ff = report.freeform.faces || {};
      const analytisch = n(ff.plane) + n(ff.cylinder) + n(ff.cone) + n(ff.sphere) + n(ff.torus);
      done.push(`Freiform: ${analytisch} analytische Flächen (Kugeln ${n(ff.sphere)}, Tori ${n(ff.torus)}), ${n(ff.facet)} Facetten`);
    }
    // Warum blieb ein Kanal facettiert? Nur wenn der Rückfall nicht schon alles facettiert hat.
    if (!report.fallbackStage) {
      const tubeNote = tubeRejectNote(lastAnalysis?.tubeStats?.rejected);
      if (tubeNote) done.push(tubeNote);
    }
    // Schalen-Befunde (assembleSolids): Hohlräume, umgestülpte Eingabe, verworfene Finnen
    if (n(report.voids)) done.push(report.voids === 1 ? '1 innerer Hohlraum als echter Hohlraum im Körper' : `${report.voids} innere Hohlräume als echte Hohlräume im Körper`);
    if (n(report.invertedShells)) done.push('Eingabe-Netz war innen-außen gestülpt — Flächen umgedreht');
    if (n(report.droppedShells)) done.push(`${report.droppedShells} hauchdünne Schale${report.droppedShells === 1 ? '' : 'n'} (Finne/Mini-Tasche) verworfen`);
    const rounds = [];
    if (n(report.bandsDefeatured))   rounds.push(`${report.bandsDefeatured} ${report.bandsDefeatured === 1 ? 'Rundungsband' : 'Rundungsbänder'} an Deckflächen`);
    if (n(report.cornersDefeatured)) rounds.push(`${report.cornersDefeatured} gerundete Profilecke${report.cornersDefeatured === 1 ? '' : 'n'}`);
    if (n(report.filletsDefeatured)) rounds.push(`${report.filletsDefeatured} Kanten-Verrundung${report.filletsDefeatured === 1 ? '' : 'en'}`);
    if (rounds.length) done.push(`scharf gemacht: ${rounds.join(', ')}`);
    // Sicherheits-Rückfall (Hülle offen oder Orientierung einer CAD-Fläche unstimmig)
    if (report.fallbackStage === 1) done.push('Sicherheits-Rückfall: Bohrungen, Mäntel, Kegel und Kanäle facettiert gelassen');
    else if (report.fallbackStage === 2) done.push('Sicherheits-Rückfall: komplett facettiert');
    return { text, detail: done.length ? done.join(' · ') : '' };
  } else {
    const parts = [];
    if (boundaryEdges)      parts.push(`${boundaryEdges} offene Kante${boundaryEdges === 1 ? '' : 'n'}`);
    if (nonManifoldEdges)   parts.push(`${nonManifoldEdges} non-manifold-Kante${nonManifoldEdges === 1 ? '' : 'n'}`);
    if (orientationDefects) parts.push(`${orientationDefects} fehlorientierte Kante${orientationDefects === 1 ? '' : 'n'}`);
    const solids = Number.isFinite(report.solids) ? report.solids : 0;
    const opens = Number.isFinite(report.openShells) ? report.openShells : 0;
    const text = solids > 0
      ? `⚠ Teilweise offen: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) — ${solids} geschlossene${solids === 1 ? 'r' : ''} Körper als Volumen exportiert, ${opens} offene Schale${opens === 1 ? '' : 'n'} als Flächenmodell beigelegt.`
      : `⚠ Nicht wasserdicht: ${parts.join(', ')} von ${edgeCount} Kanten (${faceCount} Flächen) → offene Hülle, kein Solid.`;
    return { text, detail: cleanNote || '' };
  }
}

// ── Synthetische Befunde ─────────────────────────────────────────────────────

const reportA = {
  watertight: true,
  faceCount: 6,
  edgeCount: 12,
  boresConverted: 2,
  mantlesConverted: 1,
  bandsDefeatured: 1,
  filletsDefeatured: 3
};

const reportB = { watertight: true, faceCount: 3, edgeCount: 6 };

const reportC = { watertight: true, faceCount: 10, edgeCount: 20 };
const analysisC = {
  meshClean: { removedTris: 5, minDetailMm: 0.02, shortAfter: 2 },
  tubeStats: { rejected: [{ why: 'Bogen zu eng' }, { why: 'xyz' }] }
};

const reportD = {
  watertight: true,
  faceCount: 8,
  edgeCount: 16,
  fallbackStage: 1,
  voids: 1,
  invertedShells: 1,
  droppedShells: 2
};

const reportE = {
  watertight: true,
  faceCount: 12,
  edgeCount: 24,
  freeform: { used: true, faces: { plane: 3, cylinder: 1, sphere: 2, torus: 1, facet: 4 } }
};

const reportF = {
  watertight: false,
  faceCount: 20,
  edgeCount: 40,
  solids: 2,
  openShells: 1,
  boundaryEdges: 4,
  nonManifoldEdges: 1,
  fallbackStage: 1
};

const reportG = {
  watertight: false,
  faceCount: 4,
  edgeCount: 5,
  solids: 0,
  boundaryEdges: 1,
  orientationDefects: 2
};
const analysisG = { meshClean: { removedTris: 3, minDetailMm: 0.05 } };

describe('verdict.js', () => {
  describe('tubeRejectNote', () => {
    test('übersetzt bekannte Gründe und zählt sie', () => {
      expect(tubeRejectNote([{ why: 'Bogen zu eng' }])).toBe('1 Kanal facettiert gelassen: Bogen zu eng');
    });
    test('ignoriert unbekannte Gründe', () => {
      expect(tubeRejectNote([{ why: 'xyz' }])).toBeNull();
      expect(tubeRejectNote([])).toBeNull();
      expect(tubeRejectNote(null)).toBeNull();
    });
  });

  describe('buildVerdict – Rohtext ist wortgleich zur heutigen Logik', () => {
    const cases = [
      ['a: wasserdicht mit Bohrungen/Mänteln/Verrundungen', reportA, null],
      ['b: wasserdicht minimal', reportB, null],
      ['c: wasserdicht mit Netzbereinigung und Kanal-Rückweisung', reportC, analysisC],
      ['d: wasserdicht mit Sicherheits-Rückfall und Schalen-Befunden', reportD, null],
      ['e: wasserdicht mit Freiform-Flächen', reportE, null],
      ['f: teilweise offen mit Rückfall', reportF, null],
      ['g: nicht wasserdicht mit Netzbereinigung', reportG, analysisG]
    ];

    test.each(cases)('%s', (_name, report, analysis) => {
      const expected = legacy(report, analysis);
      const v = buildVerdict(report, analysis);
      expect(v).not.toBeNull();
      expect(v.rawText).toBe(expected.text);
      expect(v.rawDetail).toBe(expected.detail);
    });

    test('ohne Report kommt null zurück', () => {
      expect(buildVerdict(null, null)).toBeNull();
      expect(buildVerdict(undefined, {})).toBeNull();
    });
  });

  describe('buildVerdict – Zustand', () => {
    test('(a) wasserdicht → ok', () => {
      expect(buildVerdict(reportA, null).state).toBe('ok');
    });
    test('(f) mit geschlossenen Körpern → partial', () => {
      expect(buildVerdict(reportF, null).state).toBe('partial');
    });
    test('(g) ohne geschlossene Körper → open', () => {
      expect(buildVerdict(reportG, analysisG).state).toBe('open');
    });
    test('Sonderfall aus der Spezifikation (Punkt 18)', () => {
      const v = buildVerdict(
        { watertight: false, solids: 2, openShells: 1, fallbackStage: 1, boundaryEdges: 3, edgeCount: 40, faceCount: 12 },
        {}
      );
      expect(v.state).toBe('partial');
      expect(v.faceted.some((f) => f.text.includes('Sicherheits-Rückfall') && f.tip)).toBe(true);
    });
  });

  describe('buildVerdict – Inhalte', () => {
    test('(a) Verrundungen werden gezählt', () => {
      const v = buildVerdict(reportA, null);
      expect(v.filletsRemoved).toBe(4);
      expect(v.converted.some((c) => c.includes('Bohrungen als echter Zylinder'))).toBe(true);
      expect(v.converted.some((c) => c.includes('scharf gemacht:'))).toBe(true);
    });

    test('(c) Netzbereinigung landet in info, Kanal-Grund in faceted', () => {
      const v = buildVerdict(reportC, analysisC);
      expect(v.info.some((i) => i.includes('Mikro-Dreiecke entfernt'))).toBe(true);
      expect(v.faceted.some((f) => f.text.includes('1 Kanal facettiert gelassen') && f.tip)).toBe(true);
    });

    test('(d) Hohlraum, gestülpte Eingabe und verworfene Schale sind getrennt', () => {
      const v = buildVerdict(reportD, null);
      expect(v.converted.some((c) => c.includes('innerer Hohlraum'))).toBe(true);
      expect(v.info.some((i) => i.includes('innen-außen gestülpt'))).toBe(true);
      expect(v.info.some((i) => i.includes('hauchdünne Schalen'))).toBe(true);
      expect(v.faceted.some((f) => f.text.includes('Sicherheits-Rückfall'))).toBe(true);
    });

    test('(e) Freiform zählt analytische Flächen', () => {
      const v = buildVerdict(reportE, null);
      expect(v.freeformUsed).toBe(true);
      expect(v.converted.some((c) => c.includes('Freiform: 7 analytische Flächen (Kugeln 2, Tori 1), 4 Facetten'))).toBe(true);
    });

    test('(f) offene Schale erscheint in faceted mit Tipp', () => {
      const v = buildVerdict(reportF, null);
      expect(v.faceted.some((f) => f.text.includes('offene Schale als Flächenmodell beigelegt') && f.tip)).toBe(true);
    });

    test('(g) offene Hülle erscheint in faceted', () => {
      const v = buildVerdict(reportG, analysisG);
      expect(v.faceted.some((f) => f.text.startsWith('offene Hülle:') && f.tip)).toBe(true);
    });

    test('Maße und Dreieckzahl kommen aus der Analyse', () => {
      const v = buildVerdict(reportB, { meta: { triangles: 2160 }, boundingBox: { width: 40, depth: 40, height: 3.5 } });
      expect(v.triangles).toBe(2160);
      expect(v.size).toEqual({ w: 40, d: 40, h: 3.5 });
      const ohne = buildVerdict(reportB, null);
      expect(ohne.triangles).toBeNull();
      expect(ohne.size).toBeNull();
    });

    test('Defeaturing-Schalter wird durchgereicht', () => {
      expect(buildVerdict(reportA, null, { defeature: false }).defeature).toBe(false);
      expect(buildVerdict(reportA, null).defeature).toBe(true);
    });
  });
});
