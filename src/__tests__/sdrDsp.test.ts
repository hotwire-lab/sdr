import { describe, expect, it } from 'vitest';
import {
  applyDcSpikeNotch,
  applySpurBlanker,
  COLORMAP_LUTS,
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

  it('builds 256-entry RGBA LUTs and clamps dBFS mapping', () => {
    expect(COLORMAP_LUTS.turbo.length).toBe(256 * 4);
    expect(COLORMAP_LUTS.viridis.length).toBe(256 * 4);
    expect(COLORMAP_LUTS.inferno.length).toBe(256 * 4);
    expect(mapDbToLutIndex(-140, -115, -15)).toBe(0);
    expect(mapDbToLutIndex(-15, -115, -15)).toBe(255);
    expect(mapDbToLutIndex(-65, -115, -15)).toBe(128);
  });
});
