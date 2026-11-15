import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomDrawer, DrawerTab } from './components/BottomDrawer';
import { ChannelStrip, ChannelUiState } from './components/ChannelStrip';
import { RawIqInspector } from './components/RawIqInspector';
import { SdrControlBar } from './components/SdrControlBar';
import { SdrSpectrumWaterfall } from './components/SdrSpectrumWaterfall';
import { TopToolbar } from './components/TopToolbar';
import { WaveformCanvas } from './components/WaveformCanvas';
import { SpectrumTraceState, updateSpectrumTraces } from './dsp/sdrDsp';
import { ProtocolDemuxer } from './protocol/ProtocolDemuxer';
import {
  buildLaAbortCmd,
  buildLaCaptureCmd,
  buildPinForceCmd,
  buildSdrStreamCtrlCmd,
  buildSdrSweepCfgCmd,
  buildSdrTuneCmd,
  clampSdrFreqMhz,
  resolveSdrRatePreset,
} from './protocol/codec';
import {
  DEFAULT_DECODER_CONFIG,
  DecoderConfig,
  DecoderKind,
  decodeProtocol,
} from './protocol/decoders';
import {
  AppMode,
  BoardCapabilitiesFrame,
  CaptureDataFrame,
  CHANNELS,
  PinForceMode,
  PinForceState,
  PinPullMode,
  RATE_PRESETS,
  SDR_DSP_FLAG_DC_CANCEL,
  SDR_DSP_FLAG_MAX_HOLD,
  SDR_GAIN_AGC,
  SDR_STREAM_CONT_IQ,
  SDR_STREAM_FFT,
  SDR_STREAM_SINGLE_IQ,
  SDR_STREAM_STOP,
  SdrRawIqFrame,
  SdrSpectrumFrame,
  StatusTelemetryFrame,
  TriggerMode,
} from './protocol/types';
import { SerialTransport, TransportSnapshot } from './transport/SerialTransport';

const DEFAULT_TELEMETRY: StatusTelemetryFrame = {
  type: 'telemetry',
  physicalLevels: 0,
  forceEnable: 0,
  forceEnableMask: 0,
  forcedLevel: 0,
  forcedLevels: 0,
  contentionMask: 0,
  timestampMs: 0,
};

function cfgToPinState(cfg: ChannelUiState): PinForceState {
  if (cfg.mode === 1) return '0';
  if (cfg.mode === 2) return '1';
  if (cfg.pull === 1) return 'PU';
  if (cfg.pull === 2) return 'PD';
  return 'Z';
}

