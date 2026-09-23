import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The local host's PGlite directory must survive the ways a host really stops:
 * SIGKILL mid-write (OOM killer), SIGTERM (supervisor stop), and a second
 * process opening the same data root while the first is alive (which on
 * 2026-09-22 overwrote the live checkpoint and left a directory that only
 * `Aborted()` after the owner was killed).
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/pglite-writer.ts", import.meta.url));
const STUDIO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "simforge pglite crash-"));
  roots.push(root);
  return root;
}

type Child = { proc: ChildProcess; lines: string[]; stderr: string[]; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function run(root: string, mode: "write" | "read"): Child {
  const proc = spawn(process.execPath, ["--conditions=development", "--conditions=react-server", "--import", "tsx", FIXTURE, mode], {
    cwd: STUDIO_ROOT,
    env: { ...process.env, SIMFORGE_CLOUD_ROOT: root, DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const stderr: string[] = [];
  let buffered = "";
  proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
  });
  proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr.push(chunk); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { proc, lines, stderr, exited };
}

function lastCommitted(child: Child): number {
  for (let i = child.lines.length - 1; i >= 0; i -= 1) {
    const match = /^committed (\d+)$/.exec(child.lines[i]!);
    if (match) return Number(match[1]);
  }
  return 0;
}

async function waitForCommits(child: Child, count: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (lastCommitted(child) < count) {
    if (child.proc.exitCode !== null) assert.fail(`writer exited early: ${child.stderr.join("")}`);
    if (Date.now() > deadline) assert.fail(`writer did not reach ${count} commits: ${child.stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readBack(root: string): Promise<{ max: number; count: number }> {
  const reader = run(root, "read");
  const { code } = await reader.exited;
  assert.equal(code, 0, `reopen failed: ${reader.stderr.join("")}`);
  return JSON.parse(reader.lines.at(-1)!) as { max: number; count: number };
}

/** DBState from pg_control: 1 = shut down, 6 = in production. */
function clusterState(root: string): number {
  return readFileSync(join(root, "db", "global", "pg_control")).readInt32LE(16);
}

test("SIGKILL mid-write: the directory reopens with every acknowledged commit", { timeout: 300_000 }, async () => {
  const root = dataRoot();
  for (let round = 1; round <= 3; round += 1) {
    const writer = run(root, "write");
    await waitForCommits(writer, round * 40);
    writer.proc.kill("SIGKILL");
    await writer.exited;
    const acknowledged = lastCommitted(writer);
    assert.equal(clusterState(root), 6, "a killed owner leaves the cluster 'in production' for crash recovery");
    assert.ok(existsSync(join(root, "db.lock")), "the killed owner's lock is left behind");
    // The stale lock is reclaimed and crash recovery replays the WAL.
    const { max, count } = await readBack(root);
    // The kill can land between a commit and its acknowledgement, never before a commit.
    assert.ok(max === acknowledged || max === acknowledged + 1, `round ${round}: recovered ${max}, acknowledged ${acknowledged}`);
    assert.equal(count, max, "no gaps: every committed row survived");
    assert.equal(clusterState(root), 1, "the reader closed the recovered directory cleanly");
  }
});

test("a second process cannot open a data root another process holds", { timeout: 300_000 }, async () => {
  const root = dataRoot();
  const owner = run(root, "write");
  await waitForCommits(owner, 20);

  const intruder = run(root, "read");
  const { code } = await intruder.exited;
  assert.notEqual(code, 0, "the second open must fail");
  const message = intruder.stderr.join("");
  assert.match(message, /already open in another process: pid (\d+)/);
  assert.ok(message.includes(`pid ${owner.proc.pid}`), message);

  // The owner kept writing through the refused open, then dies uncleanly -
  // exactly the sequence that corrupted the 2026-09-22 directory.
  const before = lastCommitted(owner);
  await waitForCommits(owner, before + 20);
  owner.proc.kill("SIGKILL");
  await owner.exited;
  const acknowledged = lastCommitted(owner);

  const { max, count } = await readBack(root);
  assert.ok(max === acknowledged || max === acknowledged + 1, `recovered ${max}, acknowledged ${acknowledged}`);
  assert.equal(count, max);
});

test("SIGTERM closes the database cleanly and releases the lock", { timeout: 300_000 }, async () => {
  const root = dataRoot();
  const writer = run(root, "write");
  await waitForCommits(writer, 30);
  writer.proc.kill("SIGTERM");
  const { code, signal } = await writer.exited;
  assert.equal(signal, null, `killed by ${signal} before closing: ${writer.stderr.join("")}`);
  assert.equal(code, 0, writer.stderr.join(""));
  assert.equal(clusterState(root), 1, "pg_control records a clean shutdown");
  assert.equal(existsSync(join(root, "db.lock")), false);
  const { max, count } = await readBack(root);
  assert.ok(max >= lastCommitted(writer));
  assert.equal(count, max);
});
