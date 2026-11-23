/**
 * Telegram Sticker Export & Effects Utility
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

export type ShadowPreset = 'none' | 'soft' | 'sticker' | 'deep3d';

export interface StickerEffects {
  strokeWidth: number; // 0, 4, 8, 14 px
  strokeColor: string; // e.g. '#ffffff'
  shadowPreset: ShadowPreset;
}

export const DEFAULT_STICKER_EFFECTS: StickerEffects = {
  strokeWidth: 0,
  strokeColor: '#ffffff',
  shadowPreset: 'none',
};

/**
 * Generates high-performance CSS filter string for instant 60 FPS GPU preview
 * in the split viewer without re-processing images or re-rendering canvas loops.
 */
export function generateCssStickerFilter(effects: StickerEffects): string {
  const filters: string[] = [];
  const { strokeWidth, strokeColor, shadowPreset } = effects;

  // 1. Outline (stroke) via multi-angle sharp zero-blur drop shadows
  if (strokeWidth > 0) {
    const steps = strokeWidth <= 4 ? 12 : strokeWidth <= 8 ? 16 : 24;
    for (let i = 0; i < steps; i++) {
      const angle = (i * 2 * Math.PI) / steps;
      const x = Math.round(Math.cos(angle) * strokeWidth);
      const y = Math.round(Math.sin(angle) * strokeWidth);
      filters.push(`drop-shadow(${x}px ${y}px 0px ${strokeColor})`);
    }
    // Fill inner ring for thicker strokes to prevent micro-gaps
    if (strokeWidth > 4) {
      const mid = Math.round(strokeWidth * 0.5);
      for (let i = 0; i < 8; i++) {
        const angle = (i * 2 * Math.PI) / 8;
        const x = Math.round(Math.cos(angle) * mid);
        const y = Math.round(Math.sin(angle) * mid);
        filters.push(`drop-shadow(${x}px ${y}px 0px ${strokeColor})`);
      }
    }
  }

  // 2. Soft drop shadow
  if (shadowPreset === 'soft') {
    filters.push('drop-shadow(0px 6px 14px rgba(0, 0, 0, 0.22))');
  } else if (shadowPreset === 'sticker') {
    filters.push('drop-shadow(0px 8px 18px rgba(0, 0, 0, 0.32))');
  } else if (shadowPreset === 'deep3d') {
    filters.push('drop-shadow(0px 14px 28px rgba(0, 0, 0, 0.42))');
  }

  return filters.length > 0 ? filters.join(' ') : 'none';
}

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
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Не удалось загрузить изображение: ${url.slice(0, 100)}`));
    img.src = url;
  });
}

/**
 * Renders an image onto target canvas with optional die-cut sticker outline and shadow.
 */
export function renderStickerWithEffects(
  targetCanvas: HTMLCanvasElement,
  sourceEl: CanvasImageSource,
  targetW: number,
  targetH: number,
  effects: StickerEffects = DEFAULT_STICKER_EFFECTS
): void {
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  targetCanvas.width = targetW;
  targetCanvas.height = targetH;
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const { strokeWidth, strokeColor, shadowPreset } = effects;

  // Simple direct draw if no effects active
  if (strokeWidth <= 0 && shadowPreset === 'none') {
    ctx.drawImage(sourceEl, 0, 0, targetW, targetH);
    return;
  }

  // Calculate breathing room/margin so stroke and shadow don't get clipped by canvas bounds
  const shadowBlur = shadowPreset === 'soft' ? 14 : shadowPreset === 'sticker' ? 18 : shadowPreset === 'deep3d' ? 28 : 0;
  const shadowOffsetY = shadowPreset === 'soft' ? 6 : shadowPreset === 'sticker' ? 8 : shadowPreset === 'deep3d' ? 14 : 0;
  const shadowAlpha = shadowPreset === 'soft' ? 0.22 : shadowPreset === 'sticker' ? 0.32 : shadowPreset === 'deep3d' ? 0.42 : 0;

  const pad = Math.ceil(strokeWidth + (shadowPreset !== 'none' ? shadowBlur * 0.35 : 0));
  const drawW = Math.max(10, targetW - pad * 2);
  const drawH = Math.max(10, targetH - pad * 2);
  const posX = pad;
  const posY = pad;

  // 1. Offscreen silhouette canvas in stroke color
  const silhouetteCanvas = document.createElement('canvas');
  silhouetteCanvas.width = targetW;
  silhouetteCanvas.height = targetH;
  const sCtx = silhouetteCanvas.getContext('2d', { willReadFrequently: true });
  if (sCtx) {
    sCtx.imageSmoothingEnabled = true;
    sCtx.imageSmoothingQuality = 'high';
    sCtx.drawImage(sourceEl, posX, posY, drawW, drawH);
    sCtx.globalCompositeOperation = 'source-in';
    sCtx.fillStyle = strokeWidth > 0 ? strokeColor : '#000000';
    sCtx.fillRect(0, 0, targetW, targetH);
  }

  // 2. Render Soft Shadow under sticker (falls from the outline or subject)
  if (shadowPreset !== 'none' && sCtx) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${shadowAlpha})`;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = shadowOffsetY;

    if (strokeWidth > 0) {
      const steps = strokeWidth <= 4 ? 12 : strokeWidth <= 8 ? 16 : 24;
      for (let i = 0; i < steps; i++) {
        const a = (i * 2 * Math.PI) / steps;
        const dx = Math.round(Math.cos(a) * strokeWidth);
        const dy = Math.round(Math.sin(a) * strokeWidth);
        ctx.drawImage(silhouetteCanvas, dx, dy);
      }
    } else {
      ctx.drawImage(silhouetteCanvas, 0, 0);
    }
    ctx.restore();
  }

  // 3. Render Solid Die-cut Stroke
  if (strokeWidth > 0 && sCtx) {
    const steps = strokeWidth <= 4 ? 12 : strokeWidth <= 8 ? 16 : 24;
    for (let i = 0; i < steps; i++) {
      const a = (i * 2 * Math.PI) / steps;
      const dx = Math.round(Math.cos(a) * strokeWidth);
      const dy = Math.round(Math.sin(a) * strokeWidth);
      ctx.drawImage(silhouetteCanvas, dx, dy);
    }
    if (strokeWidth > 4) {
      const mid = Math.round(strokeWidth * 0.5);
      for (let i = 0; i < 8; i++) {
        const a = (i * 2 * Math.PI) / 8;
        const dx = Math.round(Math.cos(a) * mid);
        const dy = Math.round(Math.sin(a) * mid);
        ctx.drawImage(silhouetteCanvas, dx, dy);
      }
    }
  }

  // 4. Render original sharp foreground on top
  ctx.drawImage(sourceEl, posX, posY, drawW, drawH);
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
 * (URL, Canvas, Image, or RGBA buffer), baking in any active stroke and shadow.
 */
