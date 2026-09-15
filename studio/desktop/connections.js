// The connection chooser's page script (connections.html). Plain browser
// code: this page is loaded with `loadFile`, no bundler. Everything it knows
// arrives through `window.simforgeConnections` (connections-preload.cjs);
// nothing here ever holds a token.
"use strict";

(() => {
  const api = window.simforgeConnections;
  const $ = (selector) => document.querySelector(selector);
  const rows = $("[data-testid=connection-rows]");
  const detail = $("[data-testid=connections-detail]");
  const title = $("[data-testid=connections-title]");
  const pairForm = $("[data-testid=pair-form]");
  const pairError = $("[data-testid=pair-error]");
  const plaintextBox = $("[data-testid=plaintext-ack]");
  const plaintextReason = $("[data-testid=plaintext-reason]");
  const vaultNote = $("[data-testid=vault-note]");
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "lost" ? "lost" : "choose";
  document.body.dataset.mode = mode;

  function showError(element, error) {
    element.textContent = error instanceof Error ? error.message : String(error);
    element.hidden = false;
  }

  function button(label, action, extra = {}) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    Object.assign(element.dataset, extra);
    element.addEventListener("click", action);
    return element;
  }

  /**
   * One row: name, where it is, live status, Open/Forget. `where` is the
   * host's origin for a remote and the data root for this computer — the
   * local host has no origin until it has been started.
   */
  function renderRow(entry, selected) {
    const li = document.createElement("li");
    li.className = "row";
    li.dataset.testid = "connection-row";
    li.dataset.id = entry.id;
    li.dataset.selected = String(selected === entry.id);
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = entry.label;
    const where = document.createElement("div");
    where.className = "origin";
    where.textContent = entry.where;
    const status = document.createElement("div");
    status.className = "status";
    status.dataset.testid = "connection-status";
    status.dataset.state = "probing";
    status.textContent = entry.id === "local" ? entry.detail : "Checking…";
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const open = button("Open", async () => {
      open.disabled = true;
      try {
        await api.choose(entry.id);
      } catch (error) {
        status.dataset.state = "refused";
        status.textContent = error instanceof Error ? error.message : String(error);
        open.disabled = false;
      }
    }, { testid: "connection-open" });
    buttons.append(open);
    if (entry.id !== "local") {
      buttons.append(button("Forget", async () => {
        await api.forget(entry.id);
        await render();
      }, { testid: "connection-forget" }));
    }
    li.append(name, buttons, where, status);
    if (entry.id !== "local") {
      if (!entry.hasToken) {
        status.dataset.state = "unpaired";
        status.textContent = "Not paired on this computer: no credentials in the vault. Pair again to use it.";
        open.disabled = true;
      } else if (entry.refused) {
        status.dataset.state = "refused";
        status.textContent = entry.refused;
        open.disabled = true;
      } else {
        api.probe(entry.id).then((result) => {
          if (result.ok) {
            status.dataset.state = "ok";
            // `checkContract` reports what it accepted; a narrower answer
            // must degrade to "answering", never throw inside this handler,
            // where a throw would leave the row reading "Checking…" forever.
            const detail = [
              result.host?.version ? `Studio ${result.host.version}` : null,
              result.host?.protocolVersion ? `protocol v${result.host.protocolVersion}` : null,
            ].filter(Boolean).join(" · ");
            status.textContent = detail ? `Answering · ${detail}` : "Answering, and running a Studio this window can load.";
          } else {
            // One verdict, one wording: the probe checked reachability and
            // the contract together and cannot report one without the
            // other, so the row never reads "reachable" on its own.
            status.dataset.state = "unusable";
            status.textContent = `Cannot be used: ${result.reason}`;
            open.disabled = true;
          }
        }, (error) => {
          status.dataset.state = "unusable";
          status.textContent = error instanceof Error ? error.message : String(error);
          open.disabled = true;
        });
      }
    }
    return li;
  }

  async function render() {
    const state = await api.state();
    if (mode === "lost") {
      title.textContent = "The remote host stopped answering";
      detail.textContent = `SimForge Studio was attached to ${state.origin}. Nothing this window was doing is on this computer; the host keeps its database, jobs and artifacts, and this window can rejoin it as soon as it answers again.`;
      $("[data-testid=lost-reason]").textContent = state.lostReason ?? "";
      return;
    }
    detail.textContent = "Studio runs on the host you choose: its database, map cache, jobs and SimCloud account live there. This computer is the default.";
    rows.replaceChildren(
      renderRow({ id: "local", label: "This computer", where: state.local.dataRoot, detail: state.local.detail }, state.selected),
      ...state.remotes.map((remote) => renderRow({ ...remote, where: remote.origin }, state.selected)),
    );
    vaultNote.hidden = state.vaultPersistence === "os-sealed";
    vaultNote.textContent = "This computer cannot seal a secret with its OS credential store, so host credentials paired now are kept in memory only and must be paired again after a relaunch. They are never written to a file.";
  }

  async function pair() {
    const target = $("[data-testid=pair-target]").value.trim();
    const code = $("[data-testid=pair-code]").value.trim();
    const label = $("[data-testid=pair-label]").value.trim();
    const plaintextAcknowledged = $("[data-testid=plaintext-checkbox]").checked;
    pairError.hidden = true;
    const submit = $("[data-testid=pair-submit]");
    submit.disabled = true;
    try {
      // A refusal is a result, not a failure: `contextBridge` reconstructs a
      // rejected promise's Error from its message only, so the reason it was
      // refused has to arrive as a value to be branched on here.
      const result = await api.pair({ target, code, label, plaintextAcknowledged });
      if ("refused" in result) {
        plaintextReason.textContent = result.refused;
        plaintextBox.hidden = false;
      } else {
        pairForm.hidden = true;
        plaintextBox.hidden = true;
        await render();
      }
    } catch (error) {
      showError(pairError, error);
    } finally {
      submit.disabled = false;
    }
  }

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "show-pair") {
      pairForm.hidden = false;
      $("[data-testid=pair-target]").focus();
    } else if (action === "hide-pair") {
      pairForm.hidden = true;
      pairError.hidden = true;
      plaintextBox.hidden = true;
    } else if (action === "pair") {
      void pair();
    } else if (action === "retry") {
      const reason = $("[data-testid=lost-reason]");
      reason.textContent = "Trying…";
      api.retry().then((ok) => {
        if (!ok) reason.textContent = "Still no answer.";
      }, (error) => showError(reason, error));
    } else if (action === "switch") {
      void api.switchConnection();
    } else if (action === "quit") {
      void api.quit();
    }
  });

  render().catch((error) => showError(detail, error));
})();
