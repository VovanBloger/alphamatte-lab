import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { processStickerSheet, sotaCellMattingV5_2_Fast } from '../sheet-processor/index.v5.2.mjs';

const INPUT_IMAGE = path.resolve('public/assets/aistudio/sheet_0790b517.jpg');

function clamp(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Instrumented version of v5.2-FAST to measure exact per-stage breakdown across all 12 cells
let cachedWs = null;
function getWorkspace(width, height) {
  const total = width * height;
  const hw = width >> 1;
  const hh = height >> 1;
  const hTotal = hw * hh;
  if (cachedWs && cachedWs.width === width && cachedWs.height === height) {
    return cachedWs;
  }
  cachedWs = {
    width, height, total, hw, hh, hTotal,
    bgFieldR: new Float32Array(total),
    bgFieldG: new Float32Array(total),
    bgFieldB: new Float32Array(total),
    bgLum: new Float32Array(total),
    distToBg: new Float32Array(total),
    lum: new Float32Array(total),
    sat: new Float32Array(total),
    grad: new Float32Array(total),
    clampedGrad: new Float32Array(total),
    tmpBuf: new Float32Array(total),
    colSum: new Float32Array(width),
    localTexture: new Float32Array(total),
    localTextureClamped: new Float32Array(total),
    localSat: new Float32Array(total),
    inwardDist: new Uint8Array(total),
    bgState: new Uint8Array(total),
    visited: new Uint8Array(total),
    distFromBg: new Uint8Array(total),
    queue: new Int32Array(total),
    contourBarrier: new Float32Array(total),
    rawAlpha: new Float32Array(total),
    hRawSeed: new Float32Array(hTotal),
    hTmp: new Float32Array(hTotal),
    hColSum: new Float32Array(hw),
    hBufA: new Float32Array(hTotal),
    hBufB: new Float32Array(hTotal),
    hBufC: new Float32Array(hTotal),
    hBufD: new Float32Array(hTotal),
    hSubI: new Float32Array(hTotal),
    hSubP: new Float32Array(hTotal),
    hClosedHull: new Uint8Array(hTotal),
    hIsExterior: new Uint8Array(hTotal),
    hInward: new Uint8Array(hTotal),
    hQueue: new Int32Array(hTotal),
  };
  return cachedWs;
}

function boxFilterRowMajor(src, dst, tmp, colSum, width, height, radius) {
  const norm = 1 / (2 * radius + 1);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let sum = src[rowOff] * (radius + 1);
    for (let x = 1; x <= radius; x++) {
      sum += src[rowOff + (x < width ? x : width - 1)];
    }
    for (let x = 0; x < width; x++) {
      tmp[rowOff + x] = sum * norm;
      const outX = x - radius;
      const inX = x + radius + 1;
      sum += src[rowOff + (inX < width ? inX : width - 1)] - src[rowOff + (outX > 0 ? outX : 0)];
    }
  }
  for (let x = 0; x < width; x++) {
    colSum[x] = tmp[x] * (radius + 1);
  }
  for (let y = 1; y <= radius; y++) {
    const rOff = (y < height ? y : height - 1) * width;
    for (let x = 0; x < width; x++) {
      colSum[x] += tmp[rOff + x];
    }
  }
  for (let y = 0; y < height; y++) {
    const curOff = y * width;
    const outY = y - radius;
    const inY = y + radius + 1;
    const outOff = (outY > 0 ? outY : 0) * width;
    const inOff = (inY < height ? inY : height - 1) * width;
    for (let x = 0; x < width; x++) {
      dst[curOff + x] = colSum[x] * norm;
      colSum[x] += tmp[inOff + x] - tmp[outOff + x];
    }
  }
  return dst;
}

