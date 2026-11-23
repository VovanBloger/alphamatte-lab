import React, { useRef, useState } from 'react';
import {
  Upload,
  Download,
  ArrowLeft,
  Sparkles,
  Zap,
  CheckCircle2,
  FileVideo,
  Image as ImageIcon,
  Github,
  Scissors,
} from 'lucide-react';
import { CleanSplitViewer, type BackdropColor } from './components/CleanSplitViewer';
import {
  isVideoOrGifFile,
  processCustomPhotoFile,
  processCustomVideoOrGifFile,
} from './utils/customPhotoRunner';
import { resolveAssetUrl } from './utils/assetUrl';
import {
  createTelegramWebpStickerBlob,
  createHdCutoutBlob,
  triggerBlobDownload,
  type StickerEffects,
  DEFAULT_STICKER_EFFECTS,
} from './utils/telegramStickerExport';

export interface FeaturedItem {
  id: number;
  title: string;
  subtitle: string;
  category: string;
  thumb: string;
  original: string;
  processed: string;
  isVideo?: boolean;
  isGif?: boolean;
  rawFrames?: Uint8ClampedArray[];
  mattedFrames?: Uint8ClampedArray[];
  width?: number;
  height?: number;
  fps?: number;
  speedMs: number;
  badge: string;
  description: string;
  downloadName: string;
  downloadType: 'image/png' | 'video/webm' | 'image/webp';
}

const FEATURED_EXAMPLES: FeaturedItem[] = [
  {
    id: 17,
    title: 'DJ Кот',
    subtitle: 'Telegram Video Sticker',
    category: 'Видео-стикер',
    thumb: '/bench/cells/v53_17.png',
    original: '/bench/cells/cell_17_original.mp4',
    processed: '/bench/cells/cell_17_tg_sticker.webm',
    isVideo: true,
    speedMs: 116,
    badge: 'Telegram 512×512 · VP9',
    description: 'Анимированный стикер: 45 кадров, 238 КБ (лимит TG ≤ 256 КБ), 15 FPS',
    downloadName: 'dj-cat-telegram-sticker.webm',
    downloadType: 'video/webm',
  },
  {
    id: 2,
    title: 'Пушистый кот',
    subtitle: 'Светлая шерсть и усы',
    category: 'Шерсть и усы',
    thumb: '/bench/cells/v53_02.png',
    original: '/bench/cells/orig_02.jpg',
    processed: '/bench/cells/v53_02.png',
    speedMs: 38,
    badge: '38 мс · HD',
    description: 'Светлая шерсть в тени — защита от потемнения краёв и серой каймы',
    downloadName: 'fluffy-cat-alpha.png',
    downloadType: 'image/png',
  },
  {
    id: 14,
    title: 'Девушка с волосами',
    subtitle: 'Тонкие микро-пряди',
    category: 'Портреты',
    thumb: '/bench/cells/v53_14.png',
    original: '/bench/cells/orig_14.jpg',
    processed: '/bench/cells/v53_14.png',
    speedMs: 34,
    badge: '34 мс · HD',
    description: 'Выбившиеся светлые волоски без серой паутины и ореолов',
    downloadName: 'blonde-hair-alpha.png',
    downloadType: 'image/png',
  },
  {
    id: 5,
    title: 'Мыльные пузыри',
    subtitle: 'Полупрозрачность',
    category: 'Стекло и блики',
    thumb: '/bench/cells/v53_05.png',
    original: '/bench/cells/orig_05.jpg',
    processed: '/bench/cells/v53_05.png',
    speedMs: 41,
    badge: '41 мс · HD',
    description: 'Радужные тонкие сферы со сложным альфа-градиентом стекла',
    downloadName: 'soap-bubbles-alpha.png',
    downloadType: 'image/png',
  },
];

