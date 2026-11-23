import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { ControlSidebar } from './components/ControlSidebar';
import { ComparisonViewport } from './components/ComparisonViewport';
import { TelemetryPanel } from './components/TelemetryPanel';
import {
  isVideoOrGifFile,
  processCustomPhotoFile,
  processCustomVideoOrGifFile,
} from './utils/customPhotoRunner';
import type {
  BackdropMode,
  BenchMetrics,
  CellMetric,
  ComparisonMode,
  TelemetryTab,
} from './types/bench';

export default function App() {
  const [metrics, setMetrics] = useState<BenchMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [customCells, setCustomCells] = useState<CellMetric[]>([]);
  const [uploadingLabel, setUploadingLabel] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const customIdRef = useRef(101);
  const headerFileRef = useRef<HTMLInputElement>(null);

  // Start on Cell 14 (Platinum Blonde Hair) or Cell 9 (Coffee Mug) — start on #16 Silver Hair or #9 Mug
  const [selectedCellId, setSelectedCellId] = useState<number | 'sheet'>(14);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('v52_vs_v53');
  const [backdropMode, setBackdropMode] = useState<BackdropMode>('solid_dark');
  const [zoom, setZoom] = useState<number>(1);
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [categoryFilter, setCategoryFilter] = useState<string>('Все');
  const [telemetryTab, setTelemetryTab] = useState<TelemetryTab>('stages');

  useEffect(() => {
    let active = true;
    fetch('/bench/metrics.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<BenchMetrics>;
      })
      .then((data) => {
        if (active) {
          setMetrics(data);
          // Fallback to cell 9 if portrait #14 isn't present
          if (!data.cells.some((c) => c.id === 14)) {
            setSelectedCellId(9);
          }
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const allCells = useMemo(() => {
    if (!metrics) return customCells;
    return [...customCells, ...metrics.cells];
  }, [customCells, metrics]);

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || isVideoOrGifFile(f)
    );
    if (files.length === 0) {
      setUploadError('Выберите фото (JPG, PNG, WebP) или анимацию (GIF, MP4, WebM).');
      return;
    }
    setUploadError(null);
    let lastAddedId: number | null = null;

    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isVid = isVideoOrGifFile(f);
        setUploadingLabel(
          files.length > 1
            ? `Маттинг ${i + 1}/${files.length}: ${f.name}`
            : isVid
              ? `Подготовка видео/GIF → WebM...`
              : `Маттинг v5.2 vs v5.3...`
        );
        const newId = customIdRef.current++;
        const cell = isVid
          ? await processCustomVideoOrGifFile(f, newId, (status) => setUploadingLabel(status))
          : await processCustomPhotoFile(f, newId);
        setCustomCells((prev) => [cell, ...prev]);
        lastAddedId = newId;
      }
      if (lastAddedId !== null) {
        setSelectedCellId(lastAddedId);
        setComparisonMode('v52_vs_v53');
        setCategoryFilter('Все');
        setPan({ x: 0, y: 0 });
        setZoom(1);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Ошибка обработки файла');
    } finally {
      setUploadingLabel(null);
    }
  };

  const handleResetView = () => {
    setZoom(1);
    setSplitPercent(50);
    setPan({ x: 0, y: 0 });
  };

  const handleSelectCell = (id: number | 'sheet') => {
    setSelectedCellId(id);
    setPan({ x: 0, y: 0 });
  };

  const selectedCell =
    typeof selectedCellId === 'number'
      ? allCells.find((c) => c.id === selectedCellId) ?? allCells[0] ?? null
      : null;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#090e1a] text-slate-100 overflow-hidden">
      {/* Top Bar: 3-zone SaaS Dashboard header */}
      <header className="h-12 px-5 border-b border-slate-800 bg-slate-900 flex items-center justify-between gap-6 shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          <span>AlphaMatte Lab</span>
        </div>

        <nav className="hidden md:flex items-center gap-5 text-xs text-slate-400">
          <button
            type="button"
            onClick={() => {
              setSelectedCellId(14);
              setComparisonMode('v52_vs_v53');
              setBackdropMode('solid_white');
              setCategoryFilter('Люди: волосы');
              setTelemetryTab('quality');
            }}
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Люди: волосы (4)
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedCellId(2);
              setComparisonMode('v52_vs_v53');
              setBackdropMode('solid_dark');
              setCategoryFilter('Шерсть и усы');
              setTelemetryTab('quality');
            }}
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Белая шерсть (#2)
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedCellId(9);
              setComparisonMode('alpha_v52_vs_v53');
              setTelemetryTab('quality');
            }}
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Кружка и пар (#9)
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedCellId('sheet');
              setComparisonMode('v52_vs_v53');
              setTelemetryTab('pipeline');
            }}
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Лист 3×4
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <input
            ref={headerFileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
            multiple
            className="sr-only"
            aria-label="Загрузить фото, GIF или MP4 из шапки"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          {metrics && (
            <span className="hidden lg:inline text-xs font-mono text-slate-400 whitespace-nowrap">
              {metrics.image.cells} котов + {metrics.image.humanPortraits ?? 4} портрета
            </span>
          )}
          <button
            type="button"
            disabled={Boolean(uploadingLabel)}
            onClick={() => headerFileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Фото / GIF / MP4 → WebM</span>
          </button>
        </div>
      </header>

      {/* Main Workspace: Sidebar + Visual Comparison Viewport + Bottom Telemetry Panel */}
      {error ? (
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md border border-rose-500/40 bg-slate-900 rounded-lg p-5 text-sm text-rose-200">
            <div className="font-semibold mb-1">Не удалось загрузить данные замеров</div>
            <p className="text-xs text-slate-400">{error}</p>
          </div>
        </main>
      ) : !metrics ? (
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-xs font-mono text-slate-400">
            Загрузка результатов профилирования v5.2-FAST vs v5.3-TURBO...
          </div>
        </main>
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <ControlSidebar
            cells={allCells}
            selectedCellId={selectedCellId}
            onSelectCell={handleSelectCell}
            comparisonMode={comparisonMode}
            onChangeComparisonMode={setComparisonMode}
            backdropMode={backdropMode}
            onChangeBackdropMode={setBackdropMode}
            zoom={zoom}
            onChangeZoom={(z) => {
              setZoom(z);
              if (z === 1) setPan({ x: 0, y: 0 });
            }}
            splitPercent={splitPercent}
            onChangeSplitPercent={setSplitPercent}
            onResetView={handleResetView}
            categoryFilter={categoryFilter}
            onChangeCategoryFilter={setCategoryFilter}
            onUploadFiles={handleUploadFiles}
            uploadingLabel={uploadingLabel}
            uploadError={uploadError}
          />

          <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            <ComparisonViewport
              selectedCell={selectedCell}
              isSheetView={selectedCellId === 'sheet'}
              comparisonMode={comparisonMode}
              backdropMode={backdropMode}
              zoom={zoom}
              splitPercent={splitPercent}
              onChangeSplitPercent={setSplitPercent}
              pan={pan}
              onChangePan={setPan}
              onDropFiles={handleUploadFiles}
            />

            <TelemetryPanel
              metrics={metrics}
              allCells={allCells}
              activeTab={telemetryTab}
              onChangeTab={setTelemetryTab}
              selectedCellId={selectedCellId}
              onSelectCell={(id) => handleSelectCell(id)}
            />
          </main>
        </div>
      )}
    </div>
  );
}
