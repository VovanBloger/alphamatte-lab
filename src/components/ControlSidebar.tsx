import React, { useRef, useState } from 'react';
import {
  Grid2x2,
  Layers,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Upload,
  Loader2,
} from 'lucide-react';
import type { BackdropMode, CellMetric, ComparisonMode } from '../types/bench';
import { filterCellsByCategory } from '../utils/telemetryMath';
import { resolveAssetUrl } from '../utils/assetUrl';

interface ControlSidebarProps {
  cells: CellMetric[];
  selectedCellId: number | 'sheet';
  onSelectCell: (id: number | 'sheet') => void;
  comparisonMode: ComparisonMode;
  onChangeComparisonMode: (mode: ComparisonMode) => void;
  backdropMode: BackdropMode;
  onChangeBackdropMode: (mode: BackdropMode) => void;
  zoom: number;
  onChangeZoom: (zoom: number) => void;
  splitPercent: number;
  onChangeSplitPercent: (value: number) => void;
  onResetView: () => void;
  categoryFilter: string;
  onChangeCategoryFilter: (cat: string) => void;
  onUploadFiles: (files: FileList | File[]) => void;
  uploadingLabel: string | null;
  uploadError: string | null;
}

const COMPARISON_MODES: Array<{ id: ComparisonMode; label: string; hint: string }> = [
  { id: 'orig_vs_v53', label: 'Оригинал / v5.3', hint: 'До и после удаления фона' },
  { id: 'v52_vs_v53', label: 'v5.2 / v5.3 RGBA', hint: 'Сравнение готовых стикеров' },
  { id: 'alpha_v52_vs_v53', label: 'Альфа v5.2 / v5.3', hint: 'Сравнение масок прозрачности' },
  { id: 'diff_heatmap', label: 'Карта отличий', hint: 'Зелёный = восстановлено, красный = очищено' },
];

const BACKDROPS: Array<{ id: BackdropMode; label: string; swatchClass: string }> = [
  { id: 'checker_light', label: 'Шахматка (св.)', swatchClass: 'checkerboard-bg' },
  { id: 'checker_dark', label: 'Шахматка (тём.)', swatchClass: 'checkerboard-dark' },
  { id: 'solid_dark', label: 'Тёмный фон', swatchClass: 'bg-slate-950' },
  { id: 'solid_white', label: 'Белый фон', swatchClass: 'bg-white' },
  { id: 'chroma_green', label: 'Зелёный тест', swatchClass: 'bg-emerald-500' },
];

const CATEGORIES = [
  'Все',
  'Telegram Стикеры',
  'Люди: волосы',
  'Мои фото',
  'Шерсть и усы',
  'Полупрозрачность',
  'Дым и пар',
  'Свечение и боке',
  'Тон в тон',
  'Микродетали',
];

