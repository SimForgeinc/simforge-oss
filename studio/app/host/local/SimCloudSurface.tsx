"use client";

import {
  BadgeCheck,
  Brain,
  Cloud,
  CloudOff,
  Database,
  KeyRound,
  LoaderCircle,
  Map as MapIcon,
  MailWarning,
  UserCircle,
} from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import type {
  StudioCloudAccount,
  StudioCloudOrganization,
  StudioCloudStatus,
} from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { AppStage } from "@/app/components/AppStage";
import { plate } from "@/app/components/AppStage.stylex";
import {
  CloudBrowserHop,
  CloudSignInForm,
  CloudSignOutAction,
  CloudVerifyEmailBanner,
} from "./cloud/CloudAccountPanel";
import { form } from "./cloud/cloud-account.stylex";
import {
  CloudAccountDeletedNotice,
  CloudDeleteAccountAction,
} from "./simcloud/CloudDeleteAccountAction";
import { SimCloudStorage } from "./simcloud/SimCloudStorage";
import { cloudErrorMessage, studioCloud, useStudioCloudStatus } from "@/app/lib/host/cloud";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/**
 * SimCloud: the one surface for the account and everything the account
 * unlocks. It replaces the separate "Cloud Storage" and "Account" tabs and
 * the sign-in affordances that used to be scattered across the shell.
 *
 * It is a profile card, not a dashboard. Signed in, it states who you are,
 * which organization you act in, and what the account gives this
 * installation — read from the live catalog and the live compute capability
 * report, not from a cached credential, so an expired session says so instead
 * of claiming access the host does not have. There is deliberately no
 * credits, quota or usage UI: entitlement is unlimited today, and a meter
 * would be a promise about billing that the product does not make.
 *
 * Signed out it is the sign-in form, with sign-up and password reset one step
 * away.
 */

type Tab = "account" | "storage";

/** What the account unlocks, as the live host reports it — never as a cached claim. */
type Capability = {
  maps: { total: number; locked: number } | null;
  models: { families: string[]; kinds: string[] } | null;
  /** Why a capability is unknown, when it is. */
  reason: string | null;
};

