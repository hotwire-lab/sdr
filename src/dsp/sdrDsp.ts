export type ColormapId = 'turbo' | 'viridis' | 'inferno';

export interface SpectrumTraceStats {
  noiseFloorDbFs: number;
  peakDbFs: number;
  peakBinIndex: number;
  peakFreqMhz: number;
  snrDb: number;
}

export interface SpectrumTraceState {
  centerFreqMhz: number;
  spanMhz: number;
  fftBins: number;
  liveDbFs: Float32Array;
  avgDbFs: Float32Array;
  peakHoldDbFs: Float32Array;
  stats: SpectrumTraceStats;
}

export interface DspProcessOptions {
  dcNotch: boolean;
  spurBlanker: boolean;
  invertSpectrum?: boolean;
  spurThresholdDb?: number;
  avgAlpha?: number;
  clearPeakHold?: boolean;
}

type RgbStop = [number, number, number];

const TURBO_STOPS: RgbStop[] = [
  [48, 18, 59],
  [65, 69, 171],
  [45, 133, 240],
  [27, 198, 198],
  [104, 238, 114],
  [213, 224, 54],
  [253, 146, 41],
  [216, 56, 20],
  [122, 4, 3],
];

const VIRIDIS_STOPS: RgbStop[] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];

const INFERNO_STOPS: RgbStop[] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [243, 119, 26],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
];

function buildColormapLut(stops: RgbStop[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  const segCount = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segCount;
    const idx = Math.min(segCount - 1, Math.floor(t));
    const frac = t - idx;
    const a = stops[idx];
    const b = stops[idx + 1];
    const base = i * 4;
    lut[base] = Math.round(a[0] + (b[0] - a[0]) * frac);
    lut[base + 1] = Math.round(a[1] + (b[1] - a[1]) * frac);
    lut[base + 2] = Math.round(a[2] + (b[2] - a[2]) * frac);
    lut[base + 3] = 255;
  }
  return lut;
}

export const COLORMAP_LUTS: Record<ColormapId, Uint8ClampedArray> = {
  turbo: buildColormapLut(TURBO_STOPS),
  viridis: buildColormapLut(VIRIDIS_STOPS),
  inferno: buildColormapLut(INFERNO_STOPS),
};

export function mapDbToLutIndex(
  dbFs: number,
  minDbFs: number,
  maxDbFs: number,
): number {
  const span = maxDbFs - minDbFs;
  if (span <= 0.001) return 0;
  const norm = Math.max(0, Math.min(1, (dbFs - minDbFs) / span));
  return Math.round(norm * 255);
}

export function binToFreqMhz(
  binIndex: number,
  fftBins: number,
  centerFreqMhz: number,
  spanMhz: number,
): number {
  if (fftBins <= 0) return centerFreqMhz;
  return centerFreqMhz + ((binIndex - fftBins / 2) * spanMhz) / fftBins;
}

export function freqMhzToBin(
  freqMhz: number,
  fftBins: number,
  centerFreqMhz: number,
  spanMhz: number,
): number {
  if (spanMhz <= 0 || fftBins <= 0) return 0;
  return ((freqMhz - centerFreqMhz) / spanMhz) * fftBins + fftBins / 2;
}

export function applyDcSpikeNotch(bins: Float32Array): Float32Array {
  const n = bins.length;
  const out = new Float32Array(n);
  out.set(bins);
  if (n < 8) return out;

  const center = Math.floor(n / 2);
  const leftVal = bins[center - 2];
  const rightVal = bins[center + 2];

  out[center - 1] = leftVal * 0.75 + rightVal * 0.25;
  out[center] = (leftVal + rightVal) * 0.5;
  out[center + 1] = leftVal * 0.25 + rightVal * 0.75;
  return out;
}

export function applySpurBlanker(
  bins: Float32Array,
  thresholdDb = 10,
): Float32Array {
  const n = bins.length;
  const out = new Float32Array(n);
  out.set(bins);
  if (n < 6) return out;

  for (let i = 1; i < n - 1; i++) {
    const left = bins[i - 1];
    const right = bins[i + 1];
    const neighborPeak = Math.max(left, right);
    if (bins[i] - neighborPeak > thresholdDb) {
      out[i] = (left + right) * 0.5;
    }
  }
  return out;
}

export function computeSpectrumStats(
  bins: Float32Array,
  centerFreqMhz: number,
  spanMhz: number,
): SpectrumTraceStats {
  const n = bins.length;
  if (n === 0) {
    return {
      noiseFloorDbFs: -120,
      peakDbFs: -120,
      peakBinIndex: 0,
      peakFreqMhz: centerFreqMhz,
      snrDb: 0,
    };
  }

  let peakDbFs = -Infinity;
  let peakBinIndex = 0;
  for (let i = 0; i < n; i++) {
    if (bins[i] > peakDbFs) {
      peakDbFs = bins[i];
      peakBinIndex = i;
    }
  }

  const sorted = Float32Array.from(bins).sort();
  const noiseFloorDbFs = sorted[Math.floor(n * 0.25)];
  const peakFreqMhz = binToFreqMhz(peakBinIndex, n, centerFreqMhz, spanMhz);

  return {
    noiseFloorDbFs,
    peakDbFs,
    peakBinIndex,
    peakFreqMhz,
    snrDb: peakDbFs - noiseFloorDbFs,
  };
}

export function updateSpectrumTraces(
  rawDbFs: Float32Array,
  centerFreqMhz: number,
  spanMhz: number,
  prevState: SpectrumTraceState | null,
  options: DspProcessOptions,
): SpectrumTraceState {
  let processed = new Float32Array(rawDbFs.length);
  processed.set(rawDbFs);
  if (options.invertSpectrum) {
    processed.reverse();
  }
  if (options.dcNotch) {
    processed = new Float32Array(applyDcSpikeNotch(processed));
  }
  if (options.spurBlanker) {
    processed = new Float32Array(
      applySpurBlanker(processed, options.spurThresholdDb ?? 10),
    );
  }

  const fftBins = processed.length;
  const avgAlpha = options.avgAlpha ?? 0.28;
  const resetRequired =
    !prevState ||
    Boolean(options.clearPeakHold) ||
    prevState.fftBins !== fftBins ||
    Math.abs(prevState.centerFreqMhz - centerFreqMhz) > 0.01 ||
    Math.abs(prevState.spanMhz - spanMhz) > 0.01;

  const avgDbFs = new Float32Array(fftBins);
  const peakHoldDbFs = new Float32Array(fftBins);

  if (resetRequired) {
    avgDbFs.set(processed);
    peakHoldDbFs.set(processed);
  } else {
    for (let i = 0; i < fftBins; i++) {
      const val = processed[i];
      avgDbFs[i] = prevState.avgDbFs[i] * (1 - avgAlpha) + val * avgAlpha;
      peakHoldDbFs[i] = Math.max(prevState.peakHoldDbFs[i], val);
    }
  }

  return {
    centerFreqMhz,
    spanMhz,
    fftBins,
    liveDbFs: processed,
    avgDbFs,
    peakHoldDbFs,
    stats: computeSpectrumStats(processed, centerFreqMhz, spanMhz),
  };
}
