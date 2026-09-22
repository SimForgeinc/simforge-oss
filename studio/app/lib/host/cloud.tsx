"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createHttpStudioCloudService,
  isDesktopShell,
  StudioHostRequestError,
  type StudioCloudAccount,
  type StudioCloudAccountDeletion,
  type StudioCloudInvitation,
  type StudioCloudProvider,
  type StudioCloudService,
  type StudioCloudStatus,
  type StudioCloudOrganization,
} from "@simforge-oss/studio-host";
import { studioHost } from "@/app/lib/host";

/**
 * The local SimCloud connector: same-origin `/api/simforge/cloud/*` routes on
 * the local service, which holds the credentials. Separate from `studioHost`
 * on purpose — signing in adds cloud maps and storage, it never swaps the host
 * that owns local projects, jobs and renders.
 */
export const studioCloud: StudioCloudService = createHttpStudioCloudService();

/** How long the app keeps asking the local service whether the Google/GitHub browser hop finished. */
const CONNECT_POLL_INTERVAL_MS = 2_000;
const CONNECT_POLL_LIMIT_MS = 5 * 60_000;

/** Stable loader identities: a section that keys an effect on one never reloads because `loading` flipped. */
const loadAccount = (signal?: AbortSignal) => studioCloud.account(signal);
const loadInvitations = (signal?: AbortSignal) => studioCloud.listInvitations(signal);
const loadOrganizations = (signal?: AbortSignal) => studioCloud.listOrganizations(signal);

/**
 * Account actions answer `true` on success. On failure they set `error` with
 * the product message and answer `false`, so a form can stay on its step
 * without a second copy of the message.
 */
export type StudioCloudConnection = {
  /** `null` until the first status read resolves. */
  status: StudioCloudStatus | null;
  /** True while an account request or the social-hop poll is in flight. */
  loading: boolean;
  /** Product message for the last failed operation; cleared by the next successful one. */
  error: string | null;
  /** Whether the shared account sheet is open; any surface can open it in place of navigating away. */
  accountPanelOpen: boolean;
  openAccountPanel(): void;
  closeAccountPanel(): void;
  refresh(): Promise<void>;
  /** The one browser hop: opens the provider sign-in and polls status until it settles or times out. */
  connect(provider: StudioCloudProvider): Promise<boolean>;
  signIn(input: { email: string; password: string }): Promise<boolean>;
  signUp(input: { email: string; password: string; name: string }): Promise<boolean>;
  verifyEmail(code: string): Promise<boolean>;
  resendVerification(): Promise<boolean>;
  forgotPassword(email: string): Promise<boolean>;
  resetPassword(input: { email: string; code: string; newPassword: string }): Promise<boolean>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<boolean>;
  updateAccount(input: { name: string }): Promise<StudioCloudAccount | null>;
  revokeSession(id: string): Promise<boolean>;
  /**
   * Irreversibly delete the signed-in account, re-authenticating with the
   * password. Answers `false` and sets `error` when the Cloud refuses, leaving
   * the account and this sign-in untouched. On success `status` becomes
   * disconnected and {@link accountDeleted} carries what was destroyed.
   */
  deleteAccount(input: { password: string }): Promise<boolean>;
  /**
   * The last completed deletion, kept across the signed-in -> signed-out
   * transition so the signed-out surface can say what happened. Cleared by the
   * next sign-in or sign-up.
   */
  accountDeleted: StudioCloudAccountDeletion | null;
  acceptInvitation(id: string): Promise<boolean>;
  declineInvitation(id: string): Promise<boolean>;
  acceptInvitationLink(token: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
  /** Loaders for the account page; they throw so the page owns its own empty and error states. */
  account(signal?: AbortSignal): Promise<StudioCloudAccount>;
  listInvitations(signal?: AbortSignal): Promise<StudioCloudInvitation[]>;
  listOrganizations(signal?: AbortSignal): Promise<StudioCloudOrganization[]>;
};

const StudioCloudContext = createContext<StudioCloudConnection | null>(null);

export function cloudErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof StudioHostRequestError) return reason.message;
  if (reason instanceof Error && reason.name !== "AbortError" && reason.message) return reason.message;
  return fallback;
}

