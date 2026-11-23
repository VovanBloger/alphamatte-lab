function clamp(val, min, max) { return val < min ? min : val > max ? max : val; }
function smoothstep(edge0, edge1, x) { if (edge1 <= edge0) return x >= edge1 ? 1 : 0; const t = clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); }

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
    width,
    height,
    total,
    hw,
    hh,
    hTotal,
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
    // Half-res buffers for Stage 1B & Fast Guided Filter (He & Sun 2015)
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

/**
 * Kaiming He's Fast Guided Filter (He & Sun 2015, arXiv:1505.00996):
 * Computes the linear coefficients (meanA, meanB) at half-resolution (4x fewer pixels, L2-cache resident)
 * and evaluates `q[i] = meanA_up * I_full[i] + meanB_up` against the FULL-RESOLUTION guide signal `I[i]`,
 * preserving 100% of full-resolution hair/whisker edges at 4x the speed!
 */
function fastGuidedFilterHe2015(I, p, outQ, ws, eps) {
  const { width, height, hw, hh, hTotal, hSubI, hSubP, hTmp, hColSum, hBufA, hBufB, hBufC, hBufD } = ws;

  // 1. Subsample I and p (2x2 box average)
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

  // 2. Run the 6 box filters at half-resolution (radius = 1 at half-res == radius = 2 at full-res!)
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

  // 3. Evaluate against FULL-RESOLUTION guide image `I[i]` with bilinearly upsampled (meanA, meanB)
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

  const maxHalfInward = 30;
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

/**
 * Deterministic pixel-feature Semantic Classifier (`human` vs `animal`).
 * Evaluates smooth skin-tone core density in the central face region,
 * fur-strand high-frequency excess, and lower-torso shoulder silhouette flare
 * to adapt inwardDist caps, clothing edge protection, and fur capture depth.
 */
export function classifySubjectSemantic(data, width, height, ws, coreBgTol) {
  const { distToBg, localTexture, localTextureClamped } = ws;
  const fgThresh = Math.max(18.0, coreBgTol + 5.5);

  let faceFg = 0;
  let skinPx = 0;
  let lowFurSkin = 0;
  let skinFurExcessSum = 0;
  let lowerSpanSum = 0;
  let lowerRows = 0;
  let neckSpanSum = 0;
  let neckRows = 0;

  const yStart = 2;
  const yEnd = height - 2;
  const xStart = 2;
  const xEnd = width - 2;
  const invW = 1 / Math.max(1, width);
  const invH = 1 / Math.max(1, height);

  for (let y = yStart; y < yEnd; y += 2) {
    const ry = y * invH;
    const rowOff = y * width;
    let rMin = width;
    let rMax = -1;
    const inFaceY = ry >= 0.25 && ry <= 0.58;

    for (let x = xStart; x < xEnd; x += 2) {
      const i = rowOff + x;
      if (distToBg[i] < fgThresh) continue;
      if (x < rMin) rMin = x;
      if (x > rMax) rMax = x;

      if (inFaceY) {
        const rx = x * invW;
        if (rx >= 0.32 && rx <= 0.68) {
          faceFg++;
          const off = i << 2;
          const r = data[off];
          const g = data[off + 1];
          const b = data[off + 2];
          // Broad YCbCr + RGB dermal skin model (light, olive, brown, dark skin)
          if (r > g && g > b && (r - b) >= 16 && r > 65) {
            const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
            const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
            if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 178) {
              skinPx++;
              const tex = localTexture[i];
              const ex = tex - localTextureClamped[i];
              skinFurExcessSum += ex > 0 ? ex : 0;
              if (ex < 1.2 && tex < 11.0) {
                lowFurSkin++;
              }
            }
          }
        }
      }
    }

    if (rMax > rMin) {
      const span = (rMax - rMin) * invW;
      if (ry >= 0.55 && ry <= 0.65) {
        neckSpanSum += span;
        neckRows++;
      } else if (ry >= 0.78 && ry <= 0.95) {
        lowerSpanSum += span;
        lowerRows++;
      }
    }
  }

  const smoothSkinRate = skinPx > 0 ? lowFurSkin / skinPx : 0;
  const smoothSkinFaceFrac = faceFg > 0 ? lowFurSkin / faceFg : 0;
  const skinFurExcess = skinPx > 0 ? skinFurExcessSum / skinPx : 99;
  const lowerSpanRatio = lowerRows > 0 ? lowerSpanSum / lowerRows : 0;
  const neckSpanRatio = neckRows > 0 ? neckSpanSum / neckRows : lowerSpanRatio;
  const shoulderFlare = lowerSpanRatio - neckSpanRatio;
  const aspectRatio = height * invW;

  // Score combining smooth dermal skin cluster (strongest fur vs skin separator) + shoulder geometry
  let humanScore = 0;
  if (smoothSkinFaceFrac >= 0.14 && smoothSkinRate >= 0.32) {
    humanScore += 1.2 + Math.min(1.6, (smoothSkinRate - 0.32) * 5.0) + Math.min(0.6, (smoothSkinFaceFrac - 0.14) * 2.0);
  } else if (smoothSkinFaceFrac >= 0.10 && smoothSkinRate >= 0.28) {
    humanScore += (smoothSkinRate - 0.24) * 3.5;
  }
  if (skinPx > faceFg * 0.20 && skinFurExcess < 5.2) {
    humanScore += (5.2 - skinFurExcess) * 0.25;
  }
  if (lowerSpanRatio > 0.80 && shoulderFlare > 0.10) {
    humanScore += 0.65;
  } else if (lowerSpanRatio > 0.88 && smoothSkinFaceFrac >= 0.12) {
    humanScore += 0.25;
  }
  if (aspectRatio > 1.15 && smoothSkinFaceFrac >= 0.12) {
    humanScore += 0.25;
  }

  const isHuman = humanScore >= 1.35;
  const confidence = isHuman
    ? clamp(0.55 + (humanScore - 1.35) * 0.25, 0.55, 0.99)
    : clamp(0.55 + (1.35 - humanScore) * 0.33, 0.55, 0.99);

  const params = isHuman
    ? {
        inwardFloodCap: 34,
        inwardPocketCap: 12,
        maxBoundaryDepth: 10,
        edgeProtectRadius: 8,
        furCaptureDepth: 8,
        clothOverexposureGuard: true,
        hairDeHazeMaxRing: 48,
      }
    : {
        inwardFloodCap: 54,
        inwardPocketCap: 22,
        maxBoundaryDepth: 16,
        edgeProtectRadius: 3,
        furCaptureDepth: 11,
        clothOverexposureGuard: false,
        hairDeHazeMaxRing: 54,
      };

  return {
    subjectType: isHuman ? 'human' : 'animal',
    confidence: Number(confidence.toFixed(3)),
    humanScore: Number(humanScore.toFixed(3)),
    features: {
      smoothSkinRate: Number(smoothSkinRate.toFixed(3)),
      smoothSkinFaceFrac: Number(smoothSkinFaceFrac.toFixed(3)),
      skinFurExcess: Number(skinFurExcess.toFixed(2)),
      lowerSpanRatio: Number(lowerSpanRatio.toFixed(3)),
      shoulderFlare: Number(shoulderFlare.toFixed(3)),
    },
    params,
  };
}

