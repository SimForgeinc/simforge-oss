#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {reportSituationBenchmark} from './situation-benchmark-report.mjs';
import {AUTHOR_MODELS, AUTHOR_EFFORTS, GATEWAY_TIMEOUT_MS} from './gateway.mjs';

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const now = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = a => JSON.stringify([a.cohort, a.briefId, a.arm, a.mode]);
function atomic(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  try { if (exclusive) fs.linkSync(temporary, file); else fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function processIdentity(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; }
  catch { return null; }
}
function measuredChild(child) {
  let rssBytes = null, cpuTicks = null;
  try {
    const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
    if (match) rssBytes = Number(match[1]) * 1024;
    const fields = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    cpuTicks = Number(fields[11]) + Number(fields[12]);
  } catch { /* Exited or inaccessible: measurements remain unknown. */ }
  return {pid: child.pid ?? null, kind: child.kind, rssBytes, cpuTicks};
}
async function availablePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

export async function runBenchmark(configFile, {capacityLimit} = {}) {
  requireThat(process.platform === 'linux', 'Owned process groups and resource observations require Linux');
  const configPath = path.resolve(configFile), input = readJson(configPath);
  const absolute = value => path.resolve(path.dirname(configPath), value);
  requireThat(typeof input.sensingFreeze === 'string' && input.sensingFreeze, 'A frozen per-brief sensing collection is required');
  const config = {...input, cohortFile: absolute(input.cohortFile), out: absolute(input.out),
    blenderExecutable: absolute(input.blenderExecutable),
    sensingFreeze: absolute(input.sensingFreeze),
    residentCapacity: input.residentCapacity ?? 1, concurrentCapacity: input.concurrentCapacity ?? 1,
    startupTimeoutMs: input.startupTimeoutMs ?? 600000,
    assignmentTimeoutMs: input.assignmentTimeoutMs ?? 3600000,
    sampleIntervalMs: input.sampleIntervalMs ?? 5000,
    capabilityMemory: input.capabilityMemory ? absolute(input.capabilityMemory) : null};
  for (const field of ['residentCapacity', 'concurrentCapacity', 'startupTimeoutMs', 'assignmentTimeoutMs', 'sampleIntervalMs'])
    requireThat(Number.isSafeInteger(config[field]) && config[field] > 0, `Invalid ${field}`);
  requireThat(config.concurrentCapacity <= config.residentCapacity, 'Concurrent capacity exceeds resident capacity');
  const effectiveCapacity = capacityLimit ?? config.concurrentCapacity;
  requireThat(Number.isSafeInteger(effectiveCapacity) && effectiveCapacity > 0 && effectiveCapacity <= config.concurrentCapacity, 'Capacity limit must be positive and cannot exceed the frozen configured concurrency');
  requireThat(Number.isInteger(config.basePort) && config.basePort > 1024 && config.basePort + config.residentCapacity <= 65536, 'Invalid private port range');
  requireThat(![8766, 8767].some(port => port >= config.basePort && port < config.basePort + config.residentCapacity), 'Existing 8766/8767 services are protected');
  for (const field of ['ids', 'arms', 'modes']) requireThat(Array.isArray(config[field]) && config[field].length && new Set(config[field]).size === config[field].length, `Nonempty unique ${field} required`);
  requireThat(config.arms.every(arm => ['C', 'D'].includes(arm)), 'Only situation-tool arms C/D are supported');
  requireThat(config.modes.every(mode => ['matched', 'naturalStopping'].includes(mode)), 'Unsupported budget mode');
  const cohort = readJson(config.cohortFile), protocolFile = path.join(path.dirname(config.cohortFile), 'protocol.json');
  const protocol = readJson(protocolFile), protocolSha256 = digest(protocolFile), cohortSha256 = digest(config.cohortFile);
  requireThat(cohort.schema === 'simforge.situation-benchmark-cohort/v2' && protocol.schema === 'simforge.situation-benchmark-protocol/v2' && cohort.protocolSha256 === protocolSha256, 'Cohort/protocol v2 identity mismatch');
  requireThat(AUTHOR_MODELS.includes(protocol.operatingModel) && AUTHOR_EFFORTS.includes(protocol.effort) && protocol.gatewayImplementation === 'omp-starline' && cohort.model === protocol.operatingModel && cohort.effort === protocol.effort, 'Unsupported or mismatched author model/effort protocol');
  requireThat(protocol.requestTimeoutMs === GATEWAY_TIMEOUT_MS[protocol.effort], 'Frozen author request timeout mismatch');
  const assignments = [];
  for (const id of config.ids) {
    const matches = cohort.briefs.filter(brief => brief.id === id);
    requireThat(matches.length === 1, `Unknown or ambiguous brief ${id}`);
    for (const arm of config.arms) for (const mode of config.modes) assignments.push({cohort: cohort.cohort, briefId: id, brief: matches[0].brief, mapId: matches[0].mapId, arm, mode,
      runDir: `runs/${String(assignments.length + 1).padStart(6, '0')}`});
  }
  const maps = {};
  for (const mapId of new Set(assignments.map(a => a.mapId))) {
    requireThat(typeof input.manifests?.[mapId] === 'string', `Prepared manifest required for ${mapId}`);
    const file = absolute(input.manifests[mapId]), manifest = readJson(file);
    const cases = manifest.cases?.filter(row => row.id === 'map-only' && row.mapId === mapId);
    requireThat(manifest.schema === 'simforge.renderer-bakeoff/v1' && cases?.length === 1 && cases[0].actors?.length === 0, `Invalid prepared map-only manifest: ${mapId}`);
    maps[mapId] = {file, sha256: digest(file), caseId: 'map-only'};
  }
  config.manifests = maps;
  if (config.capabilityMemory) config.capabilityMemorySha256 = digest(config.capabilityMemory);
  config.sensingFreezeManifestSha256 = digest(path.join(config.sensingFreeze, 'manifest.json'));
  fs.accessSync(config.blenderExecutable, fs.constants.X_OK);
  const manifest = {schema: 'simforge.situation-benchmark-run/v1', protocolFile, protocolSha256,
    cohortFile: config.cohortFile, cohortSha256, scope: {arms: config.arms, modes: config.modes, briefIds: config.ids}, assignments};
  fs.mkdirSync(config.out, {recursive: true, mode: 0o700});
  const lock = path.join(config.out, 'supervisor.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(path.join(lock, 'owner.json'));
    requireThat(owner.startIdentity && processIdentity(owner.pid) !== owner.startIdentity, 'Benchmark directory is locked by a live or unverifiable supervisor');
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid: process.pid, startIdentity: processIdentity(process.pid)}), {flag: 'wx'});
  const children = new Set(), residents = new Set();
  let stopping = false, timer, execution, session;
  const stateFile = path.join(config.out, 'execution.json');
  const persist = () => atomic(stateFile, execution);
  function launch(kind, executable, args, logRoot) {
    fs.mkdirSync(logRoot, {recursive: true, mode: 0o700});
    const stdout = fs.openSync(path.join(logRoot, 'stdout.log'), 'ax', 0o600);
    const stderr = fs.openSync(path.join(logRoot, 'stderr.log'), 'ax', 0o600);
    const child = spawn(executable, args, {cwd: repo, detached: true, stdio: ['ignore', 'pipe', stderr], env: {...process.env, PYTHONUNBUFFERED: '1'}});
    fs.closeSync(stderr);
    child.kind = kind; child.output = ''; child.failure = null; child.exited = false;
    child.startIdentity = child.pid ? processIdentity(child.pid) : null;
    children.add(child);
    child.stdout.on('data', chunk => {
      fs.writeSync(stdout, chunk); child.output = (child.output + chunk.toString()).slice(-16384);
      const banner = child.output.match(/Workbench HTTP ready at (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
      if (banner) child.httpReadyUrl = banner[1];
    });
    child.done = new Promise(resolve => {
      child.once('error', error => { child.failure = String(error); });
      child.once('close', (code, signal) => { child.exited = true; fs.closeSync(stdout); resolve({code, signal}); });
    });
    return child;
  }
  async function stopChild(child) {
    if (!child) return;
    // Only process groups spawned by this invocation are ever signalled.
    const stillOwned = () => child.pid && !child.exited && child.startIdentity && processIdentity(child.pid) === child.startIdentity;
    if (stillOwned()) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([child.done, delay(3000)]);
      if (stillOwned()) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await child.done;
    children.delete(child); residents.delete(child);
  }
  function observe() {
    const observation = {at: now(), residentWorkers: [...residents].filter(c => !c.exited).length,
      activeWorkers: Object.values(execution.assignments).filter(row => row.status === 'running').length,
      supervisorRssBytes: process.memoryUsage().rss, systemFreeMemoryBytes: os.freemem(),
      children: [...children].filter(c => !c.exited).map(measuredChild), gpu: null,
      measurementScope: 'Direct owned children only; descendant RSS/CPU and GPU utilization are unknown. CPU ticks are Linux /proc clock ticks, not cost.'};
    execution.observations.push(observation);
    execution.peakActiveWorkers = Math.max(execution.peakActiveWorkers, observation.activeWorkers);
    execution.peakResidentWorkers = Math.max(execution.peakResidentWorkers, observation.residentWorkers);
    persist();
  }
  const interrupt = signal => { stopping = true; if (session) { session.interruption = signal; persist(); } };
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  try {
    for (const [name, value] of [['manifest.json', manifest], ['config.json', config]]) {
      const file = path.join(config.out, name);
      if (fs.existsSync(file)) requireThat(JSON.stringify(readJson(file)) === JSON.stringify(value), `Resume identity mismatch: ${name}`);
      else atomic(file, value, true);
    }
    fs.mkdirSync(path.join(config.out, 'runs'), {recursive: true});
    execution = fs.existsSync(stateFile) ? readJson(stateFile) : {schema: 'simforge.situation-benchmark-execution/v1',
      manifestSha256: digest(path.join(config.out, 'manifest.json')), assignments: {}, sessions: [], observations: [], peakActiveWorkers: 0, peakResidentWorkers: 0};
    requireThat(execution.manifestSha256 === digest(path.join(config.out, 'manifest.json')), 'Execution manifest identity mismatch');
    session = {id: randomUUID(), startedAt: now(), endedAt: null, pid: process.pid,
      capacity: {configuredConcurrent: config.concurrentCapacity, configuredResident: config.residentCapacity,
        effectiveConcurrent: effectiveCapacity, effectiveResident: effectiveCapacity, explicitLimit: capacityLimit ?? null}};
    execution.sessions.push(session);
    for (const a of assignments) {
      const row = execution.assignments[key(a)] ??= {status: 'queued', queuedAt: now(), startedAt: null, endedAt: null, queueMs: null, wallMs: null, endToEndMs: null};
      const directory = path.join(config.out, a.runDir), outcomeFile = path.join(directory, 'outcome.json');
      if (fs.existsSync(outcomeFile)) {
        const outcome = readJson(outcomeFile);
        row.status = 'completed'; row.outcomeStatus = outcome.status;
        row.endedAt ??= fs.statSync(outcomeFile).mtime.toISOString();
      } else if (row.status === 'running' || (row.status === 'queued' && fs.existsSync(directory))) {
        row.status = 'interrupted'; row.endedAt = now(); row.error = 'Prior attempt interrupted; no replacement or automatic rerun';
      }
      if (row.endedAt) { row.wallMs = row.startedAt ? Date.parse(row.endedAt) - Date.parse(row.startedAt) : null; row.endToEndMs = Date.parse(row.endedAt) - Date.parse(row.queuedAt); }
    }
    persist();
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
    timer = setInterval(observe, config.sampleIntervalMs);
    const queue = assignments.filter(a => execution.assignments[key(a)].status === 'queued');
    let next = 0;
    async function lane(index) {
      let resident = null;
      const port = config.basePort + index, url = `http://127.0.0.1:${port}`;
      try {
        while (!stopping && next < queue.length) {
          const a = queue[next++], row = execution.assignments[key(a)];
          row.status = 'running'; row.phase = 'initializing'; row.startedAt = now();
          row.queueMs = Date.parse(row.startedAt) - Date.parse(row.queuedAt); row.workerId = `${session.id}:${index}`;
          observe();
          let author = null;
          try {
            requireThat(digest(protocolFile) === protocolSha256 && digest(config.cohortFile) === cohortSha256, 'Frozen inputs changed');
            if (config.capabilityMemory) requireThat(digest(config.capabilityMemory) === config.capabilityMemorySha256, 'Capability memory changed');
            const map = maps[a.mapId];
            requireThat(digest(map.file) === map.sha256, 'Prepared manifest changed');
            if (resident && (resident.mapId !== a.mapId || resident.exited)) { await stopChild(resident); resident = null; }
            if (!resident) {
              await availablePort(port);
              const root = path.join(config.out, 'workers', session.id, `${index}-${randomUUID()}`);
              const stateRoot = path.join(root, 'state');
              resident = launch('blender', config.blenderExecutable, ['--background', '--factory-startup', '--disable-autoexec', '-noaudio', '--threads', '8', '--python-exit-code', '1',
                '--python', path.join(repo, 'renderer/blender/workbench_server.py'), '--', '--manifest', map.file, '--case', map.caseId,
                '--state-dir', stateRoot, '--port', String(port)], root);
              resident.mapId = a.mapId; resident.stateRoot = stateRoot; residents.add(resident);
              row.initialization = {pid: resident.pid ?? null, port, root, manifestSha256: map.sha256, startedAt: now()};
              observe();
            }
            const deadline = Date.now() + config.startupTimeoutMs;
            for (;;) {
              requireThat(!stopping, 'Supervisor interrupted');
              requireThat(!resident.exited && !resident.failure, `Owned Blender exited: ${resident.failure ?? 'see worker logs'}`);
              requireThat(Date.now() < deadline, 'Owned Blender readiness timeout');
              let state;
              if (resident.httpReadyUrl === url) {
                try { const response = await fetch(url + '/api/state', {signal: AbortSignal.timeout(2000)}); if (response.ok) state = await response.json(); } catch { /* Await owned server readiness within the deadline. */ }
              }
              if (state) {
                requireThat(typeof state.stateDirectory === 'string' && path.resolve(state.stateDirectory).startsWith(resident.stateRoot + path.sep), 'HTTP server is not the owned child state directory');
                requireThat(!state.lastError, `Workbench initialization error: ${state.lastError}`);
                if (state.ready && !state.busy) {
                  requireThat(state.mapId === a.mapId, 'Owned workbench map identity mismatch');
                  row.workbench = {pid: resident.pid, url, mapId: state.mapId, stateDirectory: state.stateDirectory, readyAt: now()}; break;
                }
              }
              await delay(250);
            }
            row.phase = 'authoring'; row.authoringStartedAt = now(); persist();
            const argsFile = path.join(config.out, 'workers', session.id, `assignment-${path.basename(a.runDir)}.json`);
            atomic(argsFile, {cohortFile: config.cohortFile, id: a.briefId, arm: a.arm, mode: a.mode, out: path.join(config.out, a.runDir),
              workbench: url, sensingFreeze: config.sensingFreeze, ...(config.capabilityMemory ? {capabilityMemory: config.capabilityMemory} : {})}, true);
            author = launch('authoring', process.execPath, [self, '--assignment-worker', argsFile], argsFile + '.logs');
            const deadlineAuthor = Date.now() + config.assignmentTimeoutMs;
            while (!author.exited) {
              requireThat(!stopping, 'Supervisor interrupted');
              requireThat(!resident.exited, 'Owned Blender crashed during assignment');
              requireThat(Date.now() < deadlineAuthor, 'Assignment wall-clock safety timeout');
              await delay(250);
            }
            requireThat(!author.failure, author.failure);
            const outcomeFile = path.join(config.out, a.runDir, 'outcome.json');
            requireThat(fs.existsSync(outcomeFile), 'Authoring worker exited without outcome; see logs');
            row.outcomeStatus = readJson(outcomeFile).status; row.status = 'completed';
            if (row.outcomeStatus === 'infrastructure') {
              // An infrastructure failure leaves renderer state untrusted. Never
              // reuse that process for the next independent assignment.
              await stopChild(resident); resident = null;
            }
          } catch (error) {
            // Stop writers before inspecting outcome; never create or overwrite wrapper artifacts.
            await stopChild(author); author = null;
            const outcomeFile = path.join(config.out, a.runDir, 'outcome.json');
            row.error = String(error.stack ?? error);
            if (fs.existsSync(outcomeFile)) { row.status = 'completed'; row.outcomeStatus = readJson(outcomeFile).status; }
            else row.status = stopping ? 'interrupted' : 'failed';
            await stopChild(resident); resident = null;
          } finally {
            await stopChild(author);
            row.endedAt = now(); row.wallMs = Date.parse(row.endedAt) - Date.parse(row.startedAt);
            row.endToEndMs = Date.parse(row.endedAt) - Date.parse(row.queuedAt); observe();
          }
        }
      } finally { await stopChild(resident); }
    }
    await Promise.all(Array.from({length: Math.min(effectiveCapacity, queue.length)}, (_, i) => lane(i)));
    return execution;
  } finally {
    clearInterval(timer); stopping = true;
    await Promise.all([...children].map(stopChild));
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    if (execution && session) {
      session.endedAt = now(); session.wallMs = Date.parse(session.endedAt) - Date.parse(session.startedAt);
      try { execution.productiveCompletions = reportSituationBenchmark({manifest:path.join(config.out,'manifest.json')}).overall.ensembleAccepted; }
      catch (error) { execution.productiveCompletions = null; execution.productiveCompletionError = String(error.message); }
      execution.productiveCompletionDefinition = 'Automated ensemble-accepted outcomes with validated frozen aggregate, member and mechanical evidence; not independent qualification';
      execution.assignedCount = assignments.length;
      execution.cost = null;
      observe();
    }
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    requireThat(process.argv.length === 4 || process.argv.length === 6, 'Usage: node situation-benchmark.mjs --config /absolute/config.json [--capacity N]');
    if (process.argv[2] === '--assignment-worker') {
      requireThat(process.argv.length === 4, 'Assignment worker takes one argument file');
      const {runFrozenBrief} = await import('./run-frozen-brief.mjs');
      const outcome = await runFrozenBrief(readJson(process.argv[3]));
      console.log(JSON.stringify(outcome));
    } else {
      requireThat(process.argv[2] === '--config', 'Expected --config');
      requireThat(process.argv.length === 4 || process.argv[4] === '--capacity', 'Expected --capacity N');
      const execution = await runBenchmark(process.argv[3], {capacityLimit: process.argv.length === 6 ? Number(process.argv[5]) : undefined});
      console.log(JSON.stringify({assignedCount: execution.assignedCount, productiveCompletions: execution.productiveCompletions,
        states: Object.values(execution.assignments).map(row => row.status)}));
      if (Object.values(execution.assignments).some(row => row.status !== 'completed')) process.exitCode = 2;
    }
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
