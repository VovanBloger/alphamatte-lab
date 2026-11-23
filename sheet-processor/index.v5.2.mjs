import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { sotaCellMattingV5_2_Fast, classifySubjectSemantic } from './v52-matting-core.mjs';
export { sotaCellMattingV5_2_Fast, classifySubjectSemantic };

/**
 * Supported sticker sheet grid layouts.
 */
export const SUPPORTED_LAYOUTS = Object.freeze({
  '3x3': Object.freeze({ columns: 3, rows: 3, expectedCount: 9 }),
  '3x4': Object.freeze({ columns: 3, rows: 4, expectedCount: 12 }),
});

/**
 * Default processor configuration parameters and their meaning:
 * - layout: '3x4' ('3x3' = 9 stickers, '3x4' = 12 stickers, row-major order)
 * - backgroundColor: '#00FF00' (target chroma-key background color in #RRGGBB or #RGB)
 * - nativeAlphaOnly: true to require the original PNG alpha channel and skip all color keying
 * - outputSize: 512 (final square sticker canvas dimension in px, 512x512 for Telegram)
 * - padding: 0 (transparent margin in px around each sticker inside the outputSize canvas; 0 maximizes sticker scale to 512px)
 * - tolerance: 42 (color distance threshold 5..120 for connected background removal; accounts for JPEG noise)
 * - softness: 28 (transition ramp width 2..80 for smooth alpha matting on fur, whiskers, hair, and anti-aliased edges)
 * - spillSuppression: 0.90 (0..1 strength of foreground color unmixing and chroma-spill halo suppression on edges)
 * - interiorHoleStrictness: 0.65 (0.3..0.95 strictness for clearing enclosed background pockets between limbs/paws while protecting green eyes/clothes)
 * - interiorHoleMinArea: 16 (minimum pixel area for an enclosed background pocket to be cleared)
 * - maxGridShiftRatio: 0.16 (maximum fraction of cell width/height to shift grid cut lines when searching for a clean gap)
 * - allowUpscale: true (upscale stickers so the larger dimension reaches outputSize)
 * - maxFileBytes: 524288 (maximum allowed output PNG file size in bytes = 512 KB for Telegram)
 * - maxInputBytes: 52428800 (maximum input file size in bytes = 50 MB)
 * - maxPixels: 67108864 (maximum input pixel count = 8192x8192, supports 4096x4096 4K and above)
 * - strict: false (when true, warnings downgrade overall status from 'ready' to 'needs_review')
 * - debug: false (when true, outputs diagnostic masks and grid overlays into debug/)
 */
export const DEFAULT_OPTIONS = Object.freeze({
  version: 1,
  layout: '3x4',
  backgroundColor: '#00FF00',
  outputSize: 512,
  padding: 24,
  tolerance: 42,
  softness: 28,
  spillSuppression: 0.9,
  interiorHoleStrictness: 0.65,
  interiorHoleMinArea: 16,
  maxGridShiftRatio: 0.16,
  allowUpscale: false,
  maxFileBytes: 512 * 1024,
  maxInputBytes: 50 * 1024 * 1024,
  maxPixels: 8192 * 8192,
  minStickerPixels: 48,
  strict: false,
  debug: false,
  exportTransparentSheet: true,
  exportPreview: true,
});

/**
 * Parse a hex color string (#RGB or #RRGGBB) into { r, g, b, hex }.
 */
export function parseHexColor(input) {
  if (typeof input !== 'string') {
    throw new Error('Параметр backgroundColor должен быть строкой в формате #RRGGBB или #RGB.');
  }
  const clean = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return {
      r,
      g,
      b,
      hex: `#${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`.toUpperCase(),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return { r, g, b, hex: `#${clean.toUpperCase()}` };
  }
  throw new Error(`Некорректный цвет фона "${input}". Ожидается HEX вида #00FF00.`);
}

function clamp(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Ensure targetFilePath is strictly confined inside rootDir.
 */
function assertPathInsideDir(rootDir, targetFilePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetFilePath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Нарушение безопасности пути: "${targetFilePath}" выходит за пределы "${rootDir}".`);
  }
  return resolvedTarget;
}

/**
 * Atomic file write via temporary sibling file and rename.
 */
async function writeFileAtomic(rootDir, targetPath, dataBuffer) {
  const safeTarget = assertPathInsideDir(rootDir, targetPath);
  const parentDir = path.dirname(safeTarget);
  await fs.mkdir(parentDir, { recursive: true });
  const tmpName = `${path.basename(safeTarget)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const tmpPath = assertPathInsideDir(rootDir, path.join(parentDir, tmpName));
  try {
    await fs.writeFile(tmpPath, dataBuffer);
    await fs.rename(tmpPath, safeTarget);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

// The provider supplies a single alpha plane. The CPU slicer uses the same
// contract on its decoded RGBA buffer, including for resumed legacy jobs.
export function inspectNativeSheetAlpha(pixels, width, height, rows, channels = 1, hasAlphaChannel = true) {
  const totalPixels = width * height;
  let transparentPixels = 0;
  if (hasAlphaChannel) {
    for (let i = channels - 1; i < pixels.length; i += channels) if (pixels[i] < 8) transparentPixels++;
  }
  const result = { hasAlphaChannel, transparentPixels, totalPixels, separatedGrid: false, accepted: false };
  if (!transparentPixels || width < 3 * 32 || height < rows * 32) return result;

  const alpha = (x, y) => pixels[(y * width + x) * channels + channels - 1];
  let strict = true;
  const segment = (x, y, dx, dy, length, secondX, secondY) => {
    let clear = 0;
    for (let i = 0; i < length; i++) {
      if (alpha(x + dx*i, y + dy*i) < 8 && alpha(secondX + dx*i, secondY + dy*i) < 8) clear++;
    }
    if (clear !== length) strict = false;
    return clear >= length * 0.8;
  };
  for (let r = 0; r < rows; r++) {
    const top = Math.floor(r * height / rows), bottom = Math.floor((r + 1) * height / rows);
    for (let c = 0; c <= 3; c++) {
      const x = Math.max(0, Math.min(width - 2, Math.floor(c * width / 3) - 1));
      if (!segment(x, top, 0, 1, bottom - top, x + 1, top)) return result;
    }
  }
  for (let c = 0; c < 3; c++) {
    const left = Math.floor(c * width / 3), right = Math.floor((c + 1) * width / 3);
    for (let r = 0; r <= rows; r++) {
      const y = Math.max(0, Math.min(height - 2, Math.floor(r * height / rows) - 1));
      if (!segment(left, y, 1, 0, right - left, left, y + 1)) return result;
    }
  }
  const samples = 32;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 3; c++) {
      let visible = 0, clear = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const a = alpha(Math.floor((c + (sx + 0.5)/samples)*width/3), Math.floor((r + (sy + 0.5)/samples)*height/rows));
          if (a >= 64) visible++;
          if (a < 8) clear++;
        }
      }
      if (visible < samples*samples*0.01 || !clear) return result;
      const insetX = Math.floor(width/(3*32)), insetY = Math.floor(height/(rows*32));
      const x0 = Math.floor(c*width/3) + insetX, x1 = Math.floor((c+1)*width/3) - 1 - insetX;
      const y0 = Math.floor(r*height/rows) + insetY, y1 = Math.floor((r+1)*height/rows) - 1 - insetY;
      if ([alpha(x0,y0), alpha(x1,y0), alpha(x0,y1), alpha(x1,y1)].some(value => value >= 8)) strict = false;
    }
  }
  result.separatedGrid = strict;
  result.accepted = strict || transparentPixels >= totalPixels * 0.1;
  return result;
}

/**
 * Estimate calibrated background color and noise floor from perimeter and grid gutter samples.
 */
function calibrateSheetBackground(data, width, height, targetColor, tolerance, columns, rows) {
  const { r: kr, g: kg, b: kb } = targetColor;
  const maxSampleDist = Math.max(65, tolerance * 1.85);
  const maxSampleDistSq = maxSampleDist * maxSampleDist;

  let transparentBorderCount = 0;
  let totalBorderCount = 0;
  let matchedCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const sampleR = [];
  const sampleG = [];
  const sampleB = [];
  const borderR = [];
  const borderG = [];
  const borderB = [];

  function inspectPixel(x, y, isBorder) {
    const off = (y * width + x) * 4;
    const a = data[off + 3];
    if (isBorder) {
      totalBorderCount++;
      if (a <= 12) {
        transparentBorderCount++;
        return;
      }
      if (borderR.length < 4096) {
        borderR.push(data[off]);
        borderG.push(data[off + 1]);
        borderB.push(data[off + 2]);
      }
    } else if (a <= 12) {
      return;
    }
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    const dr = r - kr;
    const dg = g - kg;
    const db = b - kb;
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq <= maxSampleDistSq) {
      matchedCount++;
      sumR += r;
      sumG += g;
      sumB += b;
      if (sampleR.length < 4096) {
        sampleR.push(r);
        sampleG.push(g);
        sampleB.push(b);
      }
    }
  }

  const stepX = Math.max(1, Math.floor(width / 512));
  const stepY = Math.max(1, Math.floor(height / 512));

  // Sample 2px outer perimeter
  for (let x = 0; x < width; x += stepX) {
    inspectPixel(x, 0, true);
    inspectPixel(x, height - 1, true);
    if (height > 2) {
      inspectPixel(x, 1, true);
      inspectPixel(x, height - 2, true);
    }
  }
  for (let y = 2; y < height - 2; y += stepY) {
    inspectPixel(0, y, true);
    inspectPixel(width - 1, y, true);
    if (width > 2) {
      inspectPixel(1, y, true);
      inspectPixel(width - 2, y, true);
    }
  }

  // Also sample expected grid gutter lines
  for (let c = 1; c < columns; c++) {
    const gx = Math.floor((c * width) / columns);
    for (let y = 0; y < height; y += stepY * 2) {
      inspectPixel(gx, y, false);
    }
  }
  for (let r = 1; r < rows; r++) {
    const gy = Math.floor((r * height) / rows);
    for (let x = 0; x < width; x += stepX * 2) {
      inspectPixel(x, gy, false);
    }
  }

  const transparentBorderRatio = totalBorderCount > 0 ? transparentBorderCount / totalBorderCount : 0;
  const opaqueBorderCount = Math.max(0, totalBorderCount - transparentBorderCount);
  const nativeAlphaSheet = transparentBorderRatio > 0.55 && matchedCount < Math.max(12, opaqueBorderCount * 0.15);

  if (!nativeAlphaSheet && matchedCount < Math.max(12, opaqueBorderCount * 0.25) && borderR.length >= 32) {
    const sortedR = [...borderR].sort((a, b) => a - b);
    const sortedG = [...borderG].sort((a, b) => a - b);
    const sortedB = [...borderB].sort((a, b) => a - b);
    const mid = Math.floor(borderR.length / 2);
    const medR = sortedR[mid];
    const medG = sortedG[mid];
    const medB = sortedB[mid];
    const inlierTolSq = 38 * 38;
    let inlierCount = 0;
    let inSumR = 0;
    let inSumG = 0;
    let inSumB = 0;
    const inR = [];
    const inG = [];
    const inB = [];
    for (let i = 0; i < borderR.length; i++) {
      const dr = borderR[i] - medR;
      const dg = borderG[i] - medG;
      const db = borderB[i] - medB;
      if (dr * dr + dg * dg + db * db <= inlierTolSq) {
        inlierCount++;
        inSumR += borderR[i];
        inSumG += borderG[i];
        inSumB += borderB[i];
        inR.push(borderR[i]);
        inG.push(borderG[i]);
        inB.push(borderB[i]);
      }
    }
    if (inlierCount >= borderR.length * 0.6) {
      const bgR = Math.round(inSumR / inlierCount);
      const bgG = Math.round(inSumG / inlierCount);
      const bgB = Math.round(inSumB / inlierCount);
      let varSum = 0;
      for (let i = 0; i < inR.length; i++) {
        const dr = inR[i] - bgR;
        const dg = inG[i] - bgG;
        const db = inB[i] - bgB;
        varSum += dr * dr + dg * dg + db * db;
      }
      return {
        bgR,
        bgG,
        bgB,
        noiseStd: Math.sqrt(varSum / inR.length),
        matchedRatio: totalBorderCount > 0 ? inlierCount / totalBorderCount : 0,
        transparentBorderRatio,
        nativeAlphaSheet,
      };
    }
  }

  if (matchedCount === 0) {
    return {
      bgR: kr,
      bgG: kg,
      bgB: kb,
      noiseStd: 0,
      matchedRatio: 0,
      transparentBorderRatio,
      nativeAlphaSheet,
    };
  }

  const bgR = Math.round(sumR / matchedCount);
  const bgG = Math.round(sumG / matchedCount);
  const bgB = Math.round(sumB / matchedCount);

  let varSum = 0;
  for (let i = 0; i < sampleR.length; i++) {
    const dr = sampleR[i] - bgR;
    const dg = sampleG[i] - bgG;
    const db = sampleB[i] - bgB;
    varSum += dr * dr + dg * dg + db * db;
  }
  const noiseStd = sampleR.length > 0 ? Math.sqrt(varSum / sampleR.length) : 0;

  return {
    bgR,
    bgG,
    bgB,
    noiseStd,
    matchedRatio: totalBorderCount > 0 ? matchedCount / totalBorderCount : 0,
    transparentBorderRatio,
    nativeAlphaSheet,
  };
}

