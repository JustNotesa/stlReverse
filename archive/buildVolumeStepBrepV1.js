/**
 * ARCHIVED — buildVolumeStepBrepV1
 *
 * Original-Strategie: Aus `analysis.planes` axis-aligned Rechteck-Flächen bauen,
 * `analysis.cylinders` / `analysis.cones` als Löcher bzw. separate Solids anhängen.
 *
 * Warum archiviert (2026-04-20):
 *   - Die zugrundeliegende Feature-Detection (`analysis.cylinders`, `analysis.cones`,
 *     `analysis.planes` etc.) ist hinter `RUN_V3BETA=false` stillgelegt und wurde
 *     nie produktiv aktiviert — die Arrays sind zur Laufzeit leer. V1 gibt dann
 *     immer `null` zurück.
 *   - Der Ansatz "Rechteck pro Plane + Bohrungen als Loch" passt nicht zu realen
 *     Meshes mit gekrümmten Flächen und nicht-axis-aligned Features.
 *
 * Warum behalten (statt löschen):
 *   - Die Seam-Vertex + Circle-Edge + ManifoldSolidBrep-Logik für Zylinder ist
 *     sauber und ggf. wiederverwendbar, falls V2 später echte Primitiv-Erkennung
 *     bekommt (siehe segmentation.js, "parkend").
 *
 * Abhängigkeiten: utils.js (normalizeVector wird intern als normVec neu definiert,
 *   also keine externen Dependencies).
 *
 * NICHT importieren — dient nur als Referenz.
 */

function computeRectCornersForPlane(plane) {
  const { offsetAxis, offsetCoordinate, spans, normal } = plane;
  if (!plane.axisAligned || !spans || spans.length < 2) return null;

  const sm = {};
  spans.forEach((s) => { sm[s.axis] = s; });
  const v = offsetCoordinate;

  if (offsetAxis === 'Z') {
    const xMin = sm.X?.min ?? 0, xMax = sm.X?.max ?? 1;
    const yMin = sm.Y?.min ?? 0, yMax = sm.Y?.max ?? 1;
    return normal[2] >= 0
      // +Z outward: CCW from above
      ? [[xMin, yMin, v], [xMax, yMin, v], [xMax, yMax, v], [xMin, yMax, v]]
      // -Z outward: CCW from below
      : [[xMin, yMin, v], [xMin, yMax, v], [xMax, yMax, v], [xMax, yMin, v]];
  }
  if (offsetAxis === 'Y') {
    const xMin = sm.X?.min ?? 0, xMax = sm.X?.max ?? 1;
    const zMin = sm.Z?.min ?? 0, zMax = sm.Z?.max ?? 1;
    return normal[1] >= 0
      // +Y outward
      ? [[xMax, v, zMin], [xMin, v, zMin], [xMin, v, zMax], [xMax, v, zMax]]
      // -Y outward
      : [[xMin, v, zMin], [xMax, v, zMin], [xMax, v, zMax], [xMin, v, zMax]];
  }
  if (offsetAxis === 'X') {
    const yMin = sm.Y?.min ?? 0, yMax = sm.Y?.max ?? 1;
    const zMin = sm.Z?.min ?? 0, zMax = sm.Z?.max ?? 1;
    return normal[0] >= 0
      // +X outward
      ? [[v, yMin, zMin], [v, yMax, zMin], [v, yMax, zMax], [v, yMin, zMax]]
      // -X outward
      : [[v, yMin, zMin], [v, yMin, zMax], [v, yMax, zMax], [v, yMax, zMin]];
  }
  return null;
}

