# HotWire SDR - 1.84–2.79 GHz RF Spectrum Analyzer (`HotWire-SDR`)

A zero-install **Progressive Web App (PWA)** and high-performance **ESP32-S3 firmware** providing a **1.84–2.79 GHz RF Spectrum Analyzer**, **scrolling Waterfall**, **Raw Baseband I/Q Constellation Inspector**, **xterm.js Serial Terminal**, and in-browser **esptool-js Web Flasher** for the **Seeed Studio XIAO ESP32-S3**.

> **Note:** HotWire SDR is a dedicated pure SDR application. The Logic Analyzer has been decoupled into its own separate repository at [HotWire-Logic-Analyzer](https://github.com/kavierim/HotWire-Logic-Analyzer).

**Live Web App (GitHub Pages):** https://kavierim.github.io/HotWire-SDR/

## Web Page Programming & Firmware Flashing

HotWire SDR provides full **in-browser firmware flashing** directly from Chromium (Chrome, Edge, Opera) via the **Web Serial API** and **`esptool-js`**:
1. Connect Seeed Studio XIAO ESP32-S3 via USB.
2. Open the **Console & Flasher** drawer at the bottom and switch to **Web Flasher (esptool-js)**.
3. Select **Seeed Studio XIAO ESP32-S3**.
4. Click **Flash Firmware** — the web app automatically sends the `0xF0` ROM bootloader command, connects via `esptool-js`, flashes the bundled bootloader, partition table, boot_app0, and application firmware, performs a hardware reset, and reconnects to the live SDR stream.
5. You can also flash custom `.bin` builds using the **Custom .bin...** button.

## Features

- **1.84–2.79 GHz Wideband RF Receiver (`ESP32-S3 RF Dump Engine`):**
  - Direct capture via ESP32-S3 SRAM arbiter (`0x3FCD0000–0x3FCDFFFF`) reserved at boot with `SOC_RESERVE_MEMORY_REGION`.
  - Continuous RFPLL tuning (`2210–2790 MHz` direct VCO, plus `1842–2209 MHz` via `5/6` LO divider control in I2C block `0x63`).
  - Selectable sample rate/span (`80`, `40`, `20`, `16 MHz`), analog baseband RX filter control (`0x67`), fast RX DC-offset calibration (`pbus_rx_dco_cal`), and AGC or Manual RX gain (`0–72`) with real-time `ADC CLIP` alerting.
- **Dual-Canvas High-DPI RF Plotter:**
  - Top live/average/peak-hold spectrum trace with Wi-Fi (Ch 1/6/11) & BLE Advertising channel overlays, crosshair readout, and draggable `M1`/`M2` delta markers.
  - Bottom scrolling heatmap waterfall with `Turbo`, `Viridis`, and `Inferno` colormaps and interactive `Min / Max dBFS` range sliders.
  - Host DSP enhancements: `DC Spike Notch`, `Spur Blanker`, `Mean Avg` vs `Max-Hold Burst` detector, and `0x32` Wideband Multi-Step Sweep.
- **Raw Baseband I/Q Inspector (`0x85`):**
  - Captures single-shot or continuous signed 8-bit I/Q streams for time-domain envelope analysis and 2D constellation visualization.
- **Dedicated Dual-Core Architecture:**
  - Core 0 handles USB CDC high-speed binary protocol parsing and serial command dispatching with zero blocking.
  - Core 1 runs the dedicated high-speed RF Dump acquisition, FFT windowing, and streaming pipeline with maximum throughput.
- **Offline Demo Mode & Browser Flashing:**
  - Includes a full client-side RF spectrum & I/Q simulator (Wi-Fi, BLE, DECT 1.9 GHz, LTE B7) and bundled firmware flashing via Web Serial (`esptool-js`).

## Development & Verification

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

## Firmware (`XIAO ESP32-S3`)

Sketch: `firmware/HotWire_SDR_XIAO_ESP32S3/HotWire_SDR_XIAO_ESP32S3.ino`

- FQBN: `esp32:esp32:XIAO_ESP32S3:CDCOnBoot=default,PSRAM=opi`
- Compiled binaries are bundled in `public/firmware/` for zero-install Web Flasher deployment.
