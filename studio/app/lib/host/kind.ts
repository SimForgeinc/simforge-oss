/**
 * What kind of host this Studio process is.
 *
 * The local desktop service keeps its SimCloud credential in the OS vault
 * and primes it before cloud-asset work; a cloud host authenticates every
 * request itself and has no vault to open. A hosted deployment replaces this
 * module (the same way it replaces `host/capabilities.ts`) to declare
 * `"cloud"`, so the distinction is a declaration, never a guess from URLs.
 */
export const HOST_KIND: "local" | "cloud" = "local";
