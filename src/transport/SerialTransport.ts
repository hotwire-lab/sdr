import {
  buildGetCapsCmd,
  buildPingStatusCmd,
  clampSdrFreqMhz,
  encodeResponseFrame,
  resolveSdrRatePreset,
} from '../protocol/codec';
import {
  CMD_BOOTLOADER,
  CMD_GET_CAPS,
  CMD_PING_STATUS,
  CMD_SDR_STREAM_CTRL,
  CMD_SDR_SWEEP_CFG,
  CMD_SDR_TUNE,
  PROTOCOL_SYNC_0,
  PROTOCOL_SYNC_1,
  SDR_DSP_FLAG_DC_CANCEL,
  SDR_FLAG_ADC_CLIP,
  SDR_FLAG_LO_DIV_ACTIVE,
  SDR_GAIN_AGC,
  SDR_LO_DIVIDER_THRESHOLD_MHZ,
  SDR_STREAM_CONT_IQ,
  SDR_STREAM_FFT,
  SDR_STREAM_SINGLE_IQ,
  SDR_STREAM_STOP,
  TYPE_BOARD_CAPABILITIES,
  TYPE_SDR_RAW_IQ_FRAME,
  TYPE_SDR_SPECTRUM_FRAME,
} from '../protocol/types';
import {
  ScreenWakeLockSentinel,
  WebSerialPort,
  WebUSBDevice,
  WebUSBDeviceFilter,
} from './web-apis';

export type TransportKind = 'none' | 'webserial' | 'webusb' | 'demo';
export type ConnectionStatus = 'waiting' | 'connecting' | 'connected';

export interface TransportSnapshot {
  status: ConnectionStatus;
  transport: TransportKind;
  deviceName: string;
  vidPid: string;
  errorMessage: string | null;
}

export type TransportStateListener = (snapshot: TransportSnapshot) => void;
export type TransportBytesListener = (bytes: Uint8Array) => void;

export const WEBUSB_FILTERS: WebUSBDeviceFilter[] = [
  { vendorId: 0x303a },
  { vendorId: 0x2886 },
  { classCode: 2, subclassCode: 2 },
  { classCode: 239, subclassCode: 2, protocolCode: 1 },
];

export interface CdcEndpointDescriptor {
  controlInterfaceNumber: number;
  dataInterfaceNumber: number;
  inEndpointNumber: number;
  outEndpointNumber: number;
  inPacketSize: number;
}

function formatVidPid(vid?: number, pid?: number): string {
  if (!vid && !pid) return '';
  const v = (vid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const p = (pid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  return `${v}:${p}`;
}

export function encodeCdcLineCoding(baudRate = 921600): Uint8Array {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, 0);
  view.setUint8(5, 0);
  view.setUint8(6, 8);
  return new Uint8Array(buf);
}

export function findCdcEndpoints(device: WebUSBDevice): CdcEndpointDescriptor | null {
  const config = device.configuration ?? device.configurations[0];
  if (!config) return null;

  const interfaces = config.interfaces;
  for (let i = 0; i < interfaces.length; i++) {
    const iface = interfaces[i];
    const alt = iface.alternate;

    if (alt.interfaceClass === 0xff) {
      continue;
    }

    let inEp: number | null = null;
    let outEp: number | null = null;
    let inPacketSize = 64;

    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in' && inEp === null) {
        inEp = ep.endpointNumber;
        inPacketSize = ep.packetSize || 64;
      }
      if (ep.direction === 'out' && outEp === null) {
        outEp = ep.endpointNumber;
      }
    }

    if (inEp !== null && outEp !== null) {
      let controlIface = iface.interfaceNumber;
      if (alt.interfaceClass === 10) {
        for (let j = i - 1; j >= 0; j--) {
          if (interfaces[j].alternate.interfaceClass === 2) {
            controlIface = interfaces[j].interfaceNumber;
            break;
          }
        }
      }
      return {
        controlInterfaceNumber: controlIface,
        dataInterfaceNumber: iface.interfaceNumber,
        inEndpointNumber: inEp,
        outEndpointNumber: outEp,
        inPacketSize,
      };
    }
  }

  return null;
}

export function detectPreferredBackend(): 'webserial' | 'webusb' | 'none' {
  if (typeof navigator === 'undefined') return 'none';
  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hasWebSerial = 'serial' in navigator && Boolean(navigator.serial);
  const hasWebUSB = 'usb' in navigator && Boolean(navigator.usb);

  if (isMobile && hasWebUSB) return 'webusb';
  if (hasWebSerial) return 'webserial';
  if (hasWebUSB) return 'webusb';
  return 'none';
}

export class SerialTransport {
  private snapshot: TransportSnapshot = {
    status: 'waiting',
    transport: 'none',
    deviceName: 'Waiting for USB...',
    vidPid: '',
    errorMessage: null,
  };

