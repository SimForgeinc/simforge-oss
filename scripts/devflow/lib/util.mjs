// Small shared helpers for the devflow commands (verify, agent:env).
// Zero dependencies on purpose: these scripts must run before `install`.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_ROOT = process.env.DEVFLOW_CACHE_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "devflow");

/** `**` crosses directories, `*` and `?` do not, `{a,b}` alternates. A pattern ending in `/` matches everything below it. */
export function globToRegExp(pattern) {
  let p = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i += 1;
        if (p[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      out += `(?:${p.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    }
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** True when `file` matches a positive pattern and no `!negated` one. */
export function matchesAny(file, patterns = []) {
  const negative = patterns.filter((p) => p.startsWith("!")).map((p) => globToRegExp(p.slice(1)));
  if (negative.some((re) => re.test(file))) return false;
  return patterns.filter((p) => !p.startsWith("!")).some((pattern) => globToRegExp(pattern).test(file));
}

export function sh(bin, args, options = {}) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

export function trySh(bin, args, options = {}) {
  try {
    return sh(bin, args, options);
  } catch {
    return null;
  }
}

export function commandExists(bin) {
  return trySh("sh", ["-c", `command -v ${bin}`]) !== null;
}

/**
 * Runs a command with output captured to `logFile` (and optionally streamed).
 * Resolves { code, ms, tail } and never rejects on a non-zero exit.
 */
export function runLogged(bin, args, { cwd, env, logFile, stream = false, input } = {}) {
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile);
  log.write(`$ ${[bin, ...args].join(" ")}\n# cwd ${cwd}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    if (input) child.stdin.end(input);
    const onData = (chunk) => {
      log.write(chunk);
      if (stream) process.stderr.write(chunk);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      log.write(`\n[devflow] failed to start: ${error.message}\n`);
    });
    child.on("close", (code, signal) => {
      log.end(() => resolve({ code: code ?? (signal ? 128 : 1), ms: Date.now() - started, logFile }));
    });
  });
}

export function tail(file, lines = 40) {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").split("\n");
  return text.slice(-lines).join("\n");
}

export function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function withNodePath(env = process.env) {
  // Node 24 lives outside the default PATH on the dev boxes; carry the running node's dir.
  const nodeDir = dirname(process.execPath);
  const path = env.PATH || "";
  return path.split(":").includes(nodeDir) ? env : { ...env, PATH: `${nodeDir}:${path}` };
}
