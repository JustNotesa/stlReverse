import { readFileSync } from 'fs';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { recognizePrimitives } from '../primitive-recognition.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';

const MAX_FACES = 50000;
function buildNormalGroups(mesh) {
  const faces = mesh.faces; const n = faces.length; if (!n) return [];
  const PLANAR_COS = Math.cos(2*Math.PI/180); const PLANAR_OFFSET_MM = 0.05;
  const vtxKey = v => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;
  const edgeKey = (a,b)=>{const ka=vtxKey(a),kb=vtxKey(b);return ka<kb?ka+'|'+kb:kb+'|'+ka;};
  const triN=new Float32Array(n*3), triOff=new Float32Array(n);
  for(let i=0;i<n;i++){const f=faces[i];const nx=f.normal[0],ny=f.normal[1],nz=f.normal[2];const l=Math.hypot(nx,ny,nz)||1;triN[i*3]=nx/l;triN[i*3+1]=ny/l;triN[i*3+2]=nz/l;const p0=f.vertices[0];triOff[i]=(nx*p0[0]+ny*p0[1]+nz*p0[2])/l;}
  const e2t=new Map();
  for(let i=0;i<n;i++){const vs=faces[i].vertices;for(let k=0;k<3;k++){const ek=edgeKey(vs[k],vs[(k+1)%3]);let e=e2t.get(ek);if(!e){e=[];e2t.set(ek,e);}e.push(i);}}
  const adj=Array.from({length:n},()=>[]);
  for(const tris of e2t.values()){if(tris.length!==2)continue;const[t1,t2]=tris;const i1=t1*3,i2=t2*3;const cosA=triN[i1]*triN[i2]+triN[i1+1]*triN[i2+1]+triN[i1+2]*triN[i2+2];if(cosA<PLANAR_COS)continue;if(Math.abs(triOff[t1]-triOff[t2])>PLANAR_OFFSET_MM)continue;adj[t1].push(t2);adj[t2].push(t1);}
  const visited=new Uint8Array(n); const regions=[];
  for(let i=0;i<n;i++){if(visited[i])continue;visited[i]=1;const members=[i];const q=[i];while(q.length){const cur=q.pop();for(const nb of adj[cur])if(!visited[nb]){visited[nb]=1;members.push(nb);q.push(nb);}}let sx=0,sy=0,sz=0;const vertices=[];for(const t of members){const f=faces[t];sx+=f.normal[0];sy+=f.normal[1];sz+=f.normal[2];for(const v of f.vertices)vertices.push(v);}const sl=Math.hypot(sx,sy,sz)||1;regions.push({normal:[sx/sl,sy/sl,sz/sl],vertices});}
  return regions.sort((a,b)=>b.vertices.length-a.vertices.length);
}
function run(path){
  const buf=readFileSync(path); const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
  let mesh=parseStl(ab,()=>{}); if(mesh.faces.length>MAX_FACES)mesh=simplifyMesh(mesh,MAX_FACES,()=>{});
  let groups=buildNormalGroups(mesh);
  const {unified}=unifyCoplanarGroups(groups); groups=unified.sort((a,b)=>b.vertices.length-a.vertices.length);
  const analysis={normalGroups:groups};
  try{recognizePrimitives(analysis.normalGroups);}catch(e){}
  const res=buildVolumeStepBrepV2(analysis);
  return {res, tris: mesh.faces.length};
}
const dir='samples/';
for(const f of ['cube_ascii.stl','block_with_hole.stl','cylinder.stl','cone_pointed.stl','fischerEbike - FahrradLicht - mount unter sattel.stl']){
  try{
    const {res,tris}=run(dir+f);
    if(!res){console.log(`${f}: NULL (zu wenig Flächen)`);continue;}
    const r=res.report; const solid=res.step.includes('MANIFOLD_SOLID_BREP'); const closed=res.step.includes('CLOSED_SHELL');
    console.log(`${f} (${tris} tris): watertight=${r.watertight} open=${r.boundaryEdges} nonman=${r.nonManifoldEdges} orient=${r.orientationDefects} faces=${r.faceCount} | SOLID=${solid} CLOSED_SHELL=${closed}`);
  }catch(e){console.log(`${f}: ERROR ${e.message}`);}
}
