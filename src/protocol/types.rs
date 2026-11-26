pub use hotwire_core::protocol::{
    BoardIdentity, CMD_BOOTLOADER, CMD_GET_CAPS, CMD_PING_STATUS, PROTOCOL_SYNC_0,
    PROTOCOL_SYNC_1, TYPE_BOARD_CAPABILITIES,
};

pub const CMD_SDR_TUNE: u8 = 0x30;
pub const CMD_SDR_STREAM_CTRL: u8 = 0x31;
pub const CMD_SDR_SWEEP_CFG: u8 = 0x32;

pub const TYPE_SDR_SPECTRUM_FRAME: u8 = 0x84;
pub const TYPE_SDR_RAW_IQ_FRAME: u8 = 0x85;

pub const MAX_FRAME_PAYLOAD_LEN: usize = 32776;

pub const SDR_MIN_FREQ_MHZ: u16 = 1842;
pub const SDR_MAX_FREQ_MHZ: u16 = 2790;
pub const SDR_LO_DIVIDER_THRESHOLD_MHZ: u16 = 2210;
pub const SDR_GAIN_AGC: u8 = 0xff;
pub const SDR_MAX_MANUAL_GAIN: u8 = 72;

pub const SDR_FLAG_ADC_CLIP: u8 = 0x01;
pub const SDR_FLAG_CAPTURE_TRUNCATED: u8 = 0x02;
pub const SDR_FLAG_LO_DIV_ACTIVE: u8 = 0x04;

pub const SDR_STREAM_STOP: u8 = 0;
pub const SDR_STREAM_FFT: u8 = 1;
pub const SDR_STREAM_SINGLE_IQ: u8 = 2;
pub const SDR_STREAM_CONT_IQ: u8 = 3;

pub const SDR_DSP_FLAG_MAX_HOLD: u8 = 0x01;
pub const SDR_DSP_FLAG_DC_CANCEL: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SdrSampleRatePreset {
    pub code: u8,
    pub label: &'static str,
    pub span_mhz: f64,
    pub sample_rate_hz: u32,
}

pub const SDR_SAMPLE_RATE_PRESETS: [SdrSampleRatePreset; 4] = [
    SdrSampleRatePreset {
        code: 0,
        label: "80 MHz",
        span_mhz: 80.0,
        sample_rate_hz: 80_000_000,
    },
    SdrSampleRatePreset {
        code: 1,
        label: "40 MHz",
        span_mhz: 40.0,
        sample_rate_hz: 40_000_000,
    },
    SdrSampleRatePreset {
        code: 2,
        label: "20 MHz",
        span_mhz: 20.0,
        sample_rate_hz: 20_000_000,
    },
    SdrSampleRatePreset {
        code: 3,
        label: "16 MHz",
        span_mhz: 16.0,
        sample_rate_hz: 16_000_000,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SdrFftSizePreset {
    pub log2: u8,
    pub bins: usize,
    pub label: &'static str,
}

pub const SDR_FFT_SIZE_PRESETS: [SdrFftSizePreset; 4] = [
    SdrFftSizePreset {
        log2: 8,
        bins: 256,
        label: "256",
    },
    SdrFftSizePreset {
        log2: 9,
        bins: 512,
        label: "512",
    },
    SdrFftSizePreset {
        log2: 10,
        bins: 1024,
        label: "1024",
    },
    SdrFftSizePreset {
        log2: 11,
        bins: 2048,
        label: "2048",
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SdrBandPreset {
    pub freq_mhz: u16,
    pub label: &'static str,
    pub short_label: &'static str,
    pub sub2210: bool,
}

pub const SDR_BAND_PRESETS: [SdrBandPreset; 10] = [
    SdrBandPreset {
        freq_mhz: 1890,
        label: "DECT EU (1890)",
        short_label: "DECT 1890",
        sub2210: true,
    },
    SdrBandPreset {
        freq_mhz: 2350,
        label: "13cm Ham (2350)",
        short_label: "Ham 2350",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2402,
        label: "BLE Adv 37 (2402)",
        short_label: "BLE 2402",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2412,
        label: "Wi-Fi Ch 1 (2412)",
        short_label: "Wi-Fi 1",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2426,
        label: "BLE Adv 38 (2426)",
        short_label: "BLE 2426",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2437,
        label: "Wi-Fi Ch 6 (2437)",
        short_label: "Wi-Fi 6",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2462,
        label: "Wi-Fi Ch 11 (2462)",
        short_label: "Wi-Fi 11",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2472,
        label: "Wi-Fi Ch 13 (2472)",
        short_label: "Wi-Fi 13",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2480,
        label: "BLE Adv 39 (2480)",
        short_label: "BLE 2480",
        sub2210: false,
    },
    SdrBandPreset {
        freq_mhz: 2655,
        label: "LTE B7 DL (2655)",
        short_label: "LTE B7",
        sub2210: false,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardCapabilitiesFrame {
    pub board: String,
    pub firmware: String,
    pub sdr_capable: bool,
    pub max_iq_kb: u8,
}

impl BoardCapabilitiesFrame {
    pub fn from_identity(id: &BoardIdentity) -> Self {
        let cap_flags = id.get_u64("capFlags").unwrap_or(0) as u32;
        let sdr_capable = id.get_bool("sdr").unwrap_or(false)
            || (cap_flags & 0x04) != 0
            || id.board.to_uppercase().contains("S3");
        Self {
            board: id.board.clone(),
            firmware: id.firmware.clone(),
            sdr_capable,
            max_iq_kb: id.get_u64("max_iq_kb").unwrap_or(8).clamp(1, 16) as u8,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SdrSpectrumFrame {
    pub center_freq_mhz: u16,
    pub rate_bw_code: u8,
    pub sample_rate_hz: u32,
    pub span_mhz: f64,
    pub active_gain_index: u8,
    pub fft_bins: usize,
    pub status_flags: u8,
    pub adc_clip: bool,
    pub capture_truncated: bool,
    pub lo_div_active: bool,
    pub power_dbfs: Vec<f32>,
    pub timestamp_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SdrRawIqFrame {
    pub center_freq_mhz: u16,
    pub rate_bw_code: u8,
    pub sample_rate_hz: u32,
    pub span_mhz: f64,
    pub active_gain_index: u8,
    pub sample_count: usize,
    pub status_flags: u8,
    pub adc_clip: bool,
    pub capture_truncated: bool,
    pub lo_div_active: bool,
    pub i_samples: Vec<i8>,
    pub q_samples: Vec<i8>,
    pub timestamp_ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedFrame {
    Capabilities(BoardIdentity, BoardCapabilitiesFrame),
    SdrSpectrum(SdrSpectrumFrame),
    SdrRawIq(SdrRawIqFrame),
}
