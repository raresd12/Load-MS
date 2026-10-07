// Builds the app icons (decision HV-4): public/icons/icon.svg,
// public/icons/icon-192.png and public/icons/icon-512.png.
//
// One geometry, on a 100 x 100 grid, feeds both the SVG and the PNGs: a flat
// #0a0a0f rounded square (corner radius 22 % of the size) with a centred
// #a78bfa barbell (a bar 6 % of the size tall and two plates on each side).
// No gradients, no text. The glyph stays inside the central 80 % circle, the
// safe zone of a maskable icon.
//
// The PNGs come from a tiny in-script rasteriser (4 x 4 supersampled
// coverage per pixel, so the edges are smooth) and the PNG encoder pattern of
// scripts/build-import-samples.mjs (crc32 + chunks), compressed with
// node:zlib. Deterministic: re-running writes byte-identical files.
//
// Run: node scripts/build-app-icons.mjs [outputDir]
// The output directory defaults to public/icons; verify-ui-hv-icons.mjs
// passes a temporary one and compares the result with the committed files.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const DEFAULT_ICON_DIR = fileURLToPath(new URL("../public/icons/", import.meta.url));

export const ICON_GEOMETRY = Object.freeze({
  grid: 100,
  background: "#0a0a0f",
  glyph: "#a78bfa",
  cornerRadius: 22,
  // x, y, width, height on the 100-unit grid.
  rects: Object.freeze([
    Object.freeze({ name: "bar", x: 16, y: 47, width: 68, height: 6 }),
    Object.freeze({ name: "inner plate left", x: 24, y: 30, width: 7, height: 40 }),
    Object.freeze({ name: "inner plate right", x: 69, y: 30, width: 7, height: 40 }),
    Object.freeze({ name: "outer plate left", x: 17, y: 36, width: 6, height: 28 }),
    Object.freeze({ name: "outer plate right", x: 77, y: 36, width: 6, height: 28 }),
  ]),
});

const SUPERSAMPLE = 4;

function hexToRgb(hex) {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
}

export function buildIconSvg(geometry = ICON_GEOMETRY) {
  const { grid, background, glyph, cornerRadius, rects } = geometry;
  const glyphRects = rects
    .map((rect) => `  <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${glyph}"/>`)
    .join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" role="img" aria-label="Load MS">`,
    `  <rect width="${grid}" height="${grid}" rx="${cornerRadius}" fill="${background}"/>`,
    glyphRects,
    "</svg>",
    "",
  ].join("\n");
}

function insideRoundedSquare(x, y, grid, radius) {
  if (x < 0 || y < 0 || x > grid || y > grid) {
    return false;
  }
  const cx = Math.min(Math.max(x, radius), grid - radius);
  const cy = Math.min(Math.max(y, radius), grid - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideGlyph(x, y, rects) {
  return rects.some((rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

// RGBA pixels, straight (not premultiplied) alpha.
export function rasteriseIcon(size, geometry = ICON_GEOMETRY) {
  const { grid, cornerRadius, rects } = geometry;
  const background = hexToRgb(geometry.background);
  const glyph = hexToRgb(geometry.glyph);
  const pixels = new Uint8Array(size * size * 4);
  const scale = grid / size;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      let glyphCovered = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * scale;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * scale;
          if (!insideRoundedSquare(x, y, grid, cornerRadius)) {
            continue;
          }
          covered += 1;
          if (insideGlyph(x, y, rects)) {
            glyphCovered += 1;
          }
        }
      }

      const offset = (py * size + px) * 4;
      if (covered === 0) {
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const sum = glyph[channel] * glyphCovered + background[channel] * (covered - glyphCovered);
        pixels[offset + channel] = Math.round(sum / covered);
      }
      pixels[offset + 3] = Math.round((255 * covered) / samples);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "latin1"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(size, rgba) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  // 8-bit RGBA, deflate, adaptive filtering method 0, no interlace.
  header.set([8, 6, 0, 0, 0], 8);

  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    // Filter type 0 (None) on every scanline.
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const chunks = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

export function buildAppIcons() {
  return new Map([
    ["icon.svg", Buffer.from(buildIconSvg(), "utf8")],
    ["icon-192.png", encodePng(192, rasteriseIcon(192))],
    ["icon-512.png", encodePng(512, rasteriseIcon(512))],
  ]);
}

if (process.argv[1]?.endsWith("build-app-icons.mjs")) {
  const outputDir = path.resolve(process.argv[2] ?? DEFAULT_ICON_DIR);
  mkdirSync(outputDir, { recursive: true });
  for (const [name, bytes] of buildAppIcons()) {
    writeFileSync(path.join(outputDir, name), bytes);
    console.log(`${path.join(outputDir, name)}: ${bytes.length} bytes`);
  }
}
