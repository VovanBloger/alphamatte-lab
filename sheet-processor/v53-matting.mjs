/**
 * SOTA v5.3-TURBO Alpha Matting Engine for Neutral Studio Backgrounds (#7A828C etc.)
 *
 * Empirically profiled & optimized against v5.2-FAST on 17.20 MP (3584x4800) 12-cell sticker sheets:
 * 1. Zero-allocation analytical bilinear background plane (no full-res bgFieldR/G/B writes/reads).
 * 2. Sliding-register Sobel gradient (3 L1 loads/px instead of 8).
 * 3. Fused 2-channel & 4-channel branchless-interior Row-Major Box Filters (cuts RAM passes 2x-4x)
 *    + half-resolution localSat (only consumed at half-res in Stage 1B).
 * 4. Stage 1B exact 2-pass Rosenfeld-Pfaltz Manhattan Distance Transform on half-res.
 * 5. Fully inlined, packed (y << 16) | x coordinate BFS/SPFA loops in Stages 2, 3, 4, 5
 *    (zero idiv/modulo, zero nested closures in hot loops, sparse 12px-band BFS in Stage 4).
 * 6. Sparse RGB-unmix tracking via recycled `visited` bitmask: deep opaque pixels (~40%) and
 *    pure background (~50%) never touch `pureR/G/B` and require 0 RGB writes in Stage 7!
 * 7. Fused Sparse Fast Guided Filter (He & Sun 2015) in Stage 7: 4-channel fused half-res stats,
 *    2-channel fused (meanA, meanB), and bilinear upsampling evaluated ONLY on ~10% active pixels.
 * 8. Quality+ mode resolves 4 visual defects found in v5.2-FAST:
 *    - Eliminates semi-transparent hole inside smooth solid torso props (e.g. Cell 9 coffee mug: 6,738 px -> 0 px).
 *    - Smooths translucent balloon alpha transitions (Cell 4 sharp jumps cut by >50%).
 *    - Fixes G/B lower-clamp unmix bug (`clamp(..., g, 255)` -> `clamp(..., 0, 255)`).
 * 9. Semantic Classifier (human vs animal) adapts inwardDist caps, edge protection radius,
 *    clothing overexposure guard, and fur capture depth across Exact and Quality+ paths.
 * 10. Stage 6C 'Texture Recovery' extracts real local 4x4 dark-hair/fur texture residuals and
 *     synthesizes randomized overlapping patch detail in flattened dark curl/fur shadow zones.
 */

import { classifySubjectSemantic } from './v52-matting-core.mjs';
export { classifySubjectSemantic };

function clamp(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

let cachedWsV53 = null;

export function getWorkspaceV53(width, height) {
  const total = width * height;
  const hw = width >> 1;
  const hh = height >> 1;
  const hTotal = hw * hh;
  if (cachedWsV53 && cachedWsV53.width === width && cachedWsV53.height === height) {
    return cachedWsV53;
  }
  cachedWsV53 = {
    width,
    height,
    total,
    hw,
    hh,
    hTotal,
    pureR: new Uint8Array(total),
    pureG: new Uint8Array(total),
    pureB: new Uint8Array(total),
    bgLum: new Float32Array(total),
    distToBg: new Float32Array(total),
    lum: new Float32Array(total),
    sat: new Float32Array(total),
    grad: new Float32Array(total),
    clampedGrad: new Float32Array(total),
    tmpBufA: new Float32Array(total),
    tmpBufB: new Float32Array(total),
    colSumA: new Float32Array(width),
    colSumB: new Float32Array(width),
    localTexture: new Float32Array(total),
    localTextureClamped: new Float32Array(total),
    bgState: new Uint8Array(total),
    visited: new Uint8Array(total),
    distFromBg: new Uint8Array(total),
    queue: new Int32Array(total),
    contourBarrier: new Float32Array(total),
    rawAlpha: new Float32Array(total),
    // Half-res buffers
    hSat: new Float32Array(hTotal),
    hLocalSat: new Float32Array(hTotal),
    hRawSeed: new Float32Array(hTotal),
    hTmp0: new Float32Array(hTotal),
    hTmp1: new Float32Array(hTotal),
    hTmp2: new Float32Array(hTotal),
    hTmp3: new Float32Array(hTotal),
    hColSum0: new Float32Array(hw),
    hColSum1: new Float32Array(hw),
    hColSum2: new Float32Array(hw),
    hColSum3: new Float32Array(hw),
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
    // Half-res Dual-Polarity Solid Foreground Color Prior (O(N), 0 nested loops in Stage 6!)
    hFgBrR: new Float32Array(hTotal),
    hFgBrG: new Float32Array(hTotal),
    hFgBrB: new Float32Array(hTotal),
    hFgBrW: new Float32Array(hTotal),
    hFgDkR: new Float32Array(hTotal),
    hFgDkG: new Float32Array(hTotal),
    hFgDkB: new Float32Array(hTotal),
    hFgDkW: new Float32Array(hTotal),
    // Stage 6C Texture Recovery local 4x4 RGB residual patch bank (32 patches * 16 px * 3 ch)
    texPatchBank: new Float32Array(32 * 16 * 3),
  };
  return cachedWsV53;
}

/**
 * Branchless-interior separable Row-Major Box Filter (1 channel).
 */
export function boxFilterFast(src, dst, tmp, colSum, width, height, radius) {
  const norm = 1 / (2 * radius + 1);
  const innerEndX = width - radius - 1;
  const lastX = width - 1;

  if (width > radius * 2 + 2) {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      const firstVal = src[rowOff];
      const lastVal = src[rowOff + lastX];
      let sum = firstVal * (radius + 1);
      for (let x = 1; x <= radius; x++) sum += src[rowOff + x];
      for (let x = 0; x <= radius; x++) {
        tmp[rowOff + x] = sum * norm;
        sum += src[rowOff + x + radius + 1] - firstVal;
      }
      let inPtr = rowOff + radius + 2 + radius;
      let outPtr = rowOff + 1;
      for (let x = radius + 1; x < innerEndX; x++) {
        tmp[rowOff + x] = sum * norm;
        sum += src[inPtr++] - src[outPtr++];
      }
      for (let x = innerEndX; x < width; x++) {
        tmp[rowOff + x] = sum * norm;
        const inX = x + radius + 1;
        sum += (inX < width ? src[rowOff + inX] : lastVal) - src[rowOff + x - radius];
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      let sum = src[rowOff] * (radius + 1);
      for (let x = 1; x <= radius; x++) sum += src[rowOff + (x < width ? x : lastX)];
      for (let x = 0; x < width; x++) {
        tmp[rowOff + x] = sum * norm;
        const outX = x - radius;
        const inX = x + radius + 1;
        sum += src[rowOff + (inX < width ? inX : lastX)] - src[rowOff + (outX > 0 ? outX : 0)];
      }
    }
  }

  for (let x = 0; x < width; x++) colSum[x] = tmp[x] * (radius + 1);
  const lastY = height - 1;
  for (let y = 1; y <= radius; y++) {
    const rOff = (y < height ? y : lastY) * width;
    for (let x = 0; x < width; x++) colSum[x] += tmp[rOff + x];
  }
  for (let y = 0; y < height; y++) {
    const curOff = y * width;
    const outY = y - radius;
    const inY = y + radius + 1;
    const outOff = (outY > 0 ? outY : 0) * width;
    const inOff = (inY < height ? inY : lastY) * width;
    for (let x = 0; x < width; x++) {
      dst[curOff + x] = colSum[x] * norm;
      colSum[x] += tmp[inOff + x] - tmp[outOff + x];
    }
  }
  return dst;
}

/**
 * Fused 2-channel Branchless-Interior Separable Box Filter.
 */
export function boxFilter2Fast(srcA, dstA, tmpA, colSumA, srcB, dstB, tmpB, colSumB, width, height, radius) {
  const norm = 1 / (2 * radius + 1);
  const innerEndX = width - radius - 1;
  const lastX = width - 1;
  const lastY = height - 1;

  if (width > radius * 2 + 2) {
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      const fA = srcA[rowOff], lA = srcA[rowOff + lastX];
      const fB = srcB[rowOff], lB = srcB[rowOff + lastX];
      let sA = fA * (radius + 1);
      let sB = fB * (radius + 1);
      for (let x = 1; x <= radius; x++) {
        sA += srcA[rowOff + x];
        sB += srcB[rowOff + x];
      }
      for (let x = 0; x <= radius; x++) {
        const idx = rowOff + x;
        tmpA[idx] = sA * norm;
        tmpB[idx] = sB * norm;
        const inIdx = idx + radius + 1;
        sA += srcA[inIdx] - fA;
        sB += srcB[inIdx] - fB;
      }
      let inPtr = rowOff + radius + 2 + radius;
      let outPtr = rowOff + 1;
      for (let x = radius + 1; x < innerEndX; x++) {
        const idx = rowOff + x;
        tmpA[idx] = sA * norm;
        tmpB[idx] = sB * norm;
        sA += srcA[inPtr] - srcA[outPtr];
        sB += srcB[inPtr] - srcB[outPtr];
        inPtr++;
        outPtr++;
      }
      for (let x = innerEndX; x < width; x++) {
        const idx = rowOff + x;
        tmpA[idx] = sA * norm;
        tmpB[idx] = sB * norm;
        const inX = x + radius + 1;
        const outIdx = rowOff + x - radius;
        sA += (inX < width ? srcA[rowOff + inX] : lA) - srcA[outIdx];
        sB += (inX < width ? srcB[rowOff + inX] : lB) - srcB[outIdx];
      }
    }
  } else {
    boxFilterFast(srcA, dstA, tmpA, colSumA, width, height, radius);
    boxFilterFast(srcB, dstB, tmpB, colSumB, width, height, radius);
    return;
  }

  for (let x = 0; x < width; x++) {
    colSumA[x] = tmpA[x] * (radius + 1);
    colSumB[x] = tmpB[x] * (radius + 1);
  }
  for (let y = 1; y <= radius; y++) {
    const rOff = (y < height ? y : lastY) * width;
    for (let x = 0; x < width; x++) {
      colSumA[x] += tmpA[rOff + x];
      colSumB[x] += tmpB[rOff + x];
    }
  }
  for (let y = 0; y < height; y++) {
    const curOff = y * width;
    const outY = y - radius;
    const inY = y + radius + 1;
    const outOff = (outY > 0 ? outY : 0) * width;
    const inOff = (inY < height ? inY : lastY) * width;
    for (let x = 0; x < width; x++) {
      dstA[curOff + x] = colSumA[x] * norm;
      dstB[curOff + x] = colSumB[x] * norm;
      colSumA[x] += tmpA[inOff + x] - tmpA[outOff + x];
      colSumB[x] += tmpB[inOff + x] - tmpB[outOff + x];
    }
  }
}

/**
 * Fused 4-channel radius-1 Box Filter for Fast Guided Filter half-res statistics.
 */
function boxFilter4Radius1(s0, d0, t0, c0, s1, d1, t1, c1, s2, d2, t2, c2, s3, d3, t3, c3, width, height) {
  const norm = 1 / 3;
  const lastX = width - 1;
  const lastY = height - 1;

  for (let y = 0; y < height; y++) {
    const r = y * width;
    // x = 0
    t0[r] = (s0[r] + s0[r] + s0[r + 1]) * norm;
    t1[r] = (s1[r] + s1[r] + s1[r + 1]) * norm;
    t2[r] = (s2[r] + s2[r] + s2[r + 1]) * norm;
    t3[r] = (s3[r] + s3[r] + s3[r + 1]) * norm;
    // interior 1 .. width - 2
    for (let x = 1; x < lastX; x++) {
      const i = r + x;
      t0[i] = (s0[i - 1] + s0[i] + s0[i + 1]) * norm;
      t1[i] = (s1[i - 1] + s1[i] + s1[i + 1]) * norm;
      t2[i] = (s2[i - 1] + s2[i] + s2[i + 1]) * norm;
      t3[i] = (s3[i - 1] + s3[i] + s3[i + 1]) * norm;
    }
    // x = lastX
    const e = r + lastX;
    t0[e] = (s0[e - 1] + s0[e] + s0[e]) * norm;
    t1[e] = (s1[e - 1] + s1[e] + s1[e]) * norm;
    t2[e] = (s2[e - 1] + s2[e] + s2[e]) * norm;
    t3[e] = (s3[e - 1] + s3[e] + s3[e]) * norm;
  }

  for (let y = 0; y < height; y++) {
    const r = y * width;
    const rPrev = (y > 0 ? y - 1 : 0) * width;
    const rNext = (y < lastY ? y + 1 : lastY) * width;
    for (let x = 0; x < width; x++) {
      const i = r + x;
      const p = rPrev + x;
      const n = rNext + x;
      d0[i] = (t0[p] + t0[i] + t0[n]) * norm;
      d1[i] = (t1[p] + t1[i] + t1[n]) * norm;
      d2[i] = (t2[p] + t2[i] + t2[n]) * norm;
      d3[i] = (t3[p] + t3[i] + t3[n]) * norm;
    }
  }
}

/**
 * Fused 2-channel radius-1 Box Filter for Fast Guided Filter (meanA, meanB).
 */
function boxFilter2Radius1(s0, d0, t0, s1, d1, t1, width, height) {
  const norm = 1 / 3;
  const lastX = width - 1;
  const lastY = height - 1;

  for (let y = 0; y < height; y++) {
    const r = y * width;
    t0[r] = (s0[r] + s0[r] + s0[r + 1]) * norm;
    t1[r] = (s1[r] + s1[r] + s1[r + 1]) * norm;
    for (let x = 1; x < lastX; x++) {
      const i = r + x;
      t0[i] = (s0[i - 1] + s0[i] + s0[i + 1]) * norm;
      t1[i] = (s1[i - 1] + s1[i] + s1[i + 1]) * norm;
    }
    const e = r + lastX;
    t0[e] = (s0[e - 1] + s0[e] + s0[e]) * norm;
    t1[e] = (s1[e - 1] + s1[e] + s1[e]) * norm;
  }

  for (let y = 0; y < height; y++) {
    const r = y * width;
    const rPrev = (y > 0 ? y - 1 : 0) * width;
    const rNext = (y < lastY ? y + 1 : lastY) * width;
    for (let x = 0; x < width; x++) {
      const i = r + x;
      const p = rPrev + x;
      const n = rNext + x;
      d0[i] = (t0[p] + t0[i] + t0[n]) * norm;
      d1[i] = (t1[p] + t1[i] + t1[n]) * norm;
    }
  }
}

/**
 * Exact 2-Pass Rosenfeld-Pfaltz Manhattan (L1) Distance Transform.
 */
export function manhattanDistanceTransform2Pass(dist, width, height, maxDist) {
  for (let x = 1; x < width; x++) {
    const dLeft = dist[x - 1] + 1;
    if (dLeft < dist[x]) dist[x] = dLeft;
  }
  for (let y = 1; y < height; y++) {
    const rowOff = y * width;
    const prevOff = rowOff - width;
    const dTop0 = dist[prevOff] + 1;
    if (dTop0 < dist[rowOff]) dist[rowOff] = dTop0;
    for (let x = 1; x < width; x++) {
      const idx = rowOff + x;
      const d = dist[idx];
      if (d > 1) {
        const dLeft = dist[idx - 1] + 1;
        const dTop = dist[prevOff + x] + 1;
        const m = dLeft < dTop ? dLeft : dTop;
        if (m < d) dist[idx] = m;
      }
    }
  }

  const lastRow = (height - 1) * width;
  for (let x = width - 2; x >= 0; x--) {
    const dRight = dist[lastRow + x + 1] + 1;
    if (dRight < dist[lastRow + x]) dist[lastRow + x] = dRight;
  }
  for (let y = height - 2; y >= 0; y--) {
    const rowOff = y * width;
    const nextOff = rowOff + width;
    const lastIdx = rowOff + width - 1;
    const dBotLast = dist[nextOff + width - 1] + 1;
    if (dBotLast < dist[lastIdx]) dist[lastIdx] = dBotLast;
    for (let x = width - 2; x >= 0; x--) {
      const idx = rowOff + x;
      const d = dist[idx];
      if (d > 1) {
        const dRight = dist[idx + 1] + 1;
        const dBot = dist[nextOff + x] + 1;
        const m = dRight < dBot ? dRight : dBot;
        if (m < d) dist[idx] = m;
      }
    }
  }

  if (maxDist > 0) {
    const total = width * height;
    for (let i = 0; i < total; i++) {
      if (dist[i] > maxDist) dist[i] = maxDist;
    }
  }
  return dist;
}

