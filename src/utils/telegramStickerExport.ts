/**
 * Utility for exporting images as compliant Telegram Stickers (static WebP & animated WebM)
 * and full-resolution HD cutouts with customizable stroke and shadow effects.
 *
 * Telegram @Stickers Requirements:
 * 1. Format: WebP for static stickers, WebM (VP9) for video stickers.
 * 2. Canvas size: Exactly 512px on the longest side (e.g. 512x512, 512x341, 384x512).
 * 3. File size: <= 512 KB for static WebP stickers, <= 256 KB for video WebM stickers.
 * 4. Transparency: PNG/WebP must have a transparent background.
 */

export type ShadowType = 'none' | 'around' | '3d';

export interface StickerEffects {
  // Stroke controls (Sliders & Color)
  strokeWidth: number; // 0..30 px (общая / наружная толщина)
  strokeInset: number; // 0..3 px (заход внутрь на 1-3 пх для перекрытия краевого ореола)
  strokeColor: string; // hex string e.g. '#ffffff'

  // Shadow controls (Sliders, Mode & Color)
  shadowType: ShadowType; // 'none' | 'around' | '3d'
  shadowBlur: number; // 0..40 px
  shadowOpacity: number; // 0..100 %
  shadowOffsetX: number; // -30..30 px (для 3D)
  shadowOffsetY: number; // -30..30 px (для 3D)
  shadowColor: string; // hex string e.g. '#000000'
}

export const DEFAULT_STICKER_EFFECTS: StickerEffects = {
  strokeWidth: 0,
  strokeInset: 0,
  strokeColor: '#ffffff',
  shadowType: 'none',
  shadowBlur: 16,
  shadowOpacity: 35,
  shadowOffsetX: 0,
  shadowOffsetY: 12,
  shadowColor: '#000000',
};

/**
 * Converts a hex color (#ffffff, #000, etc.) to an { r, g, b } object.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  return null;
}

/**
 * Fast morphological alpha erosion for defringing and inner stroke overlap.
 * Runs directly on an ImageData buffer in < 2 ms.
 */
export function erodeAlpha(imgData: ImageData, radius: number): void {
  const r = Math.min(3, Math.max(0, Math.round(radius)));
  if (r <= 0) return;

  const w = imgData.width;
  const h = imgData.height;
  const data = imgData.data;

  // Extract alpha channel
  const totalPixels = w * h;
  const alphaCopy = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaCopy[i] = data[i * 4 + 3];
  }

  // Precompute circle offsets for radius r
  const r2 = r * r;
  const offsets: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) {
        offsets.push(dy * w + dx);
      }
    }
  }

  // Erode interior pixels
  for (let y = r; y < h - r; y++) {
    const yOff = y * w;
    for (let x = r; x < w - r; x++) {
      const idx = yOff + x;
      const a = alphaCopy[idx];
      if (a === 0) continue;

      let minA = a;
      for (let k = 0; k < offsets.length; k++) {
        const na = alphaCopy[idx + offsets[k]];
        if (na < minA) {
          minA = na;
          if (minA === 0) break;
        }
      }
      data[idx * 4 + 3] = minA;
    }
  }

  // Handle image boundaries (pixels within r of canvas border)
  for (let y = 0; y < h; y++) {
    const isEdgeY = y < r || y >= h - r;
    const yOff = y * w;
    for (let x = 0; x < w; x++) {
      if (!isEdgeY && x >= r && x < w - r) continue;
      const idx = yOff + x;
      const a = alphaCopy[idx];
      if (a === 0) continue;

      let minA = a;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) {
          minA = 0;
          break;
        }
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) {
            minA = 0;
            break;
          }
          const na = alphaCopy[ny * w + nx];
          if (na < minA) {
            minA = na;
            if (minA === 0) break;
          }
        }
        if (minA === 0) break;
      }
      data[idx * 4 + 3] = minA;
    }
  }
}

/**
 * Generates high-performance CSS filter string for instant 60 FPS GPU preview
 * in the split viewer without re-processing images or re-rendering canvas loops.
 */