export default function App() {
  const [selectedItem, setSelectedItem] = useState<FeaturedItem | null>(null);
  const [backdrop, setBackdrop] = useState<BackdropColor>('checker');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingStatus, setProcessingStatus] = useState<string>('Обработка...');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [stickerEffects, setStickerEffects] = useState<StickerEffects>(DEFAULT_STICKER_EFFECTS);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const customIdRef = useRef<number>(200);

  const handleSelectExample = (ex: FeaturedItem) => {
    setSelectedItem(ex);
    setBackdrop('checker');
    setToast(null);
  };

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || isVideoOrGifFile(f)
    );
    if (files.length === 0) {
      setToast({
        type: 'error',
        message: 'Пожалуйста, выберите фото (PNG, JPEG, WebP) или видео/GIF (MP4, GIF).',
      });
      return;
    }

    const file = files[0];
    const isVid = isVideoOrGifFile(file);
    setIsProcessing(true);
    setProcessingStatus(isVid ? 'Подготовка видео → WebM...' : 'Удаление фона AlphaMatte...');
    setToast(null);

    const t0 = performance.now();
    try {
      const newId = customIdRef.current++;
      const cell = isVid
        ? await processCustomVideoOrGifFile(file, newId, (msg) => setProcessingStatus(msg))
        : await processCustomPhotoFile(file, newId);

      const elapsed = Math.round(performance.now() - t0);
      const isActuallyVideo = Boolean(cell.isVideo);
      const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
      const originalUrl = isActuallyVideo && cell.origVideoUrl ? cell.origVideoUrl : cell.assets.orig;
      const processedUrl = isActuallyVideo && cell.videoWebmUrl ? cell.videoWebmUrl : cell.assets.v53;
      const thumbUrl = cell.assets.v53;

      const customItem: FeaturedItem = {
        id: newId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        subtitle: isActuallyVideo
          ? (isGif ? 'Пользовательский GIF' : 'Пользовательское видео')
          : 'Пользовательское фото',
        category: 'Моё фото',
        thumb: thumbUrl,
        original: originalUrl,
        processed: processedUrl,
        isVideo: isActuallyVideo,
        isGif,
        rawFrames: cell.rawFrames,
        mattedFrames: cell.mattedFrames,
        width: cell.width,
        height: cell.height,
        fps: cell.fps || 20,
        speedMs: cell.v53QualMs > 0 ? Math.round(cell.v53QualMs) : elapsed,
        badge: isActuallyVideo ? `${cell.frameCount || 1} кадров · ${cell.fps || 20} FPS` : `${elapsed} мс`,
        description: isActuallyVideo
          ? `Видео/GIF (${cell.frameCount || 1} кадров, ${cell.width}×${cell.height} px, ${cell.fps || 20} FPS)`
          : `Разрешение: ${cell.width}×${cell.height} px · Алгоритм v5.3 Turbo`,
        downloadName: isActuallyVideo
          ? `${file.name.replace(/\.[^/.]+$/, '')}-sticker.webm`
          : `${file.name.replace(/\.[^/.]+$/, '')}-cutout.png`,
        downloadType: isActuallyVideo ? 'video/webm' : 'image/png',
      };

      setSelectedItem(customItem);
      setBackdrop('checker');
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Ошибка при обработке изображения',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = async (
    item: FeaturedItem,
    format: 'tg-sticker' | 'tg-webm' | 'hd-png'
  ) => {
    setIsExporting(true);
    setToast(null);

    try {
      if (format === 'tg-sticker') {
        // STATIC TELEGRAM STICKER (.WEBP, 512px max side, <= 512 KB)
        let source: string | HTMLCanvasElement = resolveAssetUrl(item.processed);

        if (
          item.isVideo &&
          item.mattedFrames &&
          item.mattedFrames.length > 0 &&
          item.width &&
          item.height
        ) {
          const canvas = document.createElement('canvas');
          canvas.width = item.width;
          canvas.height = item.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const f = item.mattedFrames[0];
            const clamped = new Uint8ClampedArray(
              f.buffer as ArrayBuffer,
              f.byteOffset,
              f.byteLength
            );
            ctx.putImageData(new ImageData(clamped, item.width, item.height), 0, 0);
            source = canvas;
          }
        } else if (item.isVideo && item.thumb) {
          source = resolveAssetUrl(item.thumb);
        }

        const res = await createTelegramWebpStickerBlob(
          source,
          item.downloadName || item.title,
          stickerEffects
        );
        triggerBlobDownload(res.blob, res.filename);

        setToast({
          type: 'success',
          message: `Стикер Telegram готов: ${res.filename} (${res.width}×${res.height} px, ${(res.sizeBytes / 1024).toFixed(1)} КБ) — подходит для бота @Stickers!`,
        });
      } else if (format === 'tg-webm') {
        // VIDEO TELEGRAM STICKER (.WEBM VP9, 512px max side, <= 256 KB, <= 3.0s, no audio)
        const href = resolveAssetUrl(item.processed);
        const a = document.createElement('a');
        a.href = href;
        const cleanBase =
          (item.downloadName || item.title).replace(/\.[^/.]+$/, '').trim() ||
          'video-sticker';
        a.download = `${cleanBase}-tg-sticker.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setToast({
          type: 'success',
          message: `Видео-стикер Telegram готов: ${cleanBase}-tg-sticker.webm (VP9, без звука, ≤ 256 КБ) — готов для @Stickers!`,
        });
      } else {
        // ORIGINAL HD CUTOUT (PNG, full resolution with baked stroke & shadow)
        let source: string | HTMLCanvasElement = resolveAssetUrl(item.processed);

        if (
          item.isVideo &&
          item.mattedFrames &&
          item.mattedFrames.length > 0 &&
          item.width &&
          item.height
        ) {
          const canvas = document.createElement('canvas');
          canvas.width = item.width;
          canvas.height = item.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const f = item.mattedFrames[0];
            const clamped = new Uint8ClampedArray(
              f.buffer as ArrayBuffer,
              f.byteOffset,
              f.byteLength
            );
            ctx.putImageData(new ImageData(clamped, item.width, item.height), 0, 0);
            source = canvas;
          }
        } else if (item.isVideo && item.thumb) {
          source = resolveAssetUrl(item.thumb);
        }

        const res = await createHdCutoutBlob(
          source,
          item.downloadName || item.title,
          stickerEffects
        );
        triggerBlobDownload(res.blob, res.filename);

        setToast({
          type: 'success',
          message: `HD вырезка сохранена: ${res.filename} (полное разрешение, прозрачный PNG).`,
        });
      }
    } catch (err) {
      setToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Ошибка при экспорте стикера',
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleUploadFiles(e.dataTransfer.files);
        }
      }}
      className="min-h-screen flex flex-col bg-[#FAF7F2] text-slate-800 selection:bg-orange-200 selection:text-orange-900"
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
        className="sr-only"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUploadFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Header */}
      <header className="h-16 px-6 lg:px-12 flex items-center justify-between border-b border-stone-200/60 bg-white/70 backdrop-blur-md sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedItem(null)}
            className="flex items-center gap-2.5 text-left group transition-transform active:scale-95"
          >
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center text-white shadow-[0_4px_12px_rgba(249,115,22,0.35)] group-hover:scale-105 transition-transform">
              <Scissors className="w-5 h-5 -rotate-45" />
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-stone-900 block leading-tight">
                AlphaMatte
              </span>
              <span className="text-[10px] text-stone-400 font-medium block leading-tight tracking-wider uppercase">
                Studio
              </span>
            </div>
          </button>
        </div>

        {selectedItem ? (
          <div className="flex items-center gap-3">
            <div className="clay-pill-speed px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 animate-pulse">
              <Zap className="w-3.5 h-3.5 fill-orange-500 text-orange-500" />
              <span>Обработано за {selectedItem.speedMs} мс</span>
            </div>
            <button
              type="button"
              onClick={() => setSelectedItem(null)}
              className="clay-button-secondary px-3.5 py-1.5 rounded-xl text-xs font-medium text-stone-700 flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Загрузить другое</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4 text-xs font-medium text-stone-500">
            <div className="hidden sm:flex items-center gap-1.5 bg-orange-50/80 text-orange-700 border border-orange-200/60 px-3 py-1 rounded-full">
              <Zap className="w-3.5 h-3.5 text-orange-500 fill-orange-500" />
              <span>Скорость от 34 мс · Без очередей</span>
            </div>
            <a
              href="https://github.com/VovanBloger/alphamatte-lab"
              target="_blank"
              rel="noreferrer"
              className="hover:text-stone-900 flex items-center gap-1 text-stone-600 transition-colors"
            >
              <Github className="w-4 h-4" />
              <span>GitHub</span>
            </a>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 md:p-10 relative">
        {/* Processing Overlay Toast */}
        {isProcessing && (
          <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-xs flex items-center justify-center z-50">
            <div className="clay-card p-8 rounded-3xl max-w-sm w-full text-center flex flex-col items-center shadow-2xl animate-in fade-in zoom-in-95 duration-200">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center text-white mb-4 shadow-lg shadow-orange-500/30 animate-bounce">
                <Sparkles className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-bold text-stone-900 mb-1">Мгновенный маттинг</h3>
              <p className="text-xs text-stone-500 mb-4">{processingStatus}</p>
              <div className="w-full bg-stone-100 rounded-full h-2 overflow-hidden">
                <div className="bg-gradient-to-r from-amber-500 to-orange-500 h-full w-2/3 animate-pulse rounded-full" />
              </div>
            </div>
          </div>
        )}

        {/* Notification Toast */}
        {toast && (
          <div
            className={`mb-6 p-4 rounded-2xl border text-xs font-medium max-w-xl w-full shadow-sm flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-200 ${
              toast.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {toast.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <span className="w-4 h-4 rounded-full bg-rose-200 text-rose-700 flex items-center justify-center text-[10px] font-bold shrink-0">
                  ✕
                </span>
              )}
              <span>{toast.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-stone-400 hover:text-stone-700 font-bold ml-2 shrink-0 p-1"
            >
              ✕
            </button>
          </div>
        )}

        {/* SCREEN 1: Clean Upload View (Screenshot 2 style) */}
        {!selectedItem ? (
          <div className="w-full max-w-3xl flex flex-col items-center text-center my-auto">
            {/* Hero Title */}
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-stone-900 mb-3 leading-tight">
              Удалить и заменить фон <br className="hidden sm:inline" />
              на фото и видео онлайн
            </h1>
            <p className="text-sm md:text-base text-stone-500 max-w-xl mb-10">
              Мгновенный альфа-маттинг для стикеров Telegram, фото и анимаций. Вырезает шерсть, волосы и прозрачность без нейросетевого мыла.
            </p>

            {/* Central Dropzone Card with "Попробуй фото бесплатно" sticker */}
            <div className="relative w-full max-w-lg mb-12">
              {/* Playful sticker tag pointing to the button (inspired by screenshot 2!) */}
              <div className="hidden sm:flex absolute -left-28 top-12 -rotate-6 z-10 flex-col items-end pointer-events-none">
                <div className="bg-[#ff8a3d] text-white text-xs font-bold px-3.5 py-1.5 rounded-xl shadow-md tracking-wide">
                  Попробуй бесплатно ✨
                </div>
                <svg
                  className="w-8 h-8 text-[#ff8a3d] mt-1 mr-4 -scale-x-100"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </div>

              {/* Clay Dropzone Card */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`clay-dropzone p-10 md:p-12 rounded-3xl border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center ${
                  isDragOver
                    ? 'border-orange-500 bg-orange-50/50 scale-102'
                    : 'border-stone-300 hover:border-orange-400 hover:bg-white'
                }`}
              >
                <div className="w-14 h-14 rounded-2xl bg-orange-100/70 text-orange-600 flex items-center justify-center mb-4 transition-transform group-hover:scale-110">
                  <Upload className="w-7 h-7" />
                </div>
                <h3 className="text-base font-semibold text-stone-800 mb-1">
                  Перетащите или загрузите фото
                </h3>
                <p className="text-xs text-stone-400 mb-6 font-medium">
                  PNG / JPEG / WEBP / MP4 / GIF. До 50 МБ.
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="clay-button-primary text-white font-semibold px-8 py-3 rounded-2xl text-sm shadow-md"
                >
                  Выбрать фото
                </button>
              </div>
            </div>

            {/* Examples Row: 4 complex benchmarks */}
            <div className="w-full flex flex-col items-center">
              <span className="text-xs font-medium text-stone-400 mb-4">
                Нет фотографии? Попробуй эти сложные примеры:
              </span>
              <div className="flex flex-wrap items-center justify-center gap-4">
                {FEATURED_EXAMPLES.map((ex) => (
                  <button
                    key={ex.id}
                    type="button"
                    onClick={() => handleSelectExample(ex)}
                    className="clay-card p-2.5 rounded-2xl flex items-center gap-3 hover:-translate-y-1 hover:shadow-lg transition-all text-left group border border-stone-200/50"
                  >
                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-stone-100 border border-stone-200 shrink-0 relative">
                      <img
                        src={resolveAssetUrl(ex.thumb)}
                        alt={ex.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform"
                      />
                      {ex.isVideo && (
                        <div className="absolute bottom-0.5 right-0.5 bg-black/70 text-[9px] text-white px-1 rounded-sm font-semibold">
                          ▶
                        </div>
                      )}
                    </div>
                    <div className="pr-2">
                      <div className="text-xs font-bold text-stone-800 group-hover:text-orange-600 transition-colors">
                        {ex.title}
                      </div>
                      <div className="text-[10px] text-stone-400 font-medium">
                        {ex.subtitle}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* SCREEN 2: Result View (Screenshot 3 style) */
          <div className="w-full max-w-6xl flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-12 my-auto">
            {/* Center: Split Viewport */}
            <div className="w-full lg:flex-1 max-w-2xl">
              <CleanSplitViewer
                originalSrc={selectedItem.original}
                processedSrc={selectedItem.processed}
                isVideo={selectedItem.isVideo}
                isGif={selectedItem.isGif}
                rawFrames={selectedItem.rawFrames}
                mattedFrames={selectedItem.mattedFrames}
                frameWidth={selectedItem.width}
                frameHeight={selectedItem.height}
                fps={selectedItem.fps}
                altTitle={selectedItem.title}
                backdrop={backdrop}
                onChangeBackdrop={setBackdrop}
                stickerEffects={stickerEffects}
              />
            </div>

            {/* Right Action Panel (Carve.Photos screenshot 3 style) */}
            <div className="w-full lg:w-80 flex flex-col gap-4">
              {/* Speed Card */}
              <div className="clay-card p-5 rounded-3xl border border-stone-200/60 flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-orange-500/10 text-orange-600 flex items-center justify-center shrink-0">
                  <Zap className="w-5 h-5 fill-orange-500" />
                </div>
                <div>
                  <div className="text-xs text-stone-400 font-medium">Скорость алгоритма</div>
                  <div className="text-base font-bold text-stone-900">
                    {selectedItem.speedMs} мс
                  </div>
                </div>
              </div>

              {/* Sticker Style Card (Stroke & Shadow settings) */}
              <div className="clay-card p-5 rounded-3xl border border-stone-200/60 flex flex-col gap-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-xl bg-orange-500/10 text-orange-600 flex items-center justify-center">
                      <Sparkles className="w-3.5 h-3.5 fill-orange-500" />
                    </div>
                    <span className="text-xs font-bold text-stone-800">Стиль стикера</span>
                  </div>
                  {(stickerEffects.strokeWidth > 0 || stickerEffects.shadowPreset !== 'none') && (
                    <button
                      type="button"
                      onClick={() => setStickerEffects(DEFAULT_STICKER_EFFECTS)}
                      className="text-[11px] font-medium text-stone-400 hover:text-orange-600 transition-colors"
                    >
                      Сбросить
                    </button>
                  )}
                </div>

                {/* Section: Stroke Width */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-stone-500">Обводка (контур)</span>
                    <span className="text-[10px] text-stone-400 font-medium">
                      {stickerEffects.strokeWidth === 0
                        ? 'Без обводки'
                        : `${stickerEffects.strokeWidth} px`}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: 'Нет', val: 0 },
                      { label: '4 px', val: 4 },
                      { label: '8 px', val: 8 },
                      { label: '14 px', val: 14 },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() =>
                          setStickerEffects((prev) => ({ ...prev, strokeWidth: opt.val }))
                        }
                        className={`py-1.5 px-2 rounded-xl text-xs font-semibold transition-all ${
                          stickerEffects.strokeWidth === opt.val
                            ? 'bg-orange-500 text-white shadow-sm'
                            : 'bg-stone-100 hover:bg-stone-200/80 text-stone-700'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section: Stroke Color (only if strokeWidth > 0) */}
                {stickerEffects.strokeWidth > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold text-stone-500 mb-1.5">
                      Цвет обводки
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {[
                        { color: '#ffffff', name: 'Белый' },
                        { color: '#1e293b', name: 'Тёмный' },
                        { color: '#fbbf24', name: 'Жёлтый' },
                        { color: '#f43f5e', name: 'Розовый' },
                        { color: '#38bdf8', name: 'Голубой' },
                        { color: '#22c55e', name: 'Зелёный' },
                      ].map((c) => (
                        <button
                          key={c.color}
                          type="button"
                          onClick={() =>
                            setStickerEffects((prev) => ({ ...prev, strokeColor: c.color }))
                          }
                          title={c.name}
                          className={`w-6 h-6 rounded-full border-2 transition-transform ${
                            stickerEffects.strokeColor.toLowerCase() === c.color.toLowerCase()
                              ? 'scale-125 border-orange-500 shadow-sm'
                              : 'border-stone-300 hover:scale-110'
                          }`}
                          style={{ backgroundColor: c.color }}
                        />
                      ))}
                      <label
                        title="Выбрать свой цвет"
                        className="relative w-6 h-6 rounded-full border-2 border-dashed border-stone-300 hover:border-orange-500 flex items-center justify-center cursor-pointer hover:scale-110 transition-transform overflow-hidden"
                      >
                        <input
                          type="color"
                          value={stickerEffects.strokeColor}
                          onChange={(e) =>
                            setStickerEffects((prev) => ({
                              ...prev,
                              strokeColor: e.target.value,
                            }))
                          }
                          className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                        />
                        <div
                          className="w-full h-full"
                          style={{
                            background:
                              'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                          }}
                        />
                      </label>
                    </div>
                  </div>
                )}

                {/* Section: Shadow Preset */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-semibold text-stone-500">Тень</span>
                    <span className="text-[10px] text-stone-400 font-medium">
                      {stickerEffects.shadowPreset === 'none'
                        ? 'Без тени'
                        : stickerEffects.shadowPreset === 'soft'
                        ? 'Мягкая'
                        : stickerEffects.shadowPreset === 'sticker'
                        ? 'Стикер'
                        : '3D объём'}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { id: 'none' as const, label: 'Нет' },
                      { id: 'soft' as const, label: 'Мягкая' },
                      { id: 'sticker' as const, label: 'Стикер' },
                      { id: 'deep3d' as const, label: '3D' },
                    ].map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          setStickerEffects((prev) => ({ ...prev, shadowPreset: s.id }))
                        }
                        className={`py-1.5 px-2 rounded-xl text-xs font-semibold transition-all ${
                          stickerEffects.shadowPreset === s.id
                            ? 'bg-orange-500 text-white shadow-sm'
                            : 'bg-stone-100 hover:bg-stone-200/80 text-stone-700'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Download Buttons Card (Compliant with Telegram @Stickers specs) */}
              <div className="clay-card p-6 rounded-3xl border border-stone-200/60 flex flex-col gap-3">
                {selectedItem.isVideo ? (
                  <>
                    {/* Primary: WebM Video Sticker */}
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => handleDownload(selectedItem, 'tg-webm')}
                      className="clay-button-primary w-full py-3.5 px-5 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md disabled:opacity-50 transition-transform active:scale-98"
                    >
                      <Download className="w-4 h-4" />
                      <span>{isExporting ? 'Экспорт...' : 'Скачать видео-стикер (WebM)'}</span>
                    </button>
                    <div className="text-[10px] text-stone-400 text-center -mt-1 font-medium">
                      Для Telegram @Stickers · 512px · VP9 · ≤ 256 КБ · без звука
                    </div>

                    {/* Secondary: Frame 0 as Static 512px WebP Sticker */}
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => handleDownload(selectedItem, 'tg-sticker')}
                      className="clay-button-secondary w-full py-2.5 px-5 rounded-2xl text-stone-700 font-semibold text-xs flex items-center justify-center gap-2 disabled:opacity-50 transition-transform active:scale-98"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-orange-500" />
                      <span>Скачать кадр как стикер (WebP 512px)</span>
                    </button>
                  </>
                ) : (
                  <>
                    {/* Primary: 512px Transparent WebP Sticker for Telegram */}
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => handleDownload(selectedItem, 'tg-sticker')}
                      className="clay-button-primary w-full py-3.5 px-5 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md disabled:opacity-50 transition-transform active:scale-98"
                    >
                      <Download className="w-4 h-4" />
                      <span>
                        {isExporting ? 'Подготовка WebP...' : 'Скачать стикер для Telegram (WebP)'}
                      </span>
                    </button>
                    <div className="text-[10px] text-stone-400 text-center -mt-1 font-medium">
                      Для Telegram @Stickers · строго 512px · WebP · ≤ 512 КБ
                    </div>

                    {/* Secondary: Original Full-Res HD Cutout PNG */}
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => handleDownload(selectedItem, 'hd-png')}
                      className="clay-button-secondary w-full py-2.5 px-5 rounded-2xl text-stone-700 font-semibold text-xs flex items-center justify-center gap-2 disabled:opacity-50 transition-transform active:scale-98"
                    >
                      <ImageIcon className="w-3.5 h-3.5 text-stone-500" />
                      <span>Скачать HD без фона (PNG)</span>
                    </button>
                    <div className="text-[10px] text-stone-400 text-center -mt-1 font-medium">
                      Оригинальное разрешение (для дизайна и печати)
                    </div>
                  </>
                )}

                {/* Info Text */}
                <div className="text-[11px] text-stone-400 text-center mt-2 border-t border-stone-100 pt-2">
                  {selectedItem.description}
                </div>
              </div>

              {/* Upload Another Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="clay-button-secondary w-full py-3 px-5 rounded-2xl text-stone-800 font-semibold text-xs flex items-center justify-center gap-2"
              >
                <Upload className="w-4 h-4 text-orange-500" />
                <span>Загрузить другое фото или видео</span>
              </button>

              {/* Quick Switcher for Other Examples */}
              <div className="pt-2">
                <div className="text-[11px] font-semibold text-stone-400 mb-2 px-1">
                  Попробовать другие примеры:
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {FEATURED_EXAMPLES.map((ex) => (
                    <button
                      key={ex.id}
                      type="button"
                      onClick={() => handleSelectExample(ex)}
                      title={ex.title}
                      className={`relative aspect-square rounded-2xl overflow-hidden border-2 transition-all p-0.5 ${
                        selectedItem.id === ex.id
                          ? 'border-orange-500 scale-105 shadow-md'
                          : 'border-stone-200 hover:border-stone-300 opacity-80 hover:opacity-100'
                      }`}
                    >
                      <img
                        src={resolveAssetUrl(ex.thumb)}
                        alt={ex.title}
                        className="w-full h-full object-cover rounded-xl"
                      />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Minimal Footer */}
      <footer className="py-4 text-center text-xs text-stone-400 border-t border-stone-200/50 bg-white/40">
        AlphaMatte Studio · Сверхбыстрый альфа-маттинг фото и видео-стикеров Telegram · 2026
      </footer>
    </div>
  );
}
