"use client";

import { LoaderCircle, LogOut, MailCheck, UserCog } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StudioCloudProvider, StudioCloudStatus } from "@simforge-oss/studio-host";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { action, cloud } from "@/app/components/host-status-cards.stylex";
import { banner, form } from "@/app/components/cloud/cloud-account.stylex";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Every SimCloud account flow, inline. The panel follows the connector's
 * status: signed out (or expired) shows the sign-in form with sign-up and
 * password reset one step away; signed in shows the account, the
 * verification banner until the address is verified, and sign-out. Only the
 * Google/GitHub buttons leave the app, for the system browser. Passwords and
 * codes go from these inputs to the local service and no further.
 */

const PROVIDER_LABELS: Record<StudioCloudProvider, string> = {
  google: "Google",
  github: "GitHub",
};

type Mode = "sign-in" | "sign-up" | "forgot" | "reset";

export function CloudAccountPanel({ onSignedIn, xstyle }: {
  /** Called once a native or social sign-in reaches `connected`; the sheet closes itself with it. */
  onSignedIn?: () => void;
  xstyle?: stylex.StyleXStyles;
}) {
  const cloud = useStudioCloudStatus();
  const state = cloud.status?.state ?? null;
  if (state === null) {
    return <p {...stylex.props(form.intro, xstyle)}>Checking the SimCloud connection…</p>;
  }
  if (state === "connecting") return <BrowserHop xstyle={xstyle} />;
  if (state === "connected" && cloud.status?.user) return <SignedIn status={cloud.status} xstyle={xstyle} />;
  return <SignedOut status={cloud.status!} onSignedIn={onSignedIn} xstyle={xstyle} />;
}