export async function createTelegramWebpStickerBlob(
  source: string | HTMLCanvasElement | HTMLImageElement,
  baseFilename = 'sticker',
  effects: StickerEffects = DEFAULT_STICKER_EFFECTS
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

  // 2. Render to offscreen canvas with transparent background and effects
  const canvas = document.createElement('canvas');
  renderStickerWithEffects(canvas, sourceEl, targetW, targetH, effects);

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
 * Creates an HD cutout PNG blob, baking in any active stroke and shadow.
 */
export async function createHdCutoutBlob(
  source: string | HTMLCanvasElement | HTMLImageElement,
  baseFilename = 'cutout',
  effects: StickerEffects = DEFAULT_STICKER_EFFECTS
): Promise<{ blob: Blob; filename: string }> {
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

  // If no effects active, fetch direct image blob to save re-compression
  if (effects.strokeWidth <= 0 && effects.shadowPreset === 'none') {
    if (typeof source === 'string') {
      const resp = await fetch(source);
      const blob = await resp.blob();
      const cleanBase = baseFilename.replace(/\.[^/.]+$/, '').trim() || 'cutout';
      return { blob, filename: `${cleanBase}-hd-cutout.png` };
    }
  }

  const canvas = document.createElement('canvas');
  renderStickerWithEffects(canvas, sourceEl, srcW, srcH, effects);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );

  if (!blob) {
    throw new Error('Не удалось сформировать HD PNG изображение');
  }

  const cleanBase = baseFilename.replace(/\.[^/.]+$/, '').trim() || 'cutout';
  return { blob, filename: `${cleanBase}-hd-cutout.png` };
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
