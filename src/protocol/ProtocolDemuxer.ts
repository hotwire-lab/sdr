import { computeXorChecksum, decodeResponsePayload } from './codec';
import {
  DecodedFrame,
  MAX_FRAME_PAYLOAD_LEN,
  SYNC_BYTE_1,
  SYNC_BYTE_2,
  TYPE_BOARD_CAPABILITIES,
  TYPE_LA_CAPTURE_DATA,
  TYPE_SDR_RAW_IQ_FRAME,
  TYPE_SDR_SPECTRUM_FRAME,
  TYPE_STATUS_TELEMETRY,
} from './types';

function isValidFrameType(typeId: number): boolean {
  return (
    typeId === TYPE_STATUS_TELEMETRY ||
    typeId === TYPE_LA_CAPTURE_DATA ||
    typeId === TYPE_BOARD_CAPABILITIES ||
    typeId === TYPE_SDR_SPECTRUM_FRAME ||
    typeId === TYPE_SDR_RAW_IQ_FRAME
  );
}

function isValidLengthForType(typeId: number, len: number): boolean {
  if (len > MAX_FRAME_PAYLOAD_LEN) return false;
  if (typeId === TYPE_STATUS_TELEMETRY) return len === 4;
  if (typeId === TYPE_LA_CAPTURE_DATA) return len >= 8;
  if (typeId === TYPE_BOARD_CAPABILITIES) return len >= 2 && len <= 4096;
  if (typeId === TYPE_SDR_SPECTRUM_FRAME) return len >= 8 + 256 && len <= 8 + 2048;
  if (typeId === TYPE_SDR_RAW_IQ_FRAME) return len >= 8 + 2 && len <= MAX_FRAME_PAYLOAD_LEN;
  return false;
}

export interface DemuxCallbacks {
  onFrame: (frame: DecodedFrame) => void;
  onTerminalBytes: (bytes: Uint8Array) => void;
}

const enum State {
  TEXT_OR_SYNC1 = 0,
  SYNC2 = 1,
  TYPE_ID = 2,
  LEN_L = 3,
  LEN_H = 4,
  PAYLOAD = 5,
  CHECKSUM = 6,
}

export class ProtocolDemuxer {
  private state: State = State.TEXT_OR_SYNC1;
  private typeId = 0;
  private lenL = 0;
  private payloadLen = 0;
  private payloadOffset = 0;
  private payloadBuf = new Uint8Array(MAX_FRAME_PAYLOAD_LEN);
  private runningXor = 0;
  private textChunks: number[] = [];

  private callbacks: DemuxCallbacks;

  constructor(callbacks: DemuxCallbacks) {
    this.callbacks = callbacks;
  }

  reset(): void {
    this.state = State.TEXT_OR_SYNC1;
    this.typeId = 0;
    this.lenL = 0;
    this.payloadLen = 0;
    this.payloadOffset = 0;
    this.runningXor = 0;
    this.textChunks.length = 0;
  }

  feed(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.byteLength; i++) {
      const b = chunk[i];

      switch (this.state) {
        case State.TEXT_OR_SYNC1:
          if (b === SYNC_BYTE_1) {
            this.flushText();
            this.state = State.SYNC2;
          } else {
            this.textChunks.push(b);
          }
          break;

        case State.SYNC2:
          if (b === SYNC_BYTE_2) {
            this.state = State.TYPE_ID;
          } else {
            this.textChunks.push(SYNC_BYTE_1);
            if (b === SYNC_BYTE_1) {
              this.state = State.SYNC2;
            } else {
              this.textChunks.push(b);
              this.state = State.TEXT_OR_SYNC1;
            }
          }
          break;

        case State.TYPE_ID:
          if (isValidFrameType(b)) {
            this.typeId = b;
            this.state = State.LEN_L;
          } else {
            this.textChunks.push(SYNC_BYTE_1, SYNC_BYTE_2, b);
            this.state = State.TEXT_OR_SYNC1;
          }
          break;

        case State.LEN_L:
          this.lenL = b;
          this.state = State.LEN_H;
          break;

        case State.LEN_H: {
          const len = this.lenL | (b << 8);
          if (isValidLengthForType(this.typeId, len)) {
            this.payloadLen = len;
            this.payloadOffset = 0;
            this.runningXor =
              SYNC_BYTE_1 ^ SYNC_BYTE_2 ^ this.typeId ^ this.lenL ^ b;
            this.state = len === 0 ? State.CHECKSUM : State.PAYLOAD;
          } else {
            this.textChunks.push(SYNC_BYTE_1, SYNC_BYTE_2, this.typeId, this.lenL, b);
            this.state = State.TEXT_OR_SYNC1;
          }
          break;
        }

        case State.PAYLOAD:
          this.payloadBuf[this.payloadOffset++] = b;
          this.runningXor ^= b;
          if (this.payloadOffset >= this.payloadLen) {
            this.state = State.CHECKSUM;
          }
          break;

        case State.CHECKSUM: {
          const expectedXor = this.runningXor & 0xff;
          if (b === expectedXor) {
            const payloadSlice = this.payloadBuf.slice(0, this.payloadLen);
            const decoded = decodeResponsePayload(this.typeId, payloadSlice);
            if (decoded) {
              this.callbacks.onFrame(decoded);
            }
          } else {
            // Re-emit discarded header bytes as terminal diagnostics if checksum fails
            const rawHeader = new Uint8Array([
              SYNC_BYTE_1,
              SYNC_BYTE_2,
              this.typeId,
              this.lenL,
              (this.payloadLen >> 8) & 0xff,
            ]);
            const recomputed = computeXorChecksum(rawHeader);
            void recomputed;
          }
          this.state = State.TEXT_OR_SYNC1;
          break;
        }
      }
    }

    this.flushText();
  }

  private flushText(): void {
    if (this.textChunks.length === 0) return;
    const out = new Uint8Array(this.textChunks);
    this.textChunks.length = 0;
    this.callbacks.onTerminalBytes(out);
  }
}
