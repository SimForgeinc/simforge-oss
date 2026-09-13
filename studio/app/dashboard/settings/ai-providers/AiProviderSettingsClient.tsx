"use client";

import * as stylex from "@stylexjs/stylex";
import { Boxes, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import type { AiProviderKeyStatus, AiProviderSettingsStatus, UpdateAiProviderSettings } from "@/app/lib/ai-providers/contracts";
import { styles } from "./ai-provider-settings.stylex";

const SETTINGS_URL = "/api/simforge/ai-providers";

type StatusResult = { status: AiProviderSettingsStatus | null; error: string | null };

async function readStatusResponse(response: Response): Promise<StatusResult> {
  if (response.ok) return { status: (await response.json()) as AiProviderSettingsStatus, error: null };
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  return {
    status: null,
    error: body?.message ?? body?.error ?? `AI provider settings request failed (${response.status}).`,
  };
}

function sourceLabel(status: AiProviderKeyStatus): string {
  switch (status.source) {
    case "os-vault":
      return "stored in this computer's secure vault";
    case "session":
      return "kept in memory until the app closes";
    case "environment":
      return "set by the service environment";
    default:
      return "not configured";
  }
}

function KeyField({
  label,
  status,
  placeholder,
  busy,
  onSave,
  onClear,
}: {
  label: string;
  status: AiProviderKeyStatus;
  placeholder: string;
  busy: boolean;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = draft.trim();
    if (key.length < 8) return;
    await onSave(key);
    setDraft("");
  };
  return (
    <form onSubmit={submit} {...stylex.props(styles.form)}>
      <label htmlFor={inputId} {...stylex.props(styles.label)}>{label}</label>
      <div {...stylex.props(styles.controls)}>
        <Input id={inputId} type="password" autoComplete="off" spellCheck={false} value={draft}
          placeholder={status.configured ? `Replace key ending in …${status.keyHint}` : placeholder}
          onChange={(event) => setDraft(event.target.value)} disabled={busy}
          xstyle={styles.mono} />
        <Button type="submit" disabled={busy || draft.trim().length < 8}><KeyRound {...stylex.props(styles.icon)} aria-hidden="true" />Save</Button>
        {status.configured && status.source !== "environment" ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void onClear()}><Trash2 {...stylex.props(styles.icon)} aria-hidden="true" />Remove</Button>
        ) : null}
      </div>
      <p {...stylex.props(styles.note)}>
        {status.configured ? `Key ending in …${status.keyHint}, ${sourceLabel(status)}.` : "No key stored."}{" "}
        The key is sent once to the local SimForge service and never shown again.
      </p>
    </form>
  );
}
export function AiProviderSettingsClient() {
  const [status, setStatus] = useState<AiProviderSettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(SETTINGS_URL, { cache: "no-store", signal: controller.signal })
      .then(readStatusResponse)
      .then((result) => {
        setStatus(result.status);
        setError(result.error);
      })
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError("AI provider settings could not be loaded.");
        }
      });
    return () => controller.abort();
  }, []);

  const patch = useCallback(async (body: UpdateAiProviderSettings) => {
    setBusy(true);
    setError(null);
    try {
      const result = await readStatusResponse(
        await fetch(SETTINGS_URL, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      if (result.status) setStatus(result.status);
      setError(result.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI provider settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div {...stylex.props(styles.root)}>
      <header>
        <h1 {...stylex.props(styles.title)}>AI providers</h1>
        <p {...stylex.props(styles.lead)}>3D asset generation calls an external AI service. SimForge ships no keys: bring your own.</p>
        <p {...stylex.props(styles.back)}><Link href="/dashboard/settings">Back to settings</Link></p>
      </header>
      {error ? <p role="alert" {...stylex.props(styles.alert)}>{error}</p> : null}
      {!status ? (
        <p {...stylex.props(styles.loading)}><LoaderCircle {...stylex.props(styles.spinner)} aria-hidden="true" />Loading provider status…</p>
      ) : (
        <>
          <p {...stylex.props(styles.vault)}><ShieldCheck {...stylex.props(styles.icon)} aria-hidden="true" />{status.keyStorage === "os-vault" ? "Keys you enter are kept in this computer's secure credential vault." : "This computer has no usable credential vault: keys you enter are kept in memory only and must be re-entered after the app restarts."}</p>
          <section {...stylex.props(styles.panel)}>
            <h2 {...stylex.props(styles.panelTitle)}><Boxes {...stylex.props(styles.icon, styles.accent)} aria-hidden="true" />3D asset generation</h2>
            <p {...stylex.props(styles.availability, status.assetGeneration.available ? styles.ready : styles.unavailable)} aria-live="polite">{status.assetGeneration.available ? "Ready: generated models are published to your local asset library." : status.assetGeneration.reason}</p>
            <div {...stylex.props(styles.field)}><KeyField label="Meshy API key" status={status.assetGeneration.meshy} placeholder="msy_…" busy={busy} onSave={(key) => patch({ meshyApiKey: key })} onClear={() => patch({ meshyApiKey: null })} /></div>
          </section>
        </>
      )}
    </div>
  );
}
