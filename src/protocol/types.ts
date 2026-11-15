export const SYNC_BYTE_1 = 0xaa;
export const SYNC_BYTE_2 = 0x55;
export const PROTOCOL_SYNC_0 = SYNC_BYTE_1;
export const PROTOCOL_SYNC_1 = SYNC_BYTE_2;

export const CMD_PING_STATUS = 0x01;
export const CMD_GET_CAPS = 0x02;
export const CMD_QUERY_CAPABILITIES = CMD_GET_CAPS;
export const CMD_SDR_TUNE = 0x30;
export const CMD_SDR_STREAM_CTRL = 0x31;
export const CMD_SDR_SWEEP_CFG = 0x32;
export const CMD_ENTER_BOOTLOADER = 0xf0;
export const CMD_BOOTLOADER = CMD_ENTER_BOOTLOADER;

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
  { freqMhz: 1890, label: 'DECT EU (1890)', shortLabel: 'DECT 1890', sub2210: true },
  { freqMhz: 2350, label: '13cm Ham (2350)', shortLabel: 'Ham 2350' },
  { freqMhz: 2402, label: 'BLE Adv 37 (2402)', shortLabel: 'BLE 2402' },
  { freqMhz: 2412, label: 'Wi-Fi Ch 1 (2412)', shortLabel: 'Wi-Fi 1' },
  { freqMhz: 2426, label: 'BLE Adv 38 (2426)', shortLabel: 'BLE 2426' },
  { freqMhz: 2437, label: 'Wi-Fi Ch 6 (2437)', shortLabel: 'Wi-Fi 6' },
  { freqMhz: 2462, label: 'Wi-Fi Ch 11 (2462)', shortLabel: 'Wi-Fi 11' },
  { freqMhz: 2472, label: 'Wi-Fi Ch 13 (2472)', shortLabel: 'Wi-Fi 13' },
  { freqMhz: 2480, label: 'BLE Adv 39 (2480)', shortLabel: 'BLE 2480' },
  { freqMhz: 2655, label: 'LTE B7 DL (2655)', shortLabel: 'LTE B7' },
];

export interface BoardCapabilitiesFrame {
  type: 'capabilities';
  board: string;
  firmware: string;
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
  | BoardCapabilitiesFrame
  | SdrSpectrumFrame
  | SdrRawIqFrame;
