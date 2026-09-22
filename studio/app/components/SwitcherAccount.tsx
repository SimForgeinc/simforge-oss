"use client";

import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioHostCapabilities, StudioHostIdentity } from "@simforge-oss/studio-host";
import { card, chip, lamp } from "@/app/components/host-status-cards.stylex";
import { CloudConnectorChip, WorkspaceChip } from "@/app/host";
import { signOutOfHost, switcherAccountKind } from "@/app/lib/host/account-session";

/**
 * Who you are on a host that has accounts, and how to stop being them.
 *
 * A local install has one fixed owner and so has no sign-out: there is
 * nothing to sign out of and nobody else to become. A host whose identity is
 * an authenticated session is the opposite case, and leaving it out was how
 * the switcher ended up offering a signed-in person a "Sign in" button.
 */
export function AccountChip({
  identity,
  onNavigate,
}: {
  identity: StudioHostIdentity;
  onNavigate?: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const name = identity.displayName ?? "Signed in";

  const signOut = async () => {
    setSigningOut(true);
    onNavigate?.();
    await signOutOfHost((href) => window.location.assign(href));
  };

  return (
    <div {...stylex.props(chip.root)} data-testid="account-chip">
      <span aria-hidden="true" {...stylex.props(lamp.base, lamp.connected)} />
      <div {...stylex.props(chip.body)}>
        <p {...stylex.props(chip.eyebrow)}>Account</p>
        <p {...stylex.props(card.truncate, chip.summary)} title={name}>
          {name}
        </p>
      </div>
      <button
        {...stylex.props(chip.action, chip.manage)}
        disabled={signingOut}
        onClick={signOut}
        type="button"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

/**
 * The switcher's account line, chosen by what the host reports.
 *
 * On a local install the account is a SimCloud connection this computer may
 * or may not have, which is what the connector chip is about. On a cloud host
 * there is nothing to connect — you are already signed in to the thing the
 * chip would offer to sign you in to, and that host ships no connector at all
 * — so the host's own identity is shown instead.
 *
 * A host that reports a fixed-local identity and has no connector shows
 * neither: it has not claimed an account, and inventing one would be a claim
 * about who you are.
 */
export function SwitcherAccount({
  capabilities,
  onNavigate,
}: {
  capabilities: StudioHostCapabilities | null;
  onNavigate?: () => void;
}) {
  if (capabilities === null || switcherAccountKind(capabilities) === "cloud-connection") {
    return CloudConnectorChip ? <CloudConnectorChip onNavigate={onNavigate} /> : null;
  }
  if (switcherAccountKind(capabilities) === "none") return null;
  return (
    <>
      {WorkspaceChip ? <WorkspaceChip identity={capabilities.identity} onNavigate={onNavigate} /> : null}
      <AccountChip identity={capabilities.identity} onNavigate={onNavigate} />
    </>
  );
}
