use serde::Deserialize;

use crate::protocol::types::*;

pub fn compute_xor_checksum(bytes: &[u8]) -> u8 {
    let mut xor = 0u8;
    for &b in bytes {
        xor ^= b;
    }
    xor
}

pub fn build_command_frame(cmd_id: u8, p1: u8, p2: u8, p3: u8, p4: u8) -> [u8; 8] {
    let mut frame = [
        PROTOCOL_SYNC_0,
        PROTOCOL_SYNC_1,
        cmd_id,
        p1,
        p2,
        p3,
        p4,
        0,
    ];
    frame[7] = compute_xor_checksum(&frame[..7]);
    frame
}

pub fn build_ping_status_cmd() -> [u8; 8] {
    build_command_frame(CMD_PING_STATUS, 0, 0, 0, 0)
}

pub fn build_get_caps_cmd() -> [u8; 8] {
    build_command_frame(CMD_GET_CAPS, 0, 0, 0, 0)
}

pub fn build_bootloader_cmd() -> [u8; 8] {
    build_command_frame(CMD_BOOTLOADER, 0xb0, 0x07, 0x10, 0xad)
}

pub fn clamp_sdr_freq_mhz(freq_mhz: i32) -> u16 {
    freq_mhz.clamp(SDR_MIN_FREQ_MHZ as i32, SDR_MAX_FREQ_MHZ as i32) as u16
}

pub fn clamp_sdr_gain_index(gain_index: i32) -> u8 {
    if gain_index == SDR_GAIN_AGC as i32 || gain_index < 0 {
        return SDR_GAIN_AGC;
    }
    gain_index.clamp(0, SDR_MAX_MANUAL_GAIN as i32) as u8
}

pub fn build_sdr_tune_cmd(center_freq_mhz: i32, rate_bw_code: u8, gain_index: i32) -> [u8; 8] {
    let freq = clamp_sdr_freq_mhz(center_freq_mhz);
    let gain = clamp_sdr_gain_index(gain_index);
    build_command_frame(
        CMD_SDR_TUNE,
        (freq & 0xff) as u8,
        ((freq >> 8) & 0xff) as u8,
        rate_bw_code & 0x03,
        gain,
    )
}

pub fn build_sdr_stream_ctrl_cmd(
    stream_mode: u8,
    size_param: u8,
    dsp_flags: u8,
    target_fps: u8,
) -> [u8; 8] {
    let clamped_fps = target_fps.clamp(1, 60);
    build_command_frame(
        CMD_SDR_STREAM_CTRL,
        stream_mode,
        size_param,
        dsp_flags,
        clamped_fps,
    )
}

pub fn build_sdr_sweep_cfg_cmd(
    start_freq_mhz: i32,
    step_count: u8,
    dwell_frames: u8,
) -> [u8; 8] {
    let freq = clamp_sdr_freq_mhz(start_freq_mhz);
    build_command_frame(
        CMD_SDR_SWEEP_CFG,
        (freq & 0xff) as u8,
        ((freq >> 8) & 0xff) as u8,
        step_count,
        dwell_frames.max(1),
    )
}

pub fn encode_response_frame(type_id: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    let mut frame = Vec::with_capacity(6 + len);
    frame.push(PROTOCOL_SYNC_0);
    frame.push(PROTOCOL_SYNC_1);
    frame.push(type_id);
    frame.push((len & 0xff) as u8);
    frame.push(((len >> 8) & 0xff) as u8);
    frame.extend_from_slice(payload);
    let chk = compute_xor_checksum(&frame);
    frame.push(chk);
    frame
}

pub fn resolve_sdr_rate_preset(rate_bw_code: u8) -> SdrSampleRatePreset {
    let masked = rate_bw_code & 0x03;
    SDR_SAMPLE_RATE_PRESETS
        .iter()
        .copied()
        .find(|p| p.code == masked)
        .unwrap_or(SDR_SAMPLE_RATE_PRESETS[0])
}

#[derive(Deserialize)]
struct RawCapsJson {
    board: Option<String>,
    firmware: Option<String>,
    sdr: Option<bool>,
    #[serde(rename = "capFlags")]
    cap_flags: Option<u32>,
}

pub fn decode_board_capabilities(payload: &[u8]) -> Option<BoardCapabilitiesFrame> {
    if payload.len() < 2 {
        return None;
    }
    let raw = std::str::from_utf8(payload).ok()?;
    let parsed: RawCapsJson = serde_json::from_str(raw).ok()?;
    let board = parsed.board.unwrap_or_else(|| "XIAO-ESP32-S3".to_string());
    let cap_flags = parsed.cap_flags.unwrap_or(0);
    let sdr_capable = parsed.sdr.unwrap_or(false)
        || (cap_flags & 0x04) != 0
        || board.to_uppercase().contains("S3");

    Some(BoardCapabilitiesFrame {
        board,
        firmware: parsed.firmware.unwrap_or_else(|| "1.0.0".to_string()),
        sdr_capable,
    })
}

fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

pub fn decode_sdr_spectrum_frame(payload: &[u8]) -> Option<SdrSpectrumFrame> {
    if payload.len() < 8 {
        return None;
    }
    let center_freq_mhz = u16::from_le_bytes([payload[0], payload[1]]);
    let rate_bw_code = payload[2];
    let active_gain_index = payload[3];
    let fft_bins = u16::from_le_bytes([payload[4], payload[5]]) as usize;
    let status_flags = payload[6];

    if fft_bins == 0 || payload.len() != 8 + fft_bins {
        return None;
    }

    let raw_bytes = payload[8..8 + fft_bins].to_vec();
    let power_dbfs: Vec<f32> = raw_bytes
        .iter()
        .map(|&b| (b as f32) * 0.5 - 127.5)
        .collect();

    let rate_preset = resolve_sdr_rate_preset(rate_bw_code);
    Some(SdrSpectrumFrame {
        center_freq_mhz,
        rate_bw_code,
        sample_rate_hz: rate_preset.sample_rate_hz,
        span_mhz: rate_preset.span_mhz,
        active_gain_index,
        fft_bins,
        status_flags,
        adc_clip: (status_flags & SDR_FLAG_ADC_CLIP) != 0,
        capture_truncated: (status_flags & SDR_FLAG_CAPTURE_TRUNCATED) != 0,
        lo_div_active: (status_flags & SDR_FLAG_LO_DIV_ACTIVE) != 0,
        power_dbfs,
        raw_bytes,
        timestamp_ms: now_ms(),
    })
}

pub fn decode_sdr_raw_iq_frame(payload: &[u8]) -> Option<SdrRawIqFrame> {
    if payload.len() < 8 {
        return None;
    }
    let center_freq_mhz = u16::from_le_bytes([payload[0], payload[1]]);
    let rate_bw_code = payload[2];
    let active_gain_index = payload[3];
    let sample_count = u16::from_le_bytes([payload[4], payload[5]]) as usize;
    let status_flags = payload[6];

    if sample_count == 0 || payload.len() != 8 + sample_count * 2 {
        return None;
    }

    let mut i_samples = Vec::with_capacity(sample_count);
    let mut q_samples = Vec::with_capacity(sample_count);
    for n in 0..sample_count {
        let offset = 8 + n * 2;
        i_samples.push(payload[offset] as i8);
        q_samples.push(payload[offset + 1] as i8);
    }

    let rate_preset = resolve_sdr_rate_preset(rate_bw_code);
    Some(SdrRawIqFrame {
        center_freq_mhz,
        rate_bw_code,
        sample_rate_hz: rate_preset.sample_rate_hz,
        span_mhz: rate_preset.span_mhz,
        active_gain_index,
        sample_count,
        status_flags,
        adc_clip: (status_flags & SDR_FLAG_ADC_CLIP) != 0,
        capture_truncated: (status_flags & SDR_FLAG_CAPTURE_TRUNCATED) != 0,
        lo_div_active: (status_flags & SDR_FLAG_LO_DIV_ACTIVE) != 0,
        i_samples,
        q_samples,
        timestamp_ms: now_ms(),
    })
}

