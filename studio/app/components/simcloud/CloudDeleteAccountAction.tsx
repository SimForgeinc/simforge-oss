"use client";

import { LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@simforge-oss/studio-ui/components/ui/button";
import { Input } from "@simforge-oss/studio-ui/components/ui/input";
import { plate } from "@/app/components/AppStage.stylex";
import { form } from "@/app/components/cloud/cloud-account.stylex";
import { useStudioCloudStatus } from "@/app/lib/host/cloud";

/**
 * Deleting the SimCloud account, from the account pane it belongs to.
 *
 * Two gates, because the action is irreversible and SimCloud counts attempts
 * rather than failures against its per-account throttle: the current password,
 * which SimCloud re-checks and which is the only thing that actually
 * authorises the deletion, and a typed word, which exists so that a password
 * sitting in a browser autofill cannot be submitted by one stray click. The
 * confirmation names what goes and what stays, because the thing users get
 * wrong here is believing their local work is cloud work — it is not, and
 * deleting the account touches none of it.
 */

/** Typed verbatim to arm the deletion; compared exactly, because it is meant to be deliberate. */
const CONFIRMATION_WORD = "DELETE";

export function CloudDeleteAccountAction() {
  const cloud = useStudioCloudStatus();
  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const passwordId = useId();
  const confirmId = useId();
  const email = cloud.status?.user?.email ?? null;

  const disarm = () => {
    setArmed(false);
    setPassword("");
    setTyped("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // A refusal keeps the form up carrying SimCloud's own sentence, which says
    // whether anything was deleted. The password is cleared because it was
    // wrong; the typed word is kept, because retyping it proves nothing twice.
    if (await cloud.deleteAccount({ password })) disarm();
    else setPassword("");
  };

  if (!armed) {
    return (
      <section {...stylex.props(plate.root)} data-testid="simcloud-delete-account">
        <h2 {...stylex.props(plate.title)}>
          <TriangleAlert {...stylex.props(plate.icon)} aria-hidden="true" /> Delete this account
        </h2>
        <p {...stylex.props(plate.copy)}>
          Permanently deletes your SimCloud account{email ? ` (${email})` : ""} and closes any organization you are the
          only member of. Everything on this computer is kept.
        </p>
        <div {...stylex.props(form.row)}>
          <Button
            data-testid="simcloud-delete-account-open"
            disabled={cloud.loading}
            onClick={() => setArmed(true)}
            type="button"
            variant="outline"
            xstyle={plate.button}
          >
            <Trash2 {...stylex.props(plate.icon)} aria-hidden="true" />
            Delete account…
          </Button>
        </div>
      </section>
    );
  }

  const ready = password.length > 0 && typed === CONFIRMATION_WORD && !cloud.loading;

  return (
    <section {...stylex.props(plate.root)} data-testid="simcloud-delete-account">
      <h2 {...stylex.props(plate.title)}>
        <TriangleAlert {...stylex.props(plate.icon)} aria-hidden="true" /> Delete your SimCloud account?
      </h2>
      <form
        aria-describedby={`${confirmId}-detail`}
        data-testid="simcloud-delete-account-confirm"
        onSubmit={(event) => void submit(event)}
      >
        <div id={`${confirmId}-detail`} {...stylex.props(plate.noticeError)}>
          <p>
            This cannot be undone. Deleted for good: your account{email ? ` ${email}` : ""}, every organization you are
            the only member of and the cloud datasets, renders and uploads inside it, and every signed-in device
            including this one. Organizations you share with other people stay and you are removed from them; if you
            own one that still has other members, SimCloud refuses until you transfer it or remove them.
          </p>
        </div>
        <p {...stylex.props(plate.copy)}>
          Kept, untouched: everything on this computer. Your scenarios, datasets, renders and installed maps all stay
          where they are, and Studio keeps working signed out — only maps and storage that need an account lock.
        </p>
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={passwordId}>Your password</label>
          <Input
            id={passwordId}
            autoComplete="current-password"
            data-testid="simcloud-delete-password"
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
            xstyle={form.input}
          />
        </div>
        <div {...stylex.props(form.field)}>
          <label {...stylex.props(form.label)} htmlFor={confirmId}>Type {CONFIRMATION_WORD} to confirm</label>
          <Input
            id={confirmId}
            autoComplete="off"
            data-testid="simcloud-delete-confirmation"
            onChange={(event) => setTyped(event.currentTarget.value)}
            required
            spellCheck={false}
            value={typed}
            xstyle={form.input}
          />
        </div>
        {cloud.error ? (
          <p {...stylex.props(form.error)} data-testid="simcloud-delete-error" role="alert">{cloud.error}</p>
        ) : null}
        <div {...stylex.props(form.row)}>
          <Button data-testid="simcloud-delete-submit" disabled={!ready} type="submit" xstyle={plate.button}>
            {cloud.loading
              ? <LoaderCircle {...stylex.props(plate.icon, plate.spinner)} aria-hidden="true" />
              : <Trash2 {...stylex.props(plate.icon)} aria-hidden="true" />}
            Delete my account
          </Button>
          <Button
            autoFocus
            disabled={cloud.loading}
            onClick={disarm}
            type="button"
            variant="outline"
            xstyle={plate.button}
          >
            Keep my account
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * What the deletion destroyed, shown on the signed-out surface — the account
 * pane it was triggered from does not exist once the account is gone. The
 * sentence is SimCloud's own: it names the organizations that closed and says
 * local data was untouched, and there is no second opinion worth composing.
 */
export function CloudAccountDeletedNotice() {
  const { accountDeleted } = useStudioCloudStatus();
  if (!accountDeleted) return null;
  return (
    <p {...stylex.props(plate.notice)} data-testid="simcloud-account-deleted" role="status">
      {accountDeleted.message}
    </p>
  );
}
