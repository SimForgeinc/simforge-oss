import { createRequire } from "node:module";
import { _electron, chromium, type Browser, type BrowserContext, type ElectronApplication, type Page, type Response } from "@playwright/test";
import { readLocalHostState, waitForLocalHostReady } from "../../packages/studio-host/src/node/local-host-state";
import type { E2eContext } from "./context";
import { E2E_ENV, envValue, type E2eMode, type HostMode } from "./env";
import { requestBrowserTicketUrl, startLocalHost, type LocalHost } from "./host";
import { STUDIO_ROOT } from "./paths";
import { PREREQUISITES, requirePrerequisites } from "./prerequisites";

/** The default landing route: Studio's scenario dashboard. */
export const DEFAULT_ROUTE = "/dashboard/scenario";

/**
 * A running Studio a test can drive: the page, the origin, and the
 * native-caller escape hatch (`api`) for asserting server state without going
 * through the UI. Both launch modes expose the same shape, so a flow suite is
 * written once and runs in browser or Electron mode.
 */
export type StudioSession = {
  readonly mode: E2eMode;
  readonly baseUrl: string;
  /** The supervisor's per-start control token; `api` presents it as a bearer. */
  readonly controlToken: string;
  readonly page: Page;
  /** Present only when this harness started the supervisor itself (browser mode). */
  readonly host: LocalHost | null;
  /** The Electron application handle in `electron` mode. */
  readonly electron: ElectronApplication | null;
  url(path: string): string;
  goto(path: string): Promise<Response | null>;
  api<T>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
};

export type LaunchBrowserStudioOptions = {
  route?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Start the interactive CPU worker with the host. */
  worker?: boolean;
  hostMode?: HostMode;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
};

export type LaunchElectronStudioOptions = {
  route?: string;
  /** A packaged desktop binary; defaults to the workspace Electron running `studio/`. */
  executablePath?: string;
  args?: string[];
  env?: Record<string, string>;
  readyTimeoutMs?: number;
};

function sessionApi(baseUrl: string, controlToken: string) {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${controlToken}`);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(new URL(path, baseUrl), { ...init, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

/**
 * Browser mode: start the real supervisor against the isolated data root,
 * bootstrap a trusted-local session through the production ticket route, and
 * hand back the page sitting on `route`.
 */
export async function launchBrowserStudio(
  context: E2eContext,
  options: LaunchBrowserStudioOptions = {},
): Promise<StudioSession> {
  const host = await startLocalHost(context, {
    hostMode: options.hostMode,
    worker: options.worker,
    env: options.env,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  context.register(() => host.stop());
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? envValue(E2E_ENV.headed) !== "1" });
    context.register(() => browser?.close());
    browserContext = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 } });
    const page = await browserContext.newPage();
    const route = options.route ?? DEFAULT_ROUTE;
    // The ticket URL's loopback hostname is the origin that receives the
    // HttpOnly trusted-local cookie; retain that origin for every later page
    // navigation instead of switching between localhost and 127.0.0.1.
    const ticketUrl = await requestBrowserTicketUrl(host, route);
    const sessionBaseUrl = new URL(ticketUrl).origin;
    await page.goto(ticketUrl, { waitUntil: "domcontentloaded" });
    const session: StudioSession = {
      mode: "browser",
      baseUrl: sessionBaseUrl,
      controlToken: host.controlToken,
      page,
      host,
      electron: null,
      url: (path) => new URL(path, sessionBaseUrl).href,
      goto: (path) => page.goto(new URL(path, sessionBaseUrl).href, { waitUntil: "domcontentloaded" }),
      api: sessionApi(sessionBaseUrl, host.controlToken),
      async close() {
        await browserContext?.close();
        await browser?.close();
        await host.stop();
      },
    };
    return session;
  } catch (error) {
    await browserContext?.close();
    await browser?.close();
    await host.stop();
    throw error;
  }
}

const require = createRequire(import.meta.url);

/** The workspace Electron executable Studio's own `pnpm desktop` uses. */
function workspaceElectronBinary(): string {
  const resolved: unknown = require(require.resolve("electron", { paths: [STUDIO_ROOT] }));
  if (typeof resolved !== "string") throw new Error("The workspace electron package did not resolve to an executable path");
  return resolved;
}

/**
 * Electron mode: the desktop shell starts its own supervisor against the
 * isolated data root and sets the trusted session on its renderer itself, so
 * the harness only waits for `host.json` and the readiness probe.
 */
export async function launchElectronStudio(
  context: E2eContext,
  options: LaunchElectronStudioOptions = {},
): Promise<StudioSession> {
  const packaged = options.executablePath ?? envValue(E2E_ENV.electronBinary);
  if (options.executablePath === undefined && envValue(E2E_ENV.electronBinary) !== undefined) {
    // A configured packaged binary must actually exist before we launch it.
    await requirePrerequisites(context, [PREREQUISITES.packagedApp]);
  }
  const executablePath = packaged ?? workspaceElectronBinary();
  const args = options.args ?? (packaged ? [] : [STUDIO_ROOT]);
  const app = await _electron.launch({
    executablePath,
    args,
    cwd: STUDIO_ROOT,
    env: { ...process.env, ...context.env, ...options.env } as Record<string, string>,
  });
  context.register(() => app.close());
  try {
    const page = await app.firstWindow();
    const deadline = Date.now() + (options.readyTimeoutMs ?? 300_000);
    let state = await readLocalHostState({ SIMFORGE_CLOUD_ROOT: context.dataRoot });
    while (state === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      state = await readLocalHostState({ SIMFORGE_CLOUD_ROOT: context.dataRoot });
    }
    if (state === null) throw new Error(`The desktop shell never published host.json under ${context.dataRoot}`);
    const ready = await waitForLocalHostReady(state.baseUrl, {
      timeoutMs: Math.max(1_000, deadline - Date.now()),
      headers: { authorization: `Bearer ${state.controlToken}` },
    });
    if (!ready) throw new Error(`Desktop Studio host at ${state.baseUrl} never became ready`);
    if (options.route !== undefined) {
      await page.goto(new URL(options.route, state.baseUrl).href, { waitUntil: "domcontentloaded" });
    }
    const session: StudioSession = {
      mode: "electron",
      baseUrl: state.baseUrl,
      controlToken: state.controlToken,
      page,
      host: null,
      electron: app,
      url: (path) => new URL(path, state.baseUrl).href,
      goto: (path) => page.goto(new URL(path, state.baseUrl).href, { waitUntil: "domcontentloaded" }),
      api: sessionApi(state.baseUrl, state.controlToken),
      close: () => app.close(),
    };
    return session;
  } catch (error) {
    await app.close();
    throw error;
  }
}

/** Launch whichever mode the context selected. */
export async function launchStudio(
  context: E2eContext,
  options: LaunchBrowserStudioOptions & LaunchElectronStudioOptions = {},
): Promise<StudioSession> {
  return context.mode === "electron" ? launchElectronStudio(context, options) : launchBrowserStudio(context, options);
}