/**
 * Perform topology-aware chroma key removal, interior hole detection,
 * continuous alpha matting (Smith-Blinn unmixing), and halo despill.
 */
function removeChromaBackground(data, width, height, config, calibration, sharedBuffers) {
  const totalPixels = width * height;
  const { bgMask, visited, queue } = sharedBuffers;
  bgMask.fill(0);
  visited.fill(0);

  const warnings = [];
  const { bgR, bgG, bgB, noiseStd } = calibration;
  const {
    tolerance,
    softness,
    spillSuppression,
    interiorHoleStrictness,
    interiorHoleMinArea,
    columns,
    rows,
  } = config;

  // Chroma unit direction vector from neutral gray to calibrated background
  const bgMean = (bgR + bgG + bgB) / 3;
  const cdR = bgR - bgMean;
  const cdG = bgG - bgMean;
  const cdB = bgB - bgMean;
  const bgChromaMag = Math.hypot(cdR, cdG, cdB);
  const invChromaMag = bgChromaMag > 1e-3 ? 1 / bgChromaMag : 0;
  const uR = cdR * invChromaMag;
  const uG = cdG * invChromaMag;
  const uB = cdB * invChromaMag;

  // Adaptive JPEG noise compensation (tightened for neutral slate/gray backgrounds)
  const jpegCompensation = Math.min(18, noiseStd * 0.85);
  const effTolerance = bgChromaMag <= 30
    ? Math.min(tolerance + jpegCompensation, 26)
    : tolerance + jpegCompensation;
  const effToleranceSq = effTolerance * effTolerance;
  const seedTolerance = effTolerance + softness * 0.35;
  const seedToleranceSq = seedTolerance * seedTolerance;

  // Minimum chroma projection required for a pixel to be considered chroma background
  // Protects pure white outlines and dark black outlines even when tolerance is large
  const minBgChromaProj = bgChromaMag > 30 ? bgChromaMag * 0.32 : -999;

  // Controlled extension thresholds for Stage 3A exterior flood-fill across studio shadows,
  // backdrop rectangles, and lighting gradients on the chroma sheet (e.g. Gemini studio patches)
  const extMinChromaProj = bgChromaMag * 0.48;
  const extMaxDistSq = Math.pow(Math.max(115, effTolerance * 2.5), 2);
  const extMaxPerpSq = Math.pow(Math.max(42, effTolerance * 1.1), 2);
  const extMaxStepSq = 42 * 42;

  function isSolidBgCandidate(pIdx, tolSq) {
    const off = pIdx * 4;
    if (data[off + 3] <= 12) return true;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    const dr = r - bgR;
    const dg = g - bgG;
    const db = b - bgB;
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq > tolSq) return false;
    if (bgChromaMag > 30) {
      const m = (r + g + b) * 0.3333333;
      const proj = (r - m) * uR + (g - m) * uG + (b - m) * uB;
      if (proj < minBgChromaProj) return false;
    }
    return true;
  }

  /**
   * Check if unvisited neighbor `n` adjacent to already-background pixel `idx` belongs to
   * a smooth studio lighting gradient / shaded chroma patch of the key color without ever
   * crossing a sharp white die-cut outline, dark contour, or character fur.
   */
  function isExtendedExternalChromaNeighbor(idx, n) {
    if (bgChromaMag <= 30) return false;
    const idxOff = idx * 4;
    if (data[idxOff + 3] <= 12) return false;
    const nOff = n * 4;
    if (data[nOff + 3] <= 12) return true;

    const nr = data[nOff];
    const ng = data[nOff + 1];
    const nb = data[nOff + 2];

    // 1. Small local color step from neighbor background pixel prevents jumping sharp outlines
    const sr = nr - data[idxOff];
    const sg = ng - data[idxOff + 1];
    const sb = nb - data[idxOff + 2];
    if (sr * sr + sg * sg + sb * sb > extMaxStepSq) return false;

    // 2. Bounded overall distance from calibrated key color
    const dr = nr - bgR;
    const dg = ng - bgG;
    const db = nb - bgB;
    if (dr * dr + dg * dg + db * db > extMaxDistSq) return false;

    // 3. Strong projection along key chroma vector (excludes white outlines, gray/brown/black fur)
    const nm = (nr + ng + nb) * 0.3333333;
    const cr = nr - nm;
    const cg = ng - nm;
    const cb = nb - nm;
    const proj = cr * uR + cg * uG + cb * uB;
    if (proj < extMinChromaProj) return false;

    // 4. Small orthogonal hue-plane deviation from key chroma direction
    const pr = cr - proj * uR;
    const pg = cg - proj * uG;
    const pb = cb - proj * uB;
    return pr * pr + pg * pg + pb * pb <= extMaxPerpSq;
  }

  // Stage 3A: Exterior BFS Flood-Fill from sheet borders and validated grid gutters
  let head = 0;
  let tail = 0;

  function trySeed(x, y, tolSq) {
    const idx = y * width + x;
    if (visited[idx]) return;
    if (isSolidBgCandidate(idx, tolSq)) {
      visited[idx] = 1;
      bgMask[idx] = 1;
      queue[tail++] = idx;
    }
  }

  for (let x = 0; x < width; x++) {
    trySeed(x, 0, seedToleranceSq);
    trySeed(x, height - 1, seedToleranceSq);
  }
  for (let y = 1; y < height - 1; y++) {
    trySeed(0, y, seedToleranceSq);
    trySeed(width - 1, y, seedToleranceSq);
  }

  // 4-connected exterior flood-fill with controlled chroma-gradient extension
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;

    // 4-neighbors
    if (x > 0) {
      const n = idx - 1;
      if (!visited[n] && (isSolidBgCandidate(n, effToleranceSq) || isExtendedExternalChromaNeighbor(idx, n))) {
        visited[n] = 1;
        bgMask[n] = 1;
        queue[tail++] = n;
      }
    }
    if (x + 1 < width) {
      const n = idx + 1;
      if (!visited[n] && (isSolidBgCandidate(n, effToleranceSq) || isExtendedExternalChromaNeighbor(idx, n))) {
        visited[n] = 1;
        bgMask[n] = 1;
        queue[tail++] = n;
      }
    }
    if (y > 0) {
      const n = idx - width;
      if (!visited[n] && (isSolidBgCandidate(n, effToleranceSq) || isExtendedExternalChromaNeighbor(idx, n))) {
        visited[n] = 1;
        bgMask[n] = 1;
        queue[tail++] = n;
      }
    }
    if (y + 1 < height) {
      const n = idx + width;
      if (!visited[n] && (isSolidBgCandidate(n, effToleranceSq) || isExtendedExternalChromaNeighbor(idx, n))) {
        visited[n] = 1;
        bgMask[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  // Stage 3B: Interior Enclosed Background Pockets vs. Green Eyes / Clothing
  // Neutral backgrounds (gray/slate) must use a tight threshold so interior whites/grays (mugs, cards, fur) stay intact.
  const isNeutralBg = Math.max(bgR, bgG, bgB) - Math.min(bgR, bgG, bgB) < 35;
  const holeCandidateTol = isNeutralBg
    ? Math.min(effTolerance * 0.9, 22)
    : Math.max(effTolerance * clamp(interiorHoleStrictness * 1.4, 0.55, 1.25), 46);
  const holeCandidateTolSq = holeCandidateTol * holeCandidateTol;
  const strictHoleTol = isNeutralBg
    ? Math.min(effTolerance * 0.75, 18)
    : Math.max(effTolerance * clamp(interiorHoleStrictness * 1.1, 0.4, 1.05), 38);

  let interiorHolesCleared = 0;
  let ambiguousRegionsProtected = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (visited[i]) continue;
    if (!isSolidBgCandidate(i, holeCandidateTolSq)) {
      visited[i] = 1;
      continue;
    }

    // Found an enclosed island of background-like color: extract component via queue
    let cHead = 0;
    let cTail = 0;
    queue[cTail++] = i;
    visited[i] = 1;

    let sumDist = 0;
    let sumDistSq = 0;
    let minDist = Infinity;
    let boundaryCount = 0;
    let highContrastBoundaryCount = 0;

    while (cHead < cTail) {
      const pIdx = queue[cHead++];
      const px = pIdx % width;
      const py = (pIdx - px) / width;
      const pOff = pIdx * 4;
      const d = Math.hypot(data[pOff] - bgR, data[pOff + 1] - bgG, data[pOff + 2] - bgB);
      sumDist += d;
      sumDistSq += d * d;
      if (d < minDist) minDist = d;

      const dxs = [-1, 1, 0, 0];
      const dys = [0, 0, -1, 1];

      for (let k = 0; k < 4; k++) {
        const nx = px + dxs[k];
        const ny = py + dys[k];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (bgMask[nIdx] === 1) continue;
        if (isSolidBgCandidate(nIdx, holeCandidateTolSq)) {
          if (!visited[nIdx]) {
            visited[nIdx] = 1;
            queue[cTail++] = nIdx;
          }
        } else {
          // Neighbor is foreground boundary around this enclosed pocket.
          // Probe up to 3 pixels outward along (dx, dy) to see past anti-aliasing / JPEG 4:2:0 subsampling
          boundaryCount++;
          let maxWallDist = 0;
          for (let step = 1; step <= 3; step++) {
            const sx = px + dxs[k] * step;
            const sy = py + dys[k] * step;
            if (sx < 0 || sx >= width || sy < 0 || sy >= height) break;
            const sOff = (sy * width + sx) * 4;
            const sDist = Math.hypot(data[sOff] - bgR, data[sOff + 1] - bgG, data[sOff + 2] - bgB);
            if (sDist > maxWallDist) maxWallDist = sDist;
          }
          if (maxWallDist > effTolerance * 1.45) {
            highContrastBoundaryCount++;
          }
        }
      }
    }

    const area = cTail;
    if (area < interiorHoleMinArea) {
      continue;
    }

    const meanDist = sumDist / area;
    const variance = Math.max(0, sumDistSq / area - meanDist * meanDist);
    const stdDev = Math.sqrt(variance);
    const rimContrastRatio = boundaryCount > 0 ? highContrastBoundaryCount / boundaryCount : 0;

    // A genuine enclosed background hole (e.g. between arms/legs/paws/hair strands) closely matches the calibrated sheet
    // background at its core (minDist <= 40), has consistent interior hue, and is surrounded by a distinct silhouette edge.
    const isGenuineHole =
      minDist <= Math.min(40, strictHoleTol) &&
      meanDist <= strictHoleTol + 8 &&
      stdDev <= Math.max(18, noiseStd * 1.9 + 12) &&
      rimContrastRatio >= 0.55;

    if (isGenuineHole) {
      for (let k = 0; k < area; k++) {
        bgMask[queue[k]] = 2; // 2 = cleared interior background hole
      }
      // Expand cleared hole up to effToleranceSq (up to 3px ring) so JPEG 4:2:0 transition pixels are included
      let expandHead = 0;
      let expandTail = area;
      while (expandHead < expandTail) {
        const pIdx = queue[expandHead++];
        const px = pIdx % width;
        const py = (pIdx - px) / width;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const nIdx = ny * width + nx;
            if (bgMask[nIdx] === 0 && isSolidBgCandidate(nIdx, effToleranceSq)) {
              bgMask[nIdx] = 2;
              visited[nIdx] = 1;
              if (expandTail < totalPixels) {
                queue[expandTail++] = nIdx;
              }
            }
          }
        }
      }
      interiorHolesCleared++;
    } else if (area >= 64 && meanDist <= strictHoleTol * 0.9 && rimContrastRatio >= 0.35) {
      // Very close to key color and borderline rim contrast: protected, but worthy of a warning
      ambiguousRegionsProtected++;
    }
  }

  if (ambiguousRegionsProtected > 0) {
    warnings.push(
      `Обнаружено ${ambiguousRegionsProtected} внутренних участков с оттенком, близким к фону (сохранены как часть персонажа: глаза/одежда/аксессуары).`
    );
  }

  // Stage 4 & 5: Continuous Alpha Matting (Smith-Blinn Unmixing) & Edge Halo Despill
  // Identify a 3-pixel boundary band around bgMask > 0 using visited array as distance map (1..3)
  visited.fill(0);
  head = 0;
  tail = 0;

  for (let i = 0; i < totalPixels; i++) {
    if (bgMask[i] > 0) {
      data[i * 4 + 3] = 0;
    } else {
      const x = i % width;
      const y = (i - x) / width;
      if (
        (x > 0 && bgMask[i - 1] > 0) ||
        (x + 1 < width && bgMask[i + 1] > 0) ||
        (y > 0 && bgMask[i - width] > 0) ||
        (y + 1 < height && bgMask[i + width] > 0) ||
        (x > 0 && y > 0 && bgMask[i - width - 1] > 0) ||
        (x + 1 < width && y > 0 && bgMask[i - width + 1] > 0) ||
        (x > 0 && y + 1 < height && bgMask[i + width - 1] > 0) ||
        (x + 1 < width && y + 1 < height && bgMask[i + width + 1] > 0)
      ) {
        visited[i] = 1; // 1px from background
        queue[tail++] = i;
      }
    }
  }

  // Keep the despill band at about one final-output pixel: 3px at 1536,
  // 8px at 4K. A fixed 3px band leaves opaque JPEG chroma fringes on 4K sheets.
  const boundaryBand = Math.max(3, Math.min(12, Math.round(Math.min(width, height) / 512)));
  while (head < tail) {
    const idx = queue[head++];
    const distRing = visited[idx];
    if (distRing >= boundaryBand) continue;
    const x = idx % width;
    const y = (idx - x) / width;
    const nextRing = distRing + 1;

    if (x > 0 && bgMask[idx - 1] === 0 && visited[idx - 1] === 0) {
      visited[idx - 1] = nextRing;
      queue[tail++] = idx - 1;
    }
    if (x + 1 < width && bgMask[idx + 1] === 0 && visited[idx + 1] === 0) {
      visited[idx + 1] = nextRing;
      queue[tail++] = idx + 1;
    }
    if (y > 0 && bgMask[idx - width] === 0 && visited[idx - width] === 0) {
      visited[idx - width] = nextRing;
      queue[tail++] = idx - width;
    }
    if (y + 1 < height && bgMask[idx + width] === 0 && visited[idx + width] === 0) {
      visited[idx + width] = nextRing;
      queue[tail++] = idx + width;
    }
  }

  const rampStart = Math.max(8, effTolerance * 0.72);
  const rampEnd = effTolerance + Math.max(4, softness);
  const noiseFloor = Math.max(6, effTolerance * 0.42);
  const alphaBand = Math.max(2, Math.min(5, Math.ceil(boundaryBand * 0.65)));

  // Process all boundary-band pixels stored in queue[0..tail-1]
  for (let q = 0; q < tail; q++) {
    const idx = queue[q];
    const ring = visited[idx];
    const off = idx * 4;
    const origA = data[off + 3];
    if (origA === 0) continue;

    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];

    const dr = r - bgR;
    const dg = g - bgG;
    const db = b - bgB;
    const dist = Math.hypot(dr, dg, db);

    const pixelMean = (r + g + b) * 0.3333333;
    const chromaProj = bgChromaMag > 20 ? (r - pixelMean) * uR + (g - pixelMean) * uG + (b - pixelMean) * uB : 0;
    const chromaRatio = bgChromaMag > 20 ? clamp(chromaProj / bgChromaMag, 0, 1) : 0;

    // 1. Continuous alpha matting combining Smith-Blinn channel lower bound and key-chroma spillover
    let alphaNorm = 1.0;
    if (ring <= alphaBand && (chromaRatio > 0.04 || ring === 1)) {
      const distAlpha = smoothstep(rampStart, rampEnd, dist);

      // Channel-wise Porter-Duff / Smith-Blinn lower bound for bright outlines (white border/whiskers)
      // and dark outlines (black ink lines) mixed with background color
      let channelLowerBound = 0;
      const channels = [
        [r, bgR],
        [g, bgG],
        [b, bgB],
      ];
      for (let c = 0; c < 3; c++) {
        const val = channels[c][0];
        const bgVal = channels[c][1];
        const diff = Math.abs(val - bgVal) - noiseFloor;
        if (diff > 0) {
          const span = val > bgVal ? Math.max(24, 255 - bgVal) : Math.max(24, bgVal);
          const lb = diff / (span - noiseFloor * 0.5);
          if (lb > channelLowerBound) channelLowerBound = lb;
        }
      }
      channelLowerBound = clamp(channelLowerBound, 0, 1);

      if (bgChromaMag > 20 && chromaRatio > 0.04) {
        // When key-chroma spill is still significant (e.g. white sticker border + green screen + JPEG 4:2:0),
        // linear key-chroma removal (1 - chromaRatio) and channelLowerBound track the exact edge coverage
        // instead of saturating to 1.0 at 18% white like raw Euclidean distance does.
        const alphaFromChroma = smoothstep(0.14, 0.96, 1 - chromaRatio);
        alphaNorm = Math.min(1.0, Math.max(channelLowerBound * 0.95, alphaFromChroma));
      } else {
        alphaNorm = Math.max(distAlpha, channelLowerBound * 0.92);
      }

      if (ring >= alphaBand) {
        alphaNorm = Math.max(alphaNorm, 0.72);
      }
      if (alphaNorm < 0.05) {
        data[off] = 0;
        data[off + 1] = 0;
        data[off + 2] = 0;
        data[off + 3] = 0;
        continue;
      }
    }

    const newA = Math.min(origA, Math.round(clamp(alphaNorm, 0, 1) * 255));
    data[off + 3] = newA;

    // 2. Foreground color unmixing & directional chroma spill suppression
    if (spillSuppression > 0) {
      const ringWeight = ring <= Math.max(2, boundaryBand - 2) ? 1.0 : ring < boundaryBand ? 0.75 : 0.45;
      const strength = spillSuppression * ringWeight;

      // Unmix background contribution (C - (1 - a) * B) / a for semi-transparent edge pixels
      const unmixAlpha = clamp(Math.max(alphaNorm, 0.25), 0.25, 1.0);
      const invAlpha = 1 / unmixAlpha;
      const unmixedR = clamp((r - (1 - unmixAlpha) * bgR) * invAlpha, 0, 255);
      const unmixedG = clamp((g - (1 - unmixAlpha) * bgG) * invAlpha, 0, 255);
      const unmixedB = clamp((b - (1 - unmixAlpha) * bgB) * invAlpha, 0, 255);

      let outR = r + (unmixedR - r) * strength;
      let outG = g + (unmixedG - g) * strength;
      let outB = b + (unmixedB - b) * strength;

      // Suppress remaining positive chroma projection along the key color vector
      if (bgChromaMag > 20) {
        const mean = (outR + outG + outB) * 0.3333333;
        const proj = (outR - mean) * uR + (outG - mean) * uG + (outB - mean) * uB;
        if (proj > 0) {
          const despillFactor = Math.max(strength, chromaRatio > 0.03 ? spillSuppression : strength);
          const cancel = proj * despillFactor;
          outR = clamp(outR - uR * cancel, 0, 255);
          outG = clamp(outG - uG * cancel, 0, 255);
          outB = clamp(outB - uB * cancel, 0, 255);
        }
      }

      data[off] = Math.round(outR);
      data[off + 1] = Math.round(outG);
      data[off + 2] = Math.round(outB);
    }
  }

  return { warnings, interiorHolesCleared, ambiguousRegionsProtected };
}

