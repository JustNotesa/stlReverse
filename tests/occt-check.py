# ─────────────────────────────────────────────────────────────────────────────
# Unabhängiger CAD-Kern als zweiter Prüfer: volles OpenCascade (OCP-Python-Bindings, NICHT
# occt-import-js) liest STEP-Dateien und prüft sie. Aufgerufen von tests/ocp-suite.mjs; einzeln:
#   arch -arm64 /usr/bin/python3 tests/occt-check.py datei.step …      (macOS/Apple Silicon)
#   python3 tests/occt-check.py datei.step …
# Ausgabe: je Datei eine JSON-Zeile { file, read, solids:[{volume, inverted, shells, faces}],
#   shells, faces, edges, freeEdges, volume, valid, invalid:[…], bop:{Status: Anzahl}, ms }
#
# Lesen: STEPControl_Reader mit ABGESCHALTETER Reparatur-Sequenz (read.step.sequence = "", sonst
# 'FromSTEP' = ShapeFix). Gemessen (2026-10, Exporter-Ausgaben alt/neu, Würfel, Hohlräume, Bohrungen,
# dino, eBike): mit und ohne Sequenz IDENTISCHE Ergebnisse. Aber: der Übersetzer selbst dreht einen
# innen-außen vertauschten Körper still um (invertierter Würfel → V = +1000, auch ohne Sequenz) — die
# Orientierung GANZER Schalen sieht dieser Check also NICHT (dafür: tests/step-strict.mjs shell-volume).
#
# Was der Check sieht:
#   valid     BRepCheck_Analyzer: Topologie/Geometrie je Teilform — u.a. sich schneidende Ränder einer
#             Fläche (IntersectingWires), Kanten neben ihrer Fläche, offene/fehlerhafte Schalen
#   bop       BRepAlgoAPI_Check mit Selbstdurchdringungs- und Mini-Kanten-Test: Flächen/Kanten, die
#             sich schneiden oder berühren (auch ZWISCHEN getrennten Körpern: berührende/durchdringende
#             Körper), Kanten unter der Toleranz (TooSmallEdge)
#   volume    GProp, exakt über die Flächen integriert (je Körper; inverted = Unendlich-Punkt innen)
#   sa        ShapeAnalysis_Wire je Rand jeder Fläche mit der Präzision 1e-6 mm (ACIS-Auflösung, CST
#             CAD Navigator): Anzahl Flächen mit sich selbst schneidendem Rand (CheckSelfIntersection),
#             3D-Lücken zwischen aufeinanderfolgenden Kanten (CheckGaps3d), Mini-Kanten (CheckSmall).
#             BRepCheck/BOP fanden den Kabelhalter-Fehler (Kanten-Enden 1.2e-6 mm neben ihrer LINE) NICHT,
#             diese Prüfung schon (479 bzw. 138 Flächen) — Toleranzen der OCCT-Kanten zählen hier nicht.
#   vertexPlane  größter Abstand Eckpunkt ↔ Ebene seiner ebenen Flächen — nur Information
# Was er nicht sieht: Orientierung ganzer Schalen (s. o.), Rand-Umlaufsinn und same_sense einzelner
# Flächen (der Übersetzer richtet sie aus — dafür step-strict orient-*), ob ein Kreis „richtig“ an Stelle
# eines Polygons sitzt (nur, ob er etwas schneidet), Abweichung vom Netz (dafür das Netz-Volumen).
# ─────────────────────────────────────────────────────────────────────────────
import sys, json, time
from collections import Counter
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepAlgoAPI import BRepAlgoAPI_Check
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.TopExp import TopExp_Explorer, TopExp
from OCP.TopAbs import TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE, TopAbs_EDGE, TopAbs_WIRE, TopAbs_VERTEX, TopAbs_IN
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRep import BRep_Tool
from OCP.TopoDS import TopoDS
from OCP.ShapeAnalysis import ShapeAnalysis_Wire
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane

SA_PREC = 1e-6                                           # mm — ACIS-Auflösung (CST CAD Navigator)

STEPControl_Reader()                                     # Reader-Parameter initialisieren, dann setzen
Interface_Static.SetCVal_s("read.step.sequence", "")     # keine ShapeFix-Reparatur beim Lesen

def count(shape, typ):
    n = 0; ex = TopExp_Explorer(shape, typ)
    while ex.More(): n += 1; ex.Next()
    return n

