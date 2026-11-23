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

export interface FeaturedItem {
  id: number;
  title: string;
  subtitle: string;
  category: string;
  thumb: string;
  original: string;
  processed: string;
  isVideo?: boolean;
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
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const customIdRef = useRef<number>(200);

  const handleSelectExample = (ex: FeaturedItem) => {
    setSelectedItem(ex);
    setBackdrop('checker');
  };

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || isVideoOrGifFile(f)
    );
    if (files.length === 0) {
      setErrorToast('Пожалуйста, выберите фото (PNG, JPEG, WebP) или видео/GIF (MP4, GIF).');
      return;
    }

    const file = files[0];
    const isVid = isVideoOrGifFile(file);
    setIsProcessing(true);
    setProcessingStatus(isVid ? 'Подготовка видео → WebM...' : 'Удаление фона AlphaMatte...');
    setErrorToast(null);

    const t0 = performance.now();
    try {
      const newId = customIdRef.current++;
      const cell = isVid
        ? await processCustomVideoOrGifFile(file, newId, (msg) => setProcessingStatus(msg))
        : await processCustomPhotoFile(file, newId);

      const elapsed = Math.round(performance.now() - t0);
      const isActuallyVideo = Boolean(cell.animatedWebmUrl);

      const customItem: FeaturedItem = {
        id: newId,
        title: file.name.replace(/\.[^/.]+$/, ''),
        subtitle: isActuallyVideo ? 'Пользовательское видео' : 'Пользовательское фото',
        category: 'Моё фото',
        thumb: cell.previewUrl,
        original: cell.origUrl,
        processed: isActuallyVideo ? (cell.animatedWebmUrl ?? cell.previewUrl) : cell.previewUrl,
        isVideo: isActuallyVideo,
        speedMs: cell.v53Ms > 0 ? cell.v53Ms : elapsed,
        badge: `${cell.v53Ms > 0 ? cell.v53Ms : elapsed} мс`,
        description: `Разрешение: ${cell.width}×${cell.height} px · Алгоритм v5.3 Turbo`,
        downloadName: isActuallyVideo
          ? `${file.name.replace(/\.[^/.]+$/, '')}-sticker.webm`
          : `${file.name.replace(/\.[^/.]+$/, '')}-cutout.png`,
        downloadType: isActuallyVideo ? 'video/webm' : 'image/png',
      };

      setSelectedItem(customItem);
      setBackdrop('checker');
    } catch (err) {
      setErrorToast(err instanceof Error ? err.message : 'Ошибка при обработке изображения');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownload = (item: FeaturedItem, format: 'hd' | 'webp' = 'hd') => {
    const isWebm = item.isVideo || item.downloadType === 'video/webm';
    const href = resolveAssetUrl(item.processed);
    const a = document.createElement('a');
    a.href = href;
    a.download = format === 'webp' ? item.downloadName.replace(/\.(png|webm)$/, '.webp') : item.downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

        {/* Error Toast */}
        {errorToast && (
          <div className="mb-6 p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium max-w-md w-full shadow-sm flex items-center justify-between gap-3">
            <span>{errorToast}</span>
            <button
              type="button"
              onClick={() => setErrorToast(null)}
              className="text-rose-500 hover:text-rose-700 font-bold"
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
                altTitle={selectedItem.title}
                backdrop={backdrop}
                onChangeBackdrop={setBackdrop}
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

              {/* Download Buttons Card */}
              <div className="clay-card p-6 rounded-3xl border border-stone-200/60 flex flex-col gap-3">
                {/* Primary Button */}
                <button
                  type="button"
                  onClick={() => handleDownload(selectedItem, 'hd')}
                  className="clay-button-primary w-full py-3.5 px-5 rounded-2xl text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md"
                >
                  <Download className="w-4 h-4" />
                  <span>
                    {selectedItem.isVideo ? 'Скачать стикер (WebM)' : 'Скачать HD'}
                  </span>
                </button>

                {/* Secondary Button */}
                <button
                  type="button"
                  onClick={() => handleDownload(selectedItem, 'webp')}
                  className="clay-button-secondary w-full py-2.5 px-5 rounded-2xl text-stone-700 font-semibold text-xs flex items-center justify-center gap-2"
                >
                  <span>Скачать WebP</span>
                </button>

                {/* Info Text */}
                <div className="text-[11px] text-stone-400 text-center mt-1">
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
