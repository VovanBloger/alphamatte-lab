import type { CellMetric, ComparisonMode, StageMetric } from '../types/bench';

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0 ms';
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }
  return `${Math.round(ms)} ms`;
}

export function formatMsPrecise(ms: number): string {
  if (!Number.isFinite(ms)) return '0.0 ms';
  return `${ms.toFixed(1)} ms`;
}

export function computeSavingsPercent(baselineMs: number, optimizedMs: number): number {
  if (baselineMs <= 0) return 0;
  return Number((((baselineMs - optimizedMs) / baselineMs) * 100).toFixed(1));
}

export function computeStageSharePercent(stageMs: number, stages: StageMetric[], field: 'v52Ms' | 'v53QualMs'): number {
  const total = stages.reduce((acc, s) => acc + s[field], 0);
  if (total <= 0) return 0;
  return Number(((stageMs / total) * 100).toFixed(1));
}

export function findTopBottleneckStage(stages: StageMetric[], field: 'v52Ms' | 'v53QualMs'): StageMetric | null {
  if (stages.length === 0) return null;
  let best = stages[0];
  for (let i = 1; i < stages.length; i++) {
    if (stages[i][field] > best[field]) {
      best = stages[i];
    }
  }
  return best;
}

export function filterCellsByCategory(cells: CellMetric[], category: string): CellMetric[] {
  if (!category || category === 'Все') return cells;
  return cells.filter((c) => c.category === category);
}

export function getComparisonLabels(mode: ComparisonMode): {
  leftLabel: string;
  rightLabel: string;
  isSingleOverlay: boolean;
} {
  switch (mode) {
    case 'orig_vs_v53':
      return { leftLabel: 'Оригинал (#7A828C)', rightLabel: 'v5.3-TURBO (Quality+)', isSingleOverlay: false };
    case 'v52_vs_v53':
      return { leftLabel: 'v5.2-FAST (База)', rightLabel: 'v5.3-TURBO (Quality+)', isSingleOverlay: false };
    case 'alpha_v52_vs_v53':
      return { leftLabel: 'Альфа v5.2-FAST', rightLabel: 'Альфа v5.3-TURBO', isSingleOverlay: false };
    case 'diff_heatmap':
      return { leftLabel: 'Карта отличий |α₅.₃ − α₅.₂|', rightLabel: 'v5.3-TURBO (Quality+)', isSingleOverlay: true };
  }
}

export function getComparisonImageSources(
  cell: CellMetric,
  mode: ComparisonMode
): { leftSrc: string; rightSrc: string } {
  switch (mode) {
    case 'orig_vs_v53':
      return { leftSrc: cell.assets.orig, rightSrc: cell.assets.v53 };
    case 'v52_vs_v53':
      return { leftSrc: cell.assets.v52, rightSrc: cell.assets.v53 };
    case 'alpha_v52_vs_v53':
      return { leftSrc: cell.assets.alphaV52, rightSrc: cell.assets.alphaV53 };
    case 'diff_heatmap':
      return { leftSrc: cell.assets.diff, rightSrc: cell.assets.v53 };
  }
}

export function clampSplitRatio(val: number): number {
  if (!Number.isFinite(val)) return 50;
  return Math.max(0, Math.min(100, val));
}