function BrowserHop({ xstyle }: { xstyle?: stylex.StyleXStyles }) {
  const { disconnect } = useStudioCloudStatus();
  return (
    <div {...stylex.props(form.root, xstyle)} data-testid="cloud-account-browser-hop">
      <p {...stylex.props(form.heading)}>Finish in your browser</p>
      <p {...stylex.props(form.intro)}>
        The provider&apos;s sign-in page opened in your browser. Studio updates itself as soon as it comes back;
        nothing here reloads.
      </p>
      <div {...stylex.props(form.row)}>
        <Button xstyle={form.submit} disabled type="button">
          <LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" />
          Waiting for the browser
        </Button>
        <Button xstyle={form.secondary} onClick={() => void disconnect()} type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SignedIn({ status, xstyle }: { status: StudioCloudStatus; xstyle?: stylex.StyleXStyles }) {
  const { loading, error, disconnect, verifyEmail, resendVerification } = useStudioCloudStatus();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [code, setCode] = useState("");
  const [resent, setResent] = useState(false);
  const codeId = useId();
  const user = status.user!;

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (await verifyEmail(code)) setCode("");
  };

  return (
    <div {...stylex.props(form.root, xstyle)} data-testid="cloud-account-signed-in">
      {!user.emailVerified ? (
        <form {...stylex.props(banner.root)} onSubmit={(event) => void submitCode(event)} data-testid="cloud-account-verify">
          <p {...stylex.props(banner.title)}>
            <MailCheck {...stylex.props(form.icon)} aria-hidden="true" />
            Verify your email address
          </p>
          <p {...stylex.props(banner.detail)}>
            We emailed a 6-digit code to {user.email ?? "your address"}. Enter it here to unlock workspace
            invitations and everything else that needs a verified account.
          </p>
          <div {...stylex.props(form.row)}>
            <label {...stylex.props(form.label)} htmlFor={codeId}>Code</label>
            <Input
              id={codeId}
              xstyle={[form.input, form.code]}
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
            />
            <Button xstyle={form.submit} disabled={loading || code.length !== 6} type="submit">
              Verify
            </Button>
            <button
              {...stylex.props(form.link)}
              disabled={loading}
              onClick={() => void resendVerification().then((ok) => setResent(ok))}
              type="button"
            >
              {resent ? "Code sent again" : "Resend code"}
            </button>
          </div>
          {error ? <p {...stylex.props(form.error)} role="alert">{error}</p> : null}
        </form>
      ) : null}

      {confirmSignOut ? (
        <div
          {...stylex.props(cloud.confirm)}
          role="alertdialog"
          aria-labelledby="cloud-sign-out-title"
          aria-describedby="cloud-sign-out-detail"
        >
          <p id="cloud-sign-out-title" {...stylex.props(cloud.confirmTitle)}>Sign out of SimCloud?</p>
          <p id="cloud-sign-out-detail" {...stylex.props(cloud.confirmDetail)}>
            Maps that need an account and cloud storage lock until you sign in again. Local projects, renders and
            documents on this computer are kept.
          </p>
          <div {...stylex.props(cloud.confirmActions)}>
            <Button
              xstyle={action.amber}
              disabled={loading}
              onClick={() => {
                setConfirmSignOut(false);
                void disconnect();
              }}
              type="button"
            >
              <LogOut {...stylex.props(action.icon)} aria-hidden="true" />
              Sign out
            </Button>
            <Button autoFocus xstyle={action.outline} onClick={() => setConfirmSignOut(false)} type="button" variant="outline">
              Stay signed in
            </Button>
          </div>
        </div>
      ) : (
        <div {...stylex.props(form.row)}>
          <Button asChild xstyle={form.secondary} variant="outline">
            <Link href="/dashboard/account">
              <UserCog {...stylex.props(form.icon)} aria-hidden="true" />
              Manage account
            </Link>
          </Button>
          <Button xstyle={form.secondary} disabled={loading} onClick={() => setConfirmSignOut(true)} type="button" variant="outline">
            <LogOut {...stylex.props(form.icon)} aria-hidden="true" />
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}

function SignedOut({ status, onSignedIn, xstyle }: {
  status: StudioCloudStatus;
  onSignedIn?: () => void;
  xstyle?: stylex.StyleXStyles;
}) {
  const cloud = useStudioCloudStatus();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState(status.user?.email ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [resetDone, setResetDone] = useState(false);
  const id = useId();
  const busy = cloud.loading;
  const expired = status.state === "expired";

  const switchMode = (next: Mode) => {
    setMode(next);
    setPassword("");
    setCode("");
    setResetDone(next === "sign-in" && mode === "reset");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    switch (mode) {
      case "sign-in":
        if (await cloud.signIn({ email, password })) {
          setPassword("");
          onSignedIn?.();
        }
        return;
      case "sign-up":
        if (await cloud.signUp({ email, password, name })) {
          setPassword("");
          onSignedIn?.();
        }
        return;
      case "forgot":
        if (await cloud.forgotPassword(email)) switchMode("reset");
        return;
      case "reset":
        if (await cloud.resetPassword({ email, code, newPassword: password })) switchMode("sign-in");
        return;
    }
  };

  const heading = mode === "sign-up"
    ? "Create your SimCloud account"
    : mode === "forgot"
      ? "Reset your password"
      : mode === "reset"
        ? "Enter the code we emailed"
        : expired
          ? "Your session ended — sign in again"
          : "Sign in to SimCloud";

  return (
    <form
      {...stylex.props(form.root, xstyle)}
      onSubmit={(event) => void submit(event)}
      data-testid="cloud-account-form"
      data-mode={mode}
    >
      <p {...stylex.props(form.heading)}>{heading}</p>
      {mode === "forgot" ? (
        <p {...stylex.props(form.intro)}>We will email a 6-digit code to the address on the account.</p>
      ) : null}
      {resetDone && mode === "sign-in" ? (
        <p {...stylex.props(form.success)} role="status">Password changed. Every device was signed out; sign in with the new password.</p>
      ) : null}

      {mode === "sign-up" ? (
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={`${id}-name`}>Name</label>
          <Input id={`${id}-name`} xstyle={form.input} autoComplete="name" maxLength={120} required value={name} onChange={(event) => setName(event.currentTarget.value)} />
        </div>
      ) : null}

      <div {...stylex.props(form.field)}>
        <label {...stylex.props(form.label)} htmlFor={`${id}-email`}>Email</label>
        <Input
          id={`${id}-email`}
          xstyle={form.input}
          type="email"
          autoComplete="username"
          inputMode="email"
          maxLength={254}
          required
          readOnly={mode === "reset"}
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
      </div>

      {mode === "reset" ? (
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={`${id}-code`}>Code</label>
          <Input
            id={`${id}-code`}
            xstyle={[form.input, form.code]}
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, ""))}
          />
        </div>
      ) : null}

      {mode !== "forgot" ? (
        <div {...stylex.props(form.field)}>
          <div {...stylex.props(form.between)}>
            <label {...stylex.props(form.label)} htmlFor={`${id}-password`}>
              {mode === "reset" ? "New password" : "Password"}
            </label>
            {mode === "sign-in" ? (
              <button {...stylex.props(form.link)} disabled={busy} onClick={() => switchMode("forgot")} type="button">
                Forgot password?
              </button>
            ) : null}
          </div>
          <Input
            id={`${id}-password`}
            xstyle={form.input}
            type="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={mode === "sign-in" ? 1 : 8}
            maxLength={256}
            required
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          {mode !== "sign-in" ? <p {...stylex.props(form.note)}>At least 8 characters.</p> : null}
        </div>
      ) : null}

      {cloud.error ? <p {...stylex.props(form.error)} role="alert">{cloud.error}</p> : null}

      <div {...stylex.props(form.between)}>
        <Button xstyle={form.submit} disabled={busy} type="submit">
          {busy ? <LoaderCircle {...stylex.props(form.icon, form.spin)} aria-hidden="true" /> : null}
          {mode === "sign-up" ? "Create account" : mode === "forgot" ? "Send code" : mode === "reset" ? "Set new password" : "Sign in"}
        </Button>
        {mode === "sign-in" ? (
          <button {...stylex.props(form.link)} disabled={busy} onClick={() => switchMode("sign-up")} type="button">
            Create account
          </button>
        ) : (
          <button {...stylex.props(form.link)} disabled={busy} onClick={() => switchMode("sign-in")} type="button">
            Back to sign in
          </button>
        )}
      </div>

      {mode === "sign-in" && status.providers.length > 0 ? (
        <>
          <div {...stylex.props(form.divider)} aria-hidden="true">
            <span {...stylex.props(form.dividerLine)} />
            or
            <span {...stylex.props(form.dividerLine)} />
          </div>
          <div {...stylex.props(form.providers)}>
            {status.providers.map((provider) => (
              <Button
                key={provider}
                xstyle={form.secondary}
                disabled={busy}
                onClick={() => void cloud.connect(provider).then((ok) => { if (ok) onSignedIn?.(); })}
                type="button"
                variant="outline"
                data-testid={`cloud-account-provider-${provider}`}
              >
                Continue with {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
          <p {...stylex.props(form.note)}>Google and GitHub sign in through your browser and return here.</p>
        </>
      ) : null}
    </form>
  );
}
