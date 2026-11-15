export const SYNC_BYTE_1 = 0xaa;
export const SYNC_BYTE_2 = 0x55;
export const PROTOCOL_SYNC_0 = SYNC_BYTE_1;
export const PROTOCOL_SYNC_1 = SYNC_BYTE_2;

export const CMD_PING_TELEMETRY = 0x01;
export const CMD_PING_STATUS = CMD_PING_TELEMETRY;
export const CMD_QUERY_CAPABILITIES = 0x02;
export const CMD_GET_CAPS = CMD_QUERY_CAPABILITIES;
export const CMD_FORCE_PIN_STATE = 0x10;
export const CMD_PIN_FORCE = CMD_FORCE_PIN_STATE;
export const CMD_FORCE_BATCH_STATE = 0x11;
export const CMD_BATCH_FORCE = CMD_FORCE_BATCH_STATE;
export const CMD_SET_SIG_GEN = 0x12;
export const CMD_SDR_TUNE = 0x30;
export const CMD_SDR_STREAM_CTRL = 0x31;
export const CMD_SDR_SWEEP_CFG = 0x32;
export const CMD_ENTER_BOOTLOADER = 0xf0;
export const CMD_BOOTLOADER = CMD_ENTER_BOOTLOADER;

export const TYPE_STATUS_TELEMETRY = 0x81;
export const TYPE_BOARD_CAPABILITIES = 0x83;
export const TYPE_SDR_SPECTRUM_FRAME = 0x84;
export const TYPE_SDR_RAW_IQ_FRAME = 0x85;

export const MAX_FRAME_PAYLOAD_LEN = 32776;

export const SDR_MIN_FREQ_MHZ = 1842;
export const SDR_MAX_FREQ_MHZ = 2790;
export const SDR_LO_DIVIDER_THRESHOLD_MHZ = 2210;
export const SDR_GAIN_AGC = 0xff;
export const SDR_MAX_MANUAL_GAIN = 72;

export const SDR_FLAG_ADC_CLIP = 0x01;
export const SDR_FLAG_CAPTURE_TRUNCATED = 0x02;
export const SDR_FLAG_LO_DIV_ACTIVE = 0x04;

export const SDR_STREAM_STOP = 0;
export const SDR_STREAM_FFT = 1;
export const SDR_STREAM_SINGLE_IQ = 2;
export const SDR_STREAM_CONT_IQ = 3;

export const SDR_DSP_FLAG_MAX_HOLD = 0x01;
export const SDR_DSP_FLAG_DC_CANCEL = 0x02;

export type PinForceMode = 0 | 1 | 2;
export type PinPullMode = 0 | 1 | 2;
export type PinForceState = 'Z' | '0' | '1' | 'PU' | 'PD' | 'SIG';

export interface ChannelMeta {
  ch: number;
  label: string;
  gpio: number;
  name: string;
  color: string;
  sigGenSupported?: boolean;
}

export const CHANNELS: ChannelMeta[] = [
  { ch: 0, label: 'D0', gpio: 1, name: 'CH0 (D0)', color: '#38bdf8' },
  { ch: 1, label: 'D1', gpio: 2, name: 'CH1 (D1)', color: '#34d399' },
  { ch: 2, label: 'D2', gpio: 3, name: 'CH2 (D2)', color: '#fbbf24' },
  { ch: 3, label: 'D3', gpio: 4, name: 'CH3 (D3)', color: '#f472b6' },
  { ch: 4, label: 'D4', gpio: 5, name: 'CH4 (D4)', color: '#a78bfa' },
  { ch: 5, label: 'D5', gpio: 6, name: 'CH5 (D5)', color: '#fb923c' },
  { ch: 6, label: 'D6', gpio: 43, name: 'CH6 (D6)', color: '#22d3ee' },
  { ch: 7, label: 'D7', gpio: 44, name: 'CH7 (D7)', color: '#e879f9', sigGenSupported: true },
];

export interface SdrSampleRatePreset {
  code: number;
  label: string;
  spanMhz: number;
  sampleRateHz: number;
}

