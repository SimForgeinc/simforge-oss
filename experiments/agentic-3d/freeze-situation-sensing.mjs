#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {canonicalJson} from '@simforge-oss/engine';
import {makeBriefSensingPolicy, loadBriefSensingPolicy, sensingPolicyDigest, sensingCatalog} from './situation-sensing-policy.mjs';

const MODEL = 'anthropic/claude-opus-5';
const EFFORT = 'high';
const MAX_REQUESTS = 4;
const MAX_OUTPUT_TOKENS = 12000;
const MAX_CONCURRENCY = 8;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(canonicalJson(value));
const check = (condition, reason) => { if (!condition) throw new Error(reason); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag:'wx', mode:0o400});
const errorRecord = error => ({name:error?.name ?? 'Error', reason:String(error?.message ?? error), stack:error?.stack ?? null, issues:error?.issues ?? null});
const planner = Object.freeze({model:MODEL, effort:EFFORT, maxRequests:MAX_REQUESTS, maxOutputTokensPerRequest:MAX_OUTPUT_TOKENS, retries:0});
const scope = 'Experimental declared instrumentation assumptions only; not executed channels, qualified sensor pixels, human fidelity, or scenario acceptance.';

function readCohort(cohortFile) {
  const file = path.resolve(cohortFile), protocolFile = path.join(path.dirname(file), 'protocol.json');
  const cohortBytes = fs.readFileSync(file), protocolBytes = fs.readFileSync(protocolFile);
  const cohort = JSON.parse(cohortBytes), protocol = JSON.parse(protocolBytes);
  check(cohort.schema === 'simforge.situation-benchmark-cohort/v2' && protocol.schema === 'simforge.situation-benchmark-protocol/v2', 'Expected frozen v2 cohort and protocol');
  check(cohort.protocolSha256 === sha(protocolBytes), 'Frozen cohort/protocol digest mismatch: ' + file);
  check(protocol.gatewayImplementation === 'omp-starline' && protocol.operatingModel === MODEL && protocol.effort === EFFORT && cohort.model === MODEL && cohort.effort === EFFORT, 'Expected matching Opus 5 high OMP-Starline cohort/protocol');
  const allocations = protocol.cohorts?.filter(row => row.id === cohort.cohort);
  check(allocations?.length === 1 && Array.isArray(cohort.briefs) && cohort.briefs.length === allocations[0].count && cohort.briefs.length > 0, 'Frozen cohort allocation mismatch');
  check(cohort.briefs.filter(row => row.heldout === true).length === allocations[0].heldout, 'Frozen heldout allocation mismatch');
  const ids = new Set();
  for (const brief of cohort.briefs) {
    check(typeof brief.id === 'string' && brief.id.length > 0 && !ids.has(brief.id), 'Missing or duplicate frozen brief ID');
    ids.add(brief.id);
    check(typeof brief.brief === 'string' && brief.brief.length > 0 && protocol.maps?.includes(brief.mapId), 'Invalid frozen brief text or map identity: ' + brief.id);
    check(Array.isArray(brief.participantRoles) && brief.participantRoles.length > 0 && brief.participantRoles.every(label => typeof label === 'string' && label.trim().length > 0) && new Set(brief.participantRoles).size === brief.participantRoles.length, 'Participant labels must be nonempty and unique: ' + brief.id);
  }
  return {file, protocolFile, cohortBytes, protocolBytes, cohort, protocol, cohortSha256:sha(cohortBytes), protocolSha256:sha(protocolBytes)};
}

function assignmentInputs(cohortFiles) {
  check(Array.isArray(cohortFiles) && cohortFiles.length > 0, 'At least one --cohort is required');
  const sources = cohortFiles.map(readCohort), seen = new Set();
  for (const source of sources) {
    check(source.protocolSha256 === sources[0].protocolSha256, 'All assigned cohorts must use the same frozen protocol');
    check(!seen.has(source.cohort.cohort), 'Duplicate assigned cohort: ' + source.cohort.cohort);
    seen.add(source.cohort.cohort);
  }
  return sources;
}

