import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMs,
  formatMsPrecise,
  computeSavingsPercent,
  computeStageSharePercent,
  findTopBottleneckStage,
  filterCellsByCategory,
  getComparisonLabels,
  clampSplitRatio,
} from './telemetryMath';
import type { CellMetric, StageMetric } from '../types/bench';

test('formatMs formats sub-second and multi-second durations cleanly', () => {
  assert.equal(formatMs(452.7), '453 ms');
  assert.equal(formatMs(1250), '1.25 s');
  assert.equal(formatMsPrecise(301.74), '301.7 ms');
});

test('computeSavingsPercent calculates exact reduction percentage', () => {
  assert.equal(computeSavingsPercent(12000, 4440), 63.0);
  assert.equal(computeSavingsPercent(0, 100), 0);
});

test('stage bottleneck and share calculations identify slowest stage', () => {
  const stages: StageMetric[] = [
    { key: 's0', label: 'Stage 0', optimization: 'opt', v52Ms: 800, v53ExactMs: 500, v53QualMs: 500, speedup: 1.6 },
    { key: 's7', label: 'Stage 7', optimization: 'opt', v52Ms: 1700, v53ExactMs: 600, v53QualMs: 600, speedup: 2.83 },
  ];
  assert.equal(findTopBottleneckStage(stages, 'v52Ms')?.key, 's7');
  assert.equal(computeStageSharePercent(1700, stages, 'v52Ms'), 68.0);
});

test('filterCellsByCategory filters accurately and returns all for Все', () => {
  const sample: CellMetric[] = [
    {
      id: 1, title: 'A', challenge: '', category: 'Шерсть и усы', width: 100, height: 100,
      v52Ms: 500, v53ExactMs: 300, v53QualMs: 300, speedup1T: 1.67,
      exactPsnrDb: 98, exactMaeAlpha: 0, exactWithin1Pct: 100, qualDiffPixelsPct: 0.2, qualMaeAlpha: 0.1,
      assets: { orig: '', v52: '', v53: '', alphaV52: '', alphaV53: '', diff: '' },
    },
    {
      id: 9, title: 'B', challenge: '', category: 'Дым и пар', width: 100, height: 100,
      v52Ms: 600, v53ExactMs: 350, v53QualMs: 350, speedup1T: 1.71,
      exactPsnrDb: 98, exactMaeAlpha: 0, exactWithin1Pct: 100, qualDiffPixelsPct: 1.4, qualMaeAlpha: 0.5,
      assets: { orig: '', v52: '', v53: '', alphaV52: '', alphaV53: '', diff: '' },
    },
  ];
  assert.equal(filterCellsByCategory(sample, 'Все').length, 2);
  assert.equal(filterCellsByCategory(sample, 'Дым и пар').length, 1);
  assert.equal(filterCellsByCategory(sample, 'Дым и пар')[0].id, 9);
});

test('getComparisonLabels and clampSplitRatio handle all modes and edge bounds', () => {
  assert.equal(getComparisonLabels('diff_heatmap').isSingleOverlay, true);
  assert.equal(getComparisonLabels('v52_vs_v53').isSingleOverlay, false);
  assert.equal(clampSplitRatio(-20), 0);
  assert.equal(clampSplitRatio(135), 100);
  assert.equal(clampSplitRatio(42.5), 42.5);
});
