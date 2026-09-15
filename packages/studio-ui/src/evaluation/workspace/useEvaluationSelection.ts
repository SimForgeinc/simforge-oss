"use client";

/**
 * What the evaluation workspace is looking at, as URL query state.
 *
 * Selection is soft state, exactly as the datasets index treats the open
 * dataset: picking a run must not re-run a server component or remount the
 * stage, but the URL must still be reloadable and copyable. So every selection
 * is written with `history.replaceState` and read back from `useSearchParams`
 * when something outside this client changes the query (the app switcher, a
 * deep-link redirect, the back button).
 *
 * The shape is a discriminated union on the section rather than a bag of
 * optional ids, because the sections do not share a selection: a campaign
 * policy and a model version are never both open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

export type EvaluationSection = "runs" | "campaigns" | "models";

export type EvaluationSelection =
  | { section: "runs"; run?: string; local?: string }
  | {
      section: "campaigns";
      campaign?: string;
      policy?: string;
      episode?: string;
      /** The ordered compare columns; the first is the baseline. */
      compare?: string[];
    }
  | { section: "models"; version?: string };

/** The reader half of `URLSearchParams`, which is all parsing needs. */
export type SelectionParams = {
  get(name: string): string | null;
  getAll(name: string): string[];
};

export const EVALUATION_SELECTION_STORAGE_KEY = "evaluation.selection.v1";

const SECTIONS: readonly EvaluationSection[] = ["runs", "campaigns", "models"];

/** A query value is only an id when it carries one; `?run=` selects nothing. */
function id(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The selection a query string describes, with the impossible states removed
 * rather than carried:
 *  - an `episode` or `policy` without a `campaign` has nothing to resolve
 *    against, so the campaign section opens with nothing selected;
 *  - `mode=compare` with fewer than two policies is not a comparison, so the
 *    mode drops and the single policy is opened normally;
 *  - a run and a local run cannot both be open; the cloud run wins, since it
 *    is the one a shared link carries.
 */
export function parseSelection(params: SelectionParams): EvaluationSelection {
  const requested = params.get("section");
  const section: EvaluationSection = SECTIONS.find((candidate) => candidate === requested) ?? "runs";

  if (section === "models") {
    const version = id(params.get("version"));
    return version ? { section, version } : { section };
  }

  if (section === "campaigns") {
    const campaign = id(params.get("campaign"));
    if (!campaign) return { section };
    const policies = params
      .getAll("policy")
      .map((value) => id(value))
      .filter((value): value is string => value !== undefined);
    if (params.get("mode") === "compare" && policies.length >= 2) {
      return { section, campaign, compare: policies };
    }
    const episode = id(params.get("episode"));
    const policy = policies[0];
    if (episode) return policy ? { section, campaign, policy, episode } : { section, campaign, episode };
    return policy ? { section, campaign, policy } : { section, campaign };
  }

  const run = id(params.get("run"));
  if (run) return { section: "runs", run };
  const local = id(params.get("local"));
  return local ? { section: "runs", local } : { section: "runs" };
}

/**
 * The query string for a selection. Round-trips through `parseSelection`,
 * including the compare columns, whose order is the comparison's baseline
 * order and therefore load-bearing.
 */
export function serializeSelection(selection: EvaluationSelection): string {
  const params = new URLSearchParams();
  params.set("section", selection.section);
  if (selection.section === "runs") {
    if (selection.run) params.set("run", selection.run);
    else if (selection.local) params.set("local", selection.local);
  } else if (selection.section === "campaigns") {
    if (selection.campaign) {
      params.set("campaign", selection.campaign);
      if (selection.compare && selection.compare.length >= 2) {
        params.set("mode", "compare");
        for (const policy of selection.compare) params.append("policy", policy);
      } else {
        if (selection.policy) params.set("policy", selection.policy);
        if (selection.episode) params.set("episode", selection.episode);
      }
    }
  } else if (selection.version) {
    params.set("version", selection.version);
  }
  return params.toString();
}

/** Is anything open, or is the section showing its own landing state? */
export function hasSelection(selection: EvaluationSelection): boolean {
  if (selection.section === "runs") return Boolean(selection.run ?? selection.local);
  if (selection.section === "models") return Boolean(selection.version);
  return Boolean(selection.campaign);
}

function remember(selection: EvaluationSelection) {
  try {
    window.localStorage.setItem(EVALUATION_SELECTION_STORAGE_KEY, serializeSelection(selection));
  } catch {
    // A denied or full storage costs the memory of the last selection, nothing else.
  }
}

function recall(): EvaluationSelection | null {
  try {
    const stored = window.localStorage.getItem(EVALUATION_SELECTION_STORAGE_KEY);
    return stored ? parseSelection(new URLSearchParams(stored)) : null;
  } catch {
    return null;
  }
}

export type EvaluationSelectionHandle = {
  selection: EvaluationSelection;
  /** Replace the whole selection. The section may change with it. */
  select: (next: EvaluationSelection) => void;
  /** Switch sections, restoring nothing: a section opens on its own landing state. */
  selectSection: (section: EvaluationSection) => void;
};

export function useEvaluationSelection(): EvaluationSelectionHandle {
  const searchParams = useSearchParams();
  const routeQuery = searchParams.toString();
  const [selection, setSelection] = useState<EvaluationSelection>(() => parseSelection(searchParams));
  // The query this client wrote itself. Without it the reconcile effect below
  // would fight every `replaceState` it makes.
  const selfWrittenQueryRef = useRef<string | null>(null);

  const write = useCallback((next: EvaluationSelection) => {
    const query = serializeSelection(next);
    selfWrittenQueryRef.current = query;
    setSelection(next);
    remember(next);
    const url = new URL(window.location.href);
    url.search = query;
    window.history.replaceState(null, "", url);
  }, []);

  // A first visit with a bare `/dashboard/evaluation` lands on what was open
  // last, the way the datasets index does.
  useEffect(() => {
    if (routeQuery) return;
    const remembered = recall();
    if (!remembered || !hasSelection(remembered)) return;
    write(remembered);
    // Intentionally mount-only: this restores the entry URL, and re-running it
    // on a later clear would refuse to let the user close a selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Soft navigation into this page (app switcher, deep-link redirect, Back)
  // changes the query without remounting: read it rather than keep stale state.
  useEffect(() => {
    if (selfWrittenQueryRef.current === routeQuery) {
      selfWrittenQueryRef.current = null;
      return;
    }
    selfWrittenQueryRef.current = null;
    if (!routeQuery) return;
    setSelection(parseSelection(new URLSearchParams(routeQuery)));
  }, [routeQuery]);

  const selectSection = useCallback(
    (section: EvaluationSection) => write({ section } as EvaluationSelection),
    [write],
  );

  return { selection, select: write, selectSection };
}