export function sotaCellMattingV5_2_Fast(rgba, width, height, opts = {}) {
  const data = new Uint8ClampedArray(rgba);
  const ws = getWorkspace(width, height);
  const {
    total, bgFieldR, bgFieldG, bgFieldB, bgLum, distToBg, lum, sat,
    grad, clampedGrad, tmpBuf, colSum, localTexture, localTextureClamped, localSat,
    bgState, visited, distFromBg, queue, contourBarrier, rawAlpha
  } = ws;

  // --- STAGE 0: Outlier-Rejected Background Calibration ---
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
      bgFieldR[idx] = bR;
      bgFieldG[idx] = bG;
      bgFieldB[idx] = bB;
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
    if (sat[idx] < 24 && distToBg[inIdx] < 18.0 && sat[inIdx] < 3.2) {
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

  boxFilterRowMajor(grad, localTexture, tmpBuf, colSum, width, height, 3);
  boxFilterRowMajor(clampedGrad, localTextureClamped, tmpBuf, colSum, width, height, 3);
  boxFilterRowMajor(sat, localSat, tmpBuf, colSum, width, height, 3);

  const coreBgTol = Math.max(13.5, Math.min(20.0, 9.5 + noiseStd * 2.2));
  const gapTol = coreBgTol + 11.0;

  // --- STAGE 1B: Semantic Classifier (human vs animal) + Fast Half-Res Inward Distance Map ---
  const semanticAdaptive = opts.semanticAdaptive !== false;
  const semantic = classifySubjectSemantic(data, width, height, ws, coreBgTol);
  if (opts.diagnostics) {
    opts.diagnostics.semantic = semantic;
  }
  const inwardFloodCap = semanticAdaptive ? semantic.params.inwardFloodCap : 48;
  const inwardPocketCap = semanticAdaptive ? semantic.params.inwardPocketCap : 18;
  const maxBoundaryDepth = semanticAdaptive ? semantic.params.maxBoundaryDepth : 12;
  const edgeProtectRadius = semanticAdaptive ? semantic.params.edgeProtectRadius : 0;
  const furCaptureDepth = semanticAdaptive ? semantic.params.furCaptureDepth : 8;
  const clothOverexposureGuard = semanticAdaptive && semantic.params.clothOverexposureGuard;
  const torsoY = (height * 0.44) | 0;

  const inwardDist = buildSubjectInwardDistanceFast(ws, coreBgTol);

  // --- STAGE 2: Semantic-Adaptive Exterior Flood-Fill ---
  bgState.fill(0);
  let head = 0, tail = 0;

  const trySeed = (x, y) => {
    const idx = y * width + x;
    if (bgState[idx] === 0 && distToBg[idx] <= coreBgTol) {
      if (clothOverexposureGuard && sat[idx] >= 3.2 && distToBg[idx] >= 4.5 && (y >= torsoY || localTextureClamped[idx] >= 2.0)) return;
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
      if (bgState[nIdx] !== 0 || inwardDist[nIdx] >= inwardFloodCap) continue;

      const d = distToBg[nIdx];
      const sVal = sat[nIdx];
      const texC = localTextureClamped[nIdx];
      // Human semantic guard: protect textured/hue-shifted clothing silhouettes from exterior flood chewing
      if (clothOverexposureGuard) {
        if (sVal >= 3.2 && d >= 4.5 && (ny >= torsoY || texC >= 2.0)) continue;
        if (ny >= torsoY && sVal >= 2.2 && d >= 3.5 && texC >= 1.9) continue;
        if (texC >= 2.6 && sVal >= 2.4 && d > coreBgTol * 0.48 && (inwardDist[nIdx] >= 4 || ny >= torsoY)) continue;
      }

      const lDiff = lum[nIdx] - bgLum[nIdx];
      const inOuterMargin = nx < 24 || nx >= width - 24 || ny < 24 || ny >= height - 24;
      const blockClothVapor = clothOverexposureGuard && ny >= torsoY && texC >= 1.9 && sVal >= 2.1;

      if (d <= coreBgTol) {
        bgState[nIdx] = (!inOuterMargin && !blockClothVapor && lDiff > 9.0 && sVal < 16 && grad[nIdx] < 9.5 && localTexture[nIdx] >= 2.2) ? 2 : 1;
        queue[tail++] = nIdx;
      } else if (d <= gapTol && grad[nIdx] < 13.5 && sVal < 14) {
        bgState[nIdx] = (!inOuterMargin && !blockClothVapor && lDiff > 8.5 && localTexture[nIdx] >= 2.2) ? 2 : 3;
        queue[tail++] = nIdx;
      }
    }
  }

  // --- STAGE 3: Exterior-Only Pocket Classifier (Semantic-Adaptive inwardDist cap) ---
  for (let i = 0; i < total; i++) {
    visited[i] = (bgState[i] > 0 || inwardDist[i] >= inwardPocketCap) ? 1 : 0;
  }
  const pocketTol = coreBgTol + 9.5;
  const maxPocketSat = clothOverexposureGuard ? 3.2 : 14.0;
  const maxPocketTex = clothOverexposureGuard ? 2.4 : 4.2;
  const pocketSeeds = [];

  for (let i = 0; i < total; i++) {
    if (visited[i]) continue;
    if (distToBg[i] > pocketTol || sat[i] > maxPocketSat || localTextureClamped[i] > maxPocketTex) {
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
        if (bgState[nIdx] > 0 || inwardDist[nIdx] >= inwardPocketCap) continue;
        if (distToBg[nIdx] <= pocketTol && sat[nIdx] <= maxPocketSat && localTextureClamped[nIdx] <= maxPocketTex) {
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            queue[cTail++] = nIdx;
          }
        }
      }
    }
    const area = cTail;
    if (area < 28) continue;
    if (minDist <= coreBgTol && (sumDist / area) <= coreBgTol + 5.5 && (sumTex / area) <= (clothOverexposureGuard ? 2.2 : 3.4)) {
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
        if (bgState[nIdx] !== 0 || inwardDist[nIdx] >= inwardFloodCap) continue;
        if (clothOverexposureGuard && ((sat[nIdx] >= 3.0 && distToBg[nIdx] >= 3.5) || localTextureClamped[nIdx] >= 2.4)) continue;
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

  // --- STAGE 4: Semantic-Adaptive Distance Transform from Pure Background (`bgState === 1`) ---
  const maxDepth = maxBoundaryDepth;
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

  // --- STAGE 5: Boundary-Seeded Deduplicated SPFA Geodesic Contour Barrier Map ---
  contourBarrier.fill(999);
  const inQueue = visited;
  inQueue.fill(0);
  head = 0; tail = 0;

  for (let i = 0; i < total; i++) {
    if (bgState[i] === 1 || bgState[i] === 2) {
      contourBarrier[i] = 0;
    }
  }
  // Only push boundary `bgState === 1 || 2` pixels that have at least one `bgState === 0 || 3` neighbor!
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

  while (head !== tail) {
    const idx = queue[head++];
    if (head === total) head = 0;
    inQueue[idx] = 0;
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

  // --- STAGE 6: EXACT v5.2 Fur & Vapor Matting on Perimeter + Protected Deep Torso Core ---
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

    const y = (i / width) | 0;
    const texC = localTextureClamped[i];
    const tex = localTexture[i];
    const isHairFurTex = tex >= 8.5 && tex > texC * 1.22;
    const isProtectedHumanCloth = clothOverexposureGuard
      && bgState[i] === 0
      && !isHairFurTex
      && sat[i] >= 2.3
      && d >= 3.8
      && (y >= torsoY || (ring <= edgeProtectRadius && texC >= 2.2));

    // Prevent vapor unmixing from overexposing/bleaching lit human clothing shoulders & collars
    const isVaporWisp = !isProtectedHumanCloth
      && ((bgState[i] === 2) || (lum[i] > bL + 4.0 && sat[i] <= 22 && contourBarrier[i] < 24 && grad[i] < 20));

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
    else if (ring <= furCaptureDepth || bgState[i] === 3) {
      const x = i - y * width;
      let fgR = r, fgG = g, fgB = b, bestDist = d;
      const baseRad = furCaptureDepth > 8 ? 10 : 8;
      const rad = Math.min(baseRad, (furCaptureDepth + 3) - Math.min(furCaptureDepth, ring));
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
      } else if (isProtectedHumanCloth && ring <= edgeProtectRadius) {
        // Lock human clothing silhouette inside edgeProtectRadius to stop chewing & overexposure
        const chromaA = smoothstep(2.0, 3.6, sat[i]);
        alpha = ring <= 1 ? clamp(Math.max(0.58, chromaA, projA, distA), 0.58, 1) : 1.0;
      } else if (ring <= 2) {
        alpha = Math.min(projA, Math.max(distA, projA * 0.85));
      } else if (ring <= (furCaptureDepth > 8 ? 7 : 5)) {
        alpha = clamp(Math.max(projA, distA), 0.25, 1);
      } else {
        alpha = clamp(Math.max(0.85, projA), 0.85, 1);
      }

      if (alpha > 0.03) {
        const unmixA = clamp(Math.max(alpha, 0.20), 0.20, 1.0);
        const uR = clamp((r - (1 - unmixA) * bR) / unmixA, 0, 255);
        const uG = clamp((g - (1 - unmixA) * bG) / unmixA, 0, 255);
        const uB = clamp((b - (1 - unmixA) * bB) / unmixA, 0, 255);
        const w = isProtectedHumanCloth
          ? (ring <= 2 ? 0.60 : 0.0)
          : ring <= 3 ? 0.92 : Math.max(0, ((furCaptureDepth + 1) - ring) / Math.max(1, furCaptureDepth - 2)) * 0.70;
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

  // --- STAGE 7: Fast Row-Major Edge-Preserving Guided Filter ---
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

  return data;
}


