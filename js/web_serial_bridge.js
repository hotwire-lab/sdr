// Browser Web Serial, WebUSB CDC-ACM, WakeLock, and esptool-js Web Flasher bridge for Rust/WASM.

const WEBUSB_FILTERS = [
  { vendorId: 0x303a },
  { vendorId: 0x2886 },
  { classCode: 2, subclassCode: 2 },
  { classCode: 239, subclassCode: 2, protocolCode: 1 },
];

function formatVidPid(vid, pid) {
  if (!vid && !pid) return '';
  const v = (vid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  const p = (pid ?? 0).toString(16).toUpperCase().padStart(4, '0');
  return `${v}:${p}`;
}

function encodeCdcLineCoding(baudRate = 921600) {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint32(0, baudRate, true);
  view.setUint8(4, 0);
  view.setUint8(5, 0);
  view.setUint8(6, 8);
  return new Uint8Array(buf);
}

function findCdcEndpoints(device) {
  const config = device.configuration ?? device.configurations?.[0];
  if (!config) return null;
  const interfaces = config.interfaces;
  for (let i = 0; i < interfaces.length; i++) {
    const iface = interfaces[i];
    const alt = iface.alternate;
    if (alt.interfaceClass === 0xff) continue;

    let inEp = null;
    let outEp = null;
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

function detectPreferredBackend() {
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

class WebUsbCdcSerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.desc = null;
    this.currentDtr = false;
    this.currentRts = false;
    this.readLoopRunning = false;
    this.controlQueue = Promise.resolve();
  }

  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  async open(options = { baudRate: 115200 }) {
    if (this.device.opened) await this.close();
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const desc = findCdcEndpoints(this.device);
    if (!desc) {
      await this.device.close();
      throw new Error('No USB CDC-ACM bulk endpoints found on selected device.');
    }
    if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
      try { await this.device.claimInterface(desc.controlInterfaceNumber); } catch {}
    }
    await this.device.claimInterface(desc.dataInterfaceNumber);
    this.desc = desc;
    await this.setBaudRate(options.baudRate || 115200);
    this.currentDtr = false;
    this.currentRts = false;
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.createStreams();
  }

  async setBaudRate(baudRate) {
    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) throw new Error('USB CDC device is not open');
      try {
        await this.device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: this.desc.controlInterfaceNumber,
          },
          encodeCdcLineCoding(baudRate),
        );
      } catch {}
    });
  }

  async setSignals(signals = {}) {
    if (signals.dataTerminalReady !== undefined) this.currentDtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.currentRts = signals.requestToSend;
    const value = (this.currentDtr ? 0x01 : 0) | (this.currentRts ? 0x02 : 0);
    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) throw new Error('USB CDC device is not open');
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value,
        index: this.desc.controlInterfaceNumber,
      });
    });
  }

  async close() {
    this.readLoopRunning = false;
    this.readable = null;
    this.writable = null;
    const desc = this.desc;
    this.desc = null;
    if (this.device.opened) {
      if (desc) {
        try {
          await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22,
            value: 0,
            index: desc.controlInterfaceNumber,
          });
        } catch {}
        try { await this.device.releaseInterface(desc.dataInterfaceNumber); } catch {}
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try { await this.device.releaseInterface(desc.controlInterfaceNumber); } catch {}
        }
      }
      try { await this.device.close(); } catch {}
    }
  }

  addEventListener() {}
  removeEventListener() {}

  enqueueControl(task) {
    const run = this.controlQueue.then(task);
    this.controlQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  createStreams() {
    const desc = this.desc;
    const readSize = Math.max(64, desc.inPacketSize);
    this.readLoopRunning = true;

    this.readable = new ReadableStream({
      pull: async (controller) => {
        while (this.readLoopRunning && this.device.opened) {
          try {
            const result = await this.device.transferIn(desc.inEndpointNumber, readSize);
            if (!this.readLoopRunning || !this.device.opened) break;
            if (result.status === 'stall') {
              await this.device.clearHalt?.('in', desc.inEndpointNumber);
              continue;
            }
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
              controller.enqueue(
                new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength),
              );
              return;
            }
          } catch (err) {
            if (!this.readLoopRunning || !this.device.opened) break;
            throw err;
          }
        }
        try { controller.close(); } catch {}
      },
      cancel: () => { this.readLoopRunning = false; },
    });

    this.writable = new WritableStream({
      write: async (chunk) => {
        if (!this.device.opened) throw new Error('USB CDC device is not open');
        const payload =
          chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
            ? chunk
            : chunk.slice();
        let res = await this.device.transferOut(desc.outEndpointNumber, payload);
        if (res.status === 'stall') {
          await this.device.clearHalt?.('out', desc.outEndpointNumber);
          res = await this.device.transferOut(desc.outEndpointNumber, payload);
        }
        if (res.status !== 'ok') throw new Error(`USB transferOut failed: ${res.status}`);
      },
    });
  }
}