export const ControlSidebar: React.FC<ControlSidebarProps> = ({
  cells,
  selectedCellId,
  onSelectCell,
  comparisonMode,
  onChangeComparisonMode,
  backdropMode,
  onChangeBackdropMode,
  zoom,
  onChangeZoom,
  splitPercent,
  onChangeSplitPercent,
  onResetView,
  categoryFilter,
  onChangeCategoryFilter,
  onUploadFiles,
  uploadingLabel,
  uploadError,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const filteredCells = filterCellsByCategory(cells, categoryFilter);
  const humanCount = cells.filter((c) => c.domain === 'humans').length;
  const customCount = cells.filter((c) => c.isCustom).length;

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  return (
    <aside
      aria-label="Панель управления сравнением"
      className="w-72 shrink-0 border-r border-slate-800 bg-slate-900/95 flex flex-col overflow-hidden"
    >
      {/* Mode & Backdrop Controls */}
      <div className="p-3.5 border-b border-slate-800 space-y-3.5">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              Режим сравнения
            </span>
          </div>
          <div className="grid grid-cols-1 gap-1">
            {COMPARISON_MODES.map((m) => {
              const active = comparisonMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onChangeComparisonMode(m.id)}
                  className={`text-left px-2.5 py-1.5 rounded-md border text-xs transition-colors ${
                    active
                      ? 'bg-sky-500/15 border-sky-500/50 text-sky-100 font-medium'
                      : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:text-slate-100'
                  }`}
                >
                  <div className="whitespace-nowrap truncate">{m.label}</div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">{m.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Backdrop Surface */}
        <div>
          <span className="text-xs font-medium text-slate-400 block mb-1.5">Подложка проверки</span>
          <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Выбор подложки">
            {BACKDROPS.map((b) => {
              const active = backdropMode === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onChangeBackdropMode(b.id)}
                  title={b.label}
                  aria-label={b.label}
                  aria-pressed={active}
                  className={`h-7 rounded border transition-all ${b.swatchClass} ${
                    active
                      ? 'ring-2 ring-sky-400 border-sky-300'
                      : 'border-slate-700 hover:border-slate-500'
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Zoom & Split */}
        <div className="space-y-2 pt-1 border-t border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              Масштаб и шторка
            </span>
            <button
              type="button"
              onClick={onResetView}
              className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 whitespace-nowrap"
              aria-label="Сбросить масштаб и позицию"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              Сброс
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onChangeZoom(Math.max(1, Number((zoom - 0.5).toFixed(1))))}
              aria-label="Уменьшить масштаб"
              className="p-1.5 rounded border border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:text-white"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <div className="flex-1 grid grid-cols-3 gap-1">
              {[1, 2, 3].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => onChangeZoom(z)}
                  className={`py-1 rounded text-xs font-mono border transition-colors ${
                    zoom === z
                      ? 'bg-slate-800 border-sky-500/50 text-sky-200'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {z}×
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChangeZoom(Math.min(4, Number((zoom + 0.5).toFixed(1))))}
              aria-label="Увеличить масштаб"
              className="p-1.5 rounded border border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:text-white"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {comparisonMode !== 'diff_heatmap' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <label htmlFor="sidebar-split-range">Позиция шторки</label>
                <span className="font-mono text-slate-300">{Math.round(splitPercent)}%</span>
              </div>
              <input
                id="sidebar-split-range"
                type="range"
                min={0}
                max={100}
                value={splitPercent}
                onChange={(e) => onChangeSplitPercent(Number(e.target.value))}
                className="w-full accent-sky-500 cursor-pointer"
              />
            </div>
          )}
        </div>
      </div>

      {/* Upload Custom Photo Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`px-3.5 py-2.5 border-b border-slate-800 transition-colors ${
          dragActive ? 'bg-sky-500/15' : 'bg-slate-950/40'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
          multiple
          aria-label="Загрузить свои фото, GIF или MP4 для тестирования"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onUploadFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
        <button
          type="button"
          disabled={Boolean(uploadingLabel)}
          onClick={() => fileInputRef.current?.click()}
          className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border text-xs font-medium transition-colors ${
            dragActive
              ? 'border-sky-400 bg-sky-500/20 text-sky-100'
              : 'border-dashed border-slate-700 bg-slate-900/80 text-slate-200 hover:border-sky-500/60 hover:text-sky-200 disabled:opacity-60'
          }`}
        >
          {uploadingLabel ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />
              <span className="truncate">{uploadingLabel}</span>
            </>
          ) : (
            <>
              <Upload className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>Фото / GIF / MP4 → WebM</span>
            </>
          )}
        </button>
        {uploadError && (
          <p className="text-[11px] text-rose-400 mt-1.5 leading-snug" role="alert">
            {uploadError}
          </p>
        )}
      </div>

      {/* Test Suite & Custom Photos List */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3.5 pt-2.5 pb-2 border-b border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
              <Grid2x2 className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              Тесты ({cells.length})
            </span>
            <button
              type="button"
              onClick={() => onSelectCell('sheet')}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                selectedCellId === 'sheet'
                  ? 'bg-sky-500/15 border-sky-500/50 text-sky-200'
                  : 'border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              Весь лист
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {[
              { key: 'Все', label: `Все (${cells.length})` },
              { key: 'Люди: волосы', label: `Люди (${humanCount})` },
              { key: 'Мои фото', label: `Мои (${customCount})` },
            ].map((tab) => {
              const active = categoryFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => onChangeCategoryFilter(tab.key)}
                  className={`py-1 px-1.5 rounded text-[11px] border transition-colors whitespace-nowrap truncate ${
                    active
                      ? 'bg-slate-800 border-sky-500/50 text-sky-200 font-medium'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <label className="sr-only" htmlFor="category-filter-select">Фильтр по категории</label>
          <select
            id="category-filter-select"
            value={categoryFilter}
            onChange={(e) => onChangeCategoryFilter(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat === 'Все' ? `Все категории (${cells.length})` : cat}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filteredCells.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400">
              {categoryFilter === 'Мои фото'
                ? 'Загрузите фото кнопкой выше или перетащите файл в окно сравнения.'
                : 'В этой категории пока нет объектов.'}
            </div>
          ) : (
            filteredCells.map((cell) => {
              const active = selectedCellId === cell.id;
              const isHuman = cell.domain === 'humans';
              const hasKeyFix = cell.id === 9 || cell.id === 4;
              return (
                <button
                  key={cell.id}
                  type="button"
                  onClick={() => onSelectCell(cell.id)}
                  className={`w-full flex items-center gap-2.5 p-2 rounded-md border text-left transition-colors ${
                    active
                      ? 'bg-sky-500/15 border-sky-500/50 text-slate-100'
                      : 'bg-transparent border-transparent hover:bg-slate-800/70 text-slate-300'
                  }`}
                >
                  <img
                    src={resolveAssetUrl(cell.assets.orig)}
                    alt={cell.title}
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded object-cover shrink-0 border border-slate-700/80 bg-slate-800"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-medium truncate">
                        {cell.isCustom ? '★ ' : `${String(cell.id).padStart(2, '0')}. `}
                        {cell.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5 font-mono">
                      <span>{cell.v53QualMs} ms</span>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-400">{cell.speedup1T}×</span>
                      {cell.semanticClass === 'human' || isHuman ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-sky-300">Человек</span>
                        </>
                      ) : cell.semanticClass === 'animal' ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-400">Животное</span>
                        </>
                      ) : null}
                      {hasKeyFix && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-400">Fix</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
};