function submissionSchema(brief, catalog) {
  const recipe = {anyOf:[
    {type:'object', properties:{kind:{const:'constructors'}, sensors:{type:'array', minItems:1, items:{type:'object', properties:{constructor:{enum:['defaultDashCamera','defaultLidar','defaultRadar']}, id:{type:'string', minLength:1}}, required:['constructor','id'], additionalProperties:false}}}, required:['kind','sensors'], additionalProperties:false},
    {type:'object', properties:{kind:{const:'rig'}, preset:{enum:catalog.rigs}, sensorIds:{type:'array', minItems:1, items:{type:'string', minLength:1}}}, required:['kind','preset','sensorIds'], additionalProperties:false},
  ]};
  const participant = {type:'object', properties:{baseRecipe:recipe, controlRecipe:{anyOf:[{type:'null'},recipe]}, rationale:{type:'string', minLength:1}, limitations:{type:'array', items:{type:'string', minLength:1}}}, required:['baseRecipe','controlRecipe','rationale','limitations'], additionalProperties:false};
  return {type:'object', properties:{participants:{type:'object', properties:Object.fromEntries(brief.participantRoles.map(label => [label,participant])), required:brief.participantRoles, additionalProperties:false}, sensingIntervention:{anyOf:[{type:'null'},{type:'object', properties:{briefField:{const:'controlIntervention'}, quote:{type:'string', minLength:1}}, required:['briefField','quote'], additionalProperties:false}]}}, required:['participants','sensingIntervention'], additionalProperties:false};
}

const SYSTEM_PROMPT = `Assign sensing independently for this frozen benchmark brief before scenario authoring or any later author-model comparison. You are an instrumentation planner, not a scenario author, critic, or judge. Your only evidence is the entire assigned frozen brief and the canonical sensing catalog returned by discover_sensing_catalog. Never seek examples, authoring outcomes, historical runs, scene templates, or assets. Do not infer approval, fidelity, acceptance, or human sensing equivalence.
First discover the canonical catalog, then submit exactly one valid policy via submit_policy. The request budget is ${MAX_REQUESTS}; invalid syntax or policy validation may be repaired only within this bound. There is no fallback. Use exact participant labels as object keys. Every label needs one declared recipe, rationale, and honest limitations. Select existing canonical constructors with explicit stable deterministic sensor IDs, or copy one entire canonical rig preset with explicit sensorIds in slot order. Do not invent sensors, tunings, schemas, random IDs, human-eye presets, or scene scaffolds. Choose sensing based on the brief's information and decision demands, with ordinary semantic judgment; a plural participant label does not prescribe group cardinality. The declared recipe applies to each role later bound to that label, resolving mounts against actual actor dimensions. Do not decide concrete program role IDs here.
Use controlRecipe:null to declare the SAME recipe in base and control, never an omitted sensor or fallback. Only use a different control recipe when sensing/attention itself is the explicit causal intervention; cite exact text in the appropriate brief field using sensingIntervention, otherwise null. Do not modify sensing merely because geometry, actor presence, path, or behavior differs between variants. Clearly state limits of canonical sensing for attention and human perception. Instrumentation assumptions, executed channels, and qualified sensor pixels are distinct; assignment proves only the first.`;