const state = {
  webSerialPort: null,
  webSerialReader: null,
  webSerialWriter: null,
  webUsbDevice: null,
  webUsbDesc: null,
  webUsbReadActive: false,
  wakeLockSentinel: null,
  sessionEpoch: 0,
  autoReconnectPaused: false,
  onState: null,
  onBytes: null,
  status: 'waiting',
  transport: 'none',
};

function notifyState(status, transport, deviceName, vidPid, errorMessage) {
  state.status = status;
  state.transport = transport;
  if (state.onState) {
    state.onState(status, transport, deviceName, vidPid, errorMessage ?? '');
  }
}

async function acquireWakeLock() {
  if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
  if (state.wakeLockSentinel && !state.wakeLockSentinel.released) return;
  try {
    state.wakeLockSentinel = await navigator.wakeLock.request('screen');
  } catch {}
}

async function releaseWakeLock() {
  if (!state.wakeLockSentinel) return;
  try {
    if (!state.wakeLockSentinel.released) await state.wakeLockSentinel.release();
  } catch {}
  state.wakeLockSentinel = null;
}

async function closeAllHandles(preserveSerialPortRef = false) {
  state.webUsbReadActive = false;

  if (state.webSerialReader) {
    try { await state.webSerialReader.cancel(); } catch {}
    try { state.webSerialReader.releaseLock(); } catch {}
    state.webSerialReader = null;
  }

  if (state.webSerialWriter) {
    try { state.webSerialWriter.releaseLock(); } catch {}
    state.webSerialWriter = null;
  }

  if (state.webSerialPort) {
    const port = state.webSerialPort;
    if (!preserveSerialPortRef) state.webSerialPort = null;
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    try { await port.close(); } catch {}
  }

  if (state.webUsbDevice) {
    const dev = state.webUsbDevice;
    const desc = state.webUsbDesc;
    state.webUsbDevice = null;
    state.webUsbDesc = null;
    if (desc) {
      try {
        await dev.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x22,
          value: 0,
          index: desc.controlInterfaceNumber,
        });
      } catch {}
      try { await dev.releaseInterface(desc.dataInterfaceNumber); } catch {}
      if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
        try { await dev.releaseInterface(desc.controlInterfaceNumber); } catch {}
      }
    }
    try { if (dev.opened) await dev.close(); } catch {}
  }
}

async function handleDisconnect(msg) {
  state.sessionEpoch += 1;
  await closeAllHandles(false);
  await releaseWakeLock();
  notifyState('waiting', 'none', 'Waiting for USB...', '', msg);
}

async function runWebSerialReadLoop(port, epoch) {
  if (!port.readable) return;
  const reader = port.readable.getReader();
  state.webSerialReader = reader;
  try {
    while (epoch === state.sessionEpoch) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0 && state.onBytes) {
        state.onBytes(value);
      }
    }
  } catch (err) {
    if (epoch === state.sessionEpoch) {
      await handleDisconnect(err instanceof Error ? err.message : String(err));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
    if (state.webSerialReader === reader) state.webSerialReader = null;
  }
}

