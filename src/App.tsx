import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BottomDrawer } from './components/BottomDrawer';
import { RawIqInspector } from './components/RawIqInspector';
import { SdrControlBar } from './components/SdrControlBar';
import { SdrSpectrumWaterfall } from './components/SdrSpectrumWaterfall';
import { TopToolbar } from './components/TopToolbar';
import { WidebandScannerModal } from './components/WidebandScannerModal';
import { SpectrumTraceState, updateSpectrumTraces } from './dsp/sdrDsp';
import { ProtocolDemuxer } from './protocol/ProtocolDemuxer';
import {
  buildSdrStreamCtrlCmd,
  buildSdrSweepCfgCmd,
  buildSdrTuneCmd,
  clampSdrFreqMhz,
  resolveSdrRatePreset,
} from './protocol/codec';
import {
  BoardCapabilitiesFrame,
  SDR_DSP_FLAG_DC_CANCEL,
  SDR_DSP_FLAG_MAX_HOLD,
  SDR_STREAM_CONT_IQ,
  SDR_STREAM_FFT,
  SDR_STREAM_SINGLE_IQ,
  SDR_STREAM_STOP,
  SdrRawIqFrame,
  SdrSpectrumFrame,
} from './protocol/types';
import { SerialTransport, TransportSnapshot } from './transport/SerialTransport';