export const App: React.FC = () => {
  const transportRef = useRef<SerialTransport | null>(null);
  if (!transportRef.current) {
    transportRef.current = new SerialTransport();
  }
  const serialTransport = transportRef.current;

  const terminalWriterRef = useRef<((bytes: Uint8Array) => void) | null>(null);
  const registerTerminalWriter = useCallback((writer: (bytes: Uint8Array) => void) => {
    terminalWriterRef.current = writer;
    return () => {
      if (terminalWriterRef.current === writer) {
        terminalWriterRef.current = null;
      }
    };
  }, []);

  const [transport, setTransport] = useState<TransportSnapshot>(() =>
    serialTransport.getSnapshot(),
  );
  const [caps, setCaps] = useState<BoardCapabilitiesFrame | null>(null);
  const [telemetry, setTelemetry] = useState<StatusTelemetryFrame | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('sdr');

  // Logic Analyzer state
  const [channelNames, setChannelNames] = useState<string[]>(() =>
    CHANNELS.map((c) => c.name),
  );
  const [channelConfigs, setChannelConfigs] = useState<ChannelUiState[]>(() =>
    Array.from({ length: 8 }, () => ({ mode: 0, pull: 0, protect: true })),
  );
  const [rateId, setRateId] = useState<number>(9);
  const [depthBlocksKb, setDepthBlocksKb] = useState<number>(16);
  const [trigCh, setTrigCh] = useState<number>(255);
  const [trigEdge, setTrigEdge] = useState<TriggerMode>('rising');
  const [preTrigRatio, setPreTrigRatio] = useState<number>(1);
  const [decoderConfig, setDecoderConfig] = useState<DecoderConfig>(
    DEFAULT_DECODER_CONFIG,
  );
  const [laCapturing, setLaCapturing] = useState<boolean>(false);
  const [captureFrame, setCaptureFrame] = useState<CaptureDataFrame | null>(null);

  // SDR state
  const [sdrStreaming, setSdrStreaming] = useState<boolean>(false);
  const [sdrCenterFreqMhz, setSdrCenterFreqMhz] = useState<number>(2437);
  const [sdrRateBwCode, setSdrRateBwCode] = useState<number>(0);
  const [sdrFftLog2, setSdrFftLog2] = useState<number>(10);
  const [sdrMaxHoldDetector, setSdrMaxHoldDetector] = useState<boolean>(false);
  const [sdrSubWindows, setSdrSubWindows] = useState<number>(4);
  const [sdrDcNotch, setSdrDcNotch] = useState<boolean>(true);
  const [sdrSpurBlanker, setSdrSpurBlanker] = useState<boolean>(false);
  const [sdrGainIndex, setSdrGainIndex] = useState<number>(SDR_GAIN_AGC);
  const [sdrTargetFps, setSdrTargetFps] = useState<number>(20);
  const [sdrSweepEnabled, setSdrSweepEnabled] = useState<boolean>(false);

  const [sdrActiveGain, setSdrActiveGain] = useState<number>(42);
  const [sdrAdcClip, setSdrAdcClip] = useState<boolean>(false);
  const [sdrLoDivActive, setSdrLoDivActive] = useState<boolean>(false);
  const [sdrCaptureTruncated, setSdrCaptureTruncated] = useState<boolean>(false);
  const [sdrTrace, setSdrTrace] = useState<SpectrumTraceState | null>(null);
  const [sdrFrameVersion, setSdrFrameVersion] = useState<number>(0);
  const [sdrFps, setSdrFps] = useState<number>(0);

  // Raw I/Q Inspector state
  const [rawIqOpen, setRawIqOpen] = useState<boolean>(false);
  const [rawIqFrame, setRawIqFrame] = useState<SdrRawIqFrame | null>(null);
  const [rawIqKb, setRawIqKb] = useState<number>(2);
  const [streamingContIq, setStreamingContIq] = useState<boolean>(false);

  // Bottom drawer state
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('terminal');

  const dspOptionsRef = useRef({
    dcNotch: sdrDcNotch,
    spurBlanker: sdrSpurBlanker,
    clearNextPeak: false,
  });
  dspOptionsRef.current.dcNotch = sdrDcNotch;
  dspOptionsRef.current.spurBlanker = sdrSpurBlanker;

  const lastSdrFrameTsRef = useRef<number>(0);

  useEffect(() => {
    const demuxer = new ProtocolDemuxer({
      onTerminalBytes: (bytes) => {
        terminalWriterRef.current?.(bytes);
      },
      onFrame: (frame) => {
        if (frame.type === 'capabilities') {
          setCaps(frame);
          if (!frame.sdrCapable) {
            setAppMode('la');
          }
        } else if (frame.type === 'telemetry') {
          setTelemetry(frame);
        } else if (frame.type === 'capture') {
          setCaptureFrame(frame);
          setLaCapturing(false);
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

          setSdrActiveGain(specFrame.activeGainIndex);
          setSdrAdcClip(specFrame.adcClip);
          setSdrLoDivActive(specFrame.loDivActive);
          setSdrCaptureTruncated(specFrame.captureTruncated);
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
                clearPeakHold: clearPeak,
              },
            );
          });
          setSdrFrameVersion((v) => v + 1);
        } else if (frame.type === 'sdrRawIq') {
          setRawIqFrame(frame);
          setSdrActiveGain(frame.activeGainIndex);
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
        setLaCapturing(false);
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

  const handleForceChannel = useCallback(
    (ch: number, mode: PinForceMode, pull: PinPullMode, protect = true) => {
      setChannelConfigs((prev) => {
        const next = [...prev];
        next[ch] = { mode, pull, protect };
        return next;
      });
      void serialTransport.writeBytes(
        buildPinForceCmd(ch, mode, pull, protect ? 1 : 0),
      );
    },
    [serialTransport],
  );

  const cyclePinForce = useCallback(
    (ch: number) => {
      const cur = channelConfigs[ch]?.mode ?? 0;
      const nextMode: PinForceMode = cur === 0 ? 2 : cur === 2 ? 1 : 0;
      handleForceChannel(ch, nextMode, 0, true);
    },
    [channelConfigs, handleForceChannel],
  );

  const handleAllZ = useCallback(() => {
    setChannelConfigs(
      Array.from({ length: 8 }, () => ({ mode: 0, pull: 0, protect: true })),
    );
    void serialTransport.writeBytes(buildPinForceCmd(0xff, 0, 0, 1));
  }, [serialTransport]);

  const pinForceStates = useMemo(
    () => channelConfigs.map(cfgToPinState),
    [channelConfigs],
  );

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

  const handleAppModeChange = useCallback(
    (nextMode: AppMode) => {
      if (nextMode === appMode) return;
      if (nextMode === 'la' && sdrStreaming) {
        setSdrStreaming(false);
        setStreamingContIq(false);
        sendSdrStreamCtrl(SDR_STREAM_STOP, sdrFftLog2);
      } else if (nextMode === 'sdr' && laCapturing) {
        setLaCapturing(false);
        void serialTransport.writeBytes(buildLaAbortCmd());
      }
      setAppMode(nextMode);
    },
    [
      appMode,
      sdrStreaming,
      laCapturing,
      sendSdrStreamCtrl,
      sdrFftLog2,
      serialTransport,
    ],
  );

  const handleStartCapture = useCallback(() => {
    if (sdrStreaming) {
      setSdrStreaming(false);
      setStreamingContIq(false);
      sendSdrStreamCtrl(SDR_STREAM_STOP, sdrFftLog2);
    }
    const edgeCode =
      trigEdge === 'rising' ? 0 : trigEdge === 'falling' ? 1 : trigEdge === 'high' ? 2 : 3;
    const packed = ((preTrigRatio & 0x03) << 4) | (edgeCode & 0x03);
    setLaCapturing(true);
    void serialTransport.writeBytes(
      buildLaCaptureCmd(rateId, trigCh, packed, depthBlocksKb),
    );
  }, [
    sdrStreaming,
    sendSdrStreamCtrl,
    sdrFftLog2,
    trigEdge,
    preTrigRatio,
    serialTransport,
    rateId,
    trigCh,
    depthBlocksKb,
  ]);

  const handleAbortCapture = useCallback(() => {
    setLaCapturing(false);
    void serialTransport.writeBytes(buildLaAbortCmd());
  }, [serialTransport]);

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
    if (laCapturing) {
      setLaCapturing(false);
      void serialTransport.writeBytes(buildLaAbortCmd());
    }
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
    laCapturing,
    serialTransport,
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

  const decodedFrames = useMemo(() => {
    if (!captureFrame) return [];
    return decodeProtocol(
      captureFrame.samples,
      captureFrame.sampleRateHz,
      decoderConfig,
    );
  }, [captureFrame, decoderConfig]);

  const activeRatePreset =
    RATE_PRESETS.find((r) => r.id === rateId) ?? RATE_PRESETS[5];
  const sdrSpanMhz = resolveSdrRatePreset(sdrRateBwCode).spanMhz;

  return (
    <div className="app-shell">
      <TopToolbar
        transport={transport}
        caps={caps}
        appMode={appMode}
        onAppModeChange={handleAppModeChange}
        onConnect={() => void serialTransport.connect()}
        onDisconnect={() => void serialTransport.disconnect()}
        onStartDemo={() => void serialTransport.startDemo()}
        onAllZ={handleAllZ}
        rateId={rateId}
        onRateChange={setRateId}
        depthBlocksKb={depthBlocksKb}
        onDepthChange={setDepthBlocksKb}
        trigCh={trigCh}
        onTrigChChange={setTrigCh}
        trigEdge={trigEdge}
        onTrigEdgeChange={setTrigEdge}
        preTrigRatio={preTrigRatio}
        onPreTrigRatioChange={setPreTrigRatio}
        decoderConfig={decoderConfig}
        onDecoderKindChange={(kind: DecoderKind) =>
          setDecoderConfig((prev) => ({ ...prev, kind }))
        }
        laCapturing={laCapturing}
        laProgressText={activeRatePreset.label}
        onStartCapture={handleStartCapture}
        onAbortCapture={handleAbortCapture}
        sdrStreaming={sdrStreaming}
        sdrTargetFps={sdrTargetFps}
        onSdrTargetFpsChange={setSdrTargetFps}
        onToggleSdrStream={handleToggleSdrStream}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
      />

      <main className="main-workspace">
        {appMode === 'la' ? (
          <div className="la-workspace">
            <div className="channel-strip-col">
              <ChannelStrip
                connected={transport.status === 'connected'}
                telemetry={telemetry ?? DEFAULT_TELEMETRY}
                channelConfigs={channelConfigs}
                channelLabels={channelNames}
                boardPins={caps?.pins}
                onForceChannel={handleForceChannel}
                onRenameChannel={(ch, alias) =>
                  setChannelNames((prev) => {
                    const next = [...prev];
                    next[ch] = alias || CHANNELS[ch].name;
                    return next;
                  })
                }
              />
            </div>
            <div className="waveform-col">
              <WaveformCanvas
                capture={captureFrame}
                capturing={laCapturing}
                decodedFrames={decodedFrames}
                channelLabels={channelNames}
              />
            </div>
          </div>
        ) : (
          <>
            <SdrControlBar
              connected={transport.status === 'connected'}
              centerFreqMhz={sdrCenterFreqMhz}
              onCenterFreqChange={handleCenterFreqChange}
              rateBwCode={sdrRateBwCode}
              onRateBwChange={handleRateBwChange}
              fftLog2={sdrFftLog2}
              onFftLog2Change={setSdrFftLog2}
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
              activeGainIndex={sdrActiveGain}
              adcClip={sdrAdcClip}
              loDivActive={sdrLoDivActive}
              captureTruncated={sdrCaptureTruncated}
              onOpenRawIq={handleOpenRawIq}
              telemetry={telemetry}
              pinForceStates={pinForceStates}
              onCyclePinForce={cyclePinForce}
              onAllZ={handleAllZ}
            />
            <SdrSpectrumWaterfall
              trace={sdrTrace}
              centerFreqMhz={sdrCenterFreqMhz}
              spanMhz={sdrSpanMhz}
              fps={sdrFps}
              streaming={sdrStreaming}
              frameVersion={sdrFrameVersion}
            />
          </>
        )}
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

      <BottomDrawer
        open={drawerOpen}
        activeTab={drawerTab}
        onTabChange={setDrawerTab}
        onClose={() => setDrawerOpen(false)}
        transportSnapshot={transport}
        caps={caps}
        serialTransport={serialTransport}
        registerTerminalWriter={registerTerminalWriter}
      />
    </div>
  );
};

export default App;
