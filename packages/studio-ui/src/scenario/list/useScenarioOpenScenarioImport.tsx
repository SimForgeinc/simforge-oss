"use client";

import * as stylex from "@stylexjs/stylex";
import { styles } from "./useScenarioOpenScenarioImport.stylex";
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp } from "lucide-react";
import { CloudActivityIndicator } from "../../components/CloudLoadingSurface";
import type { ScenarioDocumentDto } from "../../lib/scenario/contracts";
import { Button } from "../../components/ui/button";
import { list } from "../scenario-controls.stylex";
import type { ScenarioMapOption } from "./document-map-groups";

type Diagnostic = {
  code: string;
  path: string;
  disposition: "supported" | "approximated" | "unsupported";
  message: string;
};

type ImportAnalysis = {
  standard: string;
  source: { byteLength: number; sha256: string; fileName: string };
  title: string;
  logicFile: string | null;
  embeddedMapIdentity: { mapVersionId: string | null; mapId: string | null; xodrSha256: string | null };
  diagnostics: Diagnostic[];
  capabilities: Record<Diagnostic["disposition"], number>;
};

type MapResolution = {
  status: "resolved" | "ambiguous" | "unresolved" | "conflict";
  source: "embedded-identity" | "logic-file" | "explicit" | null;
  requestedIdentity: string | null;
  candidates: Array<{ mapVersionId: string; label: string }>;
  selectedMapVersionId: string | null;
};

type ImportResponse = { analysis: ImportAnalysis; resolution: MapResolution; document?: ScenarioDocumentDto; error?: string; message?: string };