async function openWebSerialPort(port, initCmds) {
  await closeAllHandles(false);
  const epoch = ++state.sessionEpoch;
  const info = port.getInfo ? port.getInfo() : {};
  const vidPid = formatVidPid(info.usbVendorId, info.usbProductId);

  notifyState('connecting', 'webserial', 'Connecting...', vidPid, null);
  try {
    await port.open({
      baudRate: 921600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 131072,
    });
    if (epoch !== state.sessionEpoch) {
      try { await port.close(); } catch {}
      return;
    }
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}

    state.webSerialPort = port;
    if (port.writable) state.webSerialWriter = port.writable.getWriter();

    notifyState('connected', 'webserial', 'HotWire SDR USB', vidPid, null);
    void acquireWakeLock();
    void runWebSerialReadLoop(port, epoch);

    if (initCmds && initCmds.length > 0) {
      await js_write_bytes(initCmds);
      window.setTimeout(() => {
        if (epoch === state.sessionEpoch && state.status === 'connected') {
          void js_write_bytes(initCmds);
        }
      }, 250);
    }
  } catch (err) {
    await closeAllHandles(false);
    const msg = err instanceof Error ? err.message : String(err);
    notifyState('waiting', 'none', 'Waiting for USB...', '', `Failed to open serial port: ${msg}`);
  }
}

async function runWebUsbReadLoop(device, desc, epoch) {
  const readSize = Math.max(64, desc.inPacketSize);
  while (state.webUsbReadActive && epoch === state.sessionEpoch && device.opened) {
    try {
      const result = await device.transferIn(desc.inEndpointNumber, readSize);
      if (!state.webUsbReadActive || epoch !== state.sessionEpoch) break;
      if (result.status === 'ok' && result.data && result.data.byteLength > 0 && state.onBytes) {
        const chunk = new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        );
        state.onBytes(chunk);
      }
    } catch (err) {
      if (state.webUsbReadActive && epoch === state.sessionEpoch) {
        await handleDisconnect(err instanceof Error ? err.message : String(err));
      }
      break;
    }
  }
}

async function openWebUsbDevice(device, initCmds) {
  await closeAllHandles(false);
  const epoch = ++state.sessionEpoch;
  const vidPid = formatVidPid(device.vendorId, device.productId);
  notifyState('connecting', 'webusb', device.productName?.trim() || 'Connecting USB...', vidPid, null);

  try {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    if (epoch !== state.sessionEpoch) return;

    const desc = findCdcEndpoints(device);
    if (!desc) {
      await device.close();
      notifyState('waiting', 'none', 'Waiting for USB...', '', 'No USB CDC-ACM bulk endpoints found on selected device.');
      return;
    }

    if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
      try { await device.claimInterface(desc.controlInterfaceNumber); } catch {}
    }
    await device.claimInterface(desc.dataInterfaceNumber);
    if (epoch !== state.sessionEpoch) return;

    try {
      await device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: desc.controlInterfaceNumber },
        encodeCdcLineCoding(921600),
      );
    } catch {}

    await device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 0x22,
      value: 0x0003,
      index: desc.controlInterfaceNumber,
    });

    state.webUsbDevice = device;
    state.webUsbDesc = desc;
    notifyState('connected', 'webusb', device.productName?.trim() || 'HotWire SDR USB', vidPid, null);
    void acquireWakeLock();
    state.webUsbReadActive = true;
    void runWebUsbReadLoop(device, desc, epoch);

    if (initCmds && initCmds.length > 0) {
      await js_write_bytes(initCmds);
      window.setTimeout(() => {
        if (epoch === state.sessionEpoch && state.status === 'connected') {
          void js_write_bytes(initCmds);
        }
      }, 250);
    }
  } catch (err) {
    await closeAllHandles(false);
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.toLowerCase().includes('claim')
      ? `${msg} (Close Arduino IDE / Serial Monitor or use Web Serial on Desktop.)`
      : msg;
    notifyState('waiting', 'none', 'Waiting for USB...', '', hint);
  }
}

