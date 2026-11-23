import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const { processStickerSheet } = await import(pathToFileURL(path.resolve(process.env.SEAMS_PROCESSOR_MODULE || 'sheet-processor/index.mjs')).href);
const colors = Array.from({ length: 12 }, (_, index) => [130 + index * 7, 20 + index * 3, 70 + index * 5]);

async function fixture(directory, variant = 'safe') {
  const shapes = [];
  for (let row = 0; row < 4; row++) for (let column = 0; column < 3; column++) {
    const index = row * 3 + column;
    if (variant === 'empty' && index === 10) continue;
    // A wide hand in the second row crosses the nominal x=300 line. Its entire
    // component still belongs to cell4, and a 20px corridor separates its neighbor.
    const shifted = row === 1;
    const left = column * 300 + (shifted && column === 1 ? 75 : 25);
    const right = column * 300 + (shifted && column === 0 ? 355 : 275);
    const top = row * 300 + 30, bottom = variant === 'clipped' && row === 3 ? 1200 : row * 300 + 270;
    shapes.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="rgb(${colors[index]})"/>`);
  }
  if (variant === 'fused') shapes.push('<rect x="280" y="450" width="120" height="30" fill="#884466"/>');
  // A separated dust pixel inside the 2px render crop is deliberately excluded
  // from component ownership (<4px), but copied by the legacy renderer. The
  // accounting mismatch must prevent downgrading the seam warning.
  if (variant === 'ownership-noise') shapes.push('<rect x="23" y="80" width="1" height="1" fill="#884466"/>');
  const inputPath = path.join(directory, 'sheet.png');
  await writeFile(inputPath, await sharp(Buffer.from(`<svg width="900" height="1200">${shapes.join('')}</svg>`)).png().toBuffer());
  return inputPath;
}

async function run(variant, check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seams-'));
  try {
    const outputDir = path.join(directory, 'out');
    const result = await processStickerSheet({ inputPath: await fixture(directory, variant), outputDir, layout: '3x4', strict: true });
    await check(result, outputDir);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('A non-straight gutter is advisory only after complete unique component ownership and pixel preservation', async () => {
  await run('safe', async (result, outputDir) => {
    assert.equal(result.status, 'ready', JSON.stringify(result.warnings));
    assert.equal(result.readyCount, 12);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.advisories.some(advisory => advisory.code === 'component-preserving-grid-seam' && advisory.axis === 'x' && advisory.minOpaqueCount > 0));
    assert.equal(result.diagnostics.componentOwnership.complete, true);
    assert.equal(result.diagnostics.componentOwnership.retainedComponentCount, 12);
    for (const [index, sticker] of result.stickers.entries()) {
      assert.equal(sticker.status, 'ready');
      const { data, info } = await sharp(await readFile(path.join(outputDir, sticker.path))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const center = (256 * info.width + 256) * 4;
      assert.deepEqual([...data.subarray(center, center + 3)], colors[index], `Cell${index + 1} must retain its own subject`);
      let opaque = 0;
      for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 16) opaque++;
      const expected = result.diagnostics.componentOwnership.renderedCellPixelCounts[index].expected;
      assert.equal(opaque, expected, 'No-upscale fixture must retain every source foreground pixel without a guillotine cut');
    }
  });
});

test('A seam stays blocking when exact renderer preservation accounting is incomplete', async () => {
  await run('ownership-noise', async result => {
    assert.equal(result.readyCount, 12, 'Cell-level readiness alone is insufficient');
    assert.equal(result.status, 'needs_review');
    assert.deepEqual(result.advisories, []);
    assert.equal(result.diagnostics.componentOwnership.complete, false);
    assert.ok(result.warnings.some(warning => warning.includes('не имеет сквозного прозрачного промежутка')));
  });
});

for (const variant of ['fused', 'clipped', 'empty']) {
  test(`Component seam advisory never accepts ${variant} subjects`, async () => {
    await run(variant, async result => {
      assert.notEqual(result.status, 'ready');
      assert.ok(result.stickers.some(sticker => sticker.status !== 'ready'));
      assert.deepEqual(result.advisories || [], []);
      if (variant === 'fused') assert.ok(result.warnings.some(warning => warning.includes('пересекается или сливается')));
      if (variant === 'clipped') assert.ok(result.warnings.some(warning => warning.includes('внешней границы листа')));
      if (variant === 'empty') assert.ok(result.errors.some(error => error.includes('пуста')));
    });
  });
}
