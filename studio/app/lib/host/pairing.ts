import { randomBytes } from "node:crypto";

/**
 * Pairing codes: how a desktop shell on another machine obtains this host's
 * control token without anyone pasting the token. `simforge host pair` (a
 * native caller holding the token) mints a code; the shell exchanges it once
 * through the same route. The code is short enough to read aloud, lives a few
 * minutes, and dies on first use whether or not the exchange succeeded.
 *
 * Guessing is bounded twice: 8 symbols from a 32-symbol alphabet is 40 bits,
 * and a burst of failed claims wipes every outstanding code, so an attacker on
 * the link gets a handful of guesses per code the operator mints, not a
 * window. The token itself only ever leaves in a response body, never a URL.
 */
export const PAIRING_CODE_LIFETIME_MS = 5 * 60_000;
const PAIRING_CODE_LENGTH = 8;
/** Unambiguous: no 0/O, 1/I. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_OUTSTANDING = 8;
const MAX_FAILED_CLAIMS = 5;

type Pending = { expiresAt: number };

export type PairingStore = {
  /** A fresh code, or null when too many codes are outstanding. */
  mint(now?: number): { code: string; expiresAt: number } | null;
  /** Consumes the code. True once, for a live code; false for anything else. */
  claim(presented: string, now?: number): boolean;
  /** Outstanding live codes, for tests and status. */
  size(now?: number): number;
};

/** The comparison form: codes are shown grouped (`ABCD-EFGH`) and typed loosely. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `ABCD-EFGH`: the display form of a code. */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function createPairingStore(): PairingStore {
  const pending = new Map<string, Pending>();
  let failedClaims = 0;
  const sweep = (now: number) => {
    for (const [code, entry] of pending) if (entry.expiresAt <= now) pending.delete(code);
  };
  return {
    mint(now = Date.now()) {
      sweep(now);
      if (pending.size >= MAX_OUTSTANDING) return null;
      let code = "";
      for (const byte of randomBytes(PAIRING_CODE_LENGTH)) code += ALPHABET.charAt(byte % ALPHABET.length);
      const expiresAt = now + PAIRING_CODE_LIFETIME_MS;
      pending.set(code, { expiresAt });
      failedClaims = 0;
      return { code, expiresAt };
    },
    claim(presented, now = Date.now()) {
      sweep(now);
      const code = normalizePairingCode(presented);
      const entry = pending.get(code);
      pending.delete(code);
      if (entry !== undefined) {
        failedClaims = 0;
        return true;
      }
      failedClaims += 1;
      if (failedClaims >= MAX_FAILED_CLAIMS) {
        pending.clear();
        failedClaims = 0;
      }
      return false;
    },
    size(now = Date.now()) {
      sweep(now);
      return pending.size;
    },
  };
}
