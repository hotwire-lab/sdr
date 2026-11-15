import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DecodedFrameAnnotation,
  PulseMeasurement,
  countChannelEdges,
  findNearestEdge,
  measurePulseAtSample,
} from '../protocol/decoders';
import {
  formatDuration,
  formatFrequency,
  formatSignedDuration,
} from '../protocol/timeFormat';
import { CHANNELS, CaptureDataFrame } from '../protocol/types';

const MINIMAP_HEIGHT = 20;
const RULER_HEIGHT = 26;
const TOP_HEIGHT = MINIMAP_HEIGHT + RULER_HEIGHT;
const MINIMAP_BINS = 512;

export interface WaveformCanvasProps {
  capture: CaptureDataFrame | null;
  capturing: boolean;
  decodedFrames?: DecodedFrameAnnotation[];
  selectedFrameId?: number | null;
  onSelectFrame?: (frame: DecodedFrameAnnotation) => void;
  channelLabels?: readonly string[];
}

export interface WaveformCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  panByFraction: (frac: number) => void;
  fitAll: () => void;
  jumpToTrigger: () => void;
  toggleCursors: () => void;
  focusSampleRange: (startSample: number, endSample: number) => void;
}

interface ViewWindow {
  startSample: number;
  visibleSamples: number;
}

interface HoverState {
  x: number;
  y: number;
  ch: number;
  sampleIdx: number;
  measurement: PulseMeasurement | null;
}

interface SnapMarker {
  sampleIdx: number;
  ch: number;
}

function chooseNiceStep(rawStepSec: number): number {
  if (!Number.isFinite(rawStepSec) || rawStepSec <= 0) return 1e-6;
  const exp = Math.floor(Math.log10(rawStepSec));
  const base = Math.pow(10, exp);
  const norm = rawStepSec / base;
  if (norm <= 1) return base;
  if (norm <= 2) return 2 * base;
  if (norm <= 5) return 5 * base;
  return 10 * base;
}

function frameBadgeColors(kind: DecodedFrameAnnotation['kind']): {
  bg: string;
  border: string;
  text: string;
} {
  switch (kind) {
    case 'start':
      return { bg: 'rgba(63, 185, 80, 0.28)', border: '#3FB950', text: '#AFF5B4' };
    case 'stop':
      return { bg: 'rgba(240, 136, 62, 0.28)', border: '#F0883E', text: '#FFD8B5' };
    case 'addr':
      return { bg: 'rgba(188, 140, 255, 0.28)', border: '#BC8CFF', text: '#EBD9FF' };
    case 'error':
      return { bg: 'rgba(248, 81, 73, 0.34)', border: '#F85149', text: '#FFDCE0' };
    default:
      return { bg: 'rgba(57, 197, 207, 0.24)', border: '#39C5CF', text: '#C5F7FA' };
  }
}

