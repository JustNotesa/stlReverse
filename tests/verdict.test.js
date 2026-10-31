import { buildVerdict, tubeRejectNote, filletTileText } from '../verdict.js';

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
      expect(buildVerdict(reportA, null).defeature).toBe(false);   // Standard AUS (wie die UI)
    });
  });

  describe('buildVerdict – Rundungen (entfernt vs. erhalten)', () => {
    test('roundsRemoved zählt Bänder, Profilecken und Kanten-Verrundungen', () => {
      const v = buildVerdict({
        watertight: true, faceCount: 6, edgeCount: 12,
        bandsDefeatured: 2, cornersDefeatured: 1, filletsDefeatured: 3
      }, null);
      expect(v.roundsRemoved).toBe(6);
      expect(v.filletsRemoved).toBe(6);
    });

    test('coneBandsDefeatured ist in bandsDefeatured enthalten und wird nicht doppelt gezählt', () => {
      const v = buildVerdict({
        watertight: true, faceCount: 6, edgeCount: 12,
        bandsDefeatured: 4, coneBandsDefeatured: 2, cornersDefeatured: 1, filletsDefeatured: 1
      }, null);
      expect(v.roundsRemoved).toBe(6);
      expect(v.filletsRemoved).toBe(6);
    });

    test('roundsKept zählt erhaltene Teil-Zylinder und -Kegel', () => {
      const v = buildVerdict({
        watertight: true, faceCount: 6, edgeCount: 12, arcCylinders: 2, arcCones: 1
      }, null);
      expect(v.roundsKept).toBe(3);
      expect(v.roundsRemoved).toBe(0);
    });

    test('ohne Rundungen sind beide Zähler 0', () => {
      const v = buildVerdict(reportB, null);
      expect(v.roundsRemoved).toBe(0);
      expect(v.roundsKept).toBe(0);
    });
  });

  describe('buildVerdict – Lochrand-Rundungen und echte Fasen', () => {
    // Washer mit verrundetem Lochrand: die Randbänder gehen in der Bohrungs-/Mantel-Umwandlung
    // auf (Chamfer-Zone). Der Export meldet je Zone, was sie war:
    //   `rimFilletsToChamfer` = Rundung (Normalen streuen) → als Fase (Kegel) geschrieben
    //   `rimChamfersKept`     = echte Fase (Normalen gleich)  → bleibt Kegel
    // Beides ist KEINE entfernte Verrundung — eine Rundung wurde in eine Fase umgewandelt.
    const rimReport = (extra) => ({
      watertight: true,
      faceCount: 6,
      edgeCount: 12,
      bandsDefeatured: 0,
      cornersDefeatured: 0,
      filletsDefeatured: 0,
      ...extra
    });

    test('(a) rimFilletsToChamfer: eigener Chip + Kachel „2 → Fase“, zählt nicht als entfernt', () => {
      const v = buildVerdict(rimReport({ rimFilletsToChamfer: 2 }), null, { defeature: true });
      expect(v.rimToChamfer).toBe(2);
      expect(v.roundsRemoved).toBe(0);
      expect(v.filletsRemoved).toBe(0);
      expect(v.converted).toContain('2 Lochrand-Rundungen als Fase (Kegel) geschrieben');
      expect(filletTileText(v)).toBe('2 → Fase');
    });

    test('(b) rimChamfersKept: eigener Chip — echte Fasen zählen NICHT als Verrundung', () => {
      const v = buildVerdict(rimReport({ rimChamfersKept: 2 }), null, { defeature: true });
      expect(v.rimChamfersKept).toBe(2);
      expect(v.roundsRemoved).toBe(0);
      expect(v.filletsRemoved).toBe(0);
      expect(v.converted).toContain('2 Fasen als echte Kegel');
      expect(filletTileText(v)).toBe('keine gezählt');
    });

    test('(c) ohne die Felder bleiben alle Zähler 0', () => {
      const v = buildVerdict(rimReport(), null, { defeature: true });
      expect(v.rimToChamfer).toBe(0);
      expect(v.rimChamfersKept).toBe(0);
      expect(v.roundsRemoved).toBe(0);
      expect(v.filletsRemoved).toBe(0);
      expect(filletTileText(v)).toBe('keine gezählt');
      expect(v.converted.some((c) => c.includes('Lochrand'))).toBe(false);
    });

    test('(d) rawText und rawDetail bleiben mit und ohne die Felder gleich', () => {
      const ohne = buildVerdict(rimReport(), null);
      const mit = buildVerdict(rimReport({ rimFilletsToChamfer: 2, rimChamfersKept: 2 }), null);
      expect(mit.rawText).toBe(ohne.rawText);
      expect(mit.rawDetail).toBe(ohne.rawDetail);
    });

    test('(e) Lochrand-Rundungen stehen NICHT im „scharf gemacht:“-Text', () => {
      const v = buildVerdict(rimReport({ rimFilletsToChamfer: 2, bandsDefeatured: 1 }), null, { defeature: true });
      const scharf = v.converted.find((c) => c.startsWith('scharf gemacht:'));
      expect(scharf).toBeTruthy();
      expect(scharf).not.toContain('Lochrand');
      expect(v.converted.filter((c) => c.includes('Lochrand'))).toHaveLength(1);
    });

    test('(f) Singular: „1 Lochrand-Rundung …“ / „1 Fase als echter Kegel“', () => {
      const v = buildVerdict(rimReport({ rimFilletsToChamfer: 1, rimChamfersKept: 1 }), null, { defeature: true });
      expect(v.converted).toContain('1 Lochrand-Rundung als Fase (Kegel) geschrieben');
      expect(v.converted).toContain('1 Fase als echter Kegel');
      expect(filletTileText(v)).toBe('1 → Fase');
    });

    test('(g) Kachel verbindet „entfernt“ / „→ Fase“ / „bleiben rund“ mit Komma', () => {
      const v = buildVerdict(rimReport({ bandsDefeatured: 3, rimFilletsToChamfer: 2, arcCylinders: 1 }), null, { defeature: true });
      expect(v.roundsRemoved).toBe(3);
      expect(filletTileText(v)).toBe('3 entfernt, 2 → Fase, 1 bleiben rund');
    });
  });

  describe('buildVerdict – überwiegend facettiert', () => {
    const analysisTri = (triangles) => ({ meta: { triangles } });

    test('Dino-ähnlich (3861 Flächen aus 3938 Dreiecken) → true, mit Hinweis', () => {
      const v = buildVerdict({ watertight: true, faceCount: 3861, edgeCount: 7722 }, analysisTri(3938));
      expect(v.mostlyFaceted).toBe(true);
      const eintrag = v.faceted.find((f) => f.text.includes('3861 von 3938 Dreiecken blieben einzelne Flächen'));
      expect(eintrag).toBeTruthy();
      expect(eintrag.tip).toBeTruthy();
      expect(eintrag.text).toContain('organische Form, keine erkennbare Geometrie');
    });

    test('Washer (6 Flächen aus 2160 Dreiecken) → false', () => {
      const v = buildVerdict({ watertight: true, faceCount: 6, edgeCount: 12 }, analysisTri(2160));
      expect(v.mostlyFaceted).toBe(false);
      expect(v.faceted.some((f) => f.text.includes('Dreiecken blieben einzelne Flächen'))).toBe(false);
    });

    test('Würfel (6 Flächen aus 12 Dreiecken) → false (zu wenige Flächen)', () => {
      const v = buildVerdict({ watertight: true, faceCount: 6, edgeCount: 12 }, analysisTri(12));
      expect(v.mostlyFaceted).toBe(false);
    });

    test('ohne Dreieckzahl ist kein Facetten-Urteil möglich', () => {
      const v = buildVerdict({ watertight: true, faceCount: 3861, edgeCount: 7722 }, null);
      expect(v.mostlyFaceted).toBe(false);
      expect(v.triangles).toBeNull();
    });

    test('nicht wasserdicht → kein Facetten-Urteil', () => {
      const v = buildVerdict({ watertight: false, faceCount: 3861, edgeCount: 7722, solids: 0 }, analysisTri(3938));
      expect(v.mostlyFaceted).toBe(false);
    });

    test('Freiform: mehr Facetten als die Hälfte der Flächen → true, Text nennt ff.facet', () => {
      const v = buildVerdict({
        watertight: true, faceCount: 12, edgeCount: 24,
        freeform: { used: true, faces: { plane: 2, cylinder: 1, facet: 9 } }
      }, analysisTri(30));
      expect(v.mostlyFaceted).toBe(true);
      const eintrag = v.faceted.find((f) => f.text.includes('9 von 12 Flächen bleiben einzelne Facetten'));
      expect(eintrag).toBeTruthy();
      expect(eintrag.tip).toContain('Freiform-Erkennung');
    });

    test('Freiform mit wenigen Facetten → false', () => {
      const v = buildVerdict(reportE, analysisTri(40));
      expect(v.mostlyFaceted).toBe(false);
    });
  });

  // Berührflächen-Reparatur (mesh-repair.js): zwei Körper, die sich flächig berühren, tragen
  // die Kontaktfläche doppelt. Die Reparatur verschweißt sie — das gehört ins Verdikt.
  describe('buildVerdict – Berührflächen-Reparatur', () => {
    const dicht = { watertight: true, faceCount: 6, edgeCount: 12 };
    const mitRepair = (repair) => ({ meshClean: { removedTris: 0, minDetailMm: 0.02, repair } });

    test('(a) 866 Berührkanten / 416 Kontaktflächen stehen im Rohtext und in info', () => {
      const v = buildVerdict(dicht, mitRepair({ nonManifoldEdges: 866, nonManifoldEdgesAfter: 0, contactPairs: 416 }));
      expect(v.rawDetail).toContain('866 Berührkanten verschweißt (416 doppelte Kontaktflächen zweier sich berührender Körper entfernt)');
      expect(v.info.some((i) => i.includes('866 Berührkanten verschweißt (416 doppelte Kontaktflächen zweier sich berührender Körper entfernt)'))).toBe(true);
    });

    test('(b) Singular: „1 Berührkante verschweißt (1 doppelte Kontaktfläche …)"', () => {
      const v = buildVerdict(dicht, mitRepair({ nonManifoldEdges: 1, nonManifoldEdgesAfter: 0, contactPairs: 1 }));
      expect(v.rawDetail).toContain('1 Berührkante verschweißt (1 doppelte Kontaktfläche zweier sich berührender Körper entfernt)');
      expect(v.info.some((i) => i.includes('1 Berührkante verschweißt (1 doppelte Kontaktfläche zweier sich berührender Körper entfernt)'))).toBe(true);
    });

    test('(c) ohne Kontaktpaare: kein „Berührkante" irgendwo', () => {
      const v = buildVerdict(dicht, mitRepair({ nonManifoldEdges: 0, nonManifoldEdgesAfter: 0, contactPairs: 0 }));
      expect(v.rawDetail).not.toContain('Berührkante');
      expect(v.info.some((i) => i.includes('Berührkante'))).toBe(false);
      expect(JSON.stringify(v)).not.toContain('Berührkante');
    });

    test('(d) nicht wasserdicht: Netzbereinigung und Berührflächen mit „ · " verbunden', () => {
      const offen = { watertight: false, faceCount: 20, edgeCount: 40, solids: 0, boundaryEdges: 4 };
      const v = buildVerdict(offen, {
        meshClean: { removedTris: 3, minDetailMm: 0.02, repair: { nonManifoldEdges: 2, nonManifoldEdgesAfter: 0, contactPairs: 1 } }
      });
      expect(v.rawDetail).toBe('3 Mikro-Dreiecke entfernt (Kanten < 0,02 mm) · 2 Berührkanten verschweißt (1 doppelte Kontaktfläche zweier sich berührender Körper entfernt)');
    });
  });
});
