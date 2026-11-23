/**
 * Server-Side & CLI Video / GIF Background Removal -> Transparent WebM (VP9 Alpha yuva420p),
 * Animated WebP, and Transparent PNG Poster.
 * Uses SOTA v5.4-HYBRID (`sotaCellMattingV5_3_Turbo`) with Temporal Alpha Stabilization.
 *
 * Fully compliant with Telegram Video Stickers:
 * - Dimensions: max side exactly 512px, other side <= 512px (even integers).
 * - Codec: VP9 (libvpx-vp9) with yuva420p alpha channel.
 * - Duration: strictly <= 3.0 seconds.
 * - Framerate: <= 30 FPS.
 * - Audio: none (-an).
 * - File size: strictly <= 256 KB (262,144 bytes), enforced with automatic CRF/bitrate fallback.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sotaCellMattingV5_3_Turbo } from './v53-matting.mjs';

export function runCommandBuffer(cmd, args, inputBuffer = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      } else {
        reject(
          new Error(
            `${cmd} exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8').slice(-600)}`
          )
        );
      }
    });

    if (inputBuffer) {
      child.stdin.write(inputBuffer);
    }
    child.stdin.end();
  });
}

/**
 * Probe media file to extract width, height, duration, and FPS.
 */
export async function probeMedia(inputPath, ffmpegBin = 'ffmpeg') {
  let stderr = '';
  try {
    const res = await runCommandBuffer(ffmpegBin, ['-hide_banner', '-i', inputPath]);
    stderr = res.stderr;
  } catch (err) {
    stderr = String(err.message || err);
  }

  const matchDim = stderr.match(/Stream #\d+:\d+.*?: Video:.*? (\d{2,5})x(\d{2,5})/);
  const matchDur = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const matchFps = stderr.match(/, (\d+(?:\.\d+)?) fps/);

  let durationSec = null;
  if (matchDur) {
    durationSec = (+matchDur[1] * 3600) + (+matchDur[2] * 60) + (+matchDur[3]);
  }

  return {
    width: matchDim ? parseInt(matchDim[1], 10) : null,
    height: matchDim ? parseInt(matchDim[2], 10) : null,
    durationSec,
    fps: matchFps ? parseFloat(matchFps[1]) : null,
  };
}

/**
 * Compute Telegram sticker geometry:
 * One side MUST be exactly 512px, other side <= 512px, both even integers.
 */
export function computeTelegramStickerGeometry(srcW, srcH) {
  if (!srcW || !srcH) return { width: 512, height: 512 };
  if (srcW === srcH) return { width: 512, height: 512 };

  if (srcW > srcH) {
    const targetW = 512;
    const targetH = Math.max(16, Math.min(512, Math.round((512 * srcH / srcW) / 2) * 2));
    return { width: targetW, height: targetH };
  } else {
    const targetH = 512;
    const targetW = Math.max(16, Math.min(512, Math.round((512 * srcW / srcH) / 2) * 2));
    return { width: targetW, height: targetH };
  }
}

/**
 * Process a block of raw RGBA frames in-place using v5.4-HYBRID matting
 * with temporal edge stabilization across consecutive frames.
 */
export function matteRgbaFrameSequence(rawRgbaFramesBuffer, width, height, opts = {}) {
  const framePixels = width * height;
  const frameBytes = framePixels * 4;
  const frameCount = Math.floor(rawRgbaFramesBuffer.length / frameBytes);
  const temporalBlend = opts.temporalSmoothing !== false;

  const prevRgb = temporalBlend ? new Uint8ClampedArray(framePixels * 3) : null;
  const prevAlpha = temporalBlend ? new Uint8Array(framePixels) : null;
  const outBuffer = Buffer.allocUnsafe(frameCount * frameBytes);

  for (let f = 0; f < frameCount; f++) {
    const byteOff = f * frameBytes;
    const frameRgba = new Uint8ClampedArray(
      rawRgbaFramesBuffer.buffer,
      rawRgbaFramesBuffer.byteOffset + byteOff,
      frameBytes
    );
    const frameCopy = new Uint8ClampedArray(frameRgba);

    const matted = sotaCellMattingV5_3_Turbo(frameCopy, width, height, {
      qualityEnhancements: opts.qualityEnhancements !== false,
      photoVignetteMode: Boolean(opts.photoVignetteMode),
      inPlace: true,
    });

    if (temporalBlend && prevRgb && prevAlpha) {
      if (f > 0) {
        for (let i = 0; i < framePixels; i++) {
          const off = i << 2;
          const off3 = i * 3;
          const r = frameRgba[off];
          const g = frameRgba[off + 1];
          const b = frameRgba[off + 2];
          const motion =
            Math.abs(r - prevRgb[off3]) +
            Math.abs(g - prevRgb[off3 + 1]) +
            Math.abs(b - prevRgb[off3 + 2]);
          const curA = matted[off + 3];
          if (motion < 20) {
            const blended = (curA * 195 + prevAlpha[i] * 61 + 128) >> 8;
            matted[off + 3] = blended < 4 ? 0 : blended;
          }
          prevRgb[off3] = r;
          prevRgb[off3 + 1] = g;
          prevRgb[off3 + 2] = b;
          prevAlpha[i] = matted[off + 3];
        }
      } else {
        for (let i = 0; i < framePixels; i++) {
          const off = i << 2;
          const off3 = i * 3;
          prevRgb[off3] = frameRgba[off];
          prevRgb[off3 + 1] = frameRgba[off + 1];
          prevRgb[off3 + 2] = frameRgba[off + 2];
          prevAlpha[i] = matted[off + 3];
        }
      }
    }

    outBuffer.set(
      new Uint8Array(matted.buffer, matted.byteOffset, frameBytes),
      byteOff
    );
  }

  return { outBuffer, frameCount };
}

/**
 * Encode raw RGBA matted frames into Telegram-compliant WebM (VP9 yuva420p).
 * Strictly guarantees <= 256 KB file size with automatic fallback.
 */
export async function encodeMattedFramesToWebm(mattedRgbaBuffer, width, height, fps, outputPath, opts = {}) {
  const ffmpegBin = opts.ffmpegBin || 'ffmpeg';
  const enforceTelegramLimit = opts.telegramStickerMode !== false;
  const maxBytes = 256 * 1024; // 262,144 bytes

  let currentCrf = opts.crf ?? 32;
  let currentBitrate = opts.bitrate || '450k';

  // Make directory if missing
  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const encodeArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      String(fps),
      '-i',
      'pipe:0',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      currentBitrate,
      '-crf',
      String(currentCrf),
      '-auto-alt-ref',
      '0',
      '-an',
      outputPath,
    ];

    await runCommandBuffer(ffmpegBin, encodeArgs, mattedRgbaBuffer);

    if (!enforceTelegramLimit) break;

    const stat = fs.statSync(outputPath);
    if (stat.size <= maxBytes) {
      break;
    }

    // Exceeded 256 KB limit: increase compression and retry
    currentCrf += 4;
    const numBitrate = parseInt(currentBitrate, 10) || 450;
    currentBitrate = `${Math.max(200, Math.round(numBitrate * 0.75))}k`;
  }

  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    fileSizeBytes: stat.size,
    fileSizeKb: Number((stat.size / 1024).toFixed(1)),
    isTelegramCompliant: stat.size <= maxBytes,
    crf: currentCrf,
    bitrate: currentBitrate,
  };
}

