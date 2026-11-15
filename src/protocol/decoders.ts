import { CHANNELS, CaptureDataFrame } from './types';

export type DecoderKind = 'none' | 'uart' | 'spi' | 'i2c';

export interface DecoderConfig {
  kind: DecoderKind;
  uart: {
    rxCh: number;
    baud: number;
    invert: boolean;
  };
  spi: {
    clkCh: number;
    mosiCh: number;
    misoCh: number | null;
    csCh: number | null;
    cpol: 0 | 1;
    cpha: 0 | 1;
    bitOrder: 'msb' | 'lsb';
  };
  i2c: {
    sclCh: number;
    sdaCh: number;
  };
}

export const DEFAULT_DECODER_CONFIG: DecoderConfig = {
  kind: 'none',
  uart: {
    rxCh: 6,
    baud: 115200,
    invert: false,
  },
  spi: {
    clkCh: 0,
    mosiCh: 1,
    misoCh: 2,
    csCh: 3,
    cpol: 0,
    cpha: 0,
    bitOrder: 'msb',
  },
  i2c: {
    sclCh: 4,
    sdaCh: 5,
  },
};

export type FrameBadgeKind = 'data' | 'addr' | 'start' | 'stop' | 'error';

export interface DecodedFrameAnnotation {
  id: number;
  protocol: Exclude<DecoderKind, 'none'>;
  channel: number;
  secondaryChannel?: number;
  startSample: number;
  endSample: number;
  label: string;
  secondaryLabel?: string;
  detail: string;
  kind: FrameBadgeKind;
  rawByte?: number;
  framingError?: boolean;
}

export interface PulseMeasurement {
  channel: number;
  level: 0 | 1;
  startSample: number;
  endSample: number;
  widthSamples: number;
  widthSec: number;
  periodSamples: number | null;
  periodSec: number | null;
  frequencyHz: number | null;
  dutyPercent: number | null;
}

function bitAt(samples: Uint8Array, ch: number, idx: number): 0 | 1 {
  return ((samples[idx] >> ch) & 1) as 0 | 1;
}

export function findNearestEdge(
  samples: Uint8Array,
  ch: number,
  targetIdx: number,
  maxRadius: number
): number | null {
  if (samples.length < 2) return null;
  const center = Math.max(1, Math.min(samples.length - 1, Math.round(targetIdx)));
  const radius = Math.max(0, Math.ceil(maxRadius));
  let bestIdx: number | null = null;
  let bestDist = Infinity;

  const lo = Math.max(1, center - radius);
  const hi = Math.min(samples.length - 1, center + radius);
  for (let i = lo; i <= hi; i++) {
    if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
      const dist = Math.abs(i - targetIdx);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

export function findNextChannelEdge(
  samples: Uint8Array,
  ch: number,
  fromIdx: number,
  dir: -1 | 1
): number | null {
  if (samples.length < 2) return null;
  if (dir === 1) {
    const start = Math.max(1, Math.floor(fromIdx) + 1);
    for (let i = start; i < samples.length; i++) {
      if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
        return i;
      }
    }
    return null;
  }

  const start = Math.min(samples.length - 1, Math.ceil(fromIdx) - 1);
  for (let i = start; i >= 1; i--) {
    if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
      return i;
    }
  }
  return null;
}

export function countChannelEdges(
  samples: Uint8Array,
  ch: number,
  startIdx: number,
  endIdx: number
): { rising: number; falling: number } {
  if (samples.length < 2) return { rising: 0, falling: 0 };
  const a = Math.round(Math.min(startIdx, endIdx));
  const b = Math.round(Math.max(startIdx, endIdx));
  const lo = Math.max(1, a + 1);
  const hi = Math.min(samples.length - 1, b);
  let rising = 0;
  let falling = 0;
  for (let i = lo; i <= hi; i++) {
    const prev = bitAt(samples, ch, i - 1);
    const cur = bitAt(samples, ch, i);
    if (prev === 0 && cur === 1) rising++;
    else if (prev === 1 && cur === 0) falling++;
  }
  return { rising, falling };
}