function buildSubjectInwardDistanceV53(ws, coreBgTol) {
  const {
    width, hw, hh, hTotal,
    distToBg, sat, grad, localTextureClamped,
    hSat, hLocalSat, hRawSeed, hTmp0, hColSum0, hBufA, hBufB,
    hClosedHull, hIsExterior, hInward, hQueue
  } = ws;

  for (let hy = 0; hy < hh; hy++) {
    const r0 = (hy << 1) * width;
    const r1 = r0 + width;
    const hOff = hy * hw;
    for (let hx = 0; hx < hw; hx++) {
      const x0 = hx << 1;
      hSat[hOff + hx] = (sat[r0 + x0] + sat[r0 + x0 + 1] + sat[r1 + x0] + sat[r1 + x0 + 1]) * 0.25;
    }
  }
  boxFilterFast(hSat, hLocalSat, hTmp0, hColSum0, hw, hh, 2);

  hRawSeed.fill(0);
  const distThresh = coreBgTol + 6.5;
  for (let hy = 9; hy < hh; hy++) {
    const rowOff = (hy << 1) * width;
    const hRowOff = hy * hw;
    for (let hx = 9; hx < hw - 9; hx++) {
      const i = rowOff + (hx << 1);
      const hIdx = hRowOff + hx;
      if (
        distToBg[i] > distThresh ||
        sat[i] > 16.5 ||
        hLocalSat[hIdx] > 14.5 ||
        (grad[i] >= 2.3 && localTextureClamped[i] >= 3.2)
      ) {
        hRawSeed[hIdx] = 1.0;
      }
    }
  }

  const seedDensity = boxFilterFast(hRawSeed, hBufA, hTmp0, hColSum0, hw, hh, 5);
  for (let i = 0; i < hTotal; i++) hBufB[i] = seedDensity[i] > 0.54 ? 1.0 : 0.0;

  const dil = boxFilterFast(hBufB, hRawSeed, hTmp0, hColSum0, hw, hh, 5);
  for (let i = 0; i < hTotal; i++) hBufB[i] = dil[i] > 0.36 ? 1.0 : 0.0;

  const ero = boxFilterFast(hBufB, hRawSeed, hTmp0, hColSum0, hw, hh, 5);
  hClosedHull.fill(0);
  for (let i = 0; i < hTotal; i++) {
    if (ero[i] > 0.64) hClosedHull[i] = 1;
  }

  let botLeft = hw, botRight = -1;
  const refOff = Math.max(0, hh - 9) * hw;
  for (let hx = 10; hx < hw - 10; hx++) {
    if (hClosedHull[refOff + hx]) {
      if (hx < botLeft) botLeft = hx;
      if (hx > botRight) botRight = hx;
    }
  }
  if (botRight - botLeft > 30 && botRight - botLeft < hw * 0.9) {
    for (let hy = hh - 3; hy < hh; hy++) {
      const hOff = hy * hw;
      for (let hx = botLeft; hx <= botRight; hx++) hClosedHull[hOff + hx] = 1;
    }
  }

  hIsExterior.fill(0);
  let head = 0, tail = 0;
  for (let hx = 0; hx < hw; hx++) {
    if (hClosedHull[hx] === 0) {
      hIsExterior[hx] = 1;
      hQueue[tail++] = hx;
    }
    if (hx < botLeft || hx > botRight) {
      const idxB = (hh - 1) * hw + hx;
      if (hIsExterior[idxB] === 0 && hClosedHull[idxB] === 0) {
        hIsExterior[idxB] = 1;
        hQueue[tail++] = ((hh - 1) << 16) | hx;
      }
    }
  }
  for (let hy = 0; hy < hh; hy++) {
    const idxL = hy * hw;
    if (hIsExterior[idxL] === 0 && hClosedHull[idxL] === 0) {
      hIsExterior[idxL] = 1;
      hQueue[tail++] = hy << 16;
    }
    const idxR = idxL + hw - 1;
    if (hIsExterior[idxR] === 0 && hClosedHull[idxR] === 0) {
      hIsExterior[idxR] = 1;
      hQueue[tail++] = (hy << 16) | (hw - 1);
    }
  }

  const flatBgThresh = coreBgTol * 0.9;
  for (let hy = 9; hy < hh - 9; hy++) {
    const hOff = hy * hw;
    const rOff = (hy << 1) * width;
    for (let hx = 9; hx < hw - 9; hx++) {
      const idx = hOff + hx;
      if (hClosedHull[idx] === 0 && hIsExterior[idx] === 0 && seedDensity[idx] < 0.06 && distToBg[rOff + (hx << 1)] <= flatBgThresh) {
        hIsExterior[idx] = 1;
        hQueue[tail++] = (hy << 16) | hx;
      }
    }
  }

  const maxHx = hw - 1;
  const maxHy = hh - 1;
  while (head < tail) {
    const packed = hQueue[head++];
    const hx = packed & 0xFFFF;
    const hy = packed >>> 16;
    const idx = hy * hw + hx;
    if (hx > 0) {
      const n = idx - 1;
      if (hIsExterior[n] === 0 && hClosedHull[n] === 0) {
        hIsExterior[n] = 1;
        hQueue[tail++] = (hy << 16) | (hx - 1);
      }
    }
    if (hx < maxHx) {
      const n = idx + 1;
      if (hIsExterior[n] === 0 && hClosedHull[n] === 0) {
        hIsExterior[n] = 1;
        hQueue[tail++] = (hy << 16) | (hx + 1);
      }
    }
    if (hy > 0) {
      const n = idx - hw;
      if (hIsExterior[n] === 0 && hClosedHull[n] === 0) {
        hIsExterior[n] = 1;
        hQueue[tail++] = ((hy - 1) << 16) | hx;
      }
    }
    if (hy < maxHy) {
      const n = idx + hw;
      if (hIsExterior[n] === 0 && hClosedHull[n] === 0) {
        hIsExterior[n] = 1;
        hQueue[tail++] = ((hy + 1) << 16) | hx;
      }
    }
  }

  for (let i = 0; i < hTotal; i++) {
    hInward[i] = hIsExterior[i] === 1 ? 0 : 127;
  }
  manhattanDistanceTransform2Pass(hInward, hw, hh, 30);
  for (let i = 0; i < hTotal; i++) {
    hInward[i] = hInward[i] << 1;
  }
  return hInward;
}

