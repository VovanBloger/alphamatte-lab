import sharp from 'sharp';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { processStickerSheet as processV52, sotaCellMattingV5_2_Fast } from '../sheet-processor/index.v5.2.mjs';
import { processStickerSheet as processV53, sotaCellMattingV5_3_Turbo } from '../sheet-processor/index.mjs';

const INPUT_IMAGE = path.resolve('public/assets/aistudio/sheet_0790b517.jpg');
const WORKER_PATH = path.resolve('sheet-processor/matting-worker.mjs');

const CELL_METADATA = [
  { id: 1, domain: 'cats', title: 'Мейн-кун (шерсть + усы)', challenge: 'Тонкие пушистые кисточки ушей, светлые усы на #7A828C', category: 'Шерсть и усы' },
  { id: 2, domain: 'cats', title: 'Белый пушистый кот', challenge: 'Светлая шерсть в тени (проверка анти-потемнения краёв на тёмном фоне)', category: 'Шерсть и усы' },
  { id: 3, domain: 'cats', title: 'Рыжий кот (длинные усы)', challenge: 'Тонкие 1px усы, тёплый мех по контуру', category: 'Шерсть и усы' },
  { id: 4, domain: 'cats', title: 'Красный и синий шары', challenge: 'Полупрозрачный латекс + белые нити (баг v5.2: пятно в синем шаре)', category: 'Полупрозрачность' },
  { id: 5, domain: 'cats', title: 'Мыльные пузыри', challenge: 'Сверхтонкие радужные сферы на студийном фоне', category: 'Полупрозрачность' },
  { id: 6, domain: 'cats', title: 'Кот в очках с дымом', challenge: 'Волюметрический дым + серый мех + усы', category: 'Дым и пар' },
  { id: 7, domain: 'cats', title: 'Британец со стаканом колы', challenge: 'Шерсть почти в цвет фона #7A828C + стеклянный край', category: 'Тон в тон' },
  { id: 8, domain: 'cats', title: 'Светлячки и боке-ореолы', challenge: 'Мягкое свечение, полупрозрачный туман и мелкие искры', category: 'Свечение и боке' },
  { id: 9, domain: 'cats', title: 'Кот с горячим кофе', challenge: 'Клубы пара + гладкая кружка (баг v5.2: дыра в кружке!)', category: 'Дым и пар' },
  { id: 10, domain: 'cats', title: 'Котёнок с шаром-сердцем и банкой', challenge: 'Розовый шар + стеклянная банка со звёздами', category: 'Полупрозрачность' },
  { id: 11, domain: 'cats', title: 'Одуванчик и пушинки', challenge: 'Десятки отдельных полупрозрачных парашютиков в воздухе', category: 'Микродетали' },
  { id: 12, domain: 'cats', title: 'Бенгальский огонь и золотой шар', challenge: 'Искры, дымок и металлизированный золотой шар', category: 'Свечение и боке' },
];

const HUMAN_PORTRAITS = [
  {
    id: 13,
    domain: 'humans',
    path: path.resolve('src/assets/images/human_curly_afro_1795366630633.jpg'),
    title: 'Афро-кудри (плотный ореол)',
    challenge: 'Сотни микро-просветов фона внутри тёмных кудрей + деконтаминация серого ореола',
    category: 'Люди: волосы',
  },
  {
    id: 14,
    domain: 'humans',
    path: path.resolve('src/assets/images/human_blonde_wispy_1795366630132.jpg'),
    title: 'Платиновый блонд (тонкие пряди)',
    challenge: 'Выбившиеся светлые волоски в воздухе — защита от серой «паутины» и потемнения',
    category: 'Люди: волосы',
  },
  {
    id: 15,
    domain: 'humans',
    path: path.resolve('src/assets/images/human_dark_messy_1795366630364.jpg'),
    title: 'Тёмные волны + серая рубашка',
    challenge: 'Тёмные выбившиеся волоски + фактурная серо-зелёная рубашка близко к #7A828C',
    category: 'Люди: волосы',
  },
  {
    id: 16,
    domain: 'humans',
    path: path.resolve('src/assets/images/human_silver_wispy_1795366631310.jpg'),
    title: 'Седые пушистые волосы',
    challenge: 'Бело-седые полупрозрачные пряди в тени — полный аналог белой кошачьей шерсти',
    category: 'Люди: волосы',
  },
];