/**
 * Find optimal seam position in 1D projection array near expectedPos within +-maxShift.
 */
function findOptimalSeam1D(projection, length, expectedPos, maxShift) {
  const minPos = Math.max(1, expectedPos - maxShift);
  const maxPos = Math.min(length - 2, expectedPos + maxShift);

  // 1. Search for contiguous zero-alpha runs (completely clear gutter)
  let bestZeroRunCenter = -1;
  let bestZeroRunScore = -Infinity;

  let runStart = -1;
  for (let p = minPos; p <= maxPos + 1; p++) {
    const val = p <= maxPos ? projection[p] : 1;
    if (val === 0) {
      if (runStart === -1) runStart = p;
    } else if (runStart !== -1) {
      const runEnd = p - 1;
      const runWidth = runEnd - runStart + 1;
      const runCenter = Math.round((runStart + runEnd) / 2);
      const distPenalty = Math.abs(runCenter - expectedPos) * 0.35;
      const score = runWidth * 2.5 - distPenalty;
      if (score > bestZeroRunScore) {
        bestZeroRunScore = score;
        bestZeroRunCenter = runCenter;
      }
      runStart = -1;
    }
  }

  if (bestZeroRunCenter !== -1) {
    return { pos: bestZeroRunCenter, minOpaqueCount: 0, hasCleanGap: true };
  }

  // 2. No completely zero line: find minimum-opacity valley closest to expectedPos
  let bestPos = expectedPos;
  let minVal = projection[expectedPos];
  for (let p = minPos; p <= maxPos; p++) {
    const val = projection[p];
    if (
      val < minVal ||
      (val === minVal && Math.abs(p - expectedPos) < Math.abs(bestPos - expectedPos))
    ) {
      minVal = val;
      bestPos = p;
    }
  }

  return { pos: bestPos, minOpaqueCount: minVal, hasCleanGap: minVal === 0 };
}