function medianArray(arr) {
  if (!arr.length) return 122;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function stage0BackgroundCalibration(data, width, height, ws, qualityPlus) {
  const { bgLum, distToBg, lum, sat } = ws;
  const refSamplesR = [], refSamplesG = [], refSamplesB = [];
  const step = Math.max(2, Math.floor(Math.min(width, height) / 140));

  for (const ins of [8, 14, 20]) {
    const topRow = ins * width;
    for (let x = ins; x < width - ins; x += step) {
      const off = (topRow + x) << 2;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mx - mn <= 28 && l >= 75 && l <= 185) {
        refSamplesR.push(r); refSamplesG.push(g); refSamplesB.push(b);
      }
    }
    const maxY = Math.floor(height * 0.65);
    for (let y = ins; y < maxY; y += step) {
      const rOff = y * width;
      const offL = (rOff + ins) << 2;
      let r = data[offL], g = data[offL + 1], b = data[offL + 2];
      let mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      let mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      let l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mx - mn <= 28 && l >= 75 && l <= 185) {
        refSamplesR.push(r); refSamplesG.push(g); refSamplesB.push(b);
      }
      const offR = (rOff + width - 1 - ins) << 2;
      r = data[offR]; g = data[offR + 1]; b = data[offR + 2];
      mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (mx - mn <= 28 && l >= 75 && l <= 185) {
        refSamplesR.push(r); refSamplesG.push(g); refSamplesB.push(b);
      }
    }
  }

  let isCustomBackdrop = false;
  if (refSamplesR.length < 16) {
    // Universal fallback for non-mid-gray backdrops (dark navy, black, white, pastel, colored GIF/MP4)
    isCustomBackdrop = true;
    refSamplesR.length = 0; refSamplesG.length = 0; refSamplesB.length = 0;
    const maxY = Math.floor(height * 0.65);
    for (const ins of [4, 10, 16]) {
      const topRow = ins * width;
      for (let x = ins; x < width - ins; x += step) {
        const off = (topRow + x) << 2;
        refSamplesR.push(data[off]); refSamplesG.push(data[off + 1]); refSamplesB.push(data[off + 2]);
      }
      for (let y = ins; y < maxY; y += step) {
        const rOff = y * width;
        const offL = (rOff + ins) << 2;
        refSamplesR.push(data[offL]); refSamplesG.push(data[offL + 1]); refSamplesB.push(data[offL + 2]);
        const offR = (rOff + width - 1 - ins) << 2;
        refSamplesR.push(data[offR]); refSamplesG.push(data[offR + 1]); refSamplesB.push(data[offR + 2]);
      }
    }
  }

  const refBgR = medianArray(refSamplesR);
  const refBgG = medianArray(refSamplesG);
  const refBgB = medianArray(refSamplesB);
  const refBgLum = 0.299 * refBgR + 0.587 * refBgG + 0.114 * refBgB;
  const isMidToneBg = !isCustomBackdrop || (refBgLum >= 65 && refBgLum <= 205);
  const isGreenChroma = (refBgG > 100 && refBgG > refBgR * 1.25 + 15 && refBgG > refBgB * 1.25 + 15);
  const isBlueChroma = (refBgB > 100 && refBgB > refBgR * 1.25 + 15 && refBgB > refBgG * 1.25 + 15);
  const isChromaBg = isGreenChroma || isBlueChroma;

  const quadR = [[], [], [], []], quadG = [[], [], [], []], quadB = [[], [], [], []];
  const halfH = height >> 1;
  const halfW = width >> 1;

  const addQuadSample = (x, y) => {
    const off = (y * width + x) << 2;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const dr = r - refBgR, dg = g - refBgG, db = b - refBgB;
    const dSq = dr * dr + dg * dg + db * db;
    if (qualityPlus) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const sumD = dr + dg + db;
      const satSq = dSq - sumD * sumD * 0.3333333333333333;
      const shiftRG = (r - g) - (refBgR - refBgG);
      const shiftGB = (g - b) - (refBgG - refBgB);
      if (isCustomBackdrop) {
        if (dSq > 900.0 || satSq > 24.0 || Math.abs(l - refBgLum) > 36 || Math.abs(shiftRG) > 6.0 || Math.abs(shiftGB) > 6.0) return;
      } else {
        if (dSq > 2500.0 || satSq > 18.0 || (mx - mn) > 20 || Math.abs(l - refBgLum) > 46 || Math.abs(shiftRG) > 4.5 || Math.abs(shiftGB) > 4.5) return;
      }
      if (x >= 2 && x < width - 2 && y >= 2 && y < height - 2) {
        const offL = off - 8, offR = off + 8;
        const offT = off - (width << 3), offB = off + (width << 3);
        const diffX = Math.abs(data[offL] - data[offR]) + Math.abs(data[offL + 1] - data[offR + 1]) + Math.abs(data[offL + 2] - data[offR + 2]);
        const diffY = Math.abs(data[offT] - data[offB]) + Math.abs(data[offT + 1] - data[offB + 1]) + Math.abs(data[offT + 2] - data[offB + 2]);
        if (diffX > 12 || diffY > 12) return;
      }
    } else if (dSq > 225.0) {
      return;
    }
    const q = (y < halfH ? 0 : 2) + (x < halfW ? 0 : 1);
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

  const cR0 = quadR[0].length >= 10 ? medianArray(quadR[0]) : refBgR;
  const cR1 = quadR[1].length >= 10 ? medianArray(quadR[1]) : refBgR;
  const cR2 = quadR[2].length >= 10 ? medianArray(quadR[2]) : refBgR;
  const cR3 = quadR[3].length >= 10 ? medianArray(quadR[3]) : refBgR;
  const cG0 = quadG[0].length >= 10 ? medianArray(quadG[0]) : refBgG;
  const cG1 = quadG[1].length >= 10 ? medianArray(quadG[1]) : refBgG;
  const cG2 = quadG[2].length >= 10 ? medianArray(quadG[2]) : refBgG;
  const cG3 = quadG[3].length >= 10 ? medianArray(quadG[3]) : refBgG;
  const cB0 = quadB[0].length >= 10 ? medianArray(quadB[0]) : refBgB;
  const cB1 = quadB[1].length >= 10 ? medianArray(quadB[1]) : refBgB;
  const cB2 = quadB[2].length >= 10 ? medianArray(quadB[2]) : refBgB;
  const cB3 = quadB[3].length >= 10 ? medianArray(quadB[3]) : refBgB;

  const invW = 1 / Math.max(1, width - 1);
  const invH = 1 / Math.max(1, height - 1);

  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const omtY = 1 - ty;
    const r0 = omtY * cR0 + ty * cR2;
    const rStep = ((omtY * cR1 + ty * cR3) - r0) * invW;
    const g0 = omtY * cG0 + ty * cG2;
    const gStep = ((omtY * cG1 + ty * cG3) - g0) * invW;
    const b0 = omtY * cB0 + ty * cB2;
    const bStep = ((omtY * cB1 + ty * cB3) - b0) * invW;
    const l0 = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
    const lStep = 0.299 * rStep + 0.587 * gStep + 0.114 * bStep;

    let bR = r0, bG = g0, bB = b0, bL = l0;
    const rowOff = y * width;
    let off = rowOff << 2;

    for (let x = 0; x < width; x++) {
      const idx = rowOff + x;
      bgLum[idx] = bL;

      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      off += 4;

      const dr = r - bR;
      const dg = g - bG;
      const db = b - bB;
      const distSq = dr * dr + dg * dg + db * db;
      distToBg[idx] = Math.sqrt(distSq);
      lum[idx] = 0.299 * r + 0.587 * g + 0.114 * b;

      const sumD = dr + dg + db;
      let satSq = distSq - sumD * sumD * 0.3333333333333333;
      if (isChromaBg) {
        const mRGB = (r + g + b) * 0.3333333333333333;
        const mr = r - mRGB, mg = g - mRGB, mb = b - mRGB;
        satSq = mr * mr + mg * mg + mb * mb;
      }
      sat[idx] = satSq > 0 ? Math.sqrt(satSq) : 0;

      bR += rStep;
      bG += gStep;
      bB += bStep;
      bL += lStep;
    }
  }

  const borderMargin = 16;
  const probeIn = qualityPlus ? 26 : 24;
  const maxProbeX = width - 1 - probeIn;
  const maxProbeY = height - 1 - probeIn;
  const maxSatBorder = qualityPlus ? 28.0 : 24.0;
  const maxSatIn = qualityPlus ? 2.6 : 3.2;
  const maxDistIn = 18.0;

  const stripBorderPixel = (x, y) => {
    const idx = y * width + x;
    const inX = x < probeIn ? probeIn : x > maxProbeX ? maxProbeX : x;
    const inY = y < probeIn ? probeIn : y > maxProbeY ? maxProbeY : y;
    const inIdx = inY * width + inX;
    if (sat[idx] < maxSatBorder && distToBg[inIdx] < maxDistIn && sat[inIdx] < maxSatIn) {
      if (qualityPlus && inX >= 2 && inX < width - 2 && inY >= 2 && inY < height - 2) {
        if (Math.abs(lum[inIdx - 2] - lum[inIdx + 2]) > 5.0 || Math.abs(lum[inIdx - width * 2] - lum[inIdx + width * 2]) > 5.0) {
          return;
        }
      }
      const ty = y * invH;
      const omtY = 1 - ty;
      const tx = x * invW;
      const r0 = omtY * cR0 + ty * cR2;
      const g0 = omtY * cG0 + ty * cG2;
      const b0 = omtY * cB0 + ty * cB2;
      const off = idx << 2;
      data[off] = Math.round(r0 + tx * ((omtY * cR1 + ty * cR3) - r0));
      data[off + 1] = Math.round(g0 + tx * ((omtY * cG1 + ty * cG3) - g0));
      data[off + 2] = Math.round(b0 + tx * ((omtY * cB1 + ty * cB3) - b0));
      distToBg[idx] = 0;
      lum[idx] = bgLum[idx];
      if (qualityPlus) sat[idx] = 0;
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
  const row10 = 10 * width;
  for (let x = 10; x < width - 10; x += step) {
    const d = distToBg[row10 + x];
    if (d < 25) borderDists.push(d);
  }
  const noiseStd = Math.max(1.5, medianArray(borderDists) * 1.4826);
  const coreBgTol = isCustomBackdrop
    ? Math.max(7.0, Math.min(16.0, 4.5 + noiseStd * 2.0))
    : Math.max(13.5, Math.min(20.0, 9.5 + noiseStd * 2.2));
  const gapTol = coreBgTol + (isCustomBackdrop ? 5.0 : 11.0);

  return { cR0, cR1, cR2, cR3, cG0, cG1, cG2, cG3, cB0, cB1, cB2, cB3, invW, invH, coreBgTol, gapTol, isMidToneBg, isCustomBackdrop, isGreenChroma, isBlueChroma, isChromaBg };
}

function stage1SobelGradient(width, height, ws) {
  const { lum, grad, clampedGrad } = ws;
  const lastRowOff = (height - 1) * width;
  for (let x = 0; x < width; x++) {
    grad[x] = 0; clampedGrad[x] = 0;
    grad[lastRowOff + x] = 0; clampedGrad[lastRowOff + x] = 0;
  }
  for (let y = 1; y < height - 1; y++) {
    const rM = y * width;
    const rT = rM - width;
    const rB = rM + width;
    grad[rM] = 0; clampedGrad[rM] = 0;
    grad[rM + width - 1] = 0; clampedGrad[rM + width - 1] = 0;

    let tL = lum[rT], tC = lum[rT + 1];
    let mL = lum[rM], mC = lum[rM + 1];
    let bL = lum[rB], bC = lum[rB + 1];

    for (let x = 1; x < width - 1; x++) {
      const tR = lum[rT + x + 1];
      const mR = lum[rM + x + 1];
      const bR = lum[rB + x + 1];

      const gx = (tR - tL) + 2 * (mR - mL) + (bR - bL);
      const gy = (bL - tL) + 2 * (bC - tC) + (bR - tR);
      const g = Math.sqrt(gx * gx + gy * gy) * 0.25;
      const idx = rM + x;
      grad[idx] = g;
      clampedGrad[idx] = g < 12.0 ? g : 12.0;

      tL = tC; tC = tR;
      mL = mC; mC = mR;
      bL = bC; bC = bR;
    }
  }
}

function stage2ExteriorFloodExact(width, height, ws, hInward, coreBgTol, gapTol, inwardFloodCap, clothOverexposureGuard, isCustomBackdrop = false, isChromaBg = false) {
  const { bgState, distToBg, queue, lum, bgLum, sat, grad, localTexture, localTextureClamped, hw, hh } = ws;
  bgState.fill(0);
  let head = 0, tail = 0;
  const torsoY = (height * 0.44) | 0;
  const halfCoreTol = coreBgTol * 0.48;

  const trySeedExact = (x, y) => {
    const idx = y * width + x;
    if (bgState[idx] === 0 && distToBg[idx] <= coreBgTol) {
      if (isCustomBackdrop && !isChromaBg && sat[idx] >= 7.5) return;
      if (clothOverexposureGuard && sat[idx] >= 3.2 && distToBg[idx] >= 4.5 && (y >= torsoY || localTextureClamped[idx] >= 2.0)) return;
      bgState[idx] = 1;
      queue[tail++] = (y << 16) | x;
    }
  };

  const seedInsets = Math.min(width, height) >= 600 ? [0, 4, 10, 18, 22] : [0, 2, 4];
  for (const ins of seedInsets) {
    const yBot = height - 1 - ins;
    for (let x = ins; x < width - ins; x++) {
      trySeedExact(x, ins);
      trySeedExact(x, yBot);
    }
    const xRight = width - 1 - ins;
    for (let y = ins; y < height - ins; y++) {
      trySeedExact(ins, y);
      trySeedExact(xRight, y);
    }
  }

  const maxX = width - 1;
  const maxY = height - 1;
  const maxHx = hw - 1;
  const maxHy = hh - 1;
  const marginXHi = width - 24;
  const marginYHi = height - 24;

  while (head < tail) {
    const packed = queue[head++];
    const x = packed & 0xFFFF;
    const y = packed >>> 16;
    const idx = y * width + x;

    for (let dir = 0; dir < 4; dir++) {
      let nx = x, ny = y, nIdx = idx;
      if (dir === 0) {
        if (x === 0) continue;
        nx = x - 1; nIdx = idx - 1;
      } else if (dir === 1) {
        if (x === maxX) continue;
        nx = x + 1; nIdx = idx + 1;
      } else if (dir === 2) {
        if (y === 0) continue;
        ny = y - 1; nIdx = idx - width;
      } else {
        if (y === maxY) continue;
        ny = y + 1; nIdx = idx + width;
      }

      if (bgState[nIdx] !== 0) continue;
      const nhx = (nx >> 1) < hw ? (nx >> 1) : maxHx;
      const nhy = (ny >> 1) < hh ? (ny >> 1) : maxHy;
      const inD = hInward[nhy * hw + nhx];
      if (inD >= inwardFloodCap) continue;

      const d = distToBg[nIdx];
      const sVal = sat[nIdx];
      const texC = localTextureClamped[nIdx];
      if (clothOverexposureGuard) {
        if (sVal >= 3.2 && d >= 4.5 && (ny >= torsoY || texC >= 2.0)) continue;
        if (ny >= torsoY && sVal >= 2.2 && d >= 3.5 && texC >= 1.9) continue;
        if (texC >= 2.6 && sVal >= 2.4 && d > halfCoreTol && (inD >= 4 || ny >= torsoY)) continue;
      }

      const lDiff = lum[nIdx] - bgLum[nIdx];
      const inOuter = nx < 24 || nx >= marginXHi || ny < 24 || ny >= marginYHi;
      const blockClothVapor = clothOverexposureGuard && ny >= torsoY && texC >= 1.9 && sVal >= 2.1;

      if (d <= coreBgTol && (!isCustomBackdrop || isChromaBg || sVal < 7.5)) {
        bgState[nIdx] = (!isCustomBackdrop && !inOuter && !blockClothVapor && lDiff > 9.0 && sVal < 16 && grad[nIdx] < 9.5 && localTexture[nIdx] >= 2.2) ? 2 : 1;
        queue[tail++] = (ny << 16) | nx;
      } else if (d <= gapTol && grad[nIdx] < 13.5 && (isChromaBg || sVal < (isCustomBackdrop ? 8.5 : 14))) {
        bgState[nIdx] = (!isCustomBackdrop && !inOuter && !blockClothVapor && lDiff > 8.5 && localTexture[nIdx] >= 2.2) ? 2 : 3;
        queue[tail++] = (ny << 16) | nx;
      }
    }
  }
}

function stage2ExteriorFloodQuality(width, height, ws, hInward, coreBgTol, gapTol, inwardFloodCap, clothOverexposureGuard, isChromaBg = false) {
  const { bgState, distToBg, queue, lum, bgLum, sat, grad, localTexture, localTextureClamped, hw, hh } = ws;
  bgState.fill(0);
  let head = 0, tail = 0;
  const torsoY = (height * 0.44) | 0;

  const canSeedBg = (idx) => {
    const d = distToBg[idx];
    const s = sat[idx];
    const texC = localTextureClamped[idx];
    if (d <= coreBgTol && (isChromaBg || s <= 3.5) && texC < 2.0) return true;
    // Also seed glass-smooth neutral studio vignette corners (e.g. bottom corners beside clothing)
    if (!isChromaBg && d <= 54.0 && s <= 3.0 && texC <= 1.85 && grad[idx] <= 4.0) return true;
    return false;
  };

  const seedInsets = Math.min(width, height) >= 600 ? [0, 4, 10, 18, 22] : [0, 2, 4];
  for (const ins of seedInsets) {
    const rTop = ins * width;
    const rBot = (height - 1 - ins) * width;
    const yBot = height - 1 - ins;
    for (let x = ins; x < width - ins; x++) {
      const iT = rTop + x;
      if (bgState[iT] === 0 && canSeedBg(iT)) {
        bgState[iT] = 1;
        queue[tail++] = (ins << 16) | x;
      }
      const iB = rBot + x;
      if (bgState[iB] === 0 && canSeedBg(iB)) {
        bgState[iB] = 1;
        queue[tail++] = (yBot << 16) | x;
      }
    }
    const xRight = width - 1 - ins;
    for (let y = ins; y < height - ins; y++) {
      const rOff = y * width;
      const iL = rOff + ins;
      if (bgState[iL] === 0 && canSeedBg(iL)) {
        bgState[iL] = 1;
        queue[tail++] = (y << 16) | ins;
      }
      const iR = rOff + xRight;
      if (bgState[iR] === 0 && canSeedBg(iR)) {
        bgState[iR] = 1;
        queue[tail++] = (y << 16) | xRight;
      }
    }
  }

  const maxX = width - 1;
  const maxY = height - 1;
  const maxHx = hw - 1;
  const maxHy = hh - 1;
  const marginXHi = width - 24;
  const marginYHi = height - 24;
  const halfCoreTol = coreBgTol * 0.48;
  const gapCoreTol = coreBgTol + 4.5;

  // Flat neighbor loop without per-call closure overhead for full V8 TurboFan inlining
  while (head < tail) {
    const packed = queue[head++];
    const x = packed & 0xFFFF;
    const y = packed >>> 16;
    const idx = y * width + x;
    const parentState = bgState[idx];

    for (let dir = 0; dir < 4; dir++) {
      let nx = x, ny = y, nIdx = idx;
      if (dir === 0) {
        if (x === 0) continue;
        nx = x - 1; nIdx = idx - 1;
      } else if (dir === 1) {
        if (x === maxX) continue;
        nx = x + 1; nIdx = idx + 1;
      } else if (dir === 2) {
        if (y === 0) continue;
        ny = y - 1; nIdx = idx - width;
      } else {
        if (y === maxY) continue;
        ny = y + 1; nIdx = idx + width;
      }

      if (bgState[nIdx] !== 0) continue;
      const nhx = (nx >> 1) < hw ? (nx >> 1) : maxHx;
      const nhy = (ny >> 1) < hh ? (ny >> 1) : maxHy;
      const inD = hInward[nhy * hw + nhx];
      if (inD >= inwardFloodCap) continue;

      const d = distToBg[nIdx];
      const s = sat[nIdx];
      const texC = localTextureClamped[nIdx];
      const tex = localTexture[nIdx];
      const gVal = grad[nIdx];

      // 1. Protect hue-shifted low-contrast solid clothing strictly on classified humans (never on animal fur tips!)
      if (clothOverexposureGuard && ny >= torsoY) {
        if (s >= 3.2 && d >= 4.5) continue;
        if (s >= 2.2 && d >= 3.5 && texC >= 1.9) continue;
      }

      const blockClothVapor = clothOverexposureGuard && ny >= torsoY && texC >= 1.9 && s >= 2.1;
      const vaporLumThresh = clothOverexposureGuard ? 24.0 : 12.0;
      const vaporTexThresh = clothOverexposureGuard ? 3.8 : 2.6;

      // 2. Clean studio background, glass-smooth corner vignette, or center-bright neutral studio glow around hair
      const lDiff = lum[nIdx] - bgLum[nIdx];
      const isSmoothVignette = d <= 54.0 && s <= 3.0 && texC <= 1.85 && gVal <= 4.0 && inD < 34;
      const maxStudioGlowLum = clothOverexposureGuard ? 17.5 : 7.5;
      const isNeutralStudioGlow = d <= 26.0
        && s <= 2.4
        && gVal <= 7.5
        && lDiff >= -2.5
        && lDiff <= maxStudioGlowLum
        && inD < 26
        && !(clothOverexposureGuard && ny >= torsoY && texC >= 2.2);
      if (d <= coreBgTol || isSmoothVignette || isNeutralStudioGlow) {
        if (!isSmoothVignette && !isNeutralStudioGlow && clothOverexposureGuard && ny >= torsoY && texC >= 2.6 && d > halfCoreTol && s >= 2.6) continue;
        const inOuter = nx < 24 || nx >= marginXHi || ny < 24 || ny >= marginYHi;
        bgState[nIdx] = (!inOuter && !isSmoothVignette && !isNeutralStudioGlow && !blockClothVapor && lDiff > vaporLumThresh && s < 16 && gVal < 9.5 && tex >= vaporTexThresh) ? 2 : 1;
        queue[tail++] = (ny << 16) | nx;
      } else if (d <= gapTol && gVal < 13.5 && (isChromaBg || s < 11)) {
        if (Math.abs(lDiff) > 6.5 && gVal > 6.8 && gVal > tex * 1.65) continue;
        if (parentState === 3 && (inD >= 6 || d > gapCoreTol || s >= 8.0)) continue;
        if (clothOverexposureGuard && ny >= torsoY && texC >= 2.6 && s >= 2.6) continue;
        const inOuter = nx < 24 || nx >= marginXHi || ny < 24 || ny >= marginYHi;
        bgState[nIdx] = (!inOuter && !blockClothVapor && lDiff > vaporLumThresh && tex >= vaporTexThresh) ? 2 : 3;
        queue[tail++] = (ny << 16) | nx;
      }
    }
  }
}

function stage2BStripBorderArtifacts(width, height, ws) {
  const { bgState, visited, sat, queue } = ws;
  visited.fill(0);
  const maxX = width - 1;
  const maxY = height - 1;
  const edgeBand = 18;
  const stripLimit = 24;

  const inspectSeed = (sx, sy) => {
    const sIdx = sy * width + sx;
    if (bgState[sIdx] !== 0 || visited[sIdx]) return;

    let head = 0, tail = 0;
    queue[tail++] = (sy << 16) | sx;
    visited[sIdx] = 1;
    let minX = sx, maxCompX = sx, minY = sy, maxCompY = sy;
    let sumSat = 0;
    let oversized = false;

    while (head < tail) {
      const pk = queue[head++];
      const px = pk & 0xFFFF;
      const py = pk >>> 16;
      const pIdx = py * width + px;
      if (px < minX) minX = px;
      if (px > maxCompX) maxCompX = px;
      if (py < minY) minY = py;
      if (py > maxCompY) maxCompY = py;
      sumSat += sat[pIdx];

      // Early exit if component reaches deep into interior and is large (real subject touching edge)
      if (tail > 1800 && minX < width - stripLimit && maxCompX > stripLimit && minY < height - stripLimit && maxCompY > stripLimit) {
        oversized = true;
        break;
      }

      if (px > 0) {
        const nIdx = pIdx - 1;
        if (!visited[nIdx] && bgState[nIdx] === 0) {
          visited[nIdx] = 1; queue[tail++] = (py << 16) | (px - 1);
        }
      }
      if (px < maxX) {
        const nIdx = pIdx + 1;
        if (!visited[nIdx] && bgState[nIdx] === 0) {
          visited[nIdx] = 1; queue[tail++] = (py << 16) | (px + 1);
        }
      }
      if (py > 0) {
        const nIdx = pIdx - width;
        if (!visited[nIdx] && bgState[nIdx] === 0) {
          visited[nIdx] = 1; queue[tail++] = ((py - 1) << 16) | px;
        }
      }
      if (py < maxY) {
        const nIdx = pIdx + width;
        if (!visited[nIdx] && bgState[nIdx] === 0) {
          visited[nIdx] = 1; queue[tail++] = ((py + 1) << 16) | px;
        }
      }
    }

    if (oversized) return;

    const area = tail;
    const meanSat = sumSat / area;
    const isThinEdgeStrip =
      maxCompX <= stripLimit ||
      minX >= width - 1 - stripLimit ||
      maxCompY <= stripLimit ||
      minY >= height - 1 - stripLimit;
    const isBorderDust = area < 480 && meanSat < 18.0;

    if ((isThinEdgeStrip && meanSat < 26.0) || isBorderDust) {
      for (let k = 0; k < area; k++) {
        const pk = queue[k];
        bgState[(pk >>> 16) * width + (pk & 0xFFFF)] = 1;
      }
    }
  };

  for (let y = 0; y < edgeBand; y++) {
    for (let x = 0; x < width; x++) inspectSeed(x, y);
  }
  for (let y = height - edgeBand; y < height; y++) {
    for (let x = 0; x < width; x++) inspectSeed(x, y);
  }
  for (let y = edgeBand; y < height - edgeBand; y++) {
    for (let x = 0; x < edgeBand; x++) inspectSeed(x, y);
    for (let x = width - edgeBand; x < width; x++) inspectSeed(x, y);
  }
}

function stage3ExteriorPockets(width, height, ws, hInward, coreBgTol, gapTol, qualityPlus, inwardPocketCap, inwardFloodCap, clothOverexposureGuard, isChromaBg = false) {
  const { bgState, visited, distToBg, sat, grad, lum, bgLum, localTexture, localTextureClamped, queue, hw, hh } = ws;
  visited.fill(0);
  const pocketTol = coreBgTol + 9.5;
  const strictHumanPockets = clothOverexposureGuard;
  const maxSatPocket = isChromaBg ? 255.0 : (strictHumanPockets ? (qualityPlus ? 2.8 : 3.2) : 14.0);
  const maxTexPocket = strictHumanPockets ? (qualityPlus ? 2.2 : 2.4) : 4.2;
  const maxMeanTex = strictHumanPockets ? (qualityPlus ? 2.1 : 2.2) : 3.4;
  const pocketSeeds = [];
  const maxX = width - 1;
  const maxY = height - 1;
  const maxHx = hw - 1;
  const maxHy = hh - 1;

  for (let y = 0; y < height; y++) {
    const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
    const hRowOff = hy * hw;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const i = rowOff + x;
      if (bgState[i] > 0 || visited[i]) continue;
      const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
      if (hInward[hRowOff + hx] >= inwardPocketCap) continue;
      if (distToBg[i] > pocketTol || sat[i] > maxSatPocket || localTextureClamped[i] > maxTexPocket) {
        visited[i] = 1;
        continue;
      }

      let cHead = 0, cTail = 0;
      queue[cTail++] = (y << 16) | x;
      visited[i] = 1;
      let sumDist = 0, minDist = Infinity, sumTex = 0;

      while (cHead < cTail) {
        const pk = queue[cHead++];
        const px = pk & 0xFFFF;
        const py = pk >>> 16;
        const pIdx = py * width + px;
        const d = distToBg[pIdx];
        sumDist += d;
        if (d < minDist) minDist = d;
        sumTex += localTextureClamped[pIdx];
        const phy = (py >> 1) < hh ? (py >> 1) : maxHy;
        const phRow = phy * hw;

        if (px > 0) {
          const nIdx = pIdx - 1;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[phRow + (((px - 1) >> 1) < hw ? ((px - 1) >> 1) : maxHx)] < inwardPocketCap && distToBg[nIdx] <= pocketTol && sat[nIdx] <= maxSatPocket && localTextureClamped[nIdx] <= maxTexPocket) {
            visited[nIdx] = 1; queue[cTail++] = (py << 16) | (px - 1);
          }
        }
        if (px < maxX) {
          const nIdx = pIdx + 1;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[phRow + (((px + 1) >> 1) < hw ? ((px + 1) >> 1) : maxHx)] < inwardPocketCap && distToBg[nIdx] <= pocketTol && sat[nIdx] <= maxSatPocket && localTextureClamped[nIdx] <= maxTexPocket) {
            visited[nIdx] = 1; queue[cTail++] = (py << 16) | (px + 1);
          }
        }
        if (py > 0) {
          const nIdx = pIdx - width;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[((((py - 1) >> 1) < hh ? ((py - 1) >> 1) : maxHy) * hw) + ((px >> 1) < hw ? (px >> 1) : maxHx)] < inwardPocketCap && distToBg[nIdx] <= pocketTol && sat[nIdx] <= maxSatPocket && localTextureClamped[nIdx] <= maxTexPocket) {
            visited[nIdx] = 1; queue[cTail++] = ((py - 1) << 16) | px;
          }
        }
        if (py < maxY) {
          const nIdx = pIdx + width;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[((((py + 1) >> 1) < hh ? ((py + 1) >> 1) : maxHy) * hw) + ((px >> 1) < hw ? (px >> 1) : maxHx)] < inwardPocketCap && distToBg[nIdx] <= pocketTol && sat[nIdx] <= maxSatPocket && localTextureClamped[nIdx] <= maxTexPocket) {
            visited[nIdx] = 1; queue[cTail++] = ((py + 1) << 16) | px;
          }
        }
      }

      const area = cTail;
      if (area < 28) continue;
      if (minDist <= coreBgTol && (sumDist / area) <= coreBgTol + 5.5 && (sumTex / area) <= maxMeanTex) {
        for (let k = 0; k < area; k++) {
          const pk = queue[k];
          bgState[(pk >>> 16) * width + (pk & 0xFFFF)] = 1;
          pocketSeeds.push(pk);
        }
      }
    }
  }

  if (pocketSeeds.length > 0) {
    let head = 0, tail = 0;
    for (let k = 0; k < pocketSeeds.length; k++) queue[tail++] = pocketSeeds[k];
    while (head < tail) {
      const packed = queue[head++];
      const x = packed & 0xFFFF;
      const y = packed >>> 16;
      const idx = y * width + x;
      const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
      const hRow = hy * hw;

      const expand = (nIdx, nx, ny, inD) => {
        if (bgState[nIdx] !== 0 || inD >= inwardFloodCap) return;
        if (strictHumanPockets && qualityPlus && ((sat[nIdx] >= 2.8 && distToBg[nIdx] >= 3.2) || localTextureClamped[nIdx] >= 2.2)) return;
        if (strictHumanPockets && !qualityPlus && ((sat[nIdx] >= 3.0 && distToBg[nIdx] >= 3.5) || localTextureClamped[nIdx] >= 2.4)) return;
        const d = distToBg[nIdx];
        if (d <= coreBgTol) {
          bgState[nIdx] = ((lum[nIdx] - bgLum[nIdx]) > 9.0 && sat[nIdx] < 16 && grad[nIdx] < 9.5 && localTexture[nIdx] >= 2.2) ? 2 : 1;
          queue[tail++] = (ny << 16) | nx;
        } else if (d <= gapTol && grad[nIdx] < 13.5 && sat[nIdx] < 14) {
          bgState[nIdx] = ((lum[nIdx] - bgLum[nIdx]) > 8.5 && localTexture[nIdx] >= 2.2) ? 2 : 3;
          queue[tail++] = (ny << 16) | nx;
        }
      };

      if (x > 0) expand(idx - 1, x - 1, y, hInward[hRow + (((x - 1) >> 1) < hw ? ((x - 1) >> 1) : maxHx)]);
      if (x < maxX) expand(idx + 1, x + 1, y, hInward[hRow + (((x + 1) >> 1) < hw ? ((x + 1) >> 1) : maxHx)]);
      if (y > 0) expand(idx - width, x, y - 1, hInward[((((y - 1) >> 1) < hh ? ((y - 1) >> 1) : maxHy) * hw) + ((x >> 1) < hw ? (x >> 1) : maxHx)]);
      if (y < maxY) expand(idx + width, x, y + 1, hInward[((((y + 1) >> 1) < hh ? ((y + 1) >> 1) : maxHy) * hw) + ((x >> 1) < hw ? (x >> 1) : maxHx)]);
    }
  }
}

