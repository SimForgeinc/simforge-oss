"use client";

import { Boxes, KeyRound, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { cn } from "@simforge-oss/studio-ui/lib/utils";
import type {
  AiProviderKeyStatus,
  AiProviderSettingsStatus,
  UpdateAiProviderSettings,
} from "@/app/lib/ai-providers/contracts";

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
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={inputId} className="text-xs font-medium text-white/60">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={status.configured ? `Replace key ending in …${status.keyHint}` : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
          className="font-mono"
        />
        <Button type="submit" disabled={busy || draft.trim().length < 8}>
          <KeyRound aria-hidden="true" />
          Save
        </Button>
        {status.configured && status.source !== "environment" ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void onClear()}>
            <Trash2 aria-hidden="true" />
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] leading-4 text-white/40">
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
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8 text-white">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">AI providers</h1>
        <p className="mt-1 text-sm text-white/50">
          3D asset generation calls an external AI service. SimForge ships no keys: bring your own.
        </p>
        <p className="mt-2 text-xs text-white/40">
          <Link href="/dashboard/settings" className="underline underline-offset-2">
            Back to settings
          </Link>
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {!status ? (
        <p className="flex items-center gap-2 text-sm text-white/50">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Loading provider status…
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-xs text-white/45">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {status.keyStorage === "os-vault"
              ? "Keys you enter are kept in this computer's secure credential vault."
              : "This computer has no usable credential vault: keys you enter are kept in memory only and must be re-entered after the app restarts."}
          </p>

          <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <h2 className="flex items-center gap-2 text-base font-medium">
              <Boxes className="size-4 text-[#E8E044]" aria-hidden="true" />
              3D asset generation
            </h2>
            <p
              className={cn(
                "mt-2 text-xs",
                status.assetGeneration.available ? "text-emerald-200/80" : "text-amber-200/90",
              )}
              aria-live="polite"
            >
              {status.assetGeneration.available
                ? "Ready: generated models are published to your local asset library."
                : status.assetGeneration.reason}
            </p>
            <div className="mt-4">
              <KeyField
                label="Meshy API key"
                status={status.assetGeneration.meshy}
                placeholder="msy_…"
                busy={busy}
                onSave={(key) => patch({ meshyApiKey: key })}
                onClear={() => patch({ meshyApiKey: null })}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
