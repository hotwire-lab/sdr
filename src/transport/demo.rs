use crate::protocol::codec::{clamp_sdr_freq_mhz, encode_response_frame, resolve_sdr_rate_preset};
use crate::protocol::types::*;

#[derive(Debug, Clone, Copy)]
enum EmitterShape {
    Ofdm,
    Narrow,
}

#[derive(Debug, Clone, Copy)]
struct DemoEmitter {
    freq_mhz: f64,
    bw_mhz: f64,
    peak_dbfs: f64,
    shape: EmitterShape,
}

#[derive(Debug, Clone)]
pub struct DemoSimulator {
    pub center_mhz: u16,
    pub rate_bw_code: u8,
    pub gain_index: u8,
    pub stream_mode: u8,
    pub fft_log2: u8,
    pub iq_kb: u8,
    pub dsp_flags: u8,
    pub target_fps: u8,
    pub sweep_start_mhz: u16,
    pub sweep_steps: u8,
    pub sweep_dwell: u8,
    pub sweep_step_idx: u8,
    pub sweep_dwell_counter: u8,
    pub frame_counter: u32,
    ascii_line: String,
}

impl Default for DemoSimulator {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoSimulator {
    pub fn new() -> Self {
        Self {
            center_mhz: 2437,
            rate_bw_code: 1,
            gain_index: 42,
            stream_mode: SDR_STREAM_STOP,
            fft_log2: 10,
            iq_kb: 2,
            dsp_flags: SDR_DSP_FLAG_DC_CANCEL,
            target_fps: 20,
            sweep_start_mhz: 2400,
            sweep_steps: 0,
            sweep_dwell: 3,
            sweep_step_idx: 0,
            sweep_dwell_counter: 0,
            frame_counter: 0,
            ascii_line: String::new(),
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn build_caps_frame(&self) -> Vec<u8> {
        let json = br#"{"board":"XIAO-ESP32-S3","firmware":"2.1.0-sdr-demo","sdr":true,"max_iq_kb":4}"#;
        encode_response_frame(TYPE_BOARD_CAPABILITIES, json)
    }

    pub fn interval_ms(&self) -> u32 {
        let fps = self.target_fps.clamp(5, 60) as f64;
        (1000.0 / fps).round().max(16.0) as u32
    }

    /// Process TX bytes sent from the app to the simulated device.
    /// Returns `(output_chunks, timer_action)`:
    /// `timer_action`: `Some(true)` = start/restart timer, `Some(false)` = stop timer, `None` = unchanged.
    pub fn handle_tx(&mut self, bytes: &[u8]) -> (Vec<Vec<u8>>, Option<bool>) {
        let mut outputs: Vec<Vec<u8>> = Vec::new();

        if bytes.len() >= 8 && bytes[0] == PROTOCOL_SYNC_0 && bytes[1] == PROTOCOL_SYNC_1 {
            let mut timer_action: Option<bool> = None;
            let mut pos = 0usize;
            while pos + 8 <= bytes.len()
                && bytes[pos] == PROTOCOL_SYNC_0
                && bytes[pos + 1] == PROTOCOL_SYNC_1
            {
                let cmd_id = bytes[pos + 2];
                let p1 = bytes[pos + 3];
                let p2 = bytes[pos + 4];
                let p3 = bytes[pos + 5];
                let p4 = bytes[pos + 6];

                match cmd_id {
                    CMD_PING_STATUS | CMD_GET_CAPS => {
                        outputs.push(self.build_caps_frame());
                    }
                    CMD_SDR_TUNE => {
                        let req_freq = u16::from_le_bytes([p1, p2]) as i32;
                        self.center_mhz = clamp_sdr_freq_mhz(req_freq);
                        self.rate_bw_code = p3 & 0x03;
                        self.gain_index = p4;
                    }
                    CMD_SDR_SWEEP_CFG => {
                        let start_freq = u16::from_le_bytes([p1, p2]) as i32;
                        self.sweep_start_mhz = clamp_sdr_freq_mhz(start_freq);
                        self.sweep_steps = p3;
                        self.sweep_dwell = p4.max(1);
                        self.sweep_step_idx = 0;
                        self.sweep_dwell_counter = 0;
                        if p3 > 0 {
                            self.center_mhz = self.sweep_start_mhz;
                        }
                    }
                    CMD_SDR_STREAM_CTRL => {
                        self.stream_mode = p1;
                        if p1 == SDR_STREAM_SINGLE_IQ {
                            self.iq_kb = p2.clamp(1, 16);
                            self.dsp_flags = p3;
                            outputs.push(self.generate_raw_iq_frame());
                            self.stream_mode = SDR_STREAM_STOP;
                            timer_action = Some(false);
                        } else if p1 == SDR_STREAM_STOP {
                            timer_action = Some(false);
                        } else {
                            if p1 == SDR_STREAM_CONT_IQ {
                                self.iq_kb = p2.clamp(1, 16);
                            } else {
                                self.fft_log2 = p2.clamp(8, 11);
                            }
                            self.dsp_flags = p3;
                            self.target_fps = if p4 == 0 { 20 } else { p4.clamp(5, 60) };
                            timer_action = Some(true);
                        }
                    }
                    CMD_BOOTLOADER => {
                        self.stream_mode = SDR_STREAM_STOP;
                        outputs.push(
                            b"\r\n\x1b[33m[Demo] Simulated 0xF0 CMD_BOOTLOADER received.\x1b[0m\r\n"
                                .to_vec(),
                        );
                        timer_action = Some(false);
                    }
                    _ => {}
                }
                pos += 8;
            }
            return (outputs, timer_action);
        }

        if let Ok(text) = std::str::from_utf8(bytes) {
            let mut timer_action = None;
            for ch in text.chars() {
                if ch == '\r' || ch == '\n' {
                    let cmd = self.ascii_line.trim().to_string();
                    self.ascii_line.clear();
                    let (resp, stop) = self.handle_ascii_command(&cmd);
                    if let Some(r) = resp {
                        outputs.push(r.into_bytes());
                    }
                    if stop {
                        timer_action = Some(false);
                    }
                } else {
                    self.ascii_line.push(ch);
                }
            }
            return (outputs, timer_action);
        }

        (outputs, None)
    }

    fn handle_ascii_command(&mut self, cmd: &str) -> (Option<String>, bool) {
        if cmd == "help" {
            return (
                Some(
                    "\r\nSDR Demo Commands: help, sdr status, sdr stop, tune <MHz>, version\r\n"
                        .to_string(),
                ),
                false,
            );
        }
        if cmd == "sdr status" {
            let rate_preset = resolve_sdr_rate_preset(self.rate_bw_code);
            let lo_div = if self.center_mhz < SDR_LO_DIVIDER_THRESHOLD_MHZ {
                "ON (5/6)"
            } else {
                "OFF (1/1)"
            };
            let gain_str = if self.gain_index == SDR_GAIN_AGC {
                "AGC".to_string()
            } else {
                self.gain_index.to_string()
            };
            return (
                Some(format!(
                    "\r\n[SDR] freq={} MHz | span={} | gain={} | LO_DIV={} | mode={}\r\n",
                    self.center_mhz, rate_preset.label, gain_str, lo_div, self.stream_mode
                )),
                false,
            );
        }
        if cmd == "sdr stop" {
            self.stream_mode = SDR_STREAM_STOP;
            return (Some("\r\n[SDR] Stream stopped.\r\n".to_string()), true);
        }
        if let Some(rest) = cmd.strip_prefix("tune ") {
            if let Ok(mhz) = rest.trim().parse::<i32>() {
                self.center_mhz = clamp_sdr_freq_mhz(mhz);
                return (
                    Some(format!("\r\n[SDR] Tuned to {} MHz.\r\n", self.center_mhz)),
                    false,
                );
            }
        }
        if cmd == "version" {
            return (
                Some("\r\nHotWire-SDR-XIAO-ESP32S3 Demo v2.0.0\r\n".to_string()),
                false,
            );
        }
        if !cmd.is_empty() {
            return (Some(format!("\r\nUnknown demo command: {cmd}\r\n")), false);
        }
        (None, false)
    }

    pub fn tick_frame(&mut self) -> Option<Vec<u8>> {
        match self.stream_mode {
            SDR_STREAM_CONT_IQ => Some(self.generate_raw_iq_frame()),
            SDR_STREAM_FFT => Some(self.generate_spectrum_frame()),
            _ => None,
        }
    }

    fn emitters(t: u32) -> Vec<DemoEmitter> {
        let mut emitters = Vec::with_capacity(12);

        let ch6_pulse = if !t.is_multiple_of(7) { 1.0 } else { 0.25 };
        emitters.push(DemoEmitter {
            freq_mhz: 2437.0,
            bw_mhz: 18.0,
            peak_dbfs: if ch6_pulse > 0.5 { -34.0 } else { -74.0 },
            shape: EmitterShape::Ofdm,
        });
        if t % 11 < 6 {
            emitters.push(DemoEmitter {
                freq_mhz: 2412.0,
                bw_mhz: 18.0,
                peak_dbfs: -48.0,
                shape: EmitterShape::Ofdm,
            });
        }
        if (t + 4) % 13 < 7 {
            emitters.push(DemoEmitter {
                freq_mhz: 2462.0,
                bw_mhz: 18.0,
                peak_dbfs: -52.0,
                shape: EmitterShape::Ofdm,
            });
        }

        let ble_ch = [2402.0, 2426.0, 2480.0][(t % 3) as usize];
        emitters.push(DemoEmitter {
            freq_mhz: ble_ch,
            bw_mhz: 1.4,
            peak_dbfs: -39.0,
            shape: EmitterShape::Narrow,
        });
        emitters.push(DemoEmitter {
            freq_mhz: 2402.0,
            bw_mhz: 1.2,
            peak_dbfs: -62.0,
            shape: EmitterShape::Narrow,
        });

        // DECT 1.9 GHz EU
        emitters.push(DemoEmitter {
            freq_mhz: 1885.0,
            bw_mhz: 1.6,
            peak_dbfs: -42.0,
            shape: EmitterShape::Narrow,
        });
        emitters.push(DemoEmitter {
            freq_mhz: 1891.0,
            bw_mhz: 1.6,
            peak_dbfs: -46.0,
            shape: EmitterShape::Narrow,
        });
        if t % 5 < 3 {
            emitters.push(DemoEmitter {
                freq_mhz: 1897.0,
                bw_mhz: 1.6,
                peak_dbfs: -51.0,
                shape: EmitterShape::Narrow,
            });
        }

        // 13cm Ham
        emitters.push(DemoEmitter {
            freq_mhz: 2350.0,
            bw_mhz: 2.2,
            peak_dbfs: -44.0,
            shape: EmitterShape::Narrow,
        });

        // LTE B7 DL
        emitters.push(DemoEmitter {
            freq_mhz: 2655.0,
            bw_mhz: 18.0,
            peak_dbfs: -45.0,
            shape: EmitterShape::Ofdm,
        });

        emitters
    }

    pub fn generate_spectrum_frame(&mut self) -> Vec<u8> {
        self.frame_counter = self.frame_counter.wrapping_add(1);
        if self.sweep_steps > 0 {
            self.sweep_dwell_counter += 1;
            if self.sweep_dwell_counter >= self.sweep_dwell {
                self.sweep_dwell_counter = 0;
                self.sweep_step_idx = (self.sweep_step_idx + 1) % self.sweep_steps;
                self.center_mhz = clamp_sdr_freq_mhz(
                    self.sweep_start_mhz as i32 + (self.sweep_step_idx as i32) * 40,
                );
            }
        }

        let rate_preset = resolve_sdr_rate_preset(self.rate_bw_code);
        let fft_bins: usize = 1usize << self.fft_log2.clamp(8, 11);
        let center_mhz = self.center_mhz;
        let span_mhz = rate_preset.span_mhz;
        let dc_cancel = (self.dsp_flags & SDR_DSP_FLAG_DC_CANCEL) != 0;
        let manual_gain = if self.gain_index == SDR_GAIN_AGC {
            42
        } else {
            self.gain_index
        };
        let gain_delta_db = (manual_gain as f64 - 42.0) * 0.65;
        let emitters = Self::emitters(self.frame_counter);

        let mut peak_observed_db = -120.0f64;
        let mut bins = vec![0.0f64; fft_bins];
        let base_noise = -98.0 + gain_delta_db * 0.45;
        let fc = self.frame_counter as f64;
        let half_bins = fft_bins as f64 / 2.0;
        let spur_bin = (fft_bins as f64 * 0.72).floor() as usize;

        for (i, bin) in bins.iter_mut().enumerate() {
            let fi = i as f64;
            let freq_mhz = (center_mhz as f64) + ((fi - half_bins) * span_mhz) / (fft_bins as f64);
            let edge_norm = ((fi - half_bins) / half_bins).abs();
            let filter_drop = if edge_norm > 0.85 {
                (edge_norm - 0.85) * 32.0
            } else {
                0.0
            };
            let noise_jitter =
                (fi * 1.73 + fc * 2.13).sin() * 1.8 + (fi * 4.31 - fc * 3.71).cos() * 1.4;
            let mut val = base_noise + noise_jitter - filter_drop;

            for em in &emitters {
                let df = (freq_mhz - em.freq_mhz).abs();
                let half_bw = em.bw_mhz * 0.5;
                match em.shape {
                    EmitterShape::Ofdm => {
                        if df < half_bw + 5.0 {
                            let flat = if df <= half_bw {
                                em.peak_dbfs + (fi * 0.9 + fc).sin() * 1.3
                            } else {
                                em.peak_dbfs - (df - half_bw) * 8.5
                            };
                            val = val.max(flat + gain_delta_db);
                        }
                    }
                    EmitterShape::Narrow => {
                        let sigma = em.bw_mhz * 0.35;
                        let gauss = em.peak_dbfs - ((df * df) / (2.0 * sigma * sigma)) * 12.0;
                        val = val.max(gauss + gain_delta_db);
                    }
                }
            }

            if i == spur_bin {
                val = val.max(-44.0 + gain_delta_db * 0.3);
            }

            if i == fft_bins / 2 {
                if !dc_cancel {
                    val = val.max(-30.0 + gain_delta_db * 0.25);
                } else {
                    val += 3.5;
                }
            }

            let clamped = val.clamp(-127.5, 0.0);
            *bin = clamped;
            if clamped > peak_observed_db {
                peak_observed_db = clamped;
            }
        }

        let clipped =
            self.gain_index != SDR_GAIN_AGC && manual_gain >= 62 && peak_observed_db > -12.0;
        let effective_gain = if self.gain_index == SDR_GAIN_AGC {
            (42.0 - (peak_observed_db + 35.0).max(-20.0) * 0.4)
                .round()
                .clamp(6.0, 64.0) as u8
        } else {
            manual_gain
        };

        let mut status_flags = 0u8;
        if clipped {
            status_flags |= SDR_FLAG_ADC_CLIP;
        }
        if center_mhz < SDR_LO_DIVIDER_THRESHOLD_MHZ {
            status_flags |= SDR_FLAG_LO_DIV_ACTIVE;
        }

        let mut payload = vec![0u8; 8 + fft_bins];
        payload[0..2].copy_from_slice(&center_mhz.to_le_bytes());
        payload[2] = self.rate_bw_code & 0x03;
        payload[3] = effective_gain;
        payload[4..6].copy_from_slice(&(fft_bins as u16).to_le_bytes());
        payload[6] = status_flags;
        payload[7] = 0;

        for (i, &db) in bins.iter().enumerate() {
            payload[8 + i] = ((db + 127.5) * 2.0).round().clamp(0.0, 255.0) as u8;
        }

        encode_response_frame(TYPE_SDR_SPECTRUM_FRAME, &payload)
    }

    pub fn generate_raw_iq_frame(&mut self) -> Vec<u8> {
        self.frame_counter = self.frame_counter.wrapping_add(1);
        let sample_count = ((self.iq_kb as usize) * 1024).clamp(256, 4096);
        let manual_gain = if self.gain_index == SDR_GAIN_AGC {
            42
        } else {
            self.gain_index
        };
        let gain_scale = 10.0f64.powf((manual_gain as f64 - 42.0) / 36.0);
        let dc_cancel = (self.dsp_flags & SDR_DSP_FLAG_DC_CANCEL) != 0;
        let dc_offset_i = if dc_cancel { 0.0 } else { 12.0 };
        let dc_offset_q = if dc_cancel { 0.0 } else { -9.0 };

        let mut payload = vec![0u8; 8 + sample_count * 2];
        let mut status_flags = 0u8;
        let is_sub2210 = self.center_mhz < SDR_LO_DIVIDER_THRESHOLD_MHZ;
        if is_sub2210 {
            status_flags |= SDR_FLAG_LO_DIV_ACTIVE;
        }

        let mut clipped = false;
        let fc = self.frame_counter as f64;
        for n in 0..sample_count {
            let t = n as f64 / sample_count as f64;
            let sym = (n / 16) as u32 + self.frame_counter;
            let qpsk_phase =
                (((sym * 3) ^ (sym >> 2)) & 3) as f64 * (std::f64::consts::FRAC_PI_2)
                    + std::f64::consts::FRAC_PI_4;
            let fsk_omega = 2.0 * std::f64::consts::PI * (if is_sub2210 { 22.0 } else { 14.0 }) * t;
            let carrier_amp = if is_sub2210 { 44.0 } else { 40.0 };

            let sig_i = carrier_amp * (fsk_omega + qpsk_phase).cos();
            let sig_q = carrier_amp * (fsk_omega + qpsk_phase).sin();

            let nf = n as f64;
            let noise_i = (nf * 12.9898 + fc).sin() * 7.0;
            let noise_q = (nf * 78.233 - fc).cos() * 7.0;

            let val_i = ((sig_i + noise_i) * gain_scale + dc_offset_i).round() as i32;
            let val_q = ((sig_q + noise_q) * gain_scale + dc_offset_q).round() as i32;
            if val_i.abs() >= 127 || val_q.abs() >= 127 {
                clipped = true;
            }
            let ci = val_i.clamp(-128, 127) as i8;
            let cq = val_q.clamp(-128, 127) as i8;

            payload[8 + n * 2] = ci as u8;
            payload[8 + n * 2 + 1] = cq as u8;
        }

        if clipped {
            status_flags |= SDR_FLAG_ADC_CLIP;
        }

        payload[0..2].copy_from_slice(&self.center_mhz.to_le_bytes());
        payload[2] = self.rate_bw_code & 0x03;
        payload[3] = manual_gain;
        payload[4..6].copy_from_slice(&(sample_count as u16).to_le_bytes());
        payload[6] = status_flags;
        payload[7] = 0;

        encode_response_frame(TYPE_SDR_RAW_IQ_FRAME, &payload)
    }
}

impl hotwire_core::transport::DemoBackend for DemoSimulator {
    fn device_name(&self) -> &str {
        "XIAO-ESP32-S3 (Demo)"
    }

    fn vid_pid(&self) -> &str {
        "DEMO:0002"
    }

    fn tick_interval_ms(&self) -> Option<i32> {
        Some(self.interval_ms() as i32)
    }

    fn on_start(&mut self) -> Vec<u8> {
        self.reset();
        Vec::new()
    }

    fn handle_command(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut flat = Vec::new();
        let mut pos = 0;
        while pos + 8 <= bytes.len()
            && bytes[pos] == PROTOCOL_SYNC_0
            && bytes[pos + 1] == PROTOCOL_SYNC_1
        {
            let (outputs, _) = self.handle_tx(&bytes[pos..pos + 8]);
            for chunk in outputs {
                flat.extend_from_slice(&chunk);
            }
            pos += 8;
        }
        if pos < bytes.len() {
            let (outputs, _) = self.handle_tx(&bytes[pos..]);
            for chunk in outputs {
                flat.extend_from_slice(&chunk);
            }
        }
        flat
    }

    fn tick(&mut self) -> Option<Vec<u8>> {
        self.tick_frame()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::{build_sdr_stream_ctrl_cmd, build_sdr_tune_cmd};
    use crate::protocol::demuxer::ProtocolDemuxer;

    #[test]
    fn demo_simulator_generates_valid_spectrum_and_iq_frames() {
        let mut sim = DemoSimulator::new();
        let mut demux = ProtocolDemuxer::new();
        let mut frames = Vec::new();

        let tune = build_sdr_tune_cmd(1890, 1, 42);
        sim.handle_tx(&tune);
        let spec_bytes = sim.generate_spectrum_frame();
        demux.feed(&spec_bytes, |f| frames.push(f), |_| {});
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            DecodedFrame::SdrSpectrum(s) => {
                assert_eq!(s.center_freq_mhz, 1890);
                assert!(s.lo_div_active);
                assert_eq!(s.fft_bins, 1024);
            }
            _ => panic!("expected spectrum frame"),
        }

        let iq_cmd = build_sdr_stream_ctrl_cmd(SDR_STREAM_SINGLE_IQ, 2, SDR_DSP_FLAG_DC_CANCEL, 20);
        let (outs, timer_act) = sim.handle_tx(&iq_cmd);
        assert_eq!(timer_act, Some(false));
        assert_eq!(outs.len(), 1);
        demux.feed(&outs[0], |f| frames.push(f), |_| {});
        assert_eq!(frames.len(), 2);
        assert!(matches!(frames[1], DecodedFrame::SdrRawIq(_)));
    }
}