function stage3BHairMicroGaps(width, height, ws, hInward, coreBgTol, hairGapInwardCap) {
  const { bgState, visited, distToBg, sat, grad, localTexture, localTextureClamped, queue, hw, hh } = ws;
  visited.fill(0);
  const hairGapTol = coreBgTol * 0.96;
  const hairCoreTol = coreBgTol * 0.72;
  const expandCap = hairGapInwardCap + 4;
  const hairGapSeeds = [];
  const maxX = width - 1;
  const maxY = height - 1;
  const maxHx = hw - 1;
  const maxHy = hh - 1;

  // Strictly targets neutral BG micro-gaps trapped between sharp hair/fur strands (never tinted/woven clothing!)
  for (let y = 1; y < height - 1; y++) {
    const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
    const hRowOff = hy * hw;
    const rowOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = rowOff + x;
      if (bgState[i] > 0 || visited[i]) continue;
      const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
      if (hInward[hRowOff + hx] >= hairGapInwardCap) continue;
      if (distToBg[i] > hairGapTol || sat[i] > 2.4 || grad[i] > 10.5) {
        visited[i] = 1;
        continue;
      }

      let cHead = 0, cTail = 0;
      queue[cTail++] = (y << 16) | x;
      visited[i] = 1;
      let sumDist = 0, minDist = Infinity, sumSat = 0, maxSharpStrandTex = 0;

      while (cHead < cTail) {
        const pk = queue[cHead++];
        const px = pk & 0xFFFF;
        const py = pk >>> 16;
        const pIdx = py * width + px;
        const d = distToBg[pIdx];
        sumDist += d;
        if (d < minDist) minDist = d;
        sumSat += sat[pIdx];
        const tex = localTexture[pIdx];
        const texC = localTextureClamped[pIdx];
        if (tex > texC * 1.22 && tex > maxSharpStrandTex) maxSharpStrandTex = tex;

        const phy = (py >> 1) < hh ? (py >> 1) : maxHy;
        const phRow = phy * hw;

        if (px > 0) {
          const nIdx = pIdx - 1;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[phRow + (((px - 1) >> 1) < hw ? ((px - 1) >> 1) : maxHx)] < hairGapInwardCap && distToBg[nIdx] <= hairGapTol && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
            visited[nIdx] = 1; queue[cTail++] = (py << 16) | (px - 1);
          }
        }
        if (px < maxX) {
          const nIdx = pIdx + 1;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[phRow + (((px + 1) >> 1) < hw ? ((px + 1) >> 1) : maxHx)] < hairGapInwardCap && distToBg[nIdx] <= hairGapTol && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
            visited[nIdx] = 1; queue[cTail++] = (py << 16) | (px + 1);
          }
        }
        if (py > 0) {
          const nIdx = pIdx - width;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[((((py - 1) >> 1) < hh ? ((py - 1) >> 1) : maxHy) * hw) + ((px >> 1) < hw ? (px >> 1) : maxHx)] < hairGapInwardCap && distToBg[nIdx] <= hairGapTol && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
            visited[nIdx] = 1; queue[cTail++] = ((py - 1) << 16) | px;
          }
        }
        if (py < maxY) {
          const nIdx = pIdx + width;
          if (!visited[nIdx] && bgState[nIdx] === 0 && hInward[((((py + 1) >> 1) < hh ? ((py + 1) >> 1) : maxHy) * hw) + ((px >> 1) < hw ? (px >> 1) : maxHx)] < hairGapInwardCap && distToBg[nIdx] <= hairGapTol && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
            visited[nIdx] = 1; queue[cTail++] = ((py + 1) << 16) | px;
          }
        }
      }

      const area = cTail;
      if (area >= 4 && area <= 700 && minDist <= hairCoreTol && (sumDist / area) <= coreBgTol * 0.86 && (sumSat / area) <= 2.5 && maxSharpStrandTex >= 5.5) {
        for (let k = 0; k < area; k++) {
          const pk = queue[k];
          bgState[(pk >>> 16) * width + (pk & 0xFFFF)] = 1;
          hairGapSeeds.push(pk);
        }
      }
    }
  }

  if (hairGapSeeds.length > 0) {
    let head = 0, tail = 0;
    for (let k = 0; k < hairGapSeeds.length; k++) queue[tail++] = hairGapSeeds[k];
    while (head < tail) {
      const packed = queue[head++];
      const x = packed & 0xFFFF;
      const y = packed >>> 16;
      const idx = y * width + x;
      const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
      const hRow = hy * hw;

      if (x > 0) {
        const nIdx = idx - 1;
        if (bgState[nIdx] === 0 && hInward[hRow + (((x - 1) >> 1) < hw ? ((x - 1) >> 1) : maxHx)] < expandCap && distToBg[nIdx] <= coreBgTol * 1.05 && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
          bgState[nIdx] = distToBg[nIdx] <= coreBgTol ? 1 : 3;
          if (bgState[nIdx] === 1) queue[tail++] = (y << 16) | (x - 1);
        }
      }
      if (x < maxX) {
        const nIdx = idx + 1;
        if (bgState[nIdx] === 0 && hInward[hRow + (((x + 1) >> 1) < hw ? ((x + 1) >> 1) : maxHx)] < expandCap && distToBg[nIdx] <= coreBgTol * 1.05 && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
          bgState[nIdx] = distToBg[nIdx] <= coreBgTol ? 1 : 3;
          if (bgState[nIdx] === 1) queue[tail++] = (y << 16) | (x + 1);
        }
      }
      if (y > 0) {
        const nIdx = idx - width;
        const nhy = ((y - 1) >> 1) < hh ? ((y - 1) >> 1) : maxHy;
        if (bgState[nIdx] === 0 && hInward[nhy * hw + ((x >> 1) < hw ? (x >> 1) : maxHx)] < expandCap && distToBg[nIdx] <= coreBgTol * 1.05 && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
          bgState[nIdx] = distToBg[nIdx] <= coreBgTol ? 1 : 3;
          if (bgState[nIdx] === 1) queue[tail++] = ((y - 1) << 16) | x;
        }
      }
      if (y < maxY) {
        const nIdx = idx + width;
        const nhy = ((y + 1) >> 1) < hh ? ((y + 1) >> 1) : maxHy;
        if (bgState[nIdx] === 0 && hInward[nhy * hw + ((x >> 1) < hw ? (x >> 1) : maxHx)] < expandCap && distToBg[nIdx] <= coreBgTol * 1.05 && sat[nIdx] <= 2.8 && grad[nIdx] <= 10.5) {
          bgState[nIdx] = distToBg[nIdx] <= coreBgTol ? 1 : 3;
          if (bgState[nIdx] === 1) queue[tail++] = ((y + 1) << 16) | x;
        }
      }
    }
  }
}

function stage4BoundaryDistance(width, height, ws, maxDepth) {
  const { total, bgState, distFromBg, queue } = ws;
  const maxX = width - 1;
  const maxY = height - 1;
  distFromBg.fill(255);
  let head = 0, tail = 0;

  for (let i = 0; i < total; i++) {
    if (bgState[i] === 1) distFromBg[i] = 0;
  }
  for (let y = 1; y < height - 1; y++) {
    const rOff = y * width;
    const rT = rOff - width;
    const rB = rOff + width;
    for (let x = 1; x < width - 1; x++) {
      const i = rOff + x;
      if (bgState[i] !== 1) {
        if (
          bgState[i - 1] === 1 || bgState[i + 1] === 1 ||
          bgState[rT + x] === 1 || bgState[rB + x] === 1 ||
          bgState[rT + x - 1] === 1 || bgState[rT + x + 1] === 1 ||
          bgState[rB + x - 1] === 1 || bgState[rB + x + 1] === 1
        ) {
          distFromBg[i] = 1;
          queue[tail++] = (y << 16) | x;
        }
      }
    }
  }
  while (head < tail) {
    const packed = queue[head++];
    const x = packed & 0xFFFF;
    const y = packed >>> 16;
    const idx = y * width + x;
    const nextD = distFromBg[idx] + 1;
    if (nextD > maxDepth) continue;
    if (x > 0 && distFromBg[idx - 1] === 255) {
      distFromBg[idx - 1] = nextD;
      queue[tail++] = (y << 16) | (x - 1);
    }
    if (x < maxX && distFromBg[idx + 1] === 255) {
      distFromBg[idx + 1] = nextD;
      queue[tail++] = (y << 16) | (x + 1);
    }
    if (y > 0 && distFromBg[idx - width] === 255) {
      distFromBg[idx - width] = nextD;
      queue[tail++] = ((y - 1) << 16) | x;
    }
    if (y < maxY && distFromBg[idx + width] === 255) {
      distFromBg[idx + width] = nextD;
      queue[tail++] = ((y + 1) << 16) | x;
    }
  }
}

