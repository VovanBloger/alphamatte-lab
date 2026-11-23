import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { processStickerSheet, parseHexColor } from '../index.mjs';
import { generateTestStickerSheet, buildCharacterSvg, compositeStickerOnSolid } from './fixtures-helper.mjs';

let tmpRoot;

test.before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-sheet-tests-'));
});

test.after(async () => {
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * Helper to inspect alpha and RGB at a relative coordinate inside an extracted 512x512 sticker
 * or inside sheet-transparent.png.
 */
async function readRawRgba(filePath) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    pixelAt(x, y) {
      const ix = Math.max(0, Math.min(info.width - 1, Math.round(x)));
      const iy = Math.max(0, Math.min(info.height - 1, Math.round(y)));
      const off = (iy * info.width + ix) * 4;
      return {
        r: data[off],
        g: data[off + 1],
        b: data[off + 2],
        a: data[off + 3],
      };
    },
  };
}

test('1. 3x3 (9 stickers) and 3x4 (12 stickers) layouts on ideal #00FF00 background + row-major order + 512x512 RGBA PNG <= 512KB', async () => {
  for (const [layout, expectedCount] of [
    ['3x3', 9],
    ['3x4', 12],
  ]) {
    const dir = path.join(tmpRoot, `case1-${layout}`);
    await fs.mkdir(dir, { recursive: true });
    const inputPath = path.join(dir, 'sheet.png');
    const outputDir = path.join(dir, 'processed');

    const sheetBuf = await generateTestStickerSheet({
      width: 1536,
      height: layout === '3x4' ? 2048 : 1536,
      layout,
      bgHex: '#00FF00',
      format: 'png',
    });
    await fs.writeFile(inputPath, sheetBuf);

    const res = await processStickerSheet({
      version: 1,
      inputPath,
      outputDir,
      layout,
      backgroundColor: '#00FF00',
      outputSize: 512,
      padding: 24,
      strict: true,
      debug: true,
    });

    assert.equal(res.status, 'ready');
    assert.equal(res.layout, layout);
    assert.equal(res.expectedCount, expectedCount);
    assert.equal(res.readyCount, expectedCount);
    assert.equal(res.stickers.length, expectedCount);
    assert.equal(res.errors.length, 0);

    // Check required artifacts
    await fs.access(path.join(outputDir, 'sheet-transparent.png'));
    await fs.access(path.join(outputDir, 'preview.png'));
    await fs.access(path.join(outputDir, 'manifest.json'));
    await fs.access(path.join(outputDir, 'debug', 'background-mask.png'));
    await fs.access(path.join(outputDir, 'debug', 'alpha-mask.png'));
    await fs.access(path.join(outputDir, 'debug', 'grid-overlay.png'));

    // Verify each sticker file, dimensions, size limit, transparent padding, and row-major order
    const cols = 3;
    for (let i = 0; i < expectedCount; i++) {
      const s = res.stickers[i];
      const expectedIdx = i + 1;
      assert.equal(s.index, expectedIdx);
      assert.equal(s.row, Math.floor(i / cols));
      assert.equal(s.column, i % cols);
      assert.equal(s.status, 'ready');
      assert.equal(s.path, `stickers/${String(expectedIdx).padStart(2, '0')}.png`);
      assert.equal(s.width, 512);
      assert.equal(s.height, 512);
      assert.ok(s.bytes > 0 && s.bytes <= 512 * 1024, `Sticker ${s.path} exceeds 512KB: ${s.bytes}`);

      const stickerAbs = path.join(outputDir, s.path);
      const img = await readRawRgba(stickerAbs);
      assert.equal(img.width, 512);
      assert.equal(img.height, 512);

      // Corners must be 100% transparent (no checkerboard in final sticker PNGs!)
      assert.equal(img.pixelAt(0, 0).a, 0);
      assert.equal(img.pixelAt(511, 0).a, 0);
      assert.equal(img.pixelAt(0, 511).a, 0);
      assert.equal(img.pixelAt(511, 511).a, 0);

      // Verify configurable padding (24px) is respected on all 4 sides
      for (let p = 0; p < 22; p++) {
        assert.equal(img.pixelAt(256, p).a, 0, `Top padding violated at y=${p}`);
        assert.equal(img.pixelAt(256, 511 - p).a, 0, `Bottom padding violated at y=${511 - p}`);
        assert.equal(img.pixelAt(p, 256).a, 0, `Left padding violated at x=${p}`);
        assert.equal(img.pixelAt(511 - p, 256).a, 0, `Right padding violated at x=${511 - p}`);
      }
    }
  }
});