// Image models can keep the right cell count while giving rows unequal heights.
// Widen the search only to find a genuinely empty gutter, never to accept a
// lower-density cut through a subject. Reject implausibly narrow inferred bands.
function inferGridSeams(projection, length, count, maxShift) {
  const nominalSize = length / count;
  const seams = [];
  for (let index = 1; index < count; index++) {
    const expected = Math.round(index * nominalSize);
    const primary = findOptimalSeam1D(projection, length, expected, maxShift);
    const wider = primary.hasCleanGap ? primary : findOptimalSeam1D(
      projection, length, expected, Math.max(maxShift, Math.floor(nominalSize * 0.45))
    );
    const seam = wider.hasCleanGap ? wider : primary;
    seams.push({ index, expected, actual: seam.pos, ...seam });
  }
  const cuts = [0, ...seams.map(seam => seam.pos), length];
  if (cuts.some((cut, index) => index > 0 && cut - cuts[index - 1] < nominalSize * 0.5)) {
    return Array.from({ length: count - 1 }, (_, i) => {
      const expected = Math.round((i + 1) * nominalSize);
      const seam = findOptimalSeam1D(projection, length, expected, maxShift);
      return { index: i + 1, expected, actual: seam.pos, ...seam };
    });
  }
  return seams;
}

/**
 * Segment foreground components, adjust grid seams, and assign components to cells
 * without cutting through characters or dropping detached props (hearts, sparkles, text).
 */