function stage5GeodesicBarrier(width, height, ws) {
  const { total, bgState, contourBarrier, visited, queue, bgLum, lum, grad } = ws;
  const maxX = width - 1;
  const maxY = height - 1;
  contourBarrier.fill(999);
  const inQueue = visited;
  inQueue.fill(0);
  let head = 0, tail = 0;

  for (let i = 0; i < total; i++) {
    if (bgState[i] === 1 || bgState[i] === 2) contourBarrier[i] = 0;
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
          queue[tail++] = (y << 16) | x;
        }
      }
    }
  }

  while (head !== tail) {
    const packed = queue[head++];
    if (head === total) head = 0;
    const x = packed & 0xFFFF;
    const y = packed >>> 16;
    const idx = y * width + x;
    inQueue[idx] = 0;
    const curB = contourBarrier[idx];
    if (curB >= 24.2) continue;

    if (x > 0) {
      const nIdx = idx - 1;
      const bL = bgLum[nIdx], lVal = lum[nIdx], gVal = grad[nIdx];
      const sc = (gVal > 14 ? gVal * 0.65 : gVal * 0.15) + (lVal < bL - 8 ? (bL - lVal) * 1.6 : 0);
      const nextB = curB + (sc > 0.35 ? sc : 0.35);
      if (nextB < contourBarrier[nIdx]) {
        contourBarrier[nIdx] = nextB;
        if (nextB < 24.2 && inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          queue[tail++] = (y << 16) | (x - 1);
          if (tail === total) tail = 0;
        }
      }
    }
    if (x < maxX) {
      const nIdx = idx + 1;
      const bL = bgLum[nIdx], lVal = lum[nIdx], gVal = grad[nIdx];
      const sc = (gVal > 14 ? gVal * 0.65 : gVal * 0.15) + (lVal < bL - 8 ? (bL - lVal) * 1.6 : 0);
      const nextB = curB + (sc > 0.35 ? sc : 0.35);
      if (nextB < contourBarrier[nIdx]) {
        contourBarrier[nIdx] = nextB;
        if (nextB < 24.2 && inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          queue[tail++] = (y << 16) | (x + 1);
          if (tail === total) tail = 0;
        }
      }
    }
    if (y > 0) {
      const nIdx = idx - width;
      const bL = bgLum[nIdx], lVal = lum[nIdx], gVal = grad[nIdx];
      const sc = (gVal > 14 ? gVal * 0.65 : gVal * 0.15) + (lVal < bL - 8 ? (bL - lVal) * 1.6 : 0);
      const nextB = curB + (sc > 0.35 ? sc : 0.35);
      if (nextB < contourBarrier[nIdx]) {
        contourBarrier[nIdx] = nextB;
        if (nextB < 24.2 && inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          queue[tail++] = ((y - 1) << 16) | x;
          if (tail === total) tail = 0;
        }
      }
    }
    if (y < maxY) {
      const nIdx = idx + width;
      const bL = bgLum[nIdx], lVal = lum[nIdx], gVal = grad[nIdx];
      const sc = (gVal > 14 ? gVal * 0.65 : gVal * 0.15) + (lVal < bL - 8 ? (bL - lVal) * 1.6 : 0);
      const nextB = curB + (sc > 0.35 ? sc : 0.35);
      if (nextB < contourBarrier[nIdx]) {
        contourBarrier[nIdx] = nextB;
        if (nextB < 24.2 && inQueue[nIdx] === 0) {
          inQueue[nIdx] = 1;
          queue[tail++] = ((y + 1) << 16) | x;
          if (tail === total) tail = 0;
        }
      }
    }
  }
}

function buildDualPolarityFgField(data, width, ws, coreBgTol) {
  const { hw, hh, bgState, distFromBg, distToBg, sat, lum, bgLum, hFgBrR, hFgBrG, hFgBrB, hFgBrW, hFgDkR, hFgDkG, hFgDkB, hFgDkW, hTmp0, hColSum0 } = ws;
  const cleanMinDist = coreBgTol + 18.0;
  for (let hy = 0; hy < hh; hy++) {
    const r0 = (hy << 1) * width;
    const hOff = hy * hw;
    for (let hx = 0; hx < hw; hx++) {
      const i = r0 + (hx << 1);
      const hIdx = hOff + hx;
      const d = distToBg[i];
      if (bgState[i] === 0 && distFromBg[i] >= 3 && d > cleanMinDist) {
        const off = i << 2;
        const r = data[off], g = data[off + 1], b = data[off + 2];
        // Cubic distance + saturation weighting ensures pure deep hair/fur dominates over gray haze
        const dEx = d - cleanMinDist;
        const w = dEx * dEx * dEx * (1.0 + sat[i] * 0.06) * 0.000005;
        if (lum[i] >= bgLum[i]) {
          hFgBrR[hIdx] = r * w; hFgBrG[hIdx] = g * w; hFgBrB[hIdx] = b * w; hFgBrW[hIdx] = w;
          hFgDkR[hIdx] = 0; hFgDkG[hIdx] = 0; hFgDkB[hIdx] = 0; hFgDkW[hIdx] = 0;
        } else {
          hFgDkR[hIdx] = r * w; hFgDkG[hIdx] = g * w; hFgDkB[hIdx] = b * w; hFgDkW[hIdx] = w;
          hFgBrR[hIdx] = 0; hFgBrG[hIdx] = 0; hFgBrB[hIdx] = 0; hFgBrW[hIdx] = 0;
        }
      } else {
        hFgBrR[hIdx] = 0; hFgBrG[hIdx] = 0; hFgBrB[hIdx] = 0; hFgBrW[hIdx] = 0;
        hFgDkR[hIdx] = 0; hFgDkG[hIdx] = 0; hFgDkB[hIdx] = 0; hFgDkW[hIdx] = 0;
      }
    }
  }
  // 2-pass r=6 half-res diffusion (~24 full-px reach) so deep Afro curl pockets & cheek fluff see true surrounding hair/fur color
  for (let pass = 0; pass < 2; pass++) {
    boxFilterFast(hFgBrR, hFgBrR, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgBrG, hFgBrG, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgBrB, hFgBrB, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgBrW, hFgBrW, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgDkR, hFgDkR, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgDkG, hFgDkG, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgDkB, hFgDkB, hTmp0, hColSum0, hw, hh, 6);
    boxFilterFast(hFgDkW, hFgDkW, hTmp0, hColSum0, hw, hh, 6);
  }
}

function stage6UnmixExact(data, width, height, ws, hInward, bgPlane, furCaptureDepth, edgeProtectRadius, clothOverexposureGuard, qualityPlus, translucentPastelBody = false) {
  const { bgState, distFromBg, contourBarrier, sat, grad, distToBg, lum, bgLum, localTexture, localTextureClamped, rawAlpha, visited, pureR, pureG, pureB, hw, hh } = ws;
  const { cR0, cR1, cR2, cR3, cG0, cG1, cG2, cG3, cB0, cB1, cB2, cB3, invW, invH, coreBgTol, gapTol, isMidToneBg = true } = bgPlane;
  const rgbModified = visited;
  rgbModified.fill(0);
  const maxX = width - 1;
  const maxY = height - 1;
  const maxHx = hw - 1;
  const maxHy = hh - 1;
  const torsoY = (height * 0.44) | 0;
  const baseRad = furCaptureDepth > 8 ? 10 : 8;
  const midRingCap = furCaptureDepth > 8 ? 7 : 5;
  const invUnmixSpan = 1 / Math.max(1, furCaptureDepth - 2);

  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const omtY = 1 - ty;
    const r0 = omtY * cR0 + ty * cR2;
    const rStep = ((omtY * cR1 + ty * cR3) - r0) * invW;
    const g0 = omtY * cG0 + ty * cG2;
    const gStep = ((omtY * cG1 + ty * cG3) - g0) * invW;
    const b0 = omtY * cB0 + ty * cB2;
    const bStep = ((omtY * cB1 + ty * cB3) - b0) * invW;
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const i = rowOff + x;
      const state = bgState[i];
      if (state === 1) {
        rawAlpha[i] = 0;
        continue;
      }

      const ring = distFromBg[i];
      const cb = contourBarrier[i];
      const sVal = sat[i];
      const gVal = grad[i];
      const d = distToBg[i];
      const tex = localTexture[i];
      const texC = localTextureClamped[i];

      const isHairFurTex = tex >= 8.5 && tex > texC * 1.22;
      const isProtectedHumanCloth = clothOverexposureGuard
        && state === 0
        && !isHairFurTex
        && sVal >= 2.3
        && d >= 3.8
        && (y >= torsoY || (ring <= edgeProtectRadius && texC >= 2.2));

      const isEdge = (ring <= furCaptureDepth || state === 3);
      const canBeVapor = isMidToneBg && !isProtectedHumanCloth && ((state === 2) || (cb < 24 && sVal <= 22 && gVal < 20 && lum[i] > bgLum[i] + 4.0));
      const canBeBokeh = isMidToneBg && (ring > 2 && cb < 18 && gVal < 9.5 && sVal >= 15 && sVal <= 95 && d < 95 && tex < 6.0);
      const canBeBalloon = translucentPastelBody && (qualityPlus
        ? (ring > 2 && gVal < 5.0 && sVal >= 20 && sVal <= 108 && d < 104 && texC < 2.8)
        : (ring > 2 && gVal < 4.2 && sVal >= 20 && sVal <= 105 && d < 100 && texC < 2.3));

      if (!isEdge && !canBeVapor && !canBeBokeh && !canBeBalloon) {
        rawAlpha[i] = 1.0;
        continue;
      }

      const off = i << 2;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const bR = r0 + x * rStep;
      const bG = g0 + x * gStep;
      const bB = b0 + x * bStep;

      let alpha = 1.0;
      let outR = r, outG = g, outB = b;
      let modified = false;

      if (canBeVapor) {
        const bL = bgLum[i];
        const span = Math.max(30, 245 - bL);
        const excess = Math.max(0, lum[i] - bL - 2.5);
        const vaporA = clamp(Math.pow(excess / span, 0.78), 0, 0.95);
        const solidBlend = state === 2 ? 0 : smoothstep(12, 24, cb);
        alpha = vaporA * (1 - solidBlend) + solidBlend;
        const unmixA = Math.max(0.14, alpha);
        const invUA = 1 / unmixA;
        const oneMinus = 1 - unmixA;
        outR = clamp((r - oneMinus * bR) * invUA, r, 255);
        outG = clamp((g - oneMinus * bG) * invUA, g, 255);
        outB = clamp((b - oneMinus * bB) * invUA, b, 255);
        modified = true;
      } else if (isEdge) {
        let fgR = r, fgG = g, fgB = b, bestDist = d;
        const rClamp = ring < furCaptureDepth ? ring : furCaptureDepth;
        const radCand = (furCaptureDepth + 3) - rClamp;
        const rad = radCand < baseRad ? radCand : baseRad;
        const nyStart = y - rad;
        const nyEnd = y + rad;
        const nxStart = x - rad;
        const nxEnd = x + rad;
        const y0 = nyStart < 0 ? nyStart + (((-nyStart + 1) >> 1) << 1) : nyStart;
        const y1 = nyEnd < height ? nyEnd : maxY;
        const x0 = nxStart < 0 ? nxStart + (((-nxStart + 1) >> 1) << 1) : nxStart;
        const x1 = nxEnd < width ? nxEnd : maxX;

        for (let ny = y0; ny <= y1; ny += 2) {
          const nRowOff = ny * width;
          for (let nx = x0; nx <= x1; nx += 2) {
            const nIdx = nRowOff + nx;
            const nd = distToBg[nIdx];
            if (nd > bestDist && bgState[nIdx] !== 1 && distFromBg[nIdx] >= ring) {
              bestDist = nd;
              const nOff = nIdx << 2;
              fgR = data[nOff]; fgG = data[nOff + 1]; fgB = data[nOff + 2];
            }
          }
        }

        const vx = fgR - bR, vy = fgG - bG, vz = fgB - bB;
        const vLenSq = vx * vx + vy * vy + vz * vz;
        const projA = vLenSq > 49
          ? clamp(((r - bR) * vx + (g - bG) * vy + (b - bB) * vz) / vLenSq, 0, 1)
          : smoothstep(coreBgTol * 0.55, coreBgTol + 20, d);

        const distA = smoothstep(coreBgTol * 0.5, coreBgTol + 22, d);
        if (state === 3) {
          alpha = Math.min(projA, distA) * smoothstep(coreBgTol * 0.45, gapTol + 3, d);
        } else if (isProtectedHumanCloth && ring <= edgeProtectRadius) {
          const chromaA = smoothstep(2.0, 3.6, sVal);
          alpha = ring <= 1 ? clamp(Math.max(0.58, chromaA, projA, distA), 0.58, 1) : 1.0;
        } else if (ring <= 2) {
          alpha = Math.min(projA, Math.max(distA, projA * 0.85));
        } else if (ring <= midRingCap) {
          alpha = clamp(Math.max(projA, distA), 0.25, 1);
        } else {
          alpha = clamp(Math.max(0.85, projA), 0.85, 1);
        }

        if (alpha > 0.03) {
          const unmixA = alpha < 0.20 ? 0.20 : alpha > 1.0 ? 1.0 : alpha;
          const invUA = 1 / unmixA;
          const oneMinus = 1 - unmixA;
          let uR = clamp((r - oneMinus * bR) * invUA, 0, 255);
          let uG = clamp((g - oneMinus * bG) * invUA, 0, 255);
          let uB = clamp((b - oneMinus * bB) * invUA, 0, 255);

          if (bgPlane.isGreenChroma) {
            const maxNonGreen = Math.max(uR, uB);
            if (uG > maxNonGreen) {
              uG = (maxNonGreen * 0.75 + ((uR + uB) * 0.5) * 0.25);
            }
          } else if (bgPlane.isBlueChroma) {
            const maxNonBlue = Math.max(uR, uG);
            if (uB > maxNonBlue) {
              uB = (maxNonBlue * 0.75 + ((uR + uG) * 0.5) * 0.25);
            }
          }

          const w = isProtectedHumanCloth
            ? (ring <= 2 ? 0.60 : 0.0)
            : ring <= 3 ? 0.92 : Math.max(0, ((furCaptureDepth + 1) - ring) * invUnmixSpan) * 0.70;
          outR = r + (uR - r) * w;
          outG = g + (uG - g) * w;
          outB = b + (uB - b) * w;
          if (bgPlane.isGreenChroma) {
            const mNG = Math.max(outR, outB);
            if (outG > mNG) {
              outG = (mNG * 0.75 + ((outR + outB) * 0.5) * 0.25);
            }
          }
          modified = true;
        }
      }

      if (canBeBokeh) {
        const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
        const rawBokehA = clamp(sVal / 90 + d / 135 + specBoost, 0.42, 1.0);
        const solidBlend = smoothstep(8, 18, cb);
        const bokehAlpha = rawBokehA * (1 - solidBlend) + solidBlend;
        if (bokehAlpha < alpha) {
          alpha = bokehAlpha;
          const unmixA = alpha < 0.40 ? 0.40 : alpha;
          const invUA = 1 / unmixA;
          const oneMinus = 1 - unmixA;
          outR = clamp((r - oneMinus * bR) * invUA, 0, 255);
          outG = clamp((g - oneMinus * bG) * invUA, g, 255);
          outB = clamp((b - oneMinus * bB) * invUA, b, 255);
          modified = true;
        }
      } else if (canBeBalloon) {
        if (qualityPlus) {
          const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
          const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
          const inDist = hInward[hy * hw + hx];
          const solidProtection = smoothstep(18, 34, cb) * smoothstep(20, 36, inDist);
          const texWeight = 1.0 - smoothstep(1.8, 2.8, texC);
          const gradWeight = 1.0 - smoothstep(3.2, 5.0, gVal);
          const satWeight = smoothstep(20, 26, sVal) * (1.0 - smoothstep(88, 108, sVal));
          const distWeight = 1.0 - smoothstep(84, 104, d);
          const balloonWeight = texWeight * gradWeight * satWeight * distWeight * (1.0 - solidProtection);
          if (balloonWeight > 0.01) {
            const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
            const rawBalloonA = clamp(sVal / 95 + d / 145 + specBoost, 0.44, 1.0);
            const balloonAlpha = 1.0 - (1.0 - rawBalloonA) * balloonWeight;
            if (balloonAlpha < alpha) {
              alpha = balloonAlpha;
              const unmixA = alpha < 0.42 ? 0.42 : alpha;
              const invUA = 1 / unmixA;
              const oneMinus = 1 - unmixA;
              outR = clamp((r - oneMinus * bR) * invUA, 0, 255);
              outG = clamp((g - oneMinus * bG) * invUA, 0, 255);
              outB = clamp((b - oneMinus * bB) * invUA, 0, 255);
              modified = true;
            }
          }
        } else if (sVal >= 24 && sVal <= 95 && d < 92) {
          const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
          const balloonAlpha = clamp(sVal / 95 + d / 145 + specBoost, 0.44, 1.0);
          if (balloonAlpha < alpha) {
            alpha = balloonAlpha;
            const unmixA = alpha < 0.42 ? 0.42 : alpha;
            const invUA = 1 / unmixA;
            const oneMinus = 1 - unmixA;
            outR = clamp((r - oneMinus * bR) * invUA, 0, 255);
            outG = clamp((g - oneMinus * bG) * invUA, 0, 255);
            outB = clamp((b - oneMinus * bB) * invUA, 0, 255);
            modified = true;
          }
        }
      }

      rawAlpha[i] = alpha < 0.02 ? 0 : alpha;
      if (modified) {
        rgbModified[i] = 1;
        pureR[i] = (outR + 0.5) | 0;
        pureG[i] = (outG + 0.5) | 0;
        pureB[i] = (outB + 0.5) | 0;
      }
    }
  }
}