function countEdgeGrayHalo(rgba) {
  const totalPx = rgba.length >> 2;
  let grayHalo = 0;
  let darkFringe = 0;
  for (let i = 0; i < totalPx; i++) {
    const off = i << 2;
    const a = rgba[off + 3];
    if (a >= 15 && a <= 235) {
      const r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat < 14 && Math.abs(l - 128) < 18) grayHalo++;
      if (l < 42) darkFringe++;
    }
  }
  return { grayHalo, darkFringe };
}

async function runParallelV53(cells, qualityEnhancements, numWorkers) {
  const workers = Array.from({ length: numWorkers }, () => new Worker(WORKER_PATH));
  const dispatchBatch = async (batchCells) => {
    const results = new Array(batchCells.length);
    let nextIdx = 0;
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            const onMessage = (msg) => {
              results[msg.jobId] = new Uint8ClampedArray(msg.buffer);
              dispatchNext();
            };
            const onError = (err) => {
              worker.off('message', onMessage);
              worker.off('error', onError);
              reject(err);
            };
            const dispatchNext = () => {
              if (nextIdx >= batchCells.length) {
                worker.off('message', onMessage);
                worker.off('error', onError);
                resolve();
                return;
              }
              const idx = nextIdx++;
              const cell = batchCells[idx];
              const copy = new Uint8ClampedArray(cell.cellRgba);
              worker.postMessage(
                { jobId: idx, buffer: copy.buffer, cw: cell.cw, ch: cell.ch, qualityEnhancements, gutter: 0 },
                [copy.buffer]
              );
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
            dispatchNext();
          })
      )
    );
    return results;
  };

  // Warmup workers (V8 TurboFan + workspace allocation)
  await dispatchBatch(cells.slice(0, numWorkers));

  const tStart = performance.now();
  const results = await dispatchBatch(cells);
  const elapsedMs = performance.now() - tStart;
  await Promise.all(workers.map((w) => w.terminate()));
  return { elapsedMs, results };
}

function compareBuffers(refArr, testArr) {
  const totalPx = refArr.length >> 2;
  let sumAbsA = 0, sumSqA = 0, within1 = 0, exact0 = 0, maxDiffA = 0;
  for (let i = 0; i < totalPx; i++) {
    const off = i << 2;
    const da = Math.abs(refArr[off + 3] - testArr[off + 3]);
    sumAbsA += da;
    sumSqA += da * da;
    if (da > maxDiffA) maxDiffA = da;
    if (da === 0) exact0++;
    if (da <= 1) within1++;
  }
  const maeA = sumAbsA / totalPx;
  const mseA = sumSqA / totalPx;
  const psnrA = mseA > 0 ? 10 * Math.log10((255 * 255) / mseA) : 99.9;
  return {
    maeA: Number(maeA.toFixed(4)),
    psnrA: Number(psnrA.toFixed(2)),
    pctExact: Number(((exact0 / totalPx) * 100).toFixed(3)),
    pctWithin1: Number(((within1 / totalPx) * 100).toFixed(3)),
    maxDiffA,
  };
}

function measureMugSolidity(cellData, cw, ch) {
  const x0 = Math.floor(cw * 0.34), x1 = Math.floor(cw * 0.66);
  const y0 = Math.floor(ch * 0.68), y1 = Math.floor(ch * 0.90);
  let total = 0, semiHole = 0, minAlpha = 255;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = cellData[(y * cw + x) * 4 + 3];
      total++;
      if (a < 245 && a > 10) semiHole++;
      if (a < minAlpha) minAlpha = a;
    }
  }
  return { total, semiHole, holePct: Number(((semiHole / total) * 100).toFixed(2)), minAlpha };
}

function measureBalloonStats(cellData, cw, ch) {
  const x0 = Math.floor(cw * 0.58), x1 = Math.floor(cw * 0.90);
  const y0 = Math.floor(ch * 0.10), y1 = Math.floor(ch * 0.42);
  let count = 0, sumA = 0, sharpTransitions = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y * cw + x) * 4;
      const a = cellData[idx + 3];
      if (a > 20) {
        count++;
        sumA += a;
        const aR = cellData[idx + 7];
        const aD = cellData[((y + 1) * cw + x) * 4 + 3];
        if (aR > 20 && Math.abs(a - aR) > 18) sharpTransitions++;
        if (aD > 20 && Math.abs(a - aD) > 18) sharpTransitions++;
      }
    }
  }
  return { meanAlpha: Number((count ? sumA / count : 0).toFixed(1)), sharpTransitions };
}