function segmentCellsAndComponents(data, width, height, config, sharedBuffers) {
  const { columns, rows, maxGridShiftRatio } = config;
  const totalPixels = width * height;
  const { visited, queue } = sharedBuffers;

  // 1. Compute global and per-band 1D alpha projections
  const colAlpha = new Int32Array(width);
  const rowAlpha = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let rSum = 0;
    for (let x = 0; x < width; x++) {
      const a = data[(rowOff + x) * 4 + 3];
      if (a > 20) {
        colAlpha[x]++;
        rSum++;
      }
    }
    rowAlpha[y] = rSum;
  }

  const nominalColW = width / columns;
  const nominalRowH = height / rows;
  const maxShiftX = Math.max(4, Math.floor(nominalColW * maxGridShiftRatio));
  const maxShiftY = Math.max(4, Math.floor(nominalRowH * maxGridShiftRatio));

  const xCuts = [0];
  const yCuts = [0];
  const seamDiagnostics = { xSeams: [], ySeams: [] };

  for (const seam of inferGridSeams(colAlpha, width, columns, maxShiftX)) {
    xCuts.push(seam.pos);
    seamDiagnostics.xSeams.push(seam);
  }
  xCuts.push(width);

  for (const seam of inferGridSeams(rowAlpha, height, rows, maxShiftY)) {
    yCuts.push(seam.pos);
    seamDiagnostics.ySeams.push(seam);
  }
  yCuts.push(height);

  // Also compute per-row refined vertical seams and per-column refined horizontal seams
  // (in case characters in different rows/columns shift or have staggered heights)
  const rowVerticalCuts = [];
  const xSeamAllRowsClean = new Array(Math.max(0, columns - 1)).fill(true);
  for (let r = 0; r < rows; r++) {
    const y0 = yCuts[r];
    const y1 = yCuts[r + 1];
    const localColAlpha = new Int32Array(width);
    for (let y = y0; y < y1; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        if (data[(rowOff + x) * 4 + 3] > 20) {
          localColAlpha[x]++;
        }
      }
    }
    const rCuts = [0];
    for (let c = 1; c < columns; c++) {
      const expX = seamDiagnostics.xSeams[c - 1].hasCleanGap ? xCuts[c] : Math.round(c * nominalColW);
      const seam = findOptimalSeam1D(localColAlpha, width, expX, maxShiftX);
      rCuts.push(seam.pos);
      if (!seam.hasCleanGap) {
        xSeamAllRowsClean[c - 1] = false;
      }
    }
    rCuts.push(width);
    rowVerticalCuts.push(rCuts);
  }
  for (let c = 1; c < columns; c++) {
    if (!seamDiagnostics.xSeams[c - 1].hasCleanGap && xSeamAllRowsClean[c - 1]) {
      seamDiagnostics.xSeams[c - 1].hasCleanGap = true;
      seamDiagnostics.xSeams[c - 1].minOpaqueCount = 0;
    }
  }

  const colHorizontalCuts = [];
  const ySeamAllColsClean = new Array(Math.max(0, rows - 1)).fill(true);
  for (let c = 0; c < columns; c++) {
    const x0 = xCuts[c];
    const x1 = xCuts[c + 1];
    const localRowAlpha = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      let rSum = 0;
      for (let x = x0; x < x1; x++) {
        if (data[(rowOff + x) * 4 + 3] > 20) {
          rSum++;
        }
      }
      localRowAlpha[y] = rSum;
    }
    const cCuts = [0];
    for (let r = 1; r < rows; r++) {
      const expY = seamDiagnostics.ySeams[r - 1].hasCleanGap ? yCuts[r] : Math.round(r * nominalRowH);
      const seam = findOptimalSeam1D(localRowAlpha, height, expY, maxShiftY);
      cCuts.push(seam.pos);
      if (!seam.hasCleanGap) {
        ySeamAllColsClean[r - 1] = false;
      }
    }
    cCuts.push(height);
    colHorizontalCuts.push(cCuts);
  }
  for (let r = 1; r < rows; r++) {
    if (!seamDiagnostics.ySeams[r - 1].hasCleanGap && ySeamAllColsClean[r - 1]) {
      seamDiagnostics.ySeams[r - 1].hasCleanGap = true;
      seamDiagnostics.ySeams[r - 1].minOpaqueCount = 0;
    }
  }

  function findInterval(cuts, count, coord) {
    for (let i = 0; i < count; i++) {
      if (coord >= cuts[i] && coord < cuts[i + 1]) {
        return i;
      }
    }
    return count - 1;
  }

  // Helper to locate which cell (row, col) a point (cx, cy) falls into
  function findCellForPoint(cx, cy) {
    let col = findInterval(xCuts, columns, cx);
    let row = findInterval(colHorizontalCuts[col], rows, cy);
    col = findInterval(rowVerticalCuts[row], columns, cx);
    row = findInterval(colHorizontalCuts[col], rows, cy);
    return { row, col, cellIndex: row * columns + col };
  }

  // 2. Extract 8-connected foreground components (alpha > 16)
  // This ensures that:
  // - All disconnected parts of one sticker (hearts, confetti, floating paws) in the same cell stay together.
  // - A tail/ear slightly crossing a nominal grid line stays attached to its character and is NEVER guillotined.
  // - If two neighboring characters genuinely touch/overlap into a single giant component spanning two cells,
  //   we detect it accurately and flag `needs_review` instead of silently chopping the character!
  visited.fill(0);
  const cells = Array.from({ length: rows * columns }, (_, idx) => {
    const row = Math.floor(idx / columns);
    const col = idx % columns;
    const rCuts = rowVerticalCuts[row];
    const cCuts = colHorizontalCuts[col];
    return {
      index: idx + 1,
      row,
      column: col,
      nominalBounds: {
        left: rCuts[col],
        top: cCuts[row],
        right: rCuts[col + 1] - 1,
        bottom: cCuts[row + 1] - 1,
      },
      components: [],
      pixelCount: 0,
      opaquePixelCount: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
      warnings: [],
      overlappingCells: new Set(),
    };
  });
  let foregroundPixelCount = 0;
  let ignoredDustPixelCount = 0;
  let retainedComponentCount = 0;
  let retainedPixelCount = 0;

  // Store component ID per foreground pixel only for overlapping/multi-component resolution
  // To avoid allocating another 67MB array on 4K, each component records its bounding box;
  // if a component extends outside its assigned cell's nominal box (e.g. an overhanging tail),
  // we track its pixel indices (or bbox if isolated).
  for (let i = 0; i < totalPixels; i++) {
    if (visited[i]) continue;
    if (data[i * 4 + 3] <= 16) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    let weightSum = 0;
    let opaqueCount = 0;
    const cellMass = new Float64Array(rows * columns);

    while (head < tail) {
      const pIdx = queue[head++];
      const x = pIdx % width;
      const y = (pIdx - x) / width;
      const a = data[pIdx * 4 + 3];

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      sumX += x * a;
      sumY += y * a;
      weightSum += a;
      if (a >= 64) opaqueCount++;

      const ptCell = findCellForPoint(x, y);
      cellMass[ptCell.cellIndex] += a;

      // 8-connected neighbors so thin diagonal whiskers/outlines stay connected
      const yStart = y > 0 ? y - 1 : y;
      const yEnd = y + 1 < height ? y + 1 : y;
      const xStart = x > 0 ? x - 1 : x;
      const xEnd = x + 1 < width ? x + 1 : x;

      for (let ny = yStart; ny <= yEnd; ny++) {
        const rowOff = ny * width;
        for (let nx = xStart; nx <= xEnd; nx++) {
          const nIdx = rowOff + nx;
          if (!visited[nIdx] && data[nIdx * 4 + 3] > 16) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    const pixelCount = tail;
    foregroundPixelCount += pixelCount;
    if (pixelCount < 4) {
      ignoredDustPixelCount += pixelCount;
      continue; // ignore 1-3px dust specks
    }
    retainedComponentCount++;
    retainedPixelCount += pixelCount;

    const cx = weightSum > 0 ? sumX / weightSum : (minX + maxX) / 2;
    const cy = weightSum > 0 ? sumY / weightSum : (minY + maxY) / 2;

    // Determine primary cell by maximum alpha mass (fallback to centroid)
    let primaryCellIdx = findCellForPoint(cx, cy).cellIndex;
    let maxMass = -1;
    for (let cIdx = 0; cIdx < cellMass.length; cIdx++) {
      if (cellMass[cIdx] > maxMass) {
        maxMass = cellMass[cIdx];
        primaryCellIdx = cIdx;
      }
    }

    // Check if this single connected component spans significantly across multiple cells
    // (indicating two neighboring stickers overlap/touch with no gap between them)
    const significantCells = [];
    for (let cIdx = 0; cIdx < cellMass.length; cIdx++) {
      const ratio = weightSum > 0 ? cellMass[cIdx] / weightSum : 0;
      const cellAreaPixels = pixelCount * ratio;
      // If a neighboring cell holds > 18% of the component's mass AND > 450 pixels
      // (or spans > 1.35x of a single cell's width/height), it's a genuine cross-cell collision!
      if (
        cIdx !== primaryCellIdx &&
        ((ratio > 0.18 && cellAreaPixels > 450) ||
          maxX - minX > nominalColW * 1.28 ||
          maxY - minY > nominalRowH * 1.28) &&
        ratio > 0.08
      ) {
        significantCells.push(cIdx);
      }
    }

    const primaryCell = cells[primaryCellIdx];
    const crossesNominalBounds =
      minX < primaryCell.nominalBounds.left ||
      maxX > primaryCell.nominalBounds.right ||
      minY < primaryCell.nominalBounds.top ||
      maxY > primaryCell.nominalBounds.bottom;

    // Copy pixel indices ONLY if this component overhangs its cell's nominal bounds
    // so we can render it cleanly without including neighboring cells' pixels!
    const overhangingPixels = crossesNominalBounds ? Int32Array.from(queue.subarray(0, tail)) : null;

    const compInfo = {
      pixelCount,
      opaqueCount,
      minX,
      minY,
      maxX,
      maxY,
      cx,
      cy,
      crossesNominalBounds,
      overhangingPixels,
      significantCells,
    };

    primaryCell.components.push(compInfo);
    primaryCell.pixelCount += pixelCount;
    primaryCell.opaquePixelCount += opaqueCount;
    if (minX < primaryCell.minX) primaryCell.minX = minX;
    if (minY < primaryCell.minY) primaryCell.minY = minY;
    if (maxX > primaryCell.maxX) primaryCell.maxX = maxX;
    if (maxY > primaryCell.maxY) primaryCell.maxY = maxY;

    if (significantCells.length > 0) {
      for (const otherIdx of significantCells) {
        const otherCell = cells[otherIdx];
        primaryCell.overlappingCells.add(otherCell.index);
        otherCell.overlappingCells.add(primaryCell.index);
        // If the other cell ended up empty because its character merged into this component,
        // share the component reference so the user can review both cells without hard-cutting
        if (otherCell.components.length === 0) {
          otherCell.components.push(compInfo);
          otherCell.pixelCount += pixelCount;
          otherCell.opaquePixelCount += opaqueCount;
          if (minX < otherCell.minX) otherCell.minX = minX;
          if (minY < otherCell.minY) otherCell.minY = minY;
          if (maxX > otherCell.maxX) otherCell.maxX = maxX;
          if (maxY > otherCell.maxY) otherCell.maxY = maxY;
        }
      }
    }
  }

  const componentOwners = new Map();
  for (const cell of cells) {
    for (const component of cell.components) {
      componentOwners.set(component, (componentOwners.get(component) || 0) + 1);
    }
  }
  const ownership = {
    alphaThreshold: 16,
    foregroundPixelCount,
    ignoredDustPixelCount,
    retainedPixelCount,
    retainedComponentCount,
    assignedComponentCount: componentOwners.size,
    sharedComponentCount: [...componentOwners.values()].filter(count => count !== 1).length,
    assignedPixelCount: cells.reduce((sum, cell) => sum + cell.pixelCount, 0),
  };
  return { cells, xCuts, yCuts, rowVerticalCuts, colHorizontalCuts, seamDiagnostics, ownership };
}

/**
 * Extract a single cell's sticker pixels (including any overhanging tail/hand components
 * that belong to this cell, while excluding pixels that belong to neighboring cells)
 * and render into a 512x512 RGBA PNG buffer.
 */
// sotaCellMattingV5_2_Fast & classifySubjectSemantic imported from ./v52-matting-core.mjs above.



async function renderCellStickerPng(data, sheetWidth, sheetHeight, cell, allCells, config) {
  const { outputSize, padding, allowUpscale, maxFileBytes } = config;
  const pad = clamp(Math.round(padding), 0, Math.floor(outputSize * 0.4));
  const innerSize = Math.max(16, outputSize - pad * 2);

  // Expand inclusion bounds by 2px around detected foreground components to capture subtle alpha=1..16 feathering
  const cropLeft = Math.max(0, cell.minX - 2);
  const cropTop = Math.max(0, cell.minY - 2);
  const cropRight = Math.min(sheetWidth - 1, cell.maxX + 2);
  const cropBottom = Math.min(sheetHeight - 1, cell.maxY + 2);
  const cropW = cropRight - cropLeft + 1;
  const cropH = cropBottom - cropTop + 1;

  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  let copiedForegroundPixelCount = 0;
  const { left: nomLeft, top: nomTop, right: nomRight, bottom: nomBottom } = cell.nominalBounds;

  // Build compact crop-local bitmask for overhanging component pixels (bit 1 = foreign, bit 2 = own)
  // Avoids JS Set which hits V8 RangeError (>16.7M entries) on 4K sheets if background removal is partial.
  let overhangMask = null;
  let hasForeignOverhang = false;
  for (let c = 0; c < allCells.length; c++) {
    const other = allCells[c];
    if (other.index === cell.index) continue;
    for (let k = 0; k < other.components.length; k++) {
      const comp = other.components[k];
      if (!comp.overhangingPixels) continue;
      // Check if bbox intersects our crop box
      if (
        comp.maxX >= cropLeft &&
        comp.minX <= cropRight &&
        comp.maxY >= cropTop &&
        comp.minY <= cropBottom &&
        !cell.components.includes(comp)
      ) {
        if (!overhangMask) overhangMask = new Uint8Array(cropW * cropH);
        hasForeignOverhang = true;
        const pxArr = comp.overhangingPixels;
        for (let p = 0; p < pxArr.length; p++) {
          const pIdx = pxArr[p];
          const px = pIdx % sheetWidth;
          if (px < cropLeft || px > cropRight) continue;
          const py = (pIdx - px) / sheetWidth;
          if (py < cropTop || py > cropBottom) continue;
          overhangMask[(py - cropTop) * cropW + (px - cropLeft)] |= 1;
        }
      }
    }
  }

  // Mark our own overhanging components (outside nominal cell bounds) in bit 2
  let hasOwnOverhang = false;
  for (let k = 0; k < cell.components.length; k++) {
    const comp = cell.components[k];
    if (comp.overhangingPixels) {
      if (!overhangMask) overhangMask = new Uint8Array(cropW * cropH);
      hasOwnOverhang = true;
      const pxArr = comp.overhangingPixels;
      for (let p = 0; p < pxArr.length; p++) {
        const pIdx = pxArr[p];
        const px = pIdx % sheetWidth;
        if (px < cropLeft || px > cropRight) continue;
        const py = (pIdx - px) / sheetWidth;
        if (py < cropTop || py > cropBottom) continue;
        overhangMask[(py - cropTop) * cropW + (px - cropLeft)] |= 2;
      }
    }
  }

  // Copy cell foreground pixels into cropBuf
  for (let y = cropTop; y <= cropBottom; y++) {
    const sheetRowOff = y * sheetWidth;
    const cy = y - cropTop;
    const cropRowOff = cy * cropW;
    const inNominalY = y >= nomTop && y <= nomBottom;

    for (let x = cropLeft; x <= cropRight; x++) {
      const pIdx = sheetRowOff + x;
      const sOff = pIdx * 4;
      const a = data[sOff + 3];
      if (a === 0) continue;

      const cx = x - cropLeft;
      const cIdx = cropRowOff + cx;
      if (hasForeignOverhang && (overhangMask[cIdx] & 1)) {
        continue;
      }

      const inNominal = inNominalY && x >= nomLeft && x <= nomRight;
      if (!inNominal) {
        // Outside nominal cell box: include if part of our own overhanging component or its 2px feathering halo
        let keep = false;
        if (hasOwnOverhang) {
          if (
            (overhangMask[cIdx] & 2) ||
            (cx > 0 && (overhangMask[cIdx - 1] & 2)) ||
            (cx + 1 < cropW && (overhangMask[cIdx + 1] & 2)) ||
            (cy > 0 && (overhangMask[cIdx - cropW] & 2)) ||
            (cy + 1 < cropH && (overhangMask[cIdx + cropW] & 2))
          ) {
            keep = true;
          }
        }
        if (!keep) continue;
      }

      const dOff = cIdx * 4;
      cropBuf[dOff] = data[sOff];
      cropBuf[dOff + 1] = data[sOff + 1];
      cropBuf[dOff + 2] = data[sOff + 2];
      cropBuf[dOff + 3] = a;
      if (a > 16) copiedForegroundPixelCount++;
    }
  }

  // Find tight bounding box of non-transparent content (alpha > 0) inside cropBuf
  let tightMinX = cropW;
  let tightMaxX = -1;
  let tightMinY = cropH;
  let tightMaxY = -1;
  for (let y = 0; y < cropH; y++) {
    const rowOff = y * cropW * 4;
    for (let x = 0; x < cropW; x++) {
      if (cropBuf[rowOff + x * 4 + 3] > 0) {
        if (x < tightMinX) tightMinX = x;
        if (x > tightMaxX) tightMaxX = x;
        if (y < tightMinY) tightMinY = y;
        if (y > tightMaxY) tightMaxY = y;
      }
    }
  }

  const hasTightContent = tightMaxX >= tightMinX && tightMaxY >= tightMinY;
  const contentW = hasTightContent ? tightMaxX - tightMinX + 1 : cropW;
  const contentH = hasTightContent ? tightMaxY - tightMinY + 1 : cropH;

  let activeBuf = cropBuf;
  let activeW = cropW;
  let activeH = cropH;

  if (hasTightContent && (contentW !== cropW || contentH !== cropH)) {
    const tightBuf = Buffer.alloc(contentW * contentH * 4);
    for (let y = 0; y < contentH; y++) {
      const srcRow = (tightMinY + y) * cropW * 4 + tightMinX * 4;
      const dstRow = y * contentW * 4;
      cropBuf.copy(tightBuf, dstRow, srcRow, srcRow + contentW * 4);
    }
    activeBuf = tightBuf;
    activeW = contentW;
    activeH = contentH;
  }

  // Compute scale factor respecting allowUpscale (upscaling until the larger side reaches innerSize)
  const rawScale = Math.min(innerSize / activeW, innerSize / activeH);
  const scale = allowUpscale ? rawScale : Math.min(1, rawScale);
  const targetW = Math.max(1, Math.min(innerSize, Math.round(activeW * scale)));
  const targetH = Math.max(1, Math.min(innerSize, Math.round(activeH * scale)));

  let resizedBuf = activeBuf;
  if (targetW !== activeW || targetH !== activeH) {
    resizedBuf = await sharp(activeBuf, {
      raw: { width: activeW, height: activeH, channels: 4 },
    })
      .resize(targetW, targetH, {
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .raw()
      .toBuffer();

    // Clean negligible Lanczos ringing alpha dust (< 10) after resampling
    for (let i = 0; i < resizedBuf.length; i += 4) {
      if (resizedBuf[i + 3] < 10) {
        resizedBuf[i] = 0;
        resizedBuf[i + 1] = 0;
        resizedBuf[i + 2] = 0;
        resizedBuf[i + 3] = 0;
      }
    }
  }

  // Composite centered onto outputSize x outputSize RGBA canvas
  const canvasBuf = Buffer.alloc(outputSize * outputSize * 4);
  const offsetX = Math.floor((outputSize - targetW) / 2);
  const offsetY = Math.floor((outputSize - targetH) / 2);

  for (let y = 0; y < targetH; y++) {
    const srcStart = y * targetW * 4;
    const dstStart = ((offsetY + y) * outputSize + offsetX) * 4;
    resizedBuf.copy(canvasBuf, dstStart, srcStart, srcStart + targetW * 4);
  }

  // Lossless PNG encoding first
  const rawImage = sharp(canvasBuf, {
    raw: { width: outputSize, height: outputSize, channels: 4 },
  });

  let pngBuffer = await rawImage
    .clone()
    .png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false })
    .toBuffer();

  if (pngBuffer.length > maxFileBytes) {
    // Second lossless attempt without adaptive filtering (better on flat cartoon fills)
    const altLossless = await rawImage
      .clone()
      .png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10, palette: false })
      .toBuffer();
    if (altLossless.length < pngBuffer.length) {
      pngBuffer = altLossless;
    }
  }

  return {
    pngBuffer,
    cropBounds: { left: cropLeft, top: cropTop, width: cropW, height: cropH },
    renderedSize: { width: targetW, height: targetH, scale },
    copiedForegroundPixelCount,
  };
}

