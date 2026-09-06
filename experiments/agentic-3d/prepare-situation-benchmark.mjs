#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {canonicalJson} from '@simforge-oss/engine';
import {SCENARIO_REVIEW_POLICY, DIVERSITY_REVIEW_POLICY, policyDigest} from './situation-ensemble.mjs';
import {AUTHOR_MODEL, AUTHOR_MODELS, AUTHOR_EFFORT, GATEWAY_TIMEOUT_MS, ASTRA_MODEL} from './gateway.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value,null,2)+'\n';
const requireValue = (condition,message) => {if(!condition) throw new Error(message);};

// Locate the original top-level JSON value without reserializing any brief bytes.
function briefBytes(text) {
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;
  let depth=0, expectingKey=false, key=null, start=null, valueDepth=null;
  for(const token of text.matchAll(tokens)) {
    const value=token[0];
    if(depth===1&&expectingKey&&value.startsWith('"')) {key=JSON.parse(value);expectingKey=false;continue;}
    if(depth===1&&key==='briefs'&&value==='['&&start===null) {start=token.index;valueDepth=depth;}
    if(value==='{'||value==='[') {depth++;if(depth===1) expectingKey=true;}
    else if(value==='}'||value===']') {
      depth--;
      if(start!==null&&depth===valueDepth) return text.slice(start,token.index+1);
    } else if(value===','&&depth===1) {expectingKey=true;key=null;}
  }
  throw new Error('Frozen cohort must contain a top-level briefs array');
}

function readSource(source) {
  source=path.resolve(source);
  const originalBytes=fs.readFileSync(path.join(source,'protocol.json'));
  const original=JSON.parse(originalBytes);
  requireValue(original.schema==='simforge.situation-benchmark-protocol/v2','Expected frozen ensemble protocol');
  requireValue(original.evaluation?.scenario?.policyDigest===policyDigest(SCENARIO_REVIEW_POLICY)&&original.evaluation?.diversity?.policyDigest===policyDigest(DIVERSITY_REVIEW_POLICY),'Frozen judge policies differ');
  requireValue(original.arms.length===2&&new Set(original.arms.map(arm=>arm.id)).size===2&&original.arms.every(arm=>['C','D'].includes(arm.id)&&arm.tools==='situation'&&arm.branching===(arm.id==='D')),'Expected C/D situation-tool authoring arms');
  const sourceProtocolSha256=sha(originalBytes);
  const cohorts=original.cohorts.map(cohort=> {
    requireValue(typeof cohort.id==='string'&&/^[A-Za-z0-9_-]+$/.test(cohort.id),'Invalid cohort filename');
    const file=cohort.id+'.json', bytes=fs.readFileSync(path.join(source,file)), old=JSON.parse(bytes);
    requireValue(old.schema==='simforge.situation-benchmark-cohort/v2'&&old.protocolSha256===sourceProtocolSha256&&old.briefs.length===cohort.count&&new Set(old.briefs.map(b=>b.id)).size===cohort.count,'Original frozen cohort binding or allocation invalid: '+file);
    requireValue(old.briefs.filter(b=>b.heldout===true).length===cohort.heldout,'Original heldout allocation invalid: '+file);
    const rawBriefs=briefBytes(bytes.toString('utf8'));
    requireValue(canonicalJson(JSON.parse(rawBriefs))===canonicalJson(old.briefs),'Ambiguous frozen briefs array');
    return {file,bytes,old,rawBriefs,provenance:{sourceCohortSha256:sha(bytes),sourceProtocolSha256,briefsSha256:sha(rawBriefs),briefDigests:old.briefs.map(brief=>({id:brief.id,digest:sha(canonicalJson(brief))}))}};
  });
  requireValue(new Set(cohorts.map(cohort=>cohort.file)).size===cohorts.length,'Duplicate cohort filenames');
  return {source,originalBytes,original,sourceProtocolSha256,cohorts};
}

function modelFiles(input,authorModel,sensingFreeze) {
  requireValue(AUTHOR_MODELS.includes(authorModel),'Unsupported exact author model; no fallback is permitted');
  requireValue(AUTHOR_EFFORT==='high'&&GATEWAY_TIMEOUT_MS[AUTHOR_EFFORT]===600000,'Four-model protocol requires high effort and a common 600000ms request cap');
  const {original,sourceProtocolSha256}=input;
  const protocol=structuredClone(original);
  protocol.operatingModel=authorModel;
  protocol.effort=AUTHOR_EFFORT;
  protocol.requestTimeoutMs=GATEWAY_TIMEOUT_MS[AUTHOR_EFFORT];
  protocol.transportAdjustment={assertedBy:'Main',reason:'Observed high-effort author request aborted at the former 180-second transport deadline',retries:0,lowEffortTimeoutMs:GATEWAY_TIMEOUT_MS.low,highEffortTimeoutMs:GATEWAY_TIMEOUT_MS.high};
  protocol.operatingModelScope='Scenario author/director and its branch/repair decisions only. Scoped participant critics and independent judge ensembles remain Astra-low.';
  protocol.arms=protocol.arms.map(arm=>({...arm,model:authorModel,effort:AUTHOR_EFFORT}));
  protocol.modelComparison={status:'planned-not-run',authorModel,authorModels:AUTHOR_MODELS,authorEffort:AUTHOR_EFFORT,requestTimeoutMs:protocol.requestTimeoutMs,reviewerModel:ASTRA_MODEL,
    sourceProtocolSha256,sourceCohorts:input.cohorts.map(({file,provenance})=>({file,...provenance})),sensingFreeze:sensingFreeze?path.resolve(sensingFreeze):null,
    controls:['Same frozen briefs and assigned failures','Same tools and C/D branching arms','Same matched/natural-stopping budgets, seeds and rendering protocol','Same independent judge policies','Same frozen sensing policies by exact brief identity, never regenerated per model'],
    outcomes:['Eventual acceptance in initial bounded runs','First-submission acceptance','Authoring cycles and tool/model requests','Failures, latency and available cost data']};
  protocol.amendment={decisionId:'decision-opus-high-author-four-model-benchmark-20260905',assertedBy:'Michael',date:'2026-09-05',sourceProtocolSha256,
    changes:['Use Claude Opus 5 high for current scenario authors','Keep independent Astra-low judges unchanged','Later compare GPT 5.6 Sol, GPT 6 Astra, Claude Opus 5 and Claude Fable 5.1 as authors at the same declared effort'],
    preserved:['Every original brief and cohort allocation','Matched and natural-stopping budgets','All numeric development and final targets','Source, asset, replay, event and causal gates','All historical artifacts and failures']};
  const protocolBytes=encode(protocol), protocolSha256=sha(protocolBytes);
  const files=[{file:'protocol.json',bytes:protocolBytes},{file:'source/protocol.json',bytes:input.originalBytes}];
  for(const {file,bytes,old,rawBriefs,provenance} of input.cohorts) {
    const {briefs,...metadata}=old;
    const amended={...metadata,model:authorModel,effort:AUTHOR_EFFORT,protocolSha256,provenance:{...provenance,briefsUnchanged:true,amendment:protocol.amendment.decisionId,sourceProvenance:old.provenance??null}};
    const encoded=JSON.stringify(amended,null,2);
    files.push({file,bytes:encoded.slice(0,-1)+',\n  "briefs": '+rawBriefs+'\n}\n'},{file:'source/'+file,bytes});
  }
  return {protocol,protocolSha256,files};
}

