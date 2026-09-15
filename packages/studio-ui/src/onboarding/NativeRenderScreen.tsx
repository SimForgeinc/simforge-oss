"use client";

import * as stylex from "@stylexjs/stylex";
import { Check, CircleAlert, Clapperboard, LoaderCircle, SkipForward } from "lucide-react";
import { Button } from "../components/ui/button";
import { installRows, onboarding } from "./onboarding.stylex";

/** Mirrors the host's `NativeRenderInstall` step; the screen owns no install logic. */
export type NativeRenderInstallRow = {
  name: "sky-assets" | "runtime" | "encoder" | "actor-assets";
  state: "pending" | "running" | "done" | "failed";
  detail: string | null;
};

export type NativeRenderInstallView = {
  state: "not-installed" | "installing" | "installed" | "failed";
  reasons: readonly string[];
  steps: readonly NativeRenderInstallRow[];
  error: string | null;
};

const ROW_LABELS: Record<NativeRenderInstallRow["name"], string> = {
  "sky-assets": "Sky plates",
  runtime: "Native runtime",
  encoder: "Video encoder",
  "actor-assets": "Actor appearance assets",
};

const STATE_LABELS: Record<NativeRenderInstallRow["state"], string> = {
  pending: "Waiting",
  running: "Installing",
  done: "Ready",
  failed: "Failed",
};

/**
 * The third onboarding step: native rendering. The native engine renders
 * scenarios to video on this machine; it needs a runtime the host installs
 * on request. Skippable: everything else in Studio works without it, and the
 * render dialog offers the same install later.
 */
export function NativeRenderScreen({
  install,
  loading,
  onContinue,
  onInstall,
}: {
  install: NativeRenderInstallView | null;
  loading: boolean;
  onContinue: () => void;
  onInstall: () => void;
}) {
  const installing = install?.state === "installing";
  const installed = install?.state === "installed";
  return (
    <section data-testid="onboarding-native-render" data-state={install?.state ?? "loading"}>
      <p {...stylex.props(onboarding.eyebrow)}>Step 3 of 3</p>
      <h1 {...stylex.props(onboarding.welcomeTitle)}>Render on this machine</h1>
      <p {...stylex.props(onboarding.welcomeLede)}>
        Native rendering turns a scenario into video with the built-in renderer,
        here, without an account. It needs a one-time runtime install: the
        published runtime for this machine is downloaded and verified, which
        takes a few minutes on a normal connection.
      </p>

      {loading ? (
        <p {...stylex.props(onboarding.catalogLoading)}>
          <LoaderCircle {...stylex.props(onboarding.icon, onboarding.spinner)} aria-hidden="true" />
          Checking this machine…
        </p>
      ) : installed ? (
        <p {...stylex.props(onboarding.accountNote)} data-testid="onboarding-native-render-installed">
          <Check {...stylex.props(onboarding.icon, onboarding.iconAccent, onboarding.iconWithLabel)} aria-hidden="true" />
          Native rendering is installed. Renders you submit run on this machine.
        </p>
      ) : (
        <ul {...stylex.props(installRows.list)} data-testid="onboarding-native-render-rows">
          {(install?.steps ?? []).map((row) => (
            <li key={row.name} {...stylex.props(installRows.row)} data-state={row.state} data-step={row.name}>
              <div {...stylex.props(installRows.rowHead)}>
                <span {...stylex.props(installRows.stateIcon)}>
                  {row.state === "done" ? (
                    <Check {...stylex.props(onboarding.icon)} aria-hidden="true" />
                  ) : row.state === "running" ? (
                    <LoaderCircle {...stylex.props(onboarding.icon, onboarding.spinner)} aria-hidden="true" />
                  ) : row.state === "failed" ? (
                    <CircleAlert {...stylex.props(onboarding.icon, onboarding.iconDanger)} aria-hidden="true" />
                  ) : null}
                </span>
                <span {...stylex.props(installRows.rowLabel)}>{ROW_LABELS[row.name]}</span>
                <span {...stylex.props(installRows.rowBytes)}>{STATE_LABELS[row.state]}</span>
              </div>
              {row.detail && row.state !== "done" ? (
                <p {...stylex.props(installRows.rowMessage)}>{row.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {install?.error ? (
        <p {...stylex.props(onboarding.errorNote)} role="alert">
          {install.error}
        </p>
      ) : null}

      <div {...stylex.props(onboarding.welcomeActions)}>
        {installed ? (
          <Button autoFocus xstyle={onboarding.primaryAction} data-testid="onboarding-native-render-continue" onClick={onContinue} type="button">
            <Check {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
            Continue
          </Button>
        ) : (
          <>
            <Button
              autoFocus
              xstyle={onboarding.primaryAction}
              data-testid="onboarding-native-render-install"
              disabled={loading || installing}
              onClick={onInstall}
              type="button"
            >
              {installing ? (
                <>
                  <LoaderCircle {...stylex.props(onboarding.icon, onboarding.iconWithLabel, onboarding.spinner)} aria-hidden="true" />
                  Installing…
                </>
              ) : (
                <>
                  <Clapperboard {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
                  {install?.state === "failed" ? "Try again" : "Install native rendering"}
                </>
              )}
            </Button>
            <Button
              xstyle={onboarding.secondaryAction}
              data-testid="onboarding-native-render-skip"
              disabled={installing}
              onClick={onContinue}
              type="button"
              variant="outline"
            >
              <SkipForward {...stylex.props(onboarding.icon, onboarding.iconWithLabel)} aria-hidden="true" />
              Skip for now
            </Button>
          </>
        )}
      </div>
      <p {...stylex.props(onboarding.footnote)}>
        You can install it later from Render Settings; the render dialog says when it is needed.
      </p>
    </section>
  );
}