def check(path):
    out = {'file': path}
    t0 = time.time()
    r = STEPControl_Reader()
    if r.ReadFile(path) != IFSelect_RetDone:
        out['read'] = False
        return out
    r.TransferRoots()
    s = r.OneShape()
    out['read'] = True
    solids = []
    ex = TopExp_Explorer(s, TopAbs_SOLID)
    while ex.More():
        so = ex.Current()
        g = GProp_GProps(); BRepGProp.VolumeProperties_s(so, g)
        cl = BRepClass3d_SolidClassifier(so); cl.PerformInfinitePoint(1e-7)
        solids.append({'volume': g.Mass(), 'inverted': cl.State() == TopAbs_IN, 'shells': count(so, TopAbs_SHELL), 'faces': count(so, TopAbs_FACE)})
        ex.Next()
    out['solids'] = solids
    out['shells'] = count(s, TopAbs_SHELL)
    out['faces'] = count(s, TopAbs_FACE)
    out['edges'] = count(s, TopAbs_EDGE)
    # Randkanten: genau eine angrenzende Fläche (Nahtkanten einer Fläche zählen doppelt → nicht frei)
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(s, TopAbs_EDGE, TopAbs_FACE, m)
    free = 0
    for i in range(1, m.Extent() + 1):
        faces = m.FindFromIndex(i)                       # Extent/First statt list(): 100× schneller in OCP
        if faces.Extent() == 1 and not BRep_Tool.IsClosed_s(TopoDS.Edge_s(m.FindKey(i)), TopoDS.Face_s(faces.First())):
            free += 1
    out['freeEdges'] = free
    g = GProp_GProps(); BRepGProp.VolumeProperties_s(s, g)
    out['volume'] = g.Mass()
    ana = BRepCheck_Analyzer(s)
    out['valid'] = bool(ana.IsValid())
    invalid = []
    if not out['valid']:
        for typ, name in ((TopAbs_FACE, 'FACE'), (TopAbs_EDGE, 'EDGE'), (TopAbs_SHELL, 'SHELL'), (TopAbs_SOLID, 'SOLID')):
            e2 = TopExp_Explorer(s, typ)
            while e2.More() and len(invalid) < 10:
                if not ana.IsValid(e2.Current()):
                    st = []
                    res = ana.Result(e2.Current())
                    try:
                        st = [str(x).split('.')[-1] for x in res.Status()]
                    except Exception:
                        pass
                    invalid.append(f'{name} {st}')
                e2.Next()
    out['invalid'] = invalid
    chk = BRepAlgoAPI_Check(s, True, True)               # Mini-Kanten + Selbstdurchdringung
    out['bop'] = dict(Counter(str(x.GetCheckStatus()).split('.')[-1] for x in chk.Result()))
    # ShapeAnalysis je Fläche mit 1e-6 mm (strikter Kern): Zahl der Flächen mit Befund je Art
    sa = Counter(); vmax = 0.0
    fx = TopExp_Explorer(s, TopAbs_FACE)
    while fx.More():
        f = TopoDS.Face_s(fx.Current())
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() == GeomAbs_Plane:                # Ebene: Abstand analytisch (Projektion wäre 100× teurer)
            pl = ad.Plane()
            vx = TopExp_Explorer(f, TopAbs_VERTEX)
            while vx.More():
                vmax = max(vmax, pl.Distance(BRep_Tool.Pnt_s(TopoDS.Vertex_s(vx.Current()))))
                vx.Next()
        flags = set()
        wx = TopExp_Explorer(f, TopAbs_WIRE)
        while wx.More():
            w = TopoDS.Wire_s(wx.Current())
            an = ShapeAnalysis_Wire(w, f, SA_PREC)
            an.Load(w)
            if an.CheckSmall(SA_PREC): flags.add('small')
            if an.CheckSelfIntersection(): flags.add('selfIntersection')
            if an.CheckGaps3d(): flags.add('gaps3d')
            wx.Next()
        for fl in flags: sa[fl] += 1
        fx.Next()
    out['sa'] = dict(sa)
    out['vertexPlane'] = vmax
    out['ms'] = round((time.time() - t0) * 1000)
    return out

for p in sys.argv[1:]:
    try:
        res = check(p)
    except Exception as e:                               # ein kaputter Fall stoppt nicht die ganze Liste
        res = {'file': p, 'read': False, 'error': str(e)}
    print(json.dumps(res), flush=True)
