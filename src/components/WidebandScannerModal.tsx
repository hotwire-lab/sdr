import React, { useCallback, useEffect, useRef, useState } from 'react';
import { applyDcSpikeNotch, binToFreqMhz } from '../dsp/sdrDsp';
import {
  SDR_MAX_FREQ_MHZ,
  SDR_MIN_FREQ_MHZ,
  SdrSpectrumFrame,
} from '../protocol/types';

export interface WidebandScannerModalProps {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  latestFrame: SdrSpectrumFrame | null;
  frameVersion: number;
  invertSpectrum: boolean;
  onRequestScanStep: (freqMhz: number) => void;
  onTuneAndInspect: (freqMhz: number) => void;
}

const TOTAL_SPAN_MHZ = SDR_MAX_FREQ_MHZ - SDR_MIN_FREQ_MHZ; // 948 MHz (1842..2790)
const BUCKET_RES_MHZ = 0.5;
const BUCKET_COUNT = Math.ceil(TOTAL_SPAN_MHZ / BUCKET_RES_MHZ); // 1896 buckets
const STEP_SPAN_MHZ = 40;

const SCAN_STEPS: number[] = (() => {
  const steps: number[] = [];
  for (let f = SDR_MIN_FREQ_MHZ + STEP_SPAN_MHZ / 2; f < SDR_MAX_FREQ_MHZ; f += STEP_SPAN_MHZ) {
    steps.push(Math.min(SDR_MAX_FREQ_MHZ - STEP_SPAN_MHZ / 2, f));
  }
  const lastTarget = SDR_MAX_FREQ_MHZ - STEP_SPAN_MHZ / 2;
  if (steps.length === 0 || steps[steps.length - 1] < lastTarget) {
    steps.push(lastTarget);
  }
  return steps;
})();

const SCANNER_BANDS = [
  { label: 'DECT EU', startMhz: 1880, endMhz: 1900, color: 'rgba(244, 114, 182, 0.16)' },
  { label: '5/6 LO', startMhz: 1842, endMhz: 2210, color: 'rgba(245, 158, 11, 0.05)' },
  { label: '13cm Ham', startMhz: 2320, endMhz: 2400, color: 'rgba(34, 197, 94, 0.14)' },
  { label: 'Wi-Fi / BLE', startMhz: 2400, endMhz: 2484, color: 'rgba(56, 189, 248, 0.16)' },
  { label: 'LTE B7 DL', startMhz: 2620, endMhz: 2690, color: 'rgba(251, 146, 60, 0.16)' },
];

const PAD_LEFT = 48;
const PAD_RIGHT = 14;
const PAD_TOP = 20;
const PAD_BOTTOM = 24;