/**
 * One status reader and one social-hop poller for the whole dashboard.
 * Native account actions read status once from their own answer; polling
 * runs only while the service reports `connecting`, and stops on settle,
 * unmount or the bounded limit — a stuck browser tab never keeps the app
 * hitting the local service forever.
 */
export function StudioCloudProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StudioCloudStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [accountDeleted, setAccountDeleted] = useState<StudioCloudAccountDeletion | null>(null);
  const poll = useRef<AbortController | null>(null);
  const mapScope = status?.state === "connected" ? `${status.user?.id}:${status.activeOrganizationId}` : status?.state;
  // The first settled scope is the one the page already loaded its maps for;
  // only a later change (sign-in, sign-out, workspace switch) needs a fresh
  // list. Refreshing on the first one fetched the map list twice per load.
  const loadedMapScope = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!mapScope || mapScope === "connecting") return;
    const previous = loadedMapScope.current;
    loadedMapScope.current = mapScope;
    if (previous === undefined || previous === mapScope) return;
    const controller = new AbortController();
    void studioHost.artifacts.listMaps(controller.signal, { fresh: true }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "The local map library could not be refreshed."));
    });
    return () => controller.abort();
  }, [mapScope]);

  useEffect(() => {
    const controller = new AbortController();
    const readStatus = () => {
      void studioCloud.status(controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) {
            setStatus(next);
            setError(next.state === "error" ? next.message : null);
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
        });
    };
    readStatus();
    // The browser hop can finish after the bounded poll has stopped.
    const onFocus = () => {
      if (!poll.current) readStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      controller.abort();
      poll.current?.abort();
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await studioCloud.status());
      setError(null);
    } catch (reason) {
      setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
    }
  }, []);

  const pollUntilSettled = useCallback(async (): Promise<boolean> => {
    poll.current?.abort();
    const controller = new AbortController();
    poll.current = controller;
    const deadline = Date.now() + CONNECT_POLL_LIMIT_MS;
    setLoading(true);
    try {
      while (!controller.signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CONNECT_POLL_INTERVAL_MS);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (controller.signal.aborted) return false;
        const next = await studioCloud.status(controller.signal);
        setStatus(next);
        if (next.state !== "connecting") {
          setError(next.state === "error" ? next.message : null);
          return next.state === "connected";
        }
      }
      if (!controller.signal.aborted) {
        setError("SimCloud did not confirm the sign-in in time. Try again.");
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(cloudErrorMessage(reason, "SimCloud connection status is unavailable."));
    } finally {
      if (poll.current === controller) {
        poll.current = null;
        setLoading(false);
      }
    }
    return false;
  }, []);

  const connect = useCallback(async (provider: StudioCloudProvider) => {
    setLoading(true);
    setError(null);
    try {
      const { authorizationUrl } = await studioCloud.connect({ provider });
      // The provider's page belongs to the provider and opens in the system
      // browser; the app itself never navigates away from the local origin.
      const opened = window.open(authorizationUrl, "_blank", "noopener,noreferrer");
      // The desktop shell opens the provider in the system browser, so a null
      // handle there is ordinary rather than a blocked pop-up. Ask the shell
      // directly: this used to test for the map-cache bridge, which answers a
      // different question and answered it wrongly in every Electron window
      // whose preload had not run.
      if (opened === null && !isDesktopShell()) {
        setError("Your browser blocked the sign-in window. Allow pop-ups for this app and try again.");
      }
      setStatus((current) =>
        current ? { ...current, state: "connecting", message: null } : current,
      );
      return await pollUntilSettled();
    } catch (reason) {
      setError(cloudErrorMessage(reason, "SimCloud sign-in could not be started."));
      setLoading(false);
      return false;
    }
  }, [pollUntilSettled]);

  /** Run one account request; a status answer replaces the current one. */
  const perform = useCallback(async <T,>(
    fallback: string,
    request: () => Promise<T>,
    apply?: (result: T) => void,
  ): Promise<T | null> => {
    poll.current?.abort();
    setLoading(true);
    setError(null);
    try {
      const result = await request();
      apply?.(result);
      return result;
    } catch (reason) {
      setError(cloudErrorMessage(reason, fallback));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const withStatus = useCallback(
    async (fallback: string, request: () => Promise<StudioCloudStatus>) =>
      (await perform(fallback, request, setStatus)) !== null,
    [perform],
  );

  const value = useMemo<StudioCloudConnection>(
    () => ({
      status,
      loading,
      error,
      accountPanelOpen,
      openAccountPanel: () => {
        setError(null);
        setAccountPanelOpen(true);
      },
      closeAccountPanel: () => setAccountPanelOpen(false),
      refresh,
      connect,
      signIn: (input) => {
        setAccountDeleted(null);
        return withStatus("Sign-in failed.", () => studioCloud.signIn(input));
      },
      signUp: (input) => {
        setAccountDeleted(null);
        return withStatus("The account could not be created.", () => studioCloud.signUp(input));
      },
      verifyEmail: (code) => withStatus("The code could not be checked.", () => studioCloud.verifyEmail({ code })),
      resendVerification: () => withStatus("A new code could not be sent.", () => studioCloud.resendVerification()),
      forgotPassword: async (email) => (await perform("The reset code could not be sent.", () => studioCloud.forgotPassword({ email }))) !== null,
      resetPassword: (input) => withStatus("The password could not be reset.", () => studioCloud.resetPassword(input)),
      changePassword: async (input) => (await perform("The password could not be changed.", () => studioCloud.changePassword(input))) !== null,
      updateAccount: (input) => perform("The profile could not be saved.", () => studioCloud.updateAccount(input), (account) => {
        setStatus((current) => current?.user ? { ...current, user: { ...current.user, name: account.user.name } } : current);
      }),
      revokeSession: async (id) => (await perform("The device could not be signed out.", () => studioCloud.revokeSession(id))) !== null,
      accountDeleted,
      deleteAccount: async (input) => {
        const deletion = await perform("The account could not be deleted.", async () => {
          const result = await studioCloud.deleteAccount(input);
          // The Cloud revoked every session in the same transaction and the
          // local service has already dropped the credential, so read the
          // now signed-out status rather than leaving the dashboard showing
          // an account that no longer exists.
          setStatus(await studioCloud.status());
          return result;
        });
        setAccountDeleted(deletion);
        return deletion !== null;
      },
      acceptInvitation: async (id) => (await perform("The invitation could not be accepted.", () => studioCloud.acceptInvitation(id))) !== null,
      declineInvitation: async (id) => (await perform("The invitation could not be declined.", () => studioCloud.declineInvitation(id))) !== null,
      acceptInvitationLink: async (token) => (await perform("The invite link could not be used.", () => studioCloud.acceptInvitationLink(token))) !== null,
      disconnect: () => withStatus("SimCloud could not be signed out.", () => studioCloud.disconnect()),
      account: loadAccount,
      listInvitations: loadInvitations,
      listOrganizations: loadOrganizations,
    }),
    [status, loading, error, accountPanelOpen, accountDeleted, refresh, connect, perform, withStatus],
  );

  return <StudioCloudContext.Provider value={value}>{children}</StudioCloudContext.Provider>;
}

export function useStudioCloudStatus(): StudioCloudConnection {
  const value = useContext(StudioCloudContext);
  if (!value) {
    throw new Error("useStudioCloudStatus() requires a <StudioCloudProvider> above the dashboard tree.");
  }
  return value;
}
