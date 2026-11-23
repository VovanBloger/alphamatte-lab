import React, { useRef, useState } from 'react';
import { Download, MoveHorizontal } from 'lucide-react';
import type { BackdropMode, CellMetric, ComparisonMode } from '../types/bench';
import {
  clampSplitRatio,
  getComparisonImageSources,
  getComparisonLabels,
} from '../utils/telemetryMath';
import { resolveAssetUrl } from '../utils/assetUrl';

interface ComparisonViewportProps {
  selectedCell: CellMetric | null;
  isSheetView: boolean;
  comparisonMode: ComparisonMode;
  backdropMode: BackdropMode;
  zoom: number;
  splitPercent: number;
  onChangeSplitPercent: (value: number) => void;
  pan: { x: number; y: number };
  onChangePan: (pan: { x: number; y: number }) => void;
  onDropFiles?: (files: FileList) => void;
}

function getBackdropClasses(backdropMode: BackdropMode): string {
  switch (backdropMode) {
    case 'checker_light':
      return 'checkerboard-bg';
    case 'checker_dark':
      return 'checkerboard-dark';
    case 'solid_dark':
      return 'bg-[#262626]';
    case 'solid_white':
      return 'bg-white';
    case 'chroma_green':
      return 'bg-[#00d26a]';
  }
}

