#!/usr/bin/env node
/**
 * CLI Tool for Video & GIF Background Removal -> Telegram WebM, WebP, PNG Poster
 * Uses SOTA v5.4-HYBRID Matting Engine
 */

import fs from 'node:fs';
import path from 'node:path';
import { processVideoOrGif } from '../sheet-processor/video-matting.mjs';

function parseArgs(args) {
  const options = {
    inputPath: null,
    outputBasePath: null,
    formats: ['webm'],
    telegramStickerMode: true,
    fps: null,
    width: null,
    height: null,
    crf: 32,
    bitrate: '450k',
    ffmpegBin: process.platform === 'win32' && process.env.FFMPEG_BIN
      ? process.env.FFMPEG_BIN
      : (process.platform === 'win32' && fs.existsSync('C:/Program Files/ShareX/ffmpeg.exe')
        ? 'C:/Program Files/ShareX/ffmpeg.exe'
        : 'ffmpeg'),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' || arg === '-i') {
      options.inputPath = args[++i];
    } else if (arg === '--out' || arg === '-o') {
      options.outputBasePath = args[++i];
    } else if (arg === '--export' || arg === '-e') {
      options.formats = args[++i].split(',').map(s => s.trim().toLowerCase());
    } else if (arg === '--fps') {
      options.fps = parseInt(args[++i], 10);
    } else if (arg === '--width') {
      options.width = parseInt(args[++i], 10);
    } else if (arg === '--height') {
      options.height = parseInt(args[++i], 10);
    } else if (arg === '--crf') {
      options.crf = parseInt(args[++i], 10);
    } else if (arg === '--bitrate') {
      options.bitrate = args[++i];
    } else if (arg === '--ffmpeg') {
      options.ffmpegBin = args[++i];
    } else if (arg === '--no-telegram') {
      options.telegramStickerMode = false;
    }
  }

  return options;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node video-matting-cli.mjs --input <input_video_or_gif> [options]

Options:
  --input, -i       Path to input MP4, WebM, or GIF (required)
  --out, -o         Base path for output files (without extension)
  --export, -e      Comma-separated formats: webm, webp, png (default: webm)
  --fps             Target framerate (default: auto, max 30 for telegram)
  --width           Target width (default: 512 for telegram stickers)
  --height          Target height (default: 512 for telegram stickers)
  --crf             VP9 CRF quality factor (default: 32)
  --bitrate         Target video bitrate (default: 450k)
  --no-telegram     Disable strict Telegram sticker geometry/size constraints
  --ffmpeg          Custom path to ffmpeg binary
    `);
    process.exit(0);
  }

  const opts = parseArgs(args);
  if (!opts.inputPath) {
    console.error('Error: --input is required');
    process.exit(1);
  }

  console.log(`[VideoMatting] Processing: ${opts.inputPath}`);
  console.log(`[VideoMatting] Formats requested: ${opts.formats.join(', ')}`);
  console.log(`[VideoMatting] Telegram sticker mode: ${opts.telegramStickerMode ? 'ENABLED (<=512px, <=3.0s, <=256KB)' : 'DISABLED'}`);

  const res = await processVideoOrGif(opts);

  console.log('\n--- Processing Complete ---');
  console.log(`Dimensions: ${res.width}x${res.height}`);
  console.log(`Frames: ${res.frameCount} @ ${res.fps} fps (${res.durationSec}s)`);
  console.log(`Timings: decode ${res.timingsMs.decode}ms, matting ${res.timingsMs.matting}ms (${res.timingsMs.perFrameMattingMs} ms/frame), total ${res.timingsMs.total}ms`);

  console.log('\nExported files:');
  for (const [fmt, info] of Object.entries(res.exports)) {
    console.log(`- [${fmt.toUpperCase()}] ${info.outputPath} (${info.fileSizeKb} KB)${info.isTelegramCompliant !== undefined ? (info.isTelegramCompliant ? ' [Telegram-Valid]' : ' [OVER 256KB!]') : ''}`);
  }
}

main().catch((err) => {
  console.error('[VideoMatting Error]:', err);
  process.exit(1);
});
