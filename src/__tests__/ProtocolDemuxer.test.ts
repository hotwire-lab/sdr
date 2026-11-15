import { describe, expect, it } from 'vitest';
import { ProtocolDemuxer } from '../protocol/ProtocolDemuxer';
import { encodeResponseFrame } from '../protocol/codec';
import {
  DecodedFrame,
  TYPE_BOARD_CAPABILITIES,
  TYPE_SDR_RAW_IQ_FRAME,
  TYPE_SDR_SPECTRUM_FRAME,
} from '../protocol/types';

describe('ProtocolDemuxer with SDR Frames', () => {
  it('separates mixed UTF-8 logs, 0x83 capabilities, 0x84 FFT spectrum, and 0x85 I/Q snapshots', () => {
    const frames: DecodedFrame[] = [];
    const textBytes: number[] = [];

    const demuxer = new ProtocolDemuxer({
      onFrame: (f) => frames.push(f),
      onTerminalBytes: (b) => textBytes.push(...b),
    });

    const banner = new TextEncoder().encode('[SDR] Ready\r\n');
    const capsFrame = encodeResponseFrame(
      TYPE_BOARD_CAPABILITIES,
      new TextEncoder().encode('{"board":"XIAO-ESP32-S3","firmware":"2.0.0-sdr","sdr":true}'),
    );

    const specPayload = new Uint8Array(8 + 256);
    new DataView(specPayload.buffer).setUint16(0, 2412, true);
    new DataView(specPayload.buffer).setUint16(4, 256, true);
    specPayload[3] = 40;
    specPayload[8 + 128] = 195; // -30 dBFS
    const specFrame = encodeResponseFrame(TYPE_SDR_SPECTRUM_FRAME, specPayload);

    const iqPayload = new Uint8Array(8 + 64 * 2);
    new DataView(iqPayload.buffer).setUint16(0, 1910, true);
    new DataView(iqPayload.buffer).setUint16(4, 64, true);
    iqPayload[8] = 50;
    iqPayload[9] = (-25) & 0xff;
    const iqFrame = encodeResponseFrame(TYPE_SDR_RAW_IQ_FRAME, iqPayload);

    const combined = new Uint8Array(
      banner.length + capsFrame.length + specFrame.length + iqFrame.length,
    );
    let off = 0;
    combined.set(banner, off);
    off += banner.length;
    combined.set(capsFrame, off);
    off += capsFrame.length;
    combined.set(specFrame, off);
    off += specFrame.length;
    combined.set(iqFrame, off);

    // Feed in fragmented irregular chunks (serial USB packet split simulation)
    for (let i = 0; i < combined.length; i += 17) {
      demuxer.feed(combined.subarray(i, Math.min(combined.length, i + 17)));
    }

    expect(new TextDecoder().decode(new Uint8Array(textBytes))).toBe('[SDR] Ready\r\n');
    expect(frames.length).toBe(3);
    expect(frames[0].type).toBe('capabilities');
    expect(frames[1].type).toBe('sdrSpectrum');
    expect(frames[2].type).toBe('sdrRawIq');

    if (frames[1].type === 'sdrSpectrum') {
      expect(frames[1].centerFreqMhz).toBe(2412);
      expect(frames[1].powerDbFs[128]).toBeCloseTo(-30, 3);
    }
    if (frames[2].type === 'sdrRawIq') {
      expect(frames[2].iSamples[0]).toBe(50);
      expect(frames[2].qSamples[0]).toBe(-25);
    }
  });

  it('rejects frames with corrupted XOR checksums', () => {
    const frames: DecodedFrame[] = [];
    const demuxer = new ProtocolDemuxer({
      onFrame: (f) => frames.push(f),
      onTerminalBytes: () => {},
    });

    const specPayload = new Uint8Array(8 + 256);
    new DataView(specPayload.buffer).setUint16(0, 2437, true);
    new DataView(specPayload.buffer).setUint16(4, 256, true);
    const frame = encodeResponseFrame(TYPE_SDR_SPECTRUM_FRAME, specPayload);
    frame[frame.length - 1] ^= 0xff; // Corrupt checksum

    demuxer.feed(frame);
    expect(frames.length).toBe(0);
  });
});
