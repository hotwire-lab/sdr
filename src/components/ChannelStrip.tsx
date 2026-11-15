import React, { useRef, useState } from 'react';
import {
  BoardCapabilities,
  CHANNELS,
  PinForceMode,
  PinPullMode,
  StatusTelemetry,
} from '../protocol/types';

export interface ChannelUiState {
  mode: PinForceMode;
  pull: PinPullMode;
  protect: boolean;
}

interface ChannelStripProps {
  connected: boolean;
  telemetry: StatusTelemetry;
  channelConfigs: ChannelUiState[];
  channelLabels?: readonly string[];
  boardPins?: BoardCapabilities['pins'];
  onForceChannel: (ch: number, mode: PinForceMode, pull: PinPullMode, protect?: boolean) => void;
  onRenameChannel?: (ch: number, alias: string) => void;
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  connected,
  telemetry,
  channelConfigs,
  channelLabels,
  boardPins,
  onForceChannel,
  onRenameChannel,
}) => {
  const pulseRestoreRef = useRef<Map<number, { mode: PinForceMode; pull: PinPullMode }>>(new Map());
  const [editingCh, setEditingCh] = useState<number | null>(null);
  const [draftAlias, setDraftAlias] = useState('');

  const beginEditAlias = (ch: number, currentAlias: string) => {
    setEditingCh(ch);
    setDraftAlias(currentAlias);
  };

  const commitAlias = (ch: number) => {
    setEditingCh(null);
    onRenameChannel?.(ch, draftAlias.trim());
  };

  const handlePulseDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    ch: number,
    physHigh: boolean,
    cfg: ChannelUiState
  ) => {
    if (!connected) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointerId
    }
    if (!pulseRestoreRef.current.has(ch)) {
      pulseRestoreRef.current.set(ch, { mode: cfg.mode, pull: cfg.pull });
    }
    // Force the opposite of the live physical state
    const targetMode: PinForceMode = physHigh ? 1 : 2;
    onForceChannel(ch, targetMode, cfg.pull, cfg.protect);
  };

  const handlePulseEnd = (ch: number, cfg: ChannelUiState, hasContention: boolean) => {
    const prior = pulseRestoreRef.current.get(ch);
    if (!prior) return;
    pulseRestoreRef.current.delete(ch);
    if (hasContention) return;
    onForceChannel(ch, prior.mode, prior.pull, cfg.protect);
  };

  return (
    <aside className="channel-strip" aria-label="8-channel tri-state force controls">
      <div className="channel-strip-header">
        <span>CH / GPIO</span>
        <span>LIVE</span>
        <span>FORCE</span>
        <span>PULSE</span>
        <span>PULL</span>
      </div>

      <div className="channel-rows">
        {CHANNELS.map((meta) => {
          const bit = 1 << meta.ch;
          const resolvedGpio = boardPins?.find((p) => p.ch === meta.ch)?.gpio ?? meta.gpio;
          const cfg = channelConfigs[meta.ch] ?? { mode: 0, pull: 0, protect: true };
          const physHigh = (telemetry.physicalLevels & bit) !== 0;
          const forceActive = (telemetry.forceEnableMask & bit) !== 0;
          const forcedHigh = (telemetry.forcedLevels & bit) !== 0;
          const hasContention = (telemetry.contentionMask & bit) !== 0;

          const effectiveMode: PinForceMode = forceActive ? (forcedHigh ? 2 : 1) : cfg.mode;
          const isZMode = effectiveMode === 0;

          return (
            <div
              key={meta.ch}
              className={`channel-row ${hasContention ? 'channel-row-short' : ''}`}
            >
              <div className="ch-id-cell">
                <span className="ch-color-bar" style={{ backgroundColor: meta.color }} />
                <div className="ch-labels">
                  {editingCh === meta.ch ? (
                    <input
                      type="text"
                      className="ch-alias-input"
                      maxLength={14}
                      autoFocus
                      value={draftAlias}
                      placeholder={meta.label}
                      onChange={(e) => setDraftAlias(e.target.value)}
                      onBlur={() => commitAlias(meta.ch)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitAlias(meta.ch);
                        else if (e.key === 'Escape') setEditingCh(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ch-name-btn"
                      title="Click to rename channel alias"
                      onClick={() => beginEditAlias(meta.ch, channelLabels?.[meta.ch] ?? '')}
                    >
                      {channelLabels?.[meta.ch]?.trim() || meta.label}
                    </button>
                  )}
                  <span className="ch-gpio">
                    {channelLabels?.[meta.ch]?.trim()
                      ? `${meta.label} · GPIO ${resolvedGpio}`
                      : `GPIO ${resolvedGpio}`}
                  </span>
                </div>
              </div>

              <div className="ch-live-cell">
                {hasContention ? (
                  <span className="live-badge live-short" title="Bus conflict / short circuit >20ms">
                    SHORT!
                  </span>
                ) : (
                  <span
                    className={`live-badge ${physHigh ? 'live-high' : 'live-low'}`}
                    title={`Physical level: ${physHigh ? 'HIGH (3.3V)' : 'LOW (0V)'}`}
                  >
                    {physHigh ? '1' : '0'}
                  </span>
                )}
              </div>

              <div className="ch-force-cell">
                <div className="seg-group" role="group" aria-label={`${meta.label} tri-state mode`}>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 0 ? 'active active-z' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 0, cfg.pull, cfg.protect)}
                    title={`Release ${meta.label} to High-Z Input`}
                  >
                    Z
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 1 ? 'active active-low' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 1, cfg.pull, cfg.protect)}
                    title={`Force ${meta.label} LOW (0V)`}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    disabled={!connected}
                    className={`seg-btn ${effectiveMode === 2 ? 'active active-high' : ''}`}
                    onClick={() => onForceChannel(meta.ch, 2, cfg.pull, cfg.protect)}
                    title={`Force ${meta.label} HIGH (3.3V)`}
                  >
                    1
                  </button>
                </div>
              </div>

              <div className="ch-pulse-cell">
                <button
                  type="button"
                  disabled={!connected}
                  className="btn-pulse"
                  onPointerDown={(e) => handlePulseDown(e, meta.ch, physHigh, cfg)}
                  onPointerUp={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  onPointerCancel={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  onLostPointerCapture={() => handlePulseEnd(meta.ch, cfg, hasContention)}
                  title={`Hold to pulse ${meta.label} to ${physHigh ? '0' : '1'}, release to restore`}
                >
                  ⚡
                </button>
              </div>

              <div className="ch-pull-cell">
                <button
                  type="button"
                  disabled={!connected || !isZMode}
                  className={`btn-pull ${cfg.pull !== 0 && isZMode ? 'active' : ''}`}
                  onClick={() =>
                    onForceChannel(
                      meta.ch,
                      0,
                      ((cfg.pull + 1) % 3) as PinPullMode,
                      cfg.protect
                    )
                  }
                  title={
                    cfg.pull === 1
                      ? 'Internal Pull-Up (~45 kΩ) — click to switch to Pull-Down'
                      : cfg.pull === 2
                        ? 'Internal Pull-Down (~45 kΩ) — click to release floating (-)'
                        : 'Floating (No pull) — click to cycle PU / PD'
                  }
                >
                  {cfg.pull === 1 ? 'PU' : cfg.pull === 2 ? 'PD' : '-'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
};