async function planBrief(assignment, directory, catalog, createGatewayAgent) {
  const started = Date.now(), errors = [];
  let gateway, policy = null, discovered = false, submissions = 0, stopReason = null;
  const reply = value => ({content:[{type:'text', text:JSON.stringify(value)}], details:value});
  try {
    gateway = createGatewayAgent({modelId:MODEL, effort:EFFORT, maxTokens:MAX_OUTPUT_TOKENS,
      sessionDir:path.join(directory, 'planner-session'), systemPrompt:SYSTEM_PROMPT,
      transformContext(history) {
        if (policy) { stopReason = 'policy-frozen'; throw new Error('Planning stopped: policy already frozen'); }
        if (gateway.usage.requests.length >= MAX_REQUESTS) { stopReason = 'request-budget-exhausted'; throw new Error('Planning request budget exhausted'); }
        return history;
      },
      tools:[
        {name:'discover_sensing_catalog', label:'Discover canonical sensing', description:'Read exact canonical sensing definitions, source/runtime pins and limitations. No scene or outcome retrieval.', parameters:{type:'object', properties:{}, additionalProperties:false}, async execute() { discovered = true; return reply(catalog); }},
        {name:'submit_policy', label:'Submit brief sensing policy', description:'Submit complete selections keyed by every exact frozen participant label. Utility validation freezes the first valid submission, with no later replacement.', parameters:submissionSchema(assignment.brief, catalog), async execute(_id, input) {
          try {
            check(discovered, 'Read discover_sensing_catalog before submission');
            check(!policy, 'A policy is already frozen; replacements are forbidden');
            submissions++;
            const labels = assignment.brief.participantRoles;
            check(input.participants && Object.keys(input.participants).length === labels.length && labels.every(label => Object.hasOwn(input.participants,label)), 'Submit every exact participant label once, with no extras');
            const selections = {participants:labels.map(participant => ({participant,...input.participants[participant]})), sensingIntervention:input.sensingIntervention};
            const candidate = makeBriefSensingPolicy(assignment.brief, selections);
            check(digest(sensingCatalog()) === digest(catalog), 'Canonical sensing runtime changed during planning');
            save(path.join(directory, 'policy.json'), candidate);
            policy = candidate;
            return reply({frozen:true, digest:sensingPolicyDigest(policy), scope});
          } catch (error) {
            const record = errorRecord(error); errors.push({phase:'submission', submission:submissions, ...record});
            return {...reply({frozen:false, error:record, repairWithinRequestBudgetOnly:true}), isError:true};
          }
        }},
      ],
    });
    gateway.save();
    await gateway.agent.prompt('Assign sensing for this entire frozen brief record only:\n' + canonicalJson(assignment.brief));
  } catch (error) {
    if (!stopReason) errors.push({phase:'planner', ...errorRecord(error)});
  } finally {
    if (gateway) gateway.save();
  }
  if (!policy) errors.push({phase:'completion', reason:stopReason ?? 'Planner ended without a valid submitted policy'});
  const usage = gateway?.usage ?? {requests:[], cost:{currency:'USD', total:null, reportedTotal:null, reportedRequests:0, unavailableRequests:0}};
  const result = {assignmentId:assignment.assignmentId, briefId:assignment.brief.id, cohort:assignment.cohort, status:policy?'frozen':'failed', policyFile:policy?`${assignment.directory}/policy.json`:null, policyDigest:policy?sensingPolicyDigest(policy):null, planner, identity:gateway?.identity ?? null, requests:usage.requests.length, submissions, stopReason, elapsedMs:Date.now()-started, cost:usage.cost ?? {currency:'USD',total:null}, errors};
  save(path.join(directory, 'planner-usage.json'), usage);
  save(path.join(directory, 'planner-errors.json'), errors);
  save(path.join(directory, 'result.json'), result);
  return result;
}

function artifactInventory(directory) {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(directory,relative), {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      check(!entry.isSymbolicLink(), 'Evidence may not contain symlinks');
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && name !== 'manifest.json') files.push({file:name, sha256:sha(fs.readFileSync(path.join(directory,name)))});
    }
  }
  walk('');
  return files;
}