  private stateListeners = new Set<TransportStateListener>();
  private bytesListeners = new Set<TransportBytesListener>();

  private webSerialPort: WebSerialPort | null = null;
  private webSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private webSerialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  private webUsbDevice: WebUSBDevice | null = null;
  private webUsbDesc: CdcEndpointDescriptor | null = null;
  private webUsbReadActive = false;

  // Demo hardware simulator state (SDR RF)
  private demoSdrTimer: number | null = null;
  private demoAsciiLine = '';

  private demoSdrCenterMhz = 2437;
  private demoSdrRateBwCode = 1;
  private demoSdrGainIndex = 42;
  private demoSdrStreamMode = SDR_STREAM_STOP;
  private demoSdrFftLog2 = 10;
  private demoSdrIqKb = 2;
  private demoSdrDspFlags = SDR_DSP_FLAG_DC_CANCEL;
  private demoSdrTargetFps = 20;
  private demoSdrSweepStartMhz = 2400;
  private demoSdrSweepSteps = 0;
  private demoSdrSweepDwell = 3;
  private demoSdrSweepStepIdx = 0;
  private demoSdrSweepDwellCounter = 0;
  private demoSdrFrameCounter = 0;

  private wakeLockSentinel: ScreenWakeLockSentinel | null = null;
  private sessionEpoch = 0;
  private listenersAttached = false;
  private autoReconnectPaused = false;

  private readonly onHardwareConnect = () => {
    if (this.autoReconnectPaused) return;
    if (this.snapshot.status === 'waiting') {
      void this.probeAuthorizedDevices();
    }
  };

  private readonly onHardwareDisconnect = (ev: Event) => {
    if (this.snapshot.transport === 'webusb') {
      const usbEv = ev as Event & { device?: WebUSBDevice };
      if (!usbEv.device || usbEv.device === this.webUsbDevice) {
        void this.handleDisconnect('USB device unplugged');
      }
    } else if (this.snapshot.transport === 'webserial') {
      const serEv = ev as Event & { target?: WebSerialPort };
      if (!serEv.target || serEv.target === this.webSerialPort) {
        void this.handleDisconnect('Serial port disconnected');
      }
    }
  };

  init(): void {
    if (this.listenersAttached || typeof navigator === 'undefined') return;
    this.listenersAttached = true;

    navigator.serial?.addEventListener('connect', this.onHardwareConnect);
    navigator.serial?.addEventListener('disconnect', this.onHardwareDisconnect);
    navigator.usb?.addEventListener('connect', this.onHardwareConnect);
    navigator.usb?.addEventListener('disconnect', this.onHardwareDisconnect);

    void this.probeAuthorizedDevices();
  }

  destroy(): void {
    if (this.listenersAttached && typeof navigator !== 'undefined') {
      navigator.serial?.removeEventListener('connect', this.onHardwareConnect);
      navigator.serial?.removeEventListener('disconnect', this.onHardwareDisconnect);
      navigator.usb?.removeEventListener('connect', this.onHardwareConnect);
      navigator.usb?.removeEventListener('disconnect', this.onHardwareDisconnect);
      this.listenersAttached = false;
    }
    void this.disconnect();
  }