test('2. Noisy JPEG with compression artifacts, uneven lighting, and alternative chroma colors (#FF00FF magenta, #0000FF blue, WebP)', async () => {
  // 2A: Noisy JPEG quality=68 with uneven green gradient
  const dirJpg = path.join(tmpRoot, 'case2-noisy-jpg');
  await fs.mkdir(dirJpg, { recursive: true });
  const jpgPath = path.join(dirJpg, 'sheet.jpg');
  const jpgOut = path.join(dirJpg, 'processed');

  const jpgBuf = await generateTestStickerSheet({
    width: 1536,
    height: 1536,
    layout: '3x3',
    bgHex: '#00FF00',
    format: 'jpeg',
    jpegQuality: 68,
    gradientNoise: true,
  });
  await fs.writeFile(jpgPath, jpgBuf);

  const resJpg = await processStickerSheet({
    inputPath: jpgPath,
    outputDir: jpgOut,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });
  assert.equal(resJpg.status, 'ready');
  assert.equal(resJpg.readyCount, 9);

  // Verify edge quality on white, black, and colored backgrounds
  const sticker1Path = path.join(jpgOut, 'stickers', '01.png');
  const onWhite = await compositeStickerOnSolid(sticker1Path, { r: 255, g: 255, b: 255 });
  const onBlack = await compositeStickerOnSolid(sticker1Path, { r: 0, g: 0, b: 0 });
  const onColor = await compositeStickerOnSolid(sticker1Path, { r: 108, g: 92, b: 231 });

  assert.ok(onWhite.semiTransparentEdgePixels > 50, 'Should have smooth anti-aliased edge pixels');
  assert.equal(onWhite.pureGreenHaloPixels, 0, 'Should have zero neon green halo pixels on white background');
  assert.equal(onBlack.pureGreenHaloPixels, 0, 'Should have zero neon green halo pixels on black background');
  assert.equal(onColor.pureGreenHaloPixels, 0, 'Should have zero neon green halo pixels on colored background');

  // 2B: Magenta (#FF00FF) WebP and Blue (#0000FF) PNG
  for (const [bgColor, format] of [
    ['#FF00FF', 'webp'],
    ['#0000FF', 'png'],
  ]) {
    const subDir = path.join(tmpRoot, `case2-${bgColor.slice(1)}-${format}`);
    await fs.mkdir(subDir, { recursive: true });
    const inFile = path.join(subDir, `sheet.${format}`);
    const outDir = path.join(subDir, 'processed');
    const buf = await generateTestStickerSheet({
      width: 1200,
      height: 1200,
      layout: '3x3',
      bgHex: bgColor,
      format,
    });
    await fs.writeFile(inFile, buf);
    const res = await processStickerSheet({
      inputPath: inFile,
      outputDir: outDir,
      layout: '3x3',
      backgroundColor: bgColor,
    });
    assert.equal(res.status, 'ready');
    assert.equal(res.readyCount, 9);
  }
});