export const SDR_SAMPLE_RATE_PRESETS: SdrSampleRatePreset[] = [
  { code: 0, label: '80 MHz', spanMhz: 80, sampleRateHz: 80_000_000 },
  { code: 1, label: '40 MHz', spanMhz: 40, sampleRateHz: 40_000_000 },
  { code: 2, label: '20 MHz', spanMhz: 20, sampleRateHz: 20_000_000 },
  { code: 3, label: '16 MHz', spanMhz: 16, sampleRateHz: 16_000_000 },
];

export interface SdrFftSizePreset {
  log2: number;
  bins: number;
  label: string;
}

export const SDR_FFT_SIZE_PRESETS: SdrFftSizePreset[] = [
  { log2: 8, bins: 256, label: '256' },
  { log2: 9, bins: 512, label: '512' },
  { log2: 10, bins: 1024, label: '1024' },
  { log2: 11, bins: 2048, label: '2048' },
];

export interface SdrBandPreset {
  freqMhz: number;
  label: string;
  shortLabel: string;
  sub2210?: boolean;
}

export const SDR_BAND_PRESETS: SdrBandPreset[] = [
  { freqMhz: 1910, label: 'DECT / 1.9 GHz', shortLabel: 'DECT 1910', sub2210: true },
  { freqMhz: 2350, label: '13cm Ham 2350', shortLabel: 'Ham 2350' },
  { freqMhz: 2402, label: 'BLE Adv 37 (2402)', shortLabel: 'BLE 2402' },
  { freqMhz: 2412, label: 'Wi-Fi Ch 1 (2412)', shortLabel: 'Wi-Fi 1' },
  { freqMhz: 2426, label: 'BLE Adv 38 (2426)', shortLabel: 'BLE 2426' },
  { freqMhz: 2437, label: 'Wi-Fi Ch 6 (2437)', shortLabel: 'Wi-Fi 6' },
  { freqMhz: 2462, label: 'Wi-Fi Ch 11 (2462)', shortLabel: 'Wi-Fi 11' },
  { freqMhz: 2480, label: 'BLE Adv 39 (2480)', shortLabel: 'BLE 2480' },
  { freqMhz: 2650, label: 'LTE B7 DL (2650)', shortLabel: 'LTE B7 2650' },
];

export interface StatusTelemetryFrame {
  type: 'telemetry';
  physicalLevels: number;
  forceEnable: number;
  forceEnableMask: number;
  forcedLevel: number;
  forcedLevels: number;
  contentionMask: number;
  timestampMs: number;
}

export type StatusTelemetry = StatusTelemetryFrame;

export interface BoardCapabilityPin {
  ch: number;
  label: string;
  gpio: number;
}

export interface BoardCapabilitiesFrame {
  type: 'capabilities';
  board: string;
  firmware: string;
  channels: number;
  maxRateHz: number;
  maxDepth: number;
  pins: BoardCapabilityPin[];
  sdrCapable: boolean;
}

export type BoardCapabilities = BoardCapabilitiesFrame;

export interface SdrSpectrumFrame {
  type: 'sdrSpectrum';
  centerFreqMhz: number;
  rateBwCode: number;
  sampleRateHz: number;
  spanMhz: number;
  activeGainIndex: number;
  fftBins: number;
  statusFlags: number;
  adcClip: boolean;
  captureTruncated: boolean;
  loDivActive: boolean;
  powerDbFs: Float32Array;
  rawBytes: Uint8Array;
  timestampMs: number;
}

export interface SdrRawIqFrame {
  type: 'sdrRawIq';
  centerFreqMhz: number;
  rateBwCode: number;
  sampleRateHz: number;
  spanMhz: number;
  activeGainIndex: number;
  sampleCount: number;
  statusFlags: number;
  adcClip: boolean;
  captureTruncated: boolean;
  loDivActive: boolean;
  iSamples: Int8Array;
  qSamples: Int8Array;
  timestampMs: number;
}

export type DecodedFrame =
  | StatusTelemetryFrame
  | BoardCapabilitiesFrame
  | SdrSpectrumFrame
  | SdrRawIqFrame;
