import { describe, expect, it } from 'vitest';
import {
  buildSdrStreamCtrlCmd,
  buildSdrSweepCfgCmd,
  buildSdrTuneCmd,
  computeXorChecksum,
  decodeBoardCapabilities,
  decodeSdrRawIqFrame,
  decodeSdrSpectrumFrame,
  encodeResponseFrame,
} from '../protocol/codec';
import {
  CMD_SDR_STREAM_CTRL,
  CMD_SDR_SWEEP_CFG,
  CMD_SDR_TUNE,
  SDR_DSP_FLAG_DC_CANCEL,
  SDR_DSP_FLAG_MAX_HOLD,
  SDR_FLAG_ADC_CLIP,
  SDR_FLAG_LO_DIV_ACTIVE,
  SDR_GAIN_AGC,
  SDR_MAX_FREQ_MHZ,
  SDR_MIN_FREQ_MHZ,
  SDR_STREAM_FFT,
  TYPE_BOARD_CAPABILITIES,
  TYPE_SDR_RAW_IQ_FRAME,
  TYPE_SDR_SPECTRUM_FRAME,
} from '../protocol/types';

describe('SDR Protocol Codec', () => {
  it('encodes 8-byte CMD_SDR_TUNE frames with clamped frequency and gain', () => {
    const cmd = buildSdrTuneCmd(2437, 0, SDR_GAIN_AGC);
    expect(cmd.byteLength).toBe(8);
    expect(cmd[0]).toBe(0xaa);
    expect(cmd[1]).toBe(0x55);
    expect(cmd[2]).toBe(CMD_SDR_TUNE);
    expect(cmd[3] | (cmd[4] << 8)).toBe(2437);
    expect(cmd[5]).toBe(0);
    expect(cmd[6]).toBe(0xff);
    expect(cmd[7]).toBe(computeXorChecksum(cmd, 7));

    const clampedLow = buildSdrTuneCmd(1200, 3, -5);
    expect(clampedLow[3] | (clampedLow[4] << 8)).toBe(SDR_MIN_FREQ_MHZ);
    expect(clampedLow[5]).toBe(3);
    expect(clampedLow[6]).toBe(0xff);

    const clampedHigh = buildSdrTuneCmd(3500, 1, 90);
    expect(clampedHigh[3] | (clampedHigh[4] << 8)).toBe(SDR_MAX_FREQ_MHZ);
    expect(clampedHigh[6]).toBe(72);
  });

  it('encodes 8-byte CMD_SDR_STREAM_CTRL and CMD_SDR_SWEEP_CFG frames', () => {
    const dspFlags = SDR_DSP_FLAG_MAX_HOLD | SDR_DSP_FLAG_DC_CANCEL | (3 << 4);
    const stream = buildSdrStreamCtrlCmd(SDR_STREAM_FFT, 10, dspFlags, 30);
    expect(stream[2]).toBe(CMD_SDR_STREAM_CTRL);
    expect(stream[3]).toBe(SDR_STREAM_FFT);
    expect(stream[4]).toBe(10);
    expect(stream[5]).toBe(dspFlags);
    expect(stream[6]).toBe(30);
    expect(stream[7]).toBe(computeXorChecksum(stream, 7));

    const sweep = buildSdrSweepCfgCmd(2400, 4, 5);
    expect(sweep[2]).toBe(CMD_SDR_SWEEP_CFG);
    expect(sweep[3] | (sweep[4] << 8)).toBe(2400);
    expect(sweep[5]).toBe(4);
    expect(sweep[6]).toBe(5);
    expect(sweep[7]).toBe(computeXorChecksum(sweep, 7));
  });

  it('decodes 0x84 Spectrum frame with 0.5 dBFS resolution and status flags', () => {
    const bins = 256;
    const payload = new Uint8Array(8 + bins);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 1910, true);
    payload[2] = 1; // 40 MHz
    payload[3] = 38;
    view.setUint16(4, bins, true);
    payload[6] = SDR_FLAG_LO_DIV_ACTIVE | SDR_FLAG_ADC_CLIP;
    payload[7] = 0;

    // 0 -> -127.5 dBFS, 255 -> 0.0 dBFS, 175 -> -40.0 dBFS
    payload[8] = 0;
    payload[9] = 175;
    payload[10] = 255;

    const frame = decodeSdrSpectrumFrame(payload);
    expect(frame).not.toBeNull();
    expect(frame!.centerFreqMhz).toBe(1910);
    expect(frame!.spanMhz).toBe(40);
    expect(frame!.activeGainIndex).toBe(38);
    expect(frame!.fftBins).toBe(bins);
    expect(frame!.loDivActive).toBe(true);
    expect(frame!.adcClip).toBe(true);
    expect(frame!.captureTruncated).toBe(false);
    expect(frame!.powerDbFs[0]).toBeCloseTo(-127.5, 4);
    expect(frame!.powerDbFs[1]).toBeCloseTo(-40.0, 4);
    expect(frame!.powerDbFs[2]).toBeCloseTo(0.0, 4);
  });

  it('decodes 0x85 Raw I/Q frame into signed Int8Arrays', () => {
    const nSamples = 4;
    const payload = new Uint8Array(8 + nSamples * 2);
    const view = new DataView(payload.buffer);
    view.setUint16(0, 2437, true);
    payload[2] = 0;
    payload[3] = 24;
    view.setUint16(4, nSamples, true);
    payload[6] = 0;

    const pairs = [
      [127, -128],
      [-45, 60],
      [0, -1],
      [88, 12],
    ];
    pairs.forEach(([iVal, qVal], idx) => {
      payload[8 + idx * 2] = iVal & 0xff;
      payload[8 + idx * 2 + 1] = qVal & 0xff;
    });

    const decoded = decodeSdrRawIqFrame(payload);
    expect(decoded).not.toBeNull();
    expect(decoded!.sampleCount).toBe(nSamples);
    expect(Array.from(decoded!.iSamples)).toEqual([127, -45, 0, 88]);
    expect(Array.from(decoded!.qSamples)).toEqual([-128, 60, -1, 12]);
  });

  it('identifies sdrCapable from 0x83 capabilities JSON', () => {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({ board: 'XIAO-ESP32-S3', sdr: true, capFlags: 7 }),
    );
    const s3 = decodeBoardCapabilities(jsonBytes);
    expect(s3?.sdrCapable).toBe(true);

    const wrapped = encodeResponseFrame(TYPE_BOARD_CAPABILITIES, jsonBytes);
    expect(wrapped[2]).toBe(TYPE_BOARD_CAPABILITIES);
    expect(TYPE_SDR_SPECTRUM_FRAME).toBe(0x84);
    expect(TYPE_SDR_RAW_IQ_FRAME).toBe(0x85);
  });
});