export const WaveformCanvas = forwardRef<WaveformCanvasHandle, WaveformCanvasProps>(
  function WaveformCanvas(
    { capture, capturing, decodedFrames = [], selectedFrameId = null, onSelectFrame, channelLabels },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const [size, setSize] = useState<{ width: number; height: number }>({
      width: 640,
      height: 360,
    });
    const [view, setView] = useState<ViewWindow>({ startSample: 0, visibleSamples: 1024 });
    const [showCursors, setShowCursors] = useState(false);
    const [cursorA, setCursorA] = useState(256);
    const [cursorB, setCursorB] = useState(768);
    const [activeChannel, setActiveChannel] = useState(0);
    const [hoverState, setHoverState] = useState<HoverState | null>(null);
    const [snapMarker, setSnapMarker] = useState<SnapMarker | null>(null);
    const [boxZoomRange, setBoxZoomRange] = useState<{ x0: number; x1: number } | null>(null);

    const viewRef = useRef(view);
    viewRef.current = view;
    const captureRef = useRef(capture);
    captureRef.current = capture;
    const sizeRef = useRef(size);
    sizeRef.current = size;
    const prevCaptureLenRef = useRef<number>(0);

    const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
    const dragModeRef = useRef<
      'none' | 'pan' | 'cursorA' | 'cursorB' | 'pinch' | 'minimap' | 'boxZoom'
    >('none');
    const panStartRef = useRef<{ x: number; startSample: number }>({ x: 0, startSample: 0 });
    const downPosRef = useRef<{ x: number; y: number; moved: boolean }>({
      x: 0,
      y: 0,
      moved: false,
    });
    const pinchStartRef = useRef<{
      dist: number;
      midX: number;
      startSample: number;
      visibleSamples: number;
    }>({ dist: 1, midX: 0, startSample: 0, visibleSamples: 1024 });

    // Precompute minimap edge-activity density once per capture
    const minimapActivity = useMemo(() => {
      if (!capture || capture.samples.byteLength < 2) return null;
      const samples = capture.samples;
      const total = samples.byteLength;
      const bins = Math.min(MINIMAP_BINS, total);
      const density = new Uint16Array(bins);
      let maxDensity = 1;

      for (let b = 0; b < bins; b++) {
        const s0 = Math.floor((b / bins) * (total - 1));
        const s1 = Math.min(total - 1, Math.floor(((b + 1) / bins) * (total - 1)));
        let transitions = 0;
        for (let i = Math.max(1, s0); i <= s1; i++) {
          const diff = samples[i] ^ samples[i - 1];
          if (diff !== 0) {
            // Count changing bits across the 8 channels
            let d = diff;
            while (d) {
              transitions += d & 1;
              d >>= 1;
            }
          }
        }
        const avg = Math.min(65535, Math.round((transitions * 10) / Math.max(1, s1 - s0 + 1)));
        density[b] = avg;
        if (avg > maxDensity) maxDensity = avg;
      }

      return { density, maxDensity, bins };
    }, [capture]);

    const clampView = useCallback(
      (startSample: number, visibleSamples: number, totalOverride?: number): ViewWindow => {
        const total = totalOverride ?? captureRef.current?.samples.byteLength ?? 1024;
        const minVis = Math.min(total, 4);
        const clampedVis = Math.max(minVis, Math.min(total, visibleSamples));
        const maxStart = Math.max(0, total - clampedVis);
        const clampedStart = Math.max(0, Math.min(maxStart, startSample));
        return { startSample: clampedStart, visibleSamples: clampedVis };
      },
      []
    );

    // Reset zoom only when capture depth changes; preserve zoom/pan on same-length re-captures
    useEffect(() => {
      if (!capture || capture.samples.byteLength === 0) {
        prevCaptureLenRef.current = 0;
        return;
      }
      const total = capture.samples.byteLength;
      const trig = Math.min(total - 1, Math.max(0, capture.triggerIndex));
      if (prevCaptureLenRef.current !== total) {
        setView({ startSample: 0, visibleSamples: total });
        setCursorA(Math.max(0, Math.round(total * 0.25)));
        setCursorB(
          trig > 0 && trig < total - 1 ? trig : Math.min(total - 1, Math.round(total * 0.65))
        );
      } else {
        setView((prev) => clampView(prev.startSample, prev.visibleSamples, total));
        setCursorA((prev) => Math.max(0, Math.min(total - 1, prev)));
        setCursorB((prev) => Math.max(0, Math.min(total - 1, prev)));
      }
      prevCaptureLenRef.current = total;
      setHoverState(null);
      setSnapMarker(null);
      setBoxZoomRange(null);
    }, [capture, clampView]);

    // Track canvas container dimensions
    useEffect(() => {
      const el = containerRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = Math.max(100, Math.floor(entry.contentRect.width));
          const h = Math.max(180, Math.floor(entry.contentRect.height));
          setSize({ width: w, height: h });
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    const zoomAroundX = useCallback(
      (factor: number, xPx: number) => {
        const curCap = captureRef.current;
        if (!curCap || curCap.samples.byteLength === 0) return;
        const widthPx = Math.max(1, sizeRef.current.width);
        setView((prev) => {
          const frac = Math.max(0, Math.min(1, xPx / widthPx));
          const anchorSample = prev.startSample + frac * prev.visibleSamples;
          const nextVis = prev.visibleSamples * factor;
          const nextStart = anchorSample - frac * nextVis;
          return clampView(nextStart, nextVis, curCap.samples.byteLength);
        });
      },
      [clampView]
    );

    const centerViewOnSample = useCallback(
      (targetSample: number, zoomIfFull: boolean) => {
        if (!capture || capture.samples.byteLength === 0) return;
        const total = capture.samples.byteLength;
        setView((prev) => {
          const nextVis =
            zoomIfFull && prev.visibleSamples > total * 0.45
              ? Math.min(total, Math.max(64, Math.round(total / 8)))
              : prev.visibleSamples;
          return clampView(targetSample - nextVis / 2, nextVis, total);
        });
      },
      [capture, clampView]
    );

    const focusSampleRange = useCallback(
      (startSample: number, endSample: number) => {
        if (!capture || capture.samples.byteLength === 0) return;
        const total = capture.samples.byteLength;
        const span = Math.max(12, endSample - startSample);
        const paddedVis = Math.min(total, Math.max(span * 3, 48));
        const mid = (startSample + endSample) / 2;
        setView(clampView(mid - paddedVis / 2, paddedVis, total));
      },
      [capture, clampView]
    );

    const fitAll = useCallback(() => {
      if (!capture) return;
      setView({ startSample: 0, visibleSamples: capture.samples.byteLength });
    }, [capture]);

    const jumpToTrigger = useCallback(() => {
      if (!capture || capture.samples.byteLength === 0) return;
      centerViewOnSample(capture.triggerIndex, true);
    }, [capture, centerViewOnSample]);

    useImperativeHandle(
      ref,
      () => ({
        zoomIn: () => zoomAroundX(0.65, sizeRef.current.width / 2),
        zoomOut: () => zoomAroundX(1.5, sizeRef.current.width / 2),
        panByFraction: (frac: number) => {
          const curCap = captureRef.current;
          if (!curCap || curCap.samples.byteLength === 0) return;
          setView((prev) =>
            clampView(
              prev.startSample + frac * prev.visibleSamples,
              prev.visibleSamples,
              curCap.samples.byteLength
            )
          );
        },
        fitAll,
        jumpToTrigger,
        toggleCursors: () => setShowCursors((v) => !v),
        focusSampleRange,
      }),
      [clampView, fitAll, focusSampleRange, jumpToTrigger, zoomAroundX]
    );

    // Native non-passive wheel listener for smooth cursor-anchored zoom & Shift+wheel/trackpad pan
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const onWheel = (e: WheelEvent) => {
        const curCap = captureRef.current;
        if (!curCap || curCap.samples.byteLength === 0) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const widthPx = Math.max(1, sizeRef.current.width);
        const unitScale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? widthPx : 1;
        const dx = e.deltaX * unitScale;
        const dy = e.deltaY * unitScale;

        if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
          const panPx = e.shiftKey && Math.abs(dy) >= Math.abs(dx) ? dy : dx;
          setView((prev) =>
            clampView(
              prev.startSample + (panPx / widthPx) * prev.visibleSamples,
              prev.visibleSamples,
              curCap.samples.byteLength
            )
          );
          return;
        }

        const clampedDelta = Math.max(-280, Math.min(280, dy));
        const factor = Math.exp(clampedDelta * 0.0022);
        zoomAroundX(factor, x);
      };

      canvas.addEventListener('wheel', onWheel, { passive: false });
      return () => canvas.removeEventListener('wheel', onWheel);
    }, [clampView, zoomAroundX]);

    // Render minimap, ruler, waveforms, decoder overlays, crosshairs, and cursors
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(size.width * dpr);
      const targetH = Math.round(size.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const width = size.width;
      const height = size.height;
      const laneHeight = Math.max(16, (height - TOP_HEIGHT) / 8);

      // 1. Backgrounds: Minimap, Ruler & Alternating Channel Lanes
      ctx.fillStyle = '#0D1117';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#0B0F14';
      ctx.fillRect(0, 0, width, MINIMAP_HEIGHT);

      ctx.fillStyle = '#161B22';
      ctx.fillRect(0, MINIMAP_HEIGHT, width, RULER_HEIGHT);

      for (let ch = 0; ch < 8; ch++) {
        const yTop = TOP_HEIGHT + ch * laneHeight;
        ctx.fillStyle =
          ch === activeChannel && capture
            ? 'rgba(88, 166, 255, 0.06)'
            : ch % 2 === 0
              ? '#0D1117'
              : '#10161F';
        ctx.fillRect(0, yTop, width, laneHeight);

        ctx.strokeStyle = '#21262D';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yTop);
        ctx.lineTo(width, yTop);
        ctx.stroke();
      }

      ctx.strokeStyle = '#262C36';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, MINIMAP_HEIGHT - 0.5);
      ctx.lineTo(width, MINIMAP_HEIGHT - 0.5);
      ctx.moveTo(0, TOP_HEIGHT - 0.5);
      ctx.lineTo(width, TOP_HEIGHT - 0.5);
      ctx.stroke();

      if (!capture || capture.samples.byteLength === 0) {
        ctx.fillStyle = '#8B949E';
        ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          capturing
            ? 'Waiting for trigger / capturing samples...'
            : 'Connect USB device or launch Demo, then click Capture (Space)',
          width / 2,
          TOP_HEIGHT + (height - TOP_HEIGHT) / 2
        );
        return;
      }

      const samples = capture.samples;
      const total = samples.byteLength;
      const rateHz = Math.max(1, capture.sampleRateHz);
      const startIdx = Math.max(0, view.startSample);
      const visCount = Math.max(1, view.visibleSamples);
      const endIdx = Math.min(total, startIdx + visCount);
      const pxPerSample = width / visCount;

      const sampleToX = (sampleIdx: number) => ((sampleIdx - startIdx) / visCount) * width;

      // 1b. Minimap activity density + viewport window + trigger indicator
      if (minimapActivity) {
        const { density, maxDensity, bins } = minimapActivity;
        ctx.fillStyle = 'rgba(88, 166, 255, 0.42)';
        for (let b = 0; b < bins; b++) {
          const val = density[b];
          if (val === 0) continue;
          const barH = Math.max(2, Math.round((val / maxDensity) * (MINIMAP_HEIGHT - 4)));
          const bx0 = (b / bins) * width;
          const bx1 = ((b + 1) / bins) * width;
          ctx.fillRect(bx0, MINIMAP_HEIGHT - 2 - barH, Math.max(1, bx1 - bx0), barH);
        }
      }

      const hasTriggerMarker =
        (capture.triggered || capture.autoTriggered || capture.triggerIndex > 0) &&
        capture.triggerIndex >= 0 &&
        capture.triggerIndex < total;

      if (hasTriggerMarker) {
        const mTrigX = (capture.triggerIndex / total) * width;
        ctx.fillStyle = capture.autoTriggered ? '#8B949E' : '#F0883E';
        ctx.fillRect(Math.round(mTrigX) - 1, 1, 2, MINIMAP_HEIGHT - 2);
      }

      const vx0 = (startIdx / total) * width;
      const vwRaw = (visCount / total) * width;
      const vw = Math.max(6, Math.min(width, vwRaw));
      const vxClamped = Math.min(width - vw, Math.max(0, vx0));

      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      if (vxClamped > 0) ctx.fillRect(0, 0, vxClamped, MINIMAP_HEIGHT - 1);
      if (vxClamped + vw < width) {
        ctx.fillRect(vxClamped + vw, 0, width - (vxClamped + vw), MINIMAP_HEIGHT - 1);
      }
      ctx.strokeStyle = '#58A6FF';
      ctx.lineWidth = 1.25;
      ctx.strokeRect(vxClamped + 0.5, 1.5, vw - 1, MINIMAP_HEIGHT - 3);

      // 2. Time Ruler Ticks & Vertical Grid
      const visibleDurationSec = visCount / rateHz;
      const targetTicks = Math.max(3, Math.floor(width / 110));
      const stepSec = chooseNiceStep(visibleDurationSec / targetTicks);
      const originSample = capture.triggerIndex;
      const tStartSec = (startIdx - originSample) / rateHz;
      const tEndSec = (endIdx - originSample) / rateHz;
      const firstTickK = Math.ceil(tStartSec / stepSec);
      const lastTickK = Math.floor(tEndSec / stepSec);

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      for (let k = firstTickK; k <= lastTickK; k++) {
        const tickSec = k * stepSec;
        const samplePos = originSample + tickSec * rateHz;
        const x = sampleToX(samplePos);
        if (x < -2 || x > width + 2) continue;

        ctx.strokeStyle = '#1E2633';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_HEIGHT);
        ctx.lineTo(Math.round(x) + 0.5, height);
        ctx.stroke();

        ctx.strokeStyle = '#484F58';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, TOP_HEIGHT - 6);
        ctx.lineTo(Math.round(x) + 0.5, TOP_HEIGHT);
        ctx.stroke();

        ctx.fillStyle = '#8B949E';
        ctx.fillText(formatSignedDuration(tickSec), x + 4, MINIMAP_HEIGHT + RULER_HEIGHT / 2);
      }

      // 3. Digital Step Waveforms (D0..D7)
      const padY = Math.max(5, Math.min(12, laneHeight * 0.2));

      for (let ch = 0; ch < 8; ch++) {
        const meta = CHANNELS[ch];
        const bitMask = 1 << ch;
        const yTop = TOP_HEIGHT + ch * laneHeight;
        const yHigh = yTop + padY;
        const yLow = yTop + laneHeight - padY;

        ctx.strokeStyle = meta.color;
        ctx.lineWidth = 1.75;

        if (pxPerSample >= 1.0) {
          const iFrom = Math.max(0, Math.floor(startIdx));
          const iTo = Math.min(total - 1, Math.ceil(endIdx));

          ctx.beginPath();
          let prevBit = (samples[iFrom] & bitMask) !== 0;
          ctx.moveTo(sampleToX(iFrom), prevBit ? yHigh : yLow);

          for (let idx = iFrom + 1; idx <= iTo; idx++) {
            const curBit = (samples[idx] & bitMask) !== 0;
            const x = sampleToX(idx);
            ctx.lineTo(x, prevBit ? yHigh : yLow);
            if (curBit !== prevBit) {
              ctx.lineTo(x, curBit ? yHigh : yLow);
            }
            prevBit = curBit;
          }
          ctx.lineTo(sampleToX(iTo + 1), prevBit ? yHigh : yLow);
          ctx.stroke();

          ctx.fillStyle = `${meta.color}1C`;
          for (let idx = iFrom; idx <= iTo; idx++) {
            if ((samples[idx] & bitMask) !== 0) {
              const sx = sampleToX(idx);
              const sw = Math.max(1, sampleToX(idx + 1) - sx);
              ctx.fillRect(sx, yHigh, sw, yLow - yHigh);
            }
          }

          // Sample nodes visible at deep zoom
          if (pxPerSample >= 10) {
            ctx.fillStyle = meta.color;
            for (let idx = iFrom; idx <= iTo; idx++) {
              const cx = sampleToX(idx);
              const cy = (samples[idx] & bitMask) !== 0 ? yHigh : yLow;
              ctx.beginPath();
              ctx.arc(cx, cy, 2.3, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        } else {
          ctx.beginPath();
          let prevLastBit: boolean | null = null;
          for (let px = 0; px < width; px++) {
            const s0 = Math.max(0, Math.floor(startIdx + (px / width) * visCount));
            const s1 = Math.min(
              total - 1,
              Math.max(s0, Math.floor(startIdx + ((px + 1) / width) * visCount))
            );

            let hasLow = false;
            let hasHigh = false;
            for (let s = s0; s <= s1; s++) {
              if ((samples[s] & bitMask) !== 0) hasHigh = true;
              else hasLow = true;
              if (hasHigh && hasLow) break;
            }

            const firstBit = (samples[s0] & bitMask) !== 0;
            const lastBit = (samples[s1] & bitMask) !== 0;

            if (prevLastBit !== null && firstBit !== prevLastBit) {
              ctx.moveTo(px, yHigh);
              ctx.lineTo(px, yLow);
            }

            if (hasHigh && hasLow) {
              ctx.moveTo(px + 0.5, yHigh);
              ctx.lineTo(px + 0.5, yLow);
            } else {
              const y = hasHigh ? yHigh : yLow;
              ctx.moveTo(px, y);
              ctx.lineTo(px + 1, y);
            }
            prevLastBit = lastBit;
          }
          ctx.stroke();
        }
      }

      // 3b. Inline Protocol Decoder Bubbles
      if (decodedFrames.length > 0) {
        ctx.save();
        ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const drawBubble = (
          laneCh: number,
          frame: DecodedFrameAnnotation,
          textLabel: string,
          kind: DecodedFrameAnnotation['kind']
        ) => {
          if (frame.endSample < startIdx || frame.startSample > endIdx) return;
          const x0 = Math.max(-2, sampleToX(frame.startSample));
          const x1 = Math.min(width + 2, sampleToX(frame.endSample));
          const bw = Math.max(3, x1 - x0);
          const yTop = TOP_HEIGHT + laneCh * laneHeight;
          const bh = Math.min(15, Math.max(10, laneHeight * 0.38));
          const by = yTop + laneHeight - bh - 2;
          const style = frameBadgeColors(kind);
          const isSelected = frame.id === selectedFrameId;

          ctx.fillStyle = style.bg;
          ctx.strokeStyle = isSelected ? '#FFFFFF' : style.border;
          ctx.lineWidth = isSelected ? 1.6 : 1;
          ctx.beginPath();
          ctx.roundRect(x0 + 1, by, Math.max(2, bw - 2), bh, 3);
          ctx.fill();
          if (bw >= 5) ctx.stroke();

          if (bw >= 22) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0 + 3, by, Math.max(1, bw - 6), bh);
            ctx.clip();
            ctx.fillStyle = style.text;
            ctx.fillText(textLabel, x0 + bw / 2, by + bh / 2 + 0.5);
            ctx.restore();
          }
        };

        for (const frame of decodedFrames) {
          drawBubble(frame.channel, frame, frame.label, frame.kind);
          if (frame.secondaryChannel !== undefined && frame.secondaryLabel) {
            drawBubble(frame.secondaryChannel, frame, frame.secondaryLabel, 'data');
          }
        }
        ctx.restore();
      }

      // 4. Vertical Trigger Position Marker
      if (hasTriggerMarker) {
        const trigX = sampleToX(capture.triggerIndex);
        if (trigX >= 0 && trigX <= width) {
          ctx.save();
          ctx.strokeStyle = capture.autoTriggered ? '#8B949E' : '#F0883E';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(trigX, TOP_HEIGHT);
          ctx.lineTo(trigX, height);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = capture.autoTriggered ? '#8B949E' : '#F0883E';
          ctx.fillRect(trigX - 8, MINIMAP_HEIGHT + 4, 16, 16);
          ctx.fillStyle = '#0D1117';
          ctx.font = 'bold 10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('T', trigX, MINIMAP_HEIGHT + 12);
          ctx.restore();
        }
      }

      // 5. Box Zoom Selection Overlay
      if (boxZoomRange) {
        const bx = Math.min(boxZoomRange.x0, boxZoomRange.x1);
        const bw = Math.abs(boxZoomRange.x1 - boxZoomRange.x0);
        if (bw >= 2) {
          ctx.save();
          ctx.fillStyle = 'rgba(88, 166, 255, 0.16)';
          ctx.fillRect(bx, TOP_HEIGHT, bw, height - TOP_HEIGHT);
          ctx.strokeStyle = '#58A6FF';
          ctx.lineWidth = 1.25;
          ctx.strokeRect(bx + 0.5, TOP_HEIGHT + 0.5, bw - 1, height - TOP_HEIGHT - 1);
          const spanSec = ((bw / Math.max(1, width)) * visCount) / rateHz;
          ctx.fillStyle = '#58A6FF';
          ctx.font = '600 11px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(formatDuration(spanSec), bx + bw / 2, TOP_HEIGHT + 14);
          ctx.restore();
        }
      }

      // 6. Hover Crosshair & Enclosing Pulse Dimension Bracket
      if (hoverState && !boxZoomRange && hoverState.y >= TOP_HEIGHT) {
        ctx.save();
        ctx.strokeStyle = 'rgba(139, 148, 158, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(hoverState.x + 0.5, TOP_HEIGHT);
        ctx.lineTo(hoverState.x + 0.5, height);
        ctx.stroke();
        ctx.setLineDash([]);

        const m = hoverState.measurement;
        if (m) {
          const mx0 = sampleToX(m.startSample);
          const mx1 = sampleToX(m.endSample);
          const mw = mx1 - mx0;
          if (mw >= 14 && mx1 > 0 && mx0 < width) {
            const yTop = TOP_HEIGHT + m.channel * laneHeight;
            const yMid = yTop + laneHeight * 0.5;
            const clampX0 = Math.max(0, mx0);
            const clampX1 = Math.min(width, mx1);
            ctx.strokeStyle = '#F0F6FC';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(clampX0, yMid - 5);
            ctx.lineTo(clampX0, yMid + 5);
            ctx.moveTo(clampX1, yMid - 5);
            ctx.lineTo(clampX1, yMid + 5);
            ctx.moveTo(clampX0, yMid);
            ctx.lineTo(clampX1, yMid);
            ctx.stroke();

            if (mw >= 52) {
              const labelText = formatDuration(m.widthSec);
              ctx.font = '600 10px ui-monospace, monospace';
              const tw = ctx.measureText(labelText).width + 8;
              const cx = (clampX0 + clampX1) / 2;
              ctx.fillStyle = 'rgba(13, 17, 23, 0.9)';
              ctx.fillRect(cx - tw / 2, yMid - 8, tw, 16);
              ctx.fillStyle = '#F0F6FC';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(labelText, cx, yMid);
            }
          }
        }
        ctx.restore();
      }

      // 7. Draggable Measurement Cursors A and B + Magnetic Snap Highlight
      if (showCursors) {
        const drawCursor = (samplePos: number, label: string, color: string) => {
          const x = sampleToX(samplePos);
          if (x < -12 || x > width + 12) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, TOP_HEIGHT);
          ctx.lineTo(x, height);
          ctx.stroke();

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x - 9, MINIMAP_HEIGHT + 4, 18, 17, 3);
          ctx.fill();

          ctx.fillStyle = '#0D1117';
          ctx.font = 'bold 11px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x, MINIMAP_HEIGHT + 12.5);
          ctx.restore();
        };

        drawCursor(cursorA, 'A', '#39C5CF');
        drawCursor(cursorB, 'B', '#D29922');

        if (snapMarker) {
          const sx = sampleToX(snapMarker.sampleIdx);
          const sy = TOP_HEIGHT + snapMarker.ch * laneHeight + laneHeight / 2;
          ctx.save();
          ctx.strokeStyle = '#FFFFFF';
          ctx.fillStyle = '#39C5CF';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    }, [
      activeChannel,
      boxZoomRange,
      capture,
      capturing,
      cursorA,
      cursorB,
      decodedFrames,
      hoverState,
      minimapActivity,
      selectedFrameId,
      showCursors,
      size,
      snapMarker,
      view,
    ]);

    const xToSample = (xPx: number): number => {
      const total = capture?.samples.byteLength ?? 1;
      const raw = view.startSample + (xPx / Math.max(1, size.width)) * view.visibleSamples;
      return Math.max(0, Math.min(total - 1, Math.round(raw)));
    };

    const yToChannel = (yPx: number): number => {
      const laneHeight = Math.max(16, (size.height - TOP_HEIGHT) / 8);
      return Math.max(0, Math.min(7, Math.floor((yPx - TOP_HEIGHT) / laneHeight)));
    };

    const sampleToClientX = (sampleIdx: number): number =>
      ((sampleIdx - view.startSample) / Math.max(1, view.visibleSamples)) * size.width;

    const scrubMinimap = (xPx: number) => {
      if (!capture || capture.samples.byteLength === 0) return;
      const total = capture.samples.byteLength;
      const frac = Math.max(0, Math.min(1, xPx / Math.max(1, size.width)));
      const center = frac * total;
      setView((prev) => clampView(center - prev.visibleSamples / 2, prev.visibleSamples, total));
    };

    const snapCursorSample = (xPx: number, yPx: number, altKey: boolean): number => {
      const raw = xToSample(xPx);
      if (!capture || altKey || yPx < TOP_HEIGHT) {
        setSnapMarker(null);
        return raw;
      }
      const ch = yToChannel(yPx);
      const snapRadius = Math.max(1, Math.round((10 / Math.max(1, size.width)) * view.visibleSamples));
      const snapped = findNearestEdge(capture.samples, ch, raw, snapRadius);
      if (snapped !== null) {
        setSnapMarker({ sampleIdx: snapped, ch });
        return snapped;
      }
      setSnapMarker(null);
      return raw;
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!capture || capture.samples.byteLength === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic events
      }

      activePointers.current.set(e.pointerId, { x, y });
      downPosRef.current = { x, y, moved: false };

      if (activePointers.current.size === 2) {
        const pts = Array.from(activePointers.current.values());
        const dist = Math.max(8, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const midX = (pts[0].x + pts[1].x) / 2;
        dragModeRef.current = 'pinch';
        pinchStartRef.current = {
          dist,
          midX,
          startSample: view.startSample,
          visibleSamples: view.visibleSamples,
        };
        return;
      }

      if (y < MINIMAP_HEIGHT) {
        dragModeRef.current = 'minimap';
        scrubMinimap(x);
        return;
      }

      if (e.shiftKey && y >= TOP_HEIGHT) {
        dragModeRef.current = 'boxZoom';
        setBoxZoomRange({ x0: x, x1: x });
        return;
      }

      if (showCursors) {
        const ax = sampleToClientX(cursorA);
        const bx = sampleToClientX(cursorB);
        const distA = Math.abs(x - ax);
        const distB = Math.abs(x - bx);
        const threshold = y <= TOP_HEIGHT + 8 ? 16 : 9;
        if (distA <= threshold && distA <= distB) {
          dragModeRef.current = 'cursorA';
          return;
        }
        if (distB <= threshold) {
          dragModeRef.current = 'cursorB';
          return;
        }
      }

      dragModeRef.current = 'pan';
      panStartRef.current = { x, startSample: view.startSample };
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!capture || capture.samples.byteLength === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (!activePointers.current.has(e.pointerId)) {
        // Pure mouse hover (no button pressed): update pulse measurement HUD
        if (y >= TOP_HEIGHT) {
          const ch = yToChannel(y);
          const sampleIdx = xToSample(x);
          setHoverState((prev) => {
            if (prev && prev.x === x && prev.ch === ch && prev.sampleIdx === sampleIdx) {
              return prev;
            }
            const measurement = measurePulseAtSample(
              capture.samples,
              ch,
              sampleIdx,
              capture.sampleRateHz
            );
            return { x, y, ch, sampleIdx, measurement };
          });
        } else {
          setHoverState((prev) => (prev === null ? prev : null));
        }
        return;
      }

      if (Math.hypot(x - downPosRef.current.x, y - downPosRef.current.y) > 4) {
        downPosRef.current.moved = true;
      }

      activePointers.current.set(e.pointerId, { x, y });

      if (dragModeRef.current === 'pinch' && activePointers.current.size >= 2) {
        const pts = Array.from(activePointers.current.values());
        const dist = Math.max(8, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const midX = (pts[0].x + pts[1].x) / 2;
        const scale = pinchStartRef.current.dist / dist;
        const newVis = pinchStartRef.current.visibleSamples * scale;
        const anchorFrac = Math.max(
          0,
          Math.min(1, pinchStartRef.current.midX / Math.max(1, size.width))
        );
        const anchorSample =
          pinchStartRef.current.startSample + anchorFrac * pinchStartRef.current.visibleSamples;
        const curMidFrac = Math.max(0, Math.min(1, midX / Math.max(1, size.width)));
        const newStart = anchorSample - curMidFrac * newVis;
        setView(clampView(newStart, newVis));
        return;
      }

      if (dragModeRef.current === 'minimap') {
        scrubMinimap(x);
      } else if (dragModeRef.current === 'boxZoom') {
        setBoxZoomRange((prev) => (prev ? { x0: prev.x0, x1: x } : { x0: x, x1: x }));
      } else if (dragModeRef.current === 'cursorA') {
        setCursorA(snapCursorSample(x, y, e.altKey));
      } else if (dragModeRef.current === 'cursorB') {
        setCursorB(snapCursorSample(x, y, e.altKey));
      } else if (dragModeRef.current === 'pan') {
        const dx = x - panStartRef.current.x;
        const dSamples = (dx / Math.max(1, size.width)) * view.visibleSamples;
        setView(clampView(panStartRef.current.startSample - dSamples, view.visibleSamples));
      }
    };

    const handlePointerUpOrCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragModeRef.current === 'boxZoom' && boxZoomRange) {
        const minPx = Math.min(boxZoomRange.x0, x);
        const maxPx = Math.max(boxZoomRange.x0, x);
        if (maxPx - minPx >= 8 && capture) {
          const s0 = view.startSample + (minPx / Math.max(1, size.width)) * view.visibleSamples;
          const s1 = view.startSample + (maxPx / Math.max(1, size.width)) * view.visibleSamples;
          setView(clampView(s0, Math.max(4, s1 - s0)));
        }
        setBoxZoomRange(null);
      } else if (
        dragModeRef.current === 'pan' &&
        !downPosRef.current.moved &&
        y >= TOP_HEIGHT &&
        capture
      ) {
        // Click without dragging: select active channel or matching decoded bubble
        const ch = yToChannel(y);
        setActiveChannel(ch);
        if (decodedFrames.length > 0 && onSelectFrame) {
          const clickedSample = xToSample(x);
          const hit = decodedFrames.find(
            (f) =>
              (f.channel === ch || f.secondaryChannel === ch) &&
              clickedSample >= f.startSample &&
              clickedSample <= f.endSample
          );
          if (hit) onSelectFrame(hit);
        }
      }

      activePointers.current.delete(e.pointerId);
      setSnapMarker(null);

      if (dragModeRef.current === 'pinch') {
        if (activePointers.current.size === 1) {
          // Seamless transition from 2-finger pinch to 1-finger pan without losing gesture
          const [remaining] = Array.from(activePointers.current.values());
          dragModeRef.current = 'pan';
          panStartRef.current = { x: remaining.x, startSample: viewRef.current.startSample };
          return;
        }
        if (activePointers.current.size === 0) {
          dragModeRef.current = 'none';
          return;
        }
      }

      if (activePointers.current.size === 0) {
        dragModeRef.current = 'none';
      }
    };

    const rateHz = Math.max(1, capture?.sampleRateHz ?? 1_000_000);
    const deltaSamples = Math.abs(cursorB - cursorA);
    const deltaSec = deltaSamples / rateHz;
    const freqHz = deltaSec > 0 ? 1 / deltaSec : 0;

    const betweenEdges = useMemo(() => {
      if (!capture || !showCursors) return { rising: 0, falling: 0 };
      return countChannelEdges(capture.samples, activeChannel, cursorA, cursorB);
    }, [activeChannel, capture, cursorA, cursorB, showCursors]);

    const activeLabel =
      channelLabels?.[activeChannel]?.trim() || CHANNELS[activeChannel]?.label || `D${activeChannel}`;
    const hasTrigger = Boolean(
      capture && (capture.triggered || capture.autoTriggered || capture.triggerIndex > 0)
    );

    return (
      <div className="waveform-pane" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onPointerLeave={() => setHoverState(null)}
        />

        {capture && (
          <div className="waveform-overlay-controls">
            <button
              type="button"
              className="overlay-btn"
              title="Zoom In (+)"
              onClick={() => zoomAroundX(0.65, size.width / 2)}
            >
              +
            </button>
            <button
              type="button"
              className="overlay-btn"
              title="Zoom Out (-)"
              onClick={() => zoomAroundX(1.5, size.width / 2)}
            >
              −
            </button>
            <button type="button" className="overlay-btn" title="Fit full capture (F)" onClick={fitAll}>
              Fit
            </button>
            {hasTrigger && (
              <button
                type="button"
                className="overlay-btn"
                title="Center on Trigger (T)"
                onClick={jumpToTrigger}
              >
                Trig
              </button>
            )}
            <button
              type="button"
              className={`overlay-btn ${showCursors ? 'active' : ''}`}
              title="Toggle Measurement Cursors (C) — hold Alt to disable edge snap"
              onClick={() => setShowCursors((v) => !v)}
            >
              Cursors
            </button>
          </div>
        )}

        {capture && hoverState?.measurement && (
          <div className="pulse-hud" aria-live="polite">
            <span className="pulse-hud-ch" style={{ color: CHANNELS[hoverState.ch].color }}>
              {channelLabels?.[hoverState.ch]?.trim() || CHANNELS[hoverState.ch].label}
            </span>
            <span>{hoverState.measurement.level ? 'HIGH' : 'LOW'}</span>
            <span>W: {formatDuration(hoverState.measurement.widthSec)}</span>
            {hoverState.measurement.periodSec !== null && (
              <span>T: {formatDuration(hoverState.measurement.periodSec)}</span>
            )}
            {hoverState.measurement.frequencyHz !== null && (
              <span>{formatFrequency(hoverState.measurement.frequencyHz)}</span>
            )}
            {hoverState.measurement.dutyPercent !== null && (
              <span>Duty: {hoverState.measurement.dutyPercent.toFixed(1)}%</span>
            )}
          </div>
        )}

        {capture && (showCursors || capture.abortedEarly || capture.autoTriggered) && (
          <div className="delta-badge" aria-live="polite">
            {showCursors && (
              <>
                <span className="cursor-a-tag">
                  A: {formatSignedDuration((cursorA - capture.triggerIndex) / rateHz)}
                </span>
                <span className="cursor-b-tag">
                  B: {formatSignedDuration((cursorB - capture.triggerIndex) / rateHz)}
                </span>
                <span className="delta-tag">
                  Δt: {formatDuration(deltaSec)} ({freqHz > 0 ? formatFrequency(freqHz) : '∞'})
                </span>
                <span className="edge-count-tag" title={`Edges on ${activeLabel} between A and B`}>
                  {activeLabel}: ↑{betweenEdges.rising} ↓{betweenEdges.falling}
                </span>
              </>
            )}
            {capture.abortedEarly && <span className="flag-tag flag-warn">ABORTED</span>}
            {capture.autoTriggered && <span className="flag-tag flag-muted">AUTO-TRIG</span>}
          </div>
        )}
      </div>
    );
  }
);