/** CloudCompute's capability report, reduced to what a capability line states. */
type ComputeCapabilitiesResponse = {
  enabled?: boolean;
  families?: { family: string; available?: boolean; kinds?: string[] }[];
};

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SimCloudSurface() {
  const cloud = useStudioCloudStatus();
  const state = cloud.status?.state ?? null;
  const connected = state === "connected";
  const [tab, setTab] = useState<Tab>("account");
  const [organizations, setOrganizations] = useState<StudioCloudOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [capability, setCapability] = useState<Capability>({ maps: null, models: null, reason: null });

  /**
   * A password sign-in leaves `status.activeOrganizationId` null by design, so
   * the tenant this installation acts in comes from the organization listing.
   */
  useEffect(() => {
    if (!connected) {
      setOrganizations([]);
      setOrganizationId(null);
      return;
    }
    const controller = new AbortController();
    void studioCloud.listOrganizations(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setOrganizations(rows);
        setOrganizationId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
      })
      .catch(() => {
        // The organization line falls back to the session's own id below.
      });
    return () => controller.abort();
  }, [connected]);

  // The honest observables: the map catalog the host really answers, and the
  // compute families the cloud really reports for this session.
  useEffect(() => {
    const controller = new AbortController();
    setCapability({ maps: null, models: null, reason: null });
    const read = async (): Promise<Capability> => {
      const catalogResponse = await fetch("/api/simforge/maps/catalog", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!catalogResponse.ok) {
        return { maps: null, models: null, reason: `The map catalog did not answer (${catalogResponse.status}).` };
      }
      const catalog = (await catalogResponse.json()) as {
        maps: { locked: boolean }[];
        upstream: { reachable: boolean; message?: string };
      };
      const maps = {
        total: catalog.maps.length,
        locked: catalog.maps.filter((map) => map.locked).length,
      };
      if (!connected) {
        return {
          maps,
          models: null,
          reason: catalog.upstream.reachable ? null : catalog.upstream.message ?? null,
        };
      }
      const computeResponse = await fetch("/api/simforge/cloud/compute/capabilities", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!computeResponse.ok) {
        return { maps, models: null, reason: `Cloud models did not answer (${computeResponse.status}).` };
      }
      const compute = (await computeResponse.json()) as ComputeCapabilitiesResponse;
      const available = (compute.families ?? []).filter((family) => family.available !== false);
      return {
        maps,
        models: {
          families: available.map((family) => family.family),
          kinds: [...new Set(available.flatMap((family) => family.kinds ?? []))],
        },
        reason: compute.enabled === false ? "Cloud compute is not enabled for this account." : null,
      };
    };
    void read()
      .then((next) => {
        if (!controller.signal.aborted) setCapability(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setCapability({ maps: null, models: null, reason: cloudErrorMessage(reason, "Capabilities could not be read.") });
        }
      });
    return () => controller.abort();
  }, [connected, cloud.status?.user?.id]);

  return (
    <AppStage
      fill
      eyebrow="SimCloud"
      title="SimCloud"
      testId="simcloud-panel"
      actions={
        connected ? (
          <nav {...stylex.props(plate.tabs)} aria-label="SimCloud sections">
            <button
              {...stylex.props(plate.tab, tab === "account" ? plate.tabActive : plate.tabIdle)}
              aria-current={tab === "account" ? "page" : undefined}
              data-testid="simcloud-tab-account"
              onClick={() => setTab("account")}
              type="button"
            >
              <UserCircle {...stylex.props(plate.tabIcon)} aria-hidden="true" />
              Account
            </button>
            <button
              {...stylex.props(plate.tab, tab === "storage" ? plate.tabActive : plate.tabIdle)}
              aria-current={tab === "storage" ? "page" : undefined}
              data-testid="simcloud-tab-storage"
              onClick={() => setTab("storage")}
              type="button"
            >
              <Database {...stylex.props(plate.tabIcon)} aria-hidden="true" />
              Datasets &amp; artifacts
            </button>
          </nav>
        ) : undefined
      }
    >
      <div {...stylex.props(plate.sidebarColumns)}>
        <ProfileCard
          capability={capability}
          organization={organizations.find((row) => row.id === organizationId) ?? null}
          status={cloud.status}
        />
        {state === null ? (
          <p {...stylex.props(plate.root, plate.copy)}>Checking the SimCloud connection…</p>
        ) : state === "connecting" ? (
          <section {...stylex.props(plate.root)}>
            <CloudBrowserHop />
          </section>
        ) : connected ? (
          tab === "account" ? (
            <AccountSection status={cloud.status!} />
          ) : (
            <SimCloudStorage
              organizations={organizations}
              organizationId={organizationId}
              onOrganizationChange={setOrganizationId}
            />
          )
        ) : (
          <section {...stylex.props(plate.root)} data-testid="simcloud-sign-in">
            <CloudAccountDeletedNotice />
            <CloudSignInForm status={cloud.status!} />
          </section>
        )}
      </div>
    </AppStage>
  );
}

/**
 * The profile card: identity, the organization, and capability stated as
 * fact. Every capability line is the live answer or an explicit unknown.
 */
