"use client";

import * as stylex from "@stylexjs/stylex";
import { KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { plate } from "@/app/components/AppStage.stylex";
import { form } from "./cloud/cloud-account.stylex";
import type {
  AiCredentialSource,
  AiProviderSettingsStatus,
  UpdateAiProviderSettings,
} from "@/app/lib/ai-providers/contracts";
import { focus, hairline, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/**
 * AI provider keys, as a Settings pane rather than a page of its own: 3D
 * asset generation calls an external service and SimForge ships no keys.
 *
 * A key is sent once to the local service, which puts it in this computer's
 * credential vault (or holds it in memory when there is none) and never hands
 * it back — the UI only ever sees the last four characters it reports.
 */

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

const SOURCE_LABELS: Record<AiCredentialSource, string> = {
  "os-vault": "stored in this computer's secure vault",
  session: "kept in memory until the app closes",
  environment: "set by the service environment",
};

export function AiProviderSettings() {
  const [status, setStatus] = useState<AiProviderSettingsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const inputId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(SETTINGS_URL, { cache: "no-store", signal: controller.signal })
      .then(readStatusResponse)
      .then((result) => {
        setStatus(result.status);
        setError(result.error);
      })
      .catch((reason: unknown) => {
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = draft.trim();
    if (key.length < 8) return;
    await patch({ meshyApiKey: key });
    setDraft("");
  };

  const meshy = status?.assetGeneration.meshy ?? null;

  return (
    <section {...stylex.props([hairline.all, plate.root])} data-testid="settings-ai-providers">
      <p {...stylex.props([typography.eyebrow, plate.eyebrow])}>Authoring</p>
      <h2 {...stylex.props(plate.title)}>AI providers</h2>
      <p {...stylex.props(plate.copy)}>
        3D asset generation calls an external AI service. Bring your own key; nothing is set by default.
      </p>
      {error ? <p {...stylex.props(form.error)} role="alert">{error}</p> : null}
      {status === null && error === null ? (
        <p {...stylex.props(plate.empty)}>
          <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> Loading provider status…
        </p>
      ) : null}
      {status && meshy ? (
        <>
          <p {...stylex.props(plate.copy, plate.row)}>
            <ShieldCheck {...stylex.props(plate.icon)} aria-hidden="true" />
            {status.keyStorage === "os-vault"
              ? "Keys you enter are kept in this computer's secure credential vault."
              : "This computer has no usable credential vault: keys you enter are kept in memory only and must be re-entered after the app restarts."}
          </p>
          <p {...stylex.props(plate.copy)} aria-live="polite">
            {status.assetGeneration.available
              ? "Ready: generated models are published to your local asset library."
              : status.assetGeneration.reason}
          </p>
          <form {...stylex.props(form.root)} onSubmit={(event) => void submit(event)}>
            <div {...stylex.props(form.field)}>
              <label htmlFor={inputId} {...stylex.props(form.label)}>Meshy API key</label>
              <Input variant="plate"
                id={inputId}
                xstyle={form.input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                placeholder={meshy.configured ? `Replace key ending in …${meshy.keyHint}` : "msy_…"}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
              />
            </div>
            <div {...stylex.props(form.row)}>
              <Button xstyle={[focus.ring, plate.button]} variant="outline" type="submit" disabled={busy || draft.trim().length < 8}>
                <KeyRound {...stylex.props(plate.icon)} aria-hidden="true" />
                Save
              </Button>
              {meshy.configured && meshy.source !== "environment" ? (
                <Button xstyle={[focus.ring, plate.button]} variant="outline" type="button" disabled={busy} onClick={() => void patch({ meshyApiKey: null })}>
                  <Trash2 {...stylex.props(plate.icon)} aria-hidden="true" />
                  Remove
                </Button>
              ) : null}
            </div>
            <p {...stylex.props(form.note)}>
              {meshy.configured && meshy.source
                ? `Key ending in …${meshy.keyHint}, ${SOURCE_LABELS[meshy.source]}.`
                : "No key stored."}{" "}
              The key is sent once to the local SimForge service and never shown again.
            </p>
          </form>
        </>
      ) : null}
    </section>
  );
}
