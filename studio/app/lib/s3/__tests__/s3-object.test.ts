import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { registerLocalFile as RegisterLocalFile } from "@/app/lib/s3/s3-object";

let root: string;
let registerLocalFile: typeof RegisterLocalFile;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "s3-object-"));
  process.env["SIMFORGE_CLOUD_ROOT"] = root;
  // Deferred import, not a static one: the module resolves its object root from the
  // environment at load time, so the temporary root must exist before it is loaded.
  ({ registerLocalFile } = await import("@/app/lib/s3/s3-object"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("registerLocalFile", () => {
  it("leaves no temporary links behind when the same content is registered twice", async () => {
    // Content-addressed keys mean re-registration is routine: seeding a map that is
    // already present registers every object again. The temporary link and the
    // committed object then resolve to one inode, and POSIX rename() is a no-op that
    // does NOT unlink its source, so each call used to leak a permanent link.
    const source = join(root, "source.bin");
    await writeFile(source, Buffer.alloc(1024, 7));

    const first = await registerLocalFile("maps", () => "objects/repeat.bin", source, "application/octet-stream");
    const second = await registerLocalFile("maps", () => "objects/repeat.bin", source, "application/octet-stream");

    assert.equal(second.checksumSha256Hex, first.checksumSha256Hex);
    assert.equal(second.sizeBytes, 1024);

    const entries = await readdir(join(root, "artifacts", "maps", "objects"));
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".tmp")),
      [],
      "registering the same object twice must not leave a .tmp link",
    );
    assert.ok(entries.includes("repeat.bin"), "the committed object must survive");
  });

  it("replaces an existing object whose content differs", async () => {
    const source = join(root, "changed.bin");
    await mkdir(join(root, "artifacts", "maps", "objects"), { recursive: true });
    await writeFile(source, Buffer.alloc(16, 1));
    await registerLocalFile("maps", () => "objects/changed.bin", source, "application/octet-stream");

    await writeFile(source, Buffer.alloc(32, 2));
    const replaced = await registerLocalFile("maps", () => "objects/changed.bin", source, "application/octet-stream");

    assert.equal(replaced.sizeBytes, 32);
    const entries = await readdir(join(root, "artifacts", "maps", "objects"));
    assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
  });
});