export const ComparisonViewport: React.FC<ComparisonViewportProps> = ({
  selectedCell,
  isSheetView,
  comparisonMode,
  backdropMode,
  zoom,
  splitPercent,
  onChangeSplitPercent,
  pan,
  onChangePan,
  onDropFiles,
}) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [draggingPan, setDraggingPan] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const panOriginRef = useRef<{ startX: number; startY: number; origX: number; origY: number }>({
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });

  const labels = getComparisonLabels(comparisonMode);

  let leftSrc = resolveAssetUrl('/assets/aistudio/sheet_0790b517.jpg');
  let rightSrc = resolveAssetUrl('/bench/v53/preview.png');

  if (isSheetView) {
    if (comparisonMode === 'orig_vs_v53') {
      leftSrc = resolveAssetUrl('/assets/aistudio/sheet_0790b517.jpg');
      rightSrc = resolveAssetUrl('/bench/v53/preview.png');
    } else if (comparisonMode === 'v52_vs_v53') {
      leftSrc = resolveAssetUrl('/bench/v52/preview.png');
      rightSrc = resolveAssetUrl('/bench/v53/preview.png');
    } else if (comparisonMode === 'alpha_v52_vs_v53') {
      leftSrc = resolveAssetUrl('/bench/v52/alpha-mask.png');
      rightSrc = resolveAssetUrl('/bench/v53/alpha-mask.png');
    } else {
      leftSrc = resolveAssetUrl('/bench/v53/alpha-mask.png');
      rightSrc = resolveAssetUrl('/bench/v53/preview.png');
    }
  } else if (selectedCell) {
    const srcs = getComparisonImageSources(selectedCell, comparisonMode);
    leftSrc = resolveAssetUrl(srcs.leftSrc);
    rightSrc = resolveAssetUrl(srcs.rightSrc);
  }

  const updateSplitFromClientX = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    onChangeSplitPercent(clampSplitRatio(pct));
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom > 1 && (e.shiftKey || e.button === 1 || labels.isSingleOverlay)) {
      setDraggingPan(true);
      panOriginRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: pan.x,
        origY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (!labels.isSingleOverlay) {
      setDraggingSplit(true);
      updateSplitFromClientX(e.clientX);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingSplit) {
      updateSplitFromClientX(e.clientX);
    } else if (draggingPan) {
      const dx = e.clientX - panOriginRef.current.startX;
      const dy = e.clientY - panOriginRef.current.startY;
      onChangePan({
        x: panOriginRef.current.origX + dx,
        y: panOriginRef.current.origY + dy,
      });
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingSplit || draggingPan) {
      setDraggingSplit(false);
      setDraggingPan(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const backdropClass =
    comparisonMode === 'alpha_v52_vs_v53' || comparisonMode === 'diff_heatmap'
      ? 'bg-slate-950'
      : getBackdropClasses(backdropMode);

  const imgTransformStyle = {
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
  };

  return (
    <section
      aria-label="Окно визуального сравнения до и после"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setFileDragOver(true);
        }
      }}
      onDragLeave={() => setFileDragOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setFileDragOver(false);
          onDropFiles?.(e.dataTransfer.files);
        }
      }}
      className="flex-1 flex flex-col min-h-0 bg-[#090e1a] overflow-hidden relative"
    >
      {/* Inspector metadata bar */}
      <div className="px-5 py-2.5 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between gap-4 shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-100 truncate">
            {isSheetView
              ? 'Полный лист стикеров (3×4, 3584×4800)'
              : selectedCell
                ? `${selectedCell.isCustom ? 'Моё фото: ' : `${String(selectedCell.id).padStart(2, '0')}. `}${selectedCell.title}`
                : 'Загрузка...'}
          </h2>
          <p className="text-xs text-slate-400 truncate mt-0.5">
            {isSheetView
              ? 'Общий обзор 12 сложных объектов: шерсть, усы, дым, пар, мыльные пузыри, боке и одуванчик'
              : selectedCell?.challenge}
          </p>
        </div>

        {selectedCell && !isSheetView && (
          <div className="hidden lg:flex items-center gap-2.5 text-xs font-mono text-slate-400 shrink-0 whitespace-nowrap">
            {selectedCell.semanticClass && (
              <>
                <span
                  className={selectedCell.semanticClass === 'human' ? 'text-sky-300 font-medium' : 'text-amber-300 font-medium'}
                >
                  {selectedCell.semanticClass === 'human' ? 'Человек' : 'Животное'}
                </span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>
              v5.2: <strong className="text-slate-200 font-medium">{selectedCell.v52Ms} ms</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              v5.3: <strong className="text-emerald-400 font-medium">{selectedCell.v53QualMs} ms</strong>
            </span>
            {selectedCell.textureRecoveredPixels && selectedCell.textureRecoveredPixels > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  6C Тени:{' '}
                  <strong className="text-emerald-300 font-medium">
                    +{selectedCell.textureRecoveredPixels.toLocaleString('ru-RU')} px
                  </strong>
                </span>
              </>
            ) : typeof selectedCell.grayHaloReductionPct === 'number' ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Ореол:{' '}
                  <strong className="text-sky-300 font-medium">
                    {selectedCell.grayHaloReductionPct >= 0 ? '−' : '+'}
                    {Math.abs(selectedCell.grayHaloReductionPct)}%
                  </strong>
                </span>
              </>
            ) : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  PSNR: <strong className="text-sky-300 font-medium">{selectedCell.exactPsnrDb} dB</strong>
                </span>
              </>
            )}
            {selectedCell.isVideo && selectedCell.videoWebmUrl && (
              <a
                href={resolveAssetUrl(selectedCell.videoWebmUrl)}
                download={`${selectedCell.title.replace(/\s+/g, '_')}_tg_sticker.webm`}
                className="ml-1 inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-500/60 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 font-sans text-[11px] font-medium transition-colors whitespace-nowrap"
                title="Скачать Telegram Video Sticker (512x512, VP9 Alpha yuva420p, <=256KB)"
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                WebM (TG Sticker)
              </a>
            )}
            {selectedCell.isVideo && selectedCell.videoWebpUrl && (
              <a
                href={resolveAssetUrl(selectedCell.videoWebpUrl)}
                download={`${selectedCell.title.replace(/\s+/g, '_')}_animated.webp`}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/60 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 font-sans text-[11px] font-medium transition-colors whitespace-nowrap"
                title="Скачать анимированный WebP с прозрачностью"
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                WebP (Анимация)
              </a>
            )}
            <a
              href={resolveAssetUrl(selectedCell.assets.v53)}
              download={`${selectedCell.title.replace(/\s+/g, '_')}_${selectedCell.isVideo ? 'poster' : 'v53'}.png`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-700 bg-slate-900 hover:border-slate-500 hover:text-slate-100 text-slate-300 font-sans text-[11px] transition-colors whitespace-nowrap"
              title={selectedCell.isVideo ? "Скачать прозрачный PNG постер" : "Скачать прозрачный PNG (v5.3)"}
            >
              <Download className="w-3 h-3" aria-hidden="true" />
              PNG {selectedCell.isVideo ? 'Постер' : 'v5.3'}
            </a>
          </div>
        )}
      </div>

      {/* Main Comparison Canvas */}
      <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-hidden">
        <div
          ref={stageRef}
          data-testid="comparison-stage"
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handleStagePointerUp}
          className={`relative w-full h-full max-w-[780px] rounded-lg border overflow-hidden select-none ${backdropClass} ${
            fileDragOver ? 'border-sky-400 ring-2 ring-sky-400/40' : 'border-slate-800'
          } ${labels.isSingleOverlay ? 'cursor-grab' : 'cursor-ew-resize'}`}
        >
          {/* Right / Base Layer */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none transition-transform duration-75"
            style={imgTransformStyle}
          >
            {!isSheetView &&
            selectedCell?.isVideo &&
            selectedCell.videoWebmUrl &&
            (comparisonMode === 'orig_vs_v53' || comparisonMode === 'v52_vs_v53') ? (
              <video
                src={resolveAssetUrl(selectedCell.videoWebmUrl)}
                autoPlay
                loop
                muted
                playsInline
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <img
                src={labels.isSingleOverlay ? leftSrc : rightSrc}
                alt={labels.isSingleOverlay ? labels.leftLabel : labels.rightLabel}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            )}
          </div>

          {/* Left / Clipped Before Layer */}
          {!labels.isSingleOverlay && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
            >
              <div
                className="w-full h-full flex items-center justify-center transition-transform duration-75"
                style={imgTransformStyle}
              >
                <img
                  src={leftSrc}
                  alt={labels.leftLabel}
                  referrerPolicy="no-referrer"
                  className="max-w-full max-h-full object-contain"
                  draggable={false}
                />
              </div>
            </div>
          )}

          {/* Split Curtain Divider */}
          {!labels.isSingleOverlay && (
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-px bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.65)] pointer-events-none"
              style={{ left: `${splitPercent}%` }}
            >
              <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-slate-950/90 border border-sky-400 text-sky-300 flex items-center justify-center shadow-md">
                <MoveHorizontal className="w-4 h-4" />
              </div>
            </div>
          )}

          {/* Corner Scrim Labels */}
          <div className="absolute top-3 left-3 px-2.5 py-1 rounded bg-slate-950/80 border border-slate-800/90 text-[11px] font-medium text-slate-200 pointer-events-none">
            {labels.leftLabel}
          </div>
          {!labels.isSingleOverlay && (
            <div className="absolute top-3 right-3 px-2.5 py-1 rounded bg-slate-950/80 border border-slate-800/90 text-[11px] font-medium text-sky-200 pointer-events-none">
              {labels.rightLabel}
            </div>
          )}

          {/* Legend for Diff Heatmap */}
          {comparisonMode === 'diff_heatmap' && (
            <div className="absolute bottom-3 left-3 right-3 px-3 py-1.5 rounded bg-slate-950/85 border border-slate-800 text-[11px] text-slate-300 flex items-center justify-between gap-4 pointer-events-none">
              <span>Изумрудный: v5.3 восстановил плотность (кружка, ткань, тонкие пряди)</span>
              <span className="text-rose-300 shrink-0">Красный: v5.3 очистил застрявший фон / ореол</span>
            </div>
          )}

          {zoom > 1 && (
            <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded bg-slate-950/80 border border-slate-800 text-[11px] font-mono text-slate-300 pointer-events-none">
              {zoom}× · Shift + перетаскивание для панорамы
            </div>
          )}

          {fileDragOver && (
            <div className="absolute inset-0 bg-slate-950/80 flex items-center justify-center pointer-events-none">
              <div className="px-5 py-3 rounded-lg border border-sky-400 bg-slate-900 text-sm font-medium text-sky-200">
                Отпустите фото для запуска сравнения v5.2 vs v5.3
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
