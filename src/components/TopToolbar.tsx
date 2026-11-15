import React from 'react';
import { BoardCapabilitiesFrame } from '../protocol/types';
import { TransportSnapshot } from '../transport/SerialTransport';

export interface TopToolbarProps {
  transport: TransportSnapshot;
  caps: BoardCapabilitiesFrame | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onStartDemo: () => void;
  sdrStreaming: boolean;
  onToggleSdrStream: () => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  transport,
  caps,
  onConnect,
  onDisconnect,
  onStartDemo,
  sdrStreaming,
  onToggleSdrStream,
  drawerOpen,
  onToggleDrawer,
}) => {
  const isConnected = transport.status === 'connected';
  const isConnecting = transport.status === 'connecting';

  return (
    <header className="top-toolbar">
      <div className="toolbar-row">
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
            <span className="brand-title">HotWire SDR</span>
            <span className="brand-badge">1.8–2.8 GHz</span>
          </div>
        </div>

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

        <div className="control-spacer" />

        <div className="action-cluster">
          <button
            type="button"
            className={`btn btn-stream ${sdrStreaming ? 'btn-danger' : 'btn-accent'}`}
            onClick={onToggleSdrStream}
            disabled={!isConnected}
            title={sdrStreaming ? 'Halt live RF streaming' : 'Start live RF spectrum streaming'}
          >
            <span className="btn-icon" aria-hidden="true">
              {sdrStreaming ? '⏹' : '▶'}
            </span>
            <span>{sdrStreaming ? 'Stop RF' : 'Start RF'}</span>
          </button>

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
            Console &amp; Flasher
          </button>
        </div>
      </div>

      {transport.errorMessage && (
        <div className="toolbar-error-banner" role="alert">
          <span>{transport.errorMessage}</span>
        </div>
      )}
    </header>
  );
};