export function buildVolumeStepBrepV1(analysis) {
  // Require at least 4 axis-aligned planes for a meaningful solid.
  // Use gap-detection to separate large structural faces from small tessellation fragments:
  //   Sort detected planes by area descending, find the largest relative drop between
  //   consecutive areas → that gap separates "real faces" from "cylinder/cone side facets".
  const allAxisPlanes = (analysis?.planes || []).filter((p) => p.axisAligned && (p.area || 0) >= 0.5);
  if (allAxisPlanes.length < 4) return null;
  const sortedAreas = [...allAxisPlanes.map((p) => p.area)].sort((a, b) => b - a);
  let bestGapIdx = sortedAreas.length; // default: keep all
  let bestGapRatio = 1;
  for (let i = 1; i < sortedAreas.length; i++) {
    const ratio = sortedAreas[i - 1] / Math.max(sortedAreas[i], 0.001);
    if (ratio > Math.max(bestGapRatio, 1.5)) { // require at least 1.5× drop to be meaningful
      bestGapRatio = ratio;
      bestGapIdx = i;
    }
  }
  const areaThreshold = bestGapIdx < sortedAreas.length
    ? (sortedAreas[bestGapIdx - 1] + sortedAreas[bestGapIdx]) / 2
    : 0.5;
  const rawPlanes = allAxisPlanes.filter((p) => p.area >= areaThreshold);
  if (rawPlanes.length < 4) return null;

  // Compute corners; discard planes where corner computation fails
  const planeFaces = rawPlanes
    .map((p) => ({ plane: p, corners: computeRectCornersForPlane(p) }))
    .filter((f) => f.corners !== null);
  if (planeFaces.length < 4) return null;

  // ---- Entity builder infrastructure (same pattern as buildVolumeStepBrep) ----
  const entities = [];
  let id = 1;

  const toStep = (value) => {
    if (!Number.isFinite(value)) return '0.';
    const trimmed = Number(value).toFixed(6).replace(/(\.\d*?)0+$/, '$1');
    return trimmed.includes('.') ? trimmed : trimmed + '.';
  };

  const addPoint = (pt) => {
    const pid = id++;
    entities.push(`#${pid}=CARTESIAN_POINT('',(${pt.map(toStep).join(',')}));`);
    return pid;
  };
  const addDirection = (vec) => {
    const len = Math.hypot(vec[0], vec[1], vec[2]) || 1;
    const d = vec.map((v) => v / len || 0);
    const did = id++;
    entities.push(`#${did}=DIRECTION('',(${d.map(toStep).join(',')}));`);
    return did;
  };
  const addVector = (dirId, mag) => {
    const vid = id++;
    entities.push(`#${vid}=VECTOR('',#${dirId},${toStep(mag)});`);
    return vid;
  };
  const addAxis2Placement3D = (loc, axis, refDir) => {
    const locId = addPoint(loc);
    const axId = addDirection(axis);
    const refId = addDirection(refDir);
    const pid = id++;
    entities.push(`#${pid}=AXIS2_PLACEMENT_3D('',#${locId},#${axId},#${refId});`);
    return pid;
  };
  const addVertex = (ptId) => {
    const vid = id++;
    entities.push(`#${vid}=VERTEX_POINT('',#${ptId});`);
    return vid;
  };
  const addLine = (ptId, vecId) => {
    const lid = id++;
    entities.push(`#${lid}=LINE('',#${ptId},#${vecId});`);
    return lid;
  };
  const addCircle = (placementId, radius) => {
    const cid = id++;
    entities.push(`#${cid}=CIRCLE('',#${placementId},${toStep(radius)});`);
    return cid;
  };
  const addPlane = (placementId) => {
    const pid = id++;
    entities.push(`#${pid}=PLANE('',#${placementId});`);
    return pid;
  };
  const addCylindricalSurface = (placementId, radius) => {
    const sid = id++;
    entities.push(`#${sid}=CYLINDRICAL_SURFACE('',#${placementId},${toStep(radius)});`);
    return sid;
  };
  const addConicalSurface = (placementId, radius, semiAngle) => {
    const sid = id++;
    entities.push(`#${sid}=CONICAL_SURFACE('',#${placementId},${toStep(radius)},${toStep(semiAngle)});`);
    return sid;
  };
  const addEdgeCurve = (sv, ev, curveId, sameSense = true) => {
    const eid = id++;
    entities.push(`#${eid}=EDGE_CURVE('',#${sv},#${ev},#${curveId},.${sameSense ? 'T' : 'F'}.);`);
    return eid;
  };
  const addOrientedEdge = (edgeCurveId, orientation = true) => {
    const oid = id++;
    entities.push(`#${oid}=ORIENTED_EDGE('',*,*,#${edgeCurveId},.${orientation ? 'T' : 'F'}.);`);
    return oid;
  };
  const addEdgeLoop = (orientedEdgeIds) => {
    const lid = id++;
    entities.push(`#${lid}=EDGE_LOOP('',(${orientedEdgeIds.map((e) => `#${e}`).join(',')}));`);
    return lid;
  };
  const addFaceOuterBound = (loopId, orientation = true) => {
    const bid = id++;
    entities.push(`#${bid}=FACE_OUTER_BOUND('',#${loopId},.${orientation ? 'T' : 'F'}.);`);
    return bid;
  };
  const addFaceBound = (loopId, orientation = true) => {
    const bid = id++;
    entities.push(`#${bid}=FACE_BOUND('',#${loopId},.${orientation ? 'T' : 'F'}.);`);
    return bid;
  };
  const addAdvancedFace = (boundIds, surfaceId, sameSense = true) => {
    const fid = id++;
    entities.push(`#${fid}=ADVANCED_FACE('',(${boundIds.map((b) => `#${b}`).join(',')}),#${surfaceId},.${sameSense ? 'T' : 'F'}.);`);
    return fid;
  };
  const addClosedShell = (faceIds) => {
    const sid = id++;
    entities.push(`#${sid}=CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}));`);
    return sid;
  };
  const addManifoldSolidBrep = (shellId, name = '') => {
    const bid = id++;
    entities.push(`#${bid}=MANIFOLD_SOLID_BREP('${name}',#${shellId});`);
    return bid;
  };

  const computeRefDir = (axis) => {
    const ax = Math.abs(axis[0]), ay = Math.abs(axis[1]), az = Math.abs(axis[2]);
    let ref = ax <= ay && ax <= az ? [1, 0, 0] : ay <= ax && ay <= az ? [0, 1, 0] : [0, 0, 1];
    const cross = [
      axis[1] * ref[2] - axis[2] * ref[1],
      axis[2] * ref[0] - axis[0] * ref[2],
      axis[0] * ref[1] - axis[1] * ref[0]
    ];
    const len = Math.hypot(cross[0], cross[1], cross[2]) || 1;
    return [cross[0] / len, cross[1] / len, cross[2] / len];
  };

  // ---- Step 1: Point registry (dedup vertices) ----
  const ptRegistry = new Map(); // "x,y,z" → { ptId, vtxId }
  const ptKey = (p) => p.map((v) => Number(v).toFixed(4)).join(',');
  const getVertex = (pt) => {
    const key = ptKey(pt);
    if (!ptRegistry.has(key)) {
      const ptId = addPoint(pt);
      const vtxId = addVertex(ptId);
      ptRegistry.set(key, { ptId, vtxId });
    }
    return ptRegistry.get(key);
  };

  // ---- Step 2: Edge registry (dedup shared edges) ----
  // Canonical edge key: smaller ptKey always first → consistent direction for dedup
  const edgeRegistry = new Map(); // canonicalKey → { start, end, stepEdgeId, startVtxId, endVtxId }
  const edgeKey = (p1, p2) => {
    const k1 = ptKey(p1), k2 = ptKey(p2);
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  };

  // Register all edges from all face loops (without creating STEP entities yet)
  for (const { corners } of planeFaces) {
    for (let i = 0; i < corners.length; i++) {
      const p1 = corners[i], p2 = corners[(i + 1) % corners.length];
      const key = edgeKey(p1, p2);
      if (!edgeRegistry.has(key)) {
        // Canonical direction: p1 before p2 in lexicographic order
        const k1 = ptKey(p1), k2 = ptKey(p2);
        const [canonStart, canonEnd] = k1 < k2 ? [p1, p2] : [p2, p1];
        edgeRegistry.set(key, { start: canonStart, end: canonEnd, stepEdgeId: null, usageCount: 0 });
      }
      edgeRegistry.get(key).usageCount++;
    }
  }

  // Check: each edge must be used by exactly 2 faces for a valid closed shell
  // Edges used only once indicate an open boundary → warn but continue
  let openEdges = 0;
  for (const edge of edgeRegistry.values()) {
    if (edge.usageCount !== 2) openEdges++;
  }
  if (openEdges > 0) {
    console.warn(`V1 BRep: ${openEdges} open edges detected — shell may be incomplete. Falling back.`);
    return null;
  }

  // Create STEP EDGE_CURVE entities for all unique edges
  for (const edge of edgeRegistry.values()) {
    const { vtxId: sv } = getVertex(edge.start);
    const { vtxId: ev } = getVertex(edge.end);
    const { ptId: startPtId } = ptRegistry.get(ptKey(edge.start));
    const dir = [edge.end[0] - edge.start[0], edge.end[1] - edge.start[1], edge.end[2] - edge.start[2]];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const dirId = addDirection(dir);
    const vecId = addVector(dirId, len);
    const lineId = addLine(startPtId, vecId);
    edge.stepEdgeId = addEdgeCurve(sv, ev, lineId, true);
  }

  // ---- Step 3: Build cylinder through-hole data ----
  // For each axis-aligned cylinder: find which two planes cap it, prepare circle edges
  const cylinders = (analysis.cylinders || []).filter((c) => c.radius > 0.1 && c.length > 0.1);
  const { normalizeVector: normVec } = { normalizeVector: (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); } };

  // Map: planeIndex → array of hole data { circleTopEdgeId, circleBottomEdgeId, center, radius, refDir }
  const planeHoles = new Map(); // planeIndex → [{...}]

  for (const cyl of cylinders) {
    const cylAxis = normVec(cyl.axisVector || [0, 0, 1]);
    const isZAxis = Math.abs(cylAxis[2]) > 0.9;
    const isYAxis = Math.abs(cylAxis[1]) > 0.9;
    const isXAxis = Math.abs(cylAxis[0]) > 0.9;
    if (!isZAxis && !isYAxis && !isXAxis) continue; // skip oblique cylinders for now

    // Find which planes are the caps of this cylinder
    // A plane is a cap if: same normal axis as cylinder, AND cylinder center projects onto the plane at ≈ plane offset
    const halfLen = cyl.length / 2;
    const capCandidates = [];

    planeFaces.forEach(({ plane, corners }, pi) => {
      if (!plane.axisAligned) return;
      const sameAxis = (isZAxis && plane.offsetAxis === 'Z') ||
                       (isYAxis && plane.offsetAxis === 'Y') ||
                       (isXAxis && plane.offsetAxis === 'X');
      if (!sameAxis) return;

      const axIdx = isZAxis ? 2 : isYAxis ? 1 : 0;
      const cylCapCoord = cyl.center[['x', 'y', 'z'][axIdx]];
      const planeCoord = plane.offsetCoordinate;
      const distToBottomCap = Math.abs(planeCoord - (cylCapCoord - halfLen));
      const distToTopCap = Math.abs(planeCoord - (cylCapCoord + halfLen));

      if (distToBottomCap < cyl.length * 0.15 || distToTopCap < cyl.length * 0.15) {
        capCandidates.push({
          pi,
          plane,
          corners,
          isTop: distToTopCap < distToBottomCap
        });
      }
    });

    if (capCandidates.length < 2) continue; // can't form a through-hole without 2 caps

    // Create seam vertex and circular edges for this cylinder
    const refDir = computeRefDir(cylAxis);
    const bottomCapPlane = capCandidates.find((c) => !c.isTop) || capCandidates[0];
    const topCapPlane = capCandidates.find((c) => c.isTop) || capCandidates[1];

    const axIdx = isZAxis ? 2 : isYAxis ? 1 : 0;
    const cx = cyl.center.x, cy = cyl.center.y, cz = cyl.center.z;
    const bottomZ = bottomCapPlane.plane.offsetCoordinate;
    const topZ = topCapPlane.plane.offsetCoordinate;

    const [bottomCenterPt, topCenterPt] = isZAxis
      ? [[cx, cy, bottomZ], [cx, cy, topZ]]
      : isYAxis
        ? [[cx, bottomZ, cz], [cx, topZ, cz]]
        : [[bottomZ, cy, cz], [topZ, cy, cz]];

    const seamBottomPt = [
      bottomCenterPt[0] + refDir[0] * cyl.radius,
      bottomCenterPt[1] + refDir[1] * cyl.radius,
      bottomCenterPt[2] + refDir[2] * cyl.radius
    ];
    const seamTopPt = [
      topCenterPt[0] + refDir[0] * cyl.radius,
      topCenterPt[1] + refDir[1] * cyl.radius,
      topCenterPt[2] + refDir[2] * cyl.radius
    ];

    const { ptId: seamBottomPtId, vtxId: seamBottomVtxId } = getVertex(seamBottomPt);
    const { ptId: seamTopPtId, vtxId: seamTopVtxId } = getVertex(seamTopPt);

    // Bottom circle (at cap plane with normal pointing inward = -cylAxis direction)
    const bottomPlacementId = addAxis2Placement3D(bottomCenterPt, cylAxis, refDir);
    const bottomCircleId = addCircle(bottomPlacementId, cyl.radius);
    const bottomCircleEdgeId = addEdgeCurve(seamBottomVtxId, seamBottomVtxId, bottomCircleId, true);

    // Top circle
    const topPlacementId = addAxis2Placement3D(topCenterPt, cylAxis, refDir);
    const topCircleId = addCircle(topPlacementId, cyl.radius);
    const topCircleEdgeId = addEdgeCurve(seamTopVtxId, seamTopVtxId, topCircleId, true);

    // Seam edge (line along cylinder axis between the two seam points)
    const seamDirLen = Math.hypot(
      seamTopPt[0] - seamBottomPt[0],
      seamTopPt[1] - seamBottomPt[1],
      seamTopPt[2] - seamBottomPt[2]
    );
    const seamDirId = addDirection(cylAxis);
    const seamVecId = addVector(seamDirId, seamDirLen);
    const seamLineId = addLine(seamBottomPtId, seamVecId);
    const seamEdgeId = addEdgeCurve(seamBottomVtxId, seamTopVtxId, seamLineId, true);

    // Register hole data for both cap planes
    const holeData = {
      bottomCircleEdgeId,
      topCircleEdgeId,
      seamEdgeId,
      bottomCenterPt,
      topCenterPt,
      cylAxis,
      refDir,
      radius: cyl.radius,
      length: Math.abs(topZ - bottomZ),
      bottomPi: bottomCapPlane.pi,
      topPi: topCapPlane.pi
    };

    if (!planeHoles.has(bottomCapPlane.pi)) planeHoles.set(bottomCapPlane.pi, []);
    if (!planeHoles.has(topCapPlane.pi)) planeHoles.set(topCapPlane.pi, []);
    planeHoles.get(bottomCapPlane.pi).push({ ...holeData, isBottom: true });
    planeHoles.get(topCapPlane.pi).push({ ...holeData, isBottom: false });
  }

  // ---- Step 4: Build ADVANCED_FACEs for all planes ----
  const allSolidFaceIds = [];

  planeFaces.forEach(({ plane, corners }, pi) => {
    const orientedEdgeIds = [];
    for (let i = 0; i < corners.length; i++) {
      const p1 = corners[i], p2 = corners[(i + 1) % corners.length];
      const key = edgeKey(p1, p2);
      const edge = edgeRegistry.get(key);
      if (!edge) {
        console.warn('V1 BRep: missing edge in registry — topology incomplete');
        return;
      }
      // Forward if this traversal matches the canonical (stored) direction
      const forward = ptKey(p1) === ptKey(edge.start);
      orientedEdgeIds.push(addOrientedEdge(edge.stepEdgeId, forward));
    }
    if (orientedEdgeIds.length !== corners.length) return;

    const loopId = addEdgeLoop(orientedEdgeIds);
    const outerBoundId = addFaceOuterBound(loopId, true);
    const boundIds = [outerBoundId];

    // Add inner bounds for cylinder holes in this face
    const holes = planeHoles.get(pi) || [];
    for (const hole of holes) {
      const circleEdgeId = hole.isBottom ? hole.bottomCircleEdgeId : hole.topCircleEdgeId;
      // Inner loop: hole circle, reversed relative to outer loop's orientation
      // For a planar face with outward normal in +axis direction:
      // hole boundary must be CW when viewed from outside = forward:false on the circle edge
      const innerOe = addOrientedEdge(circleEdgeId, false);
      const innerLoopId = addEdgeLoop([innerOe]);
      boundIds.push(addFaceBound(innerLoopId, false));
    }

    const normal = plane.normal;
    const centroidArr = [plane.centroid.x, plane.centroid.y, plane.centroid.z];
    const refDir = computeRefDir(normal);
    const placementId = addAxis2Placement3D(centroidArr, normal, refDir);
    const planeId = addPlane(placementId);
    allSolidFaceIds.push(addAdvancedFace(boundIds, planeId, true));
  });

  // ---- Step 5: Build cylindrical faces for through-holes ----
  const processedCylHoles = new Set();
  for (const holes of planeHoles.values()) {
    for (const hole of holes) {
      // Use a key to process each cylinder only once
      const cylKey = `${ptKey(hole.bottomCenterPt)}|${ptKey(hole.topCenterPt)}|${hole.radius.toFixed(4)}`;
      if (processedCylHoles.has(cylKey)) continue;
      processedCylHoles.add(cylKey);

      const { bottomCircleEdgeId, topCircleEdgeId, seamEdgeId, bottomCenterPt, cylAxis, refDir, radius } = hole;
      const cylPlacementId = addAxis2Placement3D(bottomCenterPt, cylAxis, refDir);
      const cylSurfaceId = addCylindricalSurface(cylPlacementId, radius);
      // Cylindrical face: bottom circle forward → seam up → top circle reversed → seam down
      const cylLoopId = addEdgeLoop([
        addOrientedEdge(bottomCircleEdgeId, false), // reversed: inner surface
        addOrientedEdge(seamEdgeId, true),
        addOrientedEdge(topCircleEdgeId, true),
        addOrientedEdge(seamEdgeId, false)
      ]);
      const cylBoundId = addFaceOuterBound(cylLoopId, true);
      allSolidFaceIds.push(addAdvancedFace([cylBoundId], cylSurfaceId, false)); // sameSense=false: inner surface
    }
  }

  if (allSolidFaceIds.length < 4) return null;

  // ---- Step 6: Assemble main solid ----
  const shellId = addClosedShell(allSolidFaceIds);
  const mainSolidId = addManifoldSolidBrep(shellId, 'Reconstructed');

  // Additional solids: cylinders not integrated as through-holes
  const integratedCylKeys = new Set(processedCylHoles);
  const extraSolidIds = [];

  for (const cyl of cylinders) {
    const cylAxis = normVec(cyl.axisVector || [0, 0, 1]);
    const isZAxis = Math.abs(cylAxis[2]) > 0.9;
    const isYAxis = Math.abs(cylAxis[1]) > 0.9;
    const isXAxis = Math.abs(cylAxis[0]) > 0.9;
    if (!isZAxis && !isYAxis && !isXAxis) {
      // Oblique cylinders are skipped: V1 handles only axis-aligned cylinders.
      // Oblique ones require PCA-based placement and are handled by buildCylinderBrep separately.
      continue;
    }
    // Check if this cylinder was integrated as a through-hole
    const halfLen = cyl.length / 2;
    const axIdx = isZAxis ? 2 : isYAxis ? 1 : 0;
    const axNames = ['x', 'y', 'z'];
    const centerCoord = cyl.center[axNames[axIdx]];
    const bPt = isZAxis
      ? [cyl.center.x, cyl.center.y, centerCoord - halfLen]
      : isYAxis
        ? [cyl.center.x, centerCoord - halfLen, cyl.center.z]
        : [centerCoord - halfLen, cyl.center.y, cyl.center.z];
    const tPt = isZAxis
      ? [cyl.center.x, cyl.center.y, centerCoord + halfLen]
      : isYAxis
        ? [cyl.center.x, centerCoord + halfLen, cyl.center.z]
        : [centerCoord + halfLen, cyl.center.y, cyl.center.z];
    const cylKey = `${ptKey(bPt)}|${ptKey(tPt)}|${cyl.radius.toFixed(4)}`;
    if (integratedCylKeys.has(cylKey)) continue;
    // Not integrated → add as standalone cylinder solid (inline buildCylinderBrep)
    const refDir = computeRefDir(cylAxis);
    const seamBot = [bPt[0] + refDir[0] * cyl.radius, bPt[1] + refDir[1] * cyl.radius, bPt[2] + refDir[2] * cyl.radius];
    const seamTop = [tPt[0] + refDir[0] * cyl.radius, tPt[1] + refDir[1] * cyl.radius, tPt[2] + refDir[2] * cyl.radius];
    const { ptId: sботPtId, vtxId: sBotVtxId } = getVertex(seamBot);
    const { ptId: sTopPtId, vtxId: sTopVtxId } = getVertex(seamTop);
    const botPl = addAxis2Placement3D(bPt, cylAxis, refDir);
    const botCirc = addCircle(botPl, cyl.radius);
    const topPl = addAxis2Placement3D(tPt, cylAxis, refDir);
    const topCirc = addCircle(topPl, cyl.radius);
    const sd = cylAxis, sdId = addDirection(sd), svId = addVector(sdId, cyl.length);
    const slId = addLine(sботPtId, svId);
    const botEdge = addEdgeCurve(sBotVtxId, sBotVtxId, botCirc, true);
    const topEdge = addEdgeCurve(sTopVtxId, sTopVtxId, topCirc, true);
    const seamE = addEdgeCurve(sBotVtxId, sTopVtxId, slId, true);
    // Bottom cap face
    const bfLoop = addEdgeLoop([addOrientedEdge(botEdge, false)]);
    const bfBound = addFaceOuterBound(bfLoop, true);
    const bfPl = addAxis2Placement3D(bPt, [-cylAxis[0], -cylAxis[1], -cylAxis[2]], refDir);
    const bfPlane = addPlane(bfPl);
    const bfFace = addAdvancedFace([bfBound], bfPlane, true);
    // Top cap face
    const tfLoop = addEdgeLoop([addOrientedEdge(topEdge, true)]);
    const tfBound = addFaceOuterBound(tfLoop, true);
    const tfPl = addAxis2Placement3D(tPt, cylAxis, refDir);
    const tfPlane = addPlane(tfPl);
    const tfFace = addAdvancedFace([tfBound], tfPlane, true);
    // Lateral cylindrical face
    const cylPl2 = addAxis2Placement3D(bPt, cylAxis, refDir);
    const cylSurf2 = addCylindricalSurface(cylPl2, cyl.radius);
    const cylLoop2 = addEdgeLoop([
      addOrientedEdge(botEdge, true), addOrientedEdge(seamE, true),
      addOrientedEdge(topEdge, false), addOrientedEdge(seamE, false)
    ]);
    const cylBound2 = addFaceOuterBound(cylLoop2, true);
    const cylFace2 = addAdvancedFace([cylBound2], cylSurf2, true);
    const cylShell = addClosedShell([bfFace, tfFace, cylFace2]);
    extraSolidIds.push(addManifoldSolidBrep(cylShell, 'Cylinder'));
  }

  // ---- Step 6b: Cone solids (axis-aligned) ----
  for (const cone of (analysis.cones || [])) {
    const coneAxis = normVec(cone.axisVector || [0, 0, 1]);
    const isZAxis = Math.abs(coneAxis[2]) > 0.9;
    const isYAxis = Math.abs(coneAxis[1]) > 0.9;
    const isXAxis = Math.abs(coneAxis[0]) > 0.9;
    if (!isZAxis && !isYAxis && !isXAxis) continue; // oblique cones skipped in V1

    const halfLen = cone.length / 2;
    const axNames = ['x', 'y', 'z'];
    const axIdx = isZAxis ? 2 : isYAxis ? 1 : 0;
    const centerCoord = cone.center[axNames[axIdx]];
    const bPt = isZAxis
      ? [cone.center.x, cone.center.y, centerCoord - halfLen]
      : isYAxis
        ? [cone.center.x, centerCoord - halfLen, cone.center.z]
        : [centerCoord - halfLen, cone.center.y, cone.center.z];
    const tPt = isZAxis
      ? [cone.center.x, cone.center.y, centerCoord + halfLen]
      : isYAxis
        ? [cone.center.x, centerCoord + halfLen, cone.center.z]
        : [centerCoord + halfLen, cone.center.y, cone.center.z];

    const rBottom = cone.radiusBottom;
    const rTop = cone.radiusTop;
    const length = cone.length;
    const semiAngle = Math.atan(Math.abs(rBottom - rTop) / length);
    const isPointyTop = rTop < 0.001;
    const isPointyBottom = rBottom < 0.001;
    const refDir = computeRefDir(coneAxis);
    const faceIds = [];

    if (isPointyTop) {
      // Pointed top: apex at tPt, base circle at bPt
      const seamBot = [bPt[0] + refDir[0] * rBottom, bPt[1] + refDir[1] * rBottom, bPt[2] + refDir[2] * rBottom];
      const { ptId: seamBotPtId, vtxId: seamBotVtxId } = getVertex(seamBot);
      const apexPtId = addPoint(tPt);
      const apexVtxId = addVertex(apexPtId);
      // Bottom circle
      const botCircPl = addAxis2Placement3D(bPt, coneAxis, refDir);
      const botCirc = addCircle(botCircPl, rBottom);
      const botCircEdge = addEdgeCurve(seamBotVtxId, seamBotVtxId, botCirc, true);
      // Seam line to apex
      const seamDir = [tPt[0] - seamBot[0], tPt[1] - seamBot[1], tPt[2] - seamBot[2]];
      const seamLen = Math.hypot(...seamDir);
      const seamEdge = addEdgeCurve(seamBotVtxId, apexVtxId, addLine(seamBotPtId, addVector(addDirection(seamDir), seamLen)), true);
      // Bottom planar cap
      const bfLoop = addEdgeLoop([addOrientedEdge(botCircEdge, false)]);
      const bfPl = addAxis2Placement3D(bPt, [-coneAxis[0], -coneAxis[1], -coneAxis[2]], refDir);
      faceIds.push(addAdvancedFace([addFaceOuterBound(bfLoop, true)], addPlane(bfPl), true));
      // Conical lateral surface (placement at apex, axis reversed)
      const conePl = addAxis2Placement3D(tPt, [-coneAxis[0], -coneAxis[1], -coneAxis[2]], refDir);
      const coneSurf = addConicalSurface(conePl, 0, semiAngle);
      const coneLoop = addEdgeLoop([addOrientedEdge(botCircEdge, true), addOrientedEdge(seamEdge, true), addOrientedEdge(seamEdge, false)]);
      faceIds.push(addAdvancedFace([addFaceOuterBound(coneLoop, true)], coneSurf, true));

    } else if (isPointyBottom) {
      // Pointed bottom: apex at bPt, top circle at tPt
      const seamTop = [tPt[0] + refDir[0] * rTop, tPt[1] + refDir[1] * rTop, tPt[2] + refDir[2] * rTop];
      const apexPtId = addPoint(bPt);
      const apexVtxId = addVertex(apexPtId);
      const { ptId: seamTopPtId, vtxId: seamTopVtxId } = getVertex(seamTop);
      // Top circle
      const topCircPl = addAxis2Placement3D(tPt, coneAxis, refDir);
      const topCirc = addCircle(topCircPl, rTop);
      const topCircEdge = addEdgeCurve(seamTopVtxId, seamTopVtxId, topCirc, true);
      // Seam line from apex
      const seamDir = [seamTop[0] - bPt[0], seamTop[1] - bPt[1], seamTop[2] - bPt[2]];
      const seamLen = Math.hypot(...seamDir);
      const seamEdge = addEdgeCurve(apexVtxId, seamTopVtxId, addLine(apexPtId, addVector(addDirection(seamDir), seamLen)), true);
      // Top planar cap
      const tfLoop = addEdgeLoop([addOrientedEdge(topCircEdge, true)]);
      const tfPl = addAxis2Placement3D(tPt, coneAxis, refDir);
      faceIds.push(addAdvancedFace([addFaceOuterBound(tfLoop, true)], addPlane(tfPl), true));
      // Conical lateral surface (placement at apex)
      const conePl = addAxis2Placement3D(bPt, coneAxis, refDir);
      const coneSurf = addConicalSurface(conePl, 0, semiAngle);
      const coneLoop = addEdgeLoop([addOrientedEdge(topCircEdge, false), addOrientedEdge(seamEdge, false), addOrientedEdge(seamEdge, true)]);
      faceIds.push(addAdvancedFace([addFaceOuterBound(coneLoop, true)], coneSurf, true));

    } else {
      // Frustum (truncated cone)
      const seamBot = [bPt[0] + refDir[0] * rBottom, bPt[1] + refDir[1] * rBottom, bPt[2] + refDir[2] * rBottom];
      const seamTop = [tPt[0] + refDir[0] * rTop, tPt[1] + refDir[1] * rTop, tPt[2] + refDir[2] * rTop];
      const { ptId: seamBotPtId, vtxId: seamBotVtxId } = getVertex(seamBot);
      const { ptId: seamTopPtId, vtxId: seamTopVtxId } = getVertex(seamTop);
      // Bottom and top circles
      const botCircPl = addAxis2Placement3D(bPt, coneAxis, refDir);
      const botCirc = addCircle(botCircPl, rBottom);
      const botCircEdge = addEdgeCurve(seamBotVtxId, seamBotVtxId, botCirc, true);
      const topCircPl = addAxis2Placement3D(tPt, coneAxis, refDir);
      const topCirc = addCircle(topCircPl, rTop);
      const topCircEdge = addEdgeCurve(seamTopVtxId, seamTopVtxId, topCirc, true);
      // Seam edge
      const seamDir = [seamTop[0] - seamBot[0], seamTop[1] - seamBot[1], seamTop[2] - seamBot[2]];
      const seamLen = Math.hypot(...seamDir);
      const seamEdge = addEdgeCurve(seamBotVtxId, seamTopVtxId, addLine(seamBotPtId, addVector(addDirection(seamDir), seamLen)), true);
      // Bottom and top planar caps
      const bfLoop = addEdgeLoop([addOrientedEdge(botCircEdge, false)]);
      const bfPl = addAxis2Placement3D(bPt, [-coneAxis[0], -coneAxis[1], -coneAxis[2]], refDir);
      faceIds.push(addAdvancedFace([addFaceOuterBound(bfLoop, true)], addPlane(bfPl), true));
      const tfLoop = addEdgeLoop([addOrientedEdge(topCircEdge, true)]);
      const tfPl = addAxis2Placement3D(tPt, coneAxis, refDir);
      faceIds.push(addAdvancedFace([addFaceOuterBound(tfLoop, true)], addPlane(tfPl), true));
      // Conical lateral surface: placement at the extrapolated apex
      const apexDist = (rBottom * length) / (rBottom - rTop);
      const apexPos = [bPt[0] - coneAxis[0] * apexDist, bPt[1] - coneAxis[1] * apexDist, bPt[2] - coneAxis[2] * apexDist];
      const conePl = addAxis2Placement3D(apexPos, coneAxis, refDir);
      const coneSurf = addConicalSurface(conePl, 0, semiAngle);
      const coneLoop = addEdgeLoop([
        addOrientedEdge(botCircEdge, true), addOrientedEdge(seamEdge, true),
        addOrientedEdge(topCircEdge, false), addOrientedEdge(seamEdge, false)
      ]);
      faceIds.push(addAdvancedFace([addFaceOuterBound(coneLoop, true)], coneSurf, true));
    }

    extraSolidIds.push(addManifoldSolidBrep(addClosedShell(faceIds), 'Cone'));
  }

  // ---- Step 7: STEP file metadata ----
  const lenUnitId = id++;
  entities.push(`#${lenUnitId}=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));`);
  const angUnitId = id++;
  entities.push(`#${angUnitId}=(PLANE_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.RADIAN.));`);
  const solAngId = id++;
  entities.push(`#${solAngId}=(SOLID_ANGLE_UNIT()NAMED_UNIT(*)SI_UNIT($,.STERADIAN.));`);
  const uncId = id++;
  entities.push(`#${uncId}=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lenUnitId},'distance_accuracy_value','');`);
  const ctxId = id++;
  entities.push(`#${ctxId}=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncId}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnitId},#${angUnitId},#${solAngId}))REPRESENTATION_CONTEXT('',''));`);

  const allSolidIds = [mainSolidId, ...extraSolidIds];
  const shapeRepId = id++;
  entities.push(`#${shapeRepId}=ADVANCED_BREP_SHAPE_REPRESENTATION('Volume',(${allSolidIds.map((s) => `#${s}`).join(',')}),#${ctxId});`);

  const appCtxId = id++;
  entities.push(`#${appCtxId}=APPLICATION_CONTEXT('automotive_design');`);
  const appProtId = id++;
  entities.push(`#${appProtId}=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#${appCtxId});`);
  const prodCtxId = id++;
  entities.push(`#${prodCtxId}=PRODUCT_CONTEXT('design',#${appCtxId},'mechanical');`);
  const productName = analysis?.meta?.fileName || 'STLReverse';
  const prodId = id++;
  entities.push(`#${prodId}=PRODUCT('${productName}','V1 B-Rep','',(#${prodCtxId}));`);
  const formId = id++;
  entities.push(`#${formId}=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prodId},.NOT_KNOWN.);`);
  const prodDefCtxId = id++;
  entities.push(`#${prodDefCtxId}=PRODUCT_DEFINITION_CONTEXT('design',#${appCtxId},'');`);
  const prodDefId = id++;
  entities.push(`#${prodDefId}=PRODUCT_DEFINITION('','',#${formId},#${prodDefCtxId});`);
  const prodDefShapeId = id++;
  entities.push(`#${prodDefShapeId}=PRODUCT_DEFINITION_SHAPE('','',#${prodDefId});`);
  const shapeDefRepId = id++;
  entities.push(`#${shapeDefRepId}=SHAPE_DEFINITION_REPRESENTATION(#${prodDefShapeId},#${shapeRepId});`);

  const timestamp = new Date().toISOString();
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STLReverse V1 Connected B-Rep'),'2;1');",
    `FILE_NAME('stlReverse-v1-brep.step','${timestamp}',('STLReverse'),('STLReverse'),'STLReverse','STLReverse','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');
}
