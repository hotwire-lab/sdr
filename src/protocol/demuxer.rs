use hotwire_core::protocol::{FrameDemuxer, FrameRule};

use crate::protocol::codec::decode_response_payload;
use crate::protocol::types::{
    DecodedFrame, MAX_FRAME_PAYLOAD_LEN, TYPE_SDR_RAW_IQ_FRAME, TYPE_SDR_SPECTRUM_FRAME,
};

pub struct ProtocolDemuxer {
    inner: FrameDemuxer,
}

impl Default for ProtocolDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolDemuxer {
    pub fn new() -> Self {
        Self {
            inner: FrameDemuxer::new(vec![
                FrameRule::board_capabilities(),
                FrameRule::new(TYPE_SDR_SPECTRUM_FRAME, 8 + 256, 8 + 2048),
                FrameRule::new(TYPE_SDR_RAW_IQ_FRAME, 8 + 2, MAX_FRAME_PAYLOAD_LEN),
            ]),
        }
    }

    pub fn feed<F, T>(&mut self, chunk: &[u8], mut on_frame: F, on_terminal_bytes: T)
    where
        F: FnMut(DecodedFrame),
        T: FnMut(&[u8]),
    {
        self.inner.feed_with_text(
            chunk,
            |raw| {
                if let Some(frame) = decode_response_payload(raw.type_id, raw.payload) {
                    on_frame(frame);
                }
            },
            on_terminal_bytes,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::encode_response_frame;
    use crate::protocol::types::TYPE_BOARD_CAPABILITIES;

    #[test]
    fn demuxes_interleaved_text_and_sdr_frames() {
        let mut frames: Vec<DecodedFrame> = Vec::new();
        let mut text_bytes: Vec<u8> = Vec::new();
        let mut demuxer = ProtocolDemuxer::new();

        let banner = b"[SDR] Ready\r\n";
        let caps_json = br#"{"board":"XIAO-ESP32-S3","firmware":"2.0.0","sdr":true}"#;
        let caps_frame = encode_response_frame(TYPE_BOARD_CAPABILITIES, caps_json);

        let mut spec_payload = vec![0u8; 8 + 256];
        spec_payload[0..2].copy_from_slice(&2412u16.to_le_bytes());
        spec_payload[2] = 1;
        spec_payload[3] = 40;
        spec_payload[4..6].copy_from_slice(&256u16.to_le_bytes());
        spec_payload[8 + 128] = 195; // -30 dBFS
        let spec_frame = encode_response_frame(TYPE_SDR_SPECTRUM_FRAME, &spec_payload);

        let mut iq_payload = vec![0u8; 8 + 64 * 2];
        iq_payload[0..2].copy_from_slice(&1910u16.to_le_bytes());
        iq_payload[4..6].copy_from_slice(&64u16.to_le_bytes());
        iq_payload[8] = 50;
        iq_payload[9] = (-25i8) as u8;
        let iq_frame = encode_response_frame(TYPE_SDR_RAW_IQ_FRAME, &iq_payload);

        let mut combined = Vec::new();
        combined.extend_from_slice(banner);
        combined.extend_from_slice(&caps_frame);
        combined.extend_from_slice(&spec_frame);
        combined.extend_from_slice(&iq_frame);

        for chunk in combined.chunks(17) {
            demuxer.feed(
                chunk,
                |f| frames.push(f),
                |b| text_bytes.extend_from_slice(b),
            );
        }

        assert_eq!(String::from_utf8(text_bytes).unwrap(), "[SDR] Ready\r\n");
        assert_eq!(frames.len(), 3);
        assert!(matches!(frames[0], DecodedFrame::Capabilities(_, _)));
        match &frames[1] {
            DecodedFrame::SdrSpectrum(s) => {
                assert_eq!(s.center_freq_mhz, 2412);
                assert!((s.power_dbfs[128] - (-30.0)).abs() < 1e-3);
            }
            _ => panic!("expected spectrum frame"),
        }
        match &frames[2] {
            DecodedFrame::SdrRawIq(iq) => {
                assert_eq!(iq.i_samples[0], 50);
                assert_eq!(iq.q_samples[0], -25);
            }
            _ => panic!("expected raw iq frame"),
        }
    }

    #[test]
    fn rejects_corrupted_checksum() {
        let mut frames: Vec<DecodedFrame> = Vec::new();
        let mut demuxer = ProtocolDemuxer::new();

        let mut spec_payload = vec![0u8; 8 + 256];
        spec_payload[0..2].copy_from_slice(&2437u16.to_le_bytes());
        spec_payload[4..6].copy_from_slice(&256u16.to_le_bytes());
        let mut frame = encode_response_frame(TYPE_SDR_SPECTRUM_FRAME, &spec_payload);
        let last = frame.len() - 1;
        frame[last] ^= 0xff;

        demuxer.feed(&frame, |f| frames.push(f), |_| {});
        assert!(frames.is_empty());
    }
}
