import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ESPLoader, FlashOptions, LoaderOptions, Transport } from 'esptool-js';
import '@xterm/xterm/css/xterm.css';
import {
  buildBootloaderCmd,
  computeXorChecksum,
  encodeResponseFrame,
} from '../protocol/codec';
import { BoardCapabilitiesFrame } from '../protocol/types';
import { SerialTransport, TransportSnapshot } from '../transport/SerialTransport';

export type DrawerTab = 'terminal' | 'flasher';

export type TargetBoardKey = 'esp32s3';

interface BoardFlashProfile {
  key: TargetBoardKey;
  label: string;
  chipName: string;
  prefix: string;
  bootloaderOffset: number;
  flashSize: '4MB' | '8MB';
  hint: string;
}

const BOARD_FLASH_PROFILES: Record<TargetBoardKey, BoardFlashProfile> = {
  esp32s3: {
    key: 'esp32s3',
    label: 'Seeed Studio XIAO ESP32-S3',
    chipName: 'ESP32-S3',
    prefix: 'HotWire_SDR_XIAO_ESP32S3.ino',
    bootloaderOffset: 0x0,
    flashSize: '8MB',
    hint: '1.84–2.79 GHz RF Spectrum Analyzer + Waterfall Engine',
  },
};

const QUICK_MACROS = [
  { label: 'help', cmd: 'help\r\n' },
  { label: 'sdr status', cmd: 'sdr status\r\n' },
  { label: 'sdr stop', cmd: 'sdr stop\r\n' },
  { label: 'tune 2437', cmd: 'tune 2437\r\n' },
  { label: 'tune 1910', cmd: 'tune 1910\r\n' },
  { label: 'status', cmd: 'status\r\n' },
  { label: 'release', cmd: 'release\r\n' },
  { label: 'short 7', cmd: 'short 7\r\n' },
];

export interface BottomDrawerProps {
  open: boolean;
  activeTab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  transportSnapshot: TransportSnapshot;
  caps: BoardCapabilitiesFrame | null;
  serialTransport: SerialTransport;
  registerTerminalWriter: (writer: (bytes: Uint8Array) => void) => () => void;
}