export const WidebandScannerModal: React.FC<WidebandScannerModalProps> = ({
  open,
  onClose,
  connected,
  latestFrame,
  frameVersion,
  invertSpectrum,
  onRequestScanStep,
  onTuneAndInspect,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveBucketsRef = useRef<Float32Array>(new Float32Array(BUCKET_COUNT).fill(NaN));
  const peakBucketsRef = useRef<Float32Array>(new Float32Array(BUCKET_COUNT).fill(NaN));

  const [scanning, setScanning] = useState(false);
  const [scanStepIdx, setScanStepIdx] = useState(0);
  const [passCount, setPassCount] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    freqMhz: number;
    dbFs: number | null;
  } | null>(null);

  const scanningRef = useRef(scanning);
  scanningRef.current = scanning;
  const stepIdxRef = useRef(scanStepIdx);
  stepIdxRef.current = scanStepIdx;
  const awaitingCenterRef = useRef<number | null>(null);
  const lastStepAdvanceTsRef = useRef<number>(0);

  const clearScanData = useCallback(() => {
    liveBucketsRef.current.fill(NaN);
    peakBucketsRef.current.fill(NaN);
    setPassCount(0);
  }, []);

  // Auto-start scan when modal opens and device is connected
  useEffect(() => {
    if (open && connected) {
      setScanStepIdx(0);
      stepIdxRef.current = 0;
      setScanning(true);
      awaitingCenterRef.current = SCAN_STEPS[0];
      lastStepAdvanceTsRef.current = performance.now();
      onRequestScanStep(SCAN_STEPS[0]);
    } else if (!open) {
      setScanning(false);
      awaitingCenterRef.current = null;
    }
  }, [open, connected, onRequestScanStep]);

  // Watchdog to prevent scan stalling if a USB frame is dropped during retune
  useEffect(() => {
    if (!open || !scanning || !connected) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - lastStepAdvanceTsRef.current > 450) {
        const nextIdx = (stepIdxRef.current + 1) % SCAN_STEPS.length;
        if (nextIdx === 0) setPassCount((p) => p + 1);
        stepIdxRef.current = nextIdx;
        setScanStepIdx(nextIdx);
        awaitingCenterRef.current = SCAN_STEPS[nextIdx];
        lastStepAdvanceTsRef.current = now;
        onRequestScanStep(SCAN_STEPS[nextIdx]);
      }
    }, 150);
    return () => window.clearInterval(timer);
  }, [open, scanning, connected, onRequestScanStep]);

  // Stitch incoming 40 MHz spectrum frames into the 1.84-2.79 GHz wideband buffer
  useEffect(() => {
    if (!open || !scanning || !latestFrame || frameVersion === 0) return;
    const expected = awaitingCenterRef.current;
    if (expected === null || Math.abs(latestFrame.centerFreqMhz - expected) > 1.5) {
      return;
    }

    let bins = new Float32Array(latestFrame.powerDbFs);
    if (invertSpectrum) {
      bins.reverse();
    }
    // Suppress LO/DC center spike so 40 MHz steps stitch cleanly without artificial spikes
    bins = new Float32Array(applyDcSpikeNotch(bins));

    const n = bins.length;
    const live = liveBucketsRef.current;
    const peak = peakBucketsRef.current;
    const stepSeen = new Float32Array(BUCKET_COUNT).fill(-Infinity);

    for (let i = 0; i < n; i++) {
      const freq = binToFreqMhz(i, n, latestFrame.centerFreqMhz, latestFrame.spanMhz);
      if (freq < SDR_MIN_FREQ_MHZ || freq > SDR_MAX_FREQ_MHZ) continue;
      const b = Math.min(
        BUCKET_COUNT - 1,
        Math.max(0, Math.floor((freq - SDR_MIN_FREQ_MHZ) / BUCKET_RES_MHZ)),
      );
      if (bins[i] > stepSeen[b]) {
        stepSeen[b] = bins[i];
      }
    }

    for (let b = 0; b < BUCKET_COUNT; b++) {
      const val = stepSeen[b];
      if (val > -Infinity) {
        live[b] = val;
        peak[b] = Number.isNaN(peak[b]) ? val : Math.max(peak[b], val);
      }
    }

    const nextIdx = (stepIdxRef.current + 1) % SCAN_STEPS.length;
    if (nextIdx === 0) {
      setPassCount((p) => p + 1);
    }
    stepIdxRef.current = nextIdx;
    setScanStepIdx(nextIdx);
    awaitingCenterRef.current = SCAN_STEPS[nextIdx];
    lastStepAdvanceTsRef.current = performance.now();
    onRequestScanStep(SCAN_STEPS[nextIdx]);
  }, [open, scanning, latestFrame, frameVersion, invertSpectrum, onRequestScanStep]);

  // Draw wideband 1.84-2.79 GHz spectrum canvas
  const drawScanner = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !open) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, Math.floor(rect.width));
    const h = Math.max(160, Math.floor(rect.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);

    const plotW = Math.max(10, w - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(10, h - PAD_TOP - PAD_BOTTOM);
    const minDb = -115;
    const maxDb = -15;

    const freqToX = (f: number) =>
      PAD_LEFT + ((f - SDR_MIN_FREQ_MHZ) / TOTAL_SPAN_MHZ) * plotW;
    const dbToY = (db: number) => {
      const norm = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
      return PAD_TOP + (1 - norm) * plotH;
    };

    // 1. Band overlays
    for (const band of SCANNER_BANDS) {
      const x0 = Math.max(PAD_LEFT, freqToX(band.startMhz));
      const x1 = Math.min(PAD_LEFT + plotW, freqToX(band.endMhz));
      if (x1 <= x0) continue;
      ctx.fillStyle = band.color;
      ctx.fillRect(x0, PAD_TOP, x1 - x0, plotH);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(band.label, x0 + 4, PAD_TOP + 12);
    }

    // 2. Horizontal dBFS grid
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let db = -100; db <= -20; db += 20) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.55)';
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(PAD_LEFT + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.fillText(`${db}`, PAD_LEFT - 6, y + 3);
    }

    // 3. Vertical frequency grid (every 100 MHz: 1900..2700)
    ctx.textAlign = 'center';
    for (let f = 1900; f <= 2700; f += 100) {
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.strokeStyle = f === 2200 ? 'rgba(245, 158, 11, 0.3)' : 'rgba(51, 65, 85, 0.45)';
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, PAD_TOP + plotH);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${f}`, x, PAD_TOP + plotH + 15);
    }

    // 4. Stitched Peak-Hold & Live traces
    const drawBuckets = (
      arr: Float32Array,
      stroke: string,
      lineWidth: number,
      fillGrad: boolean,
      dashed: boolean,
    ) => {
      ctx.save();
      ctx.beginPath();
      let started = false;
      let firstX = PAD_LEFT;
      let lastX = PAD_LEFT;

      for (let b = 0; b < BUCKET_COUNT; b++) {
        const val = arr[b];
        if (Number.isNaN(val)) {
          started = false;
          continue;
        }
        const f = SDR_MIN_FREQ_MHZ + (b + 0.5) * BUCKET_RES_MHZ;
        const x = freqToX(f);
        const y = dbToY(val);
        if (!started) {
          ctx.moveTo(x, y);
          firstX = x;
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }

      if (dashed) ctx.setLineDash([4, 3]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      if (fillGrad && lastX > firstX) {
        ctx.setLineDash([]);
        ctx.lineTo(lastX, PAD_TOP + plotH);
        ctx.lineTo(firstX, PAD_TOP + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + plotH);
        grad.addColorStop(0, 'rgba(52, 211, 153, 0.25)');
        grad.addColorStop(1, 'rgba(52, 211, 153, 0.01)');
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    };

    drawBuckets(peakBucketsRef.current, 'rgba(251, 191, 36, 0.78)', 1.2, false, true);
    drawBuckets(liveBucketsRef.current, '#34d399', 1.5, true, false);

    // 5. Active Scan Position Line & 40 MHz capture window highlight
    const activeCenter = SCAN_STEPS[scanStepIdx] ?? SDR_MIN_FREQ_MHZ;
    const winX0 = Math.max(PAD_LEFT, freqToX(activeCenter - STEP_SPAN_MHZ / 2));
    const winX1 = Math.min(PAD_LEFT + plotW, freqToX(activeCenter + STEP_SPAN_MHZ / 2));
    const scanX = freqToX(activeCenter);

    if (scanning) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
      ctx.fillRect(winX0, PAD_TOP, Math.max(1, winX1 - winX0), plotH);
    }

    ctx.save();
    ctx.strokeStyle = scanning ? '#38bdf8' : 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scanX, PAD_TOP);
    ctx.lineTo(scanX, PAD_TOP + plotH);
    ctx.stroke();

    // Scan cursor badge
    const tag = `${activeCenter} MHz`;
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(tag).width + 10;
    const bx = Math.min(PAD_LEFT + plotW - tw - 2, Math.max(PAD_LEFT + 2, scanX - tw / 2));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(bx, PAD_TOP + 2, tw, 16);
    ctx.strokeStyle = scanning ? '#38bdf8' : '#64748b';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, PAD_TOP + 2, tw, 16);
    ctx.fillStyle = scanning ? '#38bdf8' : '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.fillText(tag, bx + 5, PAD_TOP + 13);
    ctx.restore();

    // 6. Hover crosshair
    if (hoverInfo && hoverInfo.x >= PAD_LEFT && hoverInfo.x <= PAD_LEFT + plotW) {
      ctx.save();
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hoverInfo.x, PAD_TOP);
      ctx.lineTo(hoverInfo.x, PAD_TOP + plotH);
      ctx.stroke();
      ctx.restore();
    }

    // Border
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD_LEFT, PAD_TOP, plotW, plotH);
    ctx.restore();
  }, [open, scanning, scanStepIdx, hoverInfo]);

  useEffect(() => {
    drawScanner();
  }, [drawScanner, frameVersion, scanStepIdx]);

  useEffect(() => {
    if (!open || typeof ResizeObserver === 'undefined' || !canvasRef.current) return;
    const obs = new ResizeObserver(() => drawScanner());
    obs.observe(canvasRef.current);
    return () => obs.disconnect();
  }, [open, drawScanner]);

  if (!open) return null;

  const clientXToFreq = (clientX: number, rect: DOMRect): number => {
    const plotW = Math.max(10, rect.width - PAD_LEFT - PAD_RIGHT);
    const rel = Math.max(0, Math.min(1, (clientX - rect.left - PAD_LEFT) / plotW));
    return SDR_MIN_FREQ_MHZ + rel * TOTAL_SPAN_MHZ;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const freqMhz = clientXToFreq(e.clientX, rect);
    const b = Math.min(
      BUCKET_COUNT - 1,
      Math.max(0, Math.floor((freqMhz - SDR_MIN_FREQ_MHZ) / BUCKET_RES_MHZ)),
    );
    const peakVal = peakBucketsRef.current[b];
    const liveVal = liveBucketsRef.current[b];
    const db = !Number.isNaN(liveVal) ? liveVal : !Number.isNaN(peakVal) ? peakVal : null;
    setHoverInfo({ x: e.clientX - rect.left, freqMhz, dbFs: db });
  };

  const handleCanvasClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const freqMhz = Math.round(clientXToFreq(e.clientX, rect));
    setScanning(false);
    onTuneAndInspect(freqMhz);
  };

  const activeScanFreq = SCAN_STEPS[scanStepIdx] ?? SDR_MIN_FREQ_MHZ;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Wideband RF Scanner">
      <div className="modal-card scanner-modal-card">
        <div className="modal-header">
          <div>
            <h3>Wideband Scanner (1.84–2.79 GHz)</h3>
            <span className="modal-subtitle">
              {scanning
                ? `Scanning ${activeScanFreq} MHz (${scanStepIdx + 1}/${SCAN_STEPS.length}) • Pass #${passCount + 1}`
                : `Paused at ${activeScanFreq} MHz • Click spectrum to tune`}
              {hoverInfo &&
                ` • ⊕ ${hoverInfo.freqMhz.toFixed(1)} MHz${
                  hoverInfo.dbFs !== null ? ` (${hoverInfo.dbFs.toFixed(1)} dBFS)` : ''
                }`}
            </span>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className={`btn btn-compact ${scanning ? 'btn-danger' : 'btn-accent'}`}
              disabled={!connected}
              onClick={() => {
                if (scanning) {
                  setScanning(false);
                } else {
                  setScanning(true);
                  awaitingCenterRef.current = SCAN_STEPS[stepIdxRef.current];
                  lastStepAdvanceTsRef.current = performance.now();
                  onRequestScanStep(SCAN_STEPS[stepIdxRef.current]);
                }
              }}
            >
              {scanning ? 'Pause Scan' : 'Start Scan'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={clearScanData}
            >
              Clear Peak
            </button>
            <button type="button" className="btn btn-ghost btn-compact" onClick={onClose}>
              ✕ Close
            </button>
          </div>
        </div>

        <div className="scanner-body">
          <canvas
            ref={canvasRef}
            className="scanner-canvas"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverInfo(null)}
            onPointerDown={handleCanvasClick}
            title="Click any frequency to tune main analyzer"
          />
          <div className="scanner-legend">
            <span>
              <i className="dot-live" /> Live Sweep
            </span>
            <span>
              <i className="dot-peak" /> Peak-Hold (Burst Traffic)
            </span>
            <span>
              <i className="dot-cursor" /> Active Scan Window (40 MHz)
            </span>
            <span className="scanner-hint">Click anywhere on the graph to tune &amp; inspect</span>
          </div>
        </div>
      </div>
    </div>
  );
};
