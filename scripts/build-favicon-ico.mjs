#!/usr/bin/env node
/**
 * Bundle the existing favicon PNGs into a multi resolution favicon.ico.
 *
 * The supplied favicon.ico held a single 16x16 image despite the branding
 * package describing it as a 16/32/48/64 bundle, so it rendered soft anywhere
 * a browser wanted a larger size. This packages the PNGs that were already
 * final, at their native sizes. Nothing is resized or redrawn: each entry is
 * the source PNG byte for byte.
 *
 * Run after changing any of the source PNGs:
 *   npm run build:favicon
 *
 * ICO layout, for the next person:
 *   ICONDIR       6 bytes   reserved, type, image count
 *   ICONDIRENTRY  16 bytes  once per image, ending in size and offset
 *   image data              the PNG files, concatenated
 *
 * PNG payloads inside an ICO are understood by every browser in use. The
 * alternative, a BMP payload, needs its own header rewritten per entry and an
 * inverted alpha mask, which is a lot of surface area to get wrong for no gain.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'public', 'icons');
const outFile = join(here, '..', 'public', 'favicon.ico');

const SIZES = [16, 32, 48, 64];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const images = SIZES.map((size) => {
  const path = join(iconsDir, `favicon-${size}.png`);
  const data = readFileSync(path);

  if (!data.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`${path} is not a PNG`);
  }
  // The IHDR width and height sit at bytes 16 to 24, big endian. Read them
  // rather than trusting the filename, so a mislabelled file fails here
  // instead of producing an ICO that lies about its contents.
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`${path} declares ${width}x${height}, expected ${size}x${size}`);
  }
  return { size, data };
});

const HEADER = 6;
const ENTRY = 16;
const dataOffsetBase = HEADER + ENTRY * images.length;

const header = Buffer.alloc(HEADER);
header.writeUInt16LE(0, 0); // reserved, always zero
header.writeUInt16LE(1, 2); // 1 is icon, 2 would be cursor
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = dataOffsetBase;

for (const image of images) {
  const entry = Buffer.alloc(ENTRY);
  // 256 would be written as 0 here. Nothing in this set is that large.
  entry.writeUInt8(image.size, 0);
  entry.writeUInt8(image.size, 1);
  entry.writeUInt8(0, 2); // palette size, 0 for truecolour
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel, these are 8 bit RGBA
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += image.data.length;
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
writeFileSync(outFile, ico);

console.log(`favicon.ico written with ${images.length} images`);
for (const image of images) {
  console.log(`  ${image.size}x${image.size}  ${image.data.length} bytes`);
}
console.log(`  total ${ico.length} bytes`);
