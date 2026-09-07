import { completeCloudCallback } from "@/app/lib/cloud/connection";
import { invalidateUpstreamCatalog } from "@/app/lib/cloud/maps";

/**
 * Loopback landing page for the system browser. Protected by the one pending
 * random state and PKCE verifier held by the local service; the code is
 * exchanged server-side and never shown. The page is self-contained: the
 * renderer learns the outcome by polling status, not through this tab.
 */

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)} · SimForge Studio</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1116;color:#f4f7f8;font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem;border:1px solid #1f2b35;border-radius:12px;background:#111a22}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#b9c4cc}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

export async function GET(request: Request) {
  const result = await completeCloudCallback(new URL(request.url).searchParams);
  if (result.ok) {
    invalidateUpstreamCatalog();
    return page(
      "Connected to SimCloud",
      `SimForge Studio is signed in${result.user.email ? ` as ${result.user.email}` : ""}. You can close this tab and return to Studio.`,
      200,
    );
  }
  const detail = result.error === "callback_state_mismatch"
    ? "This sign-in link is not the one Studio is waiting for, or it has expired. Return to Studio and connect again."
    : result.error === "access_denied"
      ? "You declined the connection. Studio remains local-only; you can connect again at any time."
      : `Studio could not complete the sign-in (${result.error}). Return to Studio and try again.`;
  return page("Sign-in not completed", detail, result.error === "callback_state_mismatch" ? 400 : 200);
}