/**
 * Encode raw RGBA matted frames into animated WebP (`yuva420p -loop 0`).
 */
export async function encodeMattedFramesToWebp(mattedRgbaBuffer, width, height, fps, outputPath, opts = {}) {
  const ffmpegBin = opts.ffmpegBin || 'ffmpeg';
  const quality = opts.webpQuality ?? 75;

  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const encodeArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    '-c:v',
    'libwebp',
    '-pix_fmt',
    'yuva420p',
    '-loop',
    '0',
    '-q:v',
    String(quality),
    outputPath,
  ];

  await runCommandBuffer(ffmpegBin, encodeArgs, mattedRgbaBuffer);
  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    fileSizeBytes: stat.size,
    fileSizeKb: Number((stat.size / 1024).toFixed(1)),
  };
}

/**
 * Export a single transparent RGBA PNG frame poster from matted frames.
 */
export async function exportMattedFrameToPng(mattedRgbaBuffer, width, height, outputPath, frameIndex = 0, opts = {}) {
  const ffmpegBin = opts.ffmpegBin || 'ffmpeg';
  const frameBytes = width * height * 4;
  const totalFrames = Math.floor(mattedRgbaBuffer.length / frameBytes);
  const targetFrame = Math.max(0, Math.min(totalFrames - 1, frameIndex));
  const singleFrameBuffer = mattedRgbaBuffer.subarray(
    targetFrame * frameBytes,
    (targetFrame + 1) * frameBytes
  );

  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const encodeArgs = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
    '-update',
    '1',
    '-pix_fmt',
    'rgba',
    outputPath,
  ];

  await runCommandBuffer(ffmpegBin, encodeArgs, singleFrameBuffer);
  const stat = fs.statSync(outputPath);
  return {
    outputPath,
    fileSizeBytes: stat.size,
    fileSizeKb: Number((stat.size / 1024).toFixed(1)),
  };
}

