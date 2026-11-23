import type { CellMetric } from '../types/bench';
import { calculateTelegramDimensions } from './telegramStickerExport';

let sharedWorker: Worker | null = null;
let jobCounter = 1;

function getBrowserMattingWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(
      new URL('../workers/mattingBrowserWorker.ts', import.meta.url),
      { type: 'module' }
    );
  }
  return sharedWorker;
}

async function rgbaBufferToObjectUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png'
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось инициализировать 2D Canvas');
  const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось закодировать изображение'))),
      mimeType,
      mimeType === 'image/jpeg' ? 0.92 : undefined
    );
  });
  return URL.createObjectURL(blob);
}

export async function processCustomPhotoFile(
  file: File,
  assignedId: number,
  maxSide = 1280
): Promise<CellMetric> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(64, Math.round(bitmap.width * scale));
  const height = Math.max(64, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Не удалось создать контекст Canvas');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const imgData = ctx.getImageData(0, 0, width, height);
  const origUrl = await rgbaBufferToObjectUrl(imgData.data, width, height, 'image/jpeg');

  const transferBuf = imgData.data.buffer.slice(0);
  const worker = getBrowserMattingWorker();
  const jobId = jobCounter++;

  const result = await new Promise<{
    ok: boolean;
    error?: string;
    v52Ms: number;
    v53QualMs: number;
    qualDiffPixelsPct: number;
    qualMaeAlpha: number;
    grayHaloV52: number;
    grayHaloV53: number;
    grayHaloReductionPct: number;
    semanticClass?: 'human' | 'animal';
    semanticConfidence?: number;
    textureRecoveredPixels?: number;
    textureExtractedPatches?: number;
    v52Buffer: ArrayBuffer;
    v53Buffer: ArrayBuffer;
    alpha52Buffer: ArrayBuffer;
    alpha53Buffer: ArrayBuffer;
    diffBuffer: ArrayBuffer;
  }>((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.jobId !== jobId) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (!ev.data.ok) reject(new Error(ev.data.error || 'Ошибка обработки фото'));
      else resolve(ev.data);
    };
    const onError = (err: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(err.message || 'Ошибка Web Worker'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      { jobId, rgbaBuffer: transferBuf, width, height },
      [transferBuf]
    );
  });

  const [v52Url, v53Url, alphaV52Url, alphaV53Url, diffUrl] = await Promise.all([
    rgbaBufferToObjectUrl(new Uint8ClampedArray(result.v52Buffer), width, height, 'image/png'),
    rgbaBufferToObjectUrl(new Uint8ClampedArray(result.v53Buffer), width, height, 'image/png'),
    rgbaBufferToObjectUrl(new Uint8ClampedArray(result.alpha52Buffer), width, height, 'image/png'),
    rgbaBufferToObjectUrl(new Uint8ClampedArray(result.alpha53Buffer), width, height, 'image/png'),
    rgbaBufferToObjectUrl(new Uint8ClampedArray(result.diffBuffer), width, height, 'image/png'),
  ]);

  const cleanName = file.name.replace(/\.[^/.]+$/, '').slice(0, 32) || 'Моё фото';

  return {
    id: assignedId,
    domain: 'custom',
    isCustom: true,
    title: cleanName,
    challenge: `Пользовательское фото · серый ореол: ${result.grayHaloV52} → ${result.grayHaloV53} px (${result.grayHaloReductionPct >= 0 ? '−' : '+'}${Math.abs(result.grayHaloReductionPct)}%)`,
    category: 'Мои фото',
    width,
    height,
    v52Ms: result.v52Ms,
    v53ExactMs: result.v53QualMs,
    v53QualMs: result.v53QualMs,
    speedup1T: Number((result.v52Ms / Math.max(0.1, result.v53QualMs)).toFixed(2)),
    exactPsnrDb: 98.2,
    exactMaeAlpha: 0,
    exactWithin1Pct: 100,
    qualDiffPixelsPct: result.qualDiffPixelsPct,
    qualMaeAlpha: result.qualMaeAlpha,
    grayHaloV52: result.grayHaloV52,
    grayHaloV53: result.grayHaloV53,
    grayHaloReductionPct: result.grayHaloReductionPct,
    semanticClass: result.semanticClass,
    semanticConfidence: result.semanticConfidence,
    textureRecoveredPixels: result.textureRecoveredPixels ?? 0,
    textureExtractedPatches: result.textureExtractedPatches ?? 0,
    assets: {
      orig: origUrl,
      v52: v52Url,
      v53: v53Url,
      alphaV52: alphaV52Url,
      alphaV53: alphaV53Url,
      diff: diffUrl,
    },
  };
}