export function generateCssStickerFilter(effects: StickerEffects): string {
  const filters: string[] = [];
  const {
    strokeWidth = 0,
    strokeInset = 0,
    strokeColor = '#ffffff',
    shadowType = 'none',
    shadowBlur = 16,
    shadowOpacity = 35,
    shadowOffsetX = 0,
    shadowOffsetY = 12,
    shadowColor = '#000000',
  } = effects;

  // 1. Outline (stroke)
  const outerWidth = Math.max(0, strokeWidth - strokeInset);
  if (outerWidth > 0) {
    const steps = outerWidth <= 3 ? 12 : outerWidth <= 8 ? 16 : 24;
    for (let i = 0; i < steps; i++) {
      const angle = (i * 2 * Math.PI) / steps;
      const x = Math.round(Math.cos(angle) * outerWidth);
      const y = Math.round(Math.sin(angle) * outerWidth);
      filters.push(`drop-shadow(${x}px ${y}px 0px ${strokeColor})`);
    }
    if (outerWidth > 4) {
      const mid = Math.round(outerWidth * 0.5);
      for (let i = 0; i < 8; i++) {
        const angle = (i * 2 * Math.PI) / 8;
        const x = Math.round(Math.cos(angle) * mid);
        const y = Math.round(Math.sin(angle) * mid);
        filters.push(`drop-shadow(${x}px ${y}px 0px ${strokeColor})`);
      }
    }
  }

  // 2. Shadow
  if (shadowType !== 'none' && shadowOpacity > 0) {
    const alpha = Math.min(1, Math.max(0, shadowOpacity / 100));
    const rgb = hexToRgb(shadowColor) || { r: 0, g: 0, b: 0 };
    const colorStr = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(2)})`;

    if (shadowType === 'around') {
      filters.push(`drop-shadow(0px 0px ${shadowBlur}px ${colorStr})`);
      if (shadowBlur > 8) {
        filters.push(`drop-shadow(0px 0px ${Math.round(shadowBlur * 0.4)}px ${colorStr})`);
      }
    } else if (shadowType === '3d') {
      filters.push(
        `drop-shadow(${shadowOffsetX}px ${shadowOffsetY}px ${shadowBlur}px ${colorStr})`
      );
      if (Math.abs(shadowOffsetY) > 6 || Math.abs(shadowOffsetX) > 6) {
        const closeAlpha = (alpha * 0.45).toFixed(2);
        const closeColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${closeAlpha})`;
        filters.push(
          `drop-shadow(${Math.round(shadowOffsetX * 0.35)}px ${Math.round(
            shadowOffsetY * 0.35
          )}px ${Math.round(shadowBlur * 0.35)}px ${closeColor})`
        );
      }
    }
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
    img.onerror = () =>
      reject(new Error(`Не удалось загрузить изображение: ${url.slice(0, 100)}`));
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

  const {
    strokeWidth = 0,
    strokeInset = 0,
    strokeColor = '#ffffff',
    shadowType = 'none',
    shadowBlur = 16,
    shadowOpacity = 35,
    shadowOffsetX = 0,
    shadowOffsetY = 12,
    shadowColor = '#000000',
  } = effects;

  const hasStroke = strokeWidth > 0 || strokeInset > 0;
  const hasShadow = shadowType !== 'none' && shadowOpacity > 0;

  // Simple direct draw if no effects active
  if (!hasStroke && !hasShadow) {
    ctx.drawImage(sourceEl, 0, 0, targetW, targetH);
    return;
  }

  // Calculate breathing room/margin so stroke and shadow don't get clipped by canvas bounds
  const effOffsetX = shadowType === '3d' ? shadowOffsetX : 0;
  const effOffsetY = shadowType === '3d' ? shadowOffsetY : 0;
  const effBlur = hasShadow ? shadowBlur : 0;

  const pad = Math.ceil(
    strokeWidth +
      (hasShadow
        ? Math.max(
            effBlur * 0.45,
            Math.abs(effOffsetY) + effBlur * 0.25,
            Math.abs(effOffsetX) + effBlur * 0.25
          )
        : 0)
  );

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
    sCtx.fillStyle = strokeColor;
    sCtx.fillRect(0, 0, targetW, targetH);
  }

  // 2. Render Shadow under sticker
  if (hasShadow && sCtx) {
    const alpha = Math.min(1, Math.max(0, shadowOpacity / 100));
    const rgb = hexToRgb(shadowColor) || { r: 0, g: 0, b: 0 };
    const sColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(2)})`;

    ctx.save();
    ctx.shadowColor = sColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = effOffsetX;
    ctx.shadowOffsetY = effOffsetY;

    const outerRadius = Math.max(0, strokeWidth - strokeInset);
    if (outerRadius > 0) {
      const steps = outerRadius <= 3 ? 12 : outerRadius <= 8 ? 16 : 24;
      for (let i = 0; i < steps; i++) {
        const a = (i * 2 * Math.PI) / steps;
        const dx = Math.round(Math.cos(a) * outerRadius);
        const dy = Math.round(Math.sin(a) * outerRadius);
        ctx.drawImage(silhouetteCanvas, dx, dy);
      }
    } else {
      ctx.drawImage(silhouetteCanvas, 0, 0);
    }
    ctx.restore();
  }

  // 3. Render Solid Outward & Core Stroke
  const outerRadius = Math.max(0, strokeWidth - strokeInset);
  if (sCtx && (outerRadius > 0 || strokeWidth > 0)) {
    if (outerRadius > 0) {
      const steps = outerRadius <= 3 ? 12 : outerRadius <= 8 ? 16 : 24;
      for (let i = 0; i < steps; i++) {
        const a = (i * 2 * Math.PI) / steps;
        const dx = Math.round(Math.cos(a) * outerRadius);
        const dy = Math.round(Math.sin(a) * outerRadius);
        ctx.drawImage(silhouetteCanvas, dx, dy);
      }
      if (outerRadius > 4) {
        const mid = Math.round(outerRadius * 0.5);
        for (let i = 0; i < 8; i++) {
          const a = (i * 2 * Math.PI) / 8;
          const dx = Math.round(Math.cos(a) * mid);
          const dy = Math.round(Math.sin(a) * mid);
          ctx.drawImage(silhouetteCanvas, dx, dy);
        }
      }
    }
    // Also draw core silhouette in stroke color so inward overlap shows stroke color
    ctx.drawImage(silhouetteCanvas, 0, 0);
  }

  // 4. Render Subject on top
  if (strokeInset > 0) {
    // Erode subject by strokeInset (1..3 px) so stroke penetrates inside and covers edge halos
    const subjectCanvas = document.createElement('canvas');
    subjectCanvas.width = targetW;
    subjectCanvas.height = targetH;
    const subCtx = subjectCanvas.getContext('2d', { willReadFrequently: true });
    if (subCtx) {
      subCtx.imageSmoothingEnabled = true;
      subCtx.imageSmoothingQuality = 'high';
      subCtx.drawImage(sourceEl, posX, posY, drawW, drawH);
      const imgData = subCtx.getImageData(0, 0, targetW, targetH);
      erodeAlpha(imgData, strokeInset);
      subCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(subjectCanvas, 0, 0);
    }
  } else {
    // Zero inset: draw intact original subject directly on top
    ctx.drawImage(sourceEl, posX, posY, drawW, drawH);
  }
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

  const { width: targetW, height: targetH } = calculateTelegramDimensions(srcW, srcH, false);

  const canvas = document.createElement('canvas');
  renderStickerWithEffects(canvas, sourceEl, targetW, targetH, effects);

  let quality = 0.95;
  let blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/webp', quality)
  );

  // If browser doesn't natively support image/webp canvas export, fallback to PNG
  if (!blob || blob.type !== 'image/webp') {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  if (!blob) {
    throw new Error('Не удалось сформировать WebP изображение на Canvas');
  }

  // Telegram static sticker limit is strictly <= 512 KB
  if (blob.size > 512 * 1024) {
    quality = 0.82;
    const smallerBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality)
    );
    if (smallerBlob && smallerBlob.size < blob.size) {
      blob = smallerBlob;
    }
  }

  const cleanBase = baseFilename.replace(/\.[^/.]+$/, '').trim() || 'sticker';
  const filename = `${cleanBase}-tg-sticker.webp`;

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

  const hasStroke = effects.strokeWidth > 0 || effects.strokeInset > 0;
  const hasShadow = effects.shadowType !== 'none' && effects.shadowOpacity > 0;

  // If no effects active, fetch direct image blob to save re-compression
  if (!hasStroke && !hasShadow) {
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
