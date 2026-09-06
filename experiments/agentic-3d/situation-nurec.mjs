#!/usr/bin/env node
/** Native NuRec source bindings; no renderer/model is launched by this module.
 * CLI: inspect BUNDLE [replay|policy]; fork BUNDLE NEW_DIRECTORY PATCH.json;
 *      bind BUNDLE SCENE_STATE.json (writes the bound state to stdout);
 *      rehearse BUNDLE PROGRAM.json SEED [--out NEW_DIRECTORY] (native execution over the pinned source).
 * All commands accept repeated --source-package SHA256=ABSOLUTE_PATH.
 * API options.sourcePackages binds lowercase SHA256 keys to absolute local files;
 * only an explicitly selected mapping verifies package bytes during portable loading.
 * Patches: {actors:[{op:'remove',actorId}|{op:'move',actorId,dx,dz,yawRad}|
 * {op:'retime',actorId,dtS}|{op:'inject',actor,mesh}],regions:[region]}.
 * mesh={path,sha256,frame:'simforge-y-up',transformSource:4x4}; region=
 * {id,frame:'source-world-z-up',selection:'gaussian-center',min:[x,y,z],max:[x,y,z],
 * layers:['background'],replacements:[mesh]}. Replacement transforms are rigid source-world
 * transforms; GLB vertices are y-up metres, ground-origin (same native catalog convention).
 * For injected actors transformSource must be identity: their placement comes exclusively
 * from engine scene-state. Region replacements use an absolute source-world transform.
 * Interiors and newly exposed surfaces are authored, not recovered observations.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, copyFile, realpath, stat, rename, rm } from 'node:fs/promises';
import { resolve, join, relative, basename, dirname, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { CoordinateFrame, buildMapIntel } from '@simforge-oss/maps/node';
import { createMapBundle, rehearseSituation } from '@simforge-oss/compiler/node';
import { parseSituationProgram, situationDigest } from '@simforge-oss/scenario';
import { canonicalJson } from '@simforge-oss/engine';
import { sceneState } from '@simforge-oss/engine/node';
const PIN = 'a435e9ccd72a934333b17e70d913a664e80e0820';
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const sha = async p => { const h = createHash('sha256'); for await (const b of createReadStream(p)) h.update(b); return h.digest('hex'); };
const check = (ok, why) => { if (!ok) throw new Error(why); };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const encode = v => JSON.stringify(v, null, 2) + '\n';
async function identity(root, name, kind) { const path = resolve(root, name); return { id:name, uri:pathToFileURL(path).href, sha256:await sha(path), kind }; }
function inside(root, path) { const r = relative(root,path); return r !== '..' && !r.startsWith('..'+sep) && !r.startsWith(sep); }
async function files(root, prefix='') { const out=[]; for (const e of await readdir(join(root,prefix),{withFileTypes:true})) { const p=join(prefix,e.name); if(e.isDirectory()) out.push(...await files(root,p)); else { check(!e.isSymbolicLink(),'Bundle symlinks must be materialized before authoring: '+p); out.push(p); } } return out; }
async function resolveSourcePackage(background, sourcePackages) {
  if (sourcePackages !== undefined) {
    check(sourcePackages !== null && typeof sourcePackages === 'object' && !Array.isArray(sourcePackages) && [Object.prototype,null].includes(Object.getPrototypeOf(sourcePackages)), 'sourcePackages must be a SHA256-to-absolute-path object');
    for (const [hash,path] of Object.entries(sourcePackages)) {
      check(digest(hash),'Invalid source package SHA256: '+hash);
      check(typeof path==='string'&&isAbsolute(path),'Source package path must be absolute: '+hash);
      check((await stat(path)).isFile(),'Source package path must be a file: '+path);
    }
  }
  const expected=background.sourceUsdzSha256;
  const mapped=sourcePackages!==undefined&&Object.hasOwn(sourcePackages,expected);
  const path=mapped?await realpath(sourcePackages[expected]):resolve(background.sourceUsdz);
  if(mapped) check(await sha(path)===expected,'Source package identity mismatch: '+path);
  return {path,sha256:expected,verified:mapped};
}
/** Return the canonical compiler MapBundle for the imported clip-local map, deriving
 * missing intel with the same producers/normalizer as loadMap; the executable lane
 * graph inside it is the native runtime's. No assets are written. */
