#!/usr/bin/env node

/**
 * CLI Tool for Video & GIF Background Removal -> Transparent WebM (VP9 yuva420p)
 *
 * Usage:
 *   node scripts/video-matting-cli.mjs --input input.mp4 --output output.webm
 *   node scripts/video-matting-cli.mjs --input animation.gif --output sticker.webm --fps 24 --width 512 --height 512
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processVideoOrGifToTransparentWebm } from '../sheet-processor/video-matting.mjs';

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      parsed[key] = val;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.input || !args.output) {
  console.log(`
AlphaMatte Video & GIF Matting CLI
Convert any GIF / MP4 / WebM video with background to transparent VP9 WebM.

Options:
  --input <path>         Path to input video/gif (required)
  --output <path>        Path to output .webm file (required)
  --width <number>       Output width (default: 512)
  --height <number>      Output height (default: 512)
  --fps <number>         Frame rate (default: 24)
  --duration <number>    Max duration in seconds (default: 4.0)
  --bitrate <string>     Video bitrate (default: "750k")
  --crf <number>         VP9 CRF quality (default: 26)
  --ffmpeg <path>        Custom ffmpeg binary path (default: "ffmpeg")
  --no-temporal          Disable temporal alpha stabilization

Examples:
  node scripts/video-matting-cli.mjs --input cat.gif --output cat.webm
  node scripts/video-matting-cli.mjs --input dance.mp4 --output dance.webm --width 320 --height 320 --fps 15
`);
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(process.cwd(), args.input);
const outputPath = path.resolve(process.cwd(), args.output);

console.log(`[video-matte] Processing: ${inputPath} -> ${outputPath}...`);

try {
  const result = await processVideoOrGifToTransparentWebm({
    inputPath,
    outputPath,
    width: args.width ? parseInt(args.width, 10) : 512,
    height: args.height ? parseInt(args.height, 10) : 512,
    fps: args.fps ? parseInt(args.fps, 10) : 24,
    maxDurationSec: args.duration ? parseFloat(args.duration) : 4.0,
    bitrate: args.bitrate || '750k',
    crf: args.crf ? parseInt(args.crf, 10) : 26,
    ffmpegBin: args.ffmpeg || 'ffmpeg',
    temporalSmoothing: args['no-temporal'] ? false : true,
  });

  console.log(`[video-matte] Success! ${result.frameCount} frames processed in ${result.timingsMs.total} ms (${result.timingsMs.perFrameMattingMs} ms/frame).`);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`[video-matte] Error:`, err.message);
  process.exit(1);
}