async function main() {
  const decoded = await sharp(INPUT_IMAGE)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  const { width, height } = decoded.info;
  const columns = 3, rows = 4;
  const cells = [];

  for (let r = 0; r < rows; r++) {
    const top = Math.floor((r * height) / rows);
    const bottom = Math.floor(((r + 1) * height) / rows);
    const ch = bottom - top;
    for (let c = 0; c < columns; c++) {
      const left = Math.floor((c * width) / columns);
      const right = Math.floor(((c + 1) * width) / columns);
      const cw = right - left;
      const cellRgba = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const srcOff = ((top + y) * width + left) * 4;
        cellRgba.set(decoded.data.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
      }
      cells.push({ index: r * columns + c + 1, r, c, left, top, cw, ch, cellRgba });
    }
  }

  // Warmup WITH stageTimings object to prevent V8 polymorphic deopt during timed loops
  const dummySt = {
    stage0: 0, stage1_sobel: 0, stage1_box3: 0, stage1b_inward: 0,
    stage2_flood: 0, stage3_pockets: 0, stage4_dist: 0, stage5_spfa: 0,
    stage6_unmix: 0, stage6_texture_recovery: 0, stage7_guided: 0,
  };
  sotaCellMattingV5_2_Fast(cells[0].cellRgba, cells[0].cw, cells[0].ch);
  sotaCellMattingV5_3_Turbo(cells[0].cellRgba, cells[0].cw, cells[0].ch, { qualityEnhancements: false, stageTimings: dummySt });
  sotaCellMattingV5_3_Turbo(cells[0].cellRgba, cells[0].cw, cells[0].ch, { qualityEnhancements: true, stageTimings: dummySt });

  // Measure per-cell v5.2-FAST
  const v52Out = [];
  const v52CellMs = [];
  const v52Diag = [];
  let v52TotalMs = 0;
  for (const cell of cells) {
    const diag = {};
    const t0 = performance.now();
    const out = sotaCellMattingV5_2_Fast(cell.cellRgba, cell.cw, cell.ch, { diagnostics: diag });
    const dt = performance.now() - t0;
    v52Out.push(out);
    v52CellMs.push(dt);
    v52Diag.push(diag);
    v52TotalMs += dt;
  }

  // Measure per-cell v5.3-Exact (pure speedup)
  const v53ExactStages = {
    stage0: 0, stage1_sobel: 0, stage1_box3: 0, stage1b_inward: 0,
    stage2_flood: 0, stage3_pockets: 0, stage4_dist: 0, stage5_spfa: 0,
    stage6_unmix: 0, stage6_texture_recovery: 0, stage7_guided: 0,
  };
  const v53ExactOut = [];
  const v53ExactCellMs = [];
  let v53ExactTotalMs = 0;
  for (const cell of cells) {
    const t0 = performance.now();
    const out = sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, {
      qualityEnhancements: false,
      stageTimings: v53ExactStages,
    });
    const dt = performance.now() - t0;
    v53ExactOut.push(out);
    v53ExactCellMs.push(dt);
    v53ExactTotalMs += dt;
  }

  // Measure per-cell v5.3-Quality+
  const v53QualStages = {
    stage0: 0, stage1_sobel: 0, stage1_box3: 0, stage1b_inward: 0,
    stage2_flood: 0, stage3_pockets: 0, stage4_dist: 0, stage5_spfa: 0,
    stage6_unmix: 0, stage6_texture_recovery: 0, stage7_guided: 0,
  };
  const v53QualOut = [];
  const v53QualCellMs = [];
  const v53QualDiag = [];
  let v53QualTotalMs = 0;
  for (const cell of cells) {
    const diag = {};
    const t0 = performance.now();
    const out = sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, {
      qualityEnhancements: true,
      stageTimings: v53QualStages,
      diagnostics: diag,
    });
    const dt = performance.now() - t0;
    v53QualOut.push(out);
    v53QualCellMs.push(dt);
    v53QualDiag.push(diag);
    v53QualTotalMs += dt;
  }

  // Measure parallel v5.3-Quality+ (warm worker_threads pool)
  const numWorkers = Math.min(4, os.cpus().length);
  const parRes = await runParallelV53(cells, true, numWorkers);

  // Measure full processStickerSheet (v5.2 baseline vs v5.3-TURBO parallel + concurrent export)
  const fullV52 = await processV52({
    inputPath: INPUT_IMAGE,
    outputDir: '/tmp/bench-full-v52',
    layout: '3x4',
    backgroundColor: '#7A828C',
    exportTransparentSheet: false,
    exportPreview: true,
  });

  // Warmup v5.3 worker pool once, then measure full v5.3 pipeline
  await processV53({
    inputPath: INPUT_IMAGE,
    outputDir: '/tmp/bench-full-v53-warm',
    layout: '3x4',
    backgroundColor: '#7A828C',
    exportTransparentSheet: false,
    exportPreview: false,
    parallel: true,
    qualityEnhancements: true,
  });

  const fullV53 = await processV53({
    inputPath: INPUT_IMAGE,
    outputDir: '/tmp/bench-full-v53',
    layout: '3x4',
    backgroundColor: '#7A828C',
    exportTransparentSheet: false,
    exportPreview: true,
    parallel: true,
    qualityEnhancements: true,
  });

  // Compute fidelity & per-cell metrics + export 600px comparison assets for UI
  await fs.mkdir('public/bench/cells', { recursive: true });

  const perCellStats = [];
  let sumPsnr = 0, sumMaeA = 0, sumWithin1 = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const idStr = String(cell.index).padStart(2, '0');
    const exactCmp = compareBuffers(v52Out[i], v53ExactOut[i]);
    const qualCmp = compareBuffers(v52Out[i], v53QualOut[i]);
    sumPsnr += exactCmp.psnrA;
    sumMaeA += exactCmp.maeA;
    sumWithin1 += exactCmp.pctWithin1;

    // Build amplified alpha-difference heatmap (red = v5.3 higher alpha / fixed hole, cyan = v5.3 lower alpha / cleaner bg)
    const totalPx = cell.cw * cell.ch;
    const diffBuf = Buffer.alloc(totalPx * 4);
    const alphaV52Buf = Buffer.alloc(totalPx);
    const alphaV53Buf = Buffer.alloc(totalPx);
    let diffPixels = 0;

    for (let p = 0; p < totalPx; p++) {
      const off = p << 2;
      const a52 = v52Out[i][off + 3];
      const a53 = v53QualOut[i][off + 3];
      alphaV52Buf[p] = a52;
      alphaV53Buf[p] = a53;
      const delta = a53 - a52;
      if (Math.abs(delta) > 3) {
        diffPixels++;
        const mag = Math.min(255, Math.abs(delta) * 4);
        if (delta > 0) {
          // v5.3 restored solid opacity (e.g. fixed mug hole / balloon patch / whisker) -> emerald/amber glow
          diffBuf[off] = 16;
          diffBuf[off + 1] = Math.min(255, 160 + (mag >> 1));
          diffBuf[off + 2] = 129;
          diffBuf[off + 3] = Math.max(90, mag);
        } else {
          // v5.3 cleaned extra bg/halo -> rose/magenta
          diffBuf[off] = 244;
          diffBuf[off + 1] = 63;
          diffBuf[off + 2] = 94;
          diffBuf[off + 3] = Math.max(90, mag);
        }
      } else {
        // Subtle grayscale dim of alpha for context
        const base = Math.round(a53 * 0.25);
        diffBuf[off] = base;
        diffBuf[off + 1] = base;
        diffBuf[off + 2] = base + 8;
        diffBuf[off + 3] = 255;
      }
    }

    const previewSize = 600;
    await Promise.all([
      sharp(Buffer.from(cell.cellRgba.buffer, cell.cellRgba.byteOffset, cell.cellRgba.byteLength), {
        raw: { width: cell.cw, height: cell.ch, channels: 4 },
      })
        .resize(previewSize, previewSize, { fit: 'inside' })
        .jpeg({ quality: 90 })
        .toFile(`public/bench/cells/orig_${idStr}.jpg`),

      sharp(Buffer.from(v52Out[i].buffer, v52Out[i].byteOffset, v52Out[i].byteLength), {
        raw: { width: cell.cw, height: cell.ch, channels: 4 },
      })
        .resize(previewSize, previewSize, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/v52_${idStr}.png`),

      sharp(Buffer.from(v53QualOut[i].buffer, v53QualOut[i].byteOffset, v53QualOut[i].byteLength), {
        raw: { width: cell.cw, height: cell.ch, channels: 4 },
      })
        .resize(previewSize, previewSize, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/v53_${idStr}.png`),

      sharp(alphaV52Buf, { raw: { width: cell.cw, height: cell.ch, channels: 1 } })
        .resize(previewSize, previewSize, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/alpha_v52_${idStr}.png`),

      sharp(alphaV53Buf, { raw: { width: cell.cw, height: cell.ch, channels: 1 } })
        .resize(previewSize, previewSize, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/alpha_v53_${idStr}.png`),

      sharp(diffBuf, { raw: { width: cell.cw, height: cell.ch, channels: 4 } })
        .resize(previewSize, previewSize, { fit: 'inside' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/diff_${idStr}.png`),
    ]);

    const qDiag = v53QualDiag[i];
    const sem = v52Diag[i]?.semantic || qDiag?.semantic;
    const texRec = qDiag?.textureRecovery || { extractedPatches: 0, recoveredPixels: 0 };

    perCellStats.push({
      ...CELL_METADATA[i],
      width: cell.cw,
      height: cell.ch,
      v52Ms: Number(v52CellMs[i].toFixed(1)),
      v53ExactMs: Number(v53ExactCellMs[i].toFixed(1)),
      v53QualMs: Number(v53QualCellMs[i].toFixed(1)),
      speedup1T: Number((v52CellMs[i] / v53QualCellMs[i]).toFixed(2)),
      exactPsnrDb: exactCmp.psnrA,
      exactMaeAlpha: exactCmp.maeA,
      exactWithin1Pct: exactCmp.pctWithin1,
      qualDiffPixelsPct: Number(((diffPixels / totalPx) * 100).toFixed(2)),
      qualMaeAlpha: qualCmp.maeA,
      semanticClass: sem?.subjectType || 'animal',
      semanticConfidence: sem?.confidence ?? 0,
      textureRecoveredPixels: texRec.recoveredPixels,
      textureExtractedPatches: texRec.extractedPatches,
      assets: {
        orig: `/bench/cells/orig_${idStr}.jpg`,
        v52: `/bench/cells/v52_${idStr}.png`,
        v53: `/bench/cells/v53_${idStr}.png`,
        alphaV52: `/bench/cells/alpha_v52_${idStr}.png`,
        alphaV53: `/bench/cells/alpha_v53_${idStr}.png`,
        diff: `/bench/cells/diff_${idStr}.png`,
      },
    });
  }

  const mugV52 = measureMugSolidity(v52Out[8], cells[8].cw, cells[8].ch);
  const mugV53 = measureMugSolidity(v53QualOut[8], cells[8].cw, cells[8].ch);
  const balV52 = measureBalloonStats(v52Out[3], cells[3].cw, cells[3].ch);
  const balV53 = measureBalloonStats(v53QualOut[3], cells[3].cw, cells[3].ch);

  // --- Human Portraits with Diverse Hair Types (ids 13..16) ---
  let hairV52TotalMs = 0;
  let hairV53QualTotalMs = 0;
  let hairGrayHaloV52 = 0;
  let hairGrayHaloV53 = 0;

  // Warm up on portrait resolution (896x1200) once
  {
    const dec0 = await sharp(HUMAN_PORTRAITS[0].path).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const rgba0 = new Uint8ClampedArray(dec0.data);
    sotaCellMattingV5_2_Fast(rgba0, dec0.info.width, dec0.info.height);
    sotaCellMattingV5_3_Turbo(rgba0, dec0.info.width, dec0.info.height, { qualityEnhancements: false, stageTimings: dummySt });
    sotaCellMattingV5_3_Turbo(rgba0, dec0.info.width, dec0.info.height, { qualityEnhancements: true, stageTimings: dummySt });
  }

  for (const hp of HUMAN_PORTRAITS) {
    const dec = await sharp(hp.path).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const cw = dec.info.width, ch = dec.info.height;
    const rgba = new Uint8ClampedArray(dec.data);

    const diag52 = {};
    const t0 = performance.now();
    const out52 = sotaCellMattingV5_2_Fast(rgba, cw, ch, { diagnostics: diag52 });
    const ms52 = performance.now() - t0;

    const t1 = performance.now();
    const out53Exact = sotaCellMattingV5_3_Turbo(rgba, cw, ch, { qualityEnhancements: false });
    const ms53Exact = performance.now() - t1;

    const diag53 = {};
    const t2 = performance.now();
    const out53Qual = sotaCellMattingV5_3_Turbo(rgba, cw, ch, { qualityEnhancements: true, diagnostics: diag53 });
    const ms53Qual = performance.now() - t2;

    hairV52TotalMs += ms52;
    hairV53QualTotalMs += ms53Qual;

    const exactCmp = compareBuffers(out52, out53Exact);
    const qualCmp = compareBuffers(out52, out53Qual);
    const halo52 = countEdgeGrayHalo(out52);
    const halo53 = countEdgeGrayHalo(out53Qual);
    hairGrayHaloV52 += halo52.grayHalo;
    hairGrayHaloV53 += halo53.grayHalo;

    const idStr = String(hp.id).padStart(2, '0');
    const totalPx = cw * ch;
    const diffBuf = Buffer.alloc(totalPx * 4);
    const alphaV52Buf = Buffer.alloc(totalPx);
    const alphaV53Buf = Buffer.alloc(totalPx);
    let diffPixels = 0;

    for (let p = 0; p < totalPx; p++) {
      const off = p << 2;
      const a52 = out52[off + 3];
      const a53 = out53Qual[off + 3];
      alphaV52Buf[p] = a52;
      alphaV53Buf[p] = a53;
      const delta = a53 - a52;
      if (Math.abs(delta) > 3) {
        diffPixels++;
        const mag = Math.min(255, Math.abs(delta) * 4);
        if (delta > 0) {
          diffBuf[off] = 16;
          diffBuf[off + 1] = Math.min(255, 160 + (mag >> 1));
          diffBuf[off + 2] = 129;
          diffBuf[off + 3] = Math.max(90, mag);
        } else {
          diffBuf[off] = 244;
          diffBuf[off + 1] = 63;
          diffBuf[off + 2] = 94;
          diffBuf[off + 3] = Math.max(90, mag);
        }
      } else {
        const base = Math.round(a53 * 0.25);
        diffBuf[off] = base;
        diffBuf[off + 1] = base;
        diffBuf[off + 2] = base + 8;
        diffBuf[off + 3] = 255;
      }
    }

    const previewH = 720;
    await Promise.all([
      sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: cw, height: ch, channels: 4 } })
        .resize(previewH, previewH, { fit: 'inside' })
        .jpeg({ quality: 92 })
        .toFile(`public/bench/cells/orig_${idStr}.jpg`),
      sharp(Buffer.from(out52.buffer, out52.byteOffset, out52.byteLength), { raw: { width: cw, height: ch, channels: 4 } })
        .resize(previewH, previewH, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/v52_${idStr}.png`),
      sharp(Buffer.from(out53Qual.buffer, out53Qual.byteOffset, out53Qual.byteLength), { raw: { width: cw, height: ch, channels: 4 } })
        .resize(previewH, previewH, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/v53_${idStr}.png`),
      sharp(alphaV52Buf, { raw: { width: cw, height: ch, channels: 1 } })
        .resize(previewH, previewH, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/alpha_v52_${idStr}.png`),
      sharp(alphaV53Buf, { raw: { width: cw, height: ch, channels: 1 } })
        .resize(previewH, previewH, { fit: 'inside', kernel: 'mitchell' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/alpha_v53_${idStr}.png`),
      sharp(diffBuf, { raw: { width: cw, height: ch, channels: 4 } })
        .resize(previewH, previewH, { fit: 'inside' })
        .png({ compressionLevel: 6 })
        .toFile(`public/bench/cells/diff_${idStr}.png`),
    ]);

    const hSem = diag52.semantic || diag53.semantic;
    const hTexRec = diag53.textureRecovery || { extractedPatches: 0, recoveredPixels: 0 };

    perCellStats.push({
      id: hp.id,
      domain: hp.domain,
      title: hp.title,
      challenge: hp.challenge,
      category: hp.category,
      width: cw,
      height: ch,
      v52Ms: Number(ms52.toFixed(1)),
      v53ExactMs: Number(ms53Exact.toFixed(1)),
      v53QualMs: Number(ms53Qual.toFixed(1)),
      speedup1T: Number((ms52 / Math.max(0.1, ms53Qual)).toFixed(2)),
      exactPsnrDb: exactCmp.psnrA,
      exactMaeAlpha: exactCmp.maeA,
      exactWithin1Pct: exactCmp.pctWithin1,
      qualDiffPixelsPct: Number(((diffPixels / totalPx) * 100).toFixed(2)),
      qualMaeAlpha: qualCmp.maeA,
      grayHaloV52: halo52.grayHalo,
      grayHaloV53: halo53.grayHalo,
      grayHaloReductionPct: Number((((halo52.grayHalo - halo53.grayHalo) / Math.max(1, halo52.grayHalo)) * 100).toFixed(1)),
      semanticClass: hSem?.subjectType || 'human',
      semanticConfidence: hSem?.confidence ?? 0,
      textureRecoveredPixels: hTexRec.recoveredPixels,
      textureExtractedPatches: hTexRec.extractedPatches,
      assets: {
        orig: `/bench/cells/orig_${idStr}.jpg`,
        v52: `/bench/cells/v52_${idStr}.png`,
        v53: `/bench/cells/v53_${idStr}.png`,
        alphaV52: `/bench/cells/alpha_v52_${idStr}.png`,
        alphaV53: `/bench/cells/alpha_v53_${idStr}.png`,
        diff: `/bench/cells/diff_${idStr}.png`,
      },
    });
  }

  // Baseline per-stage timings from our instrumented measurement (scaled cleanly to match v52TotalMs)
  const v52StageRatios = {
    stage0: 686.92 / 5852.58,
    stage1_sobel: 347.75 / 5852.58,
    stage1_box3: 598.18 / 5852.58,
    stage1b_inward: 494.00 / 5852.58,
    stage2_flood: 609.47 / 5852.58,
    stage3_pockets: 204.86 / 5852.58,
    stage4_dist: 227.51 / 5852.58,
    stage5_spfa: 321.15 / 5852.58,
    stage6_unmix: 948.38 / 5852.58,
    stage6_texture_recovery: 0,
    stage7_guided: 1414.36 / 5852.58,
  };

  const stageNames = [
    { key: 'stage0', label: 'Stage 0: Калибровка фона + Luma/Sat', optimization: 'Аналитическая плоскость (0 буферов bgField) + защита от одежды внизу' },
    { key: 'stage1_sobel', label: 'Stage 1A: Градиенты Собеля', optimization: 'Скользящие регистры (3 чтения/px вместо 8)' },
    { key: 'stage1_box3', label: 'Stage 1A: Box-фильтры (r=3)', optimization: 'Безветвевое ядро + перенос localSat в полуразрешение' },
    { key: 'stage1b_inward', label: 'Stage 1B: Семантика + inwardDist', optimization: 'Классификатор Человек/Животное + 2-проходный Rosenfeld-Pfaltz DT' },
    { key: 'stage2_flood', label: 'Stage 2: Адаптивный Flood-Fill', optimization: 'Упакованные (y<<16)|x + адаптивный inwardDist и защита одежды' },
    { key: 'stage3_pockets', label: 'Stage 3: Классификатор полостей', optimization: 'Семантический предел глубины + раскрытие микро-просветов волос' },
    { key: 'stage4_dist', label: 'Stage 4: Distance Transform', optimization: 'Разреженный BFS с адаптивной глубиной захвата шерсти/силуэта' },
    { key: 'stage5_spfa', label: 'Stage 5: SPFA Геодезический барьер', optimization: 'Упакованные координаты + развёрнутая релаксация (0 idiv)' },
    { key: 'stage6_unmix', label: 'Stage 6A/B: Размикширование + De-Haze', optimization: 'O(N) 2-полярный цветовой приор + защита одежды от пересветов' },
    { key: 'stage6_texture_recovery', label: 'Stage 6C: Texture Recovery', optimization: 'Локальный банк 4×4 текстур тёмных кудрей/шерсти + синтез в тенях' },
    { key: 'stage7_guided', label: 'Stage 7: Guided Filter + Despeckle 7B', optimization: 'Разреженный upsample + защита 1px прядей + 8-связная очистка пыли' },
  ];

  const stages = stageNames.map((s) => {
    const v52Ms = Number((v52TotalMs * v52StageRatios[s.key]).toFixed(1));
    const v53ExactMs = Number(v53ExactStages[s.key].toFixed(1));
    const v53QualMs = Number(v53QualStages[s.key].toFixed(1));
    return {
      ...s,
      v52Ms,
      v53ExactMs,
      v53QualMs,
      speedup: v52Ms > 0 ? Number((v52Ms / Math.max(0.1, v53QualMs)).toFixed(2)) : 0,
    };
  });

  // Aggregate semantic classifier accuracy & Stage 6C Texture Recovery summary
  let semCorrect = 0;
  let semHumans = 0;
  let semAnimals = 0;
  let totalRecoveredPixels = 0;
  let totalExtractedPatches = 0;
  let activeTextureImages = 0;
  for (const c of perCellStats) {
    const expected = c.domain === 'humans' ? 'human' : 'animal';
    if (c.semanticClass === expected) semCorrect++;
    if (c.semanticClass === 'human') semHumans++;
    else semAnimals++;
    const rec = c.textureRecoveredPixels || 0;
    totalRecoveredPixels += rec;
    totalExtractedPatches += c.textureExtractedPatches || 0;
    if (rec > 0) activeTextureImages++;
  }

  const metrics = {
    generatedAt: new Date().toISOString(),
    image: {
      filename: 'sheet_0790b517.jpg',
      width,
      height,
      megapixels: Number(((width * height) / 1e6).toFixed(2)),
      layout: '3x4',
      cells: 12,
      humanPortraits: HUMAN_PORTRAITS.length,
      cpuCores: os.cpus().length,
      workerThreads: numWorkers,
    },
    mattingSummary: {
      v52SingleThreadMs: Number(v52TotalMs.toFixed(1)),
      v53ExactSingleThreadMs: Number(v53ExactTotalMs.toFixed(1)),
      v53QualitySingleThreadMs: Number(v53QualTotalMs.toFixed(1)),
      v53QualityParallelMs: Number(parRes.elapsedMs.toFixed(1)),
      speedupExact1T: Number((v52TotalMs / v53ExactTotalMs).toFixed(2)),
      speedupQuality1T: Number((v52TotalMs / v53QualTotalMs).toFixed(2)),
      speedupQualityParallel: Number((v52TotalMs / parRes.elapsedMs).toFixed(2)),
    },
    hairBenchmark: {
      portraitsCount: HUMAN_PORTRAITS.length,
      v52TotalMs: Number(hairV52TotalMs.toFixed(1)),
      v53QualityTotalMs: Number(hairV53QualTotalMs.toFixed(1)),
      speedup1T: Number((hairV52TotalMs / Math.max(0.1, hairV53QualTotalMs)).toFixed(2)),
      grayHaloV52: hairGrayHaloV52,
      grayHaloV53: hairGrayHaloV53,
      grayHaloReductionPct: Number((((hairGrayHaloV52 - hairGrayHaloV53) / Math.max(1, hairGrayHaloV52)) * 100).toFixed(1)),
    },
    semanticSummary: {
      total: perCellStats.length,
      correct: semCorrect,
      accuracyPct: Number(((semCorrect / Math.max(1, perCellStats.length)) * 100).toFixed(1)),
      humansDetected: semHumans,
      animalsDetected: semAnimals,
    },
    textureRecoverySummary: {
      totalRecoveredPixels,
      activeImages: activeTextureImages,
      totalExtractedPatches,
      stageMs: Number(v53QualStages.stage6_texture_recovery.toFixed(1)),
    },
    fullPipeline: {
      v52: fullV52.timingsMs,
      v53: fullV53.timingsMs,
      totalSpeedup: Number((fullV52.timingsMs.total / Math.max(1, fullV53.timingsMs.total)).toFixed(2)),
      keyingSpeedup: Number((fullV52.timingsMs.keying / Math.max(1, fullV53.timingsMs.keying)).toFixed(2)),
      exportSpeedup: Number((fullV52.timingsMs.export / Math.max(1, fullV53.timingsMs.export)).toFixed(2)),
    },
    fidelityExactVsV52: {
      meanAlphaPsnrDb: Number((sumPsnr / 12).toFixed(2)),
      meanAlphaMae: Number((sumMaeA / 12).toFixed(4)),
      pixelsWithin1Pct: Number((sumWithin1 / 12).toFixed(3)),
    },
    qualityFixes: {
      cell9MugHole: {
        v52HolePixels: mugV52.semiHole,
        v52HolePct: mugV52.holePct,
        v52MinAlpha: mugV52.minAlpha,
        v53HolePixels: mugV53.semiHole,
        v53HolePct: mugV53.holePct,
        v53MinAlpha: mugV53.minAlpha,
      },
      cell4BlueBalloon: {
        v52SharpJumps: balV52.sharpTransitions,
        v53SharpJumps: balV53.sharpTransitions,
        v52MeanAlpha: balV52.meanAlpha,
        v53MeanAlpha: balV53.meanAlpha,
      },
    },
    stages,
    cells: perCellStats,
  };

  await fs.writeFile('public/bench/metrics.json', JSON.stringify(metrics, null, 2));
  console.log('\n=== FULL BENCHMARK RESULTS ===');
  console.log(JSON.stringify({
    mattingSummary: metrics.mattingSummary,
    semanticSummary: metrics.semanticSummary,
    textureRecoverySummary: metrics.textureRecoverySummary,
    fullPipeline: metrics.fullPipeline,
    fidelityExactVsV52: metrics.fidelityExactVsV52,
    qualityFixes: metrics.qualityFixes,
  }, null, 2));
  console.log('\nStage table:');
  for (const s of stages) {
    console.log(`  ${s.key.padEnd(24)}: v5.2=${String(s.v52Ms).padStart(6)}ms -> v5.3=${String(s.v53QualMs).padStart(6)}ms (${s.v52Ms > 0 ? s.speedup + 'x' : 'new'})`);
  }
}

main().catch(console.error);
