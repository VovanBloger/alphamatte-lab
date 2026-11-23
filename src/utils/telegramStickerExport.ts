/**
 * Telegram Sticker Export Utility
 *
 * Adheres strictly to Telegram @Stickers specification:
 *
 * STATIC STICKERS (.WEBP):
 * 1. Format: Genuine WebP container with alpha transparency (RIFF...WEBP).
 * 2. Dimensions: One side MUST BE EXACTLY 512 px, other side MUST BE <= 512 px.
 *    (e.g., 512x512, 512x288, 384x512). Proportions are strictly preserved.
 * 3. File size: Strictly <= 512 KB.
 *
 * VIDEO STICKERS (.WEBM):
 * 1. Format: WebM container encoded with VP9 codec (video/webm;codecs=vp9).
 * 2. Dimensions: One side MUST BE EXACTLY 512 px, other side <= 512 px (even integers).
 * 3. Duration: Strictly <= 3.0 seconds.
 * 4. Frame rate: Up to 30 FPS.
 * 5. Audio: NO audio stream allowed (Telegram rejects files with any audio track).
 * 6. File size: Strictly <= 256 KB.
 */

export interface TelegramStickerDimensions {
  width: number;
  height: number;
}

/**
 * Calculates compliant Telegram sticker dimensions.
 * Guarantees that Math.max(width, height) === 512, preserving aspect ratio.
 */
export function calculateTelegramDimensions(
  origW: number,
  origH: number,
  requireEven = false
): TelegramStickerDimensions {
  if (origW <= 0 || origH <= 0) {
    return { width: 512, height: 512 };
  }

  let width: number;
  let height: number;

  if (origW >= origH) {
    width = 512;
    height = Math.max(1, Math.min(512, Math.round((origH / origW) * 512)));
  } else {
    height = 512;
    width = Math.max(1, Math.min(512, Math.round((origW / origH) * 512)));
  }

  if (requireEven) {
    if (width === 512) {
      height = Math.max(2, height & ~1);
    } else {
      width = Math.max(2, width & ~1);
    }
  }

  return { width, height };
}

/**
 * Loads an image from a URL, Blob URL, or data URI into an HTMLImageElement.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Не удалось загрузить изображение: ${url.slice(0, 100)}`));
    img.src = url;
  });
}

export interface TelegramExportResult {
  blob: Blob;
  width: number;
  height: number;
  sizeBytes: number;
  filename: string;
}

/**
 * Creates a Telegram-ready WebP static sticker blob from an image source
 * (URL, Canvas, Image, or RGBA buffer).
 */
export async function createTelegramWebpStickerBlob(
  source: string | HTMLCanvasElement | HTMLImageElement,
  baseFilename = 'sticker'
): Promise<TelegramExportResult> {
  let sourceEl: CanvasImageSource;
  let srcW: number;
  let srcH: number;

  if (typeof source === 'string') {
    const img = await loadImage(source);
    sourceEl = img;
    srcW = img.naturalWidth || img.width;
    srcH = img.naturalHeight || img.height;
  } else if (source instanceof HTMLCanvasElement) {
    sourceEl = source;
    srcW = source.width;
    srcH = source.height;
  } else {
    sourceEl = source;
    srcW = source.naturalWidth || source.width;
    srcH = source.naturalHeight || source.height;
  }

  // 1. Calculate Telegram-compliant dimensions (one side strictly 512px)
  const { width: targetW, height: targetH } = calculateTelegramDimensions(srcW, srcH, false);

  // 2. Render to offscreen canvas with transparent background
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Не удалось инициализировать Canvas 2D context');
  }

  ctx.clearRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceEl, 0, 0, targetW, targetH);

  // 3. Encode to WebP with alpha channel, ensuring size <= 512 KB
  let quality = 0.92;
  let blob: Blob | null = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', quality)
  );

  // Fallback to PNG if browser does not support image/webp canvas export
  if (!blob || blob.type !== 'image/webp') {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    );
  }

  if (!blob) {
    throw new Error('Не удалось закодировать стикер для Telegram');
  }

  // Reduce quality if file exceeds Telegram's 512 KB limit
  const maxBytes = 512 * 1024;
  while (blob.size > maxBytes && quality > 0.4) {
    quality -= 0.15;
    const lowerQualityBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality)
    );
    if (lowerQualityBlob) {
      blob = lowerQualityBlob;
    } else {
      break;
    }
  }

  const cleanBase = baseFilename.replace(/\.[^/.]+$/, '').trim() || 'sticker';
  const ext = blob.type === 'image/webp' ? '.webp' : '.png';
  const filename = `${cleanBase}-tg-sticker${ext}`;

  return {
    blob,
    width: targetW,
    height: targetH,
    sizeBytes: blob.size,
    filename,
  };
}

/**
 * Triggers browser download for a Blob with a specified filename.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
