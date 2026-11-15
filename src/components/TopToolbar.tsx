import React from 'react';
import { BoardCapabilitiesFrame } from '../protocol/types';
import { TransportSnapshot } from '../transport/SerialTransport';

export interface TopToolbarProps {
  transport: TransportSnapshot;
  caps: BoardCapabilitiesFrame | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onStartDemo: () => void;
  onAllZ: () => void;
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
  onConnect,
  onDisconnect,
  onStartDemo,
  onAllZ,
  sdrStreaming,
  sdrTargetFps,
  onSdrTargetFpsChange,
  onToggleSdrStream,
  drawerOpen,
  onToggleDrawer,
}) => {
  const isConnected = transport.status === 'connected';
  const isConnecting = transport.status === 'connecting';

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
            <span className="brand-badge">SDR 1.8–2.8 GHz</span>
          </div>
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

      <div className="toolbar-row toolbar-row-controls">
        <div className="sdr-status-summary">
          <span className="summary-chip">
            ESP32-S3 Direct RF Dump Engine (0x3FCD0000)
          </span>
          <span className="summary-hint">
            1842–2790 MHz Wideband Spectrum &amp; Waterfall Analyzer
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
    </header>
  );
};
