#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { processStickerSheet } from './index.mjs';

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--config' || token === '-c') {
      args.configPath = argv[++i];
    } else if (token.startsWith('--config=')) {
      args.configPath = token.slice('--config='.length);
    } else if (token === '--input' || token === '-i') {
      args.inputPath = argv[++i];
    } else if (token === '--output' || token === '-o') {
      args.outputDir = argv[++i];
    } else if (token === '--layout' || token === '-l') {
      args.layout = argv[++i];
    } else if (token === '--bg' || token === '--background-color') {
      args.backgroundColor = argv[++i];
    } else if (token === '--size' || token === '--output-size') {
      args.outputSize = Number(argv[++i]);
    } else if (token === '--padding' || token === '-p') {
      args.padding = Number(argv[++i]);
    } else if (token === '--tolerance') {
      args.tolerance = Number(argv[++i]);
    } else if (token === '--softness') {
      args.softness = Number(argv[++i]);
    } else if (token === '--spill') {
      args.spillSuppression = Number(argv[++i]);
    } else if (token === '--strict') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.strict = next === 'true';
        i++;
      } else {
        args.strict = true;
      }
    } else if (token === '--no-strict') {
      args.strict = false;
    } else if (token === '--debug') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.debug = next === 'true';
        i++;
      } else {
        args.debug = true;
      }
    } else if (token === '--export-transparent-sheet') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.exportTransparentSheet = next === 'true';
        i++;
      } else {
        args.exportTransparentSheet = true;
      }
    } else if (token === '--no-export-transparent-sheet') {
      args.exportTransparentSheet = false;
    } else if (token === '--export-preview') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.exportPreview = next === 'true';
        i++;
      } else {
        args.exportPreview = true;
      }
    } else if (token === '--no-export-preview') {
      args.exportPreview = false;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown CLI argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stderr.write(
    [
      'Usage:',
      '  node cli.mjs --config /path/to/config.json',
      '  node sheet-processor/cli.mjs --config /path/to/config.json',
      '',
      'Options:',
      '  --config, -c <path>            Path to JSON configuration file',
      '  --input, -i <path>             Override inputPath',
      '  --output, -o <path>            Override outputDir',
      '  --layout, -l <3x3|3x4>         Override layout ("3x3" or "3x4")',
      '  --bg <hex>                     Override backgroundColor (default "#00FF00")',
      '  --size <px>                    Override outputSize (default 512)',
      '  --padding, -p <px>             Override padding (default 24)',
      '  --tolerance <num>              Override chroma tolerance (default 42)',
      '  --softness <num>               Override edge softness (default 22)',
      '  --spill <0..1>                 Override spillSuppression (default 0.92)',
      '  --strict [true|false]          Strict validation mode (default true)',
      '  --debug [true|false]           Save debug masks and grid overlay',
      '  --export-transparent-sheet [true|false] Export full transparent sheet (default true)',
      '  --no-export-transparent-sheet  Disable full transparent sheet export',
      '  --export-preview [true|false]  Export checkerboard preview (default true)',
      '  --no-export-preview            Disable checkerboard preview export',
      '  --help, -h                     Show this help message',
      '',
    ].join('\n'),
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  let cliArgs;
  try {
    cliArgs = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sticker-sheet-cli] Argument error: ${message}\n`);
    const payload = {
      version: 1,
      status: 'failed',
      errors: [message],
      warnings: [],
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 1;
  }

  if (cliArgs.help) {
    printHelp();
    return 0;
  }

  let fileConfig = {};
  let configBaseDir = process.cwd();
  if (cliArgs.configPath) {
    const resolvedConfigPath = path.resolve(cliArgs.configPath);
    configBaseDir = path.dirname(resolvedConfigPath);
    try {
      const rawJson = await fs.readFile(resolvedConfigPath, 'utf8');
      fileConfig = JSON.parse(rawJson);
    } catch (err) {
      const message = `Failed to load config "${cliArgs.configPath}": ${err instanceof Error ? err.message : String(err)}`;
      process.stderr.write(`[sticker-sheet-cli] ${message}\n`);
      const payload = {
        version: 1,
        status: 'failed',
        errors: [message],
        warnings: [],
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 1;
    }
  }

  const mergedOptions = {
    ...fileConfig,
  };
  for (const [k, v] of Object.entries(cliArgs)) {
    if (k !== 'configPath' && k !== 'help' && v !== undefined) {
      mergedOptions[k] = v;
    }
  }

  // Resolve relative paths in config file relative to cwd if they exist, or fallback to config dir if not found in cwd
  if (typeof mergedOptions.inputPath === 'string' && !path.isAbsolute(mergedOptions.inputPath)) {
    const cwdCandidate = path.resolve(process.cwd(), mergedOptions.inputPath);
    try {
      await fs.access(cwdCandidate);
      mergedOptions.inputPath = cwdCandidate;
    } catch {
      mergedOptions.inputPath = path.resolve(configBaseDir, mergedOptions.inputPath);
    }
  }
  if (typeof mergedOptions.outputDir === 'string' && !path.isAbsolute(mergedOptions.outputDir)) {
    mergedOptions.outputDir = path.resolve(process.cwd(), mergedOptions.outputDir);
  }

  try {
    const result = await processStickerSheet(mergedOptions);
    if (result.warnings?.length) {
      for (const warning of result.warnings) {
        process.stderr.write(`[sticker-sheet-cli] WARN: ${warning}\n`);
      }
    }
    if (result.errors?.length) {
      for (const error of result.errors) {
        process.stderr.write(`[sticker-sheet-cli] ERROR: ${error}\n`);
      }
    }
    process.stderr.write(
      `[sticker-sheet-cli] Completed with status="${result.status}" (${result.readyCount}/${result.expectedCount} stickers ready in ${result.timingsMs?.total ?? 0} ms)\n`,
    );

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    if (result.status === 'ready') return 0;
    if (result.status === 'needs_review') return 2;
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sticker-sheet-cli] Fatal error: ${message}\n`);
    const payload = {
      version: 1,
      status: 'failed',
      errors: [message],
      warnings: [],
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
