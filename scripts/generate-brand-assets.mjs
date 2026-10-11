/**
 * Renders the static brand assets committed under `app/`.
 *
 * Source of truth is vector (`app/icon.svg`, `assets/brand/opengraph-image.svg`);
 * this only rasterises them so every viewer gets an identical image. Run with
 * `node scripts/generate-brand-assets.mjs` after editing a source SVG.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icon = await readFile(join(root, "app/icon.svg"));
const og = await readFile(join(root, "assets/brand/opengraph-image.svg"));

// Apple touch icon: opaque, no transparency, square.
await sharp(icon).resize(180, 180).png().toFile(join(root, "app/apple-icon.png"));

// Social preview (Open Graph + Twitter share the same 1200x630 canvas).
const social = await sharp(og).resize(1200, 630).png().toBuffer();
await writeFile(join(root, "app/opengraph-image.png"), social);
await writeFile(join(root, "app/twitter-image.png"), social);

/** Pack PNG buffers into a PNG-compressed .ico (ICO allows PNG entries). */
async function buildIco(sizes) {
  const pngs = await Promise.all(
    sizes.map((s) => sharp(icon).resize(s, s).png().toBuffer()),
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  pngs.forEach((png, i) => {
    const b = i * 16;
    dir.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], b);
    dir.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

await writeFile(join(root, "app/favicon.ico"), await buildIco([16, 32, 48]));

console.log("brand assets written");