export async function freezeSituationSensing({cohortFiles, out, concurrency=1}) {
  check(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= MAX_CONCURRENCY, 'Concurrency must be an integer in [1,8]');
  const sources = assignmentInputs(cohortFiles), directory = path.resolve(out);
  fs.mkdirSync(directory, {recursive:false, mode:0o700});
  const assignments = [], sourceRecords = [];
  for (const [index, source] of sources.entries()) {
    const relative = `sources/${String(index+1).padStart(3,'0')}`;
    fs.mkdirSync(path.join(directory,relative), {recursive:true, mode:0o700});
    for (const [file, bytes] of [['cohort.json',source.cohortBytes],['protocol.json',source.protocolBytes]]) fs.writeFileSync(path.join(directory,relative,file), bytes, {flag:'wx', mode:0o400});
    sourceRecords.push({cohort:source.cohort.cohort, originalCohortFile:source.file, originalProtocolFile:source.protocolFile, cohortFile:`${relative}/cohort.json`, protocolFile:`${relative}/protocol.json`, cohortSha256:source.cohortSha256, protocolSha256:source.protocolSha256});
    for (const brief of source.cohort.briefs) {
      const assignmentId = String(assignments.length+1).padStart(6,'0');
      assignments.push({assignmentId, directory:`briefs/${assignmentId}`, cohort:source.cohort.cohort, cohortSha256:source.cohortSha256, protocolSha256:source.protocolSha256, briefDigest:digest(brief), brief});
    }
  }
  // The complete original denominator and source bytes exist before catalog loading or any gateway session.
  save(path.join(directory, 'assignments.json'), {schema:'simforge.brief-sensing-assignments/v1', planner, concurrency, scope, sources:sourceRecords, assignments});
  for (const assignment of assignments) {
    fs.mkdirSync(path.join(directory,assignment.directory), {recursive:true, mode:0o700});
    save(path.join(directory,assignment.directory,'assignment.json'), assignment);
  }
  const results = new Array(assignments.length);
  let catalog, createGatewayAgent, setupError;
  try {
    catalog = sensingCatalog();
    save(path.join(directory, 'sensing-catalog.json'), catalog);
    const local = path.dirname(fileURLToPath(import.meta.url));
    save(path.join(directory, 'planner-runtime.json'), {schema:'simforge.sensing-planner-runtime/v1', node:process.versions.node, files:['freeze-situation-sensing.mjs','situation-sensing-policy.mjs','gateway.mjs'].map(file => ({file, sha256:sha(fs.readFileSync(path.join(local,file)))})), catalogDigest:digest(catalog)});
    ({createGatewayAgent} = await import('./gateway.mjs'));
  } catch (error) { setupError = errorRecord(error); }
  let next = 0;
  async function worker() {
    while (next < assignments.length) {
      const index = next++, assignment = assignments[index], briefDirectory = path.join(directory,assignment.directory);
      try {
        if (setupError) throw Object.assign(new Error(setupError.reason), {cause:setupError});
        results[index] = await planBrief(assignment, briefDirectory, catalog, createGatewayAgent);
      } catch (error) {
        const failure = {assignmentId:assignment.assignmentId, briefId:assignment.brief.id, cohort:assignment.cohort, status:'failed', policyFile:null, policyDigest:null, planner, cost:{currency:'USD',total:null}, errors:[{phase:'infrastructure',...errorRecord(error)}]};
        save(path.join(briefDirectory,'infrastructure-failure.json'), failure);
        results[index] = failure;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,assignments.length)}, worker));
  const manifest = {schema:'simforge.brief-sensing-freeze/v1', scope, planner, concurrency, assigned:assignments.length, frozen:results.filter(row => row.status === 'frozen').length, failed:results.filter(row => row.status !== 'frozen').length, complete:results.every(row => row.status === 'frozen'), setupError:setupError ?? null, results, artifacts:artifactInventory(directory)};
  const verification = verifyFreeze(directory, manifest);
  manifest.complete = manifest.complete && verification.valid;
  manifest.verificationIssues = verification.issues;
  save(path.join(directory, 'manifest.json'), manifest);
  return {out:directory, complete:manifest.complete, assigned:manifest.assigned, frozen:manifest.frozen, failed:manifest.failed, verification};
}

/** Read-only verification uses saved assignments and policies; it never creates a session or rerolls evidence. */
export function verifySituationSensing(directory) {
  return verifyFreeze(directory);
}