export const App: React.FC = () => {
  const transportRef = useRef<SerialTransport | null>(null);
  if (!transportRef.current) {
    transportRef.current = new SerialTransport();
  }
  const serialTransport = transportRef.current;

  const [transport, setTransport] = useState<TransportSnapshot>(() =>
    serialTransport.getSnapshot(),
  );
  const [caps, setCaps] = useState<BoardCapabilitiesFrame | null>(null);

  // SDR state
  const [sdrStreaming, setSdrStreaming] = useState<boolean>(false);
  const [sdrCenterFreqMhz, setSdrCenterFreqMhz] = useState<number>(2437);
  const [sdrRateBwCode, setSdrRateBwCode] = useState<number>(1);
  const [sdrFftLog2, setSdrFftLog2] = useState<number>(10);
  const [sdrMaxHoldDetector, setSdrMaxHoldDetector] = useState<boolean>(false);
  const [sdrSubWindows, setSdrSubWindows] = useState<number>(4);
  const [sdrDcNotch, setSdrDcNotch] = useState<boolean>(true);
  const [sdrSpurBlanker, setSdrSpurBlanker] = useState<boolean>(false);
  const [sdrGainIndex, setSdrGainIndex] = useState<number>(42);
  const [sdrTargetFps, setSdrTargetFps] = useState<number>(20);
  const [sdrSweepEnabled, setSdrSweepEnabled] = useState<boolean>(false);

  const [sdrAdcClip, setSdrAdcClip] = useState<boolean>(false);
  const [sdrLoDivActive, setSdrLoDivActive] = useState<boolean>(false);
  const [sdrCaptureTruncated, setSdrCaptureTruncated] = useState<boolean>(false);
  const [sdrTrace, setSdrTrace] = useState<SpectrumTraceState | null>(null);
  const [latestSdrFrame, setLatestSdrFrame] = useState<SdrSpectrumFrame | null>(null);
  const [sdrFrameVersion, setSdrFrameVersion] = useState<number>(0);
  const [sdrFps, setSdrFps] = useState<number>(0);

  // Wideband Scanner modal state
  const [scannerOpen, setScannerOpen] = useState<boolean>(false);

  // Raw I/Q Inspector state
  const [rawIqOpen, setRawIqOpen] = useState<boolean>(false);
  const [rawIqFrame, setRawIqFrame] = useState<SdrRawIqFrame | null>(null);
  const [rawIqKb, setRawIqKb] = useState<number>(2);
  const [streamingContIq, setStreamingContIq] = useState<boolean>(false);

  // Bottom drawer state (Web Flasher)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  const dspOptionsRef = useRef({
    dcNotch: sdrDcNotch,
    spurBlanker: sdrSpurBlanker,
    clearNextPeak: false,
  });
  dspOptionsRef.current.dcNotch = sdrDcNotch;
  dspOptionsRef.current.spurBlanker = sdrSpurBlanker;

  const transportModeRef = useRef(transport.transport);
  transportModeRef.current = transport.transport;

  const lastSdrFrameTsRef = useRef<number>(0);

  useEffect(() => {
    const demuxer = new ProtocolDemuxer({
      onTerminalBytes: () => {},
      onFrame: (frame) => {
        if (frame.type === 'capabilities') {
          setCaps(frame);
        } else if (frame.type === 'sdrSpectrum') {
          const specFrame: SdrSpectrumFrame = frame;
          const now = performance.now();
          if (lastSdrFrameTsRef.current > 0) {
            const dt = now - lastSdrFrameTsRef.current;
            if (dt > 1) {
              const instFps = 1000 / dt;
              setSdrFps((prev) =>
                prev === 0 ? instFps : prev * 0.75 + instFps * 0.25,
              );
            }
          }
          lastSdrFrameTsRef.current = now;

          setSdrAdcClip(specFrame.adcClip);
          setSdrLoDivActive(specFrame.loDivActive);
          setSdrCaptureTruncated(specFrame.captureTruncated);
          setLatestSdrFrame(specFrame);
          setSdrTrace((prev) => {
            const clearPeak = dspOptionsRef.current.clearNextPeak;
            dspOptionsRef.current.clearNextPeak = false;
            return updateSpectrumTraces(
              specFrame.powerDbFs,
              specFrame.centerFreqMhz,
              specFrame.spanMhz,
              prev,
              {
                dcNotch: dspOptionsRef.current.dcNotch,
                spurBlanker: dspOptionsRef.current.spurBlanker,
                invertSpectrum: transportModeRef.current !== 'demo',
                clearPeakHold: clearPeak,
              },
            );
          });
          setSdrFrameVersion((v) => v + 1);
        } else if (frame.type === 'sdrRawIq') {
          setRawIqFrame(frame);
          setSdrAdcClip(frame.adcClip);
          setSdrLoDivActive(frame.loDivActive);
        }
      },
    });

    const unsubState = serialTransport.onStateChange((snap) => {
      setTransport(snap);
      if (snap.status !== 'connected') {
        setSdrStreaming(false);
        setStreamingContIq(false);
        setCaps(null);
      }
    });

    const unsubBytes = serialTransport.onBytes((bytes) => {
      demuxer.feed(bytes);
    });

    serialTransport.init();
    return () => {
      unsubState();
      unsubBytes();
      serialTransport.destroy();
    };
  }, [serialTransport]);

  const sendSdrTune = useCallback(
    (freqMhz: number, bwCode: number, gain: number) => {
      if (transport.status !== 'connected') return;
      void serialTransport.writeBytes(buildSdrTuneCmd(freqMhz, bwCode, gain));
    },
    [serialTransport, transport.status],
  );

  const buildCurrentDspFlags = useCallback(() => {
    let flags = 0;
    if (sdrMaxHoldDetector) flags |= SDR_DSP_FLAG_MAX_HOLD;
    if (sdrDcNotch) flags |= SDR_DSP_FLAG_DC_CANCEL;
    flags |= ((Math.max(1, Math.min(16, sdrSubWindows)) - 1) & 0x0f) << 4;
    return flags;
  }, [sdrMaxHoldDetector, sdrDcNotch, sdrSubWindows]);

  const sendSdrStreamCtrl = useCallback(
    (mode: number, sizeParam: number) => {
      if (transport.status !== 'connected') return;
      void serialTransport.writeBytes(
        buildSdrStreamCtrlCmd(mode, sizeParam, buildCurrentDspFlags(), sdrTargetFps),
      );
    },
    [serialTransport, transport.status, buildCurrentDspFlags, sdrTargetFps],
  );

  const handleCenterFreqChange = useCallback(
    (freq: number) => {
      const clamped = clampSdrFreqMhz(freq);
      setSdrCenterFreqMhz(clamped);
      dspOptionsRef.current.clearNextPeak = true;
      sendSdrTune(clamped, sdrRateBwCode, sdrGainIndex);
    },
    [sendSdrTune, sdrRateBwCode, sdrGainIndex],
  );

  const handleRateBwChange = useCallback(
    (code: number) => {
      setSdrRateBwCode(code);
      dspOptionsRef.current.clearNextPeak = true;
      sendSdrTune(sdrCenterFreqMhz, code, sdrGainIndex);
    },
    [sendSdrTune, sdrCenterFreqMhz, sdrGainIndex],
  );

  const handleGainIndexChange = useCallback(
    (gain: number) => {
      setSdrGainIndex(gain);
      sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, gain);
    },
    [sendSdrTune, sdrCenterFreqMhz, sdrRateBwCode],
  );

  const handleToggleSdrStream = useCallback(() => {
    if (sdrStreaming) {
      setSdrStreaming(false);
      setStreamingContIq(false);
      sendSdrStreamCtrl(SDR_STREAM_STOP, sdrFftLog2);
    } else {
      sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, sdrGainIndex);
      setSdrStreaming(true);
      setStreamingContIq(false);
      lastSdrFrameTsRef.current = 0;
      sendSdrStreamCtrl(SDR_STREAM_FFT, sdrFftLog2);
    }
  }, [
    sdrStreaming,
    sendSdrStreamCtrl,
    sdrFftLog2,
    sendSdrTune,
    sdrCenterFreqMhz,
    sdrRateBwCode,
    sdrGainIndex,
  ]);

  useEffect(() => {
    if (sdrStreaming && !streamingContIq && transport.status === 'connected') {
      sendSdrStreamCtrl(SDR_STREAM_FFT, sdrFftLog2);
    }
  }, [
    sdrStreaming,
    streamingContIq,
    transport.status,
    sdrFftLog2,
    sdrMaxHoldDetector,
    sdrSubWindows,
    sdrDcNotch,
    sdrTargetFps,
    sendSdrStreamCtrl,
  ]);

  const handleToggleSweep = useCallback(() => {
    const next = !sdrSweepEnabled;
    setSdrSweepEnabled(next);
    if (transport.status === 'connected') {
      void serialTransport.writeBytes(buildSdrSweepCfgCmd(2400, next ? 4 : 0, 4));
    }
  }, [sdrSweepEnabled, transport.status, serialTransport]);

  const handleOpenRawIq = useCallback(() => {
    setRawIqOpen(true);
    if (transport.status === 'connected' && !rawIqFrame) {
      sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, sdrGainIndex);
      sendSdrStreamCtrl(SDR_STREAM_SINGLE_IQ, rawIqKb);
    }
  }, [
    transport.status,
    rawIqFrame,
    sendSdrTune,
    sdrCenterFreqMhz,
    sdrRateBwCode,
    sdrGainIndex,
    sendSdrStreamCtrl,
    rawIqKb,
  ]);

  const handleOpenScanner = useCallback(() => {
    setScannerOpen(true);
    if (transport.status === 'connected') {
      if (sdrRateBwCode !== 1) setSdrRateBwCode(1);
      if (!sdrStreaming || streamingContIq) {
        setStreamingContIq(false);
        setSdrStreaming(true);
        lastSdrFrameTsRef.current = 0;
        sendSdrStreamCtrl(SDR_STREAM_FFT, sdrFftLog2);
      }
    }
  }, [
    transport.status,
    sdrRateBwCode,
    sdrStreaming,
    streamingContIq,
    sendSdrStreamCtrl,
    sdrFftLog2,
  ]);

  const handleRequestScanStep = useCallback(
    (freqMhz: number) => {
      if (transport.status !== 'connected') return;
      sendSdrTune(freqMhz, 1, sdrGainIndex);
    },
    [transport.status, sendSdrTune, sdrGainIndex],
  );

  const handleTuneAndInspect = useCallback(
    (freqMhz: number) => {
      const clamped = clampSdrFreqMhz(freqMhz);
      setScannerOpen(false);
      setSdrCenterFreqMhz(clamped);
      dspOptionsRef.current.clearNextPeak = true;
      sendSdrTune(clamped, sdrRateBwCode, sdrGainIndex);
    },
    [sendSdrTune, sdrRateBwCode, sdrGainIndex],
  );

  const handleRequestSingleIq = useCallback(() => {
    setStreamingContIq(false);
    setSdrStreaming(false);
    sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, sdrGainIndex);
    sendSdrStreamCtrl(SDR_STREAM_SINGLE_IQ, rawIqKb);
  }, [
    sendSdrTune,
    sdrCenterFreqMhz,
    sdrRateBwCode,
    sdrGainIndex,
    sendSdrStreamCtrl,
    rawIqKb,
  ]);

  const handleToggleContIq = useCallback(() => {
    if (streamingContIq) {
      setStreamingContIq(false);
      setSdrStreaming(false);
      sendSdrStreamCtrl(SDR_STREAM_STOP, rawIqKb);
    } else {
      sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, sdrGainIndex);
      setStreamingContIq(true);
      setSdrStreaming(true);
      sendSdrStreamCtrl(SDR_STREAM_CONT_IQ, rawIqKb);
    }
  }, [
    streamingContIq,
    sendSdrStreamCtrl,
    rawIqKb,
    sendSdrTune,
    sdrCenterFreqMhz,
    sdrRateBwCode,
    sdrGainIndex,
  ]);

  const sdrSpanMhz = resolveSdrRatePreset(sdrRateBwCode).spanMhz;

  return (
    <div className="app-shell">
      <TopToolbar
        transport={transport}
        caps={caps}
        onConnect={() => void serialTransport.connect()}
        onDisconnect={() => void serialTransport.disconnect()}
        onStartDemo={() => void serialTransport.startDemo()}
        sdrStreaming={sdrStreaming}
        onToggleSdrStream={handleToggleSdrStream}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
      />

      <main className="main-workspace sdr-only-workspace">
        <SdrControlBar
          connected={transport.status === 'connected'}
          centerFreqMhz={sdrCenterFreqMhz}
          onCenterFreqChange={handleCenterFreqChange}
          rateBwCode={sdrRateBwCode}
          onRateBwChange={handleRateBwChange}
          fftLog2={sdrFftLog2}
          onFftLog2Change={setSdrFftLog2}
          targetFps={sdrTargetFps}
          onTargetFpsChange={setSdrTargetFps}
          maxHoldDetector={sdrMaxHoldDetector}
          onMaxHoldDetectorChange={setSdrMaxHoldDetector}
          subWindows={sdrSubWindows}
          onSubWindowsChange={setSdrSubWindows}
          dcNotch={sdrDcNotch}
          onDcNotchChange={setSdrDcNotch}
          spurBlanker={sdrSpurBlanker}
          onSpurBlankerChange={setSdrSpurBlanker}
          onClearPeakHold={() => {
            dspOptionsRef.current.clearNextPeak = true;
          }}
          sweepEnabled={sdrSweepEnabled}
          onToggleSweep={handleToggleSweep}
          gainIndex={sdrGainIndex}
          onGainIndexChange={handleGainIndexChange}
          adcClip={sdrAdcClip}
          loDivActive={sdrLoDivActive}
          captureTruncated={sdrCaptureTruncated}
          onOpenRawIq={handleOpenRawIq}
          onOpenScanner={handleOpenScanner}
        />
        <SdrSpectrumWaterfall
          trace={sdrTrace}
          centerFreqMhz={sdrCenterFreqMhz}
          spanMhz={sdrSpanMhz}
          fps={sdrFps}
          streaming={sdrStreaming}
          frameVersion={sdrFrameVersion}
        />
      </main>

      <RawIqInspector
        open={rawIqOpen}
        onClose={() => {
          setRawIqOpen(false);
          if (streamingContIq) {
            setStreamingContIq(false);
            setSdrStreaming(false);
            sendSdrStreamCtrl(SDR_STREAM_STOP, rawIqKb);
          }
        }}
        frame={rawIqFrame}
        iqKb={rawIqKb}
        onIqKbChange={setRawIqKb}
        streamingContIq={streamingContIq}
        onRequestSingleShot={handleRequestSingleIq}
        onToggleContIq={handleToggleContIq}
      />

      <WidebandScannerModal
        open={scannerOpen}
        onClose={() => {
          setScannerOpen(false);
          if (transport.status === 'connected') {
            sendSdrTune(sdrCenterFreqMhz, sdrRateBwCode, sdrGainIndex);
          }
        }}
        connected={transport.status === 'connected'}
        latestFrame={latestSdrFrame}
        frameVersion={sdrFrameVersion}
        invertSpectrum={transport.transport !== 'demo'}
        onRequestScanStep={handleRequestScanStep}
        onTuneAndInspect={handleTuneAndInspect}
      />

      <BottomDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        transportSnapshot={transport}
        caps={caps}
        serialTransport={serialTransport}
      />
    </div>
  );
};

export default App;
