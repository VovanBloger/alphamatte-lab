/// <reference lib="webworker" />
import { sotaCellMattingV5_2_Fast } from '../../sheet-processor/v52-matting-core.mjs';
import { sotaCellMattingV5_3_Turbo } from '../../sheet-processor/v53-matting.mjs';

interface WorkerRequest {
  jobId: number;
  mode?: 'compare' | 'video_frame';
  rgbaBuffer: ArrayBuffer;
  width: number;
  height: number;
  resetTemporal?: boolean;
  photoVignetteMode?: boolean;
}

let prevFrameRgb: Uint8ClampedArray | null = null;
let prevFrameAlpha: Uint8Array | null = null;
let prevW = 0;
let prevH = 0;

function countGrayHalo(rgba: Uint8ClampedArray): number {
  const totalPx = rgba.length >> 2;
  let grayHalo = 0;
  for (let i = 0; i < totalPx; i++) {
    const off = i << 2;
    const a = rgba[off + 3];
    if (a >= 15 && a <= 235) {
      const r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat < 14 && Math.abs(l - 128) < 18) grayHalo++;
    }
  }
  return grayHalo;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { jobId, mode = 'compare', rgbaBuffer, width, height, resetTemporal, photoVignetteMode } = e.data;
  try {
    const src = new Uint8ClampedArray(rgbaBuffer);

    if (mode === 'video_frame') {
      const totalPx = width * height;
      if (resetTemporal || !prevFrameRgb || !prevFrameAlpha || prevW !== width || prevH !== height) {
        prevFrameRgb = new Uint8ClampedArray(totalPx * 3);
        prevFrameAlpha = new Uint8Array(totalPx);
        prevW = width;
        prevH = height;
        resetTemporal && prevFrameAlpha.fill(0);
      }

      const t0 = performance.now();
      const origCopy = new Uint8ClampedArray(src);
      const out53: Uint8ClampedArray = sotaCellMattingV5_3_Turbo(src, width, height, {
        qualityEnhancements: true,
        photoVignetteMode: Boolean(photoVignetteMode),
        inPlace: true,
      });

      if (!resetTemporal) {
        for (let i = 0; i < totalPx; i++) {
          const off = i << 2;
          const off3 = i * 3;
          const r = origCopy[off], g = origCopy[off + 1], b = origCopy[off + 2];
          const dr = Math.abs(r - prevFrameRgb[off3]);
          const dg = Math.abs(g - prevFrameRgb[off3 + 1]);
          const db = Math.abs(b - prevFrameRgb[off3 + 2]);
          const motion = dr + dg + db;
          const curA = out53[off + 3];
          if (motion < 20) {
            const pA = prevFrameAlpha[i];
            const blended = ((curA * 195 + pA * 61 + 128) >> 8);
            out53[off + 3] = blended < 4 ? 0 : blended;
          }
          prevFrameRgb[off3] = r;
          prevFrameRgb[off3 + 1] = g;
          prevFrameRgb[off3 + 2] = b;
          prevFrameAlpha[i] = out53[off + 3];
        }
      } else {
        for (let i = 0; i < totalPx; i++) {
          const off = i << 2;
          const off3 = i * 3;
          prevFrameRgb[off3] = origCopy[off];
          prevFrameRgb[off3 + 1] = origCopy[off + 1];
          prevFrameRgb[off3 + 2] = origCopy[off + 2];
          prevFrameAlpha[i] = out53[off + 3];
        }
      }

      const frameMs = Number((performance.now() - t0).toFixed(1));
      self.postMessage(
        {
          jobId,
          ok: true,
          mode: 'video_frame',
          width,
          height,
          frameMs,
          mattedBuffer: out53.buffer,
        },
        [out53.buffer]
      );
      return;
    }

    const t0 = performance.now();
    const out52: Uint8ClampedArray = sotaCellMattingV5_2_Fast(src, width, height);
    const v52Ms = performance.now() - t0;

    const diag: {
      semantic?: { subjectType: 'human' | 'animal'; confidence: number };
      textureRecovery?: { extractedPatches: number; recoveredPixels: number };
    } = {};

    const t1 = performance.now();
    const out53: Uint8ClampedArray = sotaCellMattingV5_3_Turbo(src, width, height, {
      qualityEnhancements: true,
      diagnostics: diag,
    });
    const v53QualMs = performance.now() - t1;

    const totalPx = width * height;
    const alpha52Rgba = new Uint8ClampedArray(totalPx * 4);
    const alpha53Rgba = new Uint8ClampedArray(totalPx * 4);
    const diffRgba = new Uint8ClampedArray(totalPx * 4);

    let sumAbsA = 0;
    let diffPixels = 0;

    for (let p = 0; p < totalPx; p++) {
      const off = p << 2;
      const a52 = out52[off + 3];
      const a53 = out53[off + 3];

      alpha52Rgba[off] = a52;
      alpha52Rgba[off + 1] = a52;
      alpha52Rgba[off + 2] = a52;
      alpha52Rgba[off + 3] = 255;

      alpha53Rgba[off] = a53;
      alpha53Rgba[off + 1] = a53;
      alpha53Rgba[off + 2] = a53;
      alpha53Rgba[off + 3] = 255;

      const delta = a53 - a52;
      sumAbsA += Math.abs(delta);
      if (Math.abs(delta) > 3) {
        diffPixels++;
        const mag = Math.min(255, Math.abs(delta) * 4);
        if (delta > 0) {
          diffRgba[off] = 16;
          diffRgba[off + 1] = Math.min(255, 160 + (mag >> 1));
          diffRgba[off + 2] = 129;
          diffRgba[off + 3] = Math.max(90, mag);
        } else {
          diffRgba[off] = 244;
          diffRgba[off + 1] = 63;
          diffRgba[off + 2] = 94;
          diffRgba[off + 3] = Math.max(90, mag);
        }
      } else {
        const base = Math.round(a53 * 0.25);
        diffRgba[off] = base;
        diffRgba[off + 1] = base;
        diffRgba[off + 2] = base + 8;
        diffRgba[off + 3] = 255;
      }
    }

    const grayHaloV52 = countGrayHalo(out52);
    const grayHaloV53 = countGrayHalo(out53);
    const grayHaloReductionPct = Number(
      (((grayHaloV52 - grayHaloV53) / Math.max(1, grayHaloV52)) * 100).toFixed(1)
    );

    self.postMessage(
      {
        jobId,
        ok: true,
        width,
        height,
        v52Ms: Number(v52Ms.toFixed(1)),
        v53QualMs: Number(v53QualMs.toFixed(1)),
        qualDiffPixelsPct: Number(((diffPixels / totalPx) * 100).toFixed(2)),
        qualMaeAlpha: Number((sumAbsA / totalPx).toFixed(2)),
        grayHaloV52,
        grayHaloV53,
        grayHaloReductionPct,
        semanticClass: diag.semantic?.subjectType,
        semanticConfidence: diag.semantic?.confidence,
        textureRecoveredPixels: diag.textureRecovery?.recoveredPixels ?? 0,
        textureExtractedPatches: diag.textureRecovery?.extractedPatches ?? 0,
        v52Buffer: out52.buffer,
        v53Buffer: out53.buffer,
        alpha52Buffer: alpha52Rgba.buffer,
        alpha53Buffer: alpha53Rgba.buffer,
        diffBuffer: diffRgba.buffer,
      },
      [
        out52.buffer,
        out53.buffer,
        alpha52Rgba.buffer,
        alpha53Rgba.buffer,
        diffRgba.buffer,
      ]
    );
  } catch (err) {
    self.postMessage({
      jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
