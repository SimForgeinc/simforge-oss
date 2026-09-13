// Generates every desktop icon from desktop/build/icon.svg: the SimForge S
// mark in brand yellow (#E8E044, the landing page's --accent-brand) on the
// near-black background (#0a0a0c). Run from studio/ on macOS:
//   node desktop/build-icons.mjs
// Needs rsvg-convert (brew install librsvg) and iconutil (Xcode CLT).
//
// Two shapes come out of the one master, because platforms disagree on who
// draws the corners:
//   - icon.icns (macOS): the mark on Apple's 824px squircle centred in a
//     transparent 1024px canvas. macOS 26 composes legacy .icns icons itself;
//     a full-bleed opaque square gets inset on a light glass tray (the "white
//     border"), while this shape is masked and rimmed like a native icon.
//   - icon.ico (Windows) and icon.png (Linux, BrowserWindow icon, and the
//     electron-builder fallback): full-bleed rounded square, since nothing
//     else rounds the corners there.
// Outputs are committed so packaging never depends on this script.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "build");
const master = readFileSync(join(buildDir, "icon.svg"), "utf8");

/** The master carries both shapes; keep exactly one, with the mark sized to it. */
function variant(shape) {
  const drop = shape === "mac" ? "flat" : "mac";
  const svg = master.replace(new RegExp(`<rect[^>]*data-shape="${drop}"[^>]*/>\\s*`), "");
  // The mark is drawn for the 824px macOS squircle; grow it with the full-bleed square.
  return shape === "mac"
    ? svg
    : svg.replace("<g id=\"mark\">", `<g id="mark" transform="translate(512 512) scale(${1024 / 824}) translate(-512 -512)">`);
}

function rasterize(svgPath, size, out) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", out, svgPath]);
}

/** Icon directory + PNG entries; every modern Windows reads PNG-in-ICO. */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, e);
    dir.writeUInt8(size === 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

const work = mkdtempSync(join(tmpdir(), "simforge-icons-"));
try {
  const macSvg = join(work, "mac.svg");
  const flatSvg = join(work, "flat.svg");
  writeFileSync(macSvg, variant("mac"));
  writeFileSync(flatSvg, variant("flat"));

  // macOS: iconutil wants the fixed iconset naming.
  const iconset = join(work, "icon.iconset");
  execFileSync("mkdir", [iconset]);
  for (const base of [16, 32, 128, 256, 512]) {
    rasterize(macSvg, base, join(iconset, `icon_${base}x${base}.png`));
    rasterize(macSvg, base * 2, join(iconset, `icon_${base}x${base}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);

  // Windows.
  const pngs = [16, 24, 32, 48, 64, 128, 256].map((size) => {
    const out = join(work, `win-${size}.png`);
    rasterize(flatSvg, size, out);
    return { size, data: readFileSync(out) };
  });
  writeFileSync(join(buildDir, "icon.ico"), ico(pngs));

  // Linux, BrowserWindow, and the electron-builder fallback.
  rasterize(flatSvg, 1024, join(buildDir, "icon.png"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