  onStateChange(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    listener({ ...this.snapshot });
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onBytes(listener: TransportBytesListener): () => void {
    this.bytesListeners.add(listener);
    return () => {
      this.bytesListeners.delete(listener);
    };
  }

  getSnapshot(): TransportSnapshot {
    return { ...this.snapshot };
  }

  getActiveWebSerialPort(): WebSerialPort | null {
    return this.webSerialPort;
  }

  getActiveWebUsbDevice(): WebUSBDevice | null {
    return this.webUsbDevice;
  }

  setAutoReconnectPaused(paused: boolean): void {
    this.autoReconnectPaused = paused;
  }

  async connectWebSerialPort(port: WebSerialPort): Promise<void> {
    await this.openWebSerialPort(port);
  }

  async connectWebUsbDevice(device: WebUSBDevice): Promise<void> {
    await this.openWebUsbDevice(device);
  }

  async probeAuthorizedDevices(): Promise<void> {
    if (
      this.autoReconnectPaused ||
      this.snapshot.status === 'connected' ||
      this.snapshot.status === 'connecting'
    ) {
      return;
    }
    const preferred = detectPreferredBackend();

    try {
      if (preferred === 'webserial' && navigator.serial) {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          await this.openWebSerialPort(ports[0]);
          return;
        }
      }
      if (navigator.usb) {
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
          await this.openWebUsbDevice(devices[0]);
        }
      }
    } catch {
      // Ignore silent auto-probe error
    }
  }

  async connect(overrideBackend?: 'webserial' | 'webusb'): Promise<void> {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: 'Web Serial and WebUSB require HTTPS or localhost.',
      });
      return;
    }

    const backend = overrideBackend ?? detectPreferredBackend();
    if (backend === 'none') {
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage:
          'Web Serial / WebUSB is unavailable in this browser. Try Chrome or Edge, or use Demo.',
      });
      return;
    }

    try {
      if (backend === 'webserial' && navigator.serial) {
        const port = await navigator.serial.requestPort();
        await this.openWebSerialPort(port);
      } else if (navigator.usb) {
        const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
        await this.openWebUsbDevice(device);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('No port selected') ||
        msg.includes('No device selected') ||
        msg.includes('NotFoundError')
      ) {
        this.updateSnapshot({ errorMessage: null });
      } else {
        this.updateSnapshot({
          status: 'waiting',
          transport: 'none',
          deviceName: 'Waiting for USB...',
          vidPid: '',
          errorMessage: msg,
        });
      }
    }
  }

  async disconnect(preservePortReference = false): Promise<WebSerialPort | null> {
    this.sessionEpoch += 1;
    const prevPort = this.webSerialPort;
    await this.closeAllHandles(preservePortReference);
    await this.releaseWakeLock();

    this.updateSnapshot({
      status: 'waiting',
      transport: 'none',
      deviceName: 'Waiting for USB...',
      vidPid: '',
      errorMessage: null,
    });
    return prevPort;
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || this.snapshot.status !== 'connected') return;

    if (this.snapshot.transport === 'demo') {
      this.handleDemoTx(bytes);
      return;
    }

    if (this.snapshot.transport === 'webusb' && this.webUsbDevice && this.webUsbDesc) {
      await this.webUsbDevice.transferOut(
        this.webUsbDesc.outEndpointNumber,
        bytes as unknown as BufferSource,
      );
      return;
    }

    if (this.snapshot.transport === 'webserial' && this.webSerialWriter) {
      await this.webSerialWriter.write(bytes);
    }
  }

  async startDemo(): Promise<void> {
    await this.closeAllHandles(false);
    this.demoAsciiLine = '';

    this.demoSdrCenterMhz = 2437;
    this.demoSdrRateBwCode = 1;
    this.demoSdrGainIndex = 42;
    this.demoSdrStreamMode = SDR_STREAM_STOP;
    this.demoSdrFftLog2 = 10;
    this.demoSdrIqKb = 2;
    this.demoSdrDspFlags = SDR_DSP_FLAG_DC_CANCEL;
    this.demoSdrTargetFps = 20;
    this.demoSdrSweepSteps = 0;
    this.demoSdrFrameCounter = 0;

    this.updateSnapshot({
      status: 'connected',
      transport: 'demo',
      deviceName: 'HotWire SDR (Demo Simulator)',
      vidPid: '303A:1001',
      errorMessage: null,
    });

    this.emitDemoCaps();
    this.emitBytes(
      new TextEncoder().encode(
        '\r\n\x1b[32m[Demo] Simulated XIAO-ESP32-S3 SDR ready.\x1b[0m\r\n' +
          'Type \x1b[33mhelp\x1b[0m, \x1b[33msdr status\x1b[0m, or \x1b[33mtune 1910\x1b[0m.\r\n',
      ),
    );
  }

  private async openWebSerialPort(port: WebSerialPort): Promise<void> {
    await this.closeAllHandles(false);
    const epoch = ++this.sessionEpoch;

    const info = port.getInfo();
    const vidPid = formatVidPid(info.usbVendorId, info.usbProductId);

    this.updateSnapshot({
      status: 'connecting',
      transport: 'webserial',
      deviceName: 'Connecting...',
      vidPid,
      errorMessage: null,
    });

    try {
      await port.open({
        baudRate: 921600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 131072,
      });

      if (epoch !== this.sessionEpoch) {
        try {
          await port.close();
        } catch {
          // Ignore close error on superseded session
        }
        return;
      }

      try {
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch {
        // Ignore on virtual ports
      }

      this.webSerialPort = port;
      if (port.writable) {
        this.webSerialWriter = port.writable.getWriter();
      }

      this.updateSnapshot({
        status: 'connected',
        transport: 'webserial',
        deviceName: 'HotWire SDR USB',
        vidPid,
        errorMessage: null,
      });

      void this.acquireWakeLock();
      void this.runWebSerialReadLoop(port, epoch);

      await this.writeBytes(buildGetCapsCmd());
      await this.writeBytes(buildPingStatusCmd());
      window.setTimeout(() => {
        if (epoch === this.sessionEpoch && this.snapshot.status === 'connected') {
          void this.writeBytes(buildGetCapsCmd());
          void this.writeBytes(buildPingStatusCmd());
        }
      }, 250);
    } catch (err) {
      await this.closeAllHandles(false);
      const msg = err instanceof Error ? err.message : String(err);
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: `Failed to open serial port: ${msg}`,
      });
    }
  }

  private async runWebSerialReadLoop(port: WebSerialPort, epoch: number): Promise<void> {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    this.webSerialReader = reader;

    try {
      while (epoch === this.sessionEpoch) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this.emitBytes(value);
        }
      }
    } catch (err) {
      if (epoch === this.sessionEpoch) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.handleDisconnect(msg);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore already released
      }
      if (this.webSerialReader === reader) {
        this.webSerialReader = null;
      }
    }
  }

  private async openWebUsbDevice(device: WebUSBDevice): Promise<void> {
    await this.closeAllHandles(false);
    const epoch = ++this.sessionEpoch;
    const vidPid = formatVidPid(device.vendorId, device.productId);

    this.updateSnapshot({
      status: 'connecting',
      transport: 'webusb',
      deviceName: device.productName?.trim() || 'Connecting USB...',
      vidPid,
      errorMessage: null,
    });

    try {
      if (!device.opened) {
        await device.open();
      }
      if (!device.configuration) {
        await device.selectConfiguration(1);
      }
      if (epoch !== this.sessionEpoch) return;

      const desc = findCdcEndpoints(device);
      if (!desc) {
        await device.close();
        this.updateSnapshot({
          status: 'waiting',
          transport: 'none',
          deviceName: 'Waiting for USB...',
          vidPid: '',
          errorMessage: 'No USB CDC-ACM bulk endpoints found on selected device.',
        });
        return;
      }

      if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
        try {
          await device.claimInterface(desc.controlInterfaceNumber);
        } catch {
          // Optional
        }
      }
      await device.claimInterface(desc.dataInterfaceNumber);
      if (epoch !== this.sessionEpoch) return;

      try {
        await device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: desc.controlInterfaceNumber,
          },
          encodeCdcLineCoding(921600) as unknown as BufferSource,
        );
      } catch {
        // Optional
      }

      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x0003,
        index: desc.controlInterfaceNumber,
      });

      this.webUsbDevice = device;
      this.webUsbDesc = desc;

      this.updateSnapshot({
        status: 'connected',
        transport: 'webusb',
        deviceName: device.productName?.trim() || 'HotWire SDR USB',
        vidPid,
        errorMessage: null,
      });

      void this.acquireWakeLock();
      this.webUsbReadActive = true;
      void this.runWebUsbReadLoop(device, desc, epoch);

      await this.writeBytes(buildGetCapsCmd());
      await this.writeBytes(buildPingStatusCmd());
      window.setTimeout(() => {
        if (epoch === this.sessionEpoch && this.snapshot.status === 'connected') {
          void this.writeBytes(buildGetCapsCmd());
          void this.writeBytes(buildPingStatusCmd());
        }
      }, 250);
    } catch (err) {
      await this.closeAllHandles(false);
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.toLowerCase().includes('claim')
        ? `${msg} (Close Arduino IDE / Serial Monitor or use Web Serial on Desktop.)`
        : msg;
      this.updateSnapshot({
        status: 'waiting',
        transport: 'none',
        deviceName: 'Waiting for USB...',
        vidPid: '',
        errorMessage: hint,
      });
    }
  }

  private async runWebUsbReadLoop(
    device: WebUSBDevice,
    desc: CdcEndpointDescriptor,
    epoch: number,
  ): Promise<void> {
    const readSize = Math.max(64, desc.inPacketSize);
    while (this.webUsbReadActive && epoch === this.sessionEpoch && device.opened) {
      try {
        const result = await device.transferIn(desc.inEndpointNumber, readSize);
        if (!this.webUsbReadActive || epoch !== this.sessionEpoch) break;
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          const chunk = new Uint8Array(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength,
          );
          this.emitBytes(chunk);
        }
      } catch (err) {
        if (this.webUsbReadActive && epoch === this.sessionEpoch) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.handleDisconnect(msg);
        }
        break;
      }
    }
  }

  private async handleDisconnect(errorMessage: string): Promise<void> {
    this.sessionEpoch += 1;
    await this.closeAllHandles(false);
    await this.releaseWakeLock();

    this.updateSnapshot({
      status: 'waiting',
      transport: 'none',
      deviceName: 'Waiting for USB...',
      vidPid: '',
      errorMessage,
    });
  }

  private async closeAllHandles(preserveSerialPortRef: boolean): Promise<void> {
    if (this.demoSdrTimer !== null) {
      window.clearInterval(this.demoSdrTimer);
      this.demoSdrTimer = null;
    }
    this.webUsbReadActive = false;

    if (this.webSerialReader) {
      try {
        await this.webSerialReader.cancel();
      } catch {
        // Ignore
      }
      try {
        this.webSerialReader.releaseLock();
      } catch {
        // Ignore
      }
      this.webSerialReader = null;
    }

    if (this.webSerialWriter) {
      try {
        this.webSerialWriter.releaseLock();
      } catch {
        // Ignore
      }
      this.webSerialWriter = null;
    }

    if (this.webSerialPort) {
      const port = this.webSerialPort;
      if (!preserveSerialPortRef) {
        this.webSerialPort = null;
      }
      try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch {
        // Ignore
      }
      try {
        await port.close();
      } catch {
        // Ignore
      }
    }

    if (this.webUsbDevice) {
      const dev = this.webUsbDevice;
      const desc = this.webUsbDesc;
      this.webUsbDevice = null;
      this.webUsbDesc = null;

      if (desc) {
        try {
          await dev.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22,
            value: 0x0000,
            index: desc.controlInterfaceNumber,
          });
        } catch {
          // Ignore
        }
        try {
          await dev.releaseInterface(desc.dataInterfaceNumber);
        } catch {
          // Ignore
        }
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try {
            await dev.releaseInterface(desc.controlInterfaceNumber);
          } catch {
            // Ignore
          }
        }
      }
      try {
        if (dev.opened) {
          await dev.close();
        }
      } catch {
        // Ignore
      }
    }
  }

  private handleDemoTx(bytes: Uint8Array): void {
    if (
      bytes.byteLength >= 8 &&
      bytes[0] === PROTOCOL_SYNC_0 &&
      bytes[1] === PROTOCOL_SYNC_1
    ) {
      const cmdId = bytes[2];
      const p1 = bytes[3];
      const p2 = bytes[4];
      const p3 = bytes[5];
      const p4 = bytes[6];

      switch (cmdId) {
        case CMD_PING_STATUS:
          this.emitDemoCaps();
          return;

        case CMD_GET_CAPS:
          this.emitDemoCaps();
          return;

        case CMD_SDR_TUNE: {
          const reqFreq = p1 | (p2 << 8);
          this.demoSdrCenterMhz = clampSdrFreqMhz(reqFreq);
          this.demoSdrRateBwCode = p3 & 0x03;
          this.demoSdrGainIndex = p4;
          return;
        }

        case CMD_SDR_SWEEP_CFG: {
          const startFreq = p1 | (p2 << 8);
          this.demoSdrSweepStartMhz = clampSdrFreqMhz(startFreq);
          this.demoSdrSweepSteps = p3;
          this.demoSdrSweepDwell = Math.max(1, p4);
          this.demoSdrSweepStepIdx = 0;
          this.demoSdrSweepDwellCounter = 0;
          if (p3 > 0) {
            this.demoSdrCenterMhz = this.demoSdrSweepStartMhz;
          }
          return;
        }

        case CMD_SDR_STREAM_CTRL: {
          this.demoSdrStreamMode = p1;
          if (p1 === SDR_STREAM_SINGLE_IQ) {
            this.demoSdrIqKb = Math.max(1, Math.min(16, p2));
            this.demoSdrDspFlags = p3;
            this.emitDemoSdrRawIq();
            this.demoSdrStreamMode = SDR_STREAM_STOP;
            return;
          }
          if (p1 === SDR_STREAM_STOP) {
            this.stopDemoSdrTimer();
            return;
          }
          if (p1 === SDR_STREAM_CONT_IQ) {
            this.demoSdrIqKb = Math.max(1, Math.min(16, p2));
          } else {
            this.demoSdrFftLog2 = Math.max(8, Math.min(11, p2));
          }
          this.demoSdrDspFlags = p3;
          this.demoSdrTargetFps = Math.max(5, Math.min(60, p4 || 20));
          this.startDemoSdrTimer();
          return;
        }

        case CMD_BOOTLOADER:
          this.stopDemoSdrTimer();
          this.demoSdrStreamMode = SDR_STREAM_STOP;
          this.emitBytes(
            new TextEncoder().encode(
              '\r\n\x1b[33m[Demo] Simulated 0xF0 CMD_BOOTLOADER received.\x1b[0m\r\n',
            ),
          );
          return;
      }
    }

    const text = new TextDecoder().decode(bytes);
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.demoAsciiLine.trim();
        this.demoAsciiLine = '';
        this.handleDemoAsciiCommand(cmd);
      } else {
        this.demoAsciiLine += ch;
      }
    }
  }

  private handleDemoAsciiCommand(cmd: string): void {
    if (cmd === 'help') {
      this.emitBytes(
        new TextEncoder().encode(
          '\r\nSDR Demo Commands: help, sdr status, sdr stop, tune <MHz>, version\r\n',
        ),
      );
    } else if (cmd === 'sdr status') {
      const ratePreset = resolveSdrRatePreset(this.demoSdrRateBwCode);
      const loDiv = this.demoSdrCenterMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ ? 'ON (5/6)' : 'OFF (1/1)';
      this.emitBytes(
        new TextEncoder().encode(
          `\r\n[SDR] freq=${this.demoSdrCenterMhz} MHz | span=${ratePreset.label} | gain=${this.demoSdrGainIndex === SDR_GAIN_AGC ? 'AGC' : this.demoSdrGainIndex} | LO_DIV=${loDiv} | mode=${this.demoSdrStreamMode}\r\n`,
        ),
      );
    } else if (cmd === 'sdr stop') {
      this.stopDemoSdrTimer();
      this.demoSdrStreamMode = SDR_STREAM_STOP;
      this.emitBytes(new TextEncoder().encode('\r\n[SDR] Stream stopped.\r\n'));
    } else if (cmd.startsWith('tune ')) {
      const mhz = Number(cmd.split(/\s+/)[1]);
      if (!Number.isNaN(mhz)) {
        this.demoSdrCenterMhz = clampSdrFreqMhz(mhz);
        this.emitBytes(
          new TextEncoder().encode(`\r\n[SDR] Tuned to ${this.demoSdrCenterMhz} MHz.\r\n`),
        );
      }
    } else if (cmd === 'version') {
      this.emitBytes(
        new TextEncoder().encode('\r\nHotWire-SDR-XIAO-ESP32S3 Demo v2.0.0\r\n'),
      );
    } else if (cmd.length > 0) {
      this.emitBytes(new TextEncoder().encode(`\r\nUnknown demo command: ${cmd}\r\n`));
    }
  }

  private startDemoSdrTimer(): void {
    this.stopDemoSdrTimer();
    const epoch = this.sessionEpoch;
    const intervalMs = Math.max(16, Math.round(1000 / this.demoSdrTargetFps));
    if (this.demoSdrStreamMode === SDR_STREAM_CONT_IQ) {
      this.emitDemoSdrRawIq();
    } else {
      this.emitDemoSdrSpectrum();
    }
    this.demoSdrTimer = window.setInterval(() => {
      if (epoch !== this.sessionEpoch) return;
      if (this.demoSdrStreamMode === SDR_STREAM_CONT_IQ) {
        this.emitDemoSdrRawIq();
      } else if (this.demoSdrStreamMode === SDR_STREAM_FFT) {
        this.emitDemoSdrSpectrum();
      }
    }, intervalMs);
  }

  private stopDemoSdrTimer(): void {
    if (this.demoSdrTimer !== null) {
      window.clearInterval(this.demoSdrTimer);
      this.demoSdrTimer = null;
    }
  }

  private getDemoRfEmitters(t: number): Array<{
    freqMhz: number;
    bwMhz: number;
    peakDbFs: number;
    shape: 'ofdm' | 'narrow' | 'spur';
  }> {
    const emitters: Array<{
      freqMhz: number;
      bwMhz: number;
      peakDbFs: number;
      shape: 'ofdm' | 'narrow' | 'spur';
    }> = [];

    // Wi-Fi Channels 1, 6, 11 with realistic burst pulsing
    const ch6Pulse = (t % 7) !== 0 ? 1 : 0.25;
    emitters.push({
      freqMhz: 2437,
      bwMhz: 18,
      peakDbFs: -34 * (1 / ch6Pulse) > -85 ? (ch6Pulse > 0.5 ? -34 : -74) : -74,
      shape: 'ofdm',
    });
    if (t % 11 < 6) {
      emitters.push({ freqMhz: 2412, bwMhz: 18, peakDbFs: -48, shape: 'ofdm' });
    }
    if ((t + 4) % 13 < 7) {
      emitters.push({ freqMhz: 2462, bwMhz: 18, peakDbFs: -52, shape: 'ofdm' });
    }

    // BLE Advertising channels hopping (37, 38, 39)
    const bleCh = [2402, 2426, 2480][t % 3];
    emitters.push({ freqMhz: bleCh, bwMhz: 1.4, peakDbFs: -39, shape: 'narrow' });
    emitters.push({ freqMhz: 2402, bwMhz: 1.2, peakDbFs: -62, shape: 'narrow' });

    // DECT 1.9 GHz European Allocation (1880–1900 MHz, triggers 5/6 LO divider)
    emitters.push({ freqMhz: 1885, bwMhz: 1.6, peakDbFs: -42, shape: 'narrow' });
    emitters.push({ freqMhz: 1891, bwMhz: 1.6, peakDbFs: -46, shape: 'narrow' });
    if (t % 5 < 3) {
      emitters.push({ freqMhz: 1897, bwMhz: 1.6, peakDbFs: -51, shape: 'narrow' });
    }

    // 13cm Ham ATV / Beacon
    emitters.push({ freqMhz: 2350, bwMhz: 2.2, peakDbFs: -44, shape: 'narrow' });

    // LTE Band 7 Downlink wideband plateau (2620–2690 MHz)
    emitters.push({ freqMhz: 2655, bwMhz: 18, peakDbFs: -45, shape: 'ofdm' });

    return emitters;
  }

  private emitDemoSdrSpectrum(): void {
    this.demoSdrFrameCounter += 1;
    if (this.demoSdrSweepSteps > 0) {
      this.demoSdrSweepDwellCounter += 1;
      if (this.demoSdrSweepDwellCounter >= this.demoSdrSweepDwell) {
        this.demoSdrSweepDwellCounter = 0;
        this.demoSdrSweepStepIdx = (this.demoSdrSweepStepIdx + 1) % this.demoSdrSweepSteps;
        this.demoSdrCenterMhz = clampSdrFreqMhz(
          this.demoSdrSweepStartMhz + this.demoSdrSweepStepIdx * 40,
        );
      }
    }

    const ratePreset = resolveSdrRatePreset(this.demoSdrRateBwCode);
    const fftBins = 1 << Math.max(8, Math.min(11, this.demoSdrFftLog2));
    const centerMhz = this.demoSdrCenterMhz;
    const spanMhz = ratePreset.spanMhz;
    const dcCancel = (this.demoSdrDspFlags & SDR_DSP_FLAG_DC_CANCEL) !== 0;
    const manualGain = this.demoSdrGainIndex === SDR_GAIN_AGC ? 42 : this.demoSdrGainIndex;
    const gainDeltaDb = (manualGain - 42) * 0.65;
    const emitters = this.getDemoRfEmitters(this.demoSdrFrameCounter);

    let peakObservedDb = -120;
    const bins = new Float32Array(fftBins);
    const baseNoise = -98 + gainDeltaDb * 0.45;

    for (let i = 0; i < fftBins; i++) {
      const freqMhz = centerMhz + ((i - fftBins / 2) * spanMhz) / fftBins;
      // Pseudo-thermal variance + roll-off at filter edges
      const edgeNorm = Math.abs((i - fftBins / 2) / (fftBins / 2));
      const filterDrop = edgeNorm > 0.85 ? (edgeNorm - 0.85) * 32 : 0;
      const noiseJitter =
        Math.sin(i * 1.73 + this.demoSdrFrameCounter * 2.13) * 1.8 +
        Math.cos(i * 4.31 - this.demoSdrFrameCounter * 3.71) * 1.4;
      let val = baseNoise + noiseJitter - filterDrop;

      for (const em of emitters) {
        const df = Math.abs(freqMhz - em.freqMhz);
        const halfBw = em.bwMhz * 0.5;
        if (em.shape === 'ofdm') {
          if (df < halfBw + 5) {
            const flat =
              df <= halfBw
                ? em.peakDbFs + Math.sin(i * 0.9 + this.demoSdrFrameCounter) * 1.3
                : em.peakDbFs - (df - halfBw) * 8.5;
            val = Math.max(val, flat + gainDeltaDb);
          }
        } else if (em.shape === 'narrow') {
          const sigma = em.bwMhz * 0.35;
          const gauss = em.peakDbFs - ((df * df) / (2 * sigma * sigma)) * 12;
          val = Math.max(val, gauss + gainDeltaDb);
        } else if (df < 0.7) {
          const spurVal = em.peakDbFs - df * 36;
          val = Math.max(val, spurVal + gainDeltaDb * 0.5);
        }
      }

      // Clock spur for testing Spur Blanker
      if (i === Math.floor(fftBins * 0.72)) {
        val = Math.max(val, -44 + gainDeltaDb * 0.3);
      }

      // LO / DC leakage spike at center bin unless DC Cancel is enabled
      if (i === fftBins / 2 && !dcCancel) {
        val = Math.max(val, -30 + gainDeltaDb * 0.25);
      } else if (i === fftBins / 2 && dcCancel) {
        val = Math.max(val, val + 3.5);
      }

      const clamped = Math.max(-127.5, Math.min(0, val));
      bins[i] = clamped;
      if (clamped > peakObservedDb) peakObservedDb = clamped;
    }

    const clipped =
      this.demoSdrGainIndex !== SDR_GAIN_AGC && manualGain >= 62 && peakObservedDb > -12;
    const effectiveGain =
      this.demoSdrGainIndex === SDR_GAIN_AGC
        ? Math.max(6, Math.min(64, Math.round(42 - Math.max(-20, peakObservedDb + 35) * 0.4)))
        : manualGain;

    let statusFlags = 0;
    if (clipped) statusFlags |= SDR_FLAG_ADC_CLIP;
    if (centerMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ) statusFlags |= SDR_FLAG_LO_DIV_ACTIVE;

    const payload = new Uint8Array(8 + fftBins);
    const view = new DataView(payload.buffer);
    view.setUint16(0, centerMhz, true);
    payload[2] = this.demoSdrRateBwCode & 0x03;
    payload[3] = effectiveGain & 0xff;
    view.setUint16(4, fftBins, true);
    payload[6] = statusFlags;
    payload[7] = 0;

    for (let i = 0; i < fftBins; i++) {
      const encoded = Math.max(0, Math.min(255, Math.round((bins[i] + 127.5) * 2)));
      payload[8 + i] = encoded;
    }

    this.emitBytes(encodeResponseFrame(TYPE_SDR_SPECTRUM_FRAME, payload));
  }

  private emitDemoSdrRawIq(): void {
    this.demoSdrFrameCounter += 1;
    const sampleCount = Math.max(256, Math.min(4096, this.demoSdrIqKb * 1024));
    const manualGain = this.demoSdrGainIndex === SDR_GAIN_AGC ? 42 : this.demoSdrGainIndex;
    const gainScale = Math.pow(10, (manualGain - 42) / 36);
    const dcCancel = (this.demoSdrDspFlags & SDR_DSP_FLAG_DC_CANCEL) !== 0;
    const dcOffsetI = dcCancel ? 0 : 12;
    const dcOffsetQ = dcCancel ? 0 : -9;

    const payload = new Uint8Array(8 + sampleCount * 2);
    const view = new DataView(payload.buffer);
    let statusFlags = 0;
    if (this.demoSdrCenterMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ) {
      statusFlags |= SDR_FLAG_LO_DIV_ACTIVE;
    }

    let clipped = false;
    const isSub2210 = this.demoSdrCenterMhz < SDR_LO_DIVIDER_THRESHOLD_MHZ;

    for (let n = 0; n < sampleCount; n++) {
      const t = n / sampleCount;
      // Symbol-modulated QPSK / FSK + ambient noise
      const sym = Math.floor(n / 16) + this.demoSdrFrameCounter;
      const qpskPhase = (((sym * 3) ^ (sym >> 2)) & 3) * (Math.PI / 2) + Math.PI / 4;
      const fskOmega = 2 * Math.PI * (isSub2210 ? 22 : 14) * t;
      const carrierAmp = isSub2210 ? 44 : 40;

      const sigI = carrierAmp * Math.cos(fskOmega + qpskPhase);
      const sigQ = carrierAmp * Math.sin(fskOmega + qpskPhase);

      const noiseI = Math.sin(n * 12.9898 + this.demoSdrFrameCounter) * 7;
      const noiseQ = Math.cos(n * 78.233 - this.demoSdrFrameCounter) * 7;

      let valI = Math.round((sigI + noiseI) * gainScale + dcOffsetI);
      let valQ = Math.round((sigQ + noiseQ) * gainScale + dcOffsetQ);
      if (Math.abs(valI) >= 127 || Math.abs(valQ) >= 127) {
        clipped = true;
      }
      valI = Math.max(-128, Math.min(127, valI));
      valQ = Math.max(-128, Math.min(127, valQ));

      payload[8 + n * 2] = valI & 0xff;
      payload[8 + n * 2 + 1] = valQ & 0xff;
    }

    if (clipped) statusFlags |= SDR_FLAG_ADC_CLIP;

    view.setUint16(0, this.demoSdrCenterMhz, true);
    payload[2] = this.demoSdrRateBwCode & 0x03;
    payload[3] = manualGain & 0xff;
    view.setUint16(4, sampleCount, true);
    payload[6] = statusFlags;
    payload[7] = 0;

    this.emitBytes(encodeResponseFrame(TYPE_SDR_RAW_IQ_FRAME, payload));
  }

  private emitDemoCaps(): void {
    const json = JSON.stringify({
      board: 'XIAO-ESP32-S3',
      firmware: '2.0.0-sdr-demo',
      sdr: true,
    });
    this.emitBytes(
      encodeResponseFrame(TYPE_BOARD_CAPABILITIES, new TextEncoder().encode(json)),
    );
  }

  private emitBytes(bytes: Uint8Array): void {
    for (const listener of this.bytesListeners) {
      listener(bytes);
    }
  }

  private updateSnapshot(partial: Partial<TransportSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    const copy = { ...this.snapshot };
    for (const listener of this.stateListeners) {
      listener(copy);
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (this.wakeLockSentinel && !this.wakeLockSentinel.released) return;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Ignore
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLockSentinel) return;
    try {
      if (!this.wakeLockSentinel.released) {
        await this.wakeLockSentinel.release();
      }
    } catch {
      // Ignore
    }
    this.wakeLockSentinel = null;
  }
}
