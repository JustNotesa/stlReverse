import { readFileSync } from 'fs';
import { parseStl } from '../analysis-core.js';
import { unifyCoplanarGroups } from '../face-unification.js';
import { buildVolumeStepBrepV2 } from '../exporters.js';
function bng(mesh){const faces=mesh.faces,n=faces.length;if(!n)return[];const PC=Math.cos(2*Math.PI/180),PO=0.05;const vk=v=>`${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`;const ek=(a,b)=>{const ka=vk(a),kb=vk(b);return ka<kb?ka+'|'+kb:kb+'|'+ka;};const tN=new Float32Array(n*3),tO=new Float32Array(n);for(let i=0;i<n;i++){const f=faces[i];const nx=f.normal[0],ny=f.normal[1],nz=f.normal[2];const l=Math.hypot(nx,ny,nz)||1;tN[i*3]=nx/l;tN[i*3+1]=ny/l;tN[i*3+2]=nz/l;tO[i]=(nx*f.vertices[0][0]+ny*f.vertices[0][1]+nz*f.vertices[0][2])/l;}const e2=new Map();for(let i=0;i<n;i++){const vs=faces[i].vertices;for(let k=0;k<3;k++){const e=ek(vs[k],vs[(k+1)%3]);let a=e2.get(e);if(!a){a=[];e2.set(e,a);}a.push(i);}}const adj=Array.from({length:n},()=>[]);for(const t of e2.values()){if(t.length!==2)continue;const[a,b]=t;const c=tN[a*3]*tN[b*3]+tN[a*3+1]*tN[b*3+1]+tN[a*3+2]*tN[b*3+2];if(c<PC)continue;if(Math.abs(tO[a]-tO[b])>PO)continue;adj[a].push(b);adj[b].push(a);}const vis=new Uint8Array(n),regs=[];for(let i=0;i<n;i++){if(vis[i])continue;vis[i]=1;const m=[i],q=[i];while(q.length){const c=q.pop();for(const nb of adj[c])if(!vis[nb]){vis[nb]=1;m.push(nb);q.push(nb);}}let sx=0,sy=0,sz=0;const v=[];for(const t of m){const f=faces[t];sx+=f.normal[0];sy+=f.normal[1];sz+=f.normal[2];for(const vv of f.vertices)v.push(vv);}const sl=Math.hypot(sx,sy,sz)||1;regs.push({normal:[sx/sl,sy/sl,sz/sl],vertices:v});}return regs.sort((a,b)=>b.vertices.length-a.vertices.length);}
const buf=readFileSync('samples/block_with_hole.stl');const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
let mesh=parseStl(ab,()=>{});let g=bng(mesh);const{unified}=unifyCoplanarGroups(g);g=unified.sort((a,b)=>b.vertices.length-a.vertices.length);
const step=buildVolumeStepBrepV2({normalGroups:g}).step;
const lines=step.split('\n');const E=new Map();for(const l of lines){const m=l.match(/^#(\d+)=(\w+)\((.*)\);$/);if(m)E.set(+m[1],{type:m[2],args:m[3]});}
const pt=id=>{const e=E.get(id);if(e&&e.type==='CARTESIAN_POINT'){const m=e.args.match(/\(\(([^)]+)\)\)/);return m[1];}return '?';};
// find a 3x edge curve
const oeCount=new Map();for(const[id,e]of E)if(e.type==='ORIENTED_EDGE'){const m=e.args.match(/#(\d+),\.[TF]\.\)?$/)||e.args.match(/#(\d+),\.[TF]\./);if(m)oeCount.set(+m[1],(oeCount.get(+m[1])||0)+1);}
let bad=null;for(const[id,c]of oeCount)if(c===3){bad=id;break;}
const ec=E.get(bad);const vm=ec.args.match(/#(\d+),#(\d+),#(\d+)/);
console.log('EDGE_CURVE #'+bad,'startVtx#'+vm[1],'endVtx#'+vm[2]);
// vertex -> point
const vp=v=>{const e=E.get(v);const m=e.args.match(/#(\d+)/);return pt(+m[1]);};
console.log('  start pt:',vp(+vm[1]),'  end pt:',vp(+vm[2]));
// which oriented edges ref it, which loops, which faces
const oes=[];for(const[id,e]of E)if(e.type==='ORIENTED_EDGE'&&e.args.includes('#'+bad+',')){oes.push(id);}
console.log('  oriented edges:',oes);
for(const oeid of oes){const loops=[];for(const[id,e]of E)if(e.type==='EDGE_LOOP'&&e.args.includes('#'+oeid)){loops.push(id);}
  for(const lid of loops){const bounds=[];for(const[id,e]of E)if((e.type==='FACE_OUTER_BOUND'||e.type==='FACE_BOUND')&&e.args.includes('#'+lid)){bounds.push({id,t:e.type});}
    for(const b of bounds){const faces=[];for(const[id,e]of E)if(e.type==='ADVANCED_FACE'&&e.args.includes('#'+b.id)){const sm=e.args.match(/,#(\d+),\.[TF]\.$/);faces.push({id,surf:sm?E.get(+sm[1])?.type:'?'});}
      console.log('   OE#'+oeid,'-> loop#'+lid,'-> '+b.t+'#'+b.id,'-> face',faces.map(f=>f.id+'('+f.surf+')'));}}}
