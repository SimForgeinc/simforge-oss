/**
 * Bounded, secret-scrubbed process log tails for job failure records.
 *
 * A crashed engine process leaves its explanation on stderr. The worker
 * forwards the last lines into the job's failure detail, which users see, so
 * everything that looks like a credential is redacted before the text leaves
 * the worker: URL query strings (presigned URLs carry signatures and session
 * tokens), URL userinfo, authorization headers, bearer tokens, `key=value`
 * pairs whose key names a secret, AWS access key ids, JWTs and PEM keys.
 */

const REDACTED = '[redacted]';

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature|session|cookie)[A-Za-z0-9_.-]*`;

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, `${REDACTED}-private-key`],
  // Userinfo before the query rule so `https://user:pass@host/?q` loses both.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]*@/giu, `$1${REDACTED}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/giu, `$1?${REDACTED}`],
  // Also matches the `Proxy-Authorization` header (the word ends the name).
  [/\b([a-z-]*authorization)(["']?\s*[:=]\s*)[^\n]*/giu, `$1$2${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${REDACTED}`],
  [new RegExp(String.raw`(["']?)(${SECRET_KEY})\1(\s*[:=]\s*)(["']?)[^\s"',;&}\]]+`, 'giu'), `$1$2$1$3$4${REDACTED}`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, `${REDACTED}-aws-access-key`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, `${REDACTED}-jwt`],
];

/** `text` with everything that looks like a credential replaced by `[redacted]`. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of RULES) scrubbed = scrubbed.replace(pattern, replacement);
  return scrubbed;
}

export interface LogTailOptions {
  /** At most this many trailing non-empty lines. */
  readonly maxLines?: number;
  /** At most this many characters; the head of the tail is dropped first. */
  readonly maxChars?: number;
  /**
   * The captured text starts mid-stream (its head was dropped by a capture
   * buffer), so its first line is partial and is dropped: a partial line can
   * hold the tail of a secret the scrubber no longer recognises.
   */
  readonly truncatedHead?: boolean;
}

/** The last lines of a process log, ANSI-free, secret-scrubbed and bounded. */
export function scrubbedLogTail(
  text: string,
  { maxLines = 20, maxChars = 1_200, truncatedHead = false }: LogTailOptions = {},
): string {
  // eslint-disable-next-line no-control-regex
  let lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '').split(/\r?\n/u);
  if (truncatedHead) lines = lines.slice(1);
  const kept = scrubSecrets(lines.filter((line) => line.trim().length > 0).slice(-maxLines).join('\n'));
  if (kept.length <= maxChars) return kept;
  const cut = kept.slice(kept.length - maxChars);
  // Start on a whole line when there is one inside the bound.
  const newline = cut.indexOf('\n');
  return `…${newline >= 0 && newline < cut.length - 1 ? cut.slice(newline) : cut}`;
}