function verifyFreeze(directory, suppliedManifest) {
  directory = path.resolve(directory);
  const issues = [], policies = [];
  const issue = (code, file, reason) => issues.push({code,path:file,reason});
  let manifest, assignmentRecord;
  try {
    manifest = suppliedManifest ?? json(path.join(directory,'manifest.json'));
    assignmentRecord = json(path.join(directory,'assignments.json'));
    check(manifest.schema === 'simforge.brief-sensing-freeze/v1' && assignmentRecord.schema === 'simforge.brief-sensing-assignments/v1', 'Unknown sensing freeze schema');
    check(digest(manifest.planner) === digest(planner) && digest(assignmentRecord.planner) === digest(planner), 'Planner contract mismatch');
    check(Array.isArray(manifest.artifacts) && Array.isArray(manifest.results), 'Invalid manifest inventory');
    const actual = artifactInventory(directory);
    check(digest(actual) === digest(manifest.artifacts), 'Frozen artifact inventory/hash mismatch');
    const sourceInputs = assignmentRecord.sources.map(source => {
      check(/^sources\/\d{3}\/cohort\.json$/.test(source.cohortFile) && source.protocolFile === source.cohortFile.replace('cohort.json','protocol.json'), 'Invalid source snapshot path');
      const input = readCohort(path.join(directory,source.cohortFile));
      check(input.cohortSha256 === source.cohortSha256 && input.protocolSha256 === source.protocolSha256 && input.cohort.cohort === source.cohort, 'Source snapshot identity mismatch');
      return input;
    });
    const expected = assignmentInputs(sourceInputs.map(source => source.file)).flatMap(source => source.cohort.briefs.map(brief => ({brief, source})));
    check(expected.length === assignmentRecord.assignments.length && manifest.assigned === expected.length && manifest.results.length === expected.length, 'Assigned denominator mismatch');
    for (const [index, {brief,source}] of expected.entries()) {
      const assignment = assignmentRecord.assignments[index], result = manifest.results[index];
      const id = String(index+1).padStart(6,'0'), relative = `briefs/${id}`;
      check(assignment.assignmentId === id && assignment.directory === relative && assignment.cohort === source.cohort.cohort && assignment.cohortSha256 === source.cohortSha256 && assignment.protocolSha256 === source.protocolSha256 && assignment.briefDigest === digest(brief) && digest(assignment.brief) === digest(brief), 'Assignment/source mismatch: ' + id);
      check(digest(json(path.join(directory,relative,'assignment.json'))) === digest(assignment), 'Per-brief assignment mismatch: ' + id);
      check(result.assignmentId === id && result.briefId === brief.id && result.cohort === source.cohort.cohort, 'Result assignment mismatch: ' + id);
      if (result.status !== 'frozen') { issue('policy_missing',relative,'Assigned brief has no valid frozen policy'); continue; }
      try {
        check(result.policyFile === `${relative}/policy.json`, 'Invalid policy file binding');
        const loaded = loadBriefSensingPolicy(path.join(directory,result.policyFile), brief);
        check(loaded.digest === result.policyDigest, 'Policy digest mismatch');
        check(digest(json(path.join(directory,relative,'result.json'))) === digest(result), 'Planner result differs from manifest');
        const session = json(path.join(directory,relative,'planner-session/session.json'));
        check(session.identity?.requestedModel === MODEL && session.identity?.requestedEffort === EFFORT && session.identity?.routingVerified === true && session.identity?.requestEffortVerified === true, 'Missing exact planner routing/effort evidence');
        check(session.usage?.requests?.length > 0 && session.usage.requests.length <= MAX_REQUESTS && result.requests === session.usage.requests.length, 'Planner request bound/evidence mismatch');
        policies.push({assignmentId:id, cohort:assignment.cohort, briefId:brief.id, file:result.policyFile, digest:loaded.digest});
      } catch (error) { issue('policy_invalid',relative,String(error.message ?? error)); }
    }
    check(manifest.frozen === manifest.results.filter(row => row.status === 'frozen').length && manifest.failed === manifest.assigned-manifest.frozen, 'Manifest status counts mismatch');
    if (!manifest.complete || manifest.failed !== 0 || policies.length !== manifest.assigned) issue('freeze_incomplete','manifest.json','Not every assigned brief has a verified frozen policy');
  } catch (error) { issue('freeze_invalid','manifest.json',String(error.message ?? error)); }
  return {valid:issues.length === 0, complete:issues.length === 0, assigned:assignmentRecord?.assignments?.length ?? null, verifiedPolicies:policies.length, policies, issues, scope};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const cohortFiles = [], flags = new Map();
    for (let i=2; i<process.argv.length; i+=2) {
      const name = process.argv[i], value = process.argv[i+1];
      check(['--cohort','--out','--concurrency','--verify'].includes(name) && value && !value.startsWith('--'), 'Usage: --cohort FILE [--cohort FILE ...] --out NEW_DIRECTORY [--concurrency 1..8] | --verify DIRECTORY');
      if (name === '--cohort') cohortFiles.push(value);
      else { check(!flags.has(name),'Duplicate option: '+name); flags.set(name,value); }
    }
    let result;
    if (flags.has('--verify')) {
      check(flags.size === 1 && cohortFiles.length === 0, '--verify is read-only and cannot be combined with generation options');
      result = verifySituationSensing(flags.get('--verify'));
    } else {
      check(flags.has('--out') && cohortFiles.length > 0, '--cohort and --out are required');
      const concurrency = flags.has('--concurrency') ? Number(flags.get('--concurrency')) : 1;
      result = await freezeSituationSensing({cohortFiles, out:flags.get('--out'), concurrency});
    }
    console.log(JSON.stringify(result,null,2));
    process.exitCode = result.complete ? 0 : 2;
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