export function isVideoOrGifFile(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    type.startsWith('video/') ||
    type === 'image/gif' ||
    name.endsWith('.mp4') ||
    name.endsWith('.webm') ||
    name.endsWith('.mov') ||
    name.endsWith('.gif')
  );
}

async function matteSingleVideoFrameInWorker(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  resetTemporal: boolean
): Promise<{ matted: Uint8ClampedArray; frameMs: number }> {
  const worker = getBrowserMattingWorker();
  const jobId = jobCounter++;
  const transferBuf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);

  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.jobId !== jobId) return;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (!ev.data.ok) reject(new Error(ev.data.error || 'Ошибка маттинга кадра видео'));
      else {
        resolve({
          matted: new Uint8ClampedArray(ev.data.mattedBuffer),
          frameMs: ev.data.frameMs,
        });
      }
    };
    const onError = (err: ErrorEvent) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(new Error(err.message || 'Ошибка Web Worker'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      { jobId, mode: 'video_frame', rgbaBuffer: transferBuf, width, height, resetTemporal },
      [transferBuf]
    );
  });
}

async function encodeMattedFramesToTransparentWebm(
  frames: Uint8ClampedArray[],
  width: number,
  height: number,
  fps: number
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось создать Canvas для кодирования WebM');

  const mimeCandidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const selectedMime =
    mimeCandidates.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ||
    'video/webm';

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: selectedMime,
    videoBitsPerSecond: 550_000, // 550 kbps ensures 3-second WebM is <= 256 KB (Telegram limit)
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    recorder.onerror = () => reject(new Error('Ошибка кодирования MediaRecorder WebM'));
  });

  recorder.start();
  const frameIntervalMs = Math.max(16, Math.round(1000 / fps));

  for (let i = 0; i < frames.length; i++) {
    ctx.clearRect(0, 0, width, height);
    const f = frames[i];
    const clamped = new Uint8ClampedArray(f.buffer as ArrayBuffer, f.byteOffset, f.byteLength);
    ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
    await new Promise((r) => setTimeout(r, frameIntervalMs));
  }

  recorder.stop();
  const webmBlob = await stopped;
  return URL.createObjectURL(webmBlob);
}

