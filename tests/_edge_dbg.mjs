import { readFileSync } from 'fs';
import { parseStl, simplifyMesh } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
function buildNormalGroups(mesh){const faces=mesh.faces,n=faces.length;if(!n)return[];const PC=Math.cos(2*Math.PI/180),PO=0.05;const vk=v=>`${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;const ek=(a,b)=>{const ka=vk(a),kb=vk(b);return ka<kb?ka+'|'+kb:kb+'|'+ka;};const tN=new Float32Array(n*3),tO=new Float32Array(n);for(let i=0;i<n;i++){const f=faces[i];const nx=f.normal[0],ny=f.normal[1],nz=f.normal[2];const l=Math.hypot(nx,ny,nz)||1;tN[i*3]=nx/l;tN[i*3+1]=ny/l;tN[i*3+2]=nz/l;tO[i]=(nx*f.vertices[0][0]+ny*f.vertices[0][1]+nz*f.vertices[0][2])/l;}const e2=new Map();for(let i=0;i<n;i++){const vs=faces[i].vertices;for(let k=0;k<3;k++){const e=ek(vs[k],vs[(k+1)%3]);let a=e2.get(e);if(!a){a=[];e2.set(e,a);}a.push(i);}}const adj=Array.from({length:n},()=>[]);for(const t of e2.values()){if(t.length!==2)continue;const[a,b]=t;const c=tN[a*3]*tN[b*3]+tN[a*3+1]*tN[b*3+1]+tN[a*3+2]*tN[b*3+2];if(c<PC)continue;if(Math.abs(tO[a]-tO[b])>PO)continue;adj[a].push(b);adj[b].push(a);}const vis=new Uint8Array(n),regs=[];for(let i=0;i<n;i++){if(vis[i])continue;vis[i]=1;const m=[i],q=[i];while(q.length){const c=q.pop();for(const nb of adj[c])if(!vis[nb]){vis[nb]=1;m.push(nb);q.push(nb);}}let sx=0,sy=0,sz=0;const v=[];for(const t of m){const f=faces[t];sx+=f.normal[0];sy+=f.normal[1];sz+=f.normal[2];for(const vv of f.vertices)v.push(vv);}const sl=Math.hypot(sx,sy,sz)||1;regs.push({normal:[sx/sl,sy/sl,sz/sl],vertices:v});}return regs.sort((a,b)=>b.vertices.length-a.vertices.length);}
const buf=readFileSync('samples/block_with_hole.stl');const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
let mesh=parseStl(ab,()=>{});
let g=buildNormalGroups(mesh);const{unified}=unifyCoplanarGroups(g);g=unified.sort((a,b)=>b.vertices.length-a.vertices.length);
const res=buildVolumeStepBrepV2({normalGroups:g});
const step=res.step;
// count ORIENTED_EDGE per EDGE_CURVE
const oe=[...step.matchAll(/ORIENTED_EDGE\('',\*,\*,#(\d+),/g)].map(m=>+m[1]);
const cnt=new Map();for(const id of oe)cnt.set(id,(cnt.get(id)||0)+1);
const hist={};for(const c of cnt.values())hist[c]=(hist[c]||0)+1;
console.log('EDGE_CURVE usage histogram (uses -> #edges):', hist);
// sample a 3+ used edge curve and show its endpoints
let bad=null;for(const[id,c]of cnt)if(c>2){bad=id;break;}
if(bad){const m=step.match(new RegExp('#'+bad+'=EDGE_CURVE\\(\'\',#(\\d+),#(\\d+),'));console.log('sample nonmanifold EDGE_CURVE #'+bad,'verts',m&&[m[1],m[2]], 'used', cnt.get(bad),'x');}
