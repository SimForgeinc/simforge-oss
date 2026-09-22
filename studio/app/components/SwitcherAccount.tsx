"use client";

import { useState } from "react";
import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown, LogOut } from "lucide-react";
import type { StudioHostCapabilities, StudioHostIdentity } from "@simforge-oss/studio-host";
import { card, chip } from "@/app/components/host-status-cards.stylex";
import { CloudConnectorChip, WorkspaceChip } from "@/app/host";
import { signOutOfHost, switcherAccountKind } from "@/app/lib/host/account-session";
import type { NavItem } from "@/app/lib/dashboard-nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import { focus, motionRecipe, textLayout, typography } from "@simforge-oss/studio-ui/stylex/recipes.stylex";

/**
 * Who you are on a host that has accounts, as one segment of the switcher's
 * bar: your name is the button, and the menu it opens holds the host's
 * account surfaces and the way to stop being you.
 *
 * A local install has one fixed owner and so has no sign-out: there is
 * nothing to sign out of and nobody else to become. A host whose identity is
 * an authenticated session is the opposite case, and leaving it out was how
 * the switcher ended up offering a signed-in person a "Sign in" button.
 */
export function AccountChip({
  identity,
  hostLabel,
  accountItems,
  onNavigate,
}: {
  identity: StudioHostIdentity;
  hostLabel: string;
  /** The host's own account surfaces; see `hostNavItems`. */
  accountItems: readonly NavItem[];
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          {...stylex.props(chip.root, [motionRecipe.colors, [focus.ringInset, chip.trigger]])}
          aria-label={`Account: ${name}. Open account menu`}
          data-testid="account-chip"
          disabled={signingOut}
          type="button"
        >
          <span {...stylex.props(chip.body)}>
            <span {...stylex.props([typography.tag, chip.eyebrow])}>Account</span>
            <span {...stylex.props(textLayout.truncate, chip.summary)} title={name}>
              {signingOut ? "Signing out…" : name}
            </span>
          </span>
          <ChevronDown {...stylex.props(chip.chevron)} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" xstyle={chip.menu} data-testid="account-menu">
        <DropdownMenuLabel>
          <span {...stylex.props(chip.menuName)}>{name}</span>
          <span {...stylex.props(chip.menuMeta)}>Signed in to {hostLabel}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accountItems.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem asChild key={item.href}>
              <Link href={item.href} onClick={onNavigate}>
                <Icon {...stylex.props(chip.menuIcon)} aria-hidden="true" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
        {accountItems.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem disabled={signingOut} onSelect={signOut}>
          <LogOut {...stylex.props(chip.menuIcon)} aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  accountItems,
  onNavigate,
}: {
  capabilities: StudioHostCapabilities | null;
  accountItems: readonly NavItem[];
  onNavigate?: () => void;
}) {
  if (capabilities === null || switcherAccountKind(capabilities) === "cloud-connection") {
    return CloudConnectorChip ? <CloudConnectorChip onNavigate={onNavigate} /> : null;
  }
  if (switcherAccountKind(capabilities) === "none") return null;
  return (
    <>
      {WorkspaceChip ? <WorkspaceChip identity={capabilities.identity} onNavigate={onNavigate} /> : null}
      <AccountChip
        identity={capabilities.identity}
        hostLabel={capabilities.host.label}
        accountItems={accountItems}
        onNavigate={onNavigate}
      />
    </>
  );
}
