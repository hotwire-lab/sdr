import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ESPLoader, FlashOptions, LoaderOptions, Transport } from 'esptool-js';
import { buildBootloaderCmd } from '../protocol/codec';
import { BoardCapabilitiesFrame } from '../protocol/types';
import { SerialTransport, TransportSnapshot } from '../transport/SerialTransport';

type BoardId = 'esp32s3' | 'esp32c6';

const BOARD_PROFILES: Record<
  BoardId,
  {
    label: string;
    prefix: string;
    bootloaderOffset: number;
    flashSize: '8MB' | '4MB';
    hint: string;
  }
> = {
  esp32s3: {
    label: 'Seeed Studio XIAO ESP32-S3',
    prefix: 'HotWire_SDR_XIAO_ESP32S3.ino',
    bootloaderOffset: 0x0,
    flashSize: '8MB',
    hint: '1.84–2.79 GHz RF Spectrum Analyzer',
  },
  esp32c6: {
    label: 'Seeed Studio XIAO ESP32-C6',
    prefix: 'HotWire_SDR_XIAO_ESP32C6.ino',
    bootloaderOffset: 0x0,
    flashSize: '4MB',
    hint: '1.84–2.79 GHz RF Spectrum Analyzer (External U.FL Antenna)',
  },
};

export interface BottomDrawerProps {
  open: boolean;
  onClose: () => void;
  transportSnapshot: TransportSnapshot;
  caps: BoardCapabilitiesFrame | null;
  serialTransport: SerialTransport;
}