export function measurePulseAtSample(
  samples: Uint8Array,
  ch: number,
  sampleIdx: number,
  sampleRateHz: number
): PulseMeasurement | null {
  if (samples.length < 3 || sampleRateHz <= 0) return null;
  const idx = Math.max(0, Math.min(samples.length - 1, Math.floor(sampleIdx)));
  const level = bitAt(samples, ch, idx);

  let leftEdge: number | null = null;
  for (let i = idx; i >= 1; i--) {
    if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
      leftEdge = i;
      break;
    }
  }
  if (leftEdge === null) return null;

  let rightEdge: number | null = null;
  for (let i = idx + 1; i < samples.length; i++) {
    if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
      rightEdge = i;
      break;
    }
  }
  if (rightEdge === null) return null;

  const widthSamples = rightEdge - leftEdge;
  const widthSec = widthSamples / sampleRateHz;

  // Find full period via next opposite half-cycle, or fallback to previous half-cycle
  let periodSamples: number | null = null;
  for (let i = rightEdge + 1; i < samples.length; i++) {
    if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
      periodSamples = i - leftEdge;
      break;
    }
  }
  if (periodSamples === null) {
    for (let i = leftEdge - 1; i >= 1; i--) {
      if (bitAt(samples, ch, i) !== bitAt(samples, ch, i - 1)) {
        periodSamples = rightEdge - i;
        break;
      }
    }
  }

  let periodSec: number | null = null;
  let frequencyHz: number | null = null;
  let dutyPercent: number | null = null;
  if (periodSamples !== null && periodSamples > 0) {
    periodSec = periodSamples / sampleRateHz;
    frequencyHz = sampleRateHz / periodSamples;
    const highSamples = level === 1 ? widthSamples : periodSamples - widthSamples;
    dutyPercent = Math.max(0, Math.min(100, (highSamples / periodSamples) * 100));
  }

  return {
    channel: ch,
    level,
    startSample: leftEdge,
    endSample: rightEdge,
    widthSamples,
    widthSec,
    periodSamples,
    periodSec,
    frequencyHz,
    dutyPercent,
  };
}

