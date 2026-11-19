use crate::protocol::codec::decode_response_payload;
use crate::protocol::types::{
    DecodedFrame, MAX_FRAME_PAYLOAD_LEN, SYNC_BYTE_1, SYNC_BYTE_2, TYPE_BOARD_CAPABILITIES,
    TYPE_SDR_RAW_IQ_FRAME, TYPE_SDR_SPECTRUM_FRAME,
};

fn is_valid_frame_type(type_id: u8) -> bool {
    matches!(
        type_id,
        TYPE_BOARD_CAPABILITIES | TYPE_SDR_SPECTRUM_FRAME | TYPE_SDR_RAW_IQ_FRAME
    )
}

fn is_valid_length_for_type(type_id: u8, len: usize) -> bool {
    if len > MAX_FRAME_PAYLOAD_LEN {
        return false;
    }
    match type_id {
        TYPE_BOARD_CAPABILITIES => (2..=4096).contains(&len),
        TYPE_SDR_SPECTRUM_FRAME => (8 + 256..=8 + 2048).contains(&len),
        TYPE_SDR_RAW_IQ_FRAME => (8 + 2..=MAX_FRAME_PAYLOAD_LEN).contains(&len),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    TextOrSync1,
    Sync2,
    TypeId,
    LenL,
    LenH,
    Payload,
    Checksum,
}

pub struct ProtocolDemuxer {
    state: State,
    type_id: u8,
    len_l: u8,
    payload_len: usize,
    payload_offset: usize,
    payload_buf: Vec<u8>,
    running_xor: u8,
    text_chunks: Vec<u8>,
}

impl Default for ProtocolDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolDemuxer {
    pub fn new() -> Self {
        Self {
            state: State::TextOrSync1,
            type_id: 0,
            len_l: 0,
            payload_len: 0,
            payload_offset: 0,
            payload_buf: vec![0u8; MAX_FRAME_PAYLOAD_LEN],
            running_xor: 0,
            text_chunks: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.state = State::TextOrSync1;
        self.type_id = 0;
        self.len_l = 0;
        self.payload_len = 0;
        self.payload_offset = 0;
        self.running_xor = 0;
        self.text_chunks.clear();
    }

    pub fn feed<F, T>(&mut self, chunk: &[u8], mut on_frame: F, mut on_terminal_bytes: T)
    where
        F: FnMut(DecodedFrame),
        T: FnMut(&[u8]),
    {
        for &b in chunk {
            match self.state {
                State::TextOrSync1 => {
                    if b == SYNC_BYTE_1 {
                        if !self.text_chunks.is_empty() {
                            on_terminal_bytes(&self.text_chunks);
                            self.text_chunks.clear();
                        }
                        self.state = State::Sync2;
                    } else {
                        self.text_chunks.push(b);
                    }
                }
                State::Sync2 => {
                    if b == SYNC_BYTE_2 {
                        self.state = State::TypeId;
                    } else {
                        self.text_chunks.push(SYNC_BYTE_1);
                        if b == SYNC_BYTE_1 {
                            self.state = State::Sync2;
                        } else {
                            self.text_chunks.push(b);
                            self.state = State::TextOrSync1;
                        }
                    }
                }
                State::TypeId => {
                    if is_valid_frame_type(b) {
                        self.type_id = b;
                        self.state = State::LenL;
                    } else {
                        self.text_chunks.push(SYNC_BYTE_1);
                        self.text_chunks.push(SYNC_BYTE_2);
                        self.text_chunks.push(b);
                        self.state = State::TextOrSync1;
                    }
                }
                State::LenL => {
                    self.len_l = b;
                    self.state = State::LenH;
                }
                State::LenH => {
                    let len = (self.len_l as usize) | ((b as usize) << 8);
                    if is_valid_length_for_type(self.type_id, len) {
                        self.payload_len = len;
                        self.payload_offset = 0;
                        self.running_xor = SYNC_BYTE_1 ^ SYNC_BYTE_2 ^ self.type_id ^ self.len_l ^ b;
                        self.state = if len == 0 {
                            State::Checksum
                        } else {
                            State::Payload
                        };
                    } else {
                        self.text_chunks.push(SYNC_BYTE_1);
                        self.text_chunks.push(SYNC_BYTE_2);
                        self.text_chunks.push(self.type_id);
                        self.text_chunks.push(self.len_l);
                        self.text_chunks.push(b);
                        self.state = State::TextOrSync1;
                    }
                }
                State::Payload => {
                    self.payload_buf[self.payload_offset] = b;
                    self.payload_offset += 1;
                    self.running_xor ^= b;
                    if self.payload_offset >= self.payload_len {
                        self.state = State::Checksum;
                    }
                }
                State::Checksum => {
                    if b == self.running_xor {
                        let slice = &self.payload_buf[..self.payload_len];
                        if let Some(decoded) = decode_response_payload(self.type_id, slice) {
                            on_frame(decoded);
                        }
                    }
                    self.state = State::TextOrSync1;
                }
            }
        }

        if !self.text_chunks.is_empty() {
            on_terminal_bytes(&self.text_chunks);
            self.text_chunks.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::codec::encode_response_frame;

    #[test]
    fn separates_mixed_utf8_and_binary_frames() {
        let mut frames: Vec<DecodedFrame> = Vec::new();
        let mut text_bytes: Vec<u8> = Vec::new();
        let mut demuxer = ProtocolDemuxer::new();

        let banner = b"[SDR] Ready\r\n";
        let caps_frame = encode_response_frame(
            TYPE_BOARD_CAPABILITIES,
            br#"{"board":"XIAO-ESP32-S3","firmware":"2.0.0-sdr","sdr":true}"#,
        );

        let mut spec_payload = vec![0u8; 8 + 256];
        spec_payload[0..2].copy_from_slice(&2412u16.to_le_bytes());
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
        assert!(matches!(frames[0], DecodedFrame::Capabilities(_)));
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
