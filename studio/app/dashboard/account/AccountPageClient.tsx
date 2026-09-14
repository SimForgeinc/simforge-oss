"use client";

import { Check, LoaderCircle, Mail } from "lucide-react";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudAccount, StudioCloudInvitation, StudioCloudWorkspace } from "@simforge-oss/studio-host";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { CloudAccountPanel } from "@/app/components/cloud/CloudAccountPanel";
import { account as styles, form } from "@/app/components/cloud/cloud-account.stylex";
import { cloudErrorMessage, useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * The account page. Signed out it is the sign-in form; signed in it is four
 * sections, each loading its own data from the local service and reloading
 * after its own actions. Errors from account actions come through the
 * connector's shared `error`; loader failures stay with the section.
 */

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A loader that owns its own pending and failure state; `reload` after an action. */
function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    load(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "This could not be loaded."));
      });
    return () => controller.abort();
  }, [load, enabled, version]);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  return { data, error, reload };
}

export function AccountPageClient() {
  useSetPageTitle("Account");
  const cloud = useStudioCloudStatus();
  const signedIn = cloud.status?.state === "connected";

  return (
    <div {...stylex.props(styles.shell)}>
      <SkyCloudBackdrop />
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.inner)}>
          <section aria-labelledby="account-title" {...stylex.props(styles.section, styles.first)}>
            <p {...stylex.props(styles.eyebrow)}>SimCloud</p>
            <h1 id="account-title" {...stylex.props(styles.heading)}>
              {signedIn ? cloud.status?.user?.name ?? cloud.status?.user?.email ?? "Your account" : "Your account"}
            </h1>
            {signedIn && cloud.status?.user?.email ? <p {...stylex.props(styles.copy)}>{cloud.status.user.email}</p> : null}
            <CloudAccountPanel />
          </section>
          {signedIn ? (
            <>
              <ProfileSection />
              <SecuritySection />
              <WorkspacesSection />
              <InvitationsSection />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProfileSection() {
  const cloud = useStudioCloudStatus();
  const [name, setName] = useState(cloud.status?.user?.name ?? "");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = useId();
  const current = cloud.status?.user?.name ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const result = await cloud.updateAccount({ name: name.trim() });
    setFailed(result === null);
    if (result) setSaved(true);
  };

  return (
    <section aria-labelledby="account-profile-title" {...stylex.props(styles.section)} data-testid="account-profile">
      <p {...stylex.props(styles.eyebrow)}>Profile</p>
      <h2 id="account-profile-title" {...stylex.props(styles.heading)}>Name</h2>
      <p {...stylex.props(styles.copy)}>How you appear to the members of your workspaces.</p>
      <form {...stylex.props(form.root)} onSubmit={(event) => void submit(event)}>
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={id}>Name</label>
          <Input id={id} xstyle={form.input} autoComplete="name" maxLength={120} required value={name} onChange={(event) => { setName(event.currentTarget.value); setSaved(false); }} />
        </div>
        <div {...stylex.props(form.row)}>
          <Button xstyle={form.submit} disabled={cloud.loading || name.trim().length === 0 || name.trim() === current} type="submit">
            Save
          </Button>
          {saved ? <span {...stylex.props(form.success)} role="status"><Check {...stylex.props(form.icon)} aria-hidden="true" /> Saved</span> : null}
        </div>
        {failed && cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}
      </form>
    </section>
  );
}

function SecuritySection() {
  const cloud = useStudioCloudStatus();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changed, setChanged] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = useId();
  const load = useCallback((signal: AbortSignal) => cloud.account(signal), [cloud.account]);
  const devices = useLoader<StudioCloudAccount>(load, true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChanged(false);
    const ok = await cloud.changePassword({ currentPassword, newPassword });
    setFailed(!ok);
    if (ok) {
      setCurrentPassword("");
      setNewPassword("");
      setChanged(true);
      devices.reload();
    }
  };

  const revoke = async (sessionId: string) => {
    setRevoking(sessionId);
    try {
      const ok = await cloud.revokeSession(sessionId);
      setFailed(!ok);
      if (ok) devices.reload();
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section aria-labelledby="account-security-title" {...stylex.props(styles.section)} data-testid="account-security">
      <p {...stylex.props(styles.eyebrow)}>Security</p>
      <h2 id="account-security-title" {...stylex.props(styles.heading)}>Password</h2>
      <p {...stylex.props(styles.copy)}>Changing it signs out every other device; this computer stays signed in.</p>
      <form {...stylex.props(form.root)} onSubmit={(event) => void submit(event)}>
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
          <Button xstyle={form.submit} disabled={cloud.loading || currentPassword.length === 0 || newPassword.length < 8} type="submit">
            Change password
          </Button>
          {changed ? <span {...stylex.props(form.success)} role="status"><Check {...stylex.props(form.icon)} aria-hidden="true" /> Password changed</span> : null}
        </div>
        {failed && cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}
      </form>

      <h2 {...stylex.props(styles.heading, styles.subheading)}>Devices</h2>
      <p {...stylex.props(styles.copy)}>Every computer signed in to this account. Signing a device out takes effect on its next request.</p>
      {devices.error ? <p {...stylex.props(form.error)} role="alert">{devices.error}</p> : null}
      {devices.data === null && !devices.error ? <p {...stylex.props(styles.empty)}><LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> Loading devices…</p> : null}
      {devices.data ? (
        <ul {...stylex.props(styles.list)} data-testid="account-devices">
          {devices.data.sessions.map((session) => (
            <li key={session.id} {...stylex.props(styles.item)} data-current={session.current || undefined}>
              <div {...stylex.props(styles.itemBody)}>
                <p {...stylex.props(styles.itemTitle)}>
                  {session.label ?? session.userAgent ?? "Unnamed device"}
                  {session.current ? <span {...stylex.props(styles.tag)}>This computer</span> : null}
                  {!session.active ? <span {...stylex.props(styles.tag)}>Signed out</span> : null}
                </p>
                <p {...stylex.props(styles.itemDetail)}>
                  Signed in {formatWhen(session.createdAt)} · last used {formatWhen(session.lastUsedAt)}
                </p>
              </div>
              {!session.current && session.active ? (
                <Button xstyle={[form.secondary, styles.compact]} disabled={cloud.loading || revoking !== null} onClick={() => void revoke(session.id)} type="button" variant="outline">
                  {revoking === session.id ? <LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> : null}
                  Sign out
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function WorkspacesSection() {
  const cloud = useStudioCloudStatus();
  const load = useCallback((signal: AbortSignal) => cloud.listWorkspaces(signal), [cloud.listWorkspaces]);
  const workspaces = useLoader<StudioCloudWorkspace[]>(load, true);
  const active = cloud.status?.activeWorkspaceId ?? null;
  const [switching, setSwitching] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const choose = async (organizationId: string) => {
    setSwitching(organizationId);
    try {
      setFailed(!(await cloud.setActiveWorkspace(organizationId)));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section aria-labelledby="account-workspaces-title" {...stylex.props(styles.section)} data-testid="account-workspaces">
      <p {...stylex.props(styles.eyebrow)}>Workspaces</p>
      <h2 id="account-workspaces-title" {...stylex.props(styles.heading)}>Active workspace</h2>
      <p {...stylex.props(styles.copy)}>The workspace cloud storage and managed inference act in. Workspaces are created and administered in SimCloud.</p>
      {workspaces.error ? <p {...stylex.props(form.error)} role="alert">{workspaces.error}</p> : null}
      {failed && cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}
      {workspaces.data === null && !workspaces.error ? <p {...stylex.props(styles.empty)}><LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> Loading workspaces…</p> : null}
      {workspaces.data?.length === 0 ? <p {...stylex.props(styles.empty)}>You are not a member of any workspace yet. Accept an invitation below to join one.</p> : null}
      {workspaces.data && workspaces.data.length > 0 ? (
        <ul {...stylex.props(styles.list)}>
          {workspaces.data.map((workspace) => (
            <li key={workspace.id} {...stylex.props(styles.item)} data-active={workspace.id === active || undefined}>
              <div {...stylex.props(styles.itemBody)}>
                <p {...stylex.props(styles.itemTitle)}>
                  {workspace.name}
                  {workspace.id === active ? <span {...stylex.props(styles.tag)}>Active</span> : null}
                </p>
                <p {...stylex.props(styles.itemDetail)}>{workspace.role}</p>
              </div>
              {workspace.id !== active ? (
                <Button xstyle={[form.secondary, styles.compact]} disabled={cloud.loading || switching !== null} onClick={() => void choose(workspace.id)} type="button" variant="outline">
                  {switching === workspace.id ? <LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> : null}
                  Make active
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function InvitationsSection() {
  const cloud = useStudioCloudStatus();
  const load = useCallback((signal: AbortSignal) => cloud.listInvitations(signal), [cloud.listInvitations]);
  const invitations = useLoader<StudioCloudInvitation[]>(load, true);
  const [acting, setActing] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [joined, setJoined] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = useId();
  const verified = cloud.status?.user?.emailVerified ?? false;

  const act = async (invitationId: string, accept: boolean) => {
    setActing(invitationId);
    try {
      const ok = accept ? await cloud.acceptInvitation(invitationId) : await cloud.declineInvitation(invitationId);
      setFailed(!ok);
      if (ok) invitations.reload();
    } finally {
      setActing(null);
    }
  };

  const submitLink = async (event: FormEvent) => {
    event.preventDefault();
    setJoined(false);
    const ok = await cloud.acceptInvitationLink(link.trim());
    setFailed(!ok);
    if (ok) {
      setLink("");
      setJoined(true);
      invitations.reload();
    }
  };

  return (
    <section aria-labelledby="account-invitations-title" {...stylex.props(styles.section)} data-testid="account-invitations">
      <p {...stylex.props(styles.eyebrow)}>Invitations</p>
      <h2 id="account-invitations-title" {...stylex.props(styles.heading)}>Workspace invitations</h2>
      <p {...stylex.props(styles.copy)}>
        Invitations sent to {cloud.status?.user?.email ?? "your email"}.
        {verified ? "" : " Verify your email address above before accepting one."}
      </p>
      {invitations.error ? <p {...stylex.props(form.error)} role="alert">{invitations.error}</p> : null}
      {failed && cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}
      {invitations.data === null && !invitations.error ? <p {...stylex.props(styles.empty)}><LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> Loading invitations…</p> : null}
      {invitations.data?.length === 0 ? <p {...stylex.props(styles.empty)}>No pending invitations.</p> : null}
      {invitations.data && invitations.data.length > 0 ? (
        <ul {...stylex.props(styles.list)}>
          {invitations.data.map((invitation) => (
            <li key={invitation.id} {...stylex.props(styles.item)}>
              <div {...stylex.props(styles.itemBody)}>
                <p {...stylex.props(styles.itemTitle)}>
                  <Mail {...stylex.props(form.icon)} aria-hidden="true" />
                  {invitation.organizationName}
                </p>
                <p {...stylex.props(styles.itemDetail)}>
                  {invitation.role}{invitation.inviterEmail ? ` · invited by ${invitation.inviterEmail}` : ""} · expires {formatWhen(invitation.expiresAt)}
                </p>
              </div>
              <div {...stylex.props(form.row)}>
                <Button xstyle={[form.submit, styles.compact]} disabled={cloud.loading || acting !== null || !verified} onClick={() => void act(invitation.id, true)} type="button">
                  {acting === invitation.id ? <LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> : null}
                  Accept
                </Button>
                <Button xstyle={[form.secondary, styles.compact]} disabled={cloud.loading || acting !== null} onClick={() => void act(invitation.id, false)} type="button" variant="outline">
                  Decline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form {...stylex.props(form.root, styles.spaced)} onSubmit={(event) => void submitLink(event)}>
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={id}>Have an invite link?</label>
          <Input id={id} xstyle={form.input} type="text" autoComplete="off" inputMode="url" maxLength={2048} placeholder="Paste the link from the invitation email" required value={link} onChange={(event) => { setLink(event.currentTarget.value); setJoined(false); }} />
        </div>
        <div {...stylex.props(form.row)}>
          <Button xstyle={form.submit} disabled={cloud.loading || link.trim().length === 0 || !verified} type="submit">
            Join workspace
          </Button>
          {joined ? <span {...stylex.props(form.success)} role="status"><Check {...stylex.props(form.icon)} aria-hidden="true" /> Joined</span> : null}
        </div>
      </form>
    </section>
  );
}