export async function loadNuRecMapBundle(directory, options={}) {
  return nurecMapBundle(await loadNuRecBundle(directory,options));
}
async function nurecMapBundle(binding) {
  const mapId=binding.source.mapId;
  const xodr=await readFile(join(binding.root,'map/map.xodr'),'utf8');
  const stored=await readFile(join(binding.root,'map/topology-index.json.gz'));
  const topologyBytes=new Uint8Array(stored[0]===0x1f&&stored[1]===0x8b?gunzipSync(stored):stored);
  const fit=binding.provenance.xodrFrame;
  check(fit?.kind==='geo-referenced'&&finite(fit.yawDeg)&&fit.t?.length===2&&fit.t.every(finite),'Unsupported NuRec map frame: missing importer world-to-XODR fit');
  const projString=xodr.match(/<geoReference>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/geoReference>/)?.[1];
  check(projString,'Unsupported NuRec map frame: missing source projection');
  const c=Math.cos(fit.yawDeg*Math.PI/180),s=Math.sin(fit.yawDeg*Math.PI/180),[tx,ty]=fit.t;
  // The imported road geometry is clip-local; its retained geoReference is not.
  // Use the importer's pinned fit only for the catalog's geographic annotations.
  class ImportedFrame extends CoordinateFrame {
    localToWgs84(x,y) { return super.localToWgs84(c*x-s*y+tx,s*x+c*y+ty); }
    wgs84ToLocal(lng,lat) { const [x,y]=super.wgs84ToLocal(lng,lat);return [c*(x-tx)+s*(y-ty),-s*(x-tx)+c*(y-ty)]; }
  }
  // Signal catalog and speed-limit merge are native; the intel producer reads the topology the runtime will execute.
  const executable=createMapBundle({mapId,topology:topologyBytes,xodr});
  const sourceHashes=Object.fromEntries(['map/map.xodr','map/topology-index.json.gz'].map(name=>[name==='map/map.xodr'?'xodr':'topology-index',binding.source.artifacts.find(a=>a.id===name).sha256]));
  const {catalog,derived}=buildMapIntel({mapId,mapAssetId:binding.background.sceneId,dir:join(binding.root,'map'),frame:new ImportedFrame({projString}),topology:executable.topology,sourceHashes,searchIndex:null,signals:null,lanePolygons:null,mapGeojson:null,overlay:null});
  return createMapBundle({mapId,topology:topologyBytes,derived,locations:catalog,xodr});
}
export async function loadNuRecBundle(directory, {mode='replay',policyRoleIds=['ego'],sourcePackages}={}) {
  check(['replay','policy'].includes(mode),'Unknown authority mode');
  const root=await realpath(directory), background=await json(join(root,'background.json'));
  const provenance=await json(join(root,'import-provenance.json'));
  check(background.provider==='nurec','Not a native NuRec import');
  check(digest(background.digest) && digest(background.sourceUsdzSha256),'Missing immutable source hashes');
  check(background.digest===provenance.source.members[background.member].sha256,'Background provenance mismatch');
  check(background.sourceUsdzSha256===provenance.source.usdzSha256,'Package provenance mismatch');
  const packageResolution=await resolveSourcePackage(background,sourcePackages);
  const input=await json(join(root,'scenario.input.json')), tracks=await json(join(root,'actor-trajectories.json'));
  const artifacts=await Promise.all([['background.json','baked'],['import-provenance.json','observation'],['scenario.input.json','observation'],['actor-trajectories.json','rigid-track'],['ego-reference.json','rigid-track'],['camera-rig.json','observation'],['source/map.xodr','map']].map(([n,k])=>identity(root,n,k)));
  const fork=background.sourcePatch;
  if (fork) {
    check(fork.schema==='simforge.nurec-source-patch/v1'&&fork.upstream===PIN,'Unknown source patch schema or backend revision');
    check(fork.bundleDigests&&typeof fork.bundleDigests==='object','Missing fork closure');
    for (const [name, hash] of Object.entries(fork.bundleDigests)) {check(digest(hash)&&inside(root,resolve(root,name)),'Invalid fork identity/path');check(await sha(join(root,name))===hash,'Fork artifact changed: '+name);}
    const original=await json(join(root,'source-background.json'));
    check(await sha(join(root,'source-background.json'))===fork.baseBackgroundSha256&&fork.baseBackgroundSha256===provenance.outputDigests['background.json'].sha256,'Fork base background changed');
    const unchanged=structuredClone(background);delete unchanged.sourcePatch;unchanged.actorTracks=original.actorTracks;
    check(JSON.stringify(unchanged)===JSON.stringify(original),'Fork altered capture, calibration, or background identity');
  } else {
    for (const a of artifacts) { const expected=provenance.outputDigests?.[a.id]?.sha256; if(expected) check(a.sha256===expected,'Imported artifact changed: '+a.id); }
    for(const [name, expected] of Object.entries(provenance.outputDigests??{}).filter(([n])=>!n.startsWith('qa/')&&!n.startsWith('map/'))) {
      check(inside(root,resolve(root,name))&&digest(expected.sha256),'Invalid imported identity/path');
      if(!artifacts.some(a=>a.id===name)) check(await sha(join(root,name))===expected.sha256,'Imported artifact changed: '+name);
    }
  }
  for (const name of Object.keys(provenance.outputDigests??{}).filter(n=>n.startsWith('map/'))) {
    const a=await identity(root,name,'map'); check(a.sha256===(fork?.bundleDigests?.[name]??provenance.outputDigests[name].sha256),'Map artifact changed: '+name);artifacts.push(a);
  }
  // Read the exact ego bytes that are verified, including the immutable fork source.
  const egoBytes=await readFile(join(root,'ego-reference.json'));
  check(createHash('sha256').update(egoBytes).digest('hex')===provenance.outputDigests['ego-reference.json'].sha256,'Imported ego reference changed');
  const egoReference=JSON.parse(egoBytes.toString('utf8'));
  check(egoReference.actorId==='ego'&&egoReference.frame==='simforge-scene-y-up'&&egoReference.samples?.length,'Invalid ego reference');
  check(artifacts.find(a=>a.id==='actor-trajectories.json').sha256===provenance.outputDigests['actor-trajectories.json'].sha256,'Imported actor observations changed');
  if(mode==='policy') for(const aid of policyRoleIds) {
    const actor=input.actors.find(a=>a.id===aid);check(actor,'Unknown policy role '+aid);
    const route=actor.behavior?.route;check(route?.kind==='timedPolyline'||route?.kind==='polyline','Policy binding requires an imported route');
    if(route.kind==='timedPolyline') actor.behavior.route={kind:'polyline',points:route.points.map(({x,z})=>({x,z}))};
  }
  const t0=background.episode.startTimestampUs, duration=background.episode.durationS;
  check(Number.isSafeInteger(t0)&&finite(duration)&&duration>0,'Invalid source time base');
  const range=background.metadata.timeRangeUs;
  const endS=Math.min(duration,(range.end-t0)/1e6);
  check(endS>0 && t0>=range.start,'Episode outside reconstruction time support');
  const participants=input.actors.map(a=>{
    const tid=background.actorTracks[a.id];
    check(a.id==='ego'||tid||fork?.meshes?.[a.id],'Actor lacks a recorded or explicit mesh binding: '+a.id);
    if(tid) check(tracks.actors?.[tid]?.samples?.length,'Missing imported track '+tid);
    const kind=mode==='policy'&&policyRoleIds.includes(a.id)?'policy':fork?.meshes?.[a.id]?'controller':'recorded';
    if(kind==='recorded') check(a.behavior?.route?.kind==='timedPolyline','Recorded authority requires a timed route: '+a.id);
    return {roleId:a.id,intention:kind==='policy'?'Policy controls this imported participant':kind==='controller'?'Controller drives authored actor':'Replay imported motion',authority:[{startS:0,endS,kind}],appearance:{kind:tid?'rigid-track':a.id==='ego'?'baked':'mesh',sourceId:tid?'actor-trajectories.json':a.id==='ego'?'background.json':'mesh:'+a.id},information:[]};
  });
  for (const [aid,m] of Object.entries(fork?.meshes??{})) artifacts.push({id:'mesh:'+aid,uri:pathToFileURL(resolve(root,m.path)).href,sha256:m.sha256,kind:'mesh'});
  artifacts.push({id:'source-package',uri:pathToFileURL(packageResolution.path).href,sha256:background.sourceUsdzSha256,kind:'baked'});
  const assumptions=['NuRec source world is z-up; scene-state maps (x,y,z) to (x,z,-y), yaw preserved.', 'Native world_to_nre and calibrated camera extrinsics come from the unchanged package.', 'Ground height uses imported mesh_ground nearest vertices; not new road or collision truth.', 'Reconstruction appearance does not establish driveability or unseen interiors.', 'Recorded cuboid proxy visibility has 0.75m depth tolerance; not exact per-Gaussian segmentation.', 'Off-path views, region boundaries, mesh lighting, determinism and fidelity require qualification; no gate passed by preparation.'];
  assumptions.push(packageResolution.verified?'Explicit local source package bytes verified against the pinned SHA256; GPU support and fidelity remain unqualified.':'Source package SHA256 is a provenance claim only; portable loading has not verified package availability or bytes.');
  return freeze({schema:'simforge.nurec-situation-binding/v1',root,upstream:PIN,source:{id:'nurec:'+basename(root),kind:'nurec',mapId:basename(root),artifacts,frame:{id:'simforge-world',axes:'simforge-y-up',units:'m'},time:{origin:t0/1e6,unit:'s'},assumptions},participants,input,tracks,egoReference,background,provenance,envelope:{timeS:[0,endS],sourceTimeUs:[t0,t0+endS*1e6],calibratedCameraIds:Object.keys(provenance.calibration),viewSupport:'recorded-calibrated-path-only; off-path unqualified',qualification:'not-run',unsupported:['nonrigid actor editing','support-footprint Gaussian masking','recovered unseen surfaces','new road/physics truth']}});
}
function rigid(m) {
  check(Array.isArray(m)&&m.length===4&&m.every(r=>Array.isArray(r)&&r.length===4&&r.every(finite)),'Expected finite 4x4 transform');
  check(m[3].every((v,i)=>Math.abs(v-(i===3?1:0))<1e-8),'Transform must be affine');
  for(let i=0;i<3;i++) for(let j=0;j<3;j++) check(Math.abs(m.slice(0,3).reduce((s,r)=>s+r[i]*r[j],0)-(i===j?1:0))<1e-6,'Transform must be rigid');
  const d=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]); check(Math.abs(d-1)<1e-6,'Reflections unsupported');
}
function editInput(input, edits) {
  for(const e of edits) {
    if(e.op==='inject') { check(e.actor?.id && !input.actors.some(a=>a.id===e.actor.id),'Duplicate/missing injected actor'); check(e.actor.initial?.pose && e.actor.behavior?.route,'Injection requires complete engine actor'); input.actors.push(structuredClone(e.actor)); continue; }
    const a=input.actors.find(a=>a.id===e.actorId); check(a,'Unknown actor '+e.actorId); check(a.id!=='ego'||e.op!=='remove','Cannot remove ego');
    if(e.op==='remove') { input.actors=input.actors.filter(x=>x!==a); continue; }
    const route=a.behavior?.route; check(['polyline','timedPolyline'].includes(route?.kind),'Edit requires imported polyline');
    if(e.op==='move') {
      check([e.dx,e.dz,e.yawRad].every(finite),'Move requires dx,dz,yawRad'); const c=Math.cos(e.yawRad),s=Math.sin(e.yawRad),p=a.initial.pose,ox=p.x,oz=p.z;
      for(const q of [...route.points,p]) { const x=q.x-ox,z=q.z-oz; q.x=ox+c*x+s*z+e.dx;q.z=oz-s*x+c*z+e.dz; }
      p.headingRad=(p.headingRad??0)+e.yawRad;
    } else if(e.op==='retime') {
      check(finite(e.dtS)&&route.kind==='timedPolyline','Retime requires finite dtS and recorded timedPolyline');
      for(const p of route.points) p.timeS+=e.dtS;
      check(route.points[0].timeS>=0,'Retime would clip observations; choose a nonnegative source window'); a.presentAtStart=route.points[0].timeS===0;
    } else throw new Error('Unknown actor operation '+e.op);
  }
}
export async function prepareNuRecFork(directory, output, patch, {sourcePackages}={}) {
  const binding=await loadNuRecBundle(directory,{sourcePackages}), root=binding.root;
  const out=join(await realpath(dirname(resolve(output))),basename(resolve(output)));
  check(!inside(root,out)&&!inside(out,root),'Fork must be separate from original bundle');
  check(!binding.background.sourcePatch,'Fork from the original import; compose edits in one patch');
  check(Array.isArray(patch.actors??[])&&Array.isArray(patch.regions??[]),'Invalid patch collections');
  try { await stat(out); throw new Error('Output already exists'); } catch(e) { if(e.code!=='ENOENT') throw e; }
  const edits=patch.actors??[], bg=structuredClone(binding.background), meshes={}, regions=structuredClone(patch.regions??[]);
  const prepared=[];
  async function mesh(m) { check(m?.frame==='simforge-y-up'&&digest(m.sha256),'Mesh requires frame and content digest'); rigid(m.transformSource); const path=await realpath(m.path);check(path.endsWith('.glb')&&await sha(path)===m.sha256,'Missing/changed GLB'); const bytes=await readFile(path);check(bytes.length>=20&&bytes.toString('ascii',0,4)==='glTF'&&bytes.readUInt32LE(4)===2&&bytes.readUInt32LE(8)===bytes.length,'Expected complete glTF 2 GLB');const dest='authored/'+m.sha256+'.glb';prepared.push([path,dest,m.sha256]);return {...m,path:dest}; }
  for(const e of edits) if(e.op==='inject') {
    check(e.actor?.id&&!meshes[e.actor.id],'Duplicate/missing injected actor');
    meshes[e.actor.id]=await mesh(e.mesh);
    check(e.mesh.transformSource.every((row,i)=>row.every((v,j)=>Math.abs(v-(i===j?1:0))<1e-8)),'Injected mesh transform must be identity; engine owns placement');
  }
  const regionIds=new Set();
  for(const r of regions) { check(r.id&&!regionIds.has(r.id),'Duplicate/missing region id');regionIds.add(r.id);check(r.frame==='source-world-z-up'&&r.selection==='gaussian-center','Only source-world Gaussian-center masks supported');check(r.min?.length===3&&r.max?.length===3&&r.min.every((v,i)=>finite(v)&&finite(r.max[i])&&v<r.max[i]),'Invalid region bounds');check(r.layers?.length&&r.layers.every(x=>typeof x==='string'),'Explicit static layers required');check(r.replacements?.length,'Region patch requires authored replacement geometry');r.replacements=await Promise.all(r.replacements.map(mesh));r.qualification={status:'not-run',needs:['boundary leakage from Gaussian support crossing region','coverage from all requested views/times','RGB/depth/visibility consistency','replacement lighting and geometry fidelity']}; }
  const staged=out+'.preparing-'+process.pid; await mkdir(staged,{recursive:false});
  try {
    for(const name of await files(root)) { const dst=join(staged,name);await mkdir(dirname(dst),{recursive:true});await copyFile(join(root,name),dst); }
    const input=structuredClone(binding.input);editInput(input,edits);await writeFile(join(staged,'scenario.input.json'),encode(input));
    for(const name of ['episode.episodes.json','episode.replay.episodes.json']) { let doc;try {doc=await json(join(staged,name));}catch(e){if(e.code==='ENOENT')continue;throw e;} for(const instance of doc.instances) {editInput(instance.input,edits);} await writeFile(join(staged,name),encode(doc)); }
    for(const [src,dst,hash] of prepared) {await mkdir(dirname(join(staged,dst)),{recursive:true});await copyFile(src,join(staged,dst));check(await sha(join(staged,dst))===hash,'Authored mesh changed while copying');}
    await copyFile(join(root,'background.json'),join(staged,'source-background.json'));
    for(const [name,expected] of Object.entries(binding.provenance.outputDigests)) if(!name.startsWith('qa/')&&!['background.json','scenario.input.json','episode.episodes.json','episode.replay.episodes.json'].includes(name)) check(await sha(join(staged,name))===expected.sha256,'Source changed while copying: '+name);
    for(const e of edits) if(e.op==='remove') delete bg.actorTracks[e.actorId];
    const trackTimeOffsetsUs={};for(const e of edits) if(e.op==='retime') { const tid=bg.actorTracks[e.actorId];check(tid,'Only recorded rigid actors may be retimed');trackTimeOffsetsUs[tid]=(trackTimeOffsetsUs[tid]??0)-Math.round(e.dtS*1e6); }
    const bundleDigests={};for(const name of await files(staged)) if(name!=='background.json') bundleDigests[name]=await sha(join(staged,name));
    bg.sourcePatch={schema:'simforge.nurec-source-patch/v1',upstream:PIN,baseBackgroundSha256:binding.source.artifacts.find(a=>a.id==='background.json').sha256,edits,meshes,regions,trackTimeOffsetsUs,bundleDigests,qualification:'not-run'};
    await writeFile(join(staged,'background.json'),encode(bg));await rename(staged,out);
  } catch(e) {await rm(staged,{recursive:true,force:true});throw e;}
  return loadNuRecBundle(out,{sourcePackages});
}
export function bindNuRecSceneState(binding, state) {
  check(state.version==='simforge.scene-state.v1','Expected engine simforge.scene-state.v1');const doc=structuredClone(state);
  check(finite(doc.tickHz)&&doc.tickHz>0&&Array.isArray(doc.frames)&&Array.isArray(doc.actors),'Expected canonical scene frames and actors');
  doc.mapId=binding.source.mapId;
  const allowed=new Set(binding.input.actors.map(a=>a.id)), declared=new Set();
  for(const a of doc.actors) {
    check(!declared.has(a.id),'Duplicate scene actor: '+a.id);declared.add(a.id);
    check(allowed.has(a.id),'Actor not present in this immutable fork: '+a.id);
  }
  check(declared.has('ego'),'Bound state requires ego');
  for(const frame of doc.frames) {
    check(Number.isInteger(frame.tick)&&frame.tick>=0&&finite(frame.t)&&Math.abs(frame.t-frame.tick/doc.tickHz)<1e-6,'Invalid scene time');
    check(frame.t>=binding.envelope.timeS[0]&&frame.t<binding.envelope.timeS[1],'Tick outside supported half-open time envelope');
    check(Array.isArray(frame.actors),'Expected scene frame actors');const ids=new Set();
    for(const a of frame.actors) {
      check(!ids.has(a.id),'Duplicate scene actor: '+a.id);ids.add(a.id);
      check(allowed.has(a.id)&&declared.has(a.id),'Actor not present in this immutable fork: '+a.id);
      if(a.id!=='ego'&&a.kind!=='despawn') check(binding.background.actorTracks[a.id]||binding.background.sourcePatch?.meshes?.[a.id],'Actor requires a pinned rigid-track or fork mesh: '+a.id);
    }
    check(frame.actors.some(a=>a.id==='ego'&&a.kind!=='despawn'),'Bound frame requires ego');
  }
  return freeze(doc);
}
/** Execute one SituationProgram over the pinned NuRec source through the native runtime.
 * The program's source must be the exact immutable binding source; nothing here renders,
 * closes a loop with the reconstruction, or qualifies fidelity. */
