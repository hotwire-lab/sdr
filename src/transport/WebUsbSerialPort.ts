import {
  CdcEndpointDescriptor,
  encodeCdcLineCoding,
  findCdcEndpoints,
} from './SerialTransport';
import {
  WebSerialOptions,
  WebSerialOutputSignals,
  WebSerialPort,
  WebSerialPortInfo,
  WebUSBDevice,
} from './web-apis';

/**
 * SerialPort-compatible WebUSB CDC-ACM adapter for esptool-js.
 * Enables firmware flashing over WebUSB on Android Chrome and Desktop browsers
 * where Web Serial API (navigator.serial) is unavailable.
 */
export class WebUsbCdcSerialPort implements WebSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;

  private desc: CdcEndpointDescriptor | null = null;
  private currentDtr = false;
  private currentRts = false;
  private readLoopRunning = false;
  private controlQueue: Promise<void> = Promise.resolve();

  constructor(private readonly device: WebUSBDevice) {}

  getUsbDevice(): WebUSBDevice {
    return this.device;
  }

  getInfo(): WebSerialPortInfo {
    return {
      usbVendorId: this.device.vendorId,
      usbProductId: this.device.productId,
    };
  }

  async open(options: WebSerialOptions = { baudRate: 115200 }): Promise<void> {
    if (this.device.opened) {
      await this.close();
    }

    await this.device.open();
    if (!this.device.configuration) {
      await this.device.selectConfiguration(1);
    }

    const desc = findCdcEndpoints(this.device);
    if (!desc) {
      await this.device.close();
      throw new Error('No USB CDC-ACM bulk endpoints found on selected device.');
    }

    if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
      try {
        await this.device.claimInterface(desc.controlInterfaceNumber);
      } catch {
        // Control interface is optional on some composite devices
      }
    }
    await this.device.claimInterface(desc.dataInterfaceNumber);
    this.desc = desc;

    await this.setBaudRate(options.baudRate || 115200);
    this.currentDtr = false;
    this.currentRts = false;
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });

    this.createStreams();
  }

  async setBaudRate(baudRate: number): Promise<void> {
    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) {
        throw new Error('USB CDC device is not open');
      }
      try {
        await this.device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: this.desc.controlInterfaceNumber,
          },
          encodeCdcLineCoding(baudRate) as unknown as BufferSource
        );
      } catch {
        // Ignore if device omits SET_LINE_CODING (native USB CDC ignores host baud)
      }
    });
  }

  async setSignals(signals: WebSerialOutputSignals = {}): Promise<void> {
    if (signals.dataTerminalReady !== undefined) {
      this.currentDtr = signals.dataTerminalReady;
    }
    if (signals.requestToSend !== undefined) {
      this.currentRts = signals.requestToSend;
    }
    const value = (this.currentDtr ? 0x01 : 0) | (this.currentRts ? 0x02 : 0);

    await this.enqueueControl(async () => {
      if (!this.device.opened || !this.desc) {
        throw new Error('USB CDC device is not open');
      }
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value,
        index: this.desc.controlInterfaceNumber,
      });
    });
  }

  async close(): Promise<void> {
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
            value: 0x0000,
            index: desc.controlInterfaceNumber,
          });
        } catch {
          // Ignore teardown errors
        }
        try {
          await this.device.releaseInterface(desc.dataInterfaceNumber);
        } catch {
          // Ignore release errors
        }
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try {
            await this.device.releaseInterface(desc.controlInterfaceNumber);
          } catch {
            // Ignore release errors
          }
        }
      }
      try {
        await this.device.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  addEventListener(): void {
    // Disconnect events are handled at navigator.usb level
  }

  removeEventListener(): void {
    // Disconnect events are handled at navigator.usb level
  }

  private enqueueControl(task: () => Promise<void>): Promise<void> {
    const run = this.controlQueue.then(task);
    this.controlQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private createStreams(): void {
    const desc = this.desc;
    if (!desc) {
      throw new Error('USB CDC endpoints are not configured');
    }

    const readSize = Math.max(64, desc.inPacketSize);
    this.readLoopRunning = true;

    this.readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.readLoopRunning && this.device.opened) {
          try {
            const result = await this.device.transferIn(desc.inEndpointNumber, readSize);
            if (!this.readLoopRunning || !this.device.opened) {
              break;
            }
            if (result.status === 'stall') {
              await this.device.clearHalt?.('in', desc.inEndpointNumber);
              continue;
            }
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
              controller.enqueue(
                new Uint8Array(
                  result.data.buffer,
                  result.data.byteOffset,
                  result.data.byteLength
                )
              );
              return;
            }
          } catch (err) {
            if (!this.readLoopRunning || !this.device.opened) {
              break;
            }
            throw err;
          }
        }
        try {
          controller.close();
        } catch {
          // Stream may already be closed or errored
        }
      },
      cancel: () => {
        this.readLoopRunning = false;
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!this.device.opened) {
          throw new Error('USB CDC device is not open');
        }
        const payload =
          chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
            ? chunk
            : chunk.slice();
        let res = await this.device.transferOut(
          desc.outEndpointNumber,
          payload as unknown as BufferSource
        );
        if (res.status === 'stall') {
          await this.device.clearHalt?.('out', desc.outEndpointNumber);
          res = await this.device.transferOut(
            desc.outEndpointNumber,
            payload as unknown as BufferSource
          );
        }
        if (res.status !== 'ok') {
          throw new Error(`USB transferOut failed: ${res.status}`);
        }
      },
    });
  }
}