function formatByteLabel(byte: number): { hex: string; ascii: string | null } {
  const hex = `0x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  if (byte >= 0x20 && byte <= 0x7e) {
    return { hex, ascii: `'${String.fromCharCode(byte)}'` };
  }
  if (byte === 0x0d) return { hex, ascii: '\\r' };
  if (byte === 0x0a) return { hex, ascii: '\\n' };
  if (byte === 0x09) return { hex, ascii: '\\t' };
  if (byte === 0x00) return { hex, ascii: '\\0' };
  return { hex, ascii: null };
}

export function decodeUart(
  samples: Uint8Array,
  sampleRateHz: number,
  opts: DecoderConfig['uart']
): DecodedFrameAnnotation[] {
  const results: DecodedFrameAnnotation[] = [];
  if (samples.length < 4 || sampleRateHz <= 0 || opts.baud <= 0) return results;

  const bitSamples = sampleRateHz / opts.baud;
  if (!Number.isFinite(bitSamples) || bitSamples < 2) return results;

  const idleLevel: 0 | 1 = opts.invert ? 0 : 1;
  const activeLevel: 0 | 1 = opts.invert ? 1 : 0;
  let idCounter = 1;
  let i = 1;

  while (i < samples.length) {
    const prev = bitAt(samples, opts.rxCh, i - 1);
    const cur = bitAt(samples, opts.rxCh, i);
    if (prev !== idleLevel || cur !== activeLevel) {
      i++;
      continue;
    }

    const startMid = Math.round(i + 0.5 * bitSamples);
    if (startMid >= samples.length) break;
    if (bitAt(samples, opts.rxCh, startMid) !== activeLevel) {
      i++;
      continue;
    }

    const stopMid = Math.round(i + 9.5 * bitSamples);
    if (stopMid >= samples.length) break;

    let byteVal = 0;
    for (let b = 0; b < 8; b++) {
      const bitPos = Math.round(i + (1.5 + b) * bitSamples);
      const raw = bitAt(samples, opts.rxCh, bitPos);
      const logical = opts.invert ? raw ^ 1 : raw;
      byteVal |= logical << b;
    }

    const stopRaw = bitAt(samples, opts.rxCh, stopMid);
    const framingError = stopRaw !== idleLevel;
    const endSample = Math.min(samples.length - 1, Math.round(i + 10 * bitSamples));
    const { hex, ascii } = formatByteLabel(byteVal);
    const label = ascii ? `${hex} ${ascii}` : hex;

    results.push({
      id: idCounter++,
      protocol: 'uart',
      channel: opts.rxCh,
      startSample: i,
      endSample,
      label: framingError ? `${label} !ERR` : label,
      detail: `UART ${hex}${ascii ? ` (${ascii})` : ''}${framingError ? ' [Framing Error]' : ''}`,
      kind: framingError ? 'error' : 'data',
      rawByte: byteVal,
      framingError,
    });

    // Advance just past stop-bit center so back-to-back bytes with slight clock drift still catch the next start edge
    i = Math.max(i + 1, stopMid);
  }

  return results;
}

export function decodeSpi(
  samples: Uint8Array,
  opts: DecoderConfig['spi']
): DecodedFrameAnnotation[] {
  const results: DecodedFrameAnnotation[] = [];
  if (samples.length < 4) return results;

  // Leading edge: CPOL=0 -> rising (0->1), CPOL=1 -> falling (1->0)
  // Sample edge: CPHA=0 -> leading, CPHA=1 -> trailing
  const sampleOnRising = opts.cpol === opts.cpha;
  let idCounter = 1;
  let bitCount = 0;
  let mosiByte = 0;
  let misoByte = 0;
  let byteStartSample = 0;

  for (let i = 1; i < samples.length; i++) {
    if (opts.csCh !== null) {
      const csCur = bitAt(samples, opts.csCh, i);
      if (csCur === 1) {
        bitCount = 0;
        mosiByte = 0;
        misoByte = 0;
        continue;
      }
    }

    const prevClk = bitAt(samples, opts.clkCh, i - 1);
    const curClk = bitAt(samples, opts.clkCh, i);
    const isSampleEdge = sampleOnRising
      ? prevClk === 0 && curClk === 1
      : prevClk === 1 && curClk === 0;

    if (!isSampleEdge) continue;

    if (bitCount === 0) {
      byteStartSample = i;
    }

    const mosiBit = bitAt(samples, opts.mosiCh, i);
    const misoBit = opts.misoCh !== null ? bitAt(samples, opts.misoCh, i) : 0;
    const shiftPos = opts.bitOrder === 'msb' ? 7 - bitCount : bitCount;

    if (mosiBit) mosiByte |= 1 << shiftPos;
    if (misoBit) misoByte |= 1 << shiftPos;
    bitCount++;

    if (bitCount === 8) {
      const mosiFmt = formatByteLabel(mosiByte);
      const misoHex =
        opts.misoCh !== null ? `0x${misoByte.toString(16).toUpperCase().padStart(2, '0')}` : null;
      results.push({
        id: idCounter++,
        protocol: 'spi',
        channel: opts.mosiCh,
        secondaryChannel: opts.misoCh ?? undefined,
        startSample: byteStartSample,
        endSample: Math.min(samples.length - 1, i + 1),
        label: mosiFmt.ascii ? `${mosiFmt.hex} ${mosiFmt.ascii}` : mosiFmt.hex,
        secondaryLabel: misoHex ?? undefined,
        detail:
          misoHex !== null
            ? `SPI MOSI ${mosiFmt.hex}${mosiFmt.ascii ? ` (${mosiFmt.ascii})` : ''} | MISO ${misoHex}`
            : `SPI MOSI ${mosiFmt.hex}${mosiFmt.ascii ? ` (${mosiFmt.ascii})` : ''}`,
        kind: 'data',
        rawByte: mosiByte,
      });
      bitCount = 0;
      mosiByte = 0;
      misoByte = 0;
    }
  }

  return results;
}

export function decodeI2c(
  samples: Uint8Array,
  opts: DecoderConfig['i2c']
): DecodedFrameAnnotation[] {
  const results: DecodedFrameAnnotation[] = [];
  if (samples.length < 4) return results;

  let idCounter = 1;
  let inTransaction = false;
  let isAddressPhase = true;
  let bitCount = 0;
  let curByte = 0;
  let byteStartSample = 0;

  for (let i = 1; i < samples.length; i++) {
    const prevScl = bitAt(samples, opts.sclCh, i - 1);
    const curScl = bitAt(samples, opts.sclCh, i);
    const prevSda = bitAt(samples, opts.sdaCh, i - 1);
    const curSda = bitAt(samples, opts.sdaCh, i);

    // START or Repeated START: SDA falling while SCL stays high
    if (prevScl === 1 && curScl === 1 && prevSda === 1 && curSda === 0) {
      const label = inTransaction ? 'Sr' : 'S';
      inTransaction = true;
      isAddressPhase = true;
      bitCount = 0;
      curByte = 0;
      results.push({
        id: idCounter++,
        protocol: 'i2c',
        channel: opts.sdaCh,
        startSample: Math.max(0, i - 1),
        endSample: Math.min(samples.length - 1, i + 1),
        label,
        detail: label === 'Sr' ? 'I2C Repeated START' : 'I2C START',
        kind: 'start',
      });
      continue;
    }

    // STOP: SDA rising while SCL stays high
    if (prevScl === 1 && curScl === 1 && prevSda === 0 && curSda === 1) {
      if (inTransaction) {
        results.push({
          id: idCounter++,
          protocol: 'i2c',
          channel: opts.sdaCh,
          startSample: Math.max(0, i - 1),
          endSample: Math.min(samples.length - 1, i + 1),
          label: 'P',
          detail: 'I2C STOP',
          kind: 'stop',
        });
      }
      inTransaction = false;
      isAddressPhase = true;
      bitCount = 0;
      curByte = 0;
      continue;
    }

    // Data / ACK sampled on rising edge of SCL
    if (inTransaction && prevScl === 0 && curScl === 1) {
      if (bitCount < 8) {
        if (bitCount === 0) {
          byteStartSample = i;
        }
        curByte = (curByte << 1) | curSda;
        bitCount++;
      } else {
        const ack = curSda === 0;
        const ackStr = ack ? 'ACK' : 'NACK';
        if (isAddressPhase) {
          const addr = (curByte >> 1) & 0x7f;
          const rw = (curByte & 1) === 1 ? 'R' : 'W';
          const addrHex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
          results.push({
            id: idCounter++,
            protocol: 'i2c',
            channel: opts.sdaCh,
            startSample: byteStartSample,
            endSample: Math.min(samples.length - 1, i + 1),
            label: `${addrHex} ${rw} ${ackStr}`,
            detail: `I2C Addr ${addrHex} (${rw === 'W' ? 'Write' : 'Read'}) ${ackStr}`,
            kind: ack ? 'addr' : 'error',
            rawByte: curByte,
          });
          isAddressPhase = false;
        } else {
          const byteFmt = formatByteLabel(curByte);
          results.push({
            id: idCounter++,
            protocol: 'i2c',
            channel: opts.sdaCh,
            startSample: byteStartSample,
            endSample: Math.min(samples.length - 1, i + 1),
            label: `${byteFmt.hex} ${ackStr}`,
            detail: `I2C Data ${byteFmt.hex}${byteFmt.ascii ? ` (${byteFmt.ascii})` : ''} ${ackStr}`,
            kind: ack ? 'data' : 'error',
            rawByte: curByte,
          });
        }
        bitCount = 0;
        curByte = 0;
      }
    }
  }

  return results;
}

export function decodeProtocol(
  samples: Uint8Array,
  sampleRateHz: number,
  config: DecoderConfig
): DecodedFrameAnnotation[] {
  switch (config.kind) {
    case 'uart':
      return decodeUart(samples, sampleRateHz, config.uart);
    case 'spi':
      return decodeSpi(samples, config.spi);
    case 'i2c':
      return decodeI2c(samples, config.i2c);
    default:
      return [];
  }
}

export function exportCaptureToCsv(
  capture: CaptureDataFrame,
  channelNames?: readonly string[]
): string {
  const headers = CHANNELS.map((meta, ch) => {
    const alias = channelNames?.[ch]?.trim();
    const label = alias && alias !== meta.label ? `${meta.label}_${alias}` : meta.label;
    return label.replace(/[\s,;"']/g, '_');
  });

  const lines = new Array<string>(capture.samples.length + 1);
  lines[0] = `sample_index,time_s,${headers.join(',')}`;

  const rate = capture.sampleRateHz > 0 ? capture.sampleRateHz : 1;
  for (let i = 0; i < capture.samples.length; i++) {
    const s = capture.samples[i];
    const t = (i / rate).toFixed(9);
    lines[i + 1] = `${i},${t},${s & 1},${(s >> 1) & 1},${(s >> 2) & 1},${(s >> 3) & 1},${(s >> 4) & 1},${(s >> 5) & 1},${(s >> 6) & 1},${(s >> 7) & 1}`;
  }

  return lines.join('\n') + '\n';
}

const VCD_SYMBOLS = ['!', '"', '#', '$', '%', '&', "'", '('] as const;

export function exportCaptureToVcd(
  capture: CaptureDataFrame,
  channelNames?: readonly string[]
): string {
  const rate = capture.sampleRateHz > 0 ? capture.sampleRateHz : 1_000_000;
  const psPerSample = Math.max(1, Math.round(1e12 / rate));

  const out: string[] = [
    '$version HotWire Logic Analyzer $end',
    '$timescale 1ps $end',
    '$scope module hotwire $end',
  ];

  for (let ch = 0; ch < 8; ch++) {
    const meta = CHANNELS[ch];
    const alias = channelNames?.[ch]?.trim();
    const rawName = alias && alias !== meta.label ? `${meta.label}_${alias}` : meta.label;
    const safeName = rawName.replace(/[^A-Za-z0-9_]/g, '_') || meta.label;
    out.push(`$var wire 1 ${VCD_SYMBOLS[ch]} ${safeName} $end`);
  }

  out.push('$upscope $end', '$enddefinitions $end', '$dumpvars');

  if (capture.samples.length > 0) {
    const first = capture.samples[0];
    for (let ch = 0; ch < 8; ch++) {
      out.push(`${(first >> ch) & 1}${VCD_SYMBOLS[ch]}`);
    }
    out.push('$end');

    let prev = first;
    for (let i = 1; i < capture.samples.length; i++) {
      const cur = capture.samples[i];
      const diff = cur ^ prev;
      if (diff === 0) continue;
      out.push(`#${i * psPerSample}`);
      for (let ch = 0; ch < 8; ch++) {
        if ((diff >> ch) & 1) {
          out.push(`${(cur >> ch) & 1}${VCD_SYMBOLS[ch]}`);
        }
      }
      prev = cur;
    }
  } else {
    for (let ch = 0; ch < 8; ch++) {
      out.push(`0${VCD_SYMBOLS[ch]}`);
    }
    out.push('$end');
  }

  return out.join('\n') + '\n';
}
