import React, { useEffect, useState } from 'react';
import {
  CHANNELS,
  PinForceState,
  SDR_BAND_PRESETS,
  SDR_FFT_SIZE_PRESETS,
  SDR_GAIN_AGC,
  SDR_LO_DIVIDER_THRESHOLD_MHZ,
  SDR_MAX_FREQ_MHZ,
  SDR_MAX_MANUAL_GAIN,
  SDR_MIN_FREQ_MHZ,
  SDR_SAMPLE_RATE_PRESETS,
  StatusTelemetryFrame,
} from '../protocol/types';

export interface SdrControlBarProps {
  connected: boolean;
  centerFreqMhz: number;
  onCenterFreqChange: (freqMhz: number) => void;
  rateBwCode: number;
  onRateBwChange: (code: number) => void;
  fftLog2: number;
  onFftLog2Change: (log2: number) => void;
  maxHoldDetector: boolean;
  onMaxHoldDetectorChange: (enabled: boolean) => void;
  subWindows: number;
  onSubWindowsChange: (count: number) => void;
  dcNotch: boolean;
  onDcNotchChange: (enabled: boolean) => void;
  spurBlanker: boolean;
  onSpurBlankerChange: (enabled: boolean) => void;
  onClearPeakHold: () => void;
  sweepEnabled: boolean;
  onToggleSweep: () => void;
  gainIndex: number;
  onGainIndexChange: (gain: number) => void;
  activeGainIndex: number;
  adcClip: boolean;
  loDivActive: boolean;
  captureTruncated: boolean;
  onOpenRawIq: () => void;
  telemetry: StatusTelemetryFrame | null;
  pinForceStates: PinForceState[];
  onCyclePinForce: (ch: number) => void;
  onAllZ: () => void;
}

