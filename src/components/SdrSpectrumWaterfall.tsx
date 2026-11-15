import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  binToFreqMhz,
  COLORMAP_LUTS,
  ColormapId,
  freqMhzToBin,
  mapDbToLutIndex,
  SpectrumTraceState,
} from '../dsp/sdrDsp';

export interface SdrSpectrumWaterfallProps {
  trace: SpectrumTraceState | null;
  centerFreqMhz: number;
  spanMhz: number;
  fps: number;
  streaming: boolean;
  frameVersion: number;
}

interface MarkerState {
  freqMhz: number;
  active: boolean;
}

const BAND_OVERLAYS = [
  { label: 'DECT EU', startMhz: 1880, endMhz: 1900, color: 'rgba(244, 114, 182, 0.16)' },
  { label: '13cm Ham', startMhz: 2320, endMhz: 2400, color: 'rgba(34, 197, 94, 0.12)' },
  { label: 'BLE 37', startMhz: 2401, endMhz: 2403, color: 'rgba(167, 139, 250, 0.22)' },
  { label: 'Wi-Fi Ch 1', startMhz: 2402, endMhz: 2422, color: 'rgba(56, 189, 248, 0.14)' },
  { label: 'BLE 38', startMhz: 2425, endMhz: 2427, color: 'rgba(167, 139, 250, 0.22)' },
  { label: 'Wi-Fi Ch 6', startMhz: 2427, endMhz: 2447, color: 'rgba(52, 211, 153, 0.14)' },
  { label: 'Wi-Fi Ch 11', startMhz: 2452, endMhz: 2472, color: 'rgba(251, 191, 36, 0.14)' },
  { label: 'Wi-Fi Ch 13', startMhz: 2462, endMhz: 2482, color: 'rgba(249, 115, 22, 0.14)' },
  { label: 'BLE 39', startMhz: 2479, endMhz: 2481, color: 'rgba(167, 139, 250, 0.22)' },
  { label: 'LTE B7 DL', startMhz: 2620, endMhz: 2690, color: 'rgba(251, 146, 60, 0.14)' },
];

const PLOT_PAD_LEFT = 54;
const PLOT_PAD_RIGHT = 16;
const PLOT_PAD_TOP = 18;
const PLOT_PAD_BOTTOM = 24;