function stage6UnmixQuality(data, width, height, ws, hInward, bgPlane, furRing, edgeProtectRadius, clothOverexposureGuard, inwardFloodCap, translucentPastelBody = false) {
  const { bgState, distFromBg, contourBarrier, sat, grad, distToBg, lum, bgLum, localTexture, localTextureClamped, rawAlpha, visited, pureR, pureG, pureB, hw, hh, hFgBrR, hFgBrG, hFgBrB, hFgBrW, hFgDkR, hFgDkG, hFgDkB, hFgDkW } = ws;
  const { cR0, cR1, cR2, cR3, cG0, cG1, cG2, cG3, cB0, cB1, cB2, cB3, invW, invH, coreBgTol, gapTol, isMidToneBg = true } = bgPlane;
  const rgbModified = visited;
  rgbModified.fill(0);

  buildDualPolarityFgField(data, width, ws, coreBgTol);

  const maxHx = hw - 1;
  const maxHy = hh - 1;
  const torsoY = (height * 0.44) | 0;
  const furWeightDenom = Math.max(1, furRing - 4);

  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const omtY = 1 - ty;
    const r0 = omtY * cR0 + ty * cR2;
    const rStep = ((omtY * cR1 + ty * cR3) - r0) * invW;
    const g0 = omtY * cG0 + ty * cG2;
    const gStep = ((omtY * cG1 + ty * cG3) - g0) * invW;
    const b0 = omtY * cB0 + ty * cB2;
    const bStep = ((omtY * cB1 + ty * cB3) - b0) * invW;
    const rowOff = y * width;
    const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
    const hRowOff = hy * hw;

    for (let x = 0; x < width; x++) {
      const i = rowOff + x;
      const state = bgState[i];
      if (state === 1) {
        rawAlpha[i] = 0;
        continue;
      }

      const ring = distFromBg[i];
      const cb = contourBarrier[i];
      const sVal = sat[i];
      const gVal = grad[i];
      const d = distToBg[i];
      const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
      const hIdx = hRowOff + hx;
      const inDist = hInward[hIdx];
      const tex = localTexture[i];
      const texC = localTextureClamped[i];

      // Distinguish sharp hair/fur strands from genuinely hue-shifted solid clothing (never neutral BG halo!)
      const isHairFurTex = tex >= 8.5 && tex > texC * 1.22;
      const isTrappedHairWeb = ring <= furRing && inDist < inwardFloodCap && d <= coreBgTol + 14 && sVal < 3.5 && isHairFurTex;
      const isEdge = (ring <= furRing || state === 3 || isTrappedHairWeb);
      // Prevent vapor/steam detector from overexposing/eroding lit human clothing shoulders without affecting animal mist
      const isProtectedHumanCloth = clothOverexposureGuard
        && state === 0
        && !isHairFurTex
        && y >= torsoY
        && sVal >= 2.3
        && d >= 3.8;
      const isLitClothRim = isProtectedHumanCloth || (clothOverexposureGuard && state === 0 && y >= torsoY && texC >= 2.6 && sVal >= 2.8 && sVal <= 7.0 && lum[i] < bgLum[i] + 24.0);
      const vaporMinLum = clothOverexposureGuard ? 20.0 : 8.5;
      const canBeVapor = isMidToneBg && !isLitClothRim
        && ((state === 2) || (cb < 24 && sVal <= 20 && gVal < 18 && lum[i] > bgLum[i] + vaporMinLum && (state !== 0 || ring > 2)));
      const canBeBokeh = isMidToneBg && (ring > 2 && cb < 18 && gVal < 9.5 && sVal >= 15 && sVal <= 95 && d < 95 && tex < 6.0);
      const canBeBalloon = translucentPastelBody && (ring > 2 && gVal < 5.2 && sVal >= 20 && sVal <= 105 && d < 100 && texC < 3.0);

      if (!isEdge && !canBeVapor && !canBeBokeh && !canBeBalloon) {
        rawAlpha[i] = 1.0;
        continue;
      }

      const off = i << 2;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      const bR = r0 + x * rStep;
      const bG = g0 + x * gStep;
      const bB = b0 + x * bStep;

      let alpha = 1.0;
      let outR = r, outG = g, outB = b;
      let modified = false;

      if (canBeVapor) {
        const bL = bgLum[i];
        const span = Math.max(30, 245 - bL);
        const excess = Math.max(0, lum[i] - bL - 2.5);
        const vaporA = clamp(Math.pow(excess / span, 0.78), 0, 0.95);
        const solidBlend = state === 2 ? 0 : smoothstep(12, 24, cb);
        alpha = vaporA * (1 - solidBlend) + solidBlend;
        const unmixA = sVal < 14
          ? Math.max(0.16, vaporA * (1 - solidBlend * 0.5) + alpha * (solidBlend * 0.5))
          : Math.max(0.14, alpha);
        const invUA = 1 / unmixA;
        const oneMinus = 1 - unmixA;
        outR = clamp((r - oneMinus * bR) * invUA, r, 255);
        outG = clamp((g - oneMinus * bG) * invUA, g, 255);
        outB = clamp((b - oneMinus * bB) * invUA, b, 255);
        modified = true;
      } else if (isEdge) {
        const drC = r - bR, dgC = g - bG, dbC = b - bB;
        const bL = bgLum[i];
        const lDiff = lum[i] - bL;

        const brW = hFgBrW[hIdx];
        const dkW = hFgDkW[hIdx];
        let fgR = r, fgG = g, fgB = b;
        let hasPrior = false;
        const preferDarkOnGrayFluff = isHairFurTex && ring <= furRing && sVal <= 4.5 && d <= 48.0 && dkW > brW * 1.25;

        if (brW > 0.002 && dkW > 0.002) {
          if (!preferDarkOnGrayFluff && (lDiff > 4.0 || (lDiff < -4.0 && brW > dkW * 2.5 && lDiff > -28.0) || (lDiff >= -4.0 && lDiff <= 4.0 && brW >= dkW))) {
            const inv = 1 / brW;
            fgR = hFgBrR[hIdx] * inv; fgG = hFgBrG[hIdx] * inv; fgB = hFgBrB[hIdx] * inv;
          } else {
            const inv = 1 / dkW;
            fgR = hFgDkR[hIdx] * inv; fgG = hFgDkG[hIdx] * inv; fgB = hFgDkB[hIdx] * inv;
          }
          hasPrior = true;
        } else if (brW > 0.002) {
          const inv = 1 / brW;
          fgR = hFgBrR[hIdx] * inv; fgG = hFgBrG[hIdx] * inv; fgB = hFgBrB[hIdx] * inv;
          hasPrior = true;
        } else if (dkW > 0.002) {
          const inv = 1 / dkW;
          fgR = hFgDkR[hIdx] * inv; fgG = hFgDkG[hIdx] * inv; fgB = hFgDkB[hIdx] * inv;
          hasPrior = true;
        }

        const vx = fgR - bR, vy = fgG - bG, vz = fgB - bB;
        const vLenSq = vx * vx + vy * vy + vz * vz;
        const projA = vLenSq > 64
          ? clamp((drC * vx + dgC * vy + dbC * vz) / vLenSq, 0, 1)
          : smoothstep(coreBgTol * 0.55, coreBgTol + 20, d);

        const distA = smoothstep(coreBgTol * 0.5, coreBgTol + 22, d);
        // Only genuinely protected human clothing (torso zone) locks solid silhouette — never outer animal fur tips!
        const isSolidClothBorder = isProtectedHumanCloth && (ring <= edgeProtectRadius || (sVal >= 3.2 && d >= 4.5));
        const isBgLikeFringe = bgPlane.isGreenChroma
          ? (d <= coreBgTol + 16 || (g > Math.max(r, b) + 8 && d <= coreBgTol + 26))
          : (d <= coreBgTol + 12 && sVal < 3.5);

        if (state === 3) {
          alpha = Math.min(projA, distA) * smoothstep(coreBgTol * 0.45, gapTol + 3, d);
        } else if (isSolidClothBorder) {
          const chromaA = smoothstep(2.0, 3.6, sVal);
          alpha = ring <= 1 ? clamp(Math.max(0.58, chromaA, projA, distA), 0.58, 1) : 1.0;
        } else if (isTrappedHairWeb && ring <= (furRing > 14 ? 10 : 8)) {
          alpha = Math.min(projA, distA);
        } else if (ring <= 2) {
          alpha = Math.min(projA, Math.max(distA, projA * 0.85));
        } else if (ring <= (furRing > 14 ? 8 : 6)) {
          alpha = isBgLikeFringe ? Math.min(projA, distA) : clamp(Math.max(projA, distA), 0.25, 1);
        } else {
          alpha = isBgLikeFringe && ring <= (furRing > 14 ? 12 : 10) ? Math.min(projA, distA) : clamp(Math.max(0.88, projA), 0.88, 1);
        }

        if (alpha < 0.08 && d <= coreBgTol * 1.15 && gVal < 6.0 && !isSolidClothBorder) {
          alpha = 0;
        }

        if (alpha > 0.005) {
          const unmixA = alpha < 0.22 ? 0.22 : alpha > 1.0 ? 1.0 : alpha;
          const invUA = 1 / unmixA;
          const oneMinus = 1 - unmixA;
          let uR = clamp((r - oneMinus * bR) * invUA, 0, 255);
          let uG = clamp((g - oneMinus * bG) * invUA, 0, 255);
          let uB = clamp((b - oneMinus * bB) * invUA, 0, 255);

          if (bgPlane.isGreenChroma) {
            const maxNonGreen = Math.max(uR, uB);
            if (uG > maxNonGreen) {
              uG = (maxNonGreen * 0.75 + ((uR + uB) * 0.5) * 0.25);
            }
          } else if (bgPlane.isBlueChroma) {
            const maxNonBlue = Math.max(uR, uG);
            if (uB > maxNonBlue) {
              uB = (maxNonBlue * 0.75 + ((uR + uG) * 0.5) * 0.25);
            }
          }

          let decR = uR, decG = uG, decB = uB;
          if (hasPrior) {
            const cleanLum = 0.299 * fgR + 0.587 * fgG + 0.114 * fgB;
            const uLum = 0.299 * uR + 0.587 * uG + 0.114 * uB;
            let priorW = (1.0 - smoothstep(0.12, 0.72, alpha)) * 0.82;
            if (cleanLum > bL + 16 && uLum < cleanLum - 16) {
              const darkPenalty = smoothstep(16, 60, cleanLum - uLum) * 0.92;
              if (darkPenalty > priorW) priorW = darkPenalty;
            }
            if (cleanLum < bL - 20 && uLum > cleanLum + 22) {
              const grayPenalty = smoothstep(22, 70, uLum - cleanLum) * 0.92;
              if (grayPenalty > priorW) priorW = grayPenalty;
            }
            decR = uR + (fgR - uR) * priorW;
            decG = uG + (fgG - uG) * priorW;
            decB = uB + (fgB - uB) * priorW;
            if (bgPlane.isGreenChroma) {
              const mNG = Math.max(decR, decB);
              if (decG > mNG) {
                decG = (mNG * 0.75 + ((decR + decB) * 0.5) * 0.25);
              }
            }
          }

          const w = isSolidClothBorder
            ? (ring <= 2 ? (clothOverexposureGuard ? 0.65 : 0.85) : 0.0)
            : (ring <= 5 || isTrappedHairWeb) ? 0.96 : Math.max(0, ((furRing + 1) - ring) / furWeightDenom);
          if (w > 0.01) {
            outR = r + (decR - r) * w;
            outG = g + (decG - g) * w;
            outB = b + (decB - b) * w;
            if (bgPlane.isGreenChroma) {
              const mNG = Math.max(outR, outB);
              if (outG > mNG) {
                outG = (mNG * 0.75 + ((outR + outB) * 0.5) * 0.25);
              }
            }
            modified = true;
          }
        } else if (hasPrior && (ring <= 3 || isTrappedHairWeb)) {
          outR = fgR;
          outG = fgG;
          outB = fgB;
          modified = true;
        }
      }

      if (canBeBokeh) {
        const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
        const rawBokehA = clamp(sVal / 90 + d / 135 + specBoost, 0.42, 1.0);
        const solidBlend = smoothstep(8, 18, cb);
        const bokehAlpha = rawBokehA * (1 - solidBlend) + solidBlend;
        if (bokehAlpha < alpha) {
          alpha = bokehAlpha;
          const unmixA = alpha < 0.40 ? 0.40 : alpha;
          const invUA = 1 / unmixA;
          const oneMinus = 1 - unmixA;
          outR = clamp((r - oneMinus * bR) * invUA, 0, 255);
          outG = clamp((g - oneMinus * bG) * invUA, 0, 255);
          outB = clamp((b - oneMinus * bB) * invUA, 0, 255);
          modified = true;
        }
      } else if (canBeBalloon) {
        const torsoProtection = smoothstep(18, 34, cb) * smoothstep(20, 36, inDist);
        const texWeight = 1.0 - smoothstep(1.6, 3.0, localTextureClamped[i]);
        const gradWeight = 1.0 - smoothstep(2.8, 5.2, gVal);
        const satWeight = smoothstep(20, 30, sVal) * (1.0 - smoothstep(82, 105, sVal));
        const distWeight = 1.0 - smoothstep(76, 100, d);
        const balloonWeight = texWeight * gradWeight * satWeight * distWeight * (1.0 - torsoProtection);
        if (balloonWeight > 0.01) {
          const specBoost = smoothstep(180, 238, lum[i]) * 0.50;
          const rawBalloonA = clamp(sVal / 95 + d / 145 + specBoost, 0.50, 1.0);
          const balloonAlpha = 1.0 - (1.0 - rawBalloonA) * balloonWeight;
          if (balloonAlpha < alpha) {
            alpha = balloonAlpha;
            const unmixA = alpha < 0.45 ? 0.45 : alpha;
            const invUA = 1 / unmixA;
            const oneMinus = 1 - unmixA;
            outR = clamp((r - oneMinus * bR) * invUA, 0, 255);
            outG = clamp((g - oneMinus * bG) * invUA, 0, 255);
            outB = clamp((b - oneMinus * bB) * invUA, 0, 255);
            modified = true;
          }
        }
      }

      rawAlpha[i] = alpha < 0.02 ? 0 : alpha;
      if (modified) {
        rgbModified[i] = 1;
        pureR[i] = (outR + 0.5) | 0;
        pureG[i] = (outG + 0.5) | 0;
        pureB[i] = (outB + 0.5) | 0;
      }
    }
  }
}

