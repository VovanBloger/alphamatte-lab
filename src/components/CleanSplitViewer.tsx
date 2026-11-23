import React, { useRef, useState, useEffect } from 'react';
import { MoveHorizontal, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { resolveAssetUrl } from '../utils/assetUrl';

export type BackdropColor = 'checker' | 'dark' | 'white' | 'green';

interface CleanSplitViewerProps {
  originalSrc: string;
  processedSrc: string;
  isVideo?: boolean;
  isGif?: boolean;
  rawFrames?: Uint8ClampedArray[];
  mattedFrames?: Uint8ClampedArray[];
  frameWidth?: number;
  frameHeight?: number;
  fps?: number;
  altTitle?: string;
  backdrop: BackdropColor;
  onChangeBackdrop: (bg: BackdropColor) => void;
}

export const CleanSplitViewer: React.FC<CleanSplitViewerProps> = ({
  originalSrc,
  processedSrc,
  isVideo = false,
  isGif = false,
  rawFrames,
  mattedFrames,
  frameWidth,
  frameHeight,
  fps = 20,
  altTitle = 'Сравнение',
  backdrop,
  onChangeBackdrop,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftVideoRef = useRef<HTMLVideoElement>(null);
  const rightVideoRef = useRef<HTMLVideoElement>(null);
  const rightCanvasRef = useRef<HTMLCanvasElement>(null);

  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<{ startX: number; startY: number; origX: number; origY: number }>({
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  const hasCanvasFrames = Boolean(mattedFrames && mattedFrames.length > 0 && frameWidth && frameHeight);

  // Canvas loop for custom video / GIF frames with 100% alpha transparency
  useEffect(() => {
    if (!hasCanvasFrames || !mattedFrames || !frameWidth || !frameHeight) return;
    let animId: number;
    let frameIdx = 0;
    const interval = 1000 / fps;
    let lastTime = performance.now();

    const canvas = rightCanvasRef.current;
    if (!canvas) return;
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = (now: number) => {
      if (now - lastTime >= interval) {
        lastTime = now;
        const f = mattedFrames[frameIdx];
        if (f) {
          const imgData = new ImageData(
            new Uint8ClampedArray(f.buffer, f.byteOffset, f.byteLength),
            frameWidth,
            frameHeight
          );
          ctx.putImageData(imgData, 0, 0);
        }
        frameIdx = (frameIdx + 1) % mattedFrames.length;
      }
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [hasCanvasFrames, mattedFrames, frameWidth, frameHeight, fps]);

  // Sync video playbacks if in video mode without canvas frames
  useEffect(() => {
    if (!isVideo || hasCanvasFrames) return;
    const v1 = leftVideoRef.current;
    const v2 = rightVideoRef.current;
    if (v1) {
      v1.currentTime = 0;
      v1.play().catch(() => {});
    }
    if (v2) {
      v2.currentTime = 0;
      v2.play().catch(() => {});
    }

    if (!v1 || !v2) return;
    const syncVideos = () => {
      if (Math.abs(v1.currentTime - v2.currentTime) > 0.08) {
        v2.currentTime = v1.currentTime;
      }
    };
    v1.addEventListener('timeupdate', syncVideos);
    return () => {
      v1.removeEventListener('timeupdate', syncVideos);
    };
  }, [isVideo, hasCanvasFrames, originalSrc, processedSrc]);

  const updateSplit = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.max(0, Math.min(100, pct)));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('[data-no-drag]')) return;

    if (zoom > 1 && (e.button === 1 || e.shiftKey)) {
      setIsPanning(true);
      panStartRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pan.x,
        origY: pan.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    setIsDragging(true);
    updateSplit(e.clientX);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanning) {
      const dx = e.clientX - panStartRef.current.startX;
      const dy = e.clientY - panStartRef.current.startY;
      setPan({
        x: panStartRef.current.origX + dx,
        y: panStartRef.current.origY + dy,
      });
      return;
    }
    if (isDragging) {
      updateSplit(e.clientX);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) setIsDragging(false);
    if (isPanning) setIsPanning(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  const getBackdropClass = () => {
    switch (backdrop) {
      case 'checker':
        return 'checkerboard-bg';
      case 'dark':
        return 'bg-[#18181b]';
      case 'white':
        return 'bg-white';
      case 'green':
        return 'bg-[#00e600]';
    }
  };

  const resolvedOrig = resolveAssetUrl(originalSrc);
  const resolvedProcessed = resolveAssetUrl(processedSrc);

  return (
    <div className="flex flex-col items-center w-full max-w-4xl mx-auto">
      {/* Viewport Card */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative w-full aspect-square max-h-[64vh] rounded-3xl overflow-hidden shadow-[0_20px_50px_rgba(45,35,20,0.12)] border border-white/80 select-none cursor-ew-resize bg-stone-100"
        style={{ touchAction: 'none' }}
      >
        {/* Transform container for Zoom & Pan */}
        <div
          className="w-full h-full relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isPanning ? 'none' : 'transform 0.15s ease-out',
          }}
        >
          {/* RIGHT SIDE: Processed / Cutout */}
          <div className={`absolute inset-0 w-full h-full ${getBackdropClass()}`}>
            {hasCanvasFrames ? (
              <canvas
                ref={rightCanvasRef}
                className="w-full h-full object-contain pointer-events-none"
              />
            ) : isVideo ? (
              <video
                ref={rightVideoRef}
                src={resolvedProcessed}
                autoPlay
                loop
                muted
                playsInline
                className="w-full h-full object-contain pointer-events-none"
              />
            ) : (
              <img
                src={resolvedProcessed}
                alt={`${altTitle} без фона`}
                className="w-full h-full object-contain pointer-events-none"
                draggable={false}
              />
            )}
          </div>

          {/* LEFT SIDE: Original (Clipped by splitPercent) */}
          <div
            className="absolute inset-0 h-full overflow-hidden bg-stone-100"
            style={{ width: `${splitPercent}%` }}
          >
            <div
              className="absolute inset-0 h-full"
              style={{ width: containerRef.current ? `${containerRef.current.clientWidth}px` : '100%' }}
            >
              {isGif ? (
                /* GIF must be rendered in <img> tag to play animation natively in all browsers */
                <img
                  src={resolvedOrig}
                  alt={`${altTitle} оригинал`}
                  className="w-full h-full object-contain pointer-events-none"
                  draggable={false}
                />
              ) : isVideo ? (
                <video
                  ref={leftVideoRef}
                  src={resolvedOrig}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="w-full h-full object-contain pointer-events-none"
                />
              ) : (
                <img
                  src={resolvedOrig}
                  alt={`${altTitle} оригинал`}
                  className="w-full h-full object-contain pointer-events-none"
                  draggable={false}
                />
              )}
            </div>
          </div>
        </div>

        {/* Split Divider Line & Handle */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/90 shadow-[0_0_10px_rgba(0,0,0,0.4)] pointer-events-none"
          style={{ left: `${splitPercent}%` }}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white shadow-[0_4px_14px_rgba(0,0,0,0.25)] flex items-center justify-center text-stone-700 pointer-events-auto cursor-ew-resize border border-stone-200 hover:scale-105 active:scale-95 transition-transform">
            <MoveHorizontal className="w-4 h-4 text-orange-600" />
          </div>
        </div>

        {/* Floating Badges "До" and "После" */}
        <div className="absolute top-4 left-4 pointer-events-none bg-stone-900/60 backdrop-blur-md text-white text-[11px] font-semibold tracking-wider px-3 py-1 rounded-full uppercase shadow-sm">
          До
        </div>
        <div className="absolute top-4 right-4 pointer-events-none bg-stone-900/60 backdrop-blur-md text-white text-[11px] font-semibold tracking-wider px-3 py-1 rounded-full uppercase shadow-sm">
          После
        </div>
      </div>

      {/* Under Viewport Controls */}
      <div className="flex flex-wrap items-center justify-between w-full mt-4 px-2 gap-3" data-no-drag>
        {/* Backdrop Switcher */}
        <div className="flex items-center gap-1.5 bg-white/80 backdrop-blur-sm p-1.5 rounded-2xl border border-stone-200/80 shadow-sm">
          <span className="text-xs text-stone-500 font-medium px-2">Фон:</span>
          <button
            type="button"
            onClick={() => onChangeBackdrop('checker')}
            className={`w-7 h-7 rounded-xl border flex items-center justify-center checkerboard-bg transition-all ${
              backdrop === 'checker' ? 'border-orange-500 ring-2 ring-orange-500/30 scale-105' : 'border-stone-300 opacity-70 hover:opacity-100'
            }`}
            title="Шахматка (прозрачный)"
          />
          <button
            type="button"
            onClick={() => onChangeBackdrop('dark')}
            className={`w-7 h-7 rounded-xl border bg-[#18181b] transition-all ${
              backdrop === 'dark' ? 'border-orange-500 ring-2 ring-orange-500/30 scale-105' : 'border-stone-300 opacity-70 hover:opacity-100'
            }`}
            title="Тёмный фон"
          />
          <button
            type="button"
            onClick={() => onChangeBackdrop('white')}
            className={`w-7 h-7 rounded-xl border bg-white transition-all ${
              backdrop === 'white' ? 'border-orange-500 ring-2 ring-orange-500/30 scale-105' : 'border-stone-300 opacity-70 hover:opacity-100'
            }`}
            title="Белый фон"
          />
          <button
            type="button"
            onClick={() => onChangeBackdrop('green')}
            className={`w-7 h-7 rounded-xl border bg-[#00e600] transition-all ${
              backdrop === 'green' ? 'border-orange-500 ring-2 ring-orange-500/30 scale-105' : 'border-stone-300 opacity-70 hover:opacity-100'
            }`}
            title="Зелёный (проверка ореола)"
          />
        </div>

        {/* Quick Split Percent Presets */}
        <div className="flex items-center gap-1 bg-white/80 backdrop-blur-sm p-1 rounded-2xl border border-stone-200/80 shadow-sm text-xs font-medium text-stone-600">
          <button
            type="button"
            onClick={() => setSplitPercent(100)}
            className={`px-3 py-1 rounded-xl transition-all ${
              splitPercent >= 98 ? 'bg-orange-500 text-white font-semibold shadow-xs' : 'hover:bg-stone-100'
            }`}
          >
            Только «До»
          </button>
          <button
            type="button"
            onClick={() => setSplitPercent(50)}
            className={`px-3 py-1 rounded-xl transition-all ${
              Math.abs(splitPercent - 50) < 2 ? 'bg-orange-500 text-white font-semibold shadow-xs' : 'hover:bg-stone-100'
            }`}
          >
            50% Сплит
          </button>
          <button
            type="button"
            onClick={() => setSplitPercent(0)}
            className={`px-3 py-1 rounded-xl transition-all ${
              splitPercent <= 2 ? 'bg-orange-500 text-white font-semibold shadow-xs' : 'hover:bg-stone-100'
            }`}
          >
            Только «После»
          </button>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 bg-white/80 backdrop-blur-sm p-1 rounded-2xl border border-stone-200/80 shadow-sm text-xs text-stone-600">
          <button
            type="button"
            onClick={() => setZoom((z) => (z === 1 ? 2 : 1))}
            className="p-1.5 hover:bg-stone-100 rounded-xl transition-colors flex items-center gap-1 font-medium"
            title="Увеличение"
          >
            {zoom > 1 ? <ZoomOut className="w-3.5 h-3.5 text-stone-700" /> : <ZoomIn className="w-3.5 h-3.5 text-stone-700" />}
            <span>{zoom}×</span>
          </button>
          {zoom > 1 && (
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="p-1.5 hover:bg-stone-100 rounded-xl transition-colors text-stone-500"
              title="Сброс масштаба"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
