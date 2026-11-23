import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { BenchMetrics, CellMetric, TelemetryTab } from '../types/bench';
import { computeSavingsPercent, formatMs } from '../utils/telemetryMath';

interface TelemetryPanelProps {
  metrics: BenchMetrics;
  allCells: CellMetric[];
  activeTab: TelemetryTab;
  onChangeTab: (tab: TelemetryTab) => void;
  selectedCellId: number | 'sheet';
  onSelectCell: (id: number) => void;
}

export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
  metrics,
  allCells,
  activeTab,
  onChangeTab,
  selectedCellId,
  onSelectCell,
}) => {
  const [expanded, setExpanded] = useState(false);

  const tabs: Array<{ id: TelemetryTab; label: string }> = [
    { id: 'stages', label: 'Стадии v5.2 vs v5.3' },
    { id: 'pipeline', label: 'Пайплайн и 4 потока' },
    { id: 'quality', label: 'Качество, волосы и багфиксы' },
    { id: 'cells', label: `Матрица тестов (${allCells.length})` },
  ];

  const maxStageMs = Math.max(...metrics.stages.map((s) => Math.max(s.v52Ms, s.v53QualMs)), 1);
  const { mattingSummary, fullPipeline, fidelityExactVsV52, qualityFixes, hairBenchmark, semanticSummary, textureRecoverySummary } = metrics;

  return (
    <section
      aria-label="Панель телеметрии производительности"
      className={`border-t border-slate-800 bg-slate-900 flex flex-col shrink-0 transition-all duration-150 ${
        expanded ? 'h-[430px]' : 'h-[268px]'
      }`}
    >
      {/* Tab Header & Top KPI Strip — constrained cleanly so expand button never clips at 1440px */}
      <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 min-w-0">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto" role="tablist" aria-label="Разделы телеметрии">
          {tabs.map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChangeTab(t.id)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-800 text-sky-200 border border-slate-700'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden xl:flex items-center gap-3 text-xs font-mono text-slate-400 whitespace-nowrap">
            <span>
              1T: <strong className="text-emerald-400">{mattingSummary.speedupQuality1T}×</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {metrics.image.workerThreads}T:{' '}
              <strong className="text-sky-300">{formatMs(mattingSummary.v53QualityParallelMs)}</strong>{' '}
              ({mattingSummary.speedupQualityParallel}×)
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Пайплайн: <strong className="text-emerald-400">{fullPipeline.totalSpeedup}×</strong>
            </span>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Свернуть панель телеметрии' : 'Развернуть панель телеметрии'}
            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 shrink-0"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Panel Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
        {activeTab === 'stages' && (
          <div className="space-y-2">
            <div className="grid grid-cols-[240px_1fr_130px_64px_260px] gap-3 text-[11px] font-medium text-slate-400 pb-1 border-b border-slate-800/80">
              <span>Стадия пайплайна (12 ячеек, 17.2 MP)</span>
              <span>Сравнение времени (серый = v5.2, голубой = v5.3)</span>
              <span className="text-right">v5.2 → v5.3</span>
              <span className="text-right">Ускор.</span>
              <span>Применённая оптимизация</span>
            </div>
            {metrics.stages.map((s) => {
              const isNewStage = s.v52Ms <= 0;
              const w52 = isNewStage ? 0 : Math.max(2, (s.v52Ms / maxStageMs) * 100);
              const w53 = Math.max(2, (s.v53QualMs / maxStageMs) * 100);
              const isFaster = isNewStage || s.speedup >= 1.0;
              return (
                <div
                  key={s.key}
                  className="grid grid-cols-[240px_1fr_130px_64px_260px] gap-3 items-center text-xs py-1 border-b border-slate-800/40 hover:bg-slate-800/30"
                >
                  <span className="text-slate-200 truncate font-medium">{s.label}</span>
                  <div className="space-y-1">
                    <div className="h-2 bg-slate-950 rounded-sm overflow-hidden">
                      {!isNewStage && <div className="h-full bg-slate-600 rounded-sm" style={{ width: `${w52}%` }} />}
                    </div>
                    <div className="h-2 bg-slate-950 rounded-sm overflow-hidden">
                      <div
                        className={`h-full rounded-sm ${isNewStage ? 'bg-emerald-400' : isFaster ? 'bg-sky-400' : 'bg-amber-400'}`}
                        style={{ width: `${w53}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right font-mono text-[11px] text-slate-300">
                    {isNewStage ? '—' : s.v52Ms.toFixed(0)} →{' '}
                    <span className={isNewStage ? 'text-emerald-300' : isFaster ? 'text-sky-300' : 'text-amber-300'}>
                      {s.v53QualMs.toFixed(0)} ms
                    </span>
                  </div>
                  <div
                    className={`text-right font-mono text-xs font-semibold ${
                      isNewStage
                        ? 'text-emerald-400'
                        : s.speedup >= 1.8
                          ? 'text-emerald-400'
                          : s.speedup >= 1.05
                            ? 'text-sky-300'
                            : 'text-amber-300'
                    }`}
                  >
                    {isNewStage ? 'новый' : `${s.speedup.toFixed(2)}×`}
                  </div>
                  <span className="text-[11px] text-slate-400 truncate" title={s.optimization}>
                    {s.optimization}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === 'pipeline' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="text-xs font-semibold text-slate-200 mb-2">
                Сквозной прогон processStickerSheet (3584×4800, 12 стикеров PNG)
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800 text-left">
                    <th className="py-1.5 font-medium">Этап</th>
                    <th className="py-1.5 font-medium text-right">v5.2-FAST</th>
                    <th className="py-1.5 font-medium text-right">v5.3-TURBO ({metrics.image.workerThreads}T)</th>
                    <th className="py-1.5 font-medium text-right">Экономия</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {(
                    [
                      ['Decode (Sharp JPEG → RGBA)', fullPipeline.v52.decode, fullPipeline.v53.decode],
                      ['Keying / Alpha Matting (12 ячеек)', fullPipeline.v52.keying, fullPipeline.v53.keying],
                      ['Segmentation (8-conn BFS + LUT)', fullPipeline.v52.segmentation, fullPipeline.v53.segmentation],
                      ['Export (12 PNG + Preview)', fullPipeline.v52.export, fullPipeline.v53.export],
                      ['ИТОГО (Wall-Clock)', fullPipeline.v52.total, fullPipeline.v53.total],
                    ] as Array<[string, number, number]>
                  ).map(([name, v52, v53], idx) => {
                    const isTotal = idx === 4;
                    const saving = computeSavingsPercent(v52, v53);
                    const mult = (v52 / Math.max(1, v53)).toFixed(2);
                    return (
                      <tr
                        key={name}
                        className={`border-b border-slate-800/50 ${
                          isTotal ? 'bg-slate-800/40 font-semibold text-slate-100' : 'text-slate-300'
                        }`}
                      >
                        <td className="py-1.5 font-sans">{name}</td>
                        <td className="py-1.5 text-right">{v52} ms</td>
                        <td className="py-1.5 text-right text-sky-300">{v53} ms</td>
                        <td className="py-1.5 text-right text-emerald-400">
                          −{saving}% ({mult}×)
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-200 mb-2">
                Масштабирование ядра маттинга (12 котов + 4 портрета людей)
              </h3>
              <div className="space-y-2.5">
                {[
                  {
                    label: 'v5.2-FAST (исходный, 1 поток)',
                    ms: mattingSummary.v52SingleThreadMs,
                    mult: 1.0,
                    barClass: 'bg-slate-600',
                  },
                  {
                    label: 'v5.3-Exact (1 поток, PSNR ' + fidelityExactVsV52.meanAlphaPsnrDb + ' dB)',
                    ms: mattingSummary.v53ExactSingleThreadMs,
                    mult: mattingSummary.speedupExact1T,
                    barClass: 'bg-sky-500',
                  },
                  {
                    label: 'v5.3-Quality+ Fur/Hair (1 поток, O(N) Stage 6)',
                    ms: mattingSummary.v53QualitySingleThreadMs,
                    mult: mattingSummary.speedupQuality1T,
                    barClass: 'bg-sky-400',
                  },
                  {
                    label: `v5.3-Quality+ (${metrics.image.workerThreads} worker_threads, тёплый пул)`,
                    ms: mattingSummary.v53QualityParallelMs,
                    mult: mattingSummary.speedupQualityParallel,
                    barClass: 'bg-emerald-400',
                  },
                ].map((row) => {
                  const pct = Math.min(100, (row.ms / Math.max(mattingSummary.v52SingleThreadMs, 1)) * 100);
                  return (
                    <div key={row.label} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-300">{row.label}</span>
                        <span className="font-mono text-slate-200">
                          {row.ms.toFixed(0)} ms · <strong className="text-emerald-400">{row.mult.toFixed(2)}×</strong>
                        </span>
                      </div>
                      <div className="h-2.5 bg-slate-950 rounded-sm overflow-hidden">
                        <div className={`h-full ${row.barClass} rounded-sm`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'quality' && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">Семантика (Человек vs Животное)</span>
                <button
                  type="button"
                  onClick={() => onSelectCell(15)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 underline shrink-0"
                >
                  Рубашка #15
                </button>
              </div>
              {semanticSummary && (
                <div className="font-mono text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Точность ({semanticSummary.total} тестов):</span>
                    <span className="text-emerald-400">
                      {semanticSummary.correct}/{semanticSummary.total} ({semanticSummary.accuracyPct}%)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">inwardDist (Чел / Жив):</span>
                    <span className="text-sky-300">34 px / 54–56 px</span>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Встроен в v5.2 и v5.3: защищает силуэт и пересветы одежды у людей (радиус 8 px) и углубляет захват шерсти у животных.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">Stage 6C: Texture Recovery</span>
                <button
                  type="button"
                  onClick={() => onSelectCell(13)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 underline shrink-0"
                >
                  Афро #13
                </button>
              </div>
              {textureRecoverySummary && (
                <div className="font-mono text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Восстановлено теней:</span>
                    <span className="text-emerald-400">
                      {textureRecoverySummary.totalRecoveredPixels.toLocaleString('ru-RU')} px
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Локальных патчей 4×4:</span>
                    <span className="text-sky-300">
                      {textureRecoverySummary.totalExtractedPatches} ({textureRecoverySummary.activeImages} сцен)
                    </span>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Извлекает реальные 4×4 остатки текстур из тёмных кудрей и шерсти и переносит их случайным паттерном с перекрытием в сглаженные тени.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">Шерсть и волосы (4 портрета)</span>
                <button
                  type="button"
                  onClick={() => onSelectCell(14)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 underline shrink-0"
                >
                  Блонд #14
                </button>
              </div>
              {hairBenchmark && (
                <div className="font-mono text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Серый ореол (4 портрета):</span>
                    <span className="text-emerald-400">
                      −{hairBenchmark.grayHaloReductionPct}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Скорость (1T):</span>
                    <span className="text-sky-300">{hairBenchmark.speedup1T}×</span>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Двухполярный O(N) цветовой приор + деконтаминация убирают потемнение белой шерсти на тёмном фоне и серую «паутину» в кудрях.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="text-xs font-semibold text-slate-100">
                Эквивалентность v5.3-Exact
              </div>
              <div className="grid grid-cols-3 gap-2 font-mono pt-0.5">
                <div>
                  <div className="text-[11px] text-slate-400">PSNR</div>
                  <div className="text-xs font-semibold text-sky-300">{fidelityExactVsV52.meanAlphaPsnrDb} dB</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">MAE</div>
                  <div className="text-xs font-semibold text-emerald-400">{fidelityExactVsV52.meanAlphaMae}</div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400">±1 px</div>
                  <div className="text-xs font-semibold text-emerald-400">{fidelityExactVsV52.pixelsWithin1Pct}%</div>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Без Quality+ ускорения памяти, кэша, 2-проходный DT и разреженный Stage 7 дают точное совпадение маски с семантическим v5.2-FAST.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">#9: Дыра в кружке кофе</span>
                <button
                  type="button"
                  onClick={() => onSelectCell(9)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 underline shrink-0"
                >
                  Открыть #9
                </button>
              </div>
              <div className="font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Пикселей дыры:</span>
                  <span>
                    <span className="text-rose-400">{qualityFixes.cell9MugHole.v52HolePixels}</span>
                    {' → '}
                    <span className="text-emerald-400">{qualityFixes.cell9MugHole.v53HolePixels}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Мин. альфа:</span>
                  <span>
                    <span className="text-rose-400">{qualityFixes.cell9MugHole.v52MinAlpha}</span>
                    {' → '}
                    <span className="text-emerald-400">{qualityFixes.cell9MugHole.v53MinAlpha}/255</span>
                  </span>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Топологическая защита корпуса (inwardDist + contourBarrier) полностью закрыла ложную полупрозрачность в гладкой кружке и на коже лица.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-100">#4: Шары, боке и ткань</span>
                <button
                  type="button"
                  onClick={() => onSelectCell(4)}
                  className="text-[11px] text-sky-400 hover:text-sky-300 underline shrink-0"
                >
                  Открыть #4
                </button>
              </div>
              <div className="font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Резких скачков α:</span>
                  <span>
                    <span className="text-rose-400">{qualityFixes.cell4BlueBalloon.v52SharpJumps}</span>
                    {' → '}
                    <span className="text-emerald-400">{qualityFixes.cell4BlueBalloon.v53SharpJumps}</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">G/B clamp баг:</span>
                  <span className="text-emerald-400">[0..255]</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Smoothstep-веса убрали жёсткое пятно в синем шаре, исправлен деспил G/B, добавлена защита фактурной серой одежды и 1px усов.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'cells' && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-800 text-left">
                <th className="py-1.5 font-medium">#</th>
                <th className="py-1.5 font-medium">Объект</th>
                <th className="py-1.5 font-medium">Класс</th>
                <th className="py-1.5 font-medium text-right">v5.2 (1T)</th>
                <th className="py-1.5 font-medium text-right">v5.3 (1T)</th>
                <th className="py-1.5 font-medium text-right">Ускор.</th>
                <th className="py-1.5 font-medium text-right">Exact PSNR</th>
                <th className="py-1.5 font-medium text-right">Тени 6C / Ореол</th>
              </tr>
            </thead>
            <tbody>
              {allCells.map((c) => {
                const isSelected = selectedCellId === c.id;
                const semLabel = c.semanticClass === 'human' ? 'Человек' : 'Животное';
                return (
                  <tr
                    key={c.id}
                    onClick={() => onSelectCell(c.id)}
                    className={`border-b border-slate-800/40 cursor-pointer transition-colors ${
                      isSelected ? 'bg-sky-500/15 text-slate-100' : 'text-slate-300 hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="py-1.5 font-mono text-slate-400">
                      {c.isCustom ? '★' : String(c.id).padStart(2, '0')}
                    </td>
                    <td className="py-1.5 font-medium">{c.title}</td>
                    <td className={`py-1.5 font-mono text-[11px] ${c.semanticClass === 'human' ? 'text-sky-300' : 'text-amber-300'}`}>
                      {semLabel}
                    </td>
                    <td className="py-1.5 text-right font-mono">{c.v52Ms} ms</td>
                    <td className="py-1.5 text-right font-mono text-sky-300">{c.v53QualMs} ms</td>
                    <td className="py-1.5 text-right font-mono text-emerald-400">{c.speedup1T}×</td>
                    <td className="py-1.5 text-right font-mono text-slate-300">
                      {c.isCustom ? '—' : `${c.exactPsnrDb} dB`}
                    </td>
                    <td className="py-1.5 text-right font-mono text-slate-400">
                      {c.textureRecoveredPixels && c.textureRecoveredPixels > 0
                        ? `+${c.textureRecoveredPixels.toLocaleString('ru-RU')} px`
                        : typeof c.grayHaloReductionPct === 'number'
                          ? `${c.grayHaloReductionPct >= 0 ? '−' : '+'}${Math.abs(c.grayHaloReductionPct)}% ореол`
                          : `${c.qualDiffPixelsPct}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
