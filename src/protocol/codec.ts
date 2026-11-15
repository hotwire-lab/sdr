import {
  BoardCapabilitiesFrame,
  BoardCapabilityPin,
  CaptureDataFrame,
  CHANNELS,
  CMD_BOOTLOADER,
  CMD_FORCE_BATCH_STATE,
  CMD_FORCE_PIN_STATE,
  CMD_GET_CAPS,
  CMD_LA_ABORT,
  CMD_LA_CAPTURE,
  CMD_PING_STATUS,
  CMD_SDR_STREAM_CTRL,
  CMD_SDR_SWEEP_CFG,
  CMD_SDR_TUNE,
  CMD_SET_SIG_GEN,
  DecodedFrame,
  LA_FLAG_ABORTED_EARLY,
  LA_FLAG_TRIGGERED,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  SDR_FLAG_ADC_CLIP,
  SDR_FLAG_CAPTURE_TRUNCATED,
  SDR_FLAG_LO_DIV_ACTIVE,
  SDR_GAIN_AGC,
  SDR_MAX_FREQ_MHZ,
  SDR_MAX_MANUAL_GAIN,
  SDR_MIN_FREQ_MHZ,
  SDR_SAMPLE_RATE_PRESETS,
  SdrRawIqFrame,
  SdrSpectrumFrame,
  StatusTelemetryFrame,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_SDR_RAW_IQ_FRAME,
  TYPE_SDR_SPECTRUM_FRAME,
  TYPE_STATUS_TELEMETRY,
} from './types';

export function computeXorChecksum(bytes: Uint8Array, length = bytes.byteLength): number {
  let xor = 0;
  for (let i = 0; i < length; i++) {
    xor ^= bytes[i];
  }
  return xor & 0xff;
}

export function buildCommandFrame(
  cmdId: number,
  p1 = 0,
  p2 = 0,
  p3 = 0,
  p4 = 0,
): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = PROTOCOL_SYNC_0;
  frame[1] = PROTOCOL_SYNC_1;
  frame[2] = cmdId & 0xff;
  frame[3] = p1 & 0xff;
  frame[4] = p2 & 0xff;
  frame[5] = p3 & 0xff;
  frame[6] = p4 & 0xff;
  frame[7] = computeXorChecksum(frame, 7);
  return frame;
}

export function buildPingStatusCmd(): Uint8Array {
  return buildCommandFrame(CMD_PING_STATUS);
}

export function buildPingTelemetryCmd(): Uint8Array {
  return buildPingStatusCmd();
}

export function buildGetCapsCmd(): Uint8Array {
  return buildCommandFrame(CMD_GET_CAPS);
}

export function buildQueryCapabilitiesCmd(): Uint8Array {
  return buildGetCapsCmd();
}

export function buildPinForceCmd(
  ch: number,
  modeCode: number,
  pullCode = 0,
  autoProtect = 1,
): Uint8Array {
  return buildCommandFrame(CMD_FORCE_PIN_STATE, ch, modeCode, pullCode, autoProtect);
}

export function buildForcePinStateCmd(ch: number, modeCode: number): Uint8Array {
  return buildPinForceCmd(ch, modeCode);
}

export function buildBatchForceCmd(
  forceEnableMask: number,
  forcedLevelMask: number,
  pullMask = 0,
): Uint8Array {
  return buildCommandFrame(
    CMD_FORCE_BATCH_STATE,
    forceEnableMask,
    forcedLevelMask,
    pullMask,
  );
}

export function buildForceBatchStateCmd(
  dirMask: number,
  outMask: number,
): Uint8Array {
  return buildBatchForceCmd(dirMask, outMask);
}

export function buildSetSigGenCmd(
  ch: number,
  dividerCode: number,
  freqHigh = 0,
  freqLow = 0,
): Uint8Array {
  return buildCommandFrame(CMD_SET_SIG_GEN, ch, dividerCode, freqHigh, freqLow);
}

export function buildLaCaptureCmd(
  rateId: number,
  trigCh: number,
  trigEdgeAndPreRatio: number,
  blocksKb: number,
): Uint8Array {
  return buildCommandFrame(
    CMD_LA_CAPTURE,
    rateId,
    trigCh,
    trigEdgeAndPreRatio,
    blocksKb,
  );
}

export function buildLaAbortCmd(): Uint8Array {
  return buildCommandFrame(CMD_LA_ABORT);
}

export function buildBootloaderCmd(): Uint8Array {
  return buildCommandFrame(CMD_BOOTLOADER, 0xb0, 0x07, 0x10, 0xad);
}

