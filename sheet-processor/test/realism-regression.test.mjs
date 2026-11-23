import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

// The optional module override demonstrates the regression against the captured production processor.
const { processStickerSheet } = await import(pathToFileURL(path.resolve(process.env.REALISM_PROCESSOR_MODULE || 'sheet-processor/index.mjs')).href);
const colors = Array.from({ length: 12 }, (_, index) => ({ r: 137 + index * 7, g: 23 + index * 3, b: 95 + index * 5 }));
const testRoot = path.resolve('output/realism-v16/regression-temp');
await mkdir(testRoot, { recursive: true });

async function unevenRowsFixture(destination, touchBottom = false) {
  // Same drift pattern as the saved mountains sheet: first two boundaries28% below the nominal grid.
  // Every subject remains physically separated by16px green corridors; no source photographs are embedded.
  const cuts = [0, 384, 684, 936, 1200], shapes = [];
  for (let row = 0; row < 4; row++) for (let column = 0; column < 3; column++) {
    const index = row * 3 + column, color = colors[index];
    const top = cuts[row] + 8, bottom = touchBottom && row === 3 ? 1200 : cuts[row + 1] - 8;
    shapes.push(`<rect x="${column * 300 + 24}" y="${top}" width="252" height="${bottom - top}" fill="rgb(${color.r},${color.g},${color.b})"/>`);
  }
  const buffer = await sharp(Buffer.from(`<svg width="900" height="1200"><rect width="900" height="1200" fill="#00FF00"/>${shapes.join('')}</svg>`))
    .flatten({ background: '#00FF00' }).png().toBuffer();
  const inputPath = path.join(destination, touchBottom ? 'uneven-clipped.png' : 'uneven-safe.png');
  await writeFile(inputPath, buffer);
  return inputPath;
}

test('Unequal3x4 rows beyond the nominal16% search window keep twelve isolated subjects in row-major order', async () => {
  const directory = await mkdtemp(path.join(testRoot, 'unequal-'));
  try {
    const inputPath = await unevenRowsFixture(directory), outputDir = path.join(directory, 'processed');
    const result = await processStickerSheet({ inputPath, outputDir, layout: '3x4', backgroundColor: '#00FF00', strict: true });
    assert.equal(result.status, 'ready', JSON.stringify(result.warnings));
    assert.equal(result.readyCount, 12); assert.deepEqual(result.errors, []);
    for (const [index, sticker] of result.stickers.entries()) {
      assert.equal(sticker.index, index + 1); assert.equal(sticker.status, 'ready');
      const buffer = await readFile(path.join(outputDir, sticker.path));
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 512); assert.equal(info.height, 512);
      const center = (256 * info.width + 256) * info.channels, color = colors[index];
      assert.equal(data[center + 3], 255, 'The subject must remain present and opaque');
      for (const [offset, channel] of ['r', 'g', 'b'].entries()) assert.ok(Math.abs(data[center + offset] - color[channel]) <= 2, `Cell${index + 1} must contain its own subject, not a duplicated neighbor`);
      assert.equal(data[3], 0); assert.equal(data[(511 * 512 + 511) * info.channels + 3], 0);
    }
  } finally { assert.equal(path.dirname(directory), testRoot); await rm(directory, { recursive: true, force: true }); }
});

test('Adaptive row recovery retains the strict outer-border rejection for genuinely clipped bottom subjects', async () => {
  const directory = await mkdtemp(path.join(testRoot, 'clipped-'));
  try {
    await mkdir(directory, { recursive: true });
    const inputPath = await unevenRowsFixture(directory, true);
    const result = await processStickerSheet({ inputPath, outputDir: path.join(directory, 'processed'), layout: '3x4', backgroundColor: '#00FF00', strict: true });
    assert.notEqual(result.status, 'ready', 'Transparent output padding cannot repair pixels missing from the source');
    for (const sticker of result.stickers.slice(9)) {
      assert.notEqual(sticker.status, 'ready');
      assert.ok(sticker.warnings.some(warning => warning.includes('внешней границы листа')), 'Original border clipping must stay explicit');
    }
  } finally { assert.equal(path.dirname(directory), testRoot); await rm(directory, { recursive: true, force: true }); }
});