/**
 * Render checkerboard preview contact sheet of all extracted stickers.
 */
async function renderCheckerboardPreview(stickerBuffers, columns, rows, tileSize = 256) {
  const gap = 16;
  const outerPad = 24;
  const previewW = outerPad * 2 + columns * tileSize + (columns - 1) * gap;
  const previewH = outerPad * 2 + rows * tileSize + (rows - 1) * gap;
  const checkerSize = 16;

  const bgBuf = Buffer.alloc(previewW * previewH * 4);
  // Fill subtle dark slate border around tiles and classic two-tone checkerboard inside each tile
  for (let y = 0; y < previewH; y++) {
    for (let x = 0; x < previewW; x++) {
      const off = (y * previewW + x) * 4;
      bgBuf[off] = 34;
      bgBuf[off + 1] = 36;
      bgBuf[off + 2] = 44;
      bgBuf[off + 3] = 255;
    }
  }

  const composites = [];
  for (let idx = 0; idx < columns * rows; idx++) {
    const r = Math.floor(idx / columns);
    const c = idx % columns;
    const tileX = outerPad + c * (tileSize + gap);
    const tileY = outerPad + r * (tileSize + gap);

    for (let y = 0; y < tileSize; y++) {
      const py = tileY + y;
      const cy = Math.floor(y / checkerSize);
      for (let x = 0; x < tileSize; x++) {
        const px = tileX + x;
        const cx = Math.floor(x / checkerSize);
        const isLight = (cx + cy) % 2 === 0;
        const shade = isLight ? 238 : 204;
        const off = (py * previewW + px) * 4;
        bgBuf[off] = shade;
        bgBuf[off + 1] = shade;
        bgBuf[off + 2] = shade;
        bgBuf[off + 3] = 255;
      }
    }

    const stickerBuf = stickerBuffers[idx];
    if (stickerBuf) {
      const thumb = await sharp(stickerBuf)
        .resize(tileSize, tileSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      composites.push({ input: thumb, left: tileX, top: tileY });
    }
  }

  return sharp(bgBuf, { raw: { width: previewW, height: previewH, channels: 4 } })
    .composite(composites)
    .png({ compressionLevel: 8 })
    .toBuffer();
}

/**
 * Render diagnostic debug images:
 * - debug/background-mask.png
 * - debug/alpha-mask.png
 * - debug/grid-overlay.png
 */
async function writeDebugArtifacts(
  outputDir,
  data,
  bgMask,
  width,
  height,
  segmentation,
  columns,
  rows
) {
  const totalPixels = width * height;

  // 1. background-mask.png (Black = exterior bg, Cyan = cleared interior hole, White = foreground)
  const bgVis = Buffer.alloc(totalPixels * 3);
  // 2. alpha-mask.png (Grayscale 0..255 continuous alpha)
  const alphaVis = Buffer.alloc(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const a = data[i * 4 + 3];
    alphaVis[i] = a;
    const vOff = i * 3;
    if (bgMask[i] === 1) {
      bgVis[vOff] = 16;
      bgVis[vOff + 1] = 18;
      bgVis[vOff + 2] = 24;
    } else if (bgMask[i] === 2) {
      bgVis[vOff] = 0;
      bgVis[vOff + 1] = 210;
      bgVis[vOff + 2] = 255;
    } else {
      bgVis[vOff] = 255;
      bgVis[vOff + 1] = 255;
      bgVis[vOff + 2] = 255;
    }
  }

  // 3. grid-overlay.png (Checkerboard + sticker sheet + nominal grid in yellow + adjusted seams in cyan + bbox in green/red)
  const overlayBuf = Buffer.alloc(totalPixels * 4);
  for (let y = 0; y < height; y++) {
    const cy = y >> 4;
    for (let x = 0; x < width; x++) {
      const cx = x >> 4;
      const checker = (cx + cy) & 1 ? 52 : 72;
      const idx = (y * width + x) * 4;
      const a = data[idx + 3] / 255;
      overlayBuf[idx] = Math.round(data[idx] * a + checker * (1 - a));
      overlayBuf[idx + 1] = Math.round(data[idx + 1] * a + checker * (1 - a));
      overlayBuf[idx + 2] = Math.round(data[idx + 2] * a + checker * (1 - a));
      overlayBuf[idx + 3] = 255;
    }
  }

  function plotPixel(x, y, r, g, b) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const off = (y * width + x) * 4;
    overlayBuf[off] = r;
    overlayBuf[off + 1] = g;
    overlayBuf[off + 2] = b;
    overlayBuf[off + 3] = 255;
  }

  function drawRect(x0, y0, x1, y1, r, g, b, thickness = 2) {
    for (let t = 0; t < thickness; t++) {
      for (let x = x0; x <= x1; x++) {
        plotPixel(x, y0 + t, r, g, b);
        plotPixel(x, y1 - t, r, g, b);
      }
      for (let y = y0; y <= y1; y++) {
        plotPixel(x0 + t, y, r, g, b);
        plotPixel(x1 - t, y, r, g, b);
      }
    }
  }

  // Nominal grid lines (dashed yellow)
  for (let c = 1; c < columns; c++) {
    const nx = Math.round((c * width) / columns);
    for (let y = 0; y < height; y++) {
      if ((y >> 3) & 1) {
        plotPixel(nx, y, 255, 215, 0);
        plotPixel(nx + 1, y, 255, 215, 0);
      }
    }
  }
  for (let r = 1; r < rows; r++) {
    const ny = Math.round((r * height) / rows);
    for (let x = 0; x < width; x++) {
      if ((x >> 3) & 1) {
        plotPixel(x, ny, 255, 215, 0);
        plotPixel(x, ny + 1, 255, 215, 0);
      }
    }
  }

  // Adjusted seam lines (solid cyan)
  for (let r = 0; r < rows; r++) {
    const y0 = segmentation.yCuts[r];
    const y1 = segmentation.yCuts[r + 1];
    const rCuts = segmentation.rowVerticalCuts[r];
    for (let c = 1; c < columns; c++) {
      const sx = rCuts[c];
      for (let y = y0; y < y1; y++) {
        plotPixel(sx, y, 0, 240, 255);
        plotPixel(sx + 1, y, 0, 240, 255);
      }
    }
  }
  for (let c = 0; c < columns; c++) {
    const x0 = segmentation.xCuts[c];
    const x1 = segmentation.xCuts[c + 1];
    const cCuts = segmentation.colHorizontalCuts ? segmentation.colHorizontalCuts[c] : segmentation.yCuts;
    for (let r = 1; r < rows; r++) {
      const sy = cCuts[r];
      for (let x = x0; x < x1; x++) {
        plotPixel(x, sy, 0, 240, 255);
        plotPixel(x, sy + 1, 0, 240, 255);
      }
    }
  }

  // Per-cell detected bounding boxes (green = clean, orange/red = warning/overlap)
  for (const cell of segmentation.cells) {
    if (cell.maxX >= cell.minX && cell.maxY >= cell.minY) {
      const hasIssues = cell.overlappingCells.size > 0 || cell.warnings.length > 0;
      const color = hasIssues ? [255, 92, 64] : [46, 230, 122];
      drawRect(cell.minX, cell.minY, cell.maxX, cell.maxY, color[0], color[1], color[2], 2);
    }
  }

  const [bgPng, alphaPng, gridPng] = await Promise.all([
    sharp(bgVis, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 8 }).toBuffer(),
    sharp(alphaVis, { raw: { width, height, channels: 1 } }).png({ compressionLevel: 8 }).toBuffer(),
    sharp(overlayBuf, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 8 }).toBuffer(),
  ]);

  await Promise.all([
    writeFileAtomic(outputDir, path.join(outputDir, 'debug', 'background-mask.png'), bgPng),
    writeFileAtomic(outputDir, path.join(outputDir, 'debug', 'alpha-mask.png'), alphaPng),
    writeFileAtomic(outputDir, path.join(outputDir, 'debug', 'grid-overlay.png'), gridPng),
  ]);
}

