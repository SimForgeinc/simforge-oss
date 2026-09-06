"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const viewport = $("viewport");
  const frame = $("frame");
  const code = $("code");
  const starter = `# Place a 2 m orange barrier at the clicked surface.
# Without a hit, use the selected object's origin or world origin.
position = (hit.copy() if hit is not None else
            selected.matrix_world.translation.copy()
            if selected is not None else Vector((0, 0, 0)))

bpy.ops.mesh.primitive_cube_add(size=1, location=position)
barrier = bpy.context.object
barrier.name = "Workbench_Orange_Barrier"
barrier.dimensions = (2.0, 0.35, 0.8)
barrier.location.z += 0.4
bpy.ops.object.transform_apply(
    location=False, rotation=False, scale=True)

material = bpy.data.materials.new("Workbench_Orange")
material.diffuse_color = (1.0, 0.22, 0.025, 1.0)
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = material.diffuse_color
shader.inputs["Roughness"].default_value = 0.6
barrier.data.materials.append(material)

bevel = barrier.modifiers.new("Soft edges", "BEVEL")
bevel.width = 0.035
bevel.segments = 2
`;
  code.value = starter;
  let state = null;
  let pending = false;
  let online = false;
  let epoch = 0;
  let requestedFrame = null;
  let loadedFrame = null;
  let loadedRevision = null;
  let knownError = null;
  let configDirty = false;
  let pointer = null;
  let gesture = null;
  let gestureTimer = null;
  let markerTimer = null;
  let measuring = false;
  let measurementPoints = [];
  const fmt = value => typeof value === "number" ? value.toLocaleString() : "—";
  const vector = value => Array.isArray(value) ? value.map(n => Number(n).toFixed(3)).join(", ") : "—";
  const describe = value => typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const available = () => online && state?.ready && !state.busy && !pending && loadedFrame !== null && loadedFrame === requestedFrame;
  const controlsFree = () => available() && !pointer && !gesture;

  function feedback(message) { $("feedback").textContent = message; }
  function showError(message) {
    $("error-text").textContent = String(message);
    $("error-box").hidden = false;
  }
  function updateControls() {
    const free = controlsFree();
    const imagePending = Boolean(state?.ready) && loadedFrame !== requestedFrame;
    document.querySelectorAll("[data-action]").forEach(button => { button.disabled = !free; });
    $("frame-selection").disabled = !free || !state?.selection;
    $("undo").disabled = !free || !(state?.undoDepth > 0);
    $("redo").disabled = !free || !(state?.redoDepth > 0);
    $("apply").disabled = !free || !code.value.trim();
    viewport.classList.toggle("busy", pending || Boolean(state?.busy) || imagePending);
    viewport.setAttribute("aria-busy", String(pending || Boolean(state?.busy) || imagePending));
    $("status-label").textContent = !online ? "Disconnected" : !state?.ready ? "Loading scene" : pending || state.busy ? "Working" : imagePending ? "Loading image" : "Ready";
    $("status-dot").className = "status-dot" + (!online ? " error" : available() ? " ready" : "");
    $("viewport-badge").hidden = frame.hidden || (!pending && !state?.busy && !imagePending);
    if (!$("viewport-badge").hidden) $("viewport-badge").textContent = imagePending ? "Loading rendered frame…" : state?.progress || "Blender is working…";
  }

  function refreshFrame(next) {
    if (!next.frameSha256 && !next.frameUrl) return;
    // Loading states may name a not-yet-created frame; wait for the first render.
    if (!next.frameSha256 && next.renderMs == null && !next.ready) return;
    const key = `${next.frameSha256 || ""}:${next.revision}`;
    if (key === requestedFrame || key === loadedFrame) return;
    clearMeasurement();
    requestedFrame = key;
    const url = new URL(next.frameUrl || "/frame.png", location.origin);
    if (url.origin !== location.origin) {
      requestedFrame = null;
      showError("The backend returned a frame URL outside this local workbench.");
      return;
    }
    url.searchParams.set("revision", String(next.revision));
    if (next.frameSha256) url.searchParams.set("sha", next.frameSha256);
    const image = new Image();
    image.onload = () => {
      if (requestedFrame !== key) return;
      frame.src = image.src;
      frame.hidden = false;
      frame.alt = `${next.scene || "Scene"}, Blender ${next.engine || ""} render, revision ${next.revision}`;
      $("empty-frame").hidden = true;
      loadedFrame = key;
      loadedRevision = next.revision;
      $("pick-marker").hidden = true;
      updateControls();
    };
    image.onerror = () => {
      if (requestedFrame !== key) return;
      requestedFrame = null;
      showError("Could not load the rendered frame. The previous image is retained; reconnecting will retry automatically.");
      updateControls();
    };
    image.src = url.href;
  }

  function applyState(next) {
    if (!next || typeof next !== "object") return;
    state = next;
    online = true;
    $("scene-name").textContent = next.scene || "Blender scene";
    $("loading-detail").textContent = next.progress || "Loading map geometry and rendering the first frame…";
    $("revision").textContent = fmt(next.revision);
    $("render-time").textContent = typeof next.renderMs === "number" ? (next.renderMs >= 1000 ? `${(next.renderMs / 1000).toFixed(2)} s` : `${Math.round(next.renderMs)} ms`) : "—";
    $("counts").textContent = `${fmt(next.objectCount)} objects · ${fmt(next.meshCount)} meshes · ${fmt(next.width)} × ${fmt(next.height)}`;
    $("camera-position").textContent = next.camera?.eye ? `Camera (${next.camera.frame || "world"}): ${vector(next.camera.eye)}` : "";
    $("undo-depth").textContent = fmt(next.undoDepth);
    $("redo-depth").textContent = fmt(next.redoDepth);
    if (!configDirty) {
      if (next.engine) $("engine").value = next.engine;
      if (next.samples != null) $("samples").value = next.samples;
    }
    const selection = next.selection;
    $("selection-empty").hidden = Boolean(selection);
    $("selection-details").hidden = !selection;
    if (selection) {
      $("selection-name").textContent = selection.name || "Unnamed object";
      $("selection-source").textContent = selection.source || "No source path (locally authored or generated geometry)";
      $("selection-point").textContent = vector(selection.point);
      $("selection-normal").textContent = vector(selection.normal);
      $("selection-mesh").textContent = `${fmt(selection.vertices)} vertices · ${fmt(selection.polygons)} polygons`;
      $("selection-face").textContent = fmt(selection.faceIndex);
      $("selection-frame").textContent = selection.frame || "Blender-z-up-meters";
    }
    const notes = [];
    if (next.lastEdit && typeof next.lastEdit === "object") {
      const edit = next.lastEdit;
      notes.push(`Last edit: ${fmt(edit.addedObjects)} added · ${fmt(edit.removedObjects)} removed · ${fmt(edit.changedObjects)} changed objects`);
      notes.push(`Vertices ${fmt(edit.verticesBefore)} → ${fmt(edit.verticesAfter)} · polygons ${fmt(edit.polygonsBefore)} → ${fmt(edit.polygonsAfter)}`);
      if (edit.addedNames?.length) notes.push(`Added: ${edit.addedNames.join(", ")}`);
      if (edit.output) notes.push(`Python output:\n${edit.output}`);
    } else if (next.lastEdit) notes.push(`Last edit: ${describe(next.lastEdit)}`);
    if (next.historyLimit != null) {
      let history = `History: up to ${fmt(next.historyLimit)} snapshots`;
      if (typeof next.historyStorageBytes === "number") history += ` · ${(next.historyStorageBytes / 1048576).toFixed(1)} MiB`;
      if (typeof next.historyStorageLimitBytes === "number") history += ` / ${(next.historyStorageLimitBytes / 1073741824).toFixed(1)} GiB limit`;
      notes.push(history);
    }
    $("last-edit").textContent = notes.join("\n");
    if (next.lastError && describe(next.lastError) !== knownError) {
      knownError = describe(next.lastError);
      showError(knownError);
    }
    if (!next.lastError) knownError = null;
    if (!next.ready || next.busy) feedback(next.progress || "Blender is working…");
    refreshFrame(next);
    updateControls();
  }

  async function poll() {
    const requestEpoch = epoch;
    try {
      const response = await fetch("/api/state", {cache: "no-store", signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error(`State request failed (HTTP ${response.status}).`);
      const next = await response.json();
      if (requestEpoch !== epoch) return;
      const wasReady = state?.ready;
      const wasOnline = online;
      applyState(next);
      if (next.ready && !next.busy && !pending && (!wasReady || !wasOnline)) feedback("Scene ready. Click a surface, edit the Python, then Apply & render.");
    } catch (error) {
      if (requestEpoch !== epoch) return;
      online = false;
      updateControls();
      feedback(`Connection unavailable: ${error.message} Retrying automatically…`);
      if (frame.hidden) $("loading-detail").textContent = "Waiting for the local Blender server. Connection retries automatically.";
    } finally {
      setTimeout(poll, state?.busy || !state?.ready || pending ? 800 : 1800);
    }
  }

  async function action(payload, label) {
    if (!available()) return;
    if (["edit", "undo", "redo", "reset"].includes(payload.op)) payload.baseRevision = state.revision;
    pending = true;
    epoch++;
    feedback(`${label}…`);
    $("viewport-badge").textContent = `${label}…`;
    updateControls();
    try {
      // Rendering can be long, especially Cycles. Do not time out or retry writes.
      const response = await fetch("/api/action", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)
      });
      const result = await response.json();
      epoch++;
      if (result.state) applyState(result.state);
      if (!response.ok || !result.ok) throw new Error(result.error || `Action failed (HTTP ${response.status}).`);
      $("error-box").hidden = true;
      if (payload.op === "render") {
        configDirty = false;
        if (state?.engine) $("engine").value = state.engine;
        if (state?.samples != null) $("samples").value = state.samples;
      }
      feedback(payload.op === "pick" ? (state?.selection ? `Selected ${state.selection.name}. The editor’s hit point now uses this surface.` : "No geometry at that pixel. Click a visible surface.") : `${label} complete${state?.revision != null ? ` · revision ${state.revision}` : ""}.`);
      if (payload.op === "measure") {
        const m = result.measurement;
        $("measurement").textContent = `${m.distance.toFixed(3)} m straight-line distance · Δ (${vector(m.delta)}) · ${m.frame} · frame ${m.frameRevision}. ${m.endpoints.from.name} → ${m.endpoints.to.name}. Triangle geometry, not surveyed road semantics.`;
        $("measurement").hidden = false;
      }
    } catch (error) {
      epoch++;
      showError(error.message);
      feedback("Action did not complete successfully. Inspect the error before continuing; requests are never automatically repeated.");
    } finally {
      pending = false;
      updateControls();
    }
  }

  $("dismiss-error").addEventListener("click", () => { $("error-box").hidden = true; });
  $("home").addEventListener("click", () => action({op: "look", mode: "home"}, "Restore home camera"));
  $("frame-selection").addEventListener("click", () => action({op: "look", mode: "frame-selection"}, "Frame selection"));
  $("undo").addEventListener("click", () => action({op: "undo"}, "Undo edit"));
  $("redo").addEventListener("click", () => action({op: "redo"}, "Redo edit"));
  $("measure").addEventListener("click", () => {
    const next = !measuring;
    clearMeasurement();
    measuring = next;
    $("measure").setAttribute("aria-pressed", String(measuring));
    feedback(measuring ? "Click two visible surfaces in this frame to measure their straight-line distance." : "Distance measurement cancelled.");
  });
  $("reset").addEventListener("click", () => {
    if (confirm("Restore this session to the original loaded scene? The reset can be undone. Source GLBs are not changed.")) action({op: "reset"}, "Reset scene");
  });
  $("apply").addEventListener("click", () => action({op: "edit", code: code.value}, "Apply geometry edit and render"));
  $("starter").addEventListener("click", () => {
    if (code.value !== starter && code.value.trim() && !confirm("Replace your editor contents with the orange barrier example? This does not change the scene until Apply.")) return;
    code.value = starter;
    code.focus();
    updateControls();
  });
  for (const id of ["engine", "samples"]) $(id).addEventListener("input", () => { configDirty = true; });
  $("render").addEventListener("click", () => {
    const samples = Number($("samples").value);
    if (!Number.isInteger(samples) || samples < 1 || samples > 4096) {
      showError("Samples must be a whole number from 1 to 4096.");
      $("samples").focus();
      return;
    }
    action({op: "render", engine: $("engine").value, samples}, "Render frame");
  });
  code.addEventListener("input", updateControls);
  code.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (controlsFree() && code.value.trim()) action({op: "edit", code: code.value}, "Apply geometry edit and render");
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      code.setRangeText("    ", code.selectionStart, code.selectionEnd, "end");
      updateControls();
    }
  });

  function imageBounds() {
    if (frame.hidden || !frame.naturalWidth || !frame.naturalHeight) return null;
    const rect = viewport.getBoundingClientRect();
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const scale = Math.min(width / frame.naturalWidth, height / frame.naturalHeight);
    const imageWidth = frame.naturalWidth * scale;
    const imageHeight = frame.naturalHeight * scale;
    return {left: rect.left + viewport.clientLeft + (width - imageWidth) / 2,
      top: rect.top + viewport.clientTop + (height - imageHeight) / 2, width: imageWidth, height: imageHeight};
  }
  function pointAt(x, y) {
    const bounds = imageBounds();
    if (!bounds) return null;
    const u = (x - bounds.left) / bounds.width;
    const v = (y - bounds.top) / bounds.height;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? {u, v} : null;
  }
  function clearMeasurement() {
    measuring = false;
    measurementPoints = [];
    $("measure").setAttribute("aria-pressed", "false");
    $("measure-overlay").setAttribute("hidden", "");
    $("measurement").hidden = true;
  }
  function drawMeasurement() {
    const bounds = imageBounds();
    if (!bounds || !measurementPoints.length) return;
    const rect = viewport.getBoundingClientRect();
    const overlay = $("measure-overlay");
    Object.assign(overlay.style, {left: `${bounds.left - rect.left - viewport.clientLeft}px`,
      top: `${bounds.top - rect.top - viewport.clientTop}px`, width: `${bounds.width}px`, height: `${bounds.height}px`});
    const [a, b = a] = measurementPoints;
    for (const [id, point] of [["measure-from", a], ["measure-to", b]]) {
      $(id).setAttribute("cx", point.u);
      $(id).setAttribute("cy", point.v);
    }
    for (const [key, value] of Object.entries({x1:a.u, y1:a.v, x2:b.u, y2:b.v})) $("measure-line").setAttribute(key, value);
    overlay.removeAttribute("hidden");
  }
  new ResizeObserver(drawMeasurement).observe(viewport);
  function hint(text) { $("gesture-hint").hidden = !text; $("gesture-hint").textContent = text; }
  function commitGesture() {
    clearTimeout(gestureTimer);
    gestureTimer = null;
    const next = gesture;
    gesture = null;
    hint("");
    updateControls();
    if (next && (next.dx || next.dy || next.amount)) action({op: "look", ...next}, `${next.mode === "dolly" ? "Zoom" : next.mode === "pan" ? "Pan" : "Orbit"} camera`);
  }
  function queueGesture(mode, dx, dy, amount) {
    if (!available() || pointer || (gesture && gesture.mode !== mode)) return;
    gesture ||= {mode, dx: 0, dy: 0, amount: 0};
    gesture.dx += dx;
    gesture.dy += dy;
    gesture.amount = Math.max(-2, Math.min(2, gesture.amount + amount));
    hint(`${mode === "dolly" ? "Zoom" : mode === "pan" ? "Pan" : "Orbit"} queued · pause to render`);
    clearTimeout(gestureTimer);
    gestureTimer = setTimeout(commitGesture, 350);
    updateControls();
  }
  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !controlsFree() || !pointAt(event.clientX, event.clientY)) return;
    viewport.focus({preventScroll: true});
    pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, mode: event.shiftKey ? "pan" : "orbit", moved: false, bounds: imageBounds()};
    viewport.setPointerCapture(event.pointerId);
    updateControls();
  });
  viewport.addEventListener("pointermove", event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) pointer.moved = true;
    if (pointer.moved) {
      viewport.classList.add("dragging");
      hint(`${pointer.mode === "pan" ? "Pan" : "Orbit"} · release to render`);
    }
  });
  function finishPointer(event, cancelled) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const done = pointer;
    pointer = null;
    viewport.classList.remove("dragging");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    hint("");
    updateControls();
    if (cancelled || !available()) return;
    if (done.moved) {
      const dx = (done.lastX - done.x) / done.bounds.width;
      const dy = (done.lastY - done.y) / done.bounds.height;
      if (dx || dy) action({op: "look", mode: done.mode, dx, dy}, `${done.mode === "pan" ? "Pan" : "Orbit"} camera`);
    } else {
      const point = pointAt(event.clientX, event.clientY);
      if (!point) return;
      if (measuring) {
        measurementPoints.push(point);
        drawMeasurement();
        if (measurementPoints.length === 2) {
          measuring = false;
          $("measure").setAttribute("aria-pressed", "false");
          action({op: "measure", frameRevision: loadedRevision, from: measurementPoints[0], to: point}, "Measure surfaces");
        } else feedback("First endpoint marked. Click the second surface.");
        return;
      }
      const rect = viewport.getBoundingClientRect();
      $("pick-marker").style.left = `${event.clientX - rect.left - viewport.clientLeft}px`;
      $("pick-marker").style.top = `${event.clientY - rect.top - viewport.clientTop}px`;
      $("pick-marker").hidden = false;
      clearTimeout(markerTimer);
      markerTimer = setTimeout(() => { $("pick-marker").hidden = true; }, 1400);
      action({op: "pick", frameRevision: loadedRevision, ...point}, "Select surface");
    }
  }
  viewport.addEventListener("pointerup", event => finishPointer(event, false));
  viewport.addEventListener("pointercancel", event => finishPointer(event, true));
  viewport.addEventListener("lostpointercapture", event => finishPointer(event, true));
  viewport.addEventListener("wheel", event => {
    if (frame.hidden || !pointAt(event.clientX, event.clientY)) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    queueGesture("dolly", 0, 0, event.deltaY * scale / 500);
  }, {passive: false});
  viewport.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") { clearMeasurement(); feedback("Distance measurement cleared."); return; }
    const arrows = {ArrowLeft: [-0.07, 0], ArrowRight: [0.07, 0], ArrowUp: [0, -0.07], ArrowDown: [0, 0.07]};
    if (arrows[event.key]) {
      event.preventDefault();
      queueGesture(event.shiftKey ? "pan" : "orbit", ...arrows[event.key], 0);
    } else if (["+", "=", "-", "_"].includes(event.key)) {
      event.preventDefault();
      queueGesture("dolly", 0, 0, ["+", "="].includes(event.key) ? -0.2 : 0.2);
    } else if (event.key.toLowerCase() === "h" && controlsFree()) {
      event.preventDefault();
      action({op: "look", mode: "home"}, "Restore home camera");
    }
  });
  window.addEventListener("blur", () => {
    if (pointer) finishPointer({pointerId: pointer.id}, true);
    if (gesture) commitGesture();
  });
  poll();
})();
