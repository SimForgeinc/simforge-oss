"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown } from "lucide-react";
import type { StudioHostIdentity } from "@simforge-oss/studio-host";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@simforge-oss/studio-ui/components/ui/dropdown-menu";
import { layers } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
import { card, chip, lamp } from "@/app/components/host-status-cards.stylex";

type WorkspaceSummary = { id: string; name: string; slug: string; type: string };

const styles = stylex.create({
  /** The menu sits above the switcher overlay, which is itself above dialogs. */
  menu: { zIndex: layers.appSwitcherTop, minWidth: "14rem" },
  chevron: { width: "0.75rem", height: "0.75rem", marginLeft: "0.25rem", verticalAlign: "-0.125rem" },
  meta: { marginLeft: "auto", paddingLeft: "0.75rem", fontSize: "10px", opacity: 0.5, textTransform: "capitalize" },
});

/**
 * The tenant you are acting in, and the way to become a different one.
 *
 * Quick switch is a menu of every workspace the account belongs to; choosing
 * one activates it on the server and reloads at Apps, because every server
 * component on the page was rendered for the previous workspace. Details is
 * the workspace page itself — members, billing, usage, general.
 */
export function WorkspaceChip({ identity, onNavigate }: { identity: StudioHostIdentity; onNavigate?: () => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces", { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as WorkspaceSummary[]) : []))
      .then((list) => { if (!cancelled) setWorkspaces(list); })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, []);

  const current = workspaces?.find((workspace) => workspace.id === identity.workspaceId) ?? null;

  async function activate(workspaceId: string) {
    if (workspaceId === identity.workspaceId || switching) return;
    setSwitching(workspaceId);
    setError(null);
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/activate`, { method: "POST" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Could not switch workspace.");
      setSwitching(null);
      return;
    }
    onNavigate?.();
    window.location.assign("/dashboard/apps");
  }

  const summary = switching
    ? `Switching to ${workspaces?.find((workspace) => workspace.id === switching)?.name ?? "workspace"}…`
    : error ?? current?.name ?? (workspaces === null ? "Loading…" : "No workspace");

  return (
    <div {...stylex.props(chip.root)} data-testid="workspace-chip">
      <span aria-hidden="true" {...stylex.props(lamp.base, error ? lamp.attention : lamp.connected)} />
      <div {...stylex.props(chip.body)}>
        <p {...stylex.props(chip.eyebrow)}>Workspace</p>
        <p {...stylex.props(card.truncate, chip.summary)} title={current ? `${current.name} · ${current.slug}` : undefined}>
          {summary}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button {...stylex.props(chip.action, chip.manage)} type="button" disabled={switching !== null} aria-label="Switch workspace">
            Switch
            <ChevronDown {...stylex.props(styles.chevron)} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" xstyle={styles.menu}>
          <DropdownMenuLabel>Your workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={identity.workspaceId} onValueChange={activate}>
            {(workspaces ?? []).map((workspace) => (
              <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                {workspace.name}
                <span {...stylex.props(styles.meta)}>{workspace.type}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {workspaces?.length === 0 ? <DropdownMenuItem disabled>No workspaces yet</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard/workspace/new" onClick={onNavigate}>Create workspace…</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/dashboard/workspace/join" onClick={onNavigate}>Join with an invitation…</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Link {...stylex.props(chip.action, chip.manage)} href="/dashboard/workspace/settings" onClick={onNavigate}>
        Details
      </Link>
    </div>
  );
}
