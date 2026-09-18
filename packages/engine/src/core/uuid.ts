/**
 * Random identifiers that work without a secure context.
 *
 * `crypto.randomUUID` is secure-context-only. Verified in Chromium on
 * `http://asset-host.test:5481` (`isSecureContext === false`): `randomUUID` is
 * `undefined` there, exactly like `crypto.subtle`, while `getRandomValues`
 * remains available. Studio is normally reached over a LAN address or a
 * tunnelled host, so a bare `crypto.randomUUID()` throws "crypto.randomUUID is
 * not a function" on the user's own origin — and it does so in editor paths
 * (adding an actor, editing a sensor rig, submitting a render) where the only
 * requirement is uniqueness, never cryptographic ceremony.
 *
 * This module is a leaf: it imports nothing, so the browser-safe
 * `@simforge-oss/engine/uuid` subpath costs a caller nothing.
 */

const HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

/**
 * A RFC 9562 version-4 UUID, lowercase, from `crypto.getRandomValues`.
 *
 * Byte-for-byte the format `crypto.randomUUID` produces — same version and
 * variant bits — so a stored or transmitted id is indistinguishable from one
 * minted in a secure context.
 */
export function randomUuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i]!]!;
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}
