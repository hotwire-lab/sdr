import { describe, expect, it } from 'vitest';
import {
  applyDcSpikeNotch,
  applySpurBlanker,
  binToFreqMhz,
  COLORMAP_LUTS,
  freqMhzToBin,
  mapDbToLutIndex,
  updateSpectrumTraces,
} from '../dsp/sdrDsp';

describe('SDR Host DSP Helpers', () => {
  it('interpolates center DC bins in applyDcSpikeNotch', () => {
    const bins = new Float32Array(16).fill(-90);
    bins[6] = -80;
    bins[7] = -25;
    bins[8] = -12;
    bins[9] = -30;
    bins[10] = -84;

    const cleaned = applyDcSpikeNotch(bins);
    expect(cleaned[8]).toBeCloseTo(-82, 4);
    expect(cleaned[7]).toBeCloseTo(-81, 4);
    expect(cleaned[9]).toBeCloseTo(-83, 4);
  });

  it('suppresses isolated single-bin spurs in applySpurBlanker without flattening wide lobes', () => {
    const bins = new Float32Array(16).fill(-95);
    // Wideband lobe across bins 3..5
    bins[3] = -52;
    bins[4] = -50;
    bins[5] = -53;
    // Isolated single-bin clock spur at bin 12
    bins[12] = -32;

    const blanked = applySpurBlanker(bins, 10);
    expect(blanked[4]).toBe(-50); // Preserved
    expect(blanked[12]).toBe(-95); // Blanked
  });

  it('tracks peak-hold, EMA average, and clearPeakHold in updateSpectrumTraces', () => {
    const frame1 = new Float32Array(32).fill(-95);
    frame1[10] = -30;
    const s1 = updateSpectrumTraces(frame1, 2437, 80, null, {
      dcNotch: false,
      spurBlanker: false,
    });
    expect(s1.peakHoldDbFs[10]).toBe(-30);
    expect(s1.stats.peakDbFs).toBe(-30);

    const frame2 = new Float32Array(32).fill(-95);
    frame2[20] = -40;
    const s2 = updateSpectrumTraces(frame2, 2437, 80, s1, {
      dcNotch: false,
      spurBlanker: false,
    });
    // Bin 10 stays latched in peakHoldDbFs even after signal drops
    expect(s2.peakHoldDbFs[10]).toBe(-30);
    expect(s2.peakHoldDbFs[20]).toBe(-40);
    expect(s2.avgDbFs[10]).toBeLessThan(-30);

    const s3 = updateSpectrumTraces(frame2, 2437, 80, s2, {
      dcNotch: false,
      spurBlanker: false,
      clearPeakHold: true,
    });
    expect(s3.peakHoldDbFs[10]).toBe(-95);
  });

  it('inverts spectrum axis when invertSpectrum option is enabled', () => {
    const frame = new Float32Array(32).fill(-90);
    frame[5] = -25; // Peak on left side
    const normal = updateSpectrumTraces(frame, 2437, 80, null, {
      dcNotch: false,
      spurBlanker: false,
      invertSpectrum: false,
    });
    expect(normal.liveDbFs[5]).toBe(-25);

    const inverted = updateSpectrumTraces(frame, 2437, 80, null, {
      dcNotch: false,
      spurBlanker: false,
      invertSpectrum: true,
    });
    // With 32 bins, bin 5 reverses to bin 32 - 1 - 5 = 26
    expect(inverted.liveDbFs[26]).toBe(-25);
    expect(inverted.liveDbFs[5]).toBe(-90);
  });

  it('builds 256-entry RGBA LUTs and clamps dBFS mapping', () => {
    expect(COLORMAP_LUTS.turbo.length).toBe(256 * 4);
    expect(COLORMAP_LUTS.viridis.length).toBe(256 * 4);
    expect(COLORMAP_LUTS.inferno.length).toBe(256 * 4);
    expect(mapDbToLutIndex(-140, -115, -15)).toBe(0);
    expect(mapDbToLutIndex(-15, -115, -15)).toBe(255);
    expect(mapDbToLutIndex(-65, -115, -15)).toBe(128);
  });

  it('calculates bin-to-frequency and frequency-to-bin mappings with mathematical symmetry', () => {
    const centerFreq = 2437;
    const span = 80;
    const n = 1024;

    // Center bin exactly matches center frequency
    expect(binToFreqMhz(512, n, centerFreq, span)).toBe(2437);
    expect(freqMhzToBin(2437, n, centerFreq, span)).toBe(512);

    // Bin 0 matches start frequency
    expect(binToFreqMhz(0, n, centerFreq, span)).toBe(2397);
    expect(freqMhzToBin(2397, n, centerFreq, span)).toBe(0);

    // Nyquist endpoint (bin N) matches end frequency
    expect(binToFreqMhz(1024, n, centerFreq, span)).toBe(2477);
    expect(freqMhzToBin(2477, n, centerFreq, span)).toBe(1024);

    // Arbitrary frequency round-trip
    const testFreq = 2412.5;
    const binFloat = freqMhzToBin(testFreq, n, centerFreq, span);
    expect(binToFreqMhz(binFloat, n, centerFreq, span)).toBeCloseTo(testFreq, 6);

    // European DECT 1880-1900 MHz band centered at 1890 MHz with 20 MHz span
    expect(binToFreqMhz(0, 1024, 1890, 20)).toBe(1880);
    expect(binToFreqMhz(512, 1024, 1890, 20)).toBe(1890);
    expect(binToFreqMhz(1024, 1024, 1890, 20)).toBe(1900);
  });
});