test('3. Preservation of green eyes, green clothing, white die-cut outline, fine whiskers, detached hearts, AND removal of enclosed limb holes', async () => {
  const dir = path.join(tmpRoot, 'case3-preservation');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');

  const width = 1536;
  const height = 1536;
  const sheetBuf = await generateTestStickerSheet({
    width,
    height,
    layout: '3x3',
    bgHex: '#00FF00',
    format: 'png',
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
    debug: true,
  });
  assert.equal(res.status, 'ready');

  const sheetImg = await readRawRgba(path.join(outputDir, 'sheet-transparent.png'));
  const cellW = width / 3;
  const cellH = height / 3;
  const scale = Math.min(cellW, cellH) / 340;
  const cx = 0.5 * cellW;
  const cy = 0.5 * cellH;

  // 1) Green eye iris at (cx - 24*scale, cy - 26*scale) + offset (+6*scale, 0) away from pupil
  const eyePixel = sheetImg.pixelAt(cx - 24 * scale + 7.5 * scale, cy - 26 * scale);
  assert.equal(eyePixel.a, 255, 'Green eye iris must remain 100% opaque (alpha=255)');
  assert.ok(eyePixel.g > 180 && eyePixel.g > eyePixel.r + 80, `Green eye must retain green color, got RGB(${eyePixel.r},${eyePixel.g},${eyePixel.b})`);

  // 2) Green hoodie at (cx - 35*scale, cy + 70*scale) (next to chest badge)
  const shirtPixel = sheetImg.pixelAt(cx - 35 * scale, cy + 70 * scale);
  assert.equal(shirtPixel.a, 255, 'Green hoodie/clothing must remain 100% opaque (alpha=255)');
  assert.ok(shirtPixel.g > 150 && shirtPixel.g > shirtPixel.r + 60, `Green hoodie must retain green color, got RGB(${shirtPixel.r},${shirtPixel.g},${shirtPixel.b})`);

  // 3) Enclosed background hole inside bent left arm loop at (cx - 78*scale, cy + 66*scale)
  const holePixel = sheetImg.pixelAt(cx - 78 * scale, cy + 66 * scale);
  assert.equal(holePixel.a, 0, 'Enclosed background hole between arm and torso MUST be cleared to alpha=0');

  // 4) Detached floating heart at (cx - 95*scale, cy - 102*scale + 18*scale)
  const heartPixel = sheetImg.pixelAt(cx - 95 * scale, cy - 84 * scale);
  assert.equal(heartPixel.a, 255, 'Detached floating heart in the cell must be preserved');
  assert.ok(heartPixel.r > 200, 'Floating heart must keep its red/pink color');

  // 5) Fine cat whiskers at (cx - 95*scale, cy - 8*scale)
  const whiskerPixel = sheetImg.pixelAt(cx - 95 * scale, cy - 8 * scale);
  assert.ok(whiskerPixel.a > 160, `Fine white whisker must be preserved, got alpha=${whiskerPixel.a}`);
  assert.ok(whiskerPixel.r > 220 && whiskerPixel.g > 220 && whiskerPixel.b > 220, 'Whisker must stay white without green tint');
});

/**
 * Helper to compute the non-transparent bounding box inside an RGBA image.
 */
function computeAlphaBBox(img, alphaThreshold = 16) {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.pixelAt(x, y).a >= alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
  };
}

test('4. Shifted grid and overhanging character tail crossing nominal 1/3 boundary without clipping', async () => {
  const dir = path.join(tmpRoot, 'case4-shifted-overhang');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');

  // Cell 1 is shifted right by +26px and has an overhanging tail of 155px that crosses nominal x=512 (into x ~ 542),
  // while Cell 2 is shifted right by +60px so there is still a clean gap between them.
  const sheetBuf = await generateTestStickerSheet({
    width: 1536,
    height: 1536,
    layout: '3x3',
    bgHex: '#00FF00',
    cellShifts: {
      1: { dx: 26, dy: -18 },
      2: { dx: 60, dy: 14 },
      5: { dx: -24, dy: 20 },
    },
    overhangCellIndex: 1,
    overhangRightPx: 155,
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });

  assert.equal(res.status, 'ready');
  assert.equal(res.readyCount, 9);

  // Verify Cell 1 rendered sticker includes the full overhanging tail (wider aspect ratio than standard Cell 3,
  // and right-most pixel has white die-cut border rather than sliced orange interior)
  const img1 = await readRawRgba(path.join(outputDir, 'stickers', '01.png'));
  const img3 = await readRawRgba(path.join(outputDir, 'stickers', '03.png'));
  const bbox1 = computeAlphaBBox(img1);
  const bbox3 = computeAlphaBBox(img3);
  assert.ok(
    bbox1.width / bbox1.height > bbox3.width / bbox3.height + 0.08,
    `Expected Cell 1 with overhanging tail to have wider aspect ratio than Cell 3 (${(bbox1.width / bbox1.height).toFixed(2)} vs ${(bbox3.width / bbox3.height).toFixed(2)})`,
  );
});

test('5. Empty cell detection -> status "failed", no fake sticker created, diagnostic error returned', async () => {
  const dir = path.join(tmpRoot, 'case5-empty-cell');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 1200,
    height: 1200,
    layout: '3x3',
    bgHex: '#00FF00',
    emptyCells: [5], // Center cell is empty
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });

  assert.equal(res.status, 'failed');
  assert.equal(res.expectedCount, 9);
  assert.equal(res.readyCount, 8);
  assert.equal(res.stickers.length, 9);
  assert.equal(res.stickers[4].index, 5);
  assert.equal(res.stickers[4].status, 'failed');
  assert.equal(res.stickers[4].path, null);
  assert.ok(res.errors.some((e) => e.includes('Ячейка #5') && e.includes('пуста')));

  // Ensure stickers/05.png was NOT created
  await assert.rejects(fs.access(path.join(outputDir, 'stickers', '05.png')));
});