export const SdrControlBar: React.FC<SdrControlBarProps> = ({
  connected,
  centerFreqMhz,
  onCenterFreqChange,
  rateBwCode,
  onRateBwChange,
  fftLog2,
  onFftLog2Change,
  maxHoldDetector,
  onMaxHoldDetectorChange,
  subWindows,
  onSubWindowsChange,
  dcNotch,
  onDcNotchChange,
  spurBlanker,
  onSpurBlankerChange,
  onClearPeakHold,
  sweepEnabled,
  onToggleSweep,
  gainIndex,
  onGainIndexChange,
  activeGainIndex,
  adcClip,
  loDivActive,
  captureTruncated,
  onOpenRawIq,
  telemetry,
  pinForceStates,
  onCyclePinForce,
  onAllZ,
}) => {
  const [freqDraft, setFreqDraft] = useState(String(centerFreqMhz));

  useEffect(() => {
    setFreqDraft(String(centerFreqMhz));
  }, [centerFreqMhz]);

  const commitFreqDraft = () => {
    const parsed = Number(freqDraft);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(
        SDR_MIN_FREQ_MHZ,
        Math.min(SDR_MAX_FREQ_MHZ, Math.round(parsed)),
      );
      onCenterFreqChange(clamped);
      setFreqDraft(String(clamped));
    } else {
      setFreqDraft(String(centerFreqMhz));
    }
  };

  const isSub2210 = loDivActive || centerFreqMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ;
  const isAgc = gainIndex === SDR_GAIN_AGC;

  return (
    <section className="sdr-control-bar" aria-label="RF Tuner and DSP Controls">
      {/* Row 1: Frequency Tuner + Preset Band Chips */}
      <div className="sdr-row sdr-tuner-row">
        <div className="tuner-readout-group">
          <div className="tuner-step-buttons">
            <button
              type="button"
              className="btn-step"
              onClick={() => onCenterFreqChange(centerFreqMhz - 10)}
              disabled={!connected || centerFreqMhz <= SDR_MIN_FREQ_MHZ}
              title="-10 MHz"
            >
              -10
            </button>
            <button
              type="button"
              className="btn-step"
              onClick={() => onCenterFreqChange(centerFreqMhz - 1)}
              disabled={!connected || centerFreqMhz <= SDR_MIN_FREQ_MHZ}
              title="-1 MHz"
            >
              -1
            </button>
          </div>

          <div className="tuner-input-wrap">
            <input
              type="number"
              className="tuner-mhz-input"
              aria-label="Center Frequency MHz"
              min={SDR_MIN_FREQ_MHZ}
              max={SDR_MAX_FREQ_MHZ}
              step={1}
              value={freqDraft}
              onChange={(e) => setFreqDraft(e.target.value)}
              onBlur={commitFreqDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitFreqDraft();
                }
              }}
              disabled={!connected}
            />
            <span className="tuner-unit">MHz</span>
          </div>

          <div className="tuner-step-buttons">
            <button
              type="button"
              className="btn-step"
              onClick={() => onCenterFreqChange(centerFreqMhz + 1)}
              disabled={!connected || centerFreqMhz >= SDR_MAX_FREQ_MHZ}
              title="+1 MHz"
            >
              +1
            </button>
            <button
              type="button"
              className="btn-step"
              onClick={() => onCenterFreqChange(centerFreqMhz + 10)}
              disabled={!connected || centerFreqMhz >= SDR_MAX_FREQ_MHZ}
              title="+10 MHz"
            >
              +10
            </button>
          </div>

          <div className="tuner-slider-wrap">
            <input
              type="range"
              className="tuner-slider"
              aria-label="Frequency Slider"
              min={SDR_MIN_FREQ_MHZ}
              max={SDR_MAX_FREQ_MHZ}
              step={1}
              value={centerFreqMhz}
              onChange={(e) => onCenterFreqChange(Number(e.target.value))}
              disabled={!connected}
            />
            <div className="tuner-bounds">
              <span>{SDR_MIN_FREQ_MHZ}</span>
              <span className="tuner-bound-mid">2210 LO</span>
              <span>{SDR_MAX_FREQ_MHZ}</span>
            </div>
          </div>

          <span
            className={`lo-badge ${isSub2210 ? 'lo-active' : 'lo-direct'}`}
            title={
              isSub2210
                ? '5/6 LO divider engaged via I2C block 0x63 for 1842–2209 MHz tuning'
                : 'Direct RFPLL VCO tuning (2210–2790 MHz)'
            }
          >
            {isSub2210 ? '5/6 LO Divider Active' : 'Direct RFPLL'}
          </span>
        </div>

        <div className="band-presets" role="group" aria-label="Band Quick-Jump">
          {SDR_BAND_PRESETS.map((preset) => {
            const active = Math.abs(centerFreqMhz - preset.freqMhz) < 1;
            return (
              <button
                key={preset.freqMhz}
                type="button"
                className={`band-chip ${active ? 'active' : ''} ${preset.sub2210 ? 'sub2210' : ''}`}
                onClick={() => onCenterFreqChange(preset.freqMhz)}
                disabled={!connected}
                title={preset.label}
              >
                {preset.shortLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 2: Span, FFT, Detector, DSP & Gain */}
      <div className="sdr-row sdr-dsp-row">
        <div className="control-group">
          <label htmlFor="sdr-span">Span / Rate</label>
          <select
            id="sdr-span"
            value={rateBwCode}
            onChange={(e) => onRateBwChange(Number(e.target.value))}
            disabled={!connected}
          >
            {SDR_SAMPLE_RATE_PRESETS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="sdr-fft">FFT Bins</label>
          <select
            id="sdr-fft"
            value={fftLog2}
            onChange={(e) => onFftLog2Change(Number(e.target.value))}
            disabled={!connected}
          >
            {SDR_FFT_SIZE_PRESETS.map((p) => (
              <option key={p.log2} value={p.log2}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>Detector</label>
          <div className="segmented-mini">
            <button
              type="button"
              className={!maxHoldDetector ? 'active' : ''}
              onClick={() => onMaxHoldDetectorChange(false)}
              disabled={!connected}
            >
              Mean Avg
            </button>
            <button
              type="button"
              className={maxHoldDetector ? 'active' : ''}
              onClick={() => onMaxHoldDetectorChange(true)}
              disabled={!connected}
            >
              Max-Hold
            </button>
          </div>
          <select
            aria-label="DSP Sub-windows"
            value={subWindows}
            onChange={(e) => onSubWindowsChange(Number(e.target.value))}
            disabled={!connected}
            title="Number of sub-captures accumulated per TX frame"
          >
            <option value={1}>1x</option>
            <option value={4}>4x</option>
            <option value={8}>8x</option>
          </select>
        </div>

        <div className="dsp-toggles">
          <button
            type="button"
            className={`toggle-chip ${dcNotch ? 'active' : ''}`}
            onClick={() => onDcNotchChange(!dcNotch)}
            title="Cancel LO leakage at center DC bins (firmware DC subtraction + host 3-bin notch)"
          >
            DC Spike Notch
          </button>
          <button
            type="button"
            className={`toggle-chip ${spurBlanker ? 'active' : ''}`}
            onClick={() => onSpurBlankerChange(!spurBlanker)}
            title="Suppress single-bin clock/PLL spurs >10 dB above adjacent neighbors"
          >
            Spur Blanker
          </button>
          <button
            type="button"
            className="toggle-chip"
            onClick={onClearPeakHold}
            title="Reset host Peak-Hold envelope"
          >
            Clear Peak
          </button>
          <button
            type="button"
            className={`toggle-chip ${sweepEnabled ? 'sweep-active' : ''}`}
            onClick={onToggleSweep}
            disabled={!connected}
            title="Toggle 0x32 automated 40 MHz multi-band wideband stepping (2400–2520 MHz)"
          >
            {sweepEnabled ? 'Sweep ON' : 'Wideband Sweep'}
          </button>
        </div>

        <div className="gain-cluster">
          <button
            type="button"
            className={`toggle-chip ${isAgc ? 'active' : ''}`}
            onClick={() => onGainIndexChange(isAgc ? 42 : SDR_GAIN_AGC)}
            disabled={!connected}
          >
            AGC
          </button>
          <input
            type="range"
            aria-label="Manual Gain"
            className="gain-slider"
            min={0}
            max={SDR_MAX_MANUAL_GAIN}
            step={1}
            value={isAgc ? activeGainIndex : gainIndex}
            disabled={!connected || isAgc}
            onChange={(e) => onGainIndexChange(Number(e.target.value))}
          />
          <span className="hw-gain-badge" title="Active Hardware RX Gain Step">
            HW Gain: {activeGainIndex}
          </span>
          {adcClip && (
            <span
              className="clip-alert-badge"
              title="I/Q samples hit +/-511 ADC rail! Lower manual gain or enable AGC."
            >
              ADC CLIP
            </span>
          )}
          {captureTruncated && (
            <span className="trunc-alert-badge" title="RF Dump SRAM capture sentinel truncated">
              TRUNC
            </span>
          )}
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-compact"
          onClick={onOpenRawIq}
          disabled={!connected}
          title="Capture raw time-domain I/Q snapshot (0x85) & inspect constellation"
        >
          Raw I/Q Inspector
        </button>
      </div>

      {/* Row 3: Inline Mini Force-I/O Strip (Spec 5.2) */}
      <div className="sdr-row sdr-forceio-row">
        <span className="mini-io-title">Force I/O (Core 0):</span>
        <div className="mini-io-pins">
          {CHANNELS.map((meta) => {
            const bit = 1 << meta.ch;
            const physicalHigh = telemetry ? (telemetry.physicalLevels & bit) !== 0 : false;
            const forced = pinForceStates[meta.ch] ?? 'Z';
            const contention = telemetry ? (telemetry.contentionMask & bit) !== 0 : false;
            return (
              <button
                key={meta.ch}
                type="button"
                className={`mini-io-pin force-${forced.toLowerCase()} ${
                  contention ? 'contention' : ''
                }`}
                onClick={() => onCyclePinForce(meta.ch)}
                disabled={!connected}
                title={`GPIO${meta.gpio} (${meta.label}) — Mode: ${forced}, Read: ${
                  physicalHigh ? 'HIGH' : 'LOW'
                }. Click to cycle Z -> 1 -> 0 -> Z`}
              >
                <span
                  className={`mini-led ${physicalHigh ? 'on' : 'off'}`}
                  style={{ '--ch-color': meta.color } as React.CSSProperties}
                />
                <span className="mini-pin-name">{meta.label}</span>
                <span className="mini-pin-mode">{contention ? 'ERR' : forced}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn-step"
          onClick={onAllZ}
          disabled={!connected}
          title="Release all Force-I/O pins to High-Z"
        >
          Release Z
        </button>
        <span className="mini-io-note">
          Toggle D0–D7 outputs to observe live RF switching spurs & coupling in the waterfall
        </span>
      </div>
    </section>
  );
};
