export type ComparisonMode =
  | 'orig_vs_v53'
  | 'v52_vs_v53'
  | 'alpha_v52_vs_v53'
  | 'diff_heatmap';

export type BackdropMode =
  | 'checker_light'
  | 'checker_dark'
  | 'solid_dark'
  | 'solid_white'
  | 'chroma_green';

export type TelemetryTab =
  | 'stages'
  | 'pipeline'
  | 'quality'
  | 'cells';

export type TestDomain = 'cats' | 'humans' | 'custom';

export interface StageMetric {
  key: string;
  label: string;
  optimization: string;
  v52Ms: number;
  v53ExactMs: number;
  v53QualMs: number;
  speedup: number;
}

export interface CellAssets {
  orig: string;
  v52: string;
  v53: string;
  alphaV52: string;
  alphaV53: string;
  diff: string;
}

export interface CellMetric {
  id: number;
  domain?: TestDomain;
  title: string;
  challenge: string;
  category: string;
  width: number;
  height: number;
  v52Ms: number;
  v53ExactMs: number;
  v53QualMs: number;
  speedup1T: number;
  exactPsnrDb: number;
  exactMaeAlpha: number;
  exactWithin1Pct: number;
  qualDiffPixelsPct: number;
  qualMaeAlpha: number;
  grayHaloV52?: number;
  grayHaloV53?: number;
  grayHaloReductionPct?: number;
  semanticClass?: 'human' | 'animal';
  semanticConfidence?: number;
  textureRecoveredPixels?: number;
  textureExtractedPatches?: number;
  isCustom?: boolean;
  isVideo?: boolean;
  videoWebmUrl?: string;
  origVideoUrl?: string;
  frameCount?: number;
  fps?: number;
  assets: CellAssets;
}

export interface PipelineTimings {
  decode: number;
  keying: number;
  segmentation: number;
  export: number;
  total: number;
}

export interface HairBenchmarkSummary {
  portraitsCount: number;
  v52TotalMs: number;
  v53QualityTotalMs: number;
  speedup1T: number;
  grayHaloV52: number;
  grayHaloV53: number;
  grayHaloReductionPct: number;
}

export interface SemanticSummary {
  total: number;
  correct: number;
  accuracyPct: number;
  humansDetected: number;
  animalsDetected: number;
}

export interface TextureRecoverySummary {
  totalRecoveredPixels: number;
  activeImages: number;
  totalExtractedPatches: number;
  stageMs: number;
}

export interface BenchMetrics {
  generatedAt: string;
  image: {
    filename: string;
    width: number;
    height: number;
    megapixels: number;
    layout: string;
    cells: number;
    humanPortraits?: number;
    cpuCores: number;
    workerThreads: number;
  };
  mattingSummary: {
    v52SingleThreadMs: number;
    v53ExactSingleThreadMs: number;
    v53QualitySingleThreadMs: number;
    v53QualityParallelMs: number;
    speedupExact1T: number;
    speedupQuality1T: number;
    speedupQualityParallel: number;
  };
  hairBenchmark?: HairBenchmarkSummary;
  semanticSummary?: SemanticSummary;
  textureRecoverySummary?: TextureRecoverySummary;
  fullPipeline: {
    v52: PipelineTimings;
    v53: PipelineTimings;
    totalSpeedup: number;
    keyingSpeedup: number;
    exportSpeedup: number;
  };
  fidelityExactVsV52: {
    meanAlphaPsnrDb: number;
    meanAlphaMae: number;
    pixelsWithin1Pct: number;
  };
  qualityFixes: {
    cell9MugHole: {
      v52HolePixels: number;
      v52HolePct: number;
      v52MinAlpha: number;
      v53HolePixels: number;
      v53HolePct: number;
      v53MinAlpha: number;
    };
    cell4BlueBalloon: {
      v52SharpJumps: number;
      v53SharpJumps: number;
      v52MeanAlpha: number;
      v53MeanAlpha: number;
    };
  };
  stages: StageMetric[];
  cells: CellMetric[];
}
