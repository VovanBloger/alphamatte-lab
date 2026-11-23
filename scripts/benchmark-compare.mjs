import sharp from 'sharp';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { sotaCellMattingV5_2_Fast } from '../sheet-processor/index.v5.2.mjs';
import { sotaCellMattingV5_3_Turbo } from '../sheet-processor/v53-matting.mjs';

const INPUT_IMAGE = path.resolve('public/assets/aistudio/sheet_0790b517.jpg');
const WORKER_PATH = path.resolve('sheet-processor/matting-worker.mjs');

async function runParallelV53(cells, qualityEnhancements, numWorkers) {
  const workers = Array.from({ length: numWorkers }, () => new Worker(WORKER_PATH));
  const results = new Array(cells.length);
  const tStart = performance.now();

  let nextIdx = 0;
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          const dispatchNext = () => {
            if (nextIdx >= cells.length) {
              resolve();
              return;
            }
            const idx = nextIdx++;
            const cell = cells[idx];
            // Copy cell buffer so it can be transferred zero-copy
            const copy = new Uint8ClampedArray(cell.cellRgba);
            worker.postMessage(
              {
                jobId: idx,
                buffer: copy.buffer,
                cw: cell.cw,
                ch: cell.ch,
                qualityEnhancements,
                gutter: 0,
              },
              [copy.buffer]
            );
          };
          worker.on('message', (msg) => {
            results[msg.jobId] = new Uint8ClampedArray(msg.buffer);
            dispatchNext();
          });
          worker.on('error', reject);
          dispatchNext();
        })
    )
  );
  const elapsedMs = performance.now() - tStart;
  await Promise.all(workers.map((w) => w.terminate()));
  return { elapsedMs, results };
}

function compareBuffers(refArr, testArr) {
  const totalPx = refArr.length >> 2;
  let sumAbsA = 0;
  let sumSqA = 0;
  let sumAbsRgb = 0;
  let within1 = 0;
  let exact0 = 0;
  let maxDiffA = 0;
  let visibleCount = 0;

  for (let i = 0; i < totalPx; i++) {
    const off = i << 2;
    const a1 = refArr[off + 3];
    const a2 = testArr[off + 3];
    const da = Math.abs(a1 - a2);
    sumAbsA += da;
    sumSqA += da * da;
    if (da > maxDiffA) maxDiffA = da;
    if (da === 0) exact0++;
    if (da <= 1) within1++;
    if (a1 > 10 && a2 > 10) {
      visibleCount++;
      sumAbsRgb +=
        (Math.abs(refArr[off] - testArr[off]) +
          Math.abs(refArr[off + 1] - testArr[off + 1]) +
          Math.abs(refArr[off + 2] - testArr[off + 2])) /
        3;
    }
  }
  const maeA = sumAbsA / totalPx;
  const mseA = sumSqA / totalPx;
  const psnrA = mseA > 0 ? 10 * Math.log10((255 * 255) / mseA) : 99.9;
  const maeRgb = visibleCount > 0 ? sumAbsRgb / visibleCount : 0;
  return {
    maeA,
    psnrA,
    maeRgb,
    pctExact: (exact0 / totalPx) * 100,
    pctWithin1: (within1 / totalPx) * 100,
    maxDiffA,
  };
}

function measureMugSolidity(cellData, cw, ch) {
  // Cell 9 (index 8): coffee mug lies roughly in x: [0.32..0.68], y: [0.64..0.92]
  const x0 = Math.floor(cw * 0.34);
  const x1 = Math.floor(cw * 0.66);
  const y0 = Math.floor(ch * 0.68);
  const y1 = Math.floor(ch * 0.90);
  let total = 0;
  let semiHole = 0;
  let minAlpha = 255;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = cellData[(y * cw + x) * 4 + 3];
      total++;
      if (a < 245 && a > 10) semiHole++;
      if (a < minAlpha) minAlpha = a;
    }
  }
  return { total, semiHole, holePct: (semiHole / total) * 100, minAlpha };
}