// Compact post-Stage-6 pass: builds a half-res regional hair/fur strand density field so both
// sharp curls AND smooth trapped gray pockets inside Afro curls / cat cheek fluff are detected
// within maxHairRing of the silhouette and repainted with fast pure-integer organic curl/fur grain.
function stage6BHairDeHaze(data, width, height, ws, bgPlane, maxHairRing) {
  const { bgState, distFromBg, sat, distToBg, lum, bgLum, localTexture, localTextureClamped, rawAlpha, visited: rgbModified, pureR, pureG, pureB, hw, hh, hFgBrR, hFgBrG, hFgBrB, hFgBrW, hFgDkR, hFgDkG, hFgDkB, hFgDkW, hBufA, hTmp0, hColSum0 } = ws;
  const { cR0, cR1, cR2, cR3, cG0, cG1, cG2, cG3, cB0, cB1, cB2, cB3, invW, invH } = bgPlane;
  const maxHx = hw - 1;
  const maxHy = hh - 1;

  // Build half-res regional hair-strand excess field (tex - texC > 0 only on sharp hair/fur strands, ~0 on smooth skin/shirts)
  for (let hy = 0; hy < hh; hy++) {
    const r0 = (hy << 1) * width;
    const hOff = hy * hw;
    for (let hx = 0; hx < hw; hx++) {
      const i = r0 + (hx << 1);
      const excess = bgState[i] !== 1 ? (localTexture[i] - localTextureClamped[i]) : 0;
      hBufA[hOff + hx] = excess > 0 ? excess : 0;
    }
  }
  boxFilterFast(hBufA, hBufA, hTmp0, hColSum0, hw, hh, 6);

  for (let y = 0; y < height; y++) {
    const ty = y * invH;
    const omtY = 1 - ty;
    const r0 = omtY * cR0 + ty * cR2;
    const rStep = ((omtY * cR1 + ty * cR3) - r0) * invW;
    const g0 = omtY * cG0 + ty * cG2;
    const gStep = ((omtY * cG1 + ty * cG3) - g0) * invW;
    const b0 = omtY * cB0 + ty * cB2;
    const bStep = ((omtY * cB1 + ty * cB3) - b0) * invW;
    const rowOff = y * width;
    const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
    const hRowOff = hy * hw;

    for (let x = 0; x < width; x++) {
      const i = rowOff + x;
      const ring = distFromBg[i];
      if (ring === 0 || ring > maxHairRing || bgState[i] === 1) continue;
      const alpha = rawAlpha[i];
      if (alpha < 0.03) continue;
      const sVal = sat[i];
      if (sVal > 10.0) continue;

      const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
      const hIdx = hRowOff + hx;
      const regHair = hBufA[hIdx];
      const tex = localTexture[i];
      // Require regional sharp-strand hair/fur zone (or sharp local fur edge) — excludes smooth skin, mugs, and woven shirts
      if (regHair < 2.2 && !(tex >= 8.0 && tex > localTextureClamped[i] * 1.20)) continue;

      const brW = hFgBrW[hIdx];
      const dkW = hFgDkW[hIdx];
      if (brW <= 0.002 && dkW <= 0.002) continue;

      const bL = bgLum[i];
      const lDiff = lum[i] - bL;
      const d = distToBg[i];
      const preferDarkFluff = ring <= 18 && sVal <= 5.0 && d <= 48.0 && dkW > brW * 1.20;

      let fgR, fgG, fgB;
      if (dkW > 0.002 && (preferDarkFluff || lDiff < 6.0 || brW <= 0.002)) {
        const inv = 1 / dkW;
        fgR = hFgDkR[hIdx] * inv; fgG = hFgDkG[hIdx] * inv; fgB = hFgDkB[hIdx] * inv;
      } else {
        const inv = 1 / brW;
        fgR = hFgBrR[hIdx] * inv; fgG = hFgBrG[hIdx] * inv; fgB = hFgBrB[hIdx] * inv;
      }

      const bR = r0 + x * rStep;
      const bG = g0 + x * gStep;
      const bB = b0 + x * bStep;
      const vx = fgR - bR, vy = fgG - bG, vz = fgB - bB;
      const vLenSq = vx * vx + vy * vy + vz * vz;
      if (vLenSq <= 900) continue;

      const cleanLum = 0.299 * fgR + 0.587 * fgG + 0.114 * fgB;
      const isDarkHair = cleanLum < bL - 22.0;
      const maxHazeRing = isDarkHair ? maxHairRing : 16;
      if (ring > maxHazeRing) continue;

      const off = i << 2;
      const curR = rgbModified[i] ? pureR[i] : data[off];
      const curG = rgbModified[i] ? pureG[i] : data[off + 1];
      const curB = rgbModified[i] ? pureB[i] : data[off + 2];
      const origR = data[off], origG = data[off + 1], origB = data[off + 2];

      const projRaw = ((origR - bR) * vx + (origG - bG) * vy + (origB - bB) * vz) / vLenSq;
      const projA = projRaw < 0 ? 0 : projRaw > 1 ? 1 : projRaw;
      const bgMix = 1.0 - projA;
      const minBgMix = isDarkHair ? 0.14 : 0.36;
      if (bgMix <= minBgMix && !preferDarkFluff) continue;

      const perpSq = Math.max(0, d * d - projRaw * projRaw * vLenSq);
      if (perpSq >= 360.0 && !preferDarkFluff) continue;

      const effMix = preferDarkFluff ? Math.max(bgMix, 1.0 - d / 56.0) : bgMix;
      const hairConf = Math.max(smoothstep(2.0, 5.2, regHair), smoothstep(7.5, 15.0, tex));
      const ringFade = 1.0 - smoothstep(maxHazeRing * 0.78, maxHazeRing + 1, ring);
      const hazeW = smoothstep(minBgMix, 0.54, effMix)
        * hairConf
        * (1.0 - smoothstep(6.0, 10.0, sVal))
        * ringFade;
      if (hazeW <= 0.03) continue;

      // Pure-integer multi-scale organic curl/fur strand grain (zero Math.sin/cos)
      const cx = (x + (((y >> 1) * 3) & 7)) >> 2;
      const cy = (y + (((x >> 1) * 5) & 7)) >> 2;
      const hFine = ((((x * 374761393 + y * 668265263) ^ (x * 1274126177)) * 1274126177) >>> 24) * 0.007843137 - 1.0;
      const hCoarse = ((((cx * 374761393 + cy * 668265263) ^ (cy * 1274126177)) * 1274126177) >>> 24) * 0.007843137 - 1.0;
      const pat = hCoarse * 0.62 + hFine * 0.38;

      let synR, synG, synB;
      if (cleanLum < 72.0) {
        const delta = pat * 14.0;
        synR = clamp(fgR + delta, 0, 255);
        synG = clamp(fgG + delta, 0, 255);
        synB = clamp(fgB + delta, 0, 255);
      } else {
        const mult = 1.0 + pat * 0.17;
        synR = clamp(fgR * mult, 0, 255);
        synG = clamp(fgG * mult, 0, 255);
        synB = clamp(fgB * mult, 0, 255);
      }

      const paintW = clamp(hazeW * 0.98, 0, 0.98);
      pureR[i] = (curR + (synR - curR) * paintW + 0.5) | 0;
      pureG[i] = (curG + (synG - curG) * paintW + 0.5) | 0;
      pureB[i] = (curB + (synB - curB) * paintW + 0.5) | 0;
      rgbModified[i] = 1;

      // Softly feather outermost wispy gray mist with organic strand modulation
      if (ring <= 12 && effMix > 0.52) {
        const feather = clamp(1.12 - effMix * 0.85 + pat * 0.24, 0.08, 1.0);
        if (feather < alpha) rawAlpha[i] = feather;
      }
    }
  }
}

/**
 * Stage 6C: 'Texture Recovery'
 * Identifies regions of deep dark curls / dark fur where shadow detail was softened or crushed,
 * extracts a local bank of real 4x4 zero-mean RGB texture residual patches from nearby crisp
 * dark hair/fur blocks, and applies an overlapping pseudo-random oriented patch synthesis
 * (zero grid seams, zero Math.sin/cos, zero per-frame allocations) to restore shadow detail.
 */
export function stage6CTextureRecovery(data, width, height, ws, maxHairRing, diagnostics, populateHairField = false) {
  const { bgState, distFromBg, sat, grad, lum, bgLum, localTexture, localTextureClamped, rawAlpha, visited: rgbModified, pureR, pureG, pureB, hw, hh, hBufA, hBufB, hTmp0, hColSum0, texPatchBank } = ws;
  const maxHx = hw - 1;
  const maxHy = hh - 1;
  const maxPatches = 32;
  let patchCount = 0;

  if (populateHairField) {
    for (let hy = 0; hy < hh; hy++) {
      const r0 = (hy << 1) * width;
      const hOff = hy * hw;
      for (let hx = 0; hx < hw; hx++) {
        const i = r0 + (hx << 1);
        const excess = bgState[i] !== 1 ? (localTexture[i] - localTextureClamped[i]) : 0;
        hBufA[hOff + hx] = excess > 0 ? excess : 0;
      }
    }
    boxFilterFast(hBufA, hBufA, hTmp0, hColSum0, hw, hh, 6);
  }

  // Wider half-res hair/fur canopy field so deep crushed shadow pockets (15-30px wide)
  // surrounded by sharp curls/fur are still recognized as part of the hair/fur canopy.
  boxFilterFast(hBufA, hBufB, hTmp0, hColSum0, hw, hh, 8);

  // Phase A: Extract real local 4x4 high-frequency texture residual patches from crisp dark hair/fur
  const extractWithStride = (stride) => {
    for (let y = 4; y < height - 8 && patchCount < maxPatches; y += stride) {
      const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
      const hRowOff = hy * hw;
      for (let x = 4; x < width - 8 && patchCount < maxPatches; x += stride) {
        const cIdx = (y + 1) * width + (x + 1);
        if (bgState[cIdx] !== 0 || rawAlpha[cIdx] < 0.92 || rgbModified[cIdx] !== 0) continue;
        const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
        if (hBufA[hRowOff + hx] < 1.8) continue;
        const bL = bgLum[cIdx];
        if (lum[cIdx] >= 86.0 || lum[cIdx] >= bL - 28.0 || sat[cIdx] > 20.0) continue;

        let valid = true;
        let mR = 0, mG = 0, mB = 0;
        let maxG = 0;
        for (let py = 0; py < 4; py++) {
          const rOff = (y + py) * width + x;
          for (let px = 0; px < 4; px++) {
            const pIdx = rOff + px;
            if (bgState[pIdx] !== 0 || rawAlpha[pIdx] < 0.90 || lum[pIdx] >= 96.0 || sat[pIdx] > 22.0) {
              valid = false;
              break;
            }
            const gV = grad[pIdx];
            if (gV > maxG) maxG = gV;
            const pOff = pIdx << 2;
            mR += data[pOff];
            mG += data[pOff + 1];
            mB += data[pOff + 2];
          }
          if (!valid) break;
        }
        if (!valid || maxG < 5.5) continue;

        mR *= 0.0625;
        mG *= 0.0625;
        mB *= 0.0625;
        let sqSum = 0;
        const base = patchCount * 48;
        let k = base;
        for (let py = 0; py < 4; py++) {
          const rOff = (y + py) * width + x;
          for (let px = 0; px < 4; px++) {
            const pOff = (rOff + px) << 2;
            const dr = data[pOff] - mR;
            const dg = data[pOff + 1] - mG;
            const db = data[pOff + 2] - mB;
            texPatchBank[k++] = dr;
            texPatchBank[k++] = dg;
            texPatchBank[k++] = db;
            sqSum += dr * dr + dg * dg + db * db;
          }
        }
        const rms = Math.sqrt(sqSum * 0.020833333333333332);
        if (rms >= 3.5 && rms <= 36.0) {
          patchCount++;
        }
      }
    }
  };

  extractWithStride(8);
  if (patchCount < 8) {
    extractWithStride(4);
  }

  if (patchCount === 0) {
    if (diagnostics) {
      diagnostics.textureRecovery = { extractedPatches: 0, recoveredPixels: 0 };
    }
    return 0;
  }

  // Phase B: Identify deep dark curl/fur shadow loss zones and blend overlapping randomized local patches
  let recoveredPixels = 0;
  const recRingCap = maxHairRing + 6;

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const hy = (y >> 1) < hh ? (y >> 1) : maxHy;
    const hRowOff = hy * hw;
    const tyA = y >> 2;
    const lyA = y & 3;
    const y2 = y + 2;
    const tyB = y2 >> 2;
    const lyB = y2 & 3;

    for (let x = 0; x < width; x++) {
      const i = rowOff + x;
      if (bgState[i] === 1) continue;
      const alpha = rawAlpha[i];
      if (alpha < 0.10) continue;
      const sVal = sat[i];
      if (sVal > 15.0) continue;

      const hx = (x >> 1) < hw ? (x >> 1) : maxHx;
      const hIdx = hRowOff + hx;
      const regHair = hBufA[hIdx];
      const canopyHair = Math.max(regHair, hBufB[hIdx] * 1.45);
      if (canopyHair < 1.5) continue;

      const off = i << 2;
      const wasMod = rgbModified[i] !== 0;
      const curR = wasMod ? pureR[i] : data[off];
      const curG = wasMod ? pureG[i] : data[off + 1];
      const curB = wasMod ? pureB[i] : data[off + 2];
      const curLum = 0.299 * curR + 0.587 * curG + 0.114 * curB;
      const bL = bgLum[i];
      if (curLum >= 78.0 || curLum >= bL - 28.0) continue;

      const ring = distFromBg[i];
      const gVal = grad[i];
      const isDeHazedDarkCurl = wasMod && ring > 0 && ring <= recRingCap && regHair >= 1.5;
      const isCrushedShadow = curLum < 50.0 && gVal < 11.5 && canopyHair >= 1.6;
      if (!isDeHazedDarkCurl && !isCrushedShadow) continue;

      const satFade = 1.0 - smoothstep(10.0, 15.0, sVal);
      const hairFade = smoothstep(1.5, 3.4, canopyHair);
      let lossW = 0;
      if (isDeHazedDarkCurl) {
        const dw = smoothstep(78.0, 26.0, curLum) * hairFade * satFade * 0.92;
        if (dw > lossW) lossW = dw;
      }
      if (isCrushedShadow) {
        const cw = smoothstep(50.0, 14.0, curLum) * (1.0 - smoothstep(5.5, 11.5, gVal)) * smoothstep(1.5, 3.2, canopyHair) * satFade * 0.90;
        if (cw > lossW) lossW = cw;
      }
      if (lossW < 0.06) continue;

      // Primary 4x4 tile sample (deterministic spatial hash -> random patch + random orientation)
      const txA = x >> 2;
      const lxA = x & 3;
      const hA = ((((txA * 374761393 + tyA * 668265263) ^ (tyA * 1274126177)) * 1274126177) >>> 0);
      const pA = hA % patchCount;
      const oriA = (hA >>> 8) & 3;
      let sxA = lxA, syA = lyA;
      if (oriA === 1) { sxA = 3 - lyA; syA = lxA; }
      else if (oriA === 2) { sxA = 3 - lxA; syA = 3 - lyA; }
      else if (oriA === 3) { sxA = 3 - lxA; syA = lyA; }
      const idxA = pA * 48 + ((syA << 2) + sxA) * 3;

      // Overlapping half-shifted 4x4 tile sample to eliminate 4x4 grid boundaries
      const x2 = x + 2;
      const txB = x2 >> 2;
      const lxB = x2 & 3;
      const hB = ((((txB * 668265263 + tyB * 374761393) ^ (txB * 1274126177)) * 1274126177) >>> 0);
      const pB = hB % patchCount;
      const oriB = (hB >>> 8) & 3;
      let sxB = lxB, syB = lyB;
      if (oriB === 1) { sxB = 3 - lyB; syB = lxB; }
      else if (oriB === 2) { sxB = 3 - lxB; syB = 3 - lyB; }
      else if (oriB === 3) { sxB = 3 - lxB; syB = lyB; }
      const idxB = pB * 48 + ((syB << 2) + sxB) * 3;

      // Variance-preserving dual-tile blend (sqrt(0.76^2 + 0.44^2) ≈ 0.88)
      let dR = texPatchBank[idxA] * 0.76 + texPatchBank[idxB] * 0.44;
      let dG = texPatchBank[idxA + 1] * 0.76 + texPatchBank[idxB + 1] * 0.44;
      let dB = texPatchBank[idxA + 2] * 0.76 + texPatchBank[idxB + 2] * 0.44;

      // Gentle asymmetric curl-highlight lift in ultra-deep shadows (<28 luma) without turning curls gray
      if (curLum < 28.0) {
        dR = dR > 0 ? dR * 1.15 : dR * 0.65;
        dG = dG > 0 ? dG * 1.15 : dG * 0.65;
        dB = dB > 0 ? dB * 1.15 : dB * 0.65;
      }

      const strength = lossW * 0.90;
      const maxCh = Math.min(108, bL - 16);
      const nR = clamp(curR + dR * strength, 0, maxCh);
      const nG = clamp(curG + dG * strength, 0, maxCh);
      const nB = clamp(curB + dB * strength, 0, maxCh);

      pureR[i] = (nR + 0.5) | 0;
      pureG[i] = (nG + 0.5) | 0;
      pureB[i] = (nB + 0.5) | 0;
      rgbModified[i] = 1;
      recoveredPixels++;
    }
  }

  if (diagnostics) {
    diagnostics.textureRecovery = { extractedPatches: patchCount, recoveredPixels };
  }
  return recoveredPixels;
}

