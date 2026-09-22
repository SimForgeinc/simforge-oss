import type { ScenarioDatasetDto } from "../../lib/scenario/contracts";

/**
 * The cloud half of the dataset strip's home sections.
 *
 * A dataset has exactly one home — this installation, or one SimCloud
 * organization — and a home is never a mirror
 * (`docs/engineering/local-cloud-boundary.md` §2). The strip therefore renders
 * two disjoint lists: the local datasets it already receives, and the datasets
 * the connected organization owns, read straight from that organization. There
 * is deliberately no "synced", "mirrored" or "available offline" state to
 * represent, and no link record is consulted to build this: the two lists come
 * from two origins and share no rows.
 *
 * Every non-connected case still says something. A signed-out strip is not an
 * empty strip — it names SimCloud and offers the way in — because a silent gap
 * reads as "you have no cloud datasets", which is a different claim.
 */
export type DatasetCloudHome =
  | { state: "managed-loading" }
  | { state: "managed-unavailable"; message: string }
  | { state: "managed"; workspaceId: string; organizationId: string | null; workspaceName: string }
  /** No usable connection: signed out, expired or never connected. Offers sign-in. */
  | { state: "signed-out" }
  /** The connection or the organization's dataset list is still resolving. */
  | { state: "loading" }
  /** Connected, but the organization or its datasets could not be read. */
  | { state: "unavailable"; message: string }
  /** Connected to one organization; `datasets` is what that organization owns, possibly none. */
  | {
      state: "connected";
      organizationName: string;
      datasets: ScenarioDatasetDto[];
      /**
       * How many organizations the account belongs to, including the one shown.
       *
       * The strip shows one organization's datasets. When the account belongs to more than one, the
       * section has to say so: a single organization's name over a single list, with nothing
       * indicating a second exists, asserts a completeness the strip cannot back — the user
       * reasonably concludes the other organization's datasets are missing. Choosing *which*
       * organization is account-settings work (§7), so this is a statement, not a picker.
       */
      organizationCount: number;
    };
