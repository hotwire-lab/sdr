import React, { useEffect, useState } from 'react';
import {
  SDR_BAND_PRESETS,
  SDR_FFT_SIZE_PRESETS,
  SDR_GAIN_AGC,
  SDR_LO_DIVIDER_THRESHOLD_MHZ,
  SDR_MAX_FREQ_MHZ,
  SDR_MAX_MANUAL_GAIN,
  SDR_MIN_FREQ_MHZ,
  SDR_SAMPLE_RATE_PRESETS,
} from '../protocol/types';

export interface SdrControlBarProps {
  connected: boolean;
  centerFreqMhz: number;
  onCenterFreqChange: (freqMhz: number) => void;
  rateBwCode: number;
  onRateBwChange: (code: number) => void;
  fftLog2: number;
  onFftLog2Change: (log2: number) => void;
  targetFps: number;
  onTargetFpsChange: (fps: number) => void;
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
}

export const SdrControlBar: React.FC<SdrControlBarProps> = ({
  connected,
  centerFreqMhz,
  onCenterFreqChange,
  rateBwCode,
  onRateBwChange,
  fftLog2,
  onFftLog2Change,
  targetFps,
  onTargetFpsChange,
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
}) => {
  const [freqDraft, setFreqDraft] = useState(String(centerFreqMhz));
  const [showDsp, setShowDsp] = useState(false);

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

  const stepFreq = (delta: number) => {
    const next = Math.max(
      SDR_MIN_FREQ_MHZ,
      Math.min(SDR_MAX_FREQ_MHZ, centerFreqMhz + delta),
    );
    onCenterFreqChange(next);
  };

  const isSub2210 = loDivActive || centerFreqMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ;
  const isAgc = gainIndex === SDR_GAIN_AGC;

  // Match active frequency to a band preset if within 1 MHz
  const matchedPreset = SDR_BAND_PRESETS.find(
    (p) => Math.abs(p.freqMhz - centerFreqMhz) < 1,
  );

  return (
    <section className="sdr-control-bar" aria-label="RF Tuner and DSP Controls">
      {/* Primary Row: Essential Stepping, Band Preset, Span, Gain, and Actions */}
      <div className="sdr-primary-row">
        {/* Frequency Tuner Cluster */}
        <div className="tuner-cluster">
          <button
            type="button"
            className="btn-step"
            onClick={(e) => stepFreq(e.shiftKey ? -10 : -1)}
            disabled={!connected || centerFreqMhz <= SDR_MIN_FREQ_MHZ}
            title="Step -1 MHz (Shift: -10 MHz)"
            aria-label="Step frequency down"
          >
            -
          </button>

          <div className="tuner-input-wrap">
            <input
              type="number"
              className="tuner-mhz-input"
              aria-label="Center Frequency in MHz"
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

          <button
            type="button"
            className="btn-step"
            onClick={(e) => stepFreq(e.shiftKey ? 10 : 1)}
            disabled={!connected || centerFreqMhz >= SDR_MAX_FREQ_MHZ}
            title="Step +1 MHz (Shift: +10 MHz)"
            aria-label="Step frequency up"
          >
            +
          </button>

          <select
            className="band-select"
            value={matchedPreset ? String(matchedPreset.freqMhz) : ''}
            onChange={(e) => {
              if (e.target.value) onCenterFreqChange(Number(e.target.value));
            }}
            disabled={!connected}
            title="Quick-jump to standard RF band"
            aria-label="RF Band Preset"
          >
            <option value="" disabled>
              {matchedPreset ? matchedPreset.label : 'Select Band...'}
            </option>
            {SDR_BAND_PRESETS.map((p) => (
              <option key={p.freqMhz} value={p.freqMhz}>
                {p.label} ({p.freqMhz} MHz)
              </option>
            ))}
          </select>
        </div>

        <div className="bar-divider" />

        {/* Span / Bandwidth */}
        <div className="control-group">
          <label htmlFor="sdr-span">Span</label>
          <select
            id="sdr-span"
            value={rateBwCode}
            onChange={(e) => onRateBwChange(Number(e.target.value))}
            disabled={!connected}
            title="RF Capture Bandwidth & Sampling Rate"
          >
            {SDR_SAMPLE_RATE_PRESETS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.spanMhz} MHz
              </option>
            ))}
          </select>
        </div>

        <div className="bar-divider" />

        {/* Gain Cluster */}
        <div className="gain-cluster">
          <button
            type="button"
            className={`toggle-chip ${isAgc ? 'active' : ''}`}
            onClick={() => onGainIndexChange(isAgc ? 42 : SDR_GAIN_AGC)}
            disabled={!connected}
            title={isAgc ? 'Switch to Manual Gain' : 'Switch to Automatic Gain Control'}
          >
            AGC
          </button>
          <input
            type="range"
            aria-label="Manual Gain Slider"
            className="gain-slider"
            min={0}
            max={SDR_MAX_MANUAL_GAIN}
            step={1}
            value={isAgc ? activeGainIndex : gainIndex}
            disabled={!connected || isAgc}
            onChange={(e) => onGainIndexChange(Number(e.target.value))}
            title={isAgc ? `Auto Gain (Step ${activeGainIndex})` : `Manual Gain: ${gainIndex}`}
          />
          <span className="hw-gain-badge">
            {isAgc ? `Auto (${activeGainIndex})` : `Gain ${gainIndex}`}
          </span>
          <div className="alert-slot" aria-live="polite">
            {adcClip && (
              <span
                className="clip-alert-badge"
                title="ADC Clipping! Lower manual gain or enable AGC."
              >
                CLIP
              </span>
            )}
            {captureTruncated && (
              <span className="trunc-alert-badge" title="Capture truncated">
                TRUNC
              </span>
            )}
          </div>
        </div>

        <div className="control-spacer" />

        {/* Actions & Advanced Drawer Toggle */}
        <div className="action-cluster">
          <button
            type="button"
            className={`btn btn-secondary btn-compact ${showDsp ? 'active' : ''}`}
            onClick={() => setShowDsp((v) => !v)}
            title="Toggle advanced DSP, FFT resolution and detector settings"
            aria-expanded={showDsp}
          >
            <span>DSP Options</span>
            <span className="expand-indicator">{showDsp ? '▲' : '▼'}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-compact"
            onClick={onOpenRawIq}
            disabled={!connected}
            title="Capture raw time-domain I/Q snapshot & inspect constellation"
          >
            Raw I/Q
          </button>
        </div>
      </div>

      {/* Full-Width Frequency Tuning Bar spanning 100% width directly above spectrum */}
      <div className="sdr-fullwidth-tuner" aria-label="Full-Width Frequency Tuner">
        <div className="tuner-track-info">
          <div className="tuner-track-left">
            <span className="track-freq-badge">
              <span className="track-freq-val">{centerFreqMhz}</span>
              <span className="track-freq-unit">MHz</span>
            </span>
            <span className={`track-mode-badge ${isSub2210 ? 'lo-active' : 'lo-direct'}`}>
              {isSub2210 ? '⚡ 5/6 LO' : 'Direct RF'}
            </span>
            <span className="track-preset-name">
              {matchedPreset ? matchedPreset.label : (isSub2210 ? 'Sub-2.2 GHz Band' : '2.4 GHz Band')}
            </span>
          </div>

          <div className="tuner-track-right">
            <span className="track-boundary-val">{SDR_MIN_FREQ_MHZ} MHz</span>
            <span className="track-arrow">⇄</span>
            <span className="track-boundary-val">{SDR_MAX_FREQ_MHZ} MHz</span>
          </div>
        </div>

        <div className="tuner-slider-wrap">
          <input
            type="range"
            className="fullwidth-tuner-slider"
            aria-label="Full-width Frequency Tuner Slider"
            min={SDR_MIN_FREQ_MHZ}
            max={SDR_MAX_FREQ_MHZ}
            step={1}
            value={centerFreqMhz}
            onChange={(e) => onCenterFreqChange(Number(e.target.value))}
            disabled={!connected}
            title={`${centerFreqMhz} MHz (${isSub2210 ? '5/6 LO Divider' : 'Direct Synthesizer'})`}
          />
          <div className="tuner-band-ticks" aria-hidden="true">
            <span className="band-tick" style={{ left: '5.1%' }}>DECT</span>
            <span className="band-tick band-tick-lo" style={{ left: '38.8%' }}>┆ 2210 LO</span>
            <span className="band-tick" style={{ left: '53.6%' }}>Ham 13cm</span>
            <span className="band-tick" style={{ left: '62.8%' }}>Wi-Fi / BLE</span>
            <span className="band-tick" style={{ left: '85.8%' }}>LTE B7</span>
          </div>
        </div>
      </div>

      {/* Collapsible Secondary Row: Advanced DSP, FFT, Detector & Sweep */}
      {showDsp && (
        <div className="sdr-secondary-row" role="region" aria-label="Advanced DSP Settings">
          <div className="control-group">
            <label htmlFor="sdr-fft">FFT</label>
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
            <label htmlFor="sdr-fps">Rate</label>
            <select
              id="sdr-fps"
              value={targetFps}
              onChange={(e) => onTargetFpsChange(Number(e.target.value))}
              disabled={!connected}
            >
              <option value={10}>10 FPS</option>
              <option value={20}>20 FPS</option>
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
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
                Mean
              </button>
              <button
                type="button"
                className={maxHoldDetector ? 'active' : ''}
                onClick={() => onMaxHoldDetectorChange(true)}
                disabled={!connected}
              >
                Peak
              </button>
            </div>
            <select
              aria-label="DSP Sub-windows"
              value={subWindows}
              onChange={(e) => onSubWindowsChange(Number(e.target.value))}
              disabled={!connected}
              title="Sub-windows accumulated per frame"
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
              title="Cancel LO leakage at DC center bin"
            >
              DC Notch
            </button>
            <button
              type="button"
              className={`toggle-chip ${spurBlanker ? 'active' : ''}`}
              onClick={() => onSpurBlankerChange(!spurBlanker)}
              title="Suppress single-bin clock spurs"
            >
              Spur Blanker
            </button>
            <button
              type="button"
              className={`toggle-chip ${sweepEnabled ? 'sweep-active' : ''}`}
              onClick={onToggleSweep}
              disabled={!connected}
              title="Automated 40 MHz multi-band sweep"
            >
              {sweepEnabled ? 'Sweep ON' : 'Sweep'}
            </button>
            <button
              type="button"
              className="toggle-chip"
              onClick={onClearPeakHold}
              title="Reset peak-hold envelope"
            >
              Reset Peak
            </button>
          </div>

          <div className="lo-status-wrap">
            <span className={`lo-badge ${isSub2210 ? 'lo-active' : 'lo-direct'}`}>
              {isSub2210 ? '5/6 LO Divider (1842–2209 MHz)' : 'Direct RFPLL (2210–2790 MHz)'}
            </span>
          </div>
        </div>
      )}
    </section>
  );
};
