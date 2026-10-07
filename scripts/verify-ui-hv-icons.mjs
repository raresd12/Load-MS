import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

// Visual refresh, decision HV-4 (guarded here; HV-8 row in docs/decisions.md):
// the app icons are generated, not hand-edited. scripts/build-app-icons.mjs
// takes an output directory as its first argument (default public/icons),
// writes icon-192.png and icon-512.png deterministically, and the committed
// files are exactly what it produces: #0a0a0f (or transparent) corners, a
// #a78bfa glyph through the centre. The browser chrome colours match.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(root, "scripts/build-app-icons.mjs");
const SIZES = [192, 512];
const BG = [0x0a, 0x0a, 0x0f];
const ACCENT = [0xa7, 0x8b, 0xfa];

// Minimal PNG reader: 8-bit RGB / RGBA, non-interlaced, filters 0-4.
function decodePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...bytes.subarray(0, 8)], signature, "PNG signature");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.ok(header, "PNG has an IHDR chunk");
  assert.equal(header.bitDepth, 8, "8-bit channels");
  assert.ok(header.colorType === 6 || header.colorType === 2, `RGBA or RGB (colour type ${header.colorType})`);
  assert.equal(header.interlace, 0, "not interlaced");
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * header.height, "IDAT holds every scanline");
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    for (let index = 0; index < stride; index += 1) {
      const value = raw[row * (stride + 1) + 1 + index];
      const left = index >= channels ? pixels[row * stride + index - channels] : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= channels ? pixels[(row - 1) * stride + index - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else assert.equal(filter, 0, `known scanline filter (${filter})`);
      pixels[row * stride + index] = (value + predictor) & 0xff;
    }
  }
  const pixel = (x, y) => {
    const start = (y * header.width + x) * channels;
    return [...pixels.subarray(start, start + 3), channels === 4 ? pixels[start + 3] : 255];
  };
  return { ...header, pixel };
}

// ------------------------------------------------------------------
// Build into temp directories (twice: determinism) and compare
// ------------------------------------------------------------------
assert.ok(existsSync(builder), "scripts/build-app-icons.mjs exists (HV-4)");
assert.ok(
  /process\.argv\[2\]/.test(readFileSync(builder, "utf8")),
  "scripts/build-app-icons.mjs takes the output directory as its first argument (process.argv[2]); the fixture never lets it write into public/",
);

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), "load-ms-icons-"));
  const result = spawnSync(process.execPath, [builder, dir], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `build-app-icons.mjs exits 0 (${result.stderr || result.stdout})`);
  const files = Object.fromEntries(
    SIZES.map((size) => {
      const file = path.join(dir, `icon-${size}.png`);
      assert.ok(existsSync(file), `build-app-icons.mjs wrote icon-${size}.png into the directory it was given`);
      return [size, readFileSync(file)];
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  return files;
}

const first = build();
const second = build();
for (const size of SIZES) {
  assert.ok(first[size].equals(second[size]), `icon-${size}.png is byte-identical across two runs`);
  const committed = readFileSync(path.join(root, `public/icons/icon-${size}.png`));
  assert.ok(first[size].equals(committed), `public/icons/icon-${size}.png is exactly what build-app-icons.mjs produces (re-run it)`);

  const png = decodePng(first[size]);
  assert.equal(png.width, size, `icon-${size}.png is ${size} px wide`);
  assert.equal(png.height, size, `icon-${size}.png is ${size} px tall`);
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    const [r, g, b, a] = png.pixel(x, y);
    assert.ok(a === 0 || (a === 255 && r === BG[0] && g === BG[1] && b === BG[2]), `icon-${size}.png corner (${x}, ${y}) is transparent or #0a0a0f (found rgba(${r}, ${g}, ${b}, ${a}))`);
  }
  const centre = Math.floor(size / 2);
  assert.deepEqual(png.pixel(centre, centre), [...ACCENT, 255], `icon-${size}.png centre pixel is #a78bfa`);
}

// ------------------------------------------------------------------
// Browser chrome colours
// ------------------------------------------------------------------
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const themeColor = /<meta\s+name="theme-color"\s+content="([^"]+)"/i.exec(indexHtml)?.[1];
assert.equal(themeColor?.toLowerCase(), "#0a0a0f", "index.html theme-color is #0a0a0f");
const viteConfig = readFileSync(path.join(root, "vite.config.js"), "utf8");
for (const key of ["theme_color", "background_color"]) {
  const value = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`).exec(viteConfig)?.[1];
  assert.equal(value?.toLowerCase(), "#0a0a0f", `vite.config.js manifest ${key} is #0a0a0f`);
}

console.log(`UI HV icons verification passed (${SIZES.map((size) => `icon-${size}.png`).join(", ")} rebuilt byte for byte).`);