export function js_init_transport(onState, onBytes, initCmds) {
  state.onState = onState;
  state.onBytes = onBytes;

  const onConnect = () => {
    if (state.autoReconnectPaused || state.status !== 'waiting') return;
    void js_probe_authorized(initCmds);
  };
  const onDisconnect = (ev) => {
    if (state.transport === 'webusb') {
      if (!ev.device || ev.device === state.webUsbDevice) {
        void handleDisconnect('USB device unplugged');
      }
    } else if (state.transport === 'webserial') {
      if (!ev.target || ev.target === state.webSerialPort) {
        void handleDisconnect('Serial port disconnected');
      }
    }
  };

  navigator.serial?.addEventListener('connect', onConnect);
  navigator.serial?.addEventListener('disconnect', onDisconnect);
  navigator.usb?.addEventListener('connect', onConnect);
  navigator.usb?.addEventListener('disconnect', onDisconnect);

  void js_probe_authorized(initCmds);
}

export async function js_probe_authorized(initCmds) {
  if (state.autoReconnectPaused || state.status !== 'waiting') return;
  const preferred = detectPreferredBackend();
  try {
    if (preferred === 'webserial' && navigator.serial) {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        await openWebSerialPort(ports[0], initCmds);
        return;
      }
    }
    if (navigator.usb) {
      const devices = await navigator.usb.getDevices();
      if (devices.length > 0) {
        await openWebUsbDevice(devices[0], initCmds);
      }
    }
  } catch {}
}

export async function js_connect_usb(initCmds) {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    notifyState('waiting', 'none', 'Waiting for USB...', '', 'Web Serial and WebUSB require HTTPS or localhost.');
    return;
  }
  const backend = detectPreferredBackend();
  if (backend === 'none') {
    notifyState(
      'waiting',
      'none',
      'Waiting for USB...',
      '',
      'Web Serial / WebUSB is unavailable in this browser. Try Chrome or Edge, or use Demo.',
    );
    return;
  }
  try {
    if (backend === 'webserial' && navigator.serial) {
      const port = await navigator.serial.requestPort();
      await openWebSerialPort(port, initCmds);
    } else if (navigator.usb) {
      const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
      await openWebUsbDevice(device, initCmds);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No port selected') || msg.includes('No device selected') || msg.includes('NotFoundError')) {
      notifyState('waiting', 'none', 'Waiting for USB...', '', null);
    } else {
      notifyState('waiting', 'none', 'Waiting for USB...', '', msg);
    }
  }
}

export async function js_disconnect_usb() {
  state.sessionEpoch += 1;
  await closeAllHandles(false);
  await releaseWakeLock();
  notifyState('waiting', 'none', 'Waiting for USB...', '', null);
}

export async function js_write_bytes(bytes) {
  if (!bytes || bytes.byteLength === 0 || state.status !== 'connected') return;
  if (state.transport === 'webusb' && state.webUsbDevice && state.webUsbDesc) {
    await state.webUsbDevice.transferOut(state.webUsbDesc.outEndpointNumber, bytes);
    return;
  }
  if (state.transport === 'webserial' && state.webSerialWriter) {
    await state.webSerialWriter.write(bytes);
  }
}