pub fn decode_response_payload(type_id: u8, payload: &[u8]) -> Option<DecodedFrame> {
    match type_id {
        TYPE_BOARD_CAPABILITIES => {
            decode_board_capabilities(payload).map(DecodedFrame::Capabilities)
        }
        TYPE_SDR_SPECTRUM_FRAME => {
            decode_sdr_spectrum_frame(payload).map(DecodedFrame::SdrSpectrum)
        }
        TYPE_SDR_RAW_IQ_FRAME => decode_sdr_raw_iq_frame(payload).map(DecodedFrame::SdrRawIq),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_8_byte_cmd_sdr_tune_with_clamping() {
        let cmd = build_sdr_tune_cmd(2437, 0, SDR_GAIN_AGC as i32);
        assert_eq!(cmd.len(), 8);
        assert_eq!(cmd[0], 0xaa);
        assert_eq!(cmd[1], 0x55);
        assert_eq!(cmd[2], CMD_SDR_TUNE);
        assert_eq!(u16::from_le_bytes([cmd[3], cmd[4]]), 2437);
        assert_eq!(cmd[5], 0);
        assert_eq!(cmd[6], 0xff);
        assert_eq!(cmd[7], compute_xor_checksum(&cmd[..7]));

        let clamped_low = build_sdr_tune_cmd(1200, 3, -5);
        assert_eq!(u16::from_le_bytes([clamped_low[3], clamped_low[4]]), SDR_MIN_FREQ_MHZ);
        assert_eq!(clamped_low[5], 3);
        assert_eq!(clamped_low[6], 0xff);

        let clamped_high = build_sdr_tune_cmd(3500, 1, 90);
        assert_eq!(u16::from_le_bytes([clamped_high[3], clamped_high[4]]), SDR_MAX_FREQ_MHZ);
        assert_eq!(clamped_high[6], 72);
    }

    #[test]
    fn encodes_stream_ctrl_and_sweep_cfg() {
        let dsp_flags = SDR_DSP_FLAG_MAX_HOLD | SDR_DSP_FLAG_DC_CANCEL | (3 << 4);
        let stream = build_sdr_stream_ctrl_cmd(SDR_STREAM_FFT, 10, dsp_flags, 30);
        assert_eq!(stream[2], CMD_SDR_STREAM_CTRL);
        assert_eq!(stream[3], SDR_STREAM_FFT);
        assert_eq!(stream[4], 10);
        assert_eq!(stream[5], dsp_flags);
        assert_eq!(stream[6], 30);
        assert_eq!(stream[7], compute_xor_checksum(&stream[..7]));

        let sweep = build_sdr_sweep_cfg_cmd(2400, 4, 5);
        assert_eq!(sweep[2], CMD_SDR_SWEEP_CFG);
        assert_eq!(u16::from_le_bytes([sweep[3], sweep[4]]), 2400);
        assert_eq!(sweep[5], 4);
        assert_eq!(sweep[6], 5);
        assert_eq!(sweep[7], compute_xor_checksum(&sweep[..7]));
    }

    #[test]
    fn decodes_0x84_spectrum_frame() {
        let bins = 256usize;
        let mut payload = vec![0u8; 8 + bins];
        payload[0..2].copy_from_slice(&1910u16.to_le_bytes());
        payload[2] = 1; // 40 MHz
        payload[3] = 38;
        payload[4..6].copy_from_slice(&(bins as u16).to_le_bytes());
        payload[6] = SDR_FLAG_LO_DIV_ACTIVE | SDR_FLAG_ADC_CLIP;
        payload[8] = 0;
        payload[9] = 175;
        payload[10] = 255;

        let frame = decode_sdr_spectrum_frame(&payload).expect("valid spectrum frame");
        assert_eq!(frame.center_freq_mhz, 1910);
        assert_eq!(frame.span_mhz, 40.0);
        assert_eq!(frame.active_gain_index, 38);
        assert_eq!(frame.fft_bins, bins);
        assert!(frame.lo_div_active);
        assert!(frame.adc_clip);
        assert!(!frame.capture_truncated);
        assert!((frame.power_dbfs[0] - (-127.5)).abs() < 1e-4);
        assert!((frame.power_dbfs[1] - (-40.0)).abs() < 1e-4);
        assert!((frame.power_dbfs[2] - 0.0).abs() < 1e-4);
    }

    #[test]
    fn decodes_0x85_raw_iq_frame() {
        let n_samples = 4usize;
        let mut payload = vec![0u8; 8 + n_samples * 2];
        payload[0..2].copy_from_slice(&2437u16.to_le_bytes());
        payload[2] = 0;
        payload[3] = 24;
        payload[4..6].copy_from_slice(&(n_samples as u16).to_le_bytes());

        let pairs: [(i8, i8); 4] = [(127, -128), (-45, 60), (0, -1), (88, 12)];
        for (idx, &(iv, qv)) in pairs.iter().enumerate() {
            payload[8 + idx * 2] = iv as u8;
            payload[8 + idx * 2 + 1] = qv as u8;
        }

        let decoded = decode_sdr_raw_iq_frame(&payload).expect("valid raw iq frame");
        assert_eq!(decoded.sample_count, n_samples);
        assert_eq!(decoded.i_samples, vec![127, -45, 0, 88]);
        assert_eq!(decoded.q_samples, vec![-128, 60, -1, 12]);
    }

    #[test]
    fn identifies_sdr_capable_from_caps_json() {
        let json = br#"{"board":"XIAO-ESP32-S3","sdr":true,"capFlags":7}"#;
        let s3 = decode_board_capabilities(json).expect("valid caps");
        assert!(s3.sdr_capable);

        let wrapped = encode_response_frame(TYPE_BOARD_CAPABILITIES, json);
        assert_eq!(wrapped[2], TYPE_BOARD_CAPABILITIES);
        assert_eq!(TYPE_SDR_SPECTRUM_FRAME, 0x84);
        assert_eq!(TYPE_SDR_RAW_IQ_FRAME, 0x85);
    }
}
