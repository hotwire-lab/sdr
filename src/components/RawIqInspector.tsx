import React, { useEffect, useRef, useState } from 'react';
import { SdrRawIqFrame } from '../protocol/types';

export interface RawIqInspectorProps {
  open: boolean;
  onClose: () => void;
  frame: SdrRawIqFrame | null;
  iqKb: number;
  onIqKbChange: (kb: number) => void;
  streamingContIq: boolean;
  onRequestSingleShot: () => void;
  onToggleContIq: () => void;
}

export const RawIqInspector: React.FC<RawIqInspectorProps> = ({
  open,
  onClose,
  frame,
  iqKb,
  onIqKbChange,
  streamingContIq,
  onRequestSingleShot,
  onToggleContIq,
}) => {
  const timeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const constCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewWindow, setViewWindow] = useState(512);

  useEffect(() => {
    if (!open) return;

    // 1. Time-Domain Canvas (I, Q, Envelope)
    const tCanvas = timeCanvasRef.current;
    if (tCanvas) {
      const rect = tCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(120, Math.floor(rect.height));
      tCanvas.width = Math.floor(w * dpr);
      tCanvas.height = Math.floor(h * dpr);

      const ctx = tCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, w, h);

        // Grid center lines
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        if (frame) {
          const count = Math.min(frame.sampleCount, viewWindow);
          const midY = h / 2;
          const ampScale = (h * 0.44) / 128;

          const drawSeries = (getter: (idx: number) => number, color: string, lw = 1.4) => {
            ctx.beginPath();
            for (let i = 0; i < count; i++) {
              const x = (i / Math.max(1, count - 1)) * w;
              const y = midY - getter(i) * ampScale;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.stroke();
          };

          drawSeries((i) => Math.hypot(frame.iSamples[i], frame.qSamples[i]), 'rgba(251, 191, 36, 0.45)', 1.0);
          drawSeries((i) => frame.iSamples[i], '#38bdf8', 1.4);
          drawSeries((i) => frame.qSamples[i], '#f472b6', 1.4);
        }
        ctx.restore();
      }
    }

    // 2. Constellation Scatter Plot (I vs Q)
    const cCanvas = constCanvasRef.current;
    if (cCanvas) {
      const rect = cCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(120, Math.floor(rect.height));
      cCanvas.width = Math.floor(w * dpr);
      cCanvas.height = Math.floor(h * dpr);

      const ctx = cCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.min(w, h) * 0.44;

        ctx.strokeStyle = 'rgba(51, 65, 85, 0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(w, cy);
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();

        // Reference unit rings
        for (const frac of [0.5, 1.0]) {
          ctx.beginPath();
          ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
          ctx.stroke();
        }

        if (frame) {
          const step = Math.max(1, Math.floor(frame.sampleCount / 1600));
          for (let i = 0; i < frame.sampleCount; i += step) {
            const x = cx + (frame.iSamples[i] / 128) * radius;
            const y = cy - (frame.qSamples[i] / 128) * radius;
            const clipped = Math.abs(frame.iSamples[i]) >= 126 || Math.abs(frame.qSamples[i]) >= 126;
            ctx.fillStyle = clipped
              ? 'rgba(248, 113, 113, 0.85)'
              : 'rgba(52, 211, 153, 0.65)';
            ctx.fillRect(x - 1, y - 1, 2.5, 2.5);
          }
        }
        ctx.restore();
      }
    }
  }, [open, frame, viewWindow]);

  if (!open) return null;

  let dcI = 0;
  let dcQ = 0;
  let rmsMag = 0;
  if (frame && frame.sampleCount > 0) {
    let sumSq = 0;
    for (let i = 0; i < frame.sampleCount; i++) {
      dcI += frame.iSamples[i];
      dcQ += frame.qSamples[i];
      sumSq += frame.iSamples[i] * frame.iSamples[i] + frame.qSamples[i] * frame.qSamples[i];
    }
    dcI /= frame.sampleCount;
    dcQ /= frame.sampleCount;
    rmsMag = Math.sqrt(sumSq / frame.sampleCount);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Raw I/Q Inspector">
      <div className="iq-modal">
        <div className="iq-modal-header">
          <div>
            <h3>Raw Baseband I/Q Inspector (0x85)</h3>
            <p className="iq-subtitle">
              Inspect unwrapped 8-bit signed I/Q streams, constellation rings, and ADC clipping rails
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-compact" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="iq-controls">
          <div className="control-group">
            <label htmlFor="iq-depth">Samples</label>
            <select
              id="iq-depth"
              value={iqKb}
              onChange={(e) => onIqKbChange(Number(e.target.value))}
            >
              <option value={1}>1,024</option>
              <option value={2}>2,048</option>
              <option value={4}>4,096</option>
              <option value={8}>8,192</option>
            </select>
          </div>

          <div className="control-group">
            <label htmlFor="iq-window">Time Window</label>
            <select
              id="iq-window"
              value={viewWindow}
              onChange={(e) => setViewWindow(Number(e.target.value))}
            >
              <option value={128}>128 samples</option>
              <option value={256}>256 samples</option>
              <option value={512}>512 samples</option>
              <option value={1024}>1,024 samples</option>
            </select>
          </div>

          <button type="button" className="btn btn-primary btn-compact" onClick={onRequestSingleShot}>
            Capture Snapshot
          </button>
          <button
            type="button"
            className={`btn btn-compact ${streamingContIq ? 'btn-danger' : 'btn-accent'}`}
            onClick={onToggleContIq}
          >
            {streamingContIq ? 'Stop Cont I/Q' : 'Stream Cont I/Q'}
          </button>

          {frame && (
            <div className="iq-metrics">
              <span>{frame.centerFreqMhz} MHz</span>
              <span>Gain {frame.activeGainIndex}</span>
              <span>RMS {rmsMag.toFixed(1)}</span>
              <span>DC ({dcI.toFixed(1)}, {dcQ.toFixed(1)})</span>
              {frame.adcClip && <span className="clip-alert-badge">CLIP</span>}
            </div>
          )}
        </div>

        <div className="iq-canvas-grid">
          <div className="iq-card">
            <div className="iq-card-head">
              <span>Time Domain: I(t) / Q(t) / Envelope</span>
              <span className="iq-legend">
                <i style={{ color: '#38bdf8' }}>■ I</i>{' '}
                <i style={{ color: '#f472b6' }}>■ Q</i>{' '}
                <i style={{ color: '#fbbf24' }}>■ |z|</i>
              </span>
            </div>
            <canvas ref={timeCanvasRef} className="iq-canvas" />
          </div>

          <div className="iq-card">
            <div className="iq-card-head">
              <span>2D I/Q Constellation</span>
              <span className="iq-legend">
                <i style={{ color: '#34d399' }}>● Normal</i>{' '}
                <i style={{ color: '#f87171' }}>● Clipped</i>
              </span>
            </div>
            <canvas ref={constCanvasRef} className="iq-canvas" />
          </div>
        </div>
      </div>
    </div>
  );
};