export const BottomDrawer: React.FC<BottomDrawerProps> = ({
  open,
  onClose,
  transportSnapshot,
  caps,
  serialTransport,
}) => {
  const [selectedBoard, setSelectedBoard] = useState<BoardId>('esp32s3');
  const [flashLogs, setFlashLogs] = useState<string[]>([]);
  const [flashProgress, setFlashProgress] = useState<number>(0);
  const [flashing, setFlashing] = useState<boolean>(false);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [showCustomBin, setShowCustomBin] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [flashOffset, setFlashOffset] = useState<'full' | '0x10000' | '0x0'>('full');
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const boardProfile = BOARD_PROFILES[selectedBoard];

  useEffect(() => {
    if (caps?.board?.toUpperCase().includes('C6')) {
      setSelectedBoard('esp32c6');
    } else if (caps?.board?.toUpperCase().includes('S3')) {
      setSelectedBoard('esp32s3');
    }
  }, [caps?.board]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [flashLogs]);

  const appendLog = (line: string) => {
    setFlashLogs((prev) => [...prev.slice(-140), line]);
  };

  const appendChunk = (chunk: string) => {
    const cleaned = chunk.replace(/\r/g, '');
    if (!cleaned) return;
    setFlashLogs((prev) => {
      const parts = cleaned.split('\n');
      const next = prev.length > 0 ? [...prev] : [''];
      next[next.length - 1] = `${next[next.length - 1]}${parts[0]}`;
      for (let i = 1; i < parts.length; i++) {
        next.push(parts[i]);
      }
      return next.slice(-140);
    });
  };

  const firmwareUrls = useMemo(() => {
    const base = `${import.meta.env.BASE_URL}firmware/`;
    return [
      {
        label: 'bootloader',
        address: boardProfile.bootloaderOffset,
        url: `${base}${boardProfile.prefix}.bootloader.bin`,
      },
      {
        label: 'partitions',
        address: 0x8000,
        url: `${base}${boardProfile.prefix}.partitions.bin`,
      },
      {
        label: 'boot_app0',
        address: 0xe000,
        url: `${base}boot_app0.bin`,
      },
      {
        label: 'firmware',
        address: 0x10000,
        url: `${base}${boardProfile.prefix}.bin`,
      },
    ];
  }, [boardProfile]);

  const handleFlash = async (forceOtherPort = false) => {
    if (flashing) return;
    if (typeof navigator === 'undefined' || !navigator.serial) {
      setFlashError('Web Serial API is required for browser firmware flashing.');
      return;
    }

    setFlashing(true);
    setFlashError(null);
    setFlashProgress(0);
    setFlashLogs([]);
    serialTransport.setAutoReconnectPaused(true);

    let port = forceOtherPort ? null : serialTransport.getActiveWebSerialPort();

    try {
      appendLog(`[1/4] Preparing to flash ${boardProfile.label}...`);
      if (!forceOtherPort && transportSnapshot.transport === 'webserial' && port) {
        appendLog('Sending 0xF0 bootloader entry command & closing app transport...');
        try {
          await serialTransport.writeBytes(buildBootloaderCmd());
        } catch {
          // Ignore if port closes quickly
        }
        await new Promise((r) => setTimeout(r, 250));
        await serialTransport.disconnect(true);
      } else {
        appendLog('Select the XIAO ESP32 USB-JTAG / CDC COM port in the browser prompt...');
        port = await navigator.serial.requestPort();
      }

      if (!port) {
        throw new Error('No serial port selected.');
      }

      const fileArray: Array<{ data: Uint8Array; address: number }> = [];

      if (selectedFile) {
        appendLog(`Reading selected file: ${selectedFile.name}...`);
        const buf = new Uint8Array(await selectedFile.arrayBuffer());
        const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
        fileArray.push({ data: buf, address: addr });
        appendLog(`Loaded ${selectedFile.name} (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
      } else if (flashOffset === 'full') {
        appendLog('Downloading bundled full firmware images (bootloader + partitions + app0 + app)...');
        for (const item of firmwareUrls) {
          const resp = await fetch(item.url);
          if (!resp.ok) {
            throw new Error(
              `Missing binary ${item.url} (${resp.status}). Compile & bundle firmware first.`,
            );
          }
          const buf = new Uint8Array(await resp.arrayBuffer());
          appendLog(
            `Loaded ${item.label} @ 0x${item.address.toString(16)} (${buf.byteLength} bytes)`,
          );
          fileArray.push({ data: buf, address: item.address });
        }
      } else {
        appendLog(`Downloading bundled app firmware (${boardProfile.prefix}.bin)...`);
        const base = `${import.meta.env.BASE_URL}firmware/`;
        const appUrl = `${base}${boardProfile.prefix}.bin`;
        const resp = await fetch(appUrl);
        if (!resp.ok) {
          throw new Error(`Missing binary ${appUrl} (${resp.status}).`);
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
        fileArray.push({ data: buf, address: addr });
        appendLog(`Loaded ${boardProfile.prefix}.bin (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
      }

      appendLog('[2/4] Connecting to ROM bootloader via esptool-js...');
      const espTransport = new Transport(
        port as unknown as ConstructorParameters<typeof Transport>[0],
        false,
      );
      const loaderOptions: LoaderOptions = {
        transport: espTransport,
        baudrate: 460800,
        romBaudrate: 115200,
        terminal: {
          clean: () => {},
          writeLine: (line: string) => appendLog(line),
          write: (data: string) => appendChunk(data),
        },
      };

      const esploader = new ESPLoader(loaderOptions);
      let chip = '';
      try {
        chip = await esploader.main('default_reset');
      } catch {
        appendLog('Default reset sync timed out; retrying direct no_reset sync...');
        try {
          await espTransport.disconnect();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 150));
        chip = await esploader.main('no_reset');
      }
      appendLog(`Connected to bootloader chip: ${chip || 'ESP32-S3'}`);

      appendLog('[3/4] Writing flash memory...');
      const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
      const isBundledFull = !selectedFile && flashOffset === 'full';

      const flashOptions: FlashOptions = {
        fileArray,
        flashSize: boardProfile.flashSize,
        flashMode: isBundledFull ? 'dio' : 'keep',
        flashFreq: isBundledFull ? '80m' : 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const completedPrevFiles = fileArray
            .slice(0, fileIndex)
            .reduce((acc, f) => acc + f.data.byteLength, 0);
          const currentFileBytes = fileArray[fileIndex]
            ? fileArray[fileIndex].data.byteLength * (written / Math.max(1, total))
            : written;
          const ratio =
            totalBytes > 0
              ? (completedPrevFiles + currentFileBytes) / totalBytes
              : written / Math.max(1, total);
          setFlashProgress(Math.min(100, Math.round(ratio * 100)));
        },
      };

      await esploader.writeFlash(flashOptions);

      appendLog('[4/4] Flashing complete! Triggering hardware/watchdog reset...');
      let watchdogTriggered = false;
      if (selectedBoard === 'esp32s3') {
        try {
          // Clear FORCE_DOWNLOAD_BOOT so the ROM bootloader doesn't re-enter download mode
          const RTC_CNTL_OPTION1_REG = 0x6000812c;
          const RTC_CNTL_WDTCONFIG0_REG = 0x60008098;
          const RTC_CNTL_WDTCONFIG1_REG = 0x6000809c;
          const RTC_CNTL_WDTFEED_REG = 0x600080a8;
          const RTC_CNTL_WDTWPROTECT_REG = 0x600080b0;
          const RTC_CNTL_WDT_WKEY = 0x50d83aa1;

          await esploader.writeReg(RTC_CNTL_OPTION1_REG, 0);
          await esploader.writeReg(RTC_CNTL_WDTWPROTECT_REG, RTC_CNTL_WDT_WKEY);
          await esploader.writeReg(RTC_CNTL_WDTCONFIG1_REG, 2000);
          const curCfg0 = await esploader.readReg(RTC_CNTL_WDTCONFIG0_REG);
          // Bit 31: WDT_EN, Bits 30:28: WDT_STG0 = 3 (System Reset), Bits 20:18: SYS_RESET_LENGTH = 7
          const nextCfg0 = ((curCfg0 & 0x0fe3ffff) | 0xb01c0000) >>> 0;
          await esploader.writeReg(RTC_CNTL_WDTCONFIG0_REG, nextCfg0);
          await esploader.writeReg(RTC_CNTL_WDTFEED_REG, 0x80000000);
          watchdogTriggered = true;
          await new Promise((r) => setTimeout(r, 150));
        } catch (wdtErr) {
          if (!watchdogTriggered) {
            appendLog(
              `Watchdog reset note: ${wdtErr instanceof Error ? wdtErr.message : String(wdtErr)}`,
            );
          }
        }
      }

      if (!watchdogTriggered) {
        try {
          await esploader.after('hard_reset');
        } catch {
          // ignore
        }
        try {
          await espTransport.setDTR(false);
          await espTransport.setRTS(true);
          await new Promise((r) => setTimeout(r, 100));
          await espTransport.setRTS(false);
          await new Promise((r) => setTimeout(r, 80));
        } catch {
          // ignore
        }
      }
      try {
        await espTransport.disconnect();
      } catch {
        // ignore
      }

      setFlashProgress(100);
      appendLog('Flash complete! Reconnecting to HotWire...');
      await new Promise((r) => setTimeout(r, 1200));
      serialTransport.setAutoReconnectPaused(false);
      try {
        await serialTransport.connectWebSerialPort(port);
      } catch {
        // Windows USB-Serial/JTAG may still be re-enumerating after watchdog reset
        await new Promise((r) => setTimeout(r, 900));
        await serialTransport.connectWebSerialPort(port);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFlashError(
        `${msg} (If USB re-enumerated, hold BOOT + tap RESET and click "Select Port & Flash")`,
      );
      appendLog(`ERROR: ${msg}`);
      serialTransport.setAutoReconnectPaused(false);
    } finally {
      setFlashing(false);
    }
  };

  if (!open) return null;

  return (
    <section className="bottom-drawer" aria-label="XIAO ESP32 Web Flasher">
      <div className="drawer-header">
        <div className="drawer-tabs">
          <span className="drawer-title">Web Flasher (esptool-js)</span>
          <span className="flasher-board-badge">
            {boardProfile.label} • {boardProfile.flashSize}
          </span>
        </div>

        <span className="flasher-hint">
          {caps ? `Connected: ${caps.board} (${caps.firmware})` : boardProfile.hint}
        </span>

        <button type="button" className="btn-mini" onClick={onClose}>
          Hide
        </button>
      </div>

      <div className="drawer-body">
        <div className="flasher-pane">
          <div className="flasher-controls">
            <div className="control-group">
              <label htmlFor="flash-board">Board</label>
              <select
                id="flash-board"
                value={selectedBoard}
                disabled={flashing}
                onChange={(e) => setSelectedBoard(e.target.value as BoardId)}
              >
                <option value="esp32s3">XIAO ESP32-S3 (8MB)</option>
                <option value="esp32c6">XIAO ESP32-C6 (4MB)</option>
              </select>
            </div>

            <button
              type="button"
              className="btn btn-accent"
              onClick={() => void handleFlash(false)}
              disabled={flashing}
            >
              {flashing ? `Flashing ${flashProgress}%...` : 'Flash Firmware'}
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-compact"
              disabled={flashing}
              onClick={() => void handleFlash(true)}
              title="Choose a specific COM/USB serial port manually"
            >
              Select Port &amp; Flash...
            </button>

            <button
              type="button"
              className={`btn btn-secondary btn-compact ${showCustomBin ? 'active' : ''}`}
              disabled={flashing}
              onClick={() => {
                setShowCustomBin((prev) => {
                  const next = !prev;
                  if (!next) {
                    setSelectedFile(null);
                    setFlashOffset('full');
                  }
                  return next;
                });
              }}
            >
              Custom .bin...
            </button>

            {showCustomBin && (
              <>
                <div className="control-group">
                  <label htmlFor="flash-offset">Target Image</label>
                  <select
                    id="flash-offset"
                    value={flashOffset}
                    disabled={flashing}
                    onChange={(e) =>
                      setFlashOffset(e.target.value as '0x10000' | '0x0' | 'full')
                    }
                  >
                    <option value="full">Bundled Full Image (Boot + Partitions + App)</option>
                    <option value="0x10000">App Firmware @ 0x10000</option>
                    <option value="0x0">Merged .bin @ 0x0</option>
                  </select>
                </div>

                <label className="file-picker-label">
                  <span>
                    {selectedFile
                      ? selectedFile.name
                      : `Choose .bin (${boardProfile.prefix})`}
                  </span>
                  <input
                    type="file"
                    accept=".bin"
                    disabled={flashing}
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      setSelectedFile(file);
                      if (file && flashOffset === 'full') {
                        setFlashOffset('0x10000');
                      }
                    }}
                  />
                </label>

                {selectedFile && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-compact"
                    disabled={flashing}
                    onClick={() => setSelectedFile(null)}
                  >
                    Use Bundled
                  </button>
                )}
              </>
            )}
          </div>

          {flashing && (
            <div className="flash-progress-track" aria-label="Flashing progress">
              <div
                className="flash-progress-fill"
                style={{ width: `${flashProgress}%` }}
              />
            </div>
          )}

          {flashError && <div className="flasher-error">{flashError}</div>}

          <div className="flasher-log" ref={logContainerRef}>
            {flashLogs.length === 0 ? (
              <div className="flasher-placeholder">
                Select your board and click Flash Firmware to program bundled SDR binaries directly from Chromium via Web Serial &amp; esptool-js.
              </div>
            ) : (
              flashLogs.map((l, idx) => <div key={idx}>{l || '\u00a0'}</div>)
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