function measureBalloonStats(cellData, cw, ch) {
  // Cell 4 (index 3): blue balloon lies roughly in x: [0.55..0.93], y: [0.06..0.46]
  const x0 = Math.floor(cw * 0.58);
  const x1 = Math.floor(cw * 0.90);
  const y0 = Math.floor(ch * 0.10);
  const y1 = Math.floor(ch * 0.42);
  let count = 0;
  let sumA = 0;
  let sharpTransitions = 0;
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
  return { meanAlpha: count ? sumA / count : 0, sharpTransitions };
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
        const dstOff = y * cw * 4;
        cellRgba.set(decoded.data.subarray(srcOff, srcOff + cw * 4), dstOff);
      }
      cells.push({ index: r * columns + c + 1, r, c, left, top, cw, ch, cellRgba });
    }
  }

  console.log(`Benchmarking 12 cells (${width}x${height} = ${(width * height / 1e6).toFixed(2)} MP) on ${os.cpus().length} CPUs...\n`);

  // Warmup
  for (const cell of cells) {
    sotaCellMattingV5_2_Fast(cell.cellRgba, cell.cw, cell.ch);
    sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, { qualityEnhancements: false });
    sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, { qualityEnhancements: true });
  }

  // 1. v5.2-FAST (3 runs median)
  const v52Times = [];
  let v52Out = [];
  for (let iter = 0; iter < 3; iter++) {
    const t0 = performance.now();
    v52Out = cells.map((cell) => sotaCellMattingV5_2_Fast(cell.cellRgba, cell.cw, cell.ch));
    v52Times.push(performance.now() - t0);
  }
  v52Times.sort((a, b) => a - b);
  const v52Median = v52Times[1];

  // 2. v5.3-Exact (single-thread, 3 runs median + stage breakdown)
  const v53ExactTimes = [];
  let v53ExactOut = [];
  const exactStages = {
    stage0: 0, stage1_sobel: 0, stage1_box3: 0, stage1b_inward: 0,
    stage2_flood: 0, stage3_pockets: 0, stage4_dist: 0, stage5_spfa: 0,
    stage6_unmix: 0, stage7_guided: 0,
  };
  for (let iter = 0; iter < 3; iter++) {
    const st = iter === 2 ? exactStages : null;
    const t0 = performance.now();
    v53ExactOut = cells.map((cell) =>
      sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, {
        qualityEnhancements: false,
        stageTimings: st,
      })
    );
    v53ExactTimes.push(performance.now() - t0);
  }
  v53ExactTimes.sort((a, b) => a - b);
  const v53ExactMedian = v53ExactTimes[1];

  // 3. v5.3-Quality+ (single-thread, 3 runs median + stage breakdown)
  const v53QualTimes = [];
  let v53QualOut = [];
  const qualStages = {
    stage0: 0, stage1_sobel: 0, stage1_box3: 0, stage1b_inward: 0,
    stage2_flood: 0, stage3_pockets: 0, stage4_dist: 0, stage5_spfa: 0,
    stage6_unmix: 0, stage7_guided: 0,
  };
  for (let iter = 0; iter < 3; iter++) {
    const st = iter === 2 ? qualStages : null;
    const t0 = performance.now();
    v53QualOut = cells.map((cell) =>
      sotaCellMattingV5_3_Turbo(cell.cellRgba, cell.cw, cell.ch, {
        qualityEnhancements: true,
        stageTimings: st,
      })
    );
    v53QualTimes.push(performance.now() - t0);
  }
  v53QualTimes.sort((a, b) => a - b);
  const v53QualMedian = v53QualTimes[1];

  // 4. v5.3-Quality+ Parallel (4 worker threads, 3 runs median)
  const numWorkers = Math.min(4, os.cpus().length);
  const parTimes = [];
  for (let iter = 0; iter < 3; iter++) {
    const res = await runParallelV53(cells, true, numWorkers);
    parTimes.push(res.elapsedMs);
  }
  parTimes.sort((a, b) => a - b);
  const v53ParMedian = parTimes[1];

  console.log('=== SPEEDUP SUMMARY (12 cells, 17.20 MP) ===');
  console.log(`  v5.2-FAST (1 thread)            : ${v52Median.toFixed(1)} ms (1.00x)`);
  console.log(`  v5.3-Exact (1 thread)           : ${v53ExactMedian.toFixed(1)} ms (${(v52Median / v53ExactMedian).toFixed(2)}x)`);
  console.log(`  v5.3-Quality+ (1 thread)        : ${v53QualMedian.toFixed(1)} ms (${(v52Median / v53QualMedian).toFixed(2)}x)`);
  console.log(`  v5.3-Quality+ (${numWorkers} worker threads): ${v53ParMedian.toFixed(1)} ms (${(v52Median / v53ParMedian).toFixed(2)}x)`);

  console.log('\n=== v5.3-Quality+ STAGE BREAKDOWN (12 cells, ms) ===');
  for (const [k, v] of Object.entries(qualStages)) {
    console.log(`  ${k.padEnd(18)}: ${v.toFixed(2)} ms`);
  }

  // Fidelity check: v5.3-Exact vs v5.2-FAST
  let avgPsnr = 0, avgMaeA = 0, avgWithin1 = 0;
  for (let i = 0; i < cells.length; i++) {
    const cmp = compareBuffers(v52Out[i], v53ExactOut[i]);
    avgPsnr += cmp.psnrA;
    avgMaeA += cmp.maeA;
    avgWithin1 += cmp.pctWithin1;
  }
  console.log('\n=== FIDELITY CHECK: v5.3-Exact vs v5.2-FAST (across all 12 cells) ===');
  console.log(`  Mean Alpha MAE        : ${(avgMaeA / 12).toFixed(4)} / 255`);
  console.log(`  Mean Alpha PSNR       : ${(avgPsnr / 12).toFixed(2)} dB`);
  console.log(`  Pixels within +-1/255 : ${(avgWithin1 / 12).toFixed(3)}%`);

  // Quality defect checks: Mug hole (Cell 9) & Blue Balloon patchiness (Cell 4)
  const mugV52 = measureMugSolidity(v52Out[8], cells[8].cw, cells[8].ch);
  const mugV53 = measureMugSolidity(v53QualOut[8], cells[8].cw, cells[8].ch);
  const balV52 = measureBalloonStats(v52Out[3], cells[3].cw, cells[3].ch);
  const balV53 = measureBalloonStats(v53QualOut[3], cells[3].cw, cells[3].ch);

  console.log('\n=== QUALITY FIX VERIFICATION ===');
  console.log(`  Cell 9 Coffee Mug semi-transparent hole pixels: v5.2 = ${mugV52.semiHole} (${mugV52.holePct.toFixed(2)}%, minAlpha=${mugV52.minAlpha}) -> v5.3-Quality+ = ${mugV53.semiHole} (${mugV53.holePct.toFixed(2)}%, minAlpha=${mugV53.minAlpha})`);
  console.log(`  Cell 4 Blue Balloon sharp alpha jumps (>18/255): v5.2 = ${balV52.sharpTransitions} -> v5.3-Quality+ = ${balV53.sharpTransitions}`);

  // Render full v5.3-Quality+ alpha mask & preview to inspect visually!
  const fullAlpha = Buffer.alloc(width * height);
  const fullRgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < cells.length; i++) {
    const { left, top, cw, ch } = cells[i];
    const out = v53QualOut[i];
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const sOff = (y * cw + x) * 4;
        const dIdx = (top + y) * width + (left + x);
        fullAlpha[dIdx] = out[sOff + 3];
        const dOff = dIdx * 4;
        fullRgba[dOff] = out[sOff];
        fullRgba[dOff + 1] = out[sOff + 1];
        fullRgba[dOff + 2] = out[sOff + 2];
        fullRgba[dOff + 3] = out[sOff + 3];
      }
    }
  }

  await fs.mkdir('public/bench/v53', { recursive: true });
  await sharp(fullAlpha, { raw: { width, height, channels: 1 } })
    .resize(1200)
    .png({ compressionLevel: 8 })
    .toFile('public/bench/v53/alpha-mask.png');

  // Render checkerboard preview of v5.3
  const prevW = 1200;
  const prevH = Math.round((height / width) * prevW);
  const resizedV53 = await sharp(fullRgba, { raw: { width, height, channels: 4 } })
    .resize(prevW, prevH)
    .raw()
    .toBuffer();
  const checker = Buffer.alloc(prevW * prevH * 4);
  for (let y = 0; y < prevH; y++) {
    for (let x = 0; x < prevW; x++) {
      const isLight = (((x >> 4) + (y >> 4)) & 1) === 0;
      const bg = isLight ? 236 : 202;
      const off = (y * prevW + x) * 4;
      const a = resizedV53[off + 3] / 255;
      checker[off] = Math.round(resizedV53[off] * a + bg * (1 - a));
      checker[off + 1] = Math.round(resizedV53[off + 1] * a + bg * (1 - a));
      checker[off + 2] = Math.round(resizedV53[off + 2] * a + bg * (1 - a));
      checker[off + 3] = 255;
    }
  }
  await sharp(checker, { raw: { width: prevW, height: prevH, channels: 4 } })
    .png({ compressionLevel: 8 })
    .toFile('public/bench/v53/preview.png');

  console.log('\nSaved visual inspection files: public/bench/v53/preview.png & public/bench/v53/alpha-mask.png');
}

main().catch(console.error);