test('6. Overlapping neighboring characters across cell boundary -> status "needs_review" (no silent guillotine cut)', async () => {
  const dir = path.join(tmpRoot, 'case6-overlap');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 1200,
    height: 1200,
    layout: '3x3',
    bgHex: '#00FF00',
    overlapCells: [1, 2],
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });

  assert.equal(res.status, 'needs_review');
  assert.equal(res.stickers[0].status, 'needs_review');
  assert.equal(res.stickers[1].status, 'needs_review');
  assert.ok(
    res.warnings.some(
      (w) => w.includes('пересекается или сливается') || w.includes('не имеет сквозного прозрачного промежутка'),
    ),
  );
});

test('7. Already transparent PNG input -> preserves existing transparency and green details without re-keying destruction', async () => {
  const dir = path.join(tmpRoot, 'case7-already-transparent');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet-rgba.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 1200,
    height: 1200,
    layout: '3x3',
    transparentBg: true,
    format: 'png',
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });

  assert.equal(res.status, 'ready');
  assert.equal(res.readyCount, 9);
  assert.equal(res.errors.length, 0);

  // Verify green eyes and green hoodie inside sticker 1 are 100% preserved
  const sheetImg = await readRawRgba(path.join(outputDir, 'sheet-transparent.png'));
  const cellW = 1200 / 3;
  const scale = cellW / 340;
  const cx = 0.5 * cellW;
  const cy = 0.5 * cellW;
  const eyePixel = sheetImg.pixelAt(cx - 24 * scale + 7.5 * scale, cy - 26 * scale);
  assert.equal(eyePixel.a, 255);
  assert.ok(eyePixel.g > 200);
});

test('8. Small source sheet -> no upscaling when allowUpscale: false (centers original pixels on 512x512 canvas)', async () => {
  const dir = path.join(tmpRoot, 'case8-no-upscale');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'small-sheet.png');
  const outputDir = path.join(dir, 'processed');

  // 600x600 sheet -> each cell is 200x200 (< 512 - 48 = 464px target box)
  const sheetBuf = await generateTestStickerSheet({
    width: 600,
    height: 600,
    layout: '3x3',
    bgHex: '#00FF00',
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    outputSize: 512,
    padding: 24,
    allowUpscale: false,
  });

  assert.equal(res.status, 'ready');
  const s1 = res.stickers[0];
  assert.equal(s1.width, 512);
  assert.equal(s1.height, 512);

  const img1 = await readRawRgba(path.join(outputDir, s1.path));
  const bbox = computeAlphaBBox(img1);
  assert.ok(
    bbox.width <= 200 && bbox.height <= 200,
    `Small sticker content must NOT be upscaled when allowUpscale: false; got ${bbox.width}x${bbox.height}`,
  );
});

test('8B. Scaling up to 512px -> larger side of sticker is exactly 512px when allowUpscale: true and padding: 0', async () => {
  const dir = path.join(tmpRoot, 'case8b-upscale-512');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'small-sheet.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 600,
    height: 600,
    layout: '3x3',
    bgHex: '#00FF00',
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    outputSize: 512,
    padding: 0,
    allowUpscale: true,
  });

  assert.equal(res.status, 'ready');
  const s1 = res.stickers[0];
  assert.equal(s1.width, 512);
  assert.equal(s1.height, 512);

  const img1 = await readRawRgba(path.join(outputDir, s1.path));
  const bbox = computeAlphaBBox(img1);
  const maxSide = Math.max(bbox.width, bbox.height);
  assert.equal(maxSide, 512, `Larger side of sticker must be scaled to exactly 512px; got ${maxSide}px (bbox: ${bbox.width}x${bbox.height})`);
});