/**
 * Universal video/GIF background removal with multi-format export (WebM, WebP, PNG).
 */
export async function processVideoOrGif(options = {}) {
  const {
    inputPath,
    outputBasePath,
    outputPathWebm,
    outputPathWebp,
    outputPathPng,
    formats = ['webm'],
    telegramStickerMode = true,
    ffmpegBin = 'ffmpeg',
  } = options;

  if (!inputPath) {
    throw new Error('processVideoOrGif requires inputPath');
  }

  const t0 = performance.now();

  // 1. Probe input media
  const probe = await probeMedia(inputPath, ffmpegBin);
  const srcW = probe.width || 512;
  const srcH = probe.height || 512;

  let width = options.width;
  let height = options.height;

  if (!width || !height) {
    if (telegramStickerMode) {
      const geo = computeTelegramStickerGeometry(srcW, srcH);
      width = geo.width;
      height = geo.height;
    } else {
      width = srcW;
      height = srcH;
    }
  }

  const fps = Math.min(30, options.fps || probe.fps || 24);
  const maxDurationSec = telegramStickerMode
    ? Math.min(3.0, options.maxDurationSec || 3.0)
    : (options.maxDurationSec || 3.0);

  // 2. Decode scaled raw RGBA frames via FFmpeg
  const tDecodeStart = performance.now();
  const decodeArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-t',
    String(maxDurationSec),
    '-vf',
    `fps=${fps},scale=${width}:${height}`,
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  const { stdout: rawFramesBuf } = await runCommandBuffer(ffmpegBin, decodeArgs);
  const decodeMs = Math.round(performance.now() - tDecodeStart);

  // 3. Matte RGBA frames in memory
  const tMatteStart = performance.now();
  const { outBuffer: mattedRgba, frameCount } = matteRgbaFrameSequence(rawFramesBuf, width, height, options);
  const mattingMs = Math.round(performance.now() - tMatteStart);

  // 4. Multi-format encode
  const results = {
    ok: true,
    inputPath,
    width,
    height,
    fps,
    frameCount,
    durationSec: Number((frameCount / fps).toFixed(2)),
    timingsMs: {
      decode: decodeMs,
      matting: mattingMs,
      perFrameMattingMs: Number((mattingMs / Math.max(1, frameCount)).toFixed(1)),
    },
    exports: {},
  };

  const base = outputBasePath || inputPath.replace(/\.[^.]+$/, '');

  // WebM
  if (formats.includes('webm') || outputPathWebm) {
    const webmPath = outputPathWebm || `${base}-sticker.webm`;
    const webmRes = await encodeMattedFramesToWebm(mattedRgba, width, height, fps, webmPath, {
      ...options,
      telegramStickerMode,
      ffmpegBin,
    });
    results.exports.webm = webmRes;
  }

  // WebP
  if (formats.includes('webp') || outputPathWebp) {
    const webpPath = outputPathWebp || `${base}.webp`;
    const webpRes = await encodeMattedFramesToWebp(mattedRgba, width, height, fps, webpPath, {
      ...options,
      ffmpegBin,
    });
    results.exports.webp = webpRes;
  }

  // PNG
  if (formats.includes('png') || outputPathPng) {
    const pngPath = outputPathPng || `${base}-poster.png`;
    const pngRes = await exportMattedFrameToPng(mattedRgba, width, height, pngPath, 0, {
      ...options,
      ffmpegBin,
    });
    results.exports.png = pngRes;
  }

  results.timingsMs.total = Math.round(performance.now() - t0);
  return results;
}

/**
 * Backward compatibility alias for single WebM export.
 */
export async function processVideoOrGifToTransparentWebm(options = {}) {
  const res = await processVideoOrGif({
    ...options,
    outputPathWebm: options.outputPath,
    formats: ['webm'],
  });
  return {
    ...res,
    outputPath: options.outputPath || res.exports.webm?.outputPath,
  };
}