function fastGuidedFilterHe2015(I, p, outQ, ws, eps) {
  const { width, height, hw, hh, hTotal, hSubI, hSubP, hTmp, hColSum, hBufA, hBufB, hBufC, hBufD } = ws;
  for (let hy = 0; hy < hh; hy++) {
    const y0 = hy << 1;
    const r0 = y0 * width;
    const r1 = r0 + width;
    const hOff = hy * hw;
    for (let hx = 0; hx < hw; hx++) {
      const x0 = hx << 1;
      const i00 = r0 + x0, i01 = i00 + 1, i10 = r1 + x0, i11 = i10 + 1;
      const ii = (I[i00] + I[i01] + I[i10] + I[i11]) * 0.25;
      const pp = (p[i00] + p[i01] + p[i10] + p[i11]) * 0.25;
      const hIdx = hOff + hx;
      hSubI[hIdx] = ii;
      hSubP[hIdx] = pp;
      hBufC[hIdx] = ii * pp;
      hBufD[hIdx] = ii * ii;
    }
  }
  const meanI = boxFilterRowMajor(hSubI, hBufA, hTmp, hColSum, hw, hh, 1);
  const meanP = boxFilterRowMajor(hSubP, hBufB, hTmp, hColSum, hw, hh, 1);
  const meanIp = boxFilterRowMajor(hBufC, hBufC, hTmp, hColSum, hw, hh, 1);
  const meanII = boxFilterRowMajor(hBufD, hBufD, hTmp, hColSum, hw, hh, 1);
  for (let i = 0; i < hTotal; i++) {
    const mI = meanI[i];
    const mP = meanP[i];
    const covIp = meanIp[i] - mI * mP;
    const varI = meanII[i] - mI * mI;
    const a = covIp / ((varI > 0 ? varI : 0) + eps);
    hBufA[i] = a;
    hBufB[i] = mP - a * mI;
  }
  const meanA = boxFilterRowMajor(hBufA, hBufC, hTmp, hColSum, hw, hh, 1);
  const meanB = boxFilterRowMajor(hBufB, hBufD, hTmp, hColSum, hw, hh, 1);
  const maxHx = hw - 1;
  const maxHy = hh - 1;
  for (let y = 0; y < height; y++) {
    const hy0 = y >> 1;
    const hy1 = hy0 < maxHy ? hy0 + 1 : maxHy;
    const wy = (y & 1) * 0.5;
    const omy = 1 - wy;
    const hOff0 = hy0 * hw;
    const hOff1 = hy1 * hw;
    const rOff = y * width;
    for (let x = 0; x < width; x++) {
      const hx0 = x >> 1;
      const hx1 = hx0 < maxHx ? hx0 + 1 : maxHx;
      const wx = (x & 1) * 0.5;
      const omx = 1 - wx;
      const i00 = hOff0 + hx0, i01 = hOff0 + hx1;
      const i10 = hOff1 + hx0, i11 = hOff1 + hx1;
      const aUp = omy * (omx * meanA[i00] + wx * meanA[i01]) + wy * (omx * meanA[i10] + wx * meanA[i11]);
      const bUp = omy * (omx * meanB[i00] + wx * meanB[i01]) + wy * (omx * meanB[i10] + wx * meanB[i11]);
      const idx = rOff + x;
      const v = aUp * I[idx] + bUp;
      outQ[idx] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return outQ;
}

function buildSubjectInwardDistanceFast(ws, coreBgTol) {
  const {
    width, height, hw, hh, hTotal,
    distToBg, sat, grad, localTextureClamped, localSat,
    hRawSeed, hTmp, hColSum, hBufA, hBufB, hClosedHull, hIsExterior, hInward, hQueue, inwardDist
  } = ws;

  hRawSeed.fill(0);
  const distThresh = coreBgTol + 6.5;
  for (let hy = 9; hy < hh; hy++) {
    const y = hy << 1;
    const rowOff = y * width;
    const hRowOff = hy * hw;
    for (let hx = 9; hx < hw - 9; hx++) {
      const i = rowOff + (hx << 1);
      if (
        distToBg[i] > distThresh ||
        sat[i] > 16.5 ||
        localSat[i] > 14.5 ||
        (grad[i] >= 2.3 && localTextureClamped[i] >= 3.2)
      ) {
        hRawSeed[hRowOff + hx] = 1.0;
      }
    }
  }
  const seedDensity = boxFilterRowMajor(hRawSeed, hBufA, hTmp, hColSum, hw, hh, 5);
  for (let i = 0; i < hTotal; i++) {
    hBufB[i] = seedDensity[i] > 0.54 ? 1.0 : 0.0;
  }
  const dil = boxFilterRowMajor(hBufB, hRawSeed, hTmp, hColSum, hw, hh, 5);
  for (let i = 0; i < hTotal; i++) {
    hBufB[i] = dil[i] > 0.36 ? 1.0 : 0.0;
  }
  const ero = boxFilterRowMajor(hBufB, hRawSeed, hTmp, hColSum, hw, hh, 5);
  hClosedHull.fill(0);
  for (let i = 0; i < hTotal; i++) {
    if (ero[i] > 0.64) hClosedHull[i] = 1;
  }
  let botLeft = hw, botRight = -1;
  const refY = Math.max(0, hh - 9);
  for (let hx = 10; hx < hw - 10; hx++) {
    if (hClosedHull[refY * hw + hx]) {
      if (hx < botLeft) botLeft = hx;
      if (hx > botRight) botRight = hx;
    }
  }
  if (botRight - botLeft > 30 && botRight - botLeft < hw * 0.9) {
    for (let hy = hh - 3; hy < hh; hy++) {
      const hOff = hy * hw;
      for (let hx = botLeft; hx <= botRight; hx++) {
        hClosedHull[hOff + hx] = 1;
      }
    }
  }
  hIsExterior.fill(0);
  let head = 0, tail = 0;
  const seedExt = (hx, hy) => {
    const idx = hy * hw + hx;
    if (hIsExterior[idx] === 0 && hClosedHull[idx] === 0) {
      hIsExterior[idx] = 1;
      hQueue[tail++] = idx;
    }
  };
  for (let hx = 0; hx < hw; hx++) {
    seedExt(hx, 0);
    if (hx < botLeft || hx > botRight) seedExt(hx, hh - 1);
  }
  for (let hy = 0; hy < hh; hy++) {
    seedExt(0, hy);
    seedExt(hw - 1, hy);
  }
  const flatBgThresh = coreBgTol * 0.9;
  for (let hy = 9; hy < hh - 9; hy++) {
    const y = hy << 1;
    const hOff = hy * hw;
    const rOff = y * width;
    for (let hx = 9; hx < hw - 9; hx++) {
      const idx = hOff + hx;
      if (hClosedHull[idx] === 0 && hIsExterior[idx] === 0 && seedDensity[idx] < 0.06 && distToBg[rOff + (hx << 1)] <= flatBgThresh) {
        hIsExterior[idx] = 1;
        hQueue[tail++] = idx;
      }
    }
  }
  const dxs = [-1, 1, 0, 0];
  const dys = [0, 0, -1, 1];
  while (head < tail) {
    const idx = hQueue[head++];
    const hx = idx % hw, hy = (idx - hx) / hw;
    for (let k = 0; k < 4; k++) {
      const nx = hx + dxs[k], ny = hy + dys[k];
      if (nx < 0 || nx >= hw || ny < 0 || ny >= hh) continue;
      const nIdx = ny * hw + nx;
      if (hIsExterior[nIdx] === 0 && hClosedHull[nIdx] === 0) {
        hIsExterior[nIdx] = 1;
        hQueue[tail++] = nIdx;
      }
    }
  }
  head = 0; tail = 0;
  for (let i = 0; i < hTotal; i++) {
    if (hIsExterior[i] === 1) {
      hInward[i] = 0;
      hQueue[tail++] = i;
    } else {
      hInward[i] = 127;
    }
  }
  const maxHalfInward = 26;
  while (head < tail) {
    const idx = hQueue[head++];
    const d = hInward[idx];
    if (d >= maxHalfInward) continue;
    const hx = idx % hw, hy = (idx - hx) / hw;
    for (let k = 0; k < 4; k++) {
      const nx = hx + dxs[k], ny = hy + dys[k];
      if (nx < 0 || nx >= hw || ny < 0 || ny >= hh) continue;
      const nIdx = ny * hw + nx;
      if (hInward[nIdx] === 127) {
        hInward[nIdx] = d + 1;
        hQueue[tail++] = nIdx;
      }
    }
  }
  for (let y = 0; y < height; y++) {
    const hy = Math.min(hh - 1, y >> 1);
    const hOff = hy * hw;
    const rOff = y * width;
    for (let x = 0; x < width; x++) {
      const hx = (x >> 1) < hw ? (x >> 1) : (hw - 1);
      inwardDist[rOff + x] = hInward[hOff + hx] << 1;
    }
  }
  return inwardDist;
}

function profileV5_2_Cell(rgba, width, height, stageAcc) {
  let t0 = performance.now();
  const data = new Uint8ClampedArray(rgba);
  const ws = getWorkspace(width, height);
  const {
    total, bgFieldR, bgFieldG, bgFieldB, bgLum, distToBg, lum, sat,
    grad, clampedGrad, tmpBuf, colSum, localTexture, localTextureClamped, localSat,
    bgState, visited, distFromBg, queue, contourBarrier, rawAlpha
  } = ws;

  // STAGE 0
  const refSamplesR = [], refSamplesG = [], refSamplesB = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 140));
  const isNeutralCandidate = (r, g, b) => {
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx - mn > 28) return false;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return l >= 75 && l <= 185;
  };
  for (const ins of [8, 14, 20]) {
    for (let x = ins; x < width - ins; x += step) {
      const off = (ins * width + x) * 4;
      if (isNeutralCandidate(data[off], data[off + 1], data[off + 2])) {
        refSamplesR.push(data[off]); refSamplesG.push(data[off + 1]); refSamplesB.push(data[off + 2]);
      }
    }
    const maxY = Math.floor(height * 0.65);
    for (let y = ins; y < maxY; y += step) {
      for (const x of [ins, width - 1 - ins]) {
        const off = (y * width + x) * 4;
        if (isNeutralCandidate(data[off], data[off + 1], data[off + 2])) {
          refSamplesR.push(data[off]); refSamplesG.push(data[off + 1]); refSamplesB.push(data[off + 2]);
        }
      }
    }
  }
  const median = arr => {
    if (!arr.length) return 122;
    const s = [...arr].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const refBgR = median(refSamplesR);
  const refBgG = median(refSamplesG);
  const refBgB = median(refSamplesB);
  const quadR = [[], [], [], []], quadG = [[], [], [], []], quadB = [[], [], [], []];
  const addQuadSample = (x, y) => {
    const off = (y * width + x) * 4;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const dr = r - refBgR, dg = g - refBgG, db = b - refBgB;
    if (dr * dr + dg * dg + db * db > 225.0) return;
    const q = (y < (height >> 1) ? 0 : 2) + (x < (width >> 1) ? 0 : 1);
    quadR[q].push(r); quadG[q].push(g); quadB[q].push(b);
  };
  for (const ins of [8, 14, 20]) {
    for (let x = ins; x < width - ins; x += step) {
      addQuadSample(x, ins);
      addQuadSample(x, height - 1 - ins);
    }
    for (let y = ins; y < height - ins; y += step) {
      addQuadSample(ins, y);
      addQuadSample(width - 1 - ins, y);
    }
  }
  const cR = quadR.map(a => a.length >= 10 ? median(a) : refBgR);
  const cG = quadG.map(a => a.length >= 10 ? median(a) : refBgG);
  const cB = quadB.map(a => a.length >= 10 ? median(a) : refBgB);
  const invW = 1 / Math.max(1, width - 1);
  const invH = 1 / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const omtY = 1 - ty;
    const r0 = omtY * cR[0] + ty * cR[2], r1 = omtY * cR[1] + ty * cR[3];
    const g0 = omtY * cG[0] + ty * cG[2], g1 = omtY * cG[1] + ty * cG[3];
    const b0 = omtY * cB[0] + ty * cB[2], b1 = omtY * cB[1] + ty * cB[3];
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const tx = x * invW;
      const idx = rowOff + x;
      const bR = r0 + tx * (r1 - r0);
      const bG = g0 + tx * (g1 - g0);
      const bB = b0 + tx * (b1 - b0);
      bgFieldR[idx] = bR; bgFieldG[idx] = bG; bgFieldB[idx] = bB;
      bgLum[idx] = 0.299 * bR + 0.587 * bG + 0.114 * bB;
      const off = idx << 2;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const dr = r - bR, dg = g - bG, db = b - bB;
      distToBg[idx] = Math.sqrt(dr * dr + dg * dg + db * db);
      lum[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      const meanD = (dr + dg + db) * 0.3333333;
      const sr = dr - meanD, sg = dg - meanD, sb = db - meanD;
      sat[idx] = Math.sqrt(sr * sr + sg * sg + sb * sb);
    }
  }
  const borderMargin = 16;
  const probeIn = 24;
  const stripBorderPixel = (x, y) => {
    const idx = y * width + x;
    const inX = clamp(x, probeIn, width - 1 - probeIn);
    const inY = clamp(y, probeIn, height - 1 - probeIn);
    const inIdx = inY * width + inX;
    if (sat[idx] < 24 && distToBg[inIdx] < 18.0 && sat[inIdx] < 16.0) {
      const off = idx << 2;
      data[off] = Math.round(bgFieldR[idx]);
      data[off + 1] = Math.round(bgFieldG[idx]);
      data[off + 2] = Math.round(bgFieldB[idx]);
      distToBg[idx] = 0;
      lum[idx] = bgLum[idx];
    }
  };
  for (let y = 0; y < borderMargin; y++) {
    for (let x = 0; x < width; x++) stripBorderPixel(x, y);
  }
  for (let y = height - borderMargin; y < height; y++) {
    for (let x = 0; x < width; x++) stripBorderPixel(x, y);
  }
  for (let y = borderMargin; y < height - borderMargin; y++) {
    for (let x = 0; x < borderMargin; x++) stripBorderPixel(x, y);
    for (let x = width - borderMargin; x < width; x++) stripBorderPixel(x, y);
  }
  const borderDists = [];
  for (let x = 10; x < width - 10; x += step) {
    if (distToBg[10 * width + x] < 25) borderDists.push(distToBg[10 * width + x]);
  }
  const noiseStd = Math.max(1.5, median(borderDists) * 1.4826);
  let t1 = performance.now();
  stageAcc.stage0 += (t1 - t0);

  // STAGE 1A: Sobel + 3 Box Filters
  grad.fill(0);
  clampedGrad.fill(0);
  for (let y = 1; y < height - 1; y++) {
    const rowOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = rowOff + x;
      const gx = -lum[idx - width - 1] + lum[idx - width + 1]
                 - 2 * lum[idx - 1] + 2 * lum[idx + 1]
                 - lum[idx + width - 1] + lum[idx + width + 1];
      const gy = -lum[idx - width - 1] - 2 * lum[idx - width] - lum[idx - width + 1]
                 + lum[idx + width - 1] + 2 * lum[idx + width] + lum[idx + width + 1];
      const g = Math.sqrt(gx * gx + gy * gy) * 0.25;
      grad[idx] = g;
      clampedGrad[idx] = g < 12.0 ? g : 12.0;
    }
  }
  let t1_sobel = performance.now();
  stageAcc.stage1_sobel += (t1_sobel - t1);

  boxFilterRowMajor(grad, localTexture, tmpBuf, colSum, width, height, 3);
  boxFilterRowMajor(clampedGrad, localTextureClamped, tmpBuf, colSum, width, height, 3);
  boxFilterRowMajor(sat, localSat, tmpBuf, colSum, width, height, 3);
  let t1_box = performance.now();
  stageAcc.stage1_box3 += (t1_box - t1_sobel);

  const coreBgTol = Math.max(13.5, Math.min(20.0, 9.5 + noiseStd * 2.2));
  const gapTol = coreBgTol + 11.0;

  // STAGE 1B: inwardDist
  const inwardDist = buildSubjectInwardDistanceFast(ws, coreBgTol);
  let t1b = performance.now();
  stageAcc.stage1b_inward += (t1b - t1_box);

  // STAGE 2: Exterior Flood-Fill
  bgState.fill(0);
  let head = 0, tail = 0;
  const trySeed = (x, y) => {
    const idx = y * width + x;
    if (bgState[idx] === 0 && distToBg[idx] <= coreBgTol) {
      bgState[idx] = 1;
      queue[tail++] = idx;
    }
  };
  for (const ins of [0, 4, 10, 18, 22]) {
    for (let x = ins; x < width - ins; x++) {
      trySeed(x, ins);
      trySeed(x, height - 1 - ins);
    }
    for (let y = ins; y < height - ins; y++) {
      trySeed(ins, y);
      trySeed(width - 1 - ins, y);
    }
  }
  const dxs = [-1, 1, 0, 0, -1, 1, -1, 1];
  const dys = [0, 0, -1, 1, -1, -1, 1, 1];
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width, y = (idx - x) / width;
    for (let k = 0; k < 4; k++) {
      const nx = x + dxs[k], ny = y + dys[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (bgState[nIdx] !== 0 || inwardDist[nIdx] >= 48) continue;
      const d = distToBg[nIdx];
      const lDiff = lum[nIdx] - bgLum[nIdx];
      const inOuterMargin = nx < 24 || nx >= width - 24 || ny < 24 || ny >= height - 24;
      if (d <= coreBgTol) {
        bgState[nIdx] = (!inOuterMargin && lDiff > 9.0 && sat[nIdx] < 16 && grad[nIdx] < 9.5 && localTexture[nIdx] >= 2.2) ? 2 : 1;
        queue[tail++] = nIdx;
      } else if (d <= gapTol && grad[nIdx] < 13.5 && sat[nIdx] < 14) {
        bgState[nIdx] = (!inOuterMargin && lDiff > 8.5 && localTexture[nIdx] >= 2.2) ? 2 : 3;
        queue[tail++] = nIdx;
      }
    }
  }
  let t2 = performance.now();
  stageAcc.stage2_flood += (t2 - t1b);

  // STAGE 3: Pocket Classifier
  for (let i = 0; i < total; i++) {
    visited[i] = (bgState[i] > 0 || inwardDist[i] >= 18) ? 1 : 0;
  }
  const pocketTol = coreBgTol + 9.5;
  const pocketSeeds = [];
  for (let i = 0; i < total; i++) {
    if (visited[i]) continue;
    if (distToBg[i] > pocketTol || sat[i] > 14 || localTextureClamped[i] > 4.2) {
      visited[i] = 1;
      continue;
    }
    let cHead = 0, cTail = 0;
    queue[cTail++] = i;
    visited[i] = 1;
    let sumDist = 0, minDist = Infinity, sumTex = 0;
    while (cHead < cTail) {
      const pIdx = queue[cHead++];
      const px = pIdx % width, py = (pIdx - px) / width;
      const d = distToBg[pIdx];
      sumDist += d;
      if (d < minDist) minDist = d;
      sumTex += localTextureClamped[pIdx];
      for (let k = 0; k < 4; k++) {
        const nx = px + dxs[k], ny = py + dys[k];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (bgState[nIdx] > 0 || inwardDist[nIdx] >= 18) continue;
        if (distToBg[nIdx] <= pocketTol && sat[nIdx] <= 14 && localTextureClamped[nIdx] <= 4.2) {
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            queue[cTail++] = nIdx;
          }
        }
      }
    }
    const area = cTail;
    if (area < 28) continue;
    if (minDist <= coreBgTol && (sumDist / area) <= coreBgTol + 5.5 && (sumTex / area) <= 3.4) {
      for (let k = 0; k < area; k++) {
        const pIdx = queue[k];
        bgState[pIdx] = 1;
        pocketSeeds.push(pIdx);
      }
    }
  }
  if (pocketSeeds.length > 0) {
    head = 0; tail = 0;
    for (let k = 0; k < pocketSeeds.length; k++) queue[tail++] = pocketSeeds[k];
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width, y = (idx - x) / width;
      for (let k = 0; k < 4; k++) {
        const nx = x + dxs[k], ny = y + dys[k];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (bgState[nIdx] !== 0 || inwardDist[nIdx] >= 48) continue;
        const d = distToBg[nIdx];
        const lDiff = lum[nIdx] - bgLum[nIdx];
        if (d <= coreBgTol) {
          bgState[nIdx] = (lDiff > 9.0 && sat[nIdx] < 16 && grad[nIdx] < 9.5 && localTexture[nIdx] >= 2.2) ? 2 : 1;
          queue[tail++] = nIdx;
        } else if (d <= gapTol && grad[nIdx] < 13.5 && sat[nIdx] < 14) {
          bgState[nIdx] = (lDiff > 8.5 && localTexture[nIdx] >= 2.2) ? 2 : 3;
          queue[tail++] = nIdx;
        }
      }
    }
  }
  let t3 = performance.now();
  stageAcc.stage3_pockets += (t3 - t2);

  // STAGE 4: Distance Transform
  const maxDepth = 12;
  distFromBg.fill(255);
  head = 0; tail = 0;
  for (let i = 0; i < total; i++) {
    if (bgState[i] === 1) distFromBg[i] = 0;
  }
  for (let y = 1; y < height - 1; y++) {
    const rOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = rOff + x;
      if (bgState[i] !== 1) {
        if (
          bgState[i - 1] === 1 || bgState[i + 1] === 1 ||
          bgState[i - width] === 1 || bgState[i + width] === 1 ||
          bgState[i - width - 1] === 1 || bgState[i - width + 1] === 1 ||
          bgState[i + width - 1] === 1 || bgState[i + width + 1] === 1
        ) {
          distFromBg[i] = 1;
          queue[tail++] = i;
        }
      }
    }
  }
  while (head < tail) {
    const idx = queue[head++];
    const d = distFromBg[idx];
    if (d >= maxDepth) continue;
    const x = idx % width, y = (idx - x) / width;
    for (let k = 0; k < 4; k++) {
      const nx = x + dxs[k], ny = y + dys[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (distFromBg[nIdx] === 255) {
        distFromBg[nIdx] = d + 1;
        queue[tail++] = nIdx;
      }
    }
  }
  let t4 = performance.now();
  stageAcc.stage4_dist += (t4 - t3);

  // STAGE 5: SPFA Geodesic Contour Barrier
  contourBarrier.fill(999);
  const inQueue = visited;
  inQueue.fill(0);
  head = 0; tail = 0;
  for (let i = 0; i < total; i++) {
    if (bgState[i] === 1 || bgState[i] === 2) {
      contourBarrier[i] = 0;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    const rOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = rOff + x;
      if (contourBarrier[i] === 0) {
        if (
          contourBarrier[i - 1] !== 0 ||
          contourBarrier[i + 1] !== 0 ||
          contourBarrier[i - width] !== 0 ||
          contourBarrier[i + width] !== 0
        ) {
          inQueue[i] = 1;
          queue[tail++] = i;
        }
      }
    }
  }
  let spfaPops = 0;
  while (head !== tail) {
    const idx = queue[head++];
    if (head === total) head = 0;
    inQueue[idx] = 0;
    spfaPops++;
    const curB = contourBarrier[idx];
    if (curB >= 24.2) continue;
    const x = idx % width, y = (idx - x) / width;
    for (let k = 0; k < 4; k++) {
      const nx = x + dxs[k], ny = y + dys[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      const bL = bgLum[nIdx];
      const darkPenalty = lum[nIdx] < bL - 8 ? (bL - lum[nIdx]) * 1.6 : 0;
      const texturePenalty = grad[nIdx] > 14 ? grad[nIdx] * 0.65 : grad[nIdx] * 0.15;
      const nextB = curB + Math.max(0.35, texturePenalty + darkPenalty);
      if (nextB < contourBarrier[nIdx]) {
        contourBarrier[nIdx] = nextB;
        if (nextB < 24.2 && inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          queue[tail++] = nIdx;
          if (tail === total) tail = 0;
        }
      }
    }
  }
  stageAcc.spfaPops += spfaPops;
  let t5 = performance.now();
  stageAcc.stage5_spfa += (t5 - t4);

  // STAGE 6: Fur & Vapor Matting
  const pureR = bgFieldR;
  const pureG = bgFieldG;
  const pureB = bgFieldB;
  for (let i = 0; i < total; i++) {
    const off = i << 2;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const bR = pureR[i], bG = pureG[i], bB = pureB[i];
    const bL = bgLum[i];
    const d = distToBg[i];
    const ring = distFromBg[i];
    if (bgState[i] === 1) {
      rawAlpha[i] = 0;
      pureR[i] = r; pureG[i] = g; pureB[i] = b;
      continue;
    }
    let alpha = 1.0;
    let outR = r, outG = g, outB = b;
    const isVaporWisp = (bgState[i] === 2) || (lum[i] > bL + 4.0 && sat[i] <= 22 && contourBarrier[i] < 24 && grad[i] < 20);
    if (isVaporWisp) {
      const span = Math.max(30, 245 - bL);
      const excess = Math.max(0, lum[i] - bL - 2.5);
      const vaporA = clamp(Math.pow(excess / span, 0.78), 0, 0.95);
      const solidBlend = bgState[i] === 2 ? 0 : smoothstep(12, 24, contourBarrier[i]);
      alpha = vaporA * (1 - solidBlend) + 1.0 * solidBlend;
      const unmixA = Math.max(0.14, alpha);
      outR = clamp((r - (1 - unmixA) * bR) / unmixA, r, 255);
      outG = clamp((g - (1 - unmixA) * bG) / unmixA, g, 255);
      outB = clamp((b - (1 - unmixA) * bB) / unmixA, b, 255);
    }
    else if (ring <= 8 || bgState[i] === 3) {
      const x = i % width, y = (i - x) / width;
      let fgR = r, fgG = g, fgB = b, bestDist = d;
      const rad = Math.min(8, 11 - Math.min(8, ring));
      for (let dy = -rad; dy <= rad; dy += 2) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const rOff = ny * width;
        for (let dx = -rad; dx <= rad; dx += 2) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = rOff + nx;
          if (bgState[nIdx] === 1) continue;
          if (distFromBg[nIdx] >= ring && distToBg[nIdx] > bestDist) {
            bestDist = distToBg[nIdx];
            const nOff = nIdx << 2;
            fgR = data[nOff]; fgG = data[nOff + 1]; fgB = data[nOff + 2];
          }
        }
      }
      const vx = fgR - bR, vy = fgG - bG, vz = fgB - bB;
      const vLenSq = vx * vx + vy * vy + vz * vz;
      let projA = 1.0;
      if (vLenSq > 49) {
        projA = clamp(((r - bR) * vx + (g - bG) * vy + (b - bB) * vz) / vLenSq, 0, 1);
      } else {
        projA = smoothstep(coreBgTol * 0.55, coreBgTol + 20, d);
      }
      const distA = smoothstep(coreBgTol * 0.5, coreBgTol + 22, d);
      if (bgState[i] === 3) {
        alpha = Math.min(projA, distA) * smoothstep(coreBgTol * 0.45, gapTol + 3, d);
      } else if (ring <= 2) {
        alpha = Math.min(projA, Math.max(distA, projA * 0.85));
      } else if (ring <= 5) {
        alpha = clamp(Math.max(projA, distA), 0.25, 1);
      } else {
        alpha = clamp(Math.max(0.85, projA), 0.85, 1);
      }
      if (alpha > 0.03) {
        const unmixA = clamp(Math.max(alpha, 0.20), 0.20, 1.0);
        const uR = clamp((r - (1 - unmixA) * bR) / unmixA, 0, 255);
        const uG = clamp((g - (1 - unmixA) * bG) / unmixA, 0, 255);
        const uB = clamp((b - (1 - unmixA) * bB) / unmixA, 0, 255);
        const w = ring <= 3 ? 0.92 : (9 - ring) / 6 * 0.70;
        outR = r + (uR - r) * w;
        outG = g + (uG - g) * w;
        outB = b + (uB - b) * w;
      }
    }
    if (ring > 2 && contourBarrier[i] < 18 && localTexture[i] < 6.0 && grad[i] < 9.5 && sat[i] >= 15 && sat[i] <= 95 && d < 95) {
      const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
      const rawBokehA = clamp(sat[i] / 90 + d / 135 + specBoost, 0.42, 1.0);
      const solidBlend = smoothstep(8, 18, contourBarrier[i]);
      const bokehAlpha = rawBokehA * (1 - solidBlend) + 1.0 * solidBlend;
      if (bokehAlpha < alpha) {
        alpha = bokehAlpha;
        const unmixA = Math.max(0.40, alpha);
        outR = clamp((r - (1 - unmixA) * bR) / unmixA, 0, 255);
        outG = clamp((g - (1 - unmixA) * bG) / unmixA, g, 255);
        outB = clamp((b - (1 - unmixA) * bB) / unmixA, b, 255);
      }
    }
    else if (ring > 2 && localTextureClamped[i] < 2.3 && grad[i] < 4.2 && sat[i] >= 24 && sat[i] <= 95 && d < 92) {
      const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
      const balloonAlpha = clamp(sat[i] / 95 + d / 145 + specBoost, 0.44, 1.0);
      if (balloonAlpha < alpha) {
        alpha = balloonAlpha;
        const unmixA = Math.max(0.42, alpha);
        outR = clamp((r - (1 - unmixA) * bR) / unmixA, 0, 255);
        outG = clamp((g - (1 - unmixA) * bG) / unmixA, g, 255);
        outB = clamp((b - (1 - unmixA) * bB) / unmixA, b, 255);
      }
    }
    rawAlpha[i] = alpha < 0.02 ? 0 : alpha;
    pureR[i] = outR;
    pureG[i] = outG;
    pureB[i] = outB;
  }
  let t6 = performance.now();
  stageAcc.stage6_unmix += (t6 - t5);

  // STAGE 7: Guided Filter + Assembly
  const guideSignal = bgLum;
  for (let i = 0; i < total; i++) {
    const v = distToBg[i] * 0.01;
    guideSignal[i] = v > 1 ? 1 : v;
  }
  const refinedAlpha = fastGuidedFilterHe2015(guideSignal, rawAlpha, distToBg, ws, 0.0012);
  for (let i = 0; i < total; i++) {
    const off = i << 2;
    const a = (bgState[i] === 1 && rawAlpha[i] === 0)
      ? 0
      : (rawAlpha[i] >= 0.99 && distFromBg[i] > 6)
        ? 1.0
        : (0.65 * refinedAlpha[i] + 0.35 * rawAlpha[i]);
    if (a < 0.02) {
      data[off] = 0; data[off + 1] = 0; data[off + 2] = 0; data[off + 3] = 0;
    } else {
      data[off] = Math.round(clamp(pureR[i], 0, 255));
      data[off + 1] = Math.round(clamp(pureG[i], 0, 255));
      data[off + 2] = Math.round(clamp(pureB[i], 0, 255));
      data[off + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  let t7 = performance.now();
  stageAcc.stage7_guided += (t7 - t6);

  return data;
}

async function main() {
  const decoded = await sharp(INPUT_IMAGE)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });

  const { width, height } = decoded.info;
  console.log(`Loaded test image: ${width}x${height} (${(width * height / 1e6).toFixed(2)} MP)`);

  const columns = 3, rows = 4;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const top = Math.floor(r * height / rows);
    const bottom = Math.floor((r + 1) * height / rows);
    const ch = bottom - top;
    for (let c = 0; c < columns; c++) {
      const left = Math.floor(c * width / columns);
      const right = Math.floor((c + 1) * width / columns);
      const cw = right - left;
      const cellRgba = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const srcOff = ((top + y) * width + left) * 4;
        const dstOff = y * cw * 4;
        cellRgba.set(decoded.data.subarray(srcOff, srcOff + cw * 4), dstOff);
      }
      cells.push({ r, c, cw, ch, cellRgba });
    }
  }

  // Warmup
  for (const cell of cells) {
    sotaCellMattingV5_2_Fast(cell.cellRgba, cell.cw, cell.ch);
  }

  // Run 5 iterations of unmodified v5.2-FAST
  const runTimes = [];
  for (let iter = 0; iter < 5; iter++) {
    const tStart = performance.now();
    for (const cell of cells) {
      sotaCellMattingV5_2_Fast(cell.cellRgba, cell.cw, cell.ch);
    }
    runTimes.push(performance.now() - tStart);
  }
  runTimes.sort((a, b) => a - b);
  console.log(`Baseline sotaCellMattingV5_2_Fast (12 cells total): median=${runTimes[2].toFixed(2)}ms, min=${runTimes[0].toFixed(2)}ms`);

  // Run instrumented stage breakdown (5 iterations average)
  const stageAcc = {
    stage0: 0,
    stage1_sobel: 0,
    stage1_box3: 0,
    stage1b_inward: 0,
    stage2_flood: 0,
    stage3_pockets: 0,
    stage4_dist: 0,
    stage5_spfa: 0,
    stage6_unmix: 0,
    stage7_guided: 0,
    spfaPops: 0,
  };
  const N = 5;
  for (let iter = 0; iter < N; iter++) {
    for (const cell of cells) {
      profileV5_2_Cell(cell.cellRgba, cell.cw, cell.ch, stageAcc);
    }
  }
  let sumStages = 0;
  for (const k of Object.keys(stageAcc)) {
    if (k !== 'spfaPops') {
      stageAcc[k] /= N;
      sumStages += stageAcc[k];
    } else {
      stageAcc[k] /= N;
    }
  }
  console.log('\n--- Stage Breakdown (12 cells, ms) ---');
  for (const [k, v] of Object.entries(stageAcc)) {
    if (k === 'spfaPops') {
      console.log(`  ${k.padEnd(18)}: ${Math.round(v)} pops`);
    } else {
      console.log(`  ${k.padEnd(18)}: ${v.toFixed(2)} ms (${((v / sumStages) * 100).toFixed(1)}%)`);
    }
  }
  console.log(`  TOTAL instrumented: ${sumStages.toFixed(2)} ms`);

  // Full pipeline benchmark
  const outDir = path.resolve('/tmp/bench-v52');
  const fullRes = await processStickerSheet({
    inputPath: INPUT_IMAGE,
    outputDir: outDir,
    layout: '3x4',
    backgroundColor: '#7A828C',
    debug: true,
  });
  console.log('\nFull processStickerSheet timingsMs:', fullRes.timingsMs);
}

main().catch(console.error);
