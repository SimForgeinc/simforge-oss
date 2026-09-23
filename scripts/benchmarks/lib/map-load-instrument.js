// Injected before any page script by the map-load benchmark (addInitScript).
// Records, in page time (performance.now), what a map load does: Cache
// Storage reads, map fetches (network vs. answered by the map cache), worker
// traffic (Basis transcodes, meshopt decodes, pack inflates), WebGL uploads,
// program links and GPU readbacks, frames with draws, and long tasks.
// Everything lands on window.__mapLoadBench for the runner to collect.
(() => {
  if (window.__mapLoadBench) return;
  const now = () => performance.now();
  const B = (window.__mapLoadBench = {
    cache: { matches: 0, hits: 0, first: null, last: null, hitBytes: 0 },
    workers: { created: 0, basisTranscodes: 0, meshoptDecodes: 0, packInflates: 0, other: 0 },
    gl: {
      contexts: 0, contextAt: null, parallelShaderCompile: null,
      compressedUploads: 0, compressedBytes: 0, texUploads: 0, bufferUploads: 0, bufferBytes: 0,
      linkProgram: 0, getError: 0, getErrorMs: 0, readPixels: 0, draws: 0,
    },
    fetches: [],
    firstDrawFrameAt: null,
    longTasks: [],
  });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) B.longTasks.push([e.startTime, e.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}

  if (window.Cache) {
    const match = Cache.prototype.match;
    Cache.prototype.match = function (request, options) {
      const started = now();
      B.cache.matches++;
      B.cache.first ??= started;
      return match.call(this, request, options).then((response) => {
        B.cache.last = now();
        if (response) {
          B.cache.hits++;
          B.cache.hitBytes += Number(response.headers.get('content-length')) || 0;
        }
        return response;
      });
    };
  }

  const NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = function (url, options) {
      const worker = new NativeWorker(url, options);
      B.workers.created++;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (options?.name?.startsWith('ktx2-inflate')) B.workers.packInflates++;
        else if (message && message.type === 'transcode') B.workers.basisTranscodes++;
        else if (message && typeof message.count === 'number' && typeof message.size === 'number') B.workers.meshoptDecodes++;
        else B.workers.other++;
        return post(message, transfer);
      };
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  const G = window.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (G) {
    const wrap = (name, fn) => { const orig = G[name]; if (orig) G[name] = function (...args) { return fn.call(this, orig, args); }; };
    const view = (args) => args.find((arg) => arg && typeof arg === 'object' && 'byteLength' in arg);
    wrap('compressedTexSubImage2D', function (orig, args) { B.gl.compressedUploads++; B.gl.compressedBytes += view(args)?.byteLength ?? 0; return orig.apply(this, args); });
    wrap('compressedTexImage2D', function (orig, args) { B.gl.compressedUploads++; B.gl.compressedBytes += view(args)?.byteLength ?? 0; return orig.apply(this, args); });
    wrap('texSubImage2D', function (orig, args) { B.gl.texUploads++; return orig.apply(this, args); });
    wrap('texImage2D', function (orig, args) { B.gl.texUploads++; return orig.apply(this, args); });
    for (const name of ['bufferData', 'bufferSubData']) {
      wrap(name, function (orig, args) { B.gl.bufferUploads++; B.gl.bufferBytes += view(args)?.byteLength ?? 0; return orig.apply(this, args); });
    }
    wrap('linkProgram', function (orig, args) { B.gl.linkProgram++; return orig.apply(this, args); });
    wrap('getError', function (orig, args) { const started = now(); const result = orig.apply(this, args); B.gl.getError++; B.gl.getErrorMs += now() - started; return result; });
    wrap('readPixels', function (orig, args) { B.gl.readPixels++; return orig.apply(this, args); });
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      wrap(name, function (orig, args) { B.gl.draws++; return orig.apply(this, args); });
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const context = getContext.call(this, type, ...rest);
      if (context && type === 'webgl2' && !context.__mapLoadBench) {
        context.__mapLoadBench = true;
        B.gl.contexts++;
        B.gl.contextAt ??= now();
        B.gl.parallelShaderCompile = Boolean(context.getExtension('KHR_parallel_shader_compile'));
      }
      return context;
    };
  }

  // Map fetches: wrap the network fetch, and whatever later replaces
  // window.fetch (the map asset gateway), so both layers are visible.
  // Only map data counts: actor models (/catalog/...) and app APIs are not map loads.
  const isMap = (url) => /\/api\/simforge\/maps\/[^/]+\/browser-assets\/|\/api\/map-assets\/[^/]+\/3d-asset\//.test(url);
  const kind = (url) => !isMap(url) ? 'other' : /\/3d\/manifest\.json/.test(url) ? 'manifest' : /variants\/manifest\.json/.test(url) ? 'variants-manifest'
    : /variants\/(textures|browser-pack)-[^/]+\.json/.test(url) ? 'index' : /packs\/objects\//.test(url) ? 'pack-chunk'
    : /\.glb(\?|$)/.test(url) ? 'glb' : /\.ktx2(\?|$)/.test(url) ? 'ktx2' : /\/api\//.test(url) ? 'api' : 'other';
  const wrapFetch = (fn, layer) => {
    if (!fn || fn.__mapLoadBench) return fn;
    const wrapped = function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? String(input);
      const record = { layer, kind: kind(url), url: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 160), start: now(), end: null, cacheHit: null };
      if (record.kind !== 'other' && record.kind !== 'api') B.fetches.push(record);
      return fn.call(this, input, init).then((response) => {
        record.end = now();
        record.cacheHit = response.headers.get('x-simforge-cache') === 'hit';
        return response;
      });
    };
    wrapped.__mapLoadBench = true;
    return wrapped;
  };
  let current = wrapFetch(window.fetch, 'network');
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    get() { return current; },
    set(value) { current = value && !value.__mapLoadBench ? wrapFetch(value, 'app') : value; },
  });

  let lastDraws = 0;
  const frame = () => {
    if (B.gl.draws > lastDraws && B.firstDrawFrameAt === null && B.gl.contexts > 0) B.firstDrawFrameAt = now();
    lastDraws = B.gl.draws;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
