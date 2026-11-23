/**
 * Server-Side & CLI Video / GIF Background Removal -> Transparent WebM (VP9 Alpha yuva420p)
 * Uses SOTA v5.4-HYBRID (`sotaCellMattingV5_3_Turbo`) with Temporal Alpha Stabilization.
 *
 * Compatible with Telegram Video Stickers (512x512, <= 30 FPS, <= 3.0s, VP9 yuva420p).
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sotaCellMattingV5_3_Turbo } from './v53-matting.mjs';

function runCommandBuffer(cmd, args, inputBuffer = null) {
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
 * Convert an input GIF or MP4/WebM file with a studio background (#7A828C)
 * into a transparent VP9 WebM video (`yuva420p`) via FFmpeg + v5.4-HYBRID matting.
 */
export async function processVideoOrGifToTransparentWebm(options = {}) {
  const {
    inputPath,
    outputPath,
    width = 512,
    height = 512,
    fps = 24,
    maxDurationSec = 3.0,
    bitrate = '650k',
    crf = 32,
    ffmpegBin = 'ffmpeg',
  } = options;

  if (!inputPath || !outputPath) {
    throw new Error('processVideoOrGifToTransparentWebm requires inputPath and outputPath');
  }

  const t0 = performance.now();

  // 1. Decode input GIF/MP4 to scaled raw RGBA frames via FFmpeg
  const decodeArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-t',
    String(maxDurationSec),
    '-vf',
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#7A828C`,
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  const tDecodeStart = performance.now();
  const { stdout: rawFramesBuf } = await runCommandBuffer(ffmpegBin, decodeArgs);
  const decodeMs = Math.round(performance.now() - tDecodeStart);

  // 2. Matte every frame with v5.4-HYBRID + temporal alpha stabilization
  const tMatteStart = performance.now();
  const { outBuffer, frameCount } = matteRgbaFrameSequence(rawFramesBuf, width, height, options);
  const mattingMs = Math.round(performance.now() - tMatteStart);

  // 3. Encode matted RGBA frames into transparent VP9 WebM (`yuva420p`)
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
    bitrate,
    '-crf',
    String(crf),
    '-auto-alt-ref',
    '0',
    '-an',
    outputPath,
  ];

  const tEncodeStart = performance.now();
  await runCommandBuffer(ffmpegBin, encodeArgs, outBuffer);
  const encodeMs = Math.round(performance.now() - tEncodeStart);

  return {
    ok: true,
    inputPath,
    outputPath,
    width,
    height,
    fps,
    frameCount,
    timingsMs: {
      decode: decodeMs,
      matting: mattingMs,
      perFrameMattingMs: Number((mattingMs / Math.max(1, frameCount)).toFixed(1)),
      encode: encodeMs,
      total: Math.round(performance.now() - t0),
    },
  };
}