async function submit(file: File, datasetId: string, mode: "analyze" | "create", mapVersionId?: string | null) {
  const form = new FormData();
  form.set("file", file);
  form.set("datasetId", datasetId);
  form.set("mode", mode);
  if (mapVersionId) form.set("mapVersionId", mapVersionId);
  const response = await fetch("/api/simforge/imports/openscenario", { method: "POST", body: form, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as ImportResponse;
  if (!response.ok) throw new Error(body.message ?? body.error ?? `OpenSCENARIO import failed (${response.status}).`);
  return body;
}

export function useScenarioOpenScenarioImport({
  datasetId,
  maps,
  onImported,
}: {
  datasetId: string;
  maps: ReadonlyArray<ScenarioMapOption>;
  onImported: (document: ScenarioDocumentDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [selectedMapVersionId, setSelectedMapVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedUnsupported, setAcknowledgedUnsupported] = useState(false);

  const reset = () => {
    setFile(null);
    setResult(null);
    setSelectedMapVersionId("");
    setError(null);
    setAcknowledgedUnsupported(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const analyze = async (nextFile: File) => {
    setFile(nextFile);
    setBusy(true);
    setError(null);
    setResult(null);
    setAcknowledgedUnsupported(false);
    try {
      const next = await submit(nextFile, datasetId, "analyze");
      setResult(next);
      setSelectedMapVersionId(next.resolution.selectedMapVersionId ?? "");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not analyze this OpenSCENARIO file.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!file || !selectedMapVersionId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await submit(file, datasetId, "create", selectedMapVersionId);
      if (!created.document) throw new Error("The server did not return the imported scenario.");
      setOpen(false);
      reset();
      onImported(created.document);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not import this OpenSCENARIO file.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    reset();
  };

  const dialog = open ? (
    <div {...stylex.props(styles.divFixedFlex)}>
      <button type="button" aria-label="Close OpenSCENARIO dialog" {...stylex.props(styles.closeOpenSCENARIODialogButton)} onClick={close} />
      <div {...stylex.props(styles.xoscImportDialog)} role="dialog" aria-modal="true" aria-labelledby="xosc-import-title" data-testid="xosc-import-dialog">
        <div>
          <h2 id="xosc-import-title" {...stylex.props(styles.xoscImportTitle)}>Open OpenSCENARIO as reference</h2>
          <p {...stylex.props(styles.createANewScenarioFromThePar)}>
            Create a new scenario from the parts we can convert. The original file stays attached as the source reference.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".xosc,application/xml,text/xml"
          aria-label="Choose OpenSCENARIO file"
          {...stylex.props(styles.chooseOpenSCENARIOFileInput)}
          onChange={(event) => { const next = event.target.files?.[0]; if (next) void analyze(next); }}
        />
        <Button type="button" variant="outline" xstyle={list.fileChooser} disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy && !result ? <CloudActivityIndicator /> : <FileUp {...stylex.props(styles.fileupIcon)} aria-hidden="true" />}
          {file ? file.name : "Choose .xosc file"}
        </Button>

        {error ? <div role="alert" {...stylex.props(styles.alert)}>{error}</div> : null}

        {result ? (
          <div {...stylex.props(styles.xoscImportReport)} data-testid="xosc-import-report">
            <div {...stylex.props(styles.divGridSm)}>
              <div><span {...stylex.props(styles.format)}>Format:</span> {result.analysis.standard}</div>
              <div><span {...stylex.props(styles.size)}>Size:</span> {result.analysis.source.byteLength.toLocaleString()} bytes</div>
              <div {...stylex.props(styles.div)}><span {...stylex.props(styles.sha256)}>SHA-256:</span> {result.analysis.source.sha256}</div>
            </div>

            <div {...stylex.props(styles.div2)}>
              <div {...stylex.props(styles.divFlexSmMedium)}>
                {result.resolution.status === "resolved" ? <CheckCircle2 {...stylex.props(styles.checkcircle2Icon)} /> : <AlertTriangle {...stylex.props(styles.alerttriangleIcon)} />}
                Map {result.resolution.status}
                {result.resolution.requestedIdentity ? ` from ${result.resolution.requestedIdentity}` : " — choose explicitly"}
              </div>
              <label {...stylex.props(styles.labelSm)}>
                <span {...stylex.props(styles.map)}>Map</span>
                <select
                  aria-label="Resolved map"
                  {...stylex.props(styles.resolvedMapSelect)}
                  value={selectedMapVersionId}
                  onChange={(event) => setSelectedMapVersionId(event.target.value)}
                >
                  <option value="">Select a known map…</option>
                  {maps.map((map) => <option key={map.mapVersionId} value={map.mapVersionId}>{map.label}</option>)}
                </select>
              </label>
              {result.resolution.status === "ambiguous" ? <p {...stylex.props(styles.multipleMapsMatchedNoMapWasS)}>Multiple maps matched. No map was selected automatically.</p> : null}
              {result.resolution.status === "unresolved" ? <p {...stylex.props(styles.noKnownMapMatchedSelectTheIn)}>No known map matched. Select the intended map; this importer never guesses.</p> : null}
              {result.resolution.status === "conflict" ? <p {...stylex.props(styles.theFileContainsContradictory)}>The file contains contradictory strong map identity. Correct the file before importing.</p> : null}
            </div>

            <div {...stylex.props(styles.xoscConversionSummary)} data-testid="xosc-conversion-summary">
              <h3 {...stylex.props(styles.whatWillBeConverted)}>What will be converted</h3>
              <ul {...stylex.props(styles.ulXs)}>
                <li>{result.analysis.capabilities.supported} {result.analysis.capabilities.supported === 1 ? "part" : "parts"} will carry over.</li>
                <li>{result.analysis.capabilities.approximated} {result.analysis.capabilities.approximated === 1 ? "part" : "parts"} will be simplified.</li>
                <li>{result.analysis.capabilities.unsupported} {result.analysis.capabilities.unsupported === 1 ? "part" : "parts"} will remain only in the source file.</li>
              </ul>
              {result.analysis.capabilities.unsupported > 0 ? (
                <label {...stylex.props(styles.labelFlexXs)}>
                  <input
                    checked={acknowledgedUnsupported}
                    {...stylex.props(styles.xoscUnsupportedAcknowledgemeInput)}
                    data-testid="xosc-unsupported-acknowledgement"
                    onChange={(event) => setAcknowledgedUnsupported(event.target.checked)}
                    type="checkbox"
                  />
                  <span>I understand that unsupported behavior will not be editable in the new scenario.</span>
                </label>
              ) : null}
            </div>

            <details>
              <summary {...stylex.props(styles.technicalConversionDetails)}>Technical conversion details</summary>
              <ul {...stylex.props(styles.openscenarioImportDiagnostic)} aria-label="OpenSCENARIO import diagnostics">
                {result.analysis.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`} {...stylex.props(styles.liXs)}>
                    <div {...stylex.props(styles.divMono)}>{diagnostic.disposition.toUpperCase()} · {diagnostic.path} · {diagnostic.code}</div>
                    <div {...stylex.props(styles.div3)}>{diagnostic.message}</div>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ) : null}

        <div {...stylex.props(styles.divFlex)}>
          <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !result || !selectedMapVersionId || (result.analysis.capabilities.unsupported > 0 && !acknowledgedUnsupported)}
            onClick={() => void create()}
          >
            {busy ? <CloudActivityIndicator /> : null}
            Create reference scenario
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { openDialog: () => setOpen(true), busy, dialog };
}