/**
 * Clean stale files in output subdirectories to ensure idempotent repeated runs.
 */
async function cleanStaleOutputs(
  outputDir,
  expectedCount,
  debugEnabled,
  exportTransparentSheet = true,
  exportPreview = true
) {
  const stickersDir = assertPathInsideDir(outputDir, path.join(outputDir, 'stickers'));
  if (existsSync(stickersDir)) {
    const entries = await fs.readdir(stickersDir);
    const validNames = new Set(
      Array.from({ length: expectedCount }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`)
    );
    for (const entry of entries) {
      if (!validNames.has(entry) || entry.endsWith('.tmp')) {
        const target = assertPathInsideDir(outputDir, path.join(stickersDir, entry));
        await fs.rm(target, { force: true });
      }
    }
  }

  const debugDir = assertPathInsideDir(outputDir, path.join(outputDir, 'debug'));
  if (!debugEnabled && existsSync(debugDir)) {
    await fs.rm(debugDir, { recursive: true, force: true });
  }

  if (!exportTransparentSheet) {
    const sheetPath = assertPathInsideDir(outputDir, path.join(outputDir, 'sheet-transparent.png'));
    if (existsSync(sheetPath)) {
      await fs.rm(sheetPath, { force: true });
    }
  }

  if (!exportPreview) {
    const previewPath = assertPathInsideDir(outputDir, path.join(outputDir, 'preview.png'));
    if (existsSync(previewPath)) {
      await fs.rm(previewPath, { force: true });
    }
  }
}

/**
 * Main sticker sheet processing function.
 *
 * @param {object} rawOptions - Configuration options.
 * @returns {Promise<object>} Processing manifest & diagnostics.
 */
export async function processStickerSheet(rawOptions = {}) {
  const startedAt = performance.now();
  const timingsMs = {
    decode: 0,
    keying: 0,
    segmentation: 0,
    export: 0,
    total: 0,
  };

  if (!rawOptions || typeof rawOptions !== 'object') {
    throw new Error('Конфигурация должна быть объектом.');
  }

  const config = { ...DEFAULT_OPTIONS, ...rawOptions };
  const warnings = [];
  const errors = [];
  const advisories = [];

  // Validate layout
  const layoutSpec = SUPPORTED_LAYOUTS[config.layout];
  if (!layoutSpec) {
    throw new Error(
      `Неподдерживаемая сетка layout="${config.layout}". Допустимые значения: "3x3", "3x4".`
    );
  }
  const { columns, rows, expectedCount } = layoutSpec;

  // Validate paths
  if (typeof config.inputPath !== 'string' || !config.inputPath.trim() || config.inputPath.includes('\0')) {
    throw new Error('Параметр inputPath обязателен и должен быть корректным путём к файлу.');
  }
  if (typeof config.outputDir !== 'string' || !config.outputDir.trim() || config.outputDir.includes('\0')) {
    throw new Error('Параметр outputDir обязателен и должен быть корректным путём к каталогу.');
  }

  const resolvedInput = path.resolve(config.inputPath);
  const resolvedOutputDir = path.resolve(config.outputDir);

  if (resolvedInput === resolvedOutputDir) {
    throw new Error('Путь inputPath и каталог outputDir не могут совпадать.');
  }
  const relInToOut = path.relative(resolvedOutputDir, resolvedInput);
  if (!relInToOut.startsWith('..') && !path.isAbsolute(relInToOut)) {
    throw new Error(
      'Исходный файл inputPath не должен находиться внутри перезаписываемых артефактов outputDir.'
    );
  }

  const targetColor = config.nativeAlphaOnly ? null : parseHexColor(config.backgroundColor);
  const outputSize = Math.round(Number(config.outputSize) || 512);
  const padding = Math.round(Number(config.padding) ?? 24);
  if (outputSize < 64 || outputSize > 2048) {
    throw new Error(`Некорректный outputSize=${outputSize} (допустимо 64..2048).`);
  }
  if (padding < 0 || padding >= outputSize / 2) {
    throw new Error(`Некорректный padding=${padding} для холста ${outputSize}x${outputSize}.`);
  }

  await fs.mkdir(resolvedOutputDir, { recursive: true });

  // Helper to build and write failure manifest when decoding/validation fails
  async function finalizeFailedResult(errorMessage, failureReason) {
    errors.push(errorMessage);
    timingsMs.total = Math.round(performance.now() - startedAt);
    const failedManifest = {
      version: Number(config.version) || 1,
      status: 'failed',
      ...(failureReason ? { failureReason } : {}),
      layout: config.layout,
      expectedCount,
      readyCount: 0,
      transparentSheetPath: null,
      previewPath: null,
      stickers: Array.from({ length: expectedCount }, (_, idx) => ({
        index: idx + 1,
        row: Math.floor(idx / columns),
        column: idx % columns,
        status: 'failed',
        path: null,
        width: outputSize,
        height: outputSize,
        bytes: 0,
        warnings: [],
      })),
      warnings,
      errors,
      advisories,
      timingsMs,
    };
    await writeFileAtomic(
      resolvedOutputDir,
      path.join(resolvedOutputDir, 'manifest.json'),
      Buffer.from(JSON.stringify(failedManifest, null, 2) + '\n', 'utf8')
    );
    return failedManifest;
  }

  // 1. Check file existence and byte size limits
  let inputStat;
  try {
    inputStat = await fs.stat(resolvedInput);
  } catch {
    return finalizeFailedResult(`Входной файл не найден или недоступен: "${config.inputPath}".`);
  }
  if (!inputStat.isFile()) {
    return finalizeFailedResult(`Путь inputPath не является обычным файлом: "${config.inputPath}".`);
  }
  if (inputStat.size === 0) {
    return finalizeFailedResult('Входной файл пуст (0 байт).');
  }
  if (inputStat.size > config.maxInputBytes) {
    return finalizeFailedResult(
      `Размер входного файла (${inputStat.size} байт) превышает лимит (${config.maxInputBytes} байт).`
    );
  }

  // 2. Decode metadata and raw RGBA pixels via Sharp with strict pixel limits
  const decodeStart = performance.now();
  let width = 0;
  let height = 0;
  let format = '';
  let rawData;

  try {
    const decoder = sharp(resolvedInput, {
      limitInputPixels: config.maxPixels,
      failOn: 'error',
    });
    const meta = await decoder.metadata();
    format = (meta.format || '').toLowerCase();
    width = meta.width || 0;
    height = meta.height || 0;

    if (!['png', 'jpeg', 'jpg', 'webp'].includes(format)) {
      return finalizeFailedResult(
        `Неподдерживаемый формат изображения "${format || 'unknown'}". Поддерживаются PNG, JPEG, WebP.`
      );
    }
    if (width < columns * 32 || height < rows * 32) {
      return finalizeFailedResult(
        `Разрешение листа (${width}x${height}) слишком мало для сетки ${config.layout}.`
      );
    }
    if (width * height > config.maxPixels) {
      return finalizeFailedResult(
        `Число пикселей изображения (${width}x${height} = ${width * height}) превышает лимит (${config.maxPixels}).`
      );
    }

    const decoded = await decoder.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    rawData = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
    if (config.nativeAlphaOnly) {
      const metrics = inspectNativeSheetAlpha(rawData, width, height, rows, decoded.info.channels, format === 'png' && meta.hasAlpha);
      if (!metrics.accepted) {
        if (metrics.transparentPixels >= metrics.totalPixels * 0.1) {
          return finalizeFailedResult('На листе не удалось выделить отдельного героя для каждой ячейки.', 'unusable_layout');
        }
        return finalizeFailedResult('Для этого набора требуется PNG с прозрачным фоном.', 'unusable_background');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finalizeFailedResult(`Ошибка декодирования изображения: ${msg}`);
  }
  timingsMs.decode = Math.round(performance.now() - decodeStart);

  // 3. Allocate shared single-pass working buffers
  const totalPixels = width * height;
  const sharedBuffers = {
    bgMask: new Uint8Array(totalPixels),
    visited: new Uint8Array(totalPixels),
    queue: new Int32Array(totalPixels),
  };

  // 4. Calibrate background and perform topology-aware chroma-key removal
  const keyingStart = performance.now();
  const calibration = config.nativeAlphaOnly ? { nativeAlphaSheet: true } : calibrateSheetBackground(
    rawData,
    width,
    height,
    targetColor,
    config.tolerance,
    columns,
    rows
  );

  if (!calibration.nativeAlphaSheet && calibration.matchedRatio < 0.08) {
    warnings.push(
      `Периметр листа слабо совпадает с заданным фоном ${targetColor.hex} (совпадение ${(calibration.matchedRatio * 100).toFixed(1)}%). Возможно, указан неверный backgroundColor или персонажи перекрывают границы.`
    );
  }

  const isNeutralBg = Math.max(calibration.bgR, calibration.bgG, calibration.bgB) - Math.min(calibration.bgR, calibration.bgG, calibration.bgB) < 35;

  if (calibration.nativeAlphaSheet) {
    // Preserve original color and opacity, including green eyes, fabric and edge pixels.
    for (let i = 0; i < totalPixels; i++) {
      if (rawData[i * 4 + 3] <= 12) sharedBuffers.bgMask[i] = 1;
    }
  } else if (isNeutralBg) {
    // SOTA v5.2-FAST Cell-level Matting for neutral backgrounds (#7A828C etc.)
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
          cellRgba.set(rawData.subarray(srcOff, srcOff + cw * 4), dstOff);
        }

        const matted = sotaCellMattingV5_2_Fast(cellRgba, cw, ch);
        const gutter = 3;
        for (let y = 0; y < ch; y++) {
          const isYBorder = y < gutter || y >= ch - gutter;
          const srcOff = y * cw * 4;
          const dstOff = ((top + y) * width + left) * 4;
          const rowStartIdx = (top + y) * width + left;
          for (let x = 0; x < cw; x++) {
            const off = srcOff + x * 4;
            if (isYBorder || x < gutter || x >= cw - gutter) {
              matted[off] = 0; matted[off + 1] = 0; matted[off + 2] = 0; matted[off + 3] = 0;
            }
            if (matted[off + 3] <= 12) {
              sharedBuffers.bgMask[rowStartIdx + x] = 1;
            }
          }
          rawData.set(matted.subarray(srcOff, srcOff + cw * 4), dstOff);
        }
      }
    }
  } else {
    const keyingResult = removeChromaBackground(rawData, width, height, { ...config, columns, rows }, calibration, sharedBuffers);
    warnings.push(...keyingResult.warnings);
  }
  timingsMs.keying = Math.round(performance.now() - keyingStart);

  // Check if nearly the entire image was wiped out (e.g. character color == background color)
  let totalOpaqueAfterKeying = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (rawData[i * 4 + 3] >= 64) totalOpaqueAfterKeying++;
  }
  if (totalOpaqueAfterKeying < totalPixels * 0.005) {
    return finalizeFailedResult(
      'После удаления фона практически не осталось непрозрачных пикселей: цвет персонажей совпадает с фоном или лист пуст.'
    );
  }

  // 5. Segment cells, find optimal grid seams, and group sticker components
  const segStart = performance.now();
  const segmentation = segmentCellsAndComponents(
    rawData,
    width,
    height,
    { ...config, columns, rows },
    sharedBuffers
  );

  const seamWarnings = [];
  for (const xSeam of segmentation.seamDiagnostics.xSeams) {
    if (!xSeam.hasCleanGap) {
      seamWarnings.push({
        axis: 'x', index: xSeam.index, position: xSeam.actual, minOpaqueCount: xSeam.minOpaqueCount,
        message: `Вертикальная граница #${xSeam.index} (x=${xSeam.actual}) не имеет сквозного прозрачного промежутка (мин. плотность ${xSeam.minOpaqueCount} px).`,
      });
    }
  }
  for (const ySeam of segmentation.seamDiagnostics.ySeams) {
    if (!ySeam.hasCleanGap) {
      seamWarnings.push({
        axis: 'y', index: ySeam.index, position: ySeam.actual, minOpaqueCount: ySeam.minOpaqueCount,
        message: `Горизонтальная граница #${ySeam.index} (y=${ySeam.actual}) не имеет сквозного прозрачного промежутка (мин. плотность ${ySeam.minOpaqueCount} px).`,
      });
    }
  }
  timingsMs.segmentation = Math.round(performance.now() - segStart);

  // 6. Export stickers, full transparent sheet, preview, and optional debug overlays
  const exportStart = performance.now();
  const shouldExportTransparentSheet =
    config.exportTransparentSheet !== undefined ? Boolean(config.exportTransparentSheet) : true;
  const shouldExportPreview =
    config.exportPreview !== undefined ? Boolean(config.exportPreview) : true;

  await cleanStaleOutputs(
    resolvedOutputDir,
    expectedCount,
    Boolean(config.debug),
    shouldExportTransparentSheet,
    shouldExportPreview
  );

  const stickerManifestItems = [];
  const previewStickerBuffers = new Array(expectedCount).fill(null);
  let readyCount = 0;
  let hasEmptyOrFailedCell = false;
  let hasReviewCell = false;
  const renderedCellPixelCounts = [];

  for (let idx = 0; idx < expectedCount; idx++) {
    const cell = segmentation.cells[idx];
    const cellWarnings = [...cell.warnings];
    const relPath = `stickers/${String(cell.index).padStart(2, '0')}.png`;

    // Check 1: Empty cell
    if (cell.opaquePixelCount < config.minStickerPixels || cell.maxX < cell.minX) {
      const msg = `Ячейка #${cell.index} (строка ${cell.row}, столбец ${cell.column}) пуста или содержит недостаточно непрозрачных пикселей (${cell.opaquePixelCount}).`;
      cellWarnings.push(msg);
      errors.push(msg);
      hasEmptyOrFailedCell = true;
      stickerManifestItems.push({
        index: cell.index,
        row: cell.row,
        column: cell.column,
        status: 'failed',
        path: null,
        width: outputSize,
        height: outputSize,
        bytes: 0,
        warnings: cellWarnings,
      });
      continue;
    }

    // Check 2: Overlapping neighboring stickers
    if (cell.overlappingCells.size > 0) {
      const neighbors = Array.from(cell.overlappingCells).sort((a, b) => a - b).join(', ');
      cellWarnings.push(
        `Персонаж в ячейке #${cell.index} пересекается или сливается с соседней ячейкой (#${neighbors}); жёсткая обрезка по сетке отключена, требуется проверка.`
      );
    }

    // Check 3: Sticker touches outer border of the sheet (clipped by generator)
    if (
      cell.minX <= 1 ||
      cell.minY <= 1 ||
      cell.maxX >= width - 2 ||
      cell.maxY >= height - 2
    ) {
      cellWarnings.push(
        `Стикер #${cell.index} вплотную касается внешней границы листа (${cell.minX},${cell.minY})-(${cell.maxX},${cell.maxY}); край мог быть обрезан при генерации.`
      );
    }

    if (!calibration.nativeAlphaSheet && !isNeutralBg) {
      let nearBgOpaquePixels = 0;
      const { bgR, bgG, bgB } = calibration;
      const simTolSq = (config.tolerance * 1.25) ** 2;
      for (let y = cell.minY; y <= cell.maxY; y += 2) {
        for (let x = cell.minX; x <= cell.maxX; x += 2) {
          const off = (y * width + x) * 4;
          if (rawData[off + 3] >= 128) {
            const dr = rawData[off] - bgR;
            const dg = rawData[off + 1] - bgG;
            const db = rawData[off + 2] - bgB;
            if (dr * dr + dg * dg + db * db <= simTolSq) nearBgOpaquePixels++;
          }
        }
      }
      if (nearBgOpaquePixels / Math.max(1, Math.ceil(cell.opaquePixelCount / 4)) > 0.35) {
        cellWarnings.push(`Цвет персонажа в ячейке #${cell.index} близко совпадает с фоном; требуется визуальная проверка контура и деталей.`);
      }
    }

    // Render 512x512 RGBA PNG
    const rendered = await renderCellStickerPng(rawData, width, height, cell, segmentation.cells, {
      outputSize,
      padding,
      allowUpscale: Boolean(config.allowUpscale),
      maxFileBytes: config.maxFileBytes,
    });
    renderedCellPixelCounts.push({
      index: cell.index,
      expected: cell.pixelCount,
      copied: rendered.copiedForegroundPixelCount,
    });

    if (rendered.pngBuffer.length > config.maxFileBytes) {
      const sizeMsg = `Размер файла стикера #${cell.index} (${rendered.pngBuffer.length} байт) превышает лимит Telegram (${config.maxFileBytes} байт).`;
      cellWarnings.push(sizeMsg);
      errors.push(sizeMsg);
      hasEmptyOrFailedCell = true;
    }

    const absStickerPath = path.join(resolvedOutputDir, 'stickers', `${String(cell.index).padStart(2, '0')}.png`);
    await writeFileAtomic(resolvedOutputDir, absStickerPath, rendered.pngBuffer);
    previewStickerBuffers[idx] = rendered.pngBuffer;

    const cellStatus =
      rendered.pngBuffer.length > config.maxFileBytes
        ? 'failed'
        : cellWarnings.length > 0
          ? 'needs_review'
          : 'ready';

    if (cellStatus === 'ready') {
      readyCount++;
    } else if (cellStatus === 'needs_review') {
      hasReviewCell = true;
      warnings.push(...cellWarnings);
    }

    stickerManifestItems.push({
      index: cell.index,
      row: cell.row,
      column: cell.column,
      status: cellStatus,
      path: relPath,
      width: outputSize,
      height: outputSize,
      bytes: rendered.pngBuffer.length,
      warnings: cellWarnings,
    });
  }

  // Write full sheet after background removal (sheet-transparent.png) and checkerboard preview (preview.png) if requested
  const exportPromises = [];
  if (shouldExportTransparentSheet) {
    exportPromises.push(
      sharp(rawData, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 8 })
        .toBuffer()
        .then((transparentSheetBuf) =>
          writeFileAtomic(
            resolvedOutputDir,
            path.join(resolvedOutputDir, 'sheet-transparent.png'),
            transparentSheetBuf
          )
        )
    );
  }

  if (shouldExportPreview) {
    exportPromises.push(
      renderCheckerboardPreview(previewStickerBuffers, columns, rows, 256).then((previewBuf) =>
        writeFileAtomic(
          resolvedOutputDir,
          path.join(resolvedOutputDir, 'preview.png'),
          previewBuf
        )
      )
    );
  }

  if (exportPromises.length > 0) {
    await Promise.all(exportPromises);
  }

  if (config.debug) {
    await writeDebugArtifacts(
      resolvedOutputDir,
      rawData,
      sharedBuffers.bgMask,
      width,
      height,
      segmentation,
      columns,
      rows
    );
  }

  timingsMs.export = Math.round(performance.now() - exportStart);
  timingsMs.total = Math.round(performance.now() - startedAt);

  // Grid lines guide component ownership; they never crop a character. A straight
  // transparent gutter may not exist when separate hands/props shift between rows.
  // Treat only that geometric diagnostic as advisory after proving unique ownership
  // and that the renderer copied every retained foreground pixel exactly once.
  // All cell-level collision, clipping, key-color and export checks stay blocking.
  const componentOwnership = {
    ...segmentation.ownership,
    renderedCellPixelCounts,
    complete: segmentation.ownership.sharedComponentCount === 0
      && segmentation.ownership.assignedComponentCount === segmentation.ownership.retainedComponentCount
      && segmentation.ownership.assignedPixelCount === segmentation.ownership.retainedPixelCount
      && segmentation.ownership.foregroundPixelCount === segmentation.ownership.retainedPixelCount + segmentation.ownership.ignoredDustPixelCount
      && renderedCellPixelCounts.length === expectedCount
      && renderedCellPixelCounts.every(cell => cell.copied === cell.expected),
  };
  const componentSafeSeams = componentOwnership.complete
    && readyCount === expectedCount && !hasEmptyOrFailedCell && !hasReviewCell && errors.length === 0;
  for (const seam of seamWarnings) {
    if (componentSafeSeams) {
      advisories.push({ code: 'component-preserving-grid-seam', ...seam });
    } else {
      warnings.push(seam.message);
    }
  }

  // Deduplicate top-level warnings
  const uniqueWarnings = Array.from(new Set(warnings));
  const uniqueErrors = Array.from(new Set(errors));

  let overallStatus = 'ready';
  if (hasEmptyOrFailedCell || uniqueErrors.length > 0) {
    overallStatus = 'failed';
  } else if (hasReviewCell || (config.strict && uniqueWarnings.length > 0)) {
    overallStatus = 'needs_review';
  }

  const manifest = {
    version: Number(config.version) || 1,
    status: overallStatus,
    layout: config.layout,
    expectedCount,
    readyCount,
    transparentSheetPath: shouldExportTransparentSheet ? 'sheet-transparent.png' : null,
    previewPath: shouldExportPreview ? 'preview.png' : null,
    stickers: stickerManifestItems,
    warnings: uniqueWarnings,
    errors: uniqueErrors,
    advisories,
    diagnostics: { componentOwnership, seams: segmentation.seamDiagnostics },
    timingsMs,
  };

  // Write manifest.json last (atomic publication)
  await writeFileAtomic(
    resolvedOutputDir,
    path.join(resolvedOutputDir, 'manifest.json'),
    Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  );

  return manifest;
}

export default processStickerSheet;