test('9. Character color nearly identical to background color -> emits warning/failure instead of silent corruption', async () => {
  const dir = path.join(tmpRoot, 'case9-color-conflict');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'conflict-sheet.png');
  const outputDir = path.join(dir, 'processed');

  // Draw 9 characters whose entire body is #02FA06 on #00FF00 without white outline
  const svgRects = ['<rect width="900" height="900" fill="#00FF00" />'];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cx = (c + 0.5) * 300;
      const cy = (r + 0.5) * 300;
      svgRects.push(`<circle cx="${cx}" cy="${cy}" r="85" fill="#02FA06" />`);
    }
  }
  const conflictBuf = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">${svgRects.join('')}</svg>`),
  )
    .png()
    .toBuffer();
  await fs.writeFile(inputPath, conflictBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
  });

  assert.notEqual(res.status, 'ready', 'Must not silently succeed when character color equals background color');
  assert.ok(res.errors.length > 0 || res.warnings.length > 0);
});

test('10. Corrupted file, missing file, unsupported layout, path confinement, and size/pixel limits', async () => {
  const dir = path.join(tmpRoot, 'case10-errors');
  await fs.mkdir(dir, { recursive: true });

  // 10A: Corrupted file
  const corruptPath = path.join(dir, 'corrupt.jpg');
  await fs.writeFile(corruptPath, Buffer.from('not-a-valid-image-stream-12345'));
  const resCorrupt = await processStickerSheet({
    inputPath: corruptPath,
    outputDir: path.join(dir, 'out-corrupt'),
    layout: '3x3',
  });
  assert.equal(resCorrupt.status, 'failed');
  assert.ok(resCorrupt.errors[0].includes('Ошибка декодирования изображения'));

  // 10B: Missing input file
  const resMissing = await processStickerSheet({
    inputPath: path.join(dir, 'does-not-exist.png'),
    outputDir: path.join(dir, 'out-missing'),
    layout: '3x3',
  });
  assert.equal(resMissing.status, 'failed');
  assert.ok(resMissing.errors[0].includes('Входной файл не найден'));

  // 10C: Unsupported layout
  await assert.rejects(
    processStickerSheet({
      inputPath: corruptPath,
      outputDir: path.join(dir, 'out-layout'),
      layout: '5x5',
    }),
    /Неподдерживаемая сетка/,
  );

  // 10D: Input inside outputDir rejected (path safety)
  const unsafeOutDir = path.join(dir, 'unsafe-out');
  await fs.mkdir(unsafeOutDir, { recursive: true });
  await assert.rejects(
    processStickerSheet({
      inputPath: path.join(unsafeOutDir, 'sheet.png'),
      outputDir: unsafeOutDir,
      layout: '3x3',
    }),
    /не должен находиться внутри/,
  );

  // 10E: Pixel limit exceeded
  const validPath = path.join(dir, 'valid.png');
  await fs.writeFile(
    validPath,
    await generateTestStickerSheet({ width: 600, height: 600, layout: '3x3' }),
  );
  const resMaxPixels = await processStickerSheet({
    inputPath: validPath,
    outputDir: path.join(dir, 'out-maxpx'),
    layout: '3x3',
    maxPixels: 100 * 100, // 10,000 px limit < 360,000 px
  });
  assert.equal(resMaxPixels.status, 'failed');
  assert.ok(
    resMaxPixels.errors[0].includes('превышает лимит') || resMaxPixels.errors[0].includes('pixel limit'),
  );
});

test('11. CLI execution (--config) -> stdout valid JSON, stderr diagnostics, exit codes (0 ready, 2 needs_review, 1 failed), and idempotency', async () => {
  const dir = path.join(tmpRoot, 'case10-cli');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');
  const configPath = path.join(dir, 'config.json');

  await fs.writeFile(
    inputPath,
    await generateTestStickerSheet({ width: 900, height: 900, layout: '3x3', bgHex: '#00FF00' }),
  );
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      inputPath,
      outputDir,
      layout: '3x3',
      backgroundColor: '#00FF00',
      outputSize: 512,
      padding: 24,
      strict: true,
      debug: false,
    }),
  );

  const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

  // Run 1: with debug=true via CLI flag
  const run1 = spawnSync(process.execPath, [cliPath, '--config', configPath, '--debug', 'true'], {
    encoding: 'utf8',
  });
  assert.equal(run1.status, 0, `Expected exit code 0, got ${run1.status}. stderr: ${run1.stderr}`);
  const parsed1 = JSON.parse(run1.stdout);
  assert.equal(parsed1.status, 'ready');
  assert.equal(parsed1.readyCount, 9);
  assert.ok(run1.stderr.includes('[sticker-sheet-cli] Completed with status="ready"'));
  await fs.access(path.join(outputDir, 'debug', 'background-mask.png'));

  // Run 2 (Idempotency): re-run into same outputDir with debug=false -> stale debug/ directory must be cleaned!
  const run2 = spawnSync(process.execPath, [cliPath, '--config', configPath], {
    encoding: 'utf8',
  });
  assert.equal(run2.status, 0);
  const parsed2 = JSON.parse(run2.stdout);
  assert.equal(parsed2.status, 'ready');
  await assert.rejects(
    fs.access(path.join(outputDir, 'debug')),
    'Stale debug directory should be removed when re-running with debug=false',
  );

  // Run 3: failed CLI run returns non-zero exit code (1) and JSON on stdout
  const badConfigPath = path.join(dir, 'bad-config.json');
  await fs.writeFile(
    badConfigPath,
    JSON.stringify({
      inputPath: path.join(dir, 'missing.png'),
      outputDir: path.join(dir, 'out-bad'),
      layout: '3x3',
    }),
  );
  const run3 = spawnSync(process.execPath, [cliPath, '--config', badConfigPath], {
    encoding: 'utf8',
  });
  assert.notEqual(run3.status, 0);
  const parsed3 = JSON.parse(run3.stdout);
  assert.equal(parsed3.status, 'failed');
});