function writeModel(out,input,prepared) {
  const {protocol,protocolSha256,files}=prepared;
  fs.mkdirSync(out,{recursive:false,mode:0o700});
  fs.mkdirSync(path.join(out,'source'),{mode:0o700});
  for(const item of files) fs.writeFileSync(path.join(out,item.file),item.bytes,{flag:'wx',mode:0o400});
  const integrity={schema:'simforge.situation-benchmark-integrity/v2',status:'planned-not-run',amendment:protocol.amendment.decisionId,sourceProtocolSha256:input.sourceProtocolSha256,files:files.map(item=>({file:item.file,sha256:sha(item.bytes)}))};
  fs.writeFileSync(path.join(out,'integrity.json'),encode(integrity),{flag:'wx',mode:0o400});
  return {out,status:'planned-not-run',authorModel:protocol.operatingModel,authorEffort:protocol.effort,requestTimeoutMs:protocol.requestTimeoutMs,protocolSha256,cohorts:protocol.cohorts,files:integrity.files};
}

/** A user-directed protocol amendment, never a new draw or a rewrite of frozen briefs. */
export function prepareSituationBenchmark({source,out,authorModel=AUTHOR_MODEL,sensingFreeze}) {
  const input=readSource(source);out=path.resolve(out);
  requireValue(input.source!==out,'Destination must be a new directory');
  return writeModel(out,input,modelFiles(input,authorModel,sensingFreeze));
}

/** Prepare all authors from a single read of frozen inputs; no model or planner runs. */
export function prepareSituationModelComparison({source,out,sensingFreeze}) {
  const input=readSource(source);out=path.resolve(out);
  requireValue(input.source!==out,'Destination must be a new directory');
  const prepared=AUTHOR_MODELS.map(authorModel=>({directory:authorModel.replaceAll('/','--'),data:modelFiles(input,authorModel,sensingFreeze)}));
  requireValue(new Set(prepared.map(row=>row.directory)).size===AUTHOR_MODELS.length,'Model directory collision');
  fs.mkdirSync(out,{recursive:false,mode:0o700});
  const models=prepared.map(({directory,data})=>({directory,...writeModel(path.join(out,directory),input,data)}));
  const manifest={schema:'simforge.situation-model-comparison/v1',status:'planned-not-run',source:input.source,sourceProtocolSha256:input.sourceProtocolSha256,
    sourceCohorts:input.cohorts.map(({file,provenance})=>({file,...provenance})),sensingFreeze:sensingFreeze?path.resolve(sensingFreeze):null,authorEffort:AUTHOR_EFFORT,requestTimeoutMs:GATEWAY_TIMEOUT_MS[AUTHOR_EFFORT],models};
  fs.writeFileSync(path.join(out,'comparison.json'),encode(manifest),{flag:'wx',mode:0o400});
  return {out,...manifest};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const flags=new Map(),usage='Usage: --source FROZEN_ENSEMBLE_DIRECTORY --out NEW_DIRECTORY [--author-model EXACT_MODEL | --all-author-models] [--sensing-freeze DIRECTORY]';
    for(let i=2;i<process.argv.length;i++) {
      const name=process.argv[i];
      requireValue(['--source','--out','--author-model','--all-author-models','--sensing-freeze'].includes(name)&&!flags.has(name),usage);
      if(name==='--all-author-models') {flags.set(name,true);continue;}
      const value=process.argv[++i];requireValue(value&&!value.startsWith('--'),usage);flags.set(name,value);
    }
    requireValue(flags.has('--source')&&flags.has('--out')&&!(flags.has('--all-author-models')&&flags.has('--author-model')),usage);
    const options={source:flags.get('--source'),out:flags.get('--out'),authorModel:flags.get('--author-model'),sensingFreeze:flags.get('--sensing-freeze')};
    console.log(JSON.stringify(flags.has('--all-author-models')?prepareSituationModelComparison(options):prepareSituationBenchmark(options),null,2));
  } catch(error) {console.error(error.stack??error);process.exitCode=1;}
}