export async function rehearseNuRecProgram(directory, programFile, seed, {sourcePackages, out}={}) {
  check(typeof seed==='string'&&seed.trim(),'An explicit nonempty seed is required');
  const binding=await loadNuRecBundle(directory,{sourcePackages});
  const program=parseSituationProgram(await json(programFile));
  check(canonicalJson(program.source)===canonicalJson(binding.source),'Program source must be the exact immutable NuRec binding source (inspect BUNDLE); sources are never rewritten to fit a program');
  check(program.template.choreography.clipSeconds<=binding.envelope.timeS[1],'Program clip exceeds the reconstruction time envelope');
  check(program.participants.every(p=>p.authority.every(a=>a.kind!=='policy')),'External policy callbacks are not supplied by this command');
  const runtime=authoringRuntimeIdentity();
  const bundle=await nurecMapBundle(binding);
  const rehearsal=rehearseSituation(program,bundle,{seed});
  const trace=rehearsal.simulation.trace;
  const traceSha256=createHash('sha256').update(canonicalJson(trace)).digest('hex');
  // Canonical scene-state is emitted natively; whether the fork can bind it is reported, never repaired.
  const scene=sceneState(trace);
  let sceneStateBinding;
  try { bindNuRecSceneState(binding,scene); sceneStateBinding={status:'bound'}; }
  catch(error) { sceneStateBinding={status:'rejected',reason:error.message}; }
  const summary={schema:'simforge.nurec-rehearsal/v1',bundle:binding.root,programDigest:situationDigest(program),seed,
    inputHash:trace.header.inputHash,traceSha256,satisfied:rehearsal.satisfied,events:rehearsal.events,constraints:rehearsal.constraints,issues:rehearsal.simulation.issues,
    sceneStateBinding,envelope:binding.envelope,runtime:{digest:runtime.digest,native:runtime.native},
    qualification:'Native engine execution over the pinned NuRec source and clip-local map; no rendering, no closed-loop reconstruction, fidelity unqualified.'};
  if(out!==undefined) {
    const directory=resolve(out);
    await mkdir(directory,{recursive:false,mode:0o700});
    for(const [name,value] of [['program.json',program],['rehearsal.json',rehearsal],['scene-state.json',scene],['runtime-identity.json',runtime],['summary.json',summary]]) {
      await writeFile(join(directory,name),encode(value),{flag:'wx',mode:0o600});
    }
  }
  return summary;
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const positional=[],sourcePackages={};let out;
    const args=process.argv.slice(2);
    for(let i=0;i<args.length;i++) {
      const value=args[i];
      if(value==='--source-package') {
        const mapping=args[++i], split=mapping?.indexOf('=')??-1;
        check(split>0,'Expected --source-package SHA256=ABSOLUTE_PATH');
        const hash=mapping.slice(0,split),path=mapping.slice(split+1);
        check(digest(hash)&&isAbsolute(path),'Expected --source-package SHA256=ABSOLUTE_PATH');
        check(!Object.hasOwn(sourcePackages,hash),'Duplicate source package SHA256: '+hash);
        sourcePackages[hash]=path;
      } else if(value==='--out') {check(out===undefined&&args[i+1]&&!args[i+1].startsWith('-'),'Expected one --out NEW_DIRECTORY');out=args[++i];}
      else {check(!value.startsWith('-'),'Unknown flag: '+value);positional.push(value);}
    }
    const [op,dir,arg,extra]=positional,options={sourcePackages};
    check(out===undefined||op==='rehearse','--out applies only to rehearse');
    let result;
    if(op==='inspect'&&[2,3].includes(positional.length))result=await loadNuRecBundle(dir,{...options,mode:arg??'replay'});
    else if(op==='fork'&&positional.length===4)result=await prepareNuRecFork(dir,arg,await json(extra),options);
    else if(op==='bind'&&positional.length===3)result=bindNuRecSceneState(await loadNuRecBundle(dir,options),await json(arg));
    else if(op==='rehearse'&&positional.length===4)result=await rehearseNuRecProgram(dir,arg,extra,{...options,out});
    else throw new Error('Usage: inspect BUNDLE [replay|policy] | fork BUNDLE NEW_DIRECTORY PATCH.json | bind BUNDLE SCENE_STATE.json | rehearse BUNDLE PROGRAM.json SEED [--out NEW_DIRECTORY]; each accepts repeated --source-package SHA256=ABSOLUTE_PATH');
    console.log(encode(result));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