export const BottomDrawer: React.FC<BottomDrawerProps> = ({
  open,
  activeTab,
  onTabChange,
  onClose,
  transportSnapshot,
  caps,
  serialTransport,
  registerTerminalWriter,
}) => {
  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const [targetBoard, setTargetBoard] = useState<TargetBoardKey>('esp32s3');
  const [flashLogs, setFlashLogs] = useState<string[]>([]);
  const [flashProgress, setFlashProgress] = useState<number>(0);
  const [flashing, setFlashing] = useState<boolean>(false);
  const [flashError, setFlashError] = useState<string | null>(null);
  const [showCustomBin, setShowCustomBin] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [flashOffset, setFlashOffset] = useState<'full' | '0x10000' | '0x0'>('full');

  useEffect(() => {
    if (!termContainerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, monospace',
      fontSize: 12,
      theme: {
        background: '#090d16',
        foreground: '#d4e1f5',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainerRef.current);
    fitAddon.fit();

    term.writeln('\x1b[36mHotWire SDR Terminal Ready.\x1b[0m');
    term.onData((data) => {
      void serialTransport.writeBytes(new TextEncoder().encode(data));
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const unregister = registerTerminalWriter((bytes) => {
      term.write(bytes);
    });

    return () => {
      unregister();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [serialTransport, registerTerminalWriter]);

  useEffect(() => {
    if (open && activeTab === 'terminal') {
      window.setTimeout(() => {
        fitAddonRef.current?.fit();
      }, 60);
    }
  }, [open, activeTab]);

  const appendLog = (line: string) => {
    setFlashLogs((prev) => [...prev.slice(-140), line]);
  };

  const firmwareUrls = useMemo(() => {
    const profile = BOARD_FLASH_PROFILES[targetBoard];
    const base = `${import.meta.env.BASE_URL}firmware/`;
    return [
      {
        label: 'bootloader',
        address: profile.bootloaderOffset,
        url: `${base}${profile.prefix}.bootloader.bin`,
      },
      {
        label: 'partitions',
        address: 0x8000,
        url: `${base}${profile.prefix}.partitions.bin`,
      },
      {
        label: 'boot_app0',
        address: 0xe000,
        url: `${base}boot_app0.bin`,
      },
      {
        label: 'firmware',
        address: 0x10000,
        url: `${base}${profile.prefix}.bin`,
      },
    ];
  }, [targetBoard]);

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

    const profile = BOARD_FLASH_PROFILES[targetBoard];
    let port = forceOtherPort ? null : serialTransport.getActiveWebSerialPort();

    try {
      appendLog(`[1/4] Preparing to flash ${profile.label}...`);
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
        appendLog('Select the ESP32-S3 USB-JTAG / CDC COM port in the browser prompt...');
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
        appendLog(`Downloading bundled app firmware (${profile.prefix}.bin)...`);
        const base = `${import.meta.env.BASE_URL}firmware/`;
        const appUrl = `${base}${profile.prefix}.bin`;
        const resp = await fetch(appUrl);
        if (!resp.ok) {
          throw new Error(`Missing binary ${appUrl} (${resp.status}).`);
        }
        const buf = new Uint8Array(await resp.arrayBuffer());
        const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
        fileArray.push({ data: buf, address: addr });
        appendLog(`Loaded ${profile.prefix}.bin (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
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
          write: (data: string) => appendLog(data),
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
      appendLog(`Connected to bootloader chip: ${chip || 'ESP32'}`);

      appendLog('[3/4] Writing flash memory...');
      const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
      const isBundledFull = !selectedFile && flashOffset === 'full';

      const flashOptions: FlashOptions = {
        fileArray,
        flashSize: profile.flashSize,
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

      appendLog('[4/4] Flashing complete! Performing hardware reset...');
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
      try {
        await espTransport.disconnect();
      } catch {
        // ignore
      }

      setFlashProgress(100);
      appendLog('Flash complete! Reconnecting to HotWire...');
      await new Promise((r) => setTimeout(r, 900));
      serialTransport.setAutoReconnectPaused(false);
      await serialTransport.connectWebSerialPort(port);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFlashError(msg);
      appendLog(`ERROR: ${msg}`);
      serialTransport.setAutoReconnectPaused(false);
    } finally {
      setFlashing(false);
    }
  };

  // Sanity reference so codec helpers don't drift unused
  void computeXorChecksum;
  void encodeResponseFrame;

  if (!open) return null;

  return (
    <section className="bottom-drawer" aria-label="Developer Console and Web Flasher">
      <div className="drawer-header">
        <div className="drawer-tabs">
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'terminal' ? 'active' : ''}`}
            onClick={() => onTabChange('terminal')}
          >
            Serial Terminal
          </button>
          <button
            type="button"
            className={`drawer-tab ${activeTab === 'flasher' ? 'active' : ''}`}
            onClick={() => onTabChange('flasher')}
          >
            Web Flasher (esptool-js)
          </button>
        </div>

        <div className="drawer-macros">
          {activeTab === 'terminal' &&
            QUICK_MACROS.map((m) => (
              <button
                key={m.label}
                type="button"
                className="btn-macro"
                onClick={() =>
                  void serialTransport.writeBytes(new TextEncoder().encode(m.cmd))
                }
                disabled={transportSnapshot.status !== 'connected'}
              >
                {m.label}
              </button>
            ))}
        </div>

        <button type="button" className="btn-mini" onClick={onClose}>
          Hide
        </button>
      </div>

      <div className="drawer-body">
        <div
          className="terminal-pane"
          style={{ display: activeTab === 'terminal' ? 'flex' : 'none' }}
        >
          <div ref={termContainerRef} className="xterm-host" />
        </div>

        {activeTab === 'flasher' && (
          <div className="flasher-pane">
            <div className="flasher-controls">
              <div className="control-group">
                <label htmlFor="target-board">Target Board</label>
                <select
                  id="target-board"
                  value={targetBoard}
                  onChange={(e) => setTargetBoard(e.target.value as TargetBoardKey)}
                  disabled={flashing}
                >
                  {Object.values(BOARD_FLASH_PROFILES).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
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

              {transportSnapshot.transport === 'webserial' && (
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  disabled={flashing}
                  onClick={() => void handleFlash(true)}
                >
                  Select Other Port...
                </button>
              )}

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
                        : `Choose .bin (${BOARD_FLASH_PROFILES[targetBoard].prefix})`}
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

              <span className="flasher-hint">
                {caps ? `Connected: ${caps.board} (${caps.firmware})` : BOARD_FLASH_PROFILES[targetBoard].hint}
              </span>
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

            <div className="flasher-log">
              {flashLogs.length === 0 ? (
                <div className="flasher-placeholder">
                  Click Flash Firmware to program bundled ESP32-S3 SDR binaries directly from Chromium via Web Serial &amp; esptool-js.
                </div>
              ) : (
                flashLogs.map((l, idx) => <div key={idx}>{l}</div>)
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