test('12. Studio chroma patch [46,212,66] in gap between cell 4 & 5 on [1,249,5] background is removed while matching [46,212,66] green eyes stay opaque', async () => {
  const dir = path.join(tmpRoot, 'case12-studio-patch');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet-studio-patch.png');
  const outputDir = path.join(dir, 'processed');

  const width = 1536;
  const height = 1536;
  const cellW = width / 3;
  const cellH = height / 3;
  const scale = Math.min(cellW, cellH) / 340;
  const bgHex = '#01F905'; // RGB [1, 249, 5]
  const patchHex = '#2ED442'; // RGB [46, 212, 66]

  const svgParts = [
    `<defs>
      <radialGradient id="studioPatchGrad" cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
        <stop offset="0%" stop-color="${patchHex}" />
        <stop offset="58%" stop-color="${patchHex}" />
        <stop offset="82%" stop-color="#19DF28" />
        <stop offset="100%" stop-color="${bgHex}" />
      </radialGradient>
    </defs>`,
    `<rect width="${width}" height="${height}" fill="${bgHex}" />`,
    // Feathered studio chroma patch bridging the gap between Cell 4 (row=1, col=0) and Cell 5 (row=1, col=1)
    `<rect x="330" y="540" width="364" height="440" fill="url(#studioPatchGrad)" />`,
  ];

  let idx = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      idx++;
      const cx = (c + 0.5) * cellW;
      const cy = (r + 0.5) * cellH;
      svgParts.push(
        buildCharacterSvg(cx, cy, scale, {
          bgHex,
          eyeGreen: patchHex, // Exact same RGB [46, 212, 66] inside white/dark eye outline
          shirtGreen: '#00D434',
          includeEnclosedHole: true,
          badgeIndex: idx,
        }),
      );
    }
  }

  const sheetBuf = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgParts.join('\n')}</svg>`),
  )
    .png({ compressionLevel: 6 })
    .toBuffer();
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
    strict: true,
    debug: true,
  });

  assert.equal(res.status, 'ready', `Expected ready, got ${res.status} with warnings: ${JSON.stringify(res.warnings)}`);
  assert.equal(res.readyCount, 9);
  assert.equal(res.warnings.length, 0);
  assert.equal(res.errors.length, 0);
  for (const sticker of res.stickers) {
    assert.equal(sticker.status, 'ready');
    assert.equal(sticker.warnings.length, 0);
  }

  const sheetImg = await readRawRgba(path.join(outputDir, 'sheet-transparent.png'));
  // Studio patch center in gap between Cell 4 and Cell 5 must be cleared to alpha=0
  for (const [gx, gy] of [
    [512, 760],
    [495, 700],
    [530, 820],
  ]) {
    assert.equal(sheetImg.pixelAt(gx, gy).a, 0, `Studio patch at (${gx},${gy}) must be transparent`);
  }

  // Green eye [46, 212, 66] inside Cell 4 (row=1, col=0) and Cell 5 (row=1, col=1) MUST remain 100% opaque
  for (const col of [0, 1]) {
    const cx = (col + 0.5) * cellW;
    const cy = 1.5 * cellH;
    const eyePx = sheetImg.pixelAt(cx - 24 * scale + 7.5 * scale, cy - 26 * scale);
    assert.equal(eyePx.a, 255, `Green eye in col ${col} must remain opaque`);
    assert.ok(eyePx.g > 180 && eyePx.g > eyePx.r + 100 && eyePx.g > eyePx.b + 100, `Green eye must keep color, got RGB(${eyePx.r},${eyePx.g},${eyePx.b})`);
  }
});

test('13. Staggered row heights across columns (no single straight horizontal line) still pass strict mode when each column has a clean gap', async () => {
  const dir = path.join(tmpRoot, 'case13-staggered-rows');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'staggered.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 1536,
    height: 1536,
    layout: '3x3',
    bgHex: '#00FF00',
    cellShifts: {
      4: { dx: 0, dy: -40 },
      5: { dx: 0, dy: 90 },
      6: { dx: 0, dy: -40 },
      7: { dx: 0, dy: -80 },
      8: { dx: 0, dy: 40 },
      9: { dx: 0, dy: -80 },
    },
  });
  await fs.writeFile(inputPath, sheetBuf);

  const res = await processStickerSheet({
    inputPath,
    outputDir,
    layout: '3x3',
    backgroundColor: '#00FF00',
    strict: true,
  });

  assert.equal(res.status, 'ready', `Expected ready, got ${res.status} with warnings: ${JSON.stringify(res.warnings)}`);
  assert.equal(res.readyCount, 9);
  assert.equal(res.warnings.length, 0);
});

test('12. Optional export flags (exportTransparentSheet & exportPreview) -> control artifact generation, manifest paths, stale cleanup, and CLI flags', async () => {
  const dir = path.join(tmpRoot, 'case12-optional-exports');
  await fs.mkdir(dir, { recursive: true });
  const inputPath = path.join(dir, 'sheet.png');
  const outputDir = path.join(dir, 'processed');

  const sheetBuf = await generateTestStickerSheet({
    width: 1536,
    height: 1536,
    layout: '3x3',
    bgHex: '#00FF00',
    format: 'png',
  });
  await fs.writeFile(inputPath, sheetBuf);

  // 1. By default, both are exported
  const defaultRes = await processStickerSheet({
    version: 1,
    inputPath,
    outputDir,
    layout: '3x3',
  });
  assert.equal(defaultRes.status, 'ready');
  assert.equal(defaultRes.transparentSheetPath, 'sheet-transparent.png');
  assert.equal(defaultRes.previewPath, 'preview.png');
  await fs.access(path.join(outputDir, 'sheet-transparent.png'));
  await fs.access(path.join(outputDir, 'preview.png'));

  // 2. Disable both flags -> artifacts are omitted, manifest fields are null, and stale files cleaned
  const disabledRes = await processStickerSheet({
    version: 1,
    inputPath,
    outputDir,
    layout: '3x3',
    exportTransparentSheet: false,
    exportPreview: false,
  });
  assert.equal(disabledRes.status, 'ready');
  assert.equal(disabledRes.transparentSheetPath, null);
  assert.equal(disabledRes.previewPath, null);
  await assert.rejects(fs.access(path.join(outputDir, 'sheet-transparent.png')));
  await assert.rejects(fs.access(path.join(outputDir, 'preview.png')));
  // Stickers and manifest must still be present and valid
  assert.equal(disabledRes.stickers.length, 9);
  await fs.access(path.join(outputDir, 'stickers', '01.png'));
  await fs.access(path.join(outputDir, 'manifest.json'));

  // 3. Test CLI flags --no-export-transparent-sheet and --no-export-preview
  const configPath = path.join(dir, 'test-config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      inputPath,
      outputDir,
      layout: '3x3',
    }),
  );
  const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const cliRun = spawnSync(
    process.execPath,
    [cliPath, '--config', configPath, '--no-export-transparent-sheet', '--no-export-preview'],
    { encoding: 'utf8' },
  );
  assert.equal(cliRun.status, 0, `CLI run failed: ${cliRun.stderr}`);
  const parsedCli = JSON.parse(cliRun.stdout);
  assert.equal(parsedCli.transparentSheetPath, null);
  assert.equal(parsedCli.previewPath, null);
  await assert.rejects(fs.access(path.join(outputDir, 'sheet-transparent.png')));
  await assert.rejects(fs.access(path.join(outputDir, 'preview.png')));
});