function ProfileCard({
  capability,
  organization,
  status,
}: {
  capability: Capability;
  organization: StudioCloudOrganization | null;
  status: StudioCloudStatus | null;
}) {
  const connected = status?.state === "connected";
  const user = connected ? status.user : null;
  const expired = status?.state === "expired";

  return (
    <section
      {...stylex.props(plate.root, styles.card)}
      data-testid="simcloud-profile"
      data-cloud-state={status?.state ?? "loading"}
    >
      <div {...stylex.props(styles.identity)}>
        <span {...stylex.props(styles.avatar)}>
          {connected ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
        </span>
        <div {...stylex.props(styles.identityBody)}>
          <p {...stylex.props(plate.eyebrow)}>
            {connected ? "Signed in" : expired ? "Session ended" : status === null ? "Checking…" : "Signed out"}
          </p>
          <p {...stylex.props(styles.name, plate.truncate)}>
            {user?.name ?? user?.email ?? "No SimCloud account"}
          </p>
          {user?.email ? <p {...stylex.props(plate.copy, plate.truncate)}>{user.email}</p> : null}
        </div>
      </div>

      <div {...stylex.props(plate.row)}>
        {user ? (
          user.emailVerified ? (
            <span {...stylex.props(plate.pill, plate.pillAccent)}>
              <BadgeCheck {...stylex.props(plate.icon)} aria-hidden="true" />
              Verified
            </span>
          ) : (
            <span {...stylex.props(plate.pill)}>
              <MailWarning {...stylex.props(plate.icon)} aria-hidden="true" />
              Email not verified
            </span>
          )
        ) : null}
        {connected ? <span {...stylex.props(plate.pill)}>Unlimited use</span> : null}
      </div>

      <dl {...stylex.props(plate.facts)}>
        <div {...stylex.props(plate.fact)}>
          <dt {...stylex.props(plate.factLabel)}>Organization</dt>
          {/* Wraps rather than truncating: an organization name plus a role is
              routinely wider than this column, and the name is the fact. */}
          <dd {...stylex.props(plate.factValue)}>
            {organization
              ? `${organization.name} · ${organization.role}`
              : connected
                ? status.activeOrganizationId ?? "None yet"
                : "—"}
          </dd>
        </div>
        <div {...stylex.props(plate.fact)}>
          <dt {...stylex.props(plate.factLabel)}>Server</dt>
          <dd {...stylex.props(plate.factValue, plate.mono, plate.truncate)}>
            {status ? status.origin.replace(/^https?:\/\//, "") : "—"}
          </dd>
        </div>
        {connected ? (
          <>
            <div {...stylex.props(plate.fact)}>
              <dt {...stylex.props(plate.factLabel)}>Sign-in kept</dt>
              <dd {...stylex.props(plate.factValue)}>
                {status.credentialPersistence === "os-vault"
                  ? "In this computer's secure vault"
                  : "In memory until the app closes"}
              </dd>
            </div>
            <div {...stylex.props(plate.fact)}>
              <dt {...stylex.props(plate.factLabel)}>Session until</dt>
              <dd {...stylex.props(plate.factValue)}>{formatWhen(status.sessionExpiresAt)}</dd>
            </div>
          </>
        ) : null}
      </dl>

      <p {...stylex.props(plate.eyebrow, styles.capabilityHead)}>
        {connected ? "This account unlocks" : "Without an account"}
      </p>
      <ul {...stylex.props(plate.list)} data-testid="simcloud-capability">
        <li {...stylex.props(styles.capability)}>
          <MapIcon {...stylex.props(plate.icon, connected && plate.accent)} aria-hidden="true" />
          <span data-testid="simcloud-capability-maps">
            {capability.maps === null
              ? "Maps — reading the catalog…"
              : connected
                ? capability.maps.locked === 0
                  ? `All ${capability.maps.total} map${capability.maps.total === 1 ? "" : "s"}, no download limit`
                  : `${capability.maps.total - capability.maps.locked} of ${capability.maps.total} maps available`
                : `${capability.maps.total} map${capability.maps.total === 1 ? "" : "s"} without an account`}
          </span>
        </li>
        <li {...stylex.props(styles.capability)}>
          <Brain {...stylex.props(plate.icon, connected && plate.accent)} aria-hidden="true" />
          <span data-testid="simcloud-capability-models">
            {capability.models === null
              ? connected
                ? "Cloud models — asking SimCloud…"
                : "Local models only; cloud models need an account"
              : capability.models.kinds.length === 0
                ? "No cloud model runs reported for this account"
                : `Cloud models: ${capability.models.kinds.join(", ")}`}
          </span>
        </li>
        <li {...stylex.props(styles.capability)}>
          <Database {...stylex.props(plate.icon, connected && plate.accent)} aria-hidden="true" />
          <span>
            {connected
              ? "Import and publish datasets and artifacts in your organization"
              : "Everything on this computer keeps working; nothing is uploaded"}
          </span>
        </li>
      </ul>
      {capability.reason ? <p {...stylex.props(plate.empty)}>{capability.reason}</p> : null}
    </section>
  );
}

/**
 * Account management: verification, password, the devices signed in to the
 * account, and sign-out. Deleting an account has no server-side operation on
 * SimCloud yet (`DELETE /api/desktop/account` answers 405), so this surface
 * deliberately offers no delete affordance rather than a control that fails.
 */
function AccountSection({ status }: { status: StudioCloudStatus }) {
  const cloud = useStudioCloudStatus();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changed, setChanged] = useState(false);
  const [failed, setFailed] = useState(false);
  const [account, setAccount] = useState<StudioCloudAccount | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    void studioCloud.account(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setAccount(next);
          setDevicesError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setDevicesError(cloudErrorMessage(reason, "The devices list could not be loaded."));
      });
    return () => controller.abort();
  }, [version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setChanged(false);
    const ok = await cloud.changePassword({ currentPassword, newPassword });
    setFailed(!ok);
    if (ok) {
      setCurrentPassword("");
      setNewPassword("");
      setChanged(true);
      reload();
    }
  };

  const revoke = async (sessionId: string) => {
    setRevoking(sessionId);
    try {
      if (await cloud.revokeSession(sessionId)) reload();
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div {...stylex.props(styles.pane)} data-testid="simcloud-account">
      <CloudVerifyEmailBanner status={status} />

      <section {...stylex.props(plate.root)}>
        <h2 {...stylex.props(plate.title)}>
          <KeyRound {...stylex.props(plate.icon)} aria-hidden="true" /> Password
        </h2>
        <p {...stylex.props(plate.copy)}>
          Changing it signs out every other device; this computer stays signed in.
        </p>
        <form {...stylex.props(form.root)} onSubmit={(event) => void submitPassword(event)}>
          <div {...stylex.props(form.field)}>
            <label {...stylex.props(form.label)} htmlFor={`${id}-current`}>Current password</label>
            <Input id={`${id}-current`} xstyle={form.input} type="password" autoComplete="current-password" maxLength={256} required value={currentPassword} onChange={(event) => setCurrentPassword(event.currentTarget.value)} />
          </div>
          <div {...stylex.props(form.field)}>
            <label {...stylex.props(form.label)} htmlFor={`${id}-new`}>New password</label>
            <Input id={`${id}-new`} xstyle={form.input} type="password" autoComplete="new-password" minLength={8} maxLength={256} required value={newPassword} onChange={(event) => setNewPassword(event.currentTarget.value)} />
            <p {...stylex.props(form.note)}>At least 8 characters.</p>
          </div>
          <div {...stylex.props(form.row)}>
            <Button xstyle={plate.button} variant="outline" disabled={cloud.loading || currentPassword.length === 0 || newPassword.length < 8} type="submit">
              Change password
            </Button>
            {changed ? <span {...stylex.props(form.success)} role="status">Password changed</span> : null}
          </div>
          {failed && cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}
        </form>
      </section>

      <section {...stylex.props(plate.root)}>
        <h2 {...stylex.props(plate.title)}>Devices</h2>
        <p {...stylex.props(plate.copy)}>
          Every computer signed in to this account. Signing one out revokes its session in SimCloud.
        </p>
        {devicesError ? <p {...stylex.props(form.error)} role="alert">{devicesError}</p> : null}
        {account === null && devicesError === null ? (
          <p {...stylex.props(plate.empty)}>
            <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> Loading devices…
          </p>
        ) : null}
        {account ? (
          <ul {...stylex.props(plate.list)} data-testid="simcloud-devices">
            {account.sessions.map((session) => (
              <li key={session.id} {...stylex.props(plate.item)} data-current={session.current || undefined}>
                <div {...stylex.props(styles.deviceBody)}>
                  <p {...stylex.props(plate.title, styles.deviceTitle, plate.truncate)}>
                    {session.label ?? session.userAgent ?? "Unnamed device"}
                    {session.current ? <span {...stylex.props(plate.pill, plate.pillAccent)}>This computer</span> : null}
                    {session.active ? null : <span {...stylex.props(plate.pill, plate.pillMuted)}>Signed out</span>}
                  </p>
                  <p {...stylex.props(plate.copy, plate.truncate)}>
                    Signed in {formatWhen(session.createdAt)} · last used {formatWhen(session.lastUsedAt)}
                  </p>
                </div>
                {!session.current && session.active ? (
                  <Button xstyle={plate.button} variant="outline" disabled={cloud.loading || revoking !== null} onClick={() => void revoke(session.id)} type="button">
                    {revoking === session.id ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" /> : null}
                    Sign out
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section {...stylex.props(plate.root)}>
        <h2 {...stylex.props(plate.title)}>This computer</h2>
        <p {...stylex.props(plate.copy)}>
          Signing out revokes this installation&apos;s session in SimCloud and removes the sign-in from this
          computer. Your projects, renders and documents here are untouched.
        </p>
        <CloudSignOutAction />
      </section>

      <CloudDeleteAccountAction />
    </div>
  );
}

const styles = stylex.create({
  pane: { display: "grid", alignContent: "start", gap: space.s3, minWidth: 0 },
  card: { alignContent: "start" },
  identity: { display: "flex", alignItems: "center", gap: space.s3, minWidth: 0 },
  identityBody: { display: "grid", gap: space.s0_5, minWidth: 0 },
  avatar: {
    display: "grid",
    placeItems: "center",
    width: "2.75rem",
    height: "2.75rem",
    flexShrink: 0,
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.12)",
    backgroundColor: colors.fillSubtle,
    color: colors.ink,
  },
  name: {
    fontFamily: text.fontDisplay,
    fontSize: text.sizeLg,
    lineHeight: text.lineBase,
    fontWeight: text.weightSemibold,
    letterSpacing: "-0.02em",
  },
  capabilityHead: { marginTop: space.s1 },
  capability: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1.125rem",
    color: "rgb(255 255 255 / 0.65)",
  },
  deviceBody: { display: "grid", gap: space.s0_5, minWidth: 0, flex: "1 1 12rem" },
  deviceTitle: { display: "flex", alignItems: "center", gap: space.s1_5, fontSize: "0.8125rem" },
});
