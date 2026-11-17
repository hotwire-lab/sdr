import { describe, expect, it, vi } from 'vitest';
import { WebUsbCdcSerialPort } from '../transport/WebUsbSerialPort';
import { WebUSBDevice } from '../transport/web-apis';

function createMockUsbDevice(): {
  device: WebUSBDevice;
  controlTransfers: Array<{ request: number; value: number; index: number; data?: BufferSource }>;
  outTransfers: Uint8Array[];
} {
  const controlTransfers: Array<{
    request: number;
    value: number;
    index: number;
    data?: BufferSource;
  }> = [];
  const outTransfers: Uint8Array[] = [];
  let opened = false;
  let readCount = 0;

  const device: WebUSBDevice = {
    usbVersionMajor: 2,
    usbVersionMinor: 0,
    deviceClass: 239,
    deviceSubclass: 2,
    deviceProtocol: 1,
    vendorId: 0x303a,
    productId: 0x1001,
    configuration: {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          claimed: false,
          alternate: {
            alternateSetting: 0,
            interfaceClass: 2,
            interfaceSubclass: 2,
            interfaceProtocol: 1,
            endpoints: [],
          },
          alternates: [],
        },
        {
          interfaceNumber: 1,
          claimed: false,
          alternate: {
            alternateSetting: 0,
            interfaceClass: 10,
            interfaceSubclass: 0,
            interfaceProtocol: 0,
            endpoints: [
              { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
              { endpointNumber: 3, direction: 'out', type: 'bulk', packetSize: 64 },
            ],
          },
          alternates: [],
        },
      ],
    },
    configurations: [],
    get opened() {
      return opened;
    },
    open: vi.fn(async () => {
      opened = true;
    }),
    close: vi.fn(async () => {
      opened = false;
    }),
    selectConfiguration: vi.fn(async () => {}),
    claimInterface: vi.fn(async () => {}),
    releaseInterface: vi.fn(async () => {}),
    selectAlternateInterface: vi.fn(async () => {}),
    controlTransferIn: vi.fn(async () => ({ status: 'ok' as const })),
    controlTransferOut: vi.fn(async (setup, data) => {
      controlTransfers.push({
        request: setup.request,
        value: setup.value,
        index: setup.index,
        data,
      });
      return { bytesWritten: 0, status: 'ok' as const };
    }),
    transferIn: vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) {
        const bytes = new Uint8Array([0xc0, 0x01, 0x08, 0xc0]);
        return {
          status: 'ok' as const,
          data: new DataView(bytes.buffer),
        };
      }
      return { status: 'ok' as const, data: new DataView(new ArrayBuffer(0)) };
    }),
    transferOut: vi.fn(async (_ep, data) => {
      const view =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
      outTransfers.push(new Uint8Array(view));
      return { bytesWritten: view.byteLength, status: 'ok' as const };
    }),
    clearHalt: vi.fn(async () => {}),
  };

  return { device, controlTransfers, outTransfers };
}

describe('WebUsbCdcSerialPort', () => {
  it('exposes USB VID/PID via getInfo()', () => {
    const { device } = createMockUsbDevice();
    const port = new WebUsbCdcSerialPort(device);
    expect(port.getInfo()).toEqual({ usbVendorId: 0x303a, usbProductId: 0x1001 });
  });

  it('opens CDC interfaces, sets baudrate and DTR/RTS signals, and streams data', async () => {
    const { device, controlTransfers, outTransfers } = createMockUsbDevice();
    const port = new WebUsbCdcSerialPort(device);

    await port.open({ baudRate: 115200 });
    expect(device.claimInterface).toHaveBeenCalledWith(0);
    expect(device.claimInterface).toHaveBeenCalledWith(1);
    expect(port.readable).not.toBeNull();
    expect(port.writable).not.toBeNull();

    await port.setBaudRate(460800);
    const baudReq = controlTransfers.filter((t) => t.request === 0x20);
    expect(baudReq).toHaveLength(2);
    const lastBaud = new DataView((baudReq[1].data as Uint8Array).buffer).getUint32(0, true);
    expect(lastBaud).toBe(460800);

    await port.setSignals({ dataTerminalReady: true });
    await port.setSignals({ requestToSend: true });
    await port.setSignals({ dataTerminalReady: false });
    const lineStates = controlTransfers.filter((t) => t.request === 0x22).map((t) => t.value);
    expect(lineStates).toEqual([0x00, 0x01, 0x03, 0x02]);

    const writer = port.writable!.getWriter();
    await writer.write(new Uint8Array([0xaa, 0xbb]));
    writer.releaseLock();
    expect(outTransfers).toEqual([new Uint8Array([0xaa, 0xbb])]);

    const reader = port.readable!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(new Uint8Array([0xc0, 0x01, 0x08, 0xc0]));
    await reader.cancel();

    await port.close();
    expect(device.releaseInterface).toHaveBeenCalledWith(1);
    expect(device.releaseInterface).toHaveBeenCalledWith(0);
    expect(device.close).toHaveBeenCalled();
  });
});
