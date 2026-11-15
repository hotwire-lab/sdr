import React from 'react';
import {
  AppMode,
  BoardCapabilitiesFrame,
  DEPTH_PRESETS,
  RATE_PRESETS,
  TriggerMode,
} from '../protocol/types';
import { DecoderConfig, DecoderKind } from '../protocol/decoders';
import { TransportSnapshot } from '../transport/SerialTransport';

export interface TopToolbarProps {
  transport: TransportSnapshot;
  caps: BoardCapabilitiesFrame | null;
  appMode: AppMode;
  onAppModeChange: (mode: AppMode) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onStartDemo: () => void;
  onAllZ: () => void;
  // LA controls
  rateId: number;
  onRateChange: (id: number) => void;
  depthBlocksKb: number;
  onDepthChange: (blocksKb: number) => void;
  trigCh: number;
  onTrigChChange: (ch: number) => void;
  trigEdge: TriggerMode;
  onTrigEdgeChange: (edge: TriggerMode) => void;
  preTrigRatio: number;
  onPreTrigRatioChange: (ratio: number) => void;
  decoderConfig: DecoderConfig;
  onDecoderKindChange: (kind: DecoderKind) => void;
  laCapturing: boolean;
  laProgressText: string | null;
  onStartCapture: () => void;
  onAbortCapture: () => void;
  // SDR stream controls
  sdrStreaming: boolean;
  sdrTargetFps: number;
  onSdrTargetFpsChange: (fps: number) => void;
  onToggleSdrStream: () => void;
  // Drawer / utility
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  transport,
  caps,
  appMode,
  onAppModeChange,
  onConnect,
  onDisconnect,
  onStartDemo,
  onAllZ,
  rateId,
  onRateChange,
  depthBlocksKb,
  onDepthChange,
  trigCh,
  onTrigChChange,
  trigEdge,
  onTrigEdgeChange,
  preTrigRatio,
  onPreTrigRatioChange,
  decoderConfig,
  onDecoderKindChange,
  laCapturing,
  laProgressText,
  onStartCapture,
  onAbortCapture,
  sdrStreaming,
  sdrTargetFps,
  onSdrTargetFpsChange,
  onToggleSdrStream,
  drawerOpen,
  onToggleDrawer,
}) => {
  const isConnected = transport.status === 'connected';
  const isConnecting = transport.status === 'connecting';
  const sdrSupported = caps ? caps.sdrCapable : true;

  return (
    <header className="top-toolbar">
      <div className="toolbar-row toolbar-row-primary">
        <div className="brand-cluster">
          <div className="brand-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                d="M2 12h4l2.5-6 3 12 3-9 2 3H22"
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="brand-text">
            <span className="brand-title">HotWire</span>
            <span className="brand-badge">SDR + LA</span>
          </div>
        </div>

        <div className="mode-switcher" role="tablist" aria-label="Instrument Mode">
          <button
            type="button"
            role="tab"
            aria-selected={appMode === 'la'}
            className={`mode-tab ${appMode === 'la' ? 'active' : ''}`}
            onClick={() => onAppModeChange('la')}
          >
            Logic Analyzer (8ch)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={appMode === 'sdr'}
            className={`mode-tab ${appMode === 'sdr' ? 'active' : ''}`}
            disabled={!sdrSupported}
            title={
              sdrSupported
                ? '1842–2790 MHz RF Spectrum Analyzer & Waterfall (ESP32-S3)'
                : 'Connected board does not support ESP32-S3 RF Dump Engine'
            }
            onClick={() => onAppModeChange('sdr')}
          >
            RF Spectrum (SDR)
            <span className="mode-pill">1.8–2.8 GHz</span>
          </button>
        </div>

        <div className="connection-cluster">
          <div
            className={`status-pill status-${transport.status}`}
            title={transport.errorMessage ?? transport.deviceName}
          >
            <span className="status-dot" />
            <span className="status-label">
              {isConnected
                ? caps?.board
                  ? `${caps.board}${transport.transport === 'demo' ? ' (Demo)' : ''}`
                  : transport.deviceName
                : isConnecting
                  ? 'Connecting...'
                  : 'Disconnected'}
            </span>
            {transport.vidPid && isConnected && (
              <span className="status-vidpid">{transport.vidPid}</span>
            )}
          </div>

          {!isConnected ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onConnect}
                disabled={isConnecting}
              >
                Connect USB
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onStartDemo}
                disabled={isConnecting}
              >
                Demo
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onDisconnect}
            >
              Disconnect
            </button>
          )}

          <button
            type="button"
            className={`btn btn-ghost ${drawerOpen ? 'active' : ''}`}
            onClick={onToggleDrawer}
            title="Toggle Serial Terminal & Firmware Web Flasher"
          >
            Terminal / Flash
          </button>
        </div>
      </div>

      {transport.errorMessage && (
        <div className="toolbar-error-banner" role="alert">
          <span>{transport.errorMessage}</span>
        </div>
      )}

      {appMode === 'la' ? (
        <div className="toolbar-row toolbar-row-controls">
          <div className="control-group">
            <label htmlFor="la-rate">Sample Rate</label>
            <select
              id="la-rate"
              value={rateId}
              onChange={(e) => onRateChange(Number(e.target.value))}
              disabled={laCapturing}
            >
              {RATE_PRESETS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="la-depth">Depth</label>
            <select
              id="la-depth"
              value={depthBlocksKb}
              onChange={(e) => onDepthChange(Number(e.target.value))}
              disabled={laCapturing}
            >
              {DEPTH_PRESETS.map((d) => (
                <option key={d.blocksKb} value={d.blocksKb}>
                  {d.label} ({d.samples.toLocaleString()})
                </option>
              ))}
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="la-trig-ch">Trigger</label>
            <select
              id="la-trig-ch"
              value={trigCh}
              onChange={(e) => onTrigChChange(Number(e.target.value))}
              disabled={laCapturing}
            >
              <option value={255}>Immediate</option>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((ch) => (
                <option key={ch} value={ch}>
                  D{ch}
                </option>
              ))}
            </select>
            <select
              aria-label="Trigger Edge"
              value={trigEdge}
              onChange={(e) => onTrigEdgeChange(e.target.value as TriggerMode)}
              disabled={laCapturing || trigCh === 255}
            >
              <option value="rising">Rising</option>
              <option value="falling">Falling</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="la-pretrig">Pre-Trig</label>
            <select
              id="la-pretrig"
              value={preTrigRatio}
              onChange={(e) => onPreTrigRatioChange(Number(e.target.value))}
              disabled={laCapturing || trigCh === 255}
            >
              <option value={0}>0%</option>
              <option value={1}>25%</option>
              <option value={2}>50%</option>
              <option value={3}>75%</option>
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="la-decoder">Decoder</label>
            <select
              id="la-decoder"
              value={decoderConfig.kind}
              onChange={(e) => onDecoderKindChange(e.target.value as DecoderKind)}
            >
              <option value="none">None</option>
              <option value="spi">SPI (D0..D3)</option>
              <option value="i2c">I2C (D4..D5)</option>
              <option value="uart">UART (D6)</option>
            </select>
          </div>

          <div className="control-spacer" />

          <div className="action-cluster">
            <button
              type="button"
              className="btn btn-warning-outline"
              onClick={onAllZ}
              disabled={!isConnected}
              title="Release all Force-I/O channels to High-Z input"
            >
              All Z
            </button>

            {!laCapturing ? (
              <button
                type="button"
                className="btn btn-accent"
                onClick={onStartCapture}
                disabled={!isConnected}
              >
                Capture Logic
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                onClick={onAbortCapture}
              >
                Abort ({laProgressText ?? 'Sampling...'})
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="toolbar-row toolbar-row-controls">
          <div className="sdr-status-summary">
            <span className="summary-chip">
              ESP32-S3 Direct RF Dump Engine (0x3FCD0000)
            </span>
            <span className="summary-hint">
              Force-I/O D0–D7 remains live in background on Core 0
            </span>
          </div>

          <div className="control-spacer" />

          <div className="control-group">
            <label htmlFor="sdr-fps">Rate</label>
            <select
              id="sdr-fps"
              value={sdrTargetFps}
              onChange={(e) => onSdrTargetFpsChange(Number(e.target.value))}
            >
              <option value={10}>10 FPS</option>
              <option value={20}>20 FPS</option>
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
            </select>
          </div>

          <div className="action-cluster">
            <button
              type="button"
              className="btn btn-warning-outline"
              onClick={onAllZ}
              disabled={!isConnected}
              title="Release all Force-I/O pins to High-Z"
            >
              All Z
            </button>
            <button
              type="button"
              className={`btn ${sdrStreaming ? 'btn-danger' : 'btn-accent'}`}
              onClick={onToggleSdrStream}
              disabled={!isConnected}
            >
              {sdrStreaming ? 'Stop RF Stream' : 'Start RF Stream'}
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
