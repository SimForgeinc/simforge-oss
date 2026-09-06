import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Agent } from './pi-harness/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { streamSimple, validateToolArguments } from './pi-harness/node_modules/@mariozechner/pi-ai/dist/index.js';

export const ASTRA_MODEL = 'openai-codex/gpt-6-astra';
export const AUTHOR_MODEL = 'anthropic/claude-opus-5';
export const AUTHOR_MODELS = Object.freeze(['openai-codex/gpt-5.6-sol', ASTRA_MODEL, AUTHOR_MODEL, 'anthropic/claude-fable-5-1']);
export const GATEWAY_EFFORT = 'low';
export const AUTHOR_EFFORT = 'high';
export const AUTHOR_EFFORTS = Object.freeze(['low', 'high']);
export const GATEWAY_TIMEOUT_MS = Object.freeze({low:180000, high:600000});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (condition, message) => { if (!condition) throw new Error(message); };

/** No network at construction: catalog and returned routing are checked before tools execute. */
export function gatewayModel({ modelId = ASTRA_MODEL, gatewayUrl = process.env.SIMFORGE_GATEWAY ?? 'http://127.0.0.1:4141/v1/chat/completions' } = {}) {
  fail(AUTHOR_MODELS.includes(modelId), 'Unsupported exact gateway model; no fallback is permitted');
  const url = new URL(gatewayUrl);
  fail(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    'Gateway URL must be HTTP(S), without embedded credentials, query or fragment');
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  fail(url.pathname === '/v1', 'Expected an OMP /v1 or /v1/chat/completions gateway endpoint');
  return Object.freeze({
    id: modelId, name: `${modelId} via OMP gateway`, api: 'openai-completions', provider: 'openai',
    baseUrl: url.href.replace(/\/$/, ''), reasoning: true, input: Object.freeze(['text', 'image']),
    // Required by the transport; these zeros are not observed inference prices.
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    contextWindow: 272000, maxTokens: 16000,
    compat: Object.freeze({ supportsReasoningEffort: true, supportsUsageInStreaming: true }),
  });
}

function gatewayKey() {
  // The existing local harness uses this non-secret sentinel for --no-auth gateways.
  // Authenticated gateways use the token emitted by `omp auth-gateway token`, never broker credentials.
  if (process.env.SIMFORGE_GATEWAY_TOKEN) return process.env.SIMFORGE_GATEWAY_TOKEN;
  if (process.env.SIMFORGE_GATEWAY_TOKEN_FILE) return fs.readFileSync(process.env.SIMFORGE_GATEWAY_TOKEN_FILE, 'utf8').trim();
  return 'local-gateway';
}

function atomicJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Persistent pi Agent, exact routing only, no alternate provider or application-level retry. */
export function createGatewayAgent({ systemPrompt, tools, sessionDir, gatewayUrl, modelId = ASTRA_MODEL, effort = GATEWAY_EFFORT, transformContext, onEvent, maxTokens = 16000 }) {
  fail(typeof systemPrompt === 'string' && Array.isArray(tools) && typeof sessionDir === 'string',
    'systemPrompt, tools and sessionDir are required');
  fail(Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 16000, 'maxTokens must be an integer in [1,16000]');
  fail(AUTHOR_EFFORTS.includes(effort), 'Unsupported explicit reasoning effort');
  const model = gatewayModel({ gatewayUrl, modelId });
  const requestTimeoutMs = GATEWAY_TIMEOUT_MS[effort];
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const blobs = path.join(sessionDir, 'images');
  fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDir, 'session.json');
  const previous = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : null;
  if (previous) fail(previous.version === 2 && previous.identity.requestedModel === model.id &&
    previous.identity.requestedEffort === effort && previous.identity.gatewayUrl === model.baseUrl && previous.identity.requestTimeoutMs === requestTimeoutMs &&
    previous.systemPrompt === systemPrompt, 'Session identity, gateway or system prompt changed; use a new sessionDir');
  const sessionId = previous?.sessionId ?? randomUUID();
  const identity = {
    requestedModel: model.id, requestedEffort: effort, gatewayUrl: model.baseUrl,
    requestTimeoutMs,
    argumentEncoding: 'json-string-v1',
    catalog: null, routingVerified: false, requestEffortVerified: false,
    upstreamExecutionVerified: false,
    limitation: 'OMP catalog and x-litellm-model-id attest gateway routing, not upstream execution. Current gateway exposes no effective reasoning-effort attestation.',
  };
  const usage = previous?.usage ?? { requests: [], totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  usage.costSource = 'x-litellm-response-cost (USD); descriptor costs are not pricing evidence';
  function reportedCost(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^\s*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/.test(value)) return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }
  // Migrate old usage without treating the descriptor's calculated zero as a quote.
  for (const request of usage.requests) {
    request.gatewayCost = reportedCost(request.gatewayCost);
    if (request.usage) request.usage = { ...request.usage, cost: request.gatewayCost };
  }
  delete usage.totals.cost;
  usage.tools ??= { calls: [] };
  const callsByPosition = new Map(usage.tools.calls.map((call) => [`${call.messageIndex}:${call.contentIndex}`, call]));
  const currentCalls = new Map();
  function recordRequests(message, messageIndex, historical = false) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.forEach((block, contentIndex) => {
      if (block.type !== 'toolCall') return;
      const key = `${messageIndex}:${contentIndex}`;
      let call = callsByPosition.get(key);
      if (!call) {
        call = { messageIndex, contentIndex, callId: block.id, name: block.name,
          evidence: historical ? 'retained-messages' : 'agent-events',
          executionStarted: historical ? null : false, validationFailure: null,
          completed: false, isError: null };
        usage.tools.calls.push(call);
        callsByPosition.set(key, call);
      }
      currentCalls.set(block.id, call);
    });
  }
  function summarizeUsage() {
    const costs = usage.requests.map((request) => request.gatewayCost).filter((cost) => cost !== null);
    const reportedTotal = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
    usage.cost = { currency: 'USD', reportedRequests: costs.length,
      unavailableRequests: usage.requests.length - costs.length, reportedTotal,
      total: costs.length === usage.requests.length ? reportedTotal : null };
    // Requested includes unexecuted/rejected calls. Completed is a terminal Agent
    // outcome, not proof of execution. Legacy failed calls may have unknown execution.
    const emptyCounts = () => ({ requested: 0, executed: 0, executionUnknown: 0,
      validationFailures: 0, completed: 0, failed: 0, succeeded: 0 });
    const totals = emptyCounts();
    const byName = Object.create(null);
    for (const call of usage.tools.calls) {
      const named = byName[call.name] ??= emptyCounts();
      for (const row of [totals, named]) {
        row.requested++;
        if (call.executionStarted === true) row.executed++;
        if (call.executionStarted === null) row.executionUnknown++;
        if (call.validationFailure !== null) row.validationFailures++;
        if (call.completed) {
          row.completed++;
          if (call.isError) row.failed++;
          else row.succeeded++;
        }
      }
    }
    usage.tools.totals = totals;
    usage.tools.byName = byName;
  }
  const imageRefs = new WeakMap();
  function imageFromRef(ref) {
    fail(/^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid persisted image digest');
    const block = { type: 'image', mimeType: ref.mimeType };
    Object.defineProperty(block, 'data', { enumerable: true, get() {
      const bytes = fs.readFileSync(path.join(blobs, ref.sha256));
      fail(digest(bytes) === ref.sha256, 'Persisted image digest mismatch');
      return bytes.toString('base64');
    } });
    imageRefs.set(block, ref);
    return block;
  }
  function storeImage(block) {
    if (imageRefs.has(block)) return imageRefs.get(block);
    const bytes = Buffer.from(block.data, 'base64');
    const sha256 = digest(bytes);
    const file = path.join(blobs, sha256);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    return { type: 'image-ref', sha256, mimeType: block.mimeType };
  }
  const messages = (previous?.messages ?? []).map((message) => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map((block) => block.type === 'image-ref' ? imageFromRef(block) : block) : message.content,
  }));
  messages.forEach((message, index) => {
    recordRequests(message, index, true);
    if (message.role !== 'toolResult') return;
    const call = currentCalls.get(message.toolCallId);
    if (!call || call.completed) return;
    call.completed = true;
    call.isError = message.isError === true;
    // A retained failure cannot establish whether the original tool was entered.
    if (!call.isError) call.executionStarted = true;
  });
  summarizeUsage();
  let catalogChecked = false;
  let activeRequest;
  async function checkCatalog(signal) {
    if (catalogChecked) return;
    const response = await fetch(`${model.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${gatewayKey()}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    fail(response.ok, `OMP model catalog failed: HTTP ${response.status}`);
    const catalog = await response.json();
    const entry = catalog.data?.find((row) => row.id === model.id);
    const anthropic = model.id.startsWith('anthropic/');
    fail(entry && entry.owned_by === (anthropic ? 'anthropic' : 'openai-codex') && entry.api === (anthropic ? 'anthropic-messages' : 'openai-codex-responses'),
      `OMP gateway does not advertise the exact ${model.id} provider route; no fallback is permitted.`);
    fail(entry.input_modalities?.includes('image') && entry.supports_tools !== false,
      'Gateway route lacks advertised image/tool support');
    identity.catalog = { id: entry.id, owned_by: entry.owned_by, api: entry.api, input_modalities: entry.input_modalities };
    catalogChecked = true;
  }
  // The gateway's strict schema conversion fills omitted numeric/string fields
  // with 0/"". Preserve intentional absence using the factory's proven JSON-string
  // transport, then validate against the original schema before any tool executes.
  const wireTools = tools.map((tool) => ({
    ...tool,
    description: `${tool.description}\nSend request as a JSON object string matching this schema; omit fields you do not intend to change:\n${JSON.stringify(tool.parameters)}`,
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'JSON object containing the operation arguments.' } }, required: ['request'], additionalProperties: false },
    async execute(callId, wire, ...rest) {
      const call = currentCalls.get(callId);
      let arguments_;
      try {
        arguments_ = JSON.parse(wire.request);
      } catch (error) {
        if (call) { call.executionStarted = false; call.validationFailure = 'json_parse'; }
        throw error;
      }
      let validated;
      try {
        validated = validateToolArguments(tool, { type: 'toolCall', id: callId, name: tool.name, arguments: arguments_ });
      } catch (error) {
        if (call) { call.executionStarted = false; call.validationFailure = 'original_schema'; }
        throw error;
      }
      if (call) call.executionStarted = true;
      return tool.execute(callId, validated, ...rest);
    },
  }));
  const agent = new Agent({
    initialState: { systemPrompt, tools: wireTools, model, thinkingLevel: effort, messages },
    sessionId, getApiKey: gatewayKey,
    transformContext: async (history, signal) => {
      // Replay retains all images on disk; only two latest image-bearing messages go on the wire.
      let retained = 0;
      const selected = history.map((message) => message);
      for (let i = selected.length - 1; i >= 0; i--) {
        const message = selected[i];
        if (!Array.isArray(message.content) || !message.content.some((block) => block.type === 'image')) continue;
        if (++retained > 2) selected[i] = { ...message, content: message.content.map((block) => block.type === 'image'
          ? { type: 'text', text: `[Earlier image archived: ${storeImage(block).sha256}]` } : block) };
      }
      return transformContext ? await transformContext(selected, signal) : selected;
    },
    streamFn: async (requested, context, options) => {
      fail(requested.id === model.id && requested.baseUrl === model.baseUrl && options?.reasoning === effort,
        'Agent model, gateway or effort was changed');
      await checkCatalog(options?.signal);
      activeRequest = { startedAt: new Date().toISOString(), startedMs: performance.now(), requestedModel: model.id, requestedEffort: effort, requestTimeoutMs, gatewayCost: null };
      usage.requests.push(activeRequest);
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      return streamSimple(model, context, { ...options, maxTokens, maxRetries: 0,
        signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        headers: { ...options?.headers, 'x-omp-app': 'simforge-situation', 'x-session-id': sessionId } });
    },
    onPayload(payload) {
      fail(payload.model === model.id && payload.reasoning_effort === effort,
        'Outgoing gateway payload did not preserve the selected model and effort');
      identity.requestEffortVerified = true;
      activeRequest.wireModel = payload.model;
      activeRequest.wireEffort = payload.reasoning_effort;
      activeRequest.payloadBytes = Buffer.byteLength(JSON.stringify(payload));
    },
    onResponse(response) {
      const headers = response.headers;
      const returned = headers['x-litellm-model-id'];
      activeRequest.status = response.status;
      activeRequest.returnedModel = returned ?? null;
      activeRequest.requestId = headers['x-request-id'] ?? headers['request-id'] ?? null;
      activeRequest.gatewayCost = reportedCost(headers['x-litellm-response-cost']);
      activeRequest.headersLatencyMs = performance.now() - activeRequest.startedMs;
      fail(response.status >= 200 && response.status < 300, `Gateway HTTP ${response.status}`);
      fail(returned === model.id.slice(model.id.indexOf('/') + 1) || returned === model.id,
        `Gateway returned missing or mismatched routing identity: ${returned ?? '(missing)'}`);
      identity.routingVerified = true;
    },
  });
  function save() {
    summarizeUsage();
    const archived = agent.state.messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      const content = message.content.map((block, index) => {
        if (block.type !== 'image') return block;
        const ref = storeImage(block);
        // Replace in-memory base64 with a lazy content-addressed reference without losing replayability.
        if (!imageRefs.has(block)) message.content[index] = imageFromRef(ref);
        return ref;
      });
      return { ...message, content };
    });
    atomicJson(sessionFile, { version: 2, sessionId, systemPrompt, identity, usage, messages: archived });
    return sessionFile;
  }
  agent.subscribe(async (event) => {
    if (event.type === 'message_end') recordRequests(event.message, agent.state.messages.length - 1);
    if (event.type === 'tool_execution_start') {
      const call = currentCalls.get(event.toolCallId);
      // A crash before the terminal event cannot prove whether dispatch entered
      // the original tool. Persist that uncertainty, not a false zero execution.
      if (call) call.executionStarted = null;
    }
    if (event.type === 'tool_execution_end') {
      const call = currentCalls.get(event.toolCallId);
      if (call) {
        call.completed = true;
        call.isError = event.isError === true || event.result?.isError === true;
        if (call.isError && call.executionStarted !== true && call.validationFailure === null) {
          call.executionStarted = false;
          call.validationFailure = tools.some((tool) => tool.name === call.name) ? 'wire_schema' : 'unknown_tool';
        }
      }
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && activeRequest) {
      activeRequest.latencyMs = performance.now() - activeRequest.startedMs;
      delete activeRequest.startedMs;
      activeRequest.stopReason = event.message.stopReason;
      activeRequest.usage = { ...event.message.usage, cost: activeRequest.gatewayCost };
      for (const key of Object.keys(usage.totals)) usage.totals[key] += event.message.usage?.[key] ?? 0;
    }
    if (event.type === 'message_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'agent_end') save();
    if (onEvent) await onEvent(event);
  });
  return { agent, save, identity, usage };
}

// A generated, randomized image challenge: answers never enter text or tool descriptions.
function challengeImage(colors) {
  const rgb = { red: [230, 20, 20], green: [20, 190, 20], blue: [20, 20, 230], yellow: [240, 220, 20] };
  const width = 256;
  const pixels = Buffer.alloc((width * 3 + 1) * width);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels.set(rgb[colors[(y >= 128 ? 2 : 0) + (x >= 128 ? 1 : 0)]], offset);
  }
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 8);
    result.writeUInt32BE(bytes.length, 0); data.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Real billable probe; invoked explicitly, never at import or Agent construction. */
export async function verifyGateway({ gatewayUrl, outputDir, modelId = ASTRA_MODEL, effort = GATEWAY_EFFORT } = {}) {
  const dir = outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'simforge-gateway-probe-'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sessionDir = path.join(dir, `session-${randomUUID()}`);
  const colors = ['red', 'green', 'blue', 'yellow'];
  for (let i = colors.length - 1; i > 0; i--) { const j = randomInt(i + 1); [colors[i], colors[j]] = [colors[j], colors[i]]; }
  const image = challengeImage(colors);
  fs.writeFileSync(path.join(dir, 'challenge.png'), image, { mode: 0o600 });
  const expected = { observation: { rows: [{ colors: colors.slice(0, 2) }, { colors: colors.slice(2) }], count: 4 }, calibration: { offsets: [1.25, -2.5], enabled: false } };
  let inspected = false;
  let submitted = false;
  let violation = null;
  let rawArguments;
  const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
  const tools = [{
    name: 'inspect_image', label: 'Inspect image', description: 'Obtain the test image. Call exactly once before report_observation.',
    parameters: object({}, []),
    async execute() {
      if (inspected) { violation = 'Image tool called more than once'; return { content: [{ type: 'text', text: violation }], details: {}, terminate: true }; }
      inspected = true;
      return { content: [{ type: 'text', text: 'Report the observed colors row by row, left to right, top row first.' },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }], details: {} };
    },
  }, {
    name: 'report_observation', label: 'Report observation', description: 'Return image observations and calibration exactly as requested. Omit optional_note and uncertainty entirely.',
    parameters: object({
      observation: object({ rows: { type: 'array', minItems: 2, maxItems: 2, items: object({ colors: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', enum: ['red', 'green', 'blue', 'yellow'] } } }, ['colors']) }, count: { type: 'integer' }, uncertainty: { type: 'number' } }, ['rows', 'count']),
      calibration: object({ offsets: { type: 'array', items: { type: 'number' } }, enabled: { type: 'boolean' } }, ['offsets', 'enabled']),
      optional_note: { type: 'string' },
    }, ['observation', 'calibration']),
    async execute(_id, args) {
      submitted = true;
      const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
      if (!inspected || canonical(args) !== canonical(expected) || canonical(rawArguments) !== canonical(expected))
        violation = 'Image understanding, nested argument fidelity or optional-field absence failed';
      return { content: [{ type: 'text', text: violation ?? 'Probe complete.' }], details: {}, terminate: true };
    },
  }];
  const handle = createGatewayAgent({ gatewayUrl, modelId, effort, sessionDir, maxTokens: 2048, tools,
    systemPrompt: 'Transport verification. Call inspect_image once, then report_observation once. Observe the image; never guess. Report all four quadrant colors, top row then bottom row. Set count to 4. Set calibration offsets to [1.25,-2.5] and enabled to false. Omit optional_note and observation.uncertainty entirely. Do not add other fields. No prose or retries.',
  });
  handle.agent.beforeToolCall = async ({ toolCall }) => {
    if (toolCall.name === 'report_observation') rawArguments = JSON.parse(toolCall.arguments.request);
  };
  let requests = 0;
  handle.agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      requests++;
      if (requests > 2 || event.message.content.filter((block) => block.type === 'toolCall').length !== 1) {
        violation = 'Probe required exactly one tool call per turn and two turns';
        handle.agent.abort();
      }
    }
    if (event.type === 'tool_execution_end' && event.isError) { violation = 'Probe tool execution failed'; handle.agent.abort(); }
  });
  try {
    await handle.agent.prompt('Run the image and nested-argument transport verification now.');
    const failure = handle.agent.state.messages.findLast((message) => message.role === 'assistant' && message.stopReason === 'error');
    if (failure) throw new Error(failure.errorMessage ?? 'Gateway agent stream failed');
    fail(!violation && inspected && submitted && requests === 2, violation ?? 'Probe did not complete both required tool calls');
    fail(handle.identity.routingVerified && handle.identity.requestEffortVerified, 'Gateway identity or request effort was not verified');
    const evidence = { ok: true, identity: handle.identity, usage: handle.usage, imageSha256: digest(image),
      imageUnderstanding: true, nestedArguments: true, optionalFieldsAbsent: true, argumentEncoding: 'json-string-v1', sessionDir, rawArguments };
    atomicJson(path.join(dir, 'gateway-evidence.json'), evidence);
    return evidence;
  } catch (error) {
    handle.save();
    atomicJson(path.join(dir, 'gateway-evidence.json'), { ok: false, error: String(error), identity: handle.identity, usage: handle.usage, sessionDir, rawArguments, expected });
    throw error;
  }
}