export const SdrSpectrumWaterfall: React.FC<SdrSpectrumWaterfallProps> = ({
  trace,
  centerFreqMhz,
  spanMhz,
  fps,
  streaming,
  frameVersion,
}) => {
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waterfallOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [colormap, setColormap] = useState<ColormapId>('turbo');
  const [minDbFs, setMinDbFs] = useState(-115);
  const [maxDbFs, setMaxDbFs] = useState(-15);
  const [showBandOverlays, setShowBandOverlays] = useState(true);
  const [waterfallPaused, setWaterfallPaused] = useState(false);

  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    freqMhz: number;
    dbFs: number;
  } | null>(null);

  const [m1, setM1] = useState<MarkerState>({ freqMhz: 2437, active: false });
  const [m2, setM2] = useState<MarkerState>({ freqMhz: 2447, active: false });
  const draggingMarkerRef = useRef<'m1' | 'm2' | null>(null);

  // Maintain rolling offscreen waterfall bitmap (512x256 logical pixels)
  const WF_WIDTH = 512;
  const WF_HEIGHT = 240;

  const ensureOffscreen = useCallback(() => {
    if (!waterfallOffscreenRef.current) {
      const c = document.createElement('canvas');
      c.width = WF_WIDTH;
      c.height = WF_HEIGHT;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
      }
      waterfallOffscreenRef.current = c;
    }
    return waterfallOffscreenRef.current;
  }, []);

  const clearWaterfall = useCallback(() => {
    const c = ensureOffscreen();
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, WF_WIDTH, WF_HEIGHT);
    }
  }, [ensureOffscreen]);

  // Append one new waterfall line per received spectrum frame
  useEffect(() => {
    if (!trace || waterfallPaused || frameVersion === 0) return;

    const offscreen = ensureOffscreen();
    const ctx = offscreen.getContext('2d');
    if (!ctx) return;

    // Scroll existing waterfall down by 1 pixel
    ctx.drawImage(offscreen, 0, 0, WF_WIDTH, WF_HEIGHT - 1, 0, 1, WF_WIDTH, WF_HEIGHT - 1);

    const row = ctx.createImageData(WF_WIDTH, 1);
    const data = row.data;
    const lut = COLORMAP_LUTS[colormap];
    const bins = trace.liveDbFs;
    const nBins = bins.length;

    for (let x = 0; x < WF_WIDTH; x++) {
      // Sample max across bin stride so thin peaks stay crisp when downsampling 2048 -> 512
      const binStart = Math.floor((x / WF_WIDTH) * nBins);
      const binEnd = Math.max(binStart + 1, Math.floor(((x + 1) / WF_WIDTH) * nBins));
      let peakVal = -130;
      for (let b = binStart; b < binEnd && b < nBins; b++) {
        if (bins[b] > peakVal) peakVal = bins[b];
      }
      const lutIdx = mapDbToLutIndex(peakVal, minDbFs, maxDbFs) * 4;
      const p = x * 4;
      data[p] = lut[lutIdx];
      data[p + 1] = lut[lutIdx + 1];
      data[p + 2] = lut[lutIdx + 2];
      data[p + 3] = 255;
    }
    ctx.putImageData(row, 0, 0);
  }, [frameVersion, trace, colormap, minDbFs, maxDbFs, waterfallPaused, ensureOffscreen]);

  const sampleTraceAtFreq = useCallback(
    (freqMhz: number): number | null => {
      if (!trace) return null;
      const binFloat = freqMhzToBin(
        freqMhz,
        trace.fftBins,
        trace.centerFreqMhz,
        trace.spanMhz,
      );
      const idx = Math.max(0, Math.min(trace.fftBins - 1, Math.round(binFloat)));
      return trace.liveDbFs[idx];
    },
    [trace],
  );

  // Render Spectrum & Waterfall High-DPI canvases
  const drawCanvases = useCallback(() => {
    const activeCenter = trace?.centerFreqMhz ?? centerFreqMhz;
    const activeSpan = trace?.spanMhz ?? spanMhz;
    const startFreq = activeCenter - activeSpan / 2;
    const endFreq = activeCenter + activeSpan / 2;

    // 1. Spectrum Canvas
    const specCanvas = spectrumCanvasRef.current;
    if (specCanvas) {
      const rect = specCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(100, Math.floor(rect.width));
      const h = Math.max(80, Math.floor(rect.height));
      if (specCanvas.width !== Math.floor(w * dpr) || specCanvas.height !== Math.floor(h * dpr)) {
        specCanvas.width = Math.floor(w * dpr);
        specCanvas.height = Math.floor(h * dpr);
      }

      const ctx = specCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, w, h);

        const plotW = Math.max(10, w - PLOT_PAD_LEFT - PLOT_PAD_RIGHT);
        const plotH = Math.max(10, h - PLOT_PAD_TOP - PLOT_PAD_BOTTOM);
        const freqToX = (f: number) => PLOT_PAD_LEFT + ((f - startFreq) / activeSpan) * plotW;
        const dbToY = (db: number) => {
          const norm = Math.max(0, Math.min(1, (db - minDbFs) / Math.max(1, maxDbFs - minDbFs)));
          return PLOT_PAD_TOP + (1 - norm) * plotH;
        };

        // Band overlays
        if (showBandOverlays) {
          for (const overlay of BAND_OVERLAYS) {
            if (overlay.endMhz < startFreq || overlay.startMhz > endFreq) continue;
            const x0 = Math.max(PLOT_PAD_LEFT, freqToX(overlay.startMhz));
            const x1 = Math.min(PLOT_PAD_LEFT + plotW, freqToX(overlay.endMhz));
            if (x1 <= x0) continue;
            ctx.fillStyle = overlay.color;
            ctx.fillRect(x0, PLOT_PAD_TOP, x1 - x0, plotH);
            ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillText(overlay.label, x0 + 4, PLOT_PAD_TOP + 12);
          }
        }

        // Horizontal dBFS Grid
        ctx.lineWidth = 1;
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        const dbStep = maxDbFs - minDbFs > 75 ? 20 : 10;
        const firstDb = Math.ceil(minDbFs / dbStep) * dbStep;
        for (let db = firstDb; db <= maxDbFs; db += dbStep) {
          const y = Math.round(dbToY(db)) + 0.5;
          ctx.strokeStyle = 'rgba(51, 65, 85, 0.55)';
          ctx.beginPath();
          ctx.moveTo(PLOT_PAD_LEFT, y);
          ctx.lineTo(PLOT_PAD_LEFT + plotW, y);
          ctx.stroke();

          ctx.fillStyle = '#94a3b8';
          ctx.textAlign = 'right';
          ctx.fillText(`${db}`, PLOT_PAD_LEFT - 6, y + 3);
        }

        // Vertical Frequency Grid
        const freqSteps = 8;
        ctx.textAlign = 'center';
        for (let k = 0; k <= freqSteps; k++) {
          const f = startFreq + (k / freqSteps) * activeSpan;
          const x = Math.round(freqToX(f)) + 0.5;
          ctx.strokeStyle =
            k === freqSteps / 2 ? 'rgba(56, 189, 248, 0.35)' : 'rgba(51, 65, 85, 0.45)';
          ctx.beginPath();
          ctx.moveTo(x, PLOT_PAD_TOP);
          ctx.lineTo(x, PLOT_PAD_TOP + plotH);
          ctx.stroke();

          ctx.fillStyle = k === freqSteps / 2 ? '#38bdf8' : '#94a3b8';
          ctx.fillText(`${f.toFixed(1)}`, x, PLOT_PAD_TOP + plotH + 15);
        }

        // Traces
        if (trace) {
          const drawTrace = (
            arr: Float32Array,
            stroke: string,
            lineWidth: number,
            fillGradient = false,
            dashed = false,
          ) => {
            ctx.save();
            ctx.beginPath();
            for (let i = 0; i < arr.length; i++) {
              const freq = binToFreqMhz(i, arr.length, activeCenter, activeSpan);
              const x = freqToX(freq);
              const y = dbToY(arr[i]);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            if (dashed) ctx.setLineDash([4, 3]);
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineWidth;
            ctx.stroke();

            if (fillGradient && arr.length > 0) {
              const lastFreq = binToFreqMhz(arr.length - 1, arr.length, activeCenter, activeSpan);
              const lastX = freqToX(lastFreq);
              ctx.lineTo(lastX, PLOT_PAD_TOP + plotH);
              ctx.lineTo(PLOT_PAD_LEFT, PLOT_PAD_TOP + plotH);
              ctx.closePath();
              const grad = ctx.createLinearGradient(0, PLOT_PAD_TOP, 0, PLOT_PAD_TOP + plotH);
              grad.addColorStop(0, 'rgba(52, 211, 153, 0.28)');
              grad.addColorStop(1, 'rgba(52, 211, 153, 0.01)');
              ctx.fillStyle = grad;
              ctx.fill();
            }
            ctx.restore();
          };

          drawTrace(trace.peakHoldDbFs, 'rgba(251, 191, 36, 0.72)', 1.25, false, true);
          drawTrace(trace.avgDbFs, 'rgba(56, 189, 248, 0.85)', 1.35, false, false);
          drawTrace(trace.liveDbFs, '#34d399', 1.6, true, false);
        }

        // Markers M1 & M2
        const drawMarker = (mk: MarkerState, tag: string, color: string) => {
          if (!mk.active || mk.freqMhz < startFreq || mk.freqMhz > endFreq) return;
          const x = freqToX(mk.freqMhz);
          const db = sampleTraceAtFreq(mk.freqMhz);
          const y = db !== null ? dbToY(db) : PLOT_PAD_TOP + 20;

          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, PLOT_PAD_TOP);
          ctx.lineTo(x, PLOT_PAD_TOP + plotH);
          ctx.stroke();

          // Diamond handle
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x, y - 6);
          ctx.lineTo(x + 6, y);
          ctx.lineTo(x, y + 6);
          ctx.lineTo(x - 6, y);
          ctx.closePath();
          ctx.fill();

          const labelText = `${tag} ${mk.freqMhz.toFixed(2)} MHz${
            db !== null ? ` (${db.toFixed(1)} dBFS)` : ''
          }`;
          const tw = ctx.measureText(labelText).width + 10;
          const bx = Math.min(PLOT_PAD_LEFT + plotW - tw - 2, Math.max(PLOT_PAD_LEFT + 2, x - tw / 2));
          ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          ctx.fillRect(bx, PLOT_PAD_TOP + 2, tw, 16);
          ctx.strokeStyle = color;
          ctx.strokeRect(bx, PLOT_PAD_TOP + 2, tw, 16);
          ctx.fillStyle = color;
          ctx.textAlign = 'left';
          ctx.fillText(labelText, bx + 5, PLOT_PAD_TOP + 13);
          ctx.restore();
        };

        drawMarker(m1, 'M1', '#fbbf24');
        drawMarker(m2, 'M2', '#f472b6');

        // Crosshair
        if (hoverInfo && hoverInfo.x >= PLOT_PAD_LEFT && hoverInfo.x <= PLOT_PAD_LEFT + plotW) {
          ctx.save();
          ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hoverInfo.x, PLOT_PAD_TOP);
          ctx.lineTo(hoverInfo.x, PLOT_PAD_TOP + plotH);
          ctx.moveTo(PLOT_PAD_LEFT, hoverInfo.y);
          ctx.lineTo(PLOT_PAD_LEFT + plotW, hoverInfo.y);
          ctx.stroke();
          ctx.restore();
        }

        // Border frame
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.strokeRect(PLOT_PAD_LEFT, PLOT_PAD_TOP, plotW, plotH);
        ctx.restore();
      }
    }

    // 2. Waterfall Canvas (exact matching horizontal plot area)
    const wfCanvas = waterfallCanvasRef.current;
    if (wfCanvas) {
      const rect = wfCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(100, Math.floor(rect.width));
      const h = Math.max(80, Math.floor(rect.height));
      if (wfCanvas.width !== Math.floor(w * dpr) || wfCanvas.height !== Math.floor(h * dpr)) {
        wfCanvas.width = Math.floor(w * dpr);
        wfCanvas.height = Math.floor(h * dpr);
      }

      const ctx = wfCanvas.getContext('2d');
      if (ctx) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#020617';
        ctx.fillRect(0, 0, w, h);

        const plotW = Math.max(10, w - PLOT_PAD_LEFT - PLOT_PAD_RIGHT);
        const plotH = Math.max(10, h - 10);
        const offscreen = ensureOffscreen();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offscreen, 0, 0, WF_WIDTH, WF_HEIGHT, PLOT_PAD_LEFT, 2, plotW, plotH);

        // Draw colormap legend bar in left gutter
        const lut = COLORMAP_LUTS[colormap];
        const barX = 14;
        const barW = 12;
        const barY = 12;
        const barH = Math.max(40, plotH - 24);
        for (let py = 0; py < barH; py++) {
          const idx = Math.round((1 - py / Math.max(1, barH - 1)) * 255) * 4;
          ctx.fillStyle = `rgb(${lut[idx]}, ${lut[idx + 1]}, ${lut[idx + 2]})`;
          ctx.fillRect(barX, barY + py, barW, 1);
        }
        ctx.strokeStyle = '#475569';
        ctx.strokeRect(barX, barY, barW, barH);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${maxDbFs}`, barX + barW + 4, barY + 7);
        ctx.fillText(`${minDbFs}`, barX + barW + 4, barY + barH);

        // Border frame
        ctx.strokeStyle = '#334155';
        ctx.strokeRect(PLOT_PAD_LEFT, 2, plotW, plotH);
        ctx.restore();
      }
    }
  }, [
    trace,
    centerFreqMhz,
    spanMhz,
    minDbFs,
    maxDbFs,
    showBandOverlays,
    m1,
    m2,
    hoverInfo,
    colormap,
    ensureOffscreen,
    sampleTraceAtFreq,
  ]);

  useEffect(() => {
    drawCanvases();
  }, [drawCanvases, frameVersion]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(() => drawCanvases());
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [drawCanvases]);

  const clientXToFreqMhz = (clientX: number, rect: DOMRect): number => {
    const activeCenter = trace?.centerFreqMhz ?? centerFreqMhz;
    const activeSpan = trace?.spanMhz ?? spanMhz;
    const plotW = Math.max(10, rect.width - PLOT_PAD_LEFT - PLOT_PAD_RIGHT);
    const rel = Math.max(0, Math.min(1, (clientX - rect.left - PLOT_PAD_LEFT) / plotW));
    return activeCenter - activeSpan / 2 + rel * activeSpan;
  };

  const handleSpectrumPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickFreq = clientXToFreqMhz(e.clientX, rect);
    const activeSpan = trace?.spanMhz ?? spanMhz;
    const hitTolerance = activeSpan * 0.02;

    if (m1.active && Math.abs(clickFreq - m1.freqMhz) < hitTolerance) {
      draggingMarkerRef.current = 'm1';
    } else if (m2.active && Math.abs(clickFreq - m2.freqMhz) < hitTolerance) {
      draggingMarkerRef.current = 'm2';
    } else if (e.shiftKey || (m1.active && !m2.active && e.button === 2)) {
      setM2({ freqMhz: clickFreq, active: true });
      draggingMarkerRef.current = 'm2';
    } else {
      setM1({ freqMhz: clickFreq, active: true });
      draggingMarkerRef.current = 'm1';
    }
    canvas.setPointerCapture(e.pointerId);
  };

  const handleSpectrumPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = spectrumCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const freqMhz = clientXToFreqMhz(e.clientX, rect);

    if (draggingMarkerRef.current === 'm1') {
      setM1({ freqMhz, active: true });
    } else if (draggingMarkerRef.current === 'm2') {
      setM2({ freqMhz, active: true });
    }

    const db = sampleTraceAtFreq(freqMhz);
    const plotH = Math.max(10, rect.height - PLOT_PAD_TOP - PLOT_PAD_BOTTOM);
    const relY = Math.max(0, Math.min(1, 1 - (y - PLOT_PAD_TOP) / plotH));
    const cursorDb = minDbFs + relY * (maxDbFs - minDbFs);

    setHoverInfo({
      x,
      y,
      freqMhz,
      dbFs: db ?? cursorDb,
    });
  };

  const handleSpectrumPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    draggingMarkerRef.current = null;
    spectrumCanvasRef.current?.releasePointerCapture(e.pointerId);
  };

  const rbwKhz = trace ? (trace.spanMhz * 1000) / trace.fftBins : (spanMhz * 1000) / 1024;
  const m1Db = m1.active ? sampleTraceAtFreq(m1.freqMhz) : null;
  const m2Db = m2.active ? sampleTraceAtFreq(m2.freqMhz) : null;

  return (
    <div className="sdr-visualizer" ref={containerRef}>
      <div className="sdr-hud-bar">
        <div className="hud-metrics">
          <span className="hud-item">
            <strong>Center:</strong> {(trace?.centerFreqMhz ?? centerFreqMhz).toFixed(1)} MHz
          </span>
          <span className="hud-item">
            <strong>Span:</strong> {trace?.spanMhz ?? spanMhz} MHz
          </span>
          <span className="hud-item">
            <strong>RBW:</strong> {rbwKhz.toFixed(1)} kHz
          </span>
          {trace && (
            <>
              <span className="hud-item">
                <strong>Peak:</strong> {trace.stats.peakFreqMhz.toFixed(2)} MHz ({trace.stats.peakDbFs.toFixed(1)} dBFS)
              </span>
              <span className="hud-item">
                <strong>Noise:</strong> {trace.stats.noiseFloorDbFs.toFixed(1)} dBFS
              </span>
              <span className="hud-item">
                <strong>SNR:</strong> {trace.stats.snrDb.toFixed(1)} dB
              </span>
            </>
          )}
          <span className={`hud-fps ${streaming ? 'live' : ''}`}>
            {streaming ? `${fps.toFixed(1)} FPS` : 'PAUSED'}
          </span>
          {m1.active && m2.active && m1Db !== null && m2Db !== null && (
            <span className="hud-delta">
              ΔM2-M1: {(m2.freqMhz - m1.freqMhz).toFixed(2)} MHz | {(m2Db - m1Db).toFixed(1)} dB
            </span>
          )}
          {hoverInfo && (
            <span className="hover-readout">
              ⊕ {hoverInfo.freqMhz.toFixed(2)} MHz ({hoverInfo.dbFs.toFixed(1)} dBFS)
            </span>
          )}
        </div>

        <div className="hud-controls">
          <button
            type="button"
            className={`btn-mini ${showBandOverlays ? 'active' : ''}`}
            onClick={() => setShowBandOverlays((v) => !v)}
            title="Toggle Wi-Fi and BLE band overlay guides"
          >
            Bands
          </button>
          <button
            type="button"
            className={`btn-mini ${m1.active ? 'active' : ''}`}
            onClick={() => setM1((prev) => ({ freqMhz: trace?.centerFreqMhz ?? centerFreqMhz, active: !prev.active }))}
            title="Toggle Marker 1 (click/drag on spectrum)"
          >
            M1
          </button>
          <button
            type="button"
            className={`btn-mini ${m2.active ? 'active' : ''}`}
            onClick={() => setM2((prev) => ({ freqMhz: (trace?.centerFreqMhz ?? centerFreqMhz) + 10, active: !prev.active }))}
            title="Toggle Marker 2 (click/drag on spectrum)"
          >
            M2
          </button>
        </div>
      </div>

      <div className="sdr-canvas-stack">
        <div className="spectrum-pane">
          <canvas
            ref={spectrumCanvasRef}
            className="spectrum-canvas"
            onPointerDown={handleSpectrumPointerDown}
            onPointerMove={handleSpectrumPointerMove}
            onPointerUp={handleSpectrumPointerUp}
            onPointerLeave={() => setHoverInfo(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              setM2({ freqMhz: clientXToFreqMhz(e.clientX, rect), active: true });
            }}
          />
          {!trace && (
            <div className="sdr-empty-overlay">
              <p>Connect XIAO ESP32-S3 or click Demo, then press Start RF.</p>
            </div>
          )}
        </div>

        <div className="waterfall-toolbar">
          <div className="wf-group">
            <label htmlFor="wf-lut">Palette</label>
            <select
              id="wf-lut"
              value={colormap}
              onChange={(e) => setColormap(e.target.value as ColormapId)}
            >
              <option value="turbo">Turbo</option>
              <option value="viridis">Viridis</option>
              <option value="inferno">Inferno</option>
            </select>
          </div>
          <div className="wf-group">
            <label htmlFor="wf-min">Min {minDbFs} dB</label>
            <input
              id="wf-min"
              type="range"
              min={-125}
              max={maxDbFs - 10}
              step={1}
              value={minDbFs}
              onChange={(e) => setMinDbFs(Number(e.target.value))}
            />
          </div>
          <div className="wf-group">
            <label htmlFor="wf-max">Max {maxDbFs} dB</label>
            <input
              id="wf-max"
              type="range"
              min={minDbFs + 10}
              max={0}
              step={1}
              value={maxDbFs}
              onChange={(e) => setMaxDbFs(Number(e.target.value))}
            />
          </div>
          <div className="wf-spacer" />
          <div className="wf-actions">
            <button
              type="button"
              className={`btn-mini btn-pause ${waterfallPaused ? 'active' : ''}`}
              onClick={() => setWaterfallPaused((p) => !p)}
              title={waterfallPaused ? 'Resume waterfall roll' : 'Pause waterfall roll'}
            >
              {waterfallPaused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="btn-mini btn-clear"
              onClick={clearWaterfall}
              title="Clear waterfall display"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="waterfall-pane">
          <canvas ref={waterfallCanvasRef} className="waterfall-canvas" />
        </div>
      </div>
    </div>
  );
};
