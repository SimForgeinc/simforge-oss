#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {runSituationAuthoring} from './situation-loop.mjs';
import {assert, fileHash, saveJson} from './situation-authoring-resources.mjs';
import {canonicalJson} from '@simforge-oss/engine';
import {SCENARIO_REVIEW_POLICY, DIVERSITY_REVIEW_POLICY, policyDigest} from './situation-ensemble.mjs';
import {AUTHOR_MODELS, AUTHOR_EFFORTS, GATEWAY_TIMEOUT_MS} from './gateway.mjs';
import {verifySituationSensing} from './freeze-situation-sensing.mjs';
import {loadBriefSensingPolicy} from './situation-sensing-policy.mjs';
import {authoringRuntimeIdentity, changedRuntimeFiles} from './runtime-identity.mjs';

const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export async function runFrozenBrief({cohortFile,id,arm,mode,out,sensingFreeze,workbench='http://127.0.0.1:8767',capabilityMemory}) {
  assert(['C','D'].includes(arm),'Only situation-tool arms C/D are supported');
  assert(['matched','naturalStopping'].includes(mode),'mode must be matched or naturalStopping');
  assert(typeof sensingFreeze==='string'&&sensingFreeze,'A frozen per-brief sensing collection is required');
  const cohortPath=path.resolve(cohortFile),protocolPath=path.join(path.dirname(cohortPath),'protocol.json');
  const cohort=json(cohortPath),protocol=json(protocolPath),protocolHash=fileHash(protocolPath);
  assert(cohort.schema==='simforge.situation-benchmark-cohort/v2'&&protocol.schema==='simforge.situation-benchmark-protocol/v2'&&cohort.protocolSha256===protocolHash,'Frozen v2 cohort/protocol identity mismatch');
  assert(protocol.evaluation?.scenario?.policyDigest===policyDigest(SCENARIO_REVIEW_POLICY)&&protocol.evaluation?.diversity?.policyDigest===policyDigest(DIVERSITY_REVIEW_POLICY),'Frozen ensemble policies mismatch');
  assert(AUTHOR_MODELS.includes(protocol.operatingModel)&&AUTHOR_EFFORTS.includes(protocol.effort)&&protocol.gatewayImplementation==='omp-starline'&&cohort.model===protocol.operatingModel&&cohort.effort===protocol.effort,'Unsupported or mismatched author model/effort protocol');
  assert(protocol.requestTimeoutMs===GATEWAY_TIMEOUT_MS[protocol.effort],'Frozen author request timeout mismatch');
  const rows=cohort.briefs.filter(row=>row.id===id);assert(rows.length===1,'Brief ID must occur exactly once in the assigned cohort');
  const brief=rows[0],budgets=protocol.budgets[mode];
  assert(protocol.arms.some(row=>row.id===arm&&row.tools==='situation'&&row.branching===(arm==='D')&&row.model===protocol.operatingModel&&row.effort===protocol.effort),'Arm contract mismatch');
  const directory=path.resolve(out);fs.mkdirSync(directory,{recursive:false,mode:0o700});
  const assignment={schema:'simforge.situation-assignment/v1',cohort:cohort.cohort,cohortSha256:fileHash(cohortPath),protocolSha256:protocolHash,id,arm,mode,brief,budgets,authorModel:protocol.operatingModel,authorEffort:protocol.effort,authorRequestTimeoutMs:protocol.requestTimeoutMs,
    seed:`${cohort.cohort}:${id}:v2`,source:'frozen-cohort',replacement:false,qualification:'automated-unqualified',sensingFreeze:path.resolve(sensingFreeze)};
  fs.copyFileSync(cohortPath,path.join(directory,'cohort.json'),fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(protocolPath,path.join(directory,'protocol.json'),fs.constants.COPYFILE_EXCL);
  saveJson(path.join(directory,'assignment.json'),assignment);
  // The runtime that executes this assignment: loaded native addon bytes, published package artifacts, lockfile and local modules.
  const implementation=authoringRuntimeIdentity();saveJson(path.join(directory,'runtime-identity.json'),implementation);
  const started=performance.now();let result;
  try {
    const verification=verifySituationSensing(assignment.sensingFreeze);
    assert(!verification.issues.some(issue=>issue.code==='freeze_invalid'),'Frozen sensing collection integrity failed: '+canonicalJson(verification.issues));
    const policies=verification.policies.filter(row=>row.cohort===cohort.cohort&&row.briefId===id);
    assert(policies.length===1,'This assigned brief has no verified frozen sensing policy; no replacement or fallback is permitted');
    const sensingPolicyFile=path.join(assignment.sensingFreeze,policies[0].file),sensing=loadBriefSensingPolicy(sensingPolicyFile,brief);
    assignment.sensingPolicyDigest=sensing.digest;
    assignment.sensingFreezeManifestSha256=fileHash(path.join(assignment.sensingFreeze,'manifest.json'));
    saveJson(path.join(directory,'assignment.json'),assignment);
    result=await runSituationAuthoring({brief:brief.brief,briefRecord:brief,map:brief.mapId,out:directory,workbench,seed:assignment.seed,branching:arm==='D',authorModel:protocol.operatingModel,authorEffort:protocol.effort,sensingPolicyFile,
      maxCalls:budgets.modelCalls,maxRehearsals:budgets.rehearsalAttempts,maxSubmissions:budgets.submissions,maxOutputTokens:budgets.maxOutputTokensPerCall,
      ...(capabilityMemory?{capabilityMemory}: {})});
    const changed=changedRuntimeFiles(implementation);
    if(changed.length) {
      saveJson(path.join(directory,'runtime-change-failure.json'),{changed,priorResult:result});
      result={...result,status:'infrastructure',decision:{explanation:'Pinned native runtime, package artifacts or local authoring files changed during the assigned run',changed},qualification:'incomplete'};
    }
  } catch(error) {
    result={status:'infrastructure',out:directory,decision:{explanation:String(error.stack??error)},evaluation:{kind:'llm-ensemble',policyDigest:policyDigest(SCENARIO_REVIEW_POLICY),reviewId:null,evidenceDigest:null,decision:null,members:[]},qualification:'incomplete'};
    saveJson(path.join(directory,'assignment-failure.json'),result);
  }
  const outcome={...result,assignment:{id,cohort:cohort.cohort,arm,mode,protocolSha256:protocolHash,runtimeDigest:implementation.digest},assignedWallMs:performance.now()-started};
  saveJson(path.join(directory,'outcome.json'),outcome);return outcome;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const flags=new Map();
  try {
    for(let i=2;i<process.argv.length;i+=2) {const name=process.argv[i],value=process.argv[i+1];assert(['--cohort','--id','--arm','--mode','--out','--sensing-freeze','--workbench','--capability-memory'].includes(name)&&value&&!flags.has(name),'Invalid or duplicate CLI option');flags.set(name,value);}
    for(const name of ['--cohort','--id','--arm','--mode','--out','--sensing-freeze']) assert(flags.has(name),'Missing '+name);
    const result=await runFrozenBrief({cohortFile:flags.get('--cohort'),id:flags.get('--id'),arm:flags.get('--arm'),mode:flags.get('--mode'),out:flags.get('--out'),sensingFreeze:flags.get('--sensing-freeze'),workbench:flags.get('--workbench'),capabilityMemory:flags.get('--capability-memory')});
    console.log(JSON.stringify({status:result.status,out:result.out,assignment:result.assignment,iterations:result.iterations,counters:result.counters}));
    process.exitCode=result.status==='ensemble_accepted'?0:2;
  } catch(error) {console.error(error.stack??error);process.exitCode=1;}
}