export function clampSdrFreqMhz(freqMhz: number): number {
  const rounded = Math.round(freqMhz);
  return Math.max(SDR_MIN_FREQ_MHZ, Math.min(SDR_MAX_FREQ_MHZ, rounded));
}

export function clampSdrGainIndex(gainIndex: number): number {
  if (gainIndex === SDR_GAIN_AGC || gainIndex < 0) {
    return SDR_GAIN_AGC;
  }
  return Math.max(0, Math.min(SDR_MAX_MANUAL_GAIN, Math.round(gainIndex)));
}

export function buildSdrTuneCmd(
  centerFreqMhz: number,
  rateBwCode: number,
  gainIndex: number,
): Uint8Array {
  const freq = clampSdrFreqMhz(centerFreqMhz);
  const gain = clampSdrGainIndex(gainIndex);
  return buildCommandFrame(
    CMD_SDR_TUNE,
    freq & 0xff,
    (freq >> 8) & 0xff,
    rateBwCode & 0x03,
    gain & 0xff,
  );
}

export function buildSdrStreamCtrlCmd(
  streamMode: number,
  sizeParam: number,
  dspFlags: number,
  targetFps: number,
): Uint8Array {
  const clampedFps = Math.max(1, Math.min(60, Math.round(targetFps)));
  return buildCommandFrame(
    CMD_SDR_STREAM_CTRL,
    streamMode & 0xff,
    sizeParam & 0xff,
    dspFlags & 0xff,
    clampedFps,
  );
}

export function buildSdrSweepCfgCmd(
  startFreqMhz: number,
  stepCount: number,
  dwellFrames: number,
): Uint8Array {
  const freq = clampSdrFreqMhz(startFreqMhz);
  return buildCommandFrame(
    CMD_SDR_SWEEP_CFG,
    freq & 0xff,
    (freq >> 8) & 0xff,
    Math.max(0, Math.min(255, Math.round(stepCount))),
    Math.max(1, Math.min(255, Math.round(dwellFrames))),
  );
}

export function encodeResponseFrame(typeId: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  const frame = new Uint8Array(6 + len);
  frame[0] = PROTOCOL_SYNC_0;
  frame[1] = PROTOCOL_SYNC_1;
  frame[2] = typeId & 0xff;
  frame[3] = len & 0xff;
  frame[4] = (len >> 8) & 0xff;
  frame.set(payload, 5);
  frame[5 + len] = computeXorChecksum(frame, 5 + len);
  return frame;
}

export function resolveSdrRatePreset(rateBwCode: number) {
  return (
    SDR_SAMPLE_RATE_PRESETS.find((preset) => preset.code === (rateBwCode & 0x03)) ??
    SDR_SAMPLE_RATE_PRESETS[0]
  );
}

export function decodeStatusTelemetry(payload: Uint8Array): StatusTelemetryFrame | null {
  if (payload.byteLength !== 4) return null;
  return {
    type: 'telemetry',
    physicalLevels: payload[0],
    forceEnable: payload[1],
    forceEnableMask: payload[1],
    forcedLevel: payload[2],
    forcedLevels: payload[2],
    contentionMask: payload[3],
    timestampMs: Date.now(),
  };
}

export function decodeCaptureData(payload: Uint8Array): CaptureDataFrame | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const rateHz = view.getUint32(0, true);
  const trigIndex = view.getUint16(4, true);
  const flags = view.getUint16(6, true);
  const triggered = (flags & LA_FLAG_TRIGGERED) !== 0;
  const samples = payload.slice(8);
  return {
    type: 'capture',
    rateHz,
    sampleRateHz: rateHz,
    trigIndex,
    triggerIndex: trigIndex,
    flags,
    triggered,
    autoTriggered: !triggered,
    abortedEarly: (flags & LA_FLAG_ABORTED_EARLY) !== 0,
    samples,
    timestampMs: Date.now(),
  };
}

