import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../');

function calculateTelegramDimensions(origW, origH, requireEven = false) {
  if (origW <= 0 || origH <= 0) return { width: 512, height: 512 };
  let width, height;
  if (origW >= origH) {
    width = 512;
    height = Math.max(1, Math.min(512, Math.round((origH / origW) * 512)));
  } else {
    height = 512;
    width = Math.max(1, Math.min(512, Math.round((origW / origH) * 512)));
  }
  if (requireEven) {
    if (width === 512) {
      height = Math.max(2, height & ~1);
    } else {
      width = Math.max(2, width & ~1);
    }
  }
  return { width, height };
}

test('calculateTelegramDimensions strictly guarantees max side is 512 px', () => {
  // Landscape
  const l1 = calculateTelegramDimensions(1200, 800);
  assert.equal(l1.width, 512);
  assert.equal(l1.height, 341);
  assert.equal(Math.max(l1.width, l1.height), 512);

  // Portrait
  const p1 = calculateTelegramDimensions(600, 900);
  assert.equal(p1.height, 512);
  assert.equal(p1.width, 341);
  assert.equal(Math.max(p1.width, p1.height), 512);

  // Square
  const s1 = calculateTelegramDimensions(1000, 1000);
  assert.deepEqual(s1, { width: 512, height: 512 });

  // Small image (must enlarge to 512px per Telegram requirement)
  const sm = calculateTelegramDimensions(300, 200);
  assert.equal(sm.width, 512);
  assert.equal(sm.height, 341);
  assert.equal(Math.max(sm.width, sm.height), 512);

  // 16:9 video sticker (even dimensions)
  const v169 = calculateTelegramDimensions(1280, 720, true);
  assert.equal(v169.width, 512);
  assert.equal(v169.height, 288);
  assert.equal(v169.height % 2, 0);

  // 9:16 video sticker (even dimensions)
  const v916 = calculateTelegramDimensions(720, 1280, true);
  assert.equal(v916.height, 512);
  assert.equal(v916.width, 288);
  assert.equal(v916.width % 2, 0);
});

test('WebP sticker generated from cutout adheres 100% to Telegram @Stickers specs', async () => {
  const samplePath = path.resolve(rootDir, 'public/bench/cells/v53_02.png');
  const metaBefore = await sharp(samplePath).metadata();
  assert.equal(metaBefore.width, 598);
  assert.equal(metaBefore.height, 600);

  const { width: targetW, height: targetH } = calculateTelegramDimensions(
    metaBefore.width,
    metaBefore.height
  );
  assert.equal(Math.max(targetW, targetH), 512);

  const webpBuffer = await sharp(samplePath)
    .resize(targetW, targetH)
    .webp({ quality: 92 })
    .toBuffer();

  // 1. Verify container magic bytes: RIFF....WEBP
  const riff = webpBuffer.subarray(0, 4).toString('ascii');
  const webp = webpBuffer.subarray(8, 12).toString('ascii');
  assert.equal(riff, 'RIFF', 'Magic header must start with RIFF');
  assert.equal(webp, 'WEBP', 'Header bytes 8-11 must be WEBP');

  // 2. Verify metadata
  const metaAfter = await sharp(webpBuffer).metadata();
  assert.equal(metaAfter.format, 'webp');
  assert.equal(metaAfter.hasAlpha, true, 'Sticker must retain alpha channel');
  assert.equal(Math.max(metaAfter.width, metaAfter.height), 512, 'One side must be strictly 512 px');
  assert.ok(metaAfter.width <= 512 && metaAfter.height <= 512, 'Other side must be <= 512 px');

  // 3. Verify file size <= 512 KB
  assert.ok(webpBuffer.length <= 512 * 1024, `Size ${webpBuffer.length} must be <= 512 KB`);
});

test('DJ Cat video sticker cell_17_tg_sticker.webm meets Telegram video sticker limits', () => {
  const webmPath = path.resolve(rootDir, 'public/bench/cells/cell_17_tg_sticker.webm');
  assert.ok(fs.existsSync(webmPath), 'DJ Cat webm must exist');

  const stats = fs.statSync(webmPath);
  assert.ok(
    stats.size <= 256 * 1024,
    `Video sticker size (${stats.size} bytes) must be <= 256 KB`
  );
});