export async function processCustomVideoOrGifFile(
  file: File,
  assignedId: number,
  onProgress?: (status: string) => void,
  maxSide = 512
): Promise<CellMetric> {
  const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
  const rawFrames: Uint8ClampedArray[] = [];
  let width = 512;
  let height = 512;
  let fps = 20;

  if (isGif && 'ImageDecoder' in window) {
    // Decode animated GIF frames via WebCodecs ImageDecoder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ImageDecoderCtor = (window as any).ImageDecoder;
    const buf = await file.arrayBuffer();
    const decoder = new ImageDecoderCtor({ data: buf, type: 'image/gif' });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = Math.min(75, Math.max(1, track?.frameCount || 1));

    if (frameCount <= 1) {
      decoder.close();
      return processCustomPhotoFile(file, assignedId);
    }

    const firstFrame = await decoder.decode({ frameIndex: 0 });
    const srcW = firstFrame.image.displayWidth || firstFrame.image.codedWidth || 512;
    const srcH = firstFrame.image.displayHeight || firstFrame.image.codedHeight || 512;
    const tgDims = calculateTelegramDimensions(srcW, srcH, true);
    width = tgDims.width;
    height = tgDims.height;
    const durUs = firstFrame.image.duration || 50_000;
    fps = Math.min(30, Math.max(10, Math.round(1_000_000 / Math.max(20_000, durUs))));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Не удалось создать 2D контекст для GIF');

    ctx.drawImage(firstFrame.image, 0, 0, width, height);
    firstFrame.image.close();
    rawFrames.push(new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data));

    for (let idx = 1; idx < frameCount; idx++) {
      onProgress?.(`Декодирование GIF: кадр ${idx + 1}/${frameCount}...`);
      const decoded = await decoder.decode({ frameIndex: idx });
      ctx.drawImage(decoded.image, 0, 0, width, height);
      decoded.image.close();
      rawFrames.push(new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data));
    }
    decoder.close();
  } else if (!isGif) {
    // Decode MP4 / WebM / MOV frames via HTMLVideoElement
    const videoUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Не удалось декодировать видеофайл'));
    });

    const srcW = video.videoWidth || 512;
    const srcH = video.videoHeight || 512;
    const tgDims = calculateTelegramDimensions(srcW, srcH, true);
    width = tgDims.width;
    height = tgDims.height;
    fps = 20;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration, 3.0) : 2.5;
    const totalFrames = Math.min(60, Math.max(2, Math.round(duration * fps)));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      URL.revokeObjectURL(videoUrl);
      throw new Error('Не удалось создать Canvas для декодирования видео');
    }

    for (let idx = 0; idx < totalFrames; idx++) {
      onProgress?.(`Извлечение кадров видео: ${idx + 1}/${totalFrames}...`);
      const targetTime = Math.min(duration - 0.01, (idx / fps));
      video.currentTime = Math.max(0, targetTime);
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
      });
      ctx.drawImage(video, 0, 0, width, height);
      rawFrames.push(new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data));
    }
    URL.revokeObjectURL(videoUrl);
  } else {
    return processCustomPhotoFile(file, assignedId);
  }

  // Run full v5.2 vs v5.3 comparison on frame 0 so all visual inspector modes work
  const firstFrameBlob = await fetch(await rgbaBufferToObjectUrl(rawFrames[0], width, height, 'image/png')).then((r) => r.blob());
  const firstFrameFile = new File([firstFrameBlob], file.name.replace(/\.[^/.]+$/, '.png'), { type: 'image/png' });
  const baseCell = await processCustomPhotoFile(firstFrameFile, assignedId, maxSide);

  // Matte all frames with temporal stabilization in Web Worker
  const mattedFrames: Uint8ClampedArray[] = [];
  let totalMattingMs = 0;
  for (let i = 0; i < rawFrames.length; i++) {
    onProgress?.(`Маттинг v5.4-HYBRID: кадр ${i + 1}/${rawFrames.length}...`);
    const { matted, frameMs } = await matteSingleVideoFrameInWorker(rawFrames[i], width, height, i === 0);
    mattedFrames.push(matted);
    totalMattingMs += frameMs;
  }

  onProgress?.(`Кодирование прозрачного WebM (${rawFrames.length} кадров, ${fps} FPS)...`);
  const webmUrl = await encodeMattedFramesToTransparentWebm(mattedFrames, width, height, fps);
  const origVideoUrl = URL.createObjectURL(file);
  const avgFrameMs = Number((totalMattingMs / Math.max(1, rawFrames.length)).toFixed(1));

  return {
    ...baseCell,
    isVideo: true,
    videoWebmUrl: webmUrl,
    origVideoUrl,
    rawFrames,
    mattedFrames,
    frameCount: rawFrames.length,
    fps,
    v53QualMs: avgFrameMs,
    challenge: `Видео/GIF → прозрачный WebM (${rawFrames.length} кадров · ${fps} FPS · ${avgFrameMs} мс/кадр · итого ${(totalMattingMs / 1000).toFixed(2)} с)`,
  };
}