export function decodeBoardCapabilities(
  payload: Uint8Array,
): BoardCapabilitiesFrame | null {
  if (payload.byteLength < 2) return null;
  const raw = new TextDecoder().decode(payload);
  try {
    const parsed = JSON.parse(raw) as {
      board?: string;
      firmware?: string;
      channels?: number;
      maxRateHz?: number;
      maxDepth?: number;
      pins?: BoardCapabilityPin[];
      sdr?: boolean;
      capFlags?: number;
    };
    const board = parsed.board ?? 'XIAO-ESP32-S3';
    const capFlags = typeof parsed.capFlags === 'number' ? parsed.capFlags : 0;
    const sdrCapable = Boolean(
      parsed.sdr ||
        (capFlags & 0x04) !== 0 ||
        board.toUpperCase().includes('S3'),
    );
    return {
      type: 'capabilities',
      board,
      firmware: parsed.firmware ?? '1.0.0',
      channels: typeof parsed.channels === 'number' ? parsed.channels : 8,
      maxRateHz: typeof parsed.maxRateHz === 'number' ? parsed.maxRateHz : 20_000_000,
      maxDepth: typeof parsed.maxDepth === 'number' ? parsed.maxDepth : 32768,
      pins: Array.isArray(parsed.pins)
        ? parsed.pins
        : CHANNELS.map((c) => ({ ch: c.ch, label: c.label, gpio: c.gpio })),
      sdrCapable,
    };
  } catch {
    return null;
  }
}

export function decodeSdrSpectrumFrame(payload: Uint8Array): SdrSpectrumFrame | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const centerFreqMhz = view.getUint16(0, true);
  const rateBwCode = payload[2];
  const activeGainIndex = payload[3];
  const fftBins = view.getUint16(4, true);
  const statusFlags = payload[6];

  if (fftBins === 0 || payload.byteLength !== 8 + fftBins) {
    return null;
  }

  const rawBytes = payload.slice(8, 8 + fftBins);
  const powerDbFs = new Float32Array(fftBins);
  for (let i = 0; i < fftBins; i++) {
    powerDbFs[i] = rawBytes[i] * 0.5 - 127.5;
  }

  const ratePreset = resolveSdrRatePreset(rateBwCode);
  return {
    type: 'sdrSpectrum',
    centerFreqMhz,
    rateBwCode,
    sampleRateHz: ratePreset.sampleRateHz,
    spanMhz: ratePreset.spanMhz,
    activeGainIndex,
    fftBins,
    statusFlags,
    adcClip: (statusFlags & SDR_FLAG_ADC_CLIP) !== 0,
    captureTruncated: (statusFlags & SDR_FLAG_CAPTURE_TRUNCATED) !== 0,
    loDivActive: (statusFlags & SDR_FLAG_LO_DIV_ACTIVE) !== 0,
    powerDbFs,
    rawBytes,
    timestampMs: Date.now(),
  };
}

export function decodeSdrRawIqFrame(payload: Uint8Array): SdrRawIqFrame | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const centerFreqMhz = view.getUint16(0, true);
  const rateBwCode = payload[2];
  const activeGainIndex = payload[3];
  const sampleCount = view.getUint16(4, true);
  const statusFlags = payload[6];

  if (sampleCount === 0 || payload.byteLength !== 8 + sampleCount * 2) {
    return null;
  }

  const iSamples = new Int8Array(sampleCount);
  const qSamples = new Int8Array(sampleCount);
  for (let n = 0; n < sampleCount; n++) {
    const offset = 8 + n * 2;
    const rawI = payload[offset];
    const rawQ = payload[offset + 1];
    iSamples[n] = rawI >= 128 ? rawI - 256 : rawI;
    qSamples[n] = rawQ >= 128 ? rawQ - 256 : rawQ;
  }

  const ratePreset = resolveSdrRatePreset(rateBwCode);
  return {
    type: 'sdrRawIq',
    centerFreqMhz,
    rateBwCode,
    sampleRateHz: ratePreset.sampleRateHz,
    spanMhz: ratePreset.spanMhz,
    activeGainIndex,
    sampleCount,
    statusFlags,
    adcClip: (statusFlags & SDR_FLAG_ADC_CLIP) !== 0,
    captureTruncated: (statusFlags & SDR_FLAG_CAPTURE_TRUNCATED) !== 0,
    loDivActive: (statusFlags & SDR_FLAG_LO_DIV_ACTIVE) !== 0,
    iSamples,
    qSamples,
    timestampMs: Date.now(),
  };
}

export function decodeResponsePayload(
  typeId: number,
  payload: Uint8Array,
): DecodedFrame | null {
  switch (typeId) {
    case TYPE_STATUS_TELEMETRY:
      return decodeStatusTelemetry(payload);
    case TYPE_LA_CAPTURE_DATA:
      return decodeCaptureData(payload);
    case TYPE_BOARD_CAPABILITIES:
      return decodeBoardCapabilities(payload);
    case TYPE_SDR_SPECTRUM_FRAME:
      return decodeSdrSpectrumFrame(payload);
    case TYPE_SDR_RAW_IQ_FRAME:
      return decodeSdrRawIqFrame(payload);
    default:
      return null;
  }
}