function stage7GuidedFilter(data, width, height, ws, bgPlaneOrTol, qualityPlus) {
  const coreBgTol = typeof bgPlaneOrTol === 'object' ? bgPlaneOrTol.coreBgTol : bgPlaneOrTol;
  const isGreenChroma = typeof bgPlaneOrTol === 'object' ? !!bgPlaneOrTol.isGreenChroma : false;
  const isBlueChroma = typeof bgPlaneOrTol === 'object' ? !!bgPlaneOrTol.isBlueChroma : false;
  const { total, hw, hh, hTotal, distToBg, rawAlpha, bgState, distFromBg, visited: rgbModified, pureR, pureG, pureB, grad, hSubI, hSubP, hTmp0, hTmp1, hTmp2, hTmp3, hColSum0, hColSum1, hColSum2, hColSum3, hBufA, hBufB, hBufC, hBufD } = ws;
  const maxHx = hw - 1;
  const maxHy = hh - 1;

  for (let hy = 0; hy < hh; hy++) {
    const r0 = (hy << 1) * width;
    const r1 = r0 + width;
    const hOff = hy * hw;
    for (let hx = 0; hx < hw; hx++) {
      const x0 = hx << 1;
      const i00 = r0 + x0, i01 = i00 + 1, i10 = r1 + x0, i11 = i10 + 1;
      const d00 = distToBg[i00] * 0.01;
      const d01 = distToBg[i01] * 0.01;
      const d10 = distToBg[i10] * 0.01;
      const d11 = distToBg[i11] * 0.01;
      const ii = ((d00 > 1 ? 1 : d00) + (d01 > 1 ? 1 : d01) + (d10 > 1 ? 1 : d10) + (d11 > 1 ? 1 : d11)) * 0.25;
      const pp = (rawAlpha[i00] + rawAlpha[i01] + rawAlpha[i10] + rawAlpha[i11]) * 0.25;
      const hIdx = hOff + hx;
      hSubI[hIdx] = ii;
      hSubP[hIdx] = pp;
      hBufC[hIdx] = ii * pp;
      hBufD[hIdx] = ii * ii;
    }
  }

  boxFilter4Radius1(
    hSubI, hBufA, hTmp0, hColSum0,
    hSubP, hBufB, hTmp1, hColSum1,
    hBufC, hBufC, hTmp2, hColSum2,
    hBufD, hBufD, hTmp3, hColSum3,
    hw, hh
  );

  const eps = 0.0012;
  for (let i = 0; i < hTotal; i++) {
    const mI = hBufA[i];
    const mP = hBufB[i];
    const covIp = hBufC[i] - mI * mP;
    const varI = hBufD[i] - mI * mI;
    const a = covIp / ((varI > 0 ? varI : 0) + eps);
    hBufA[i] = a;
    hBufB[i] = mP - a * mI;
  }

  boxFilter2Radius1(hBufA, hBufC, hTmp0, hBufB, hBufD, hTmp1, hw, hh);
  const meanA = hBufC;
  const meanB = hBufD;

  const data32 = new Uint32Array(data.buffer, data.byteOffset, total);
  for (let y = 0; y < height; y++) {
    const hy0 = y >> 1;
    const hy1 = hy0 < maxHy ? hy0 + 1 : maxHy;
    const wy = (y & 1) * 0.5;
    const omy = 1 - wy;
    const hOff0 = hy0 * hw;
    const hOff1 = hy1 * hw;
    const rOff = y * width;

    for (let x = 0; x < width; x++) {
      const idx = rOff + x;
      const ra = rawAlpha[idx];

      if (bgState[idx] === 1 && ra === 0) {
        data32[idx] = 0;
        continue;
      }

      if (ra >= 0.99 && distFromBg[idx] > 6) {
        const off = idx << 2;
        if (rgbModified[idx]) {
          data[off] = pureR[idx];
          data[off + 1] = pureG[idx];
          data[off + 2] = pureB[idx];
        }
        if (isGreenChroma && distFromBg[idx] <= 16) {
          const curR = data[off];
          const curG = data[off + 1];
          const curB = data[off + 2];
          const maxNonG = Math.max(curR, curB);
          if (curG > maxNonG) {
            data[off + 1] = (maxNonG * 0.75 + ((curR + curB) >> 1) * 0.25) | 0;
          }
        } else if (isBlueChroma && distFromBg[idx] <= 16) {
          const curR = data[off];
          const curG = data[off + 1];
          const curB = data[off + 2];
          const maxNonB = Math.max(curR, curG);
          if (curB > maxNonB) {
            data[off + 2] = (maxNonB * 0.75 + ((curR + curG) >> 1) * 0.25) | 0;
          }
        }
        data[off + 3] = 255;
        continue;
      }

      const hx0 = x >> 1;
      const hx1 = hx0 < maxHx ? hx0 + 1 : maxHx;
      const wx = (x & 1) * 0.5;
      const omx = 1 - wx;
      const i00 = hOff0 + hx0, i01 = hOff0 + hx1;
      const i10 = hOff1 + hx0, i11 = hOff1 + hx1;

      const aUp = omy * (omx * meanA[i00] + wx * meanA[i01]) + wy * (omx * meanA[i10] + wx * meanA[i11]);
      const bUp = omy * (omx * meanB[i00] + wx * meanB[i01]) + wy * (omx * meanB[i10] + wx * meanB[i11]);

      const dGuide = distToBg[idx] * 0.01;
      let refA = aUp * (dGuide > 1 ? 1 : dGuide) + bUp;
      if (refA < 0) refA = 0;
      else if (refA > 1) refA = 1;

      let a;
      if (qualityPlus) {
        if (ra === 0 && bgState[idx] === 3 && distToBg[idx] <= coreBgTol) {
          a = 0;
        } else {
          const strandW = ra > 0.12 && grad[idx] > 10 ? smoothstep(10, 24, grad[idx]) * 0.45 : 0;
          a = (0.65 - strandW) * refA + (0.35 + strandW) * ra;
        }
      } else {
        a = 0.65 * refA + 0.35 * ra;
      }
      if (a < 0.02) {
        data32[idx] = 0;
      } else {
        const off = idx << 2;
        if (rgbModified[idx]) {
          data[off] = pureR[idx];
          data[off + 1] = pureG[idx];
          data[off + 2] = pureB[idx];
        }
        if (isGreenChroma && distFromBg[idx] <= 16) {
          const curR = data[off];
          const curG = data[off + 1];
          const curB = data[off + 2];
          const maxNonG = Math.max(curR, curB);
          if (curG > maxNonG) {
            data[off + 1] = (maxNonG * 0.75 + ((curR + curB) >> 1) * 0.25) | 0;
          }
        } else if (isBlueChroma && distFromBg[idx] <= 16) {
          const curR = data[off];
          const curG = data[off + 1];
          const curB = data[off + 2];
          const maxNonB = Math.max(curR, curG);
          if (curB > maxNonB) {
            data[off + 2] = (maxNonB * 0.75 + ((curR + curG) >> 1) * 0.25) | 0;
          }
        }
        data[off + 3] = a >= 1 ? 255 : (a * 255 + 0.5) | 0;
      }
    }
  }
}

/**
 * Stage 7B: Topological Despeckle & Stray-Halo Cleanup (Quality+ only)
 * Sweeps floating background noise specks and detached low-alpha ghost fragments
 * via single-pass O(N) 8-connected BFS (zero allocations) while preserving genuine
 * detached elements (soap bubbles, fireflies, bokeh orbs, dandelion seeds, sparkler stars).
 */
export function stage7BDespeckleCleanup(data, width, height, ws, coreBgTol, diagnostics) {
  const { total, visited, queue, distFromBg, distToBg, sat, lum, bgLum } = ws;
  const data32 = new Uint32Array(data.buffer, data.byteOffset, total);
  const maxX = width - 1;
  const maxY = height - 1;
  const bgFloorDist = coreBgTol * 0.92;

  // Step 1: Suppress ultra-faint residual alpha fog on pure studio background pixels
  // AND pre-mark deep solid core pixels (visited = 2) so 8-connected BFS skips the ~90% interior
  let fringeCleared = 0;
  visited.fill(0);
  for (let i = 0; i < total; i++) {
    const a = data[(i << 2) + 3];
    if (a === 0) continue;
    if (a === 255 && distFromBg[i] >= 10) {
      visited[i] = 2;
    } else if (a <= 12 && distToBg[i] <= bgFloorDist && sat[i] < 18.0 && lum[i] < bgLum[i] + 18.0) {
      data32[i] = 0;
      fringeCleared++;
    }
  }

  // Step 2: 8-connected component sweep over boundary + detached islands (touches visited===2 -> instant keep)
  let removedIslands = 0;
  let removedPixels = fringeCleared;

  for (let y = 0; y < height; y++) {
    const rOff = y * width;
    for (let x = 0; x < width; x++) {
      const startIdx = rOff + x;
      if (visited[startIdx] !== 0 || data[(startIdx << 2) + 3] === 0) continue;

      let head = 0, tail = 0;
      visited[startIdx] = 1;
      queue[tail++] = (y << 16) | x;

      let maxAlpha = 0;
      let sumAlpha = 0;
      let solidPx = 0;
      let highSatPx = 0;
      let brightCorePx = 0;
      let isLarge = false;

      while (head < tail) {
        const pk = queue[head++];
        const px = pk & 0xFFFF;
        const py = pk >>> 16;
        const pIdx = py * width + px;

        if (!isLarge) {
          const a = data[(pIdx << 2) + 3];
          sumAlpha += a;
          if (a > maxAlpha) maxAlpha = a;
          if (a >= 160) solidPx++;
          if (a >= 55 && sat[pIdx] >= 26.0) highSatPx++;
          if (a >= 90 && lum[pIdx] >= bgLum[pIdx] + 38.0) brightCorePx++;
          if (tail >= 600) isLarge = true;
        }

        const y0 = py > 0 ? py - 1 : 0;
        const y1 = py < maxY ? py + 1 : maxY;
        const x0 = px > 0 ? px - 1 : 0;
        const x1 = px < maxX ? px + 1 : maxX;
        for (let ny = y0; ny <= y1; ny++) {
          const nRow = ny * width;
          for (let nx = x0; nx <= x1; nx++) {
            const nIdx = nRow + nx;
            const v = visited[nIdx];
            if (v === 2) {
              isLarge = true;
            } else if (v === 0 && data[(nIdx << 2) + 3] > 0) {
              visited[nIdx] = 1;
              queue[tail++] = (ny << 16) | nx;
            }
          }
        }
      }

      const area = tail;
      const keep =
        isLarge ||
        area >= 600 ||
        (area >= 36 && solidPx >= 6 && maxAlpha >= 170 && sumAlpha >= area * 52) ||
        (area >= 12 && highSatPx >= 3 && maxAlpha >= 85) ||
        (area >= 18 && brightCorePx >= 4 && maxAlpha >= 140);

      if (!keep) {
        for (let k = 0; k < area; k++) {
          const pk = queue[k];
          data32[(pk >>> 16) * width + (pk & 0xFFFF)] = 0;
        }
        removedIslands++;
        removedPixels += area;
      }
    }
  }

  if (diagnostics) {
    diagnostics.despeckle = { removedIslands, removedPixels };
  }
  return removedPixels;
}

export function sotaCellMattingV5_3_Turbo(rgba, width, height, opts = {}) {
  const qualityPlus = opts.qualityEnhancements !== undefined ? Boolean(opts.qualityEnhancements) : true;
  const semanticAdaptive = opts.semanticAdaptive !== false;
  const textureRecoveryEnabled = opts.textureRecovery !== false;
  const despeckleEnabled = opts.despeckle !== false;
  const translucentPastelBody = Boolean(opts.translucentPastelBody);
  const inPlace = Boolean(opts.inPlace);
  const st = opts.stageTimings || null;
  const diagnostics = opts.diagnostics || null;

  const t0 = st ? performance.now() : 0;
  const data = inPlace ? rgba : new Uint8ClampedArray(rgba);
  const ws = getWorkspaceV53(width, height);

  const bgPlane = stage0BackgroundCalibration(data, width, height, ws, qualityPlus);
  const t1 = st ? performance.now() : 0;
  if (st) st.stage0 += (t1 - t0);

  stage1SobelGradient(width, height, ws);
  const t1Sobel = st ? performance.now() : 0;
  if (st) st.stage1_sobel += (t1Sobel - t1);

  boxFilter2Fast(
    ws.grad, ws.localTexture, ws.tmpBufA, ws.colSumA,
    ws.clampedGrad, ws.localTextureClamped, ws.tmpBufB, ws.colSumB,
    width, height, 3
  );
  const t1Box = st ? performance.now() : 0;
  if (st) st.stage1_box3 += (t1Box - t1Sobel);

  // Semantic Classifier (human vs animal) adapts inwardDist caps, edge protection radius & fur capture depth
  const semantic = classifySubjectSemantic(data, width, height, ws, bgPlane.coreBgTol);
  if (diagnostics) {
    diagnostics.semantic = semantic;
  }
  const isHuman = semanticAdaptive && semantic.subjectType === 'human';
  const useHumanVignettePipeline = qualityPlus && (isHuman || Boolean(opts.photoVignetteMode));
  const resScale = Math.min(1.0, Math.min(width, height) / 768);
  const exactFloodCap = semanticAdaptive ? semantic.params.inwardFloodCap : 48;
  const exactPocketCap = semanticAdaptive ? semantic.params.inwardPocketCap : 18;
  const exactBoundaryDepth = semanticAdaptive ? semantic.params.maxBoundaryDepth : 12;
  const exactEdgeProtectRadius = semanticAdaptive ? semantic.params.edgeProtectRadius : 0;
  const exactFurDepth = Math.max(4, Math.round((semanticAdaptive ? semantic.params.furCaptureDepth : 8) * (bgPlane.isCustomBackdrop ? resScale : 1.0)));
  const clothOverexposureGuard = semanticAdaptive && semantic.params.clothOverexposureGuard;

  const qFloodCap = semanticAdaptive ? (isHuman ? 34 : 54) : 48;
  const qPocketCap = semanticAdaptive ? (isHuman ? 12 : 22) : 18;
  const qHairGapCap = semanticAdaptive ? (isHuman ? 34 : 42) : 34;
  const qBoundaryDepth = useHumanVignettePipeline ? 48 : exactBoundaryDepth;
  const qFurRing = semanticAdaptive ? (isHuman ? 12 : 11) : 8;
  const qHairDeHazeMaxRing = semanticAdaptive ? semantic.params.hairDeHazeMaxRing : 46;

  const hInward = buildSubjectInwardDistanceV53(ws, bgPlane.coreBgTol);
  const t1b = st ? performance.now() : 0;
  if (st) st.stage1b_inward += (t1b - t1Box);

  if (useHumanVignettePipeline) {
    stage2ExteriorFloodQuality(width, height, ws, hInward, bgPlane.coreBgTol, bgPlane.gapTol, qFloodCap, clothOverexposureGuard, bgPlane.isChromaBg);
    stage2BStripBorderArtifacts(width, height, ws);
  } else {
    stage2ExteriorFloodExact(width, height, ws, hInward, bgPlane.coreBgTol, bgPlane.gapTol, exactFloodCap, clothOverexposureGuard, bgPlane.isCustomBackdrop, bgPlane.isChromaBg);
    if (qualityPlus) {
      stage2BStripBorderArtifacts(width, height, ws);
    }
  }
  const t2 = st ? performance.now() : 0;
  if (st) st.stage2_flood += (t2 - t1b);

  stage3ExteriorPockets(
    width, height, ws, hInward, bgPlane.coreBgTol, bgPlane.gapTol, useHumanVignettePipeline,
    useHumanVignettePipeline ? qPocketCap : exactPocketCap,
    useHumanVignettePipeline ? qFloodCap : exactFloodCap,
    clothOverexposureGuard,
    bgPlane.isChromaBg
  );
  if (useHumanVignettePipeline) {
    stage3BHairMicroGaps(width, height, ws, hInward, bgPlane.coreBgTol, qHairGapCap);
  }
  const t3 = st ? performance.now() : 0;
  if (st) st.stage3_pockets += (t3 - t2);

  stage4BoundaryDistance(width, height, ws, qualityPlus ? qBoundaryDepth : exactBoundaryDepth);
  const t4 = st ? performance.now() : 0;
  if (st) st.stage4_dist += (t4 - t3);

  stage5GeodesicBarrier(width, height, ws);
  const t5 = st ? performance.now() : 0;
  if (st) st.stage5_spfa += (t5 - t4);

  if (useHumanVignettePipeline) {
    stage6UnmixQuality(data, width, height, ws, hInward, bgPlane, qFurRing, exactEdgeProtectRadius, clothOverexposureGuard, qFloodCap, translucentPastelBody);
    stage6BHairDeHaze(data, width, height, ws, bgPlane, qHairDeHazeMaxRing);
  } else {
    stage6UnmixExact(data, width, height, ws, hInward, bgPlane, exactFurDepth, exactEdgeProtectRadius, clothOverexposureGuard, qualityPlus, translucentPastelBody);
  }
  const t6 = st ? performance.now() : 0;
  if (st) st.stage6_unmix += (t6 - t5);

  if (qualityPlus && textureRecoveryEnabled) {
    stage6CTextureRecovery(data, width, height, ws, qHairDeHazeMaxRing, diagnostics, !useHumanVignettePipeline);
  } else if (diagnostics) {
    diagnostics.textureRecovery = { extractedPatches: 0, recoveredPixels: 0 };
  }
  const t6c = st ? performance.now() : 0;
  if (st && st.stage6_texture_recovery !== undefined) {
    st.stage6_texture_recovery += (t6c - t6);
  }

  stage7GuidedFilter(data, width, height, ws, bgPlane, useHumanVignettePipeline);
  if (qualityPlus && despeckleEnabled) {
    stage7BDespeckleCleanup(data, width, height, ws, bgPlane.coreBgTol, diagnostics);
  } else if (diagnostics) {
    diagnostics.despeckle = { removedIslands: 0, removedPixels: 0 };
  }
  const t7 = st ? performance.now() : 0;
  if (st) st.stage7_guided += (t7 - t6c);

  return data;
}