// --- Web Flasher (esptool-js loaded on demand via ESM) ---
export async function js_flash_firmware(
  boardId,
  forceOtherPort,
  flashOffset,
  customFile,
  bootloaderCmd,
  initCmds,
  onLog,
  onProgress,
) {
  if (typeof navigator === 'undefined' || (!navigator.serial && !navigator.usb)) {
    throw new Error('Web Serial or WebUSB API is required for browser firmware flashing.');
  }

  const profiles = {
    esp32s3: {
      label: 'Seeed Studio XIAO ESP32-S3',
      prefix: 'HotWire_SDR_XIAO_ESP32S3.ino',
      bootloaderOffset: 0x0,
      flashSize: '8MB',
    },
    esp32c6: {
      label: 'Seeed Studio XIAO ESP32-C6',
      prefix: 'HotWire_SDR_XIAO_ESP32C6.ino',
      bootloaderOffset: 0x0,
      flashSize: '4MB',
    },
  };
  const profile = profiles[boardId] ?? profiles.esp32s3;

  state.autoReconnectPaused = true;
  const preferredBackend = detectPreferredBackend();
  const useWebUsb =
    state.transport === 'webusb' ||
    (state.transport !== 'webserial' && preferredBackend === 'webusb');

  let port = null;
  let webUsbDevice = null;

  try {
    onLog(`[1/4] Preparing to flash ${profile.label}...`);
    if (useWebUsb && navigator.usb) {
      const activeUsb = forceOtherPort ? null : state.webUsbDevice;
      if (!forceOtherPort && state.transport === 'webusb' && activeUsb) {
        onLog('Sending 0xF0 bootloader entry command & closing WebUSB app transport...');
        try { await js_write_bytes(bootloaderCmd); } catch {}
        await new Promise((r) => setTimeout(r, 250));
        state.sessionEpoch += 1;
        await closeAllHandles(true);
        webUsbDevice = activeUsb;
      } else {
        onLog('Select the XIAO ESP32 USB-JTAG / CDC device in the browser WebUSB prompt...');
        webUsbDevice = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
      }
      port = new WebUsbCdcSerialPort(webUsbDevice);
    } else if (navigator.serial) {
      let serialPort = forceOtherPort ? null : state.webSerialPort;
      if (!forceOtherPort && state.transport === 'webserial' && serialPort) {
        onLog('Sending 0xF0 bootloader entry command & closing app transport...');
        try { await js_write_bytes(bootloaderCmd); } catch {}
        await new Promise((r) => setTimeout(r, 250));
        state.sessionEpoch += 1;
        await closeAllHandles(true);
      } else {
        onLog('Select the XIAO ESP32 USB-JTAG / CDC COM port in the browser prompt...');
        serialPort = await navigator.serial.requestPort();
      }
      port = serialPort;
    }

    if (!port) throw new Error('No serial or USB port selected.');

    const fileArray = [];
    if (customFile) {
      onLog(`Reading selected file: ${customFile.name}...`);
      const buf = new Uint8Array(await customFile.arrayBuffer());
      const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
      fileArray.push({ data: buf, address: addr });
      onLog(`Loaded ${customFile.name} (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
    } else if (flashOffset === 'full') {
      onLog('Downloading bundled full firmware images (bootloader + partitions + app0 + app)...');
      const items = [
        { label: 'bootloader', address: profile.bootloaderOffset, url: `./firmware/${profile.prefix}.bootloader.bin` },
        { label: 'partitions', address: 0x8000, url: `./firmware/${profile.prefix}.partitions.bin` },
        { label: 'boot_app0', address: 0xe000, url: `./firmware/boot_app0.bin` },
        { label: 'firmware', address: 0x10000, url: `./firmware/${profile.prefix}.bin` },
      ];
      for (const item of items) {
        const resp = await fetch(item.url);
        if (!resp.ok) throw new Error(`Missing binary ${item.url} (${resp.status}).`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        onLog(`Loaded ${item.label} @ 0x${item.address.toString(16)} (${buf.byteLength} bytes)`);
        fileArray.push({ data: buf, address: item.address });
      }
    } else {
      const appUrl = `./firmware/${profile.prefix}.bin`;
      onLog(`Downloading bundled app firmware (${profile.prefix}.bin)...`);
      const resp = await fetch(appUrl);
      if (!resp.ok) throw new Error(`Missing binary ${appUrl} (${resp.status}).`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
      fileArray.push({ data: buf, address: addr });
      onLog(`Loaded ${profile.prefix}.bin (${buf.byteLength} bytes) -> 0x${addr.toString(16)}`);
    }

    onLog('[2/4] Connecting to ROM bootloader...');
    const { ESPLoader, Transport } = await import('https://esm.sh/esptool-js@0.7.1');
    const espTransport = new Transport(port, false);
    const esploader = new ESPLoader({
      transport: espTransport,
      baudrate: 460800,
      romBaudrate: 115200,
      terminal: {
        clean: () => {},
        writeLine: (line) => onLog(line),
        write: (data) => {
          const cleaned = data.replace(/\r/g, '').trim();
          if (cleaned) onLog(cleaned);
        },
      },
    });

    let chip = '';
    try {
      chip = await esploader.main('default_reset');
    } catch {
      onLog('Default reset sync timed out; retrying direct no_reset sync...');
      try { await espTransport.disconnect(); } catch {}
      await new Promise((r) => setTimeout(r, 150));
      chip = await esploader.main('no_reset');
    }
    onLog(`Connected to bootloader chip: ${chip || profile.label}`);

    onLog('[3/4] Writing flash memory...');
    const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
    const isBundledFull = !customFile && flashOffset === 'full';

    await esploader.writeFlash({
      fileArray,
      flashSize: profile.flashSize,
      flashMode: isBundledFull ? 'dio' : 'keep',
      flashFreq: isBundledFull ? '80m' : 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const prev = fileArray.slice(0, fileIndex).reduce((acc, f) => acc + f.data.byteLength, 0);
        const cur = fileArray[fileIndex]
          ? fileArray[fileIndex].data.byteLength * (written / Math.max(1, total))
          : written;
        const ratio = totalBytes > 0 ? (prev + cur) / totalBytes : written / Math.max(1, total);
        onProgress(Math.min(100, Math.round(ratio * 100)));
      },
    });

    onLog('[4/4] Flashing complete! Triggering reset...');
    let watchdogTriggered = false;
    if (boardId === 'esp32s3') {
      try {
        await esploader.writeReg(0x6000812c, 0);
        await esploader.writeReg(0x600080b0, 0x50d83aa1);
        await esploader.writeReg(0x6000809c, 2000);
        const curCfg0 = await esploader.readReg(0x60008098);
        const nextCfg0 = ((curCfg0 & 0x0fe3ffff) | 0xb01c0000) >>> 0;
        await esploader.writeReg(0x60008098, nextCfg0);
        await esploader.writeReg(0x600080a8, 0x80000000);
        watchdogTriggered = true;
        await new Promise((r) => setTimeout(r, 150));
      } catch {}
    }
    if (!watchdogTriggered) {
      try { await esploader.after('hard_reset'); } catch {}
      try {
        await espTransport.setDTR(false);
        await espTransport.setRTS(true);
        await new Promise((r) => setTimeout(r, 100));
        await espTransport.setRTS(false);
        await new Promise((r) => setTimeout(r, 80));
      } catch {}
    }
    try { await espTransport.disconnect(); } catch {}

    onProgress(100);
    onLog('Flash complete! Reconnecting to HotWire...');
    await new Promise((r) => setTimeout(r, 1200));
    state.autoReconnectPaused = false;
    if (webUsbDevice) {
      try { await openWebUsbDevice(webUsbDevice, initCmds); } catch {
        await new Promise((r) => setTimeout(r, 900));
        await js_probe_authorized(initCmds);
      }
    } else {
      try { await openWebSerialPort(port, initCmds); } catch {
        await new Promise((r) => setTimeout(r, 900));
        await openWebSerialPort(port, initCmds);
      }
    }
  } finally {
    state.autoReconnectPaused = false;
  }
}
