# HotWire SDR — 1.84–2.79 GHz RF Spectrum Analyzer

[![Deploy to GitHub Pages](https://github.com/kavierim/HotWire-SDR/actions/workflows/deploy.yml/badge.svg)](https://github.com/kavierim/HotWire-SDR/actions/workflows/deploy.yml)
[![Live Web App](https://img.shields.io/badge/Live_Web_App-GitHub_Pages-0ea5e9?logo=googlechrome&logoColor=white)](https://kavierim.github.io/HotWire-SDR/)
[![Hardware](https://img.shields.io/badge/Hardware-XIAO_ESP32--S3-10b981)](https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html)
[![Web Serial & WebUSB](https://img.shields.io/badge/USB-Web_Serial_%2F_WebUSB-8b5cf6)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)

Turn a **Seeed Studio XIAO ESP32-S3** into a real-time **1.84–2.79 GHz RF Spectrum Analyzer**, **Wideband Scanner**, **scrolling Waterfall**, and **Raw Baseband I/Q Receiver** directly in your browser — **zero drivers, zero desktop install**.

> **Try it in 1 click (no hardware required):** Open **[https://kavierim.github.io/HotWire-SDR/](https://kavierim.github.io/HotWire-SDR/)** and click **Demo** $\to$ **Start RF** (or **Scanner**) to explore the live RF simulator.

![HotWire SDR live spectrum and waterfall at 1884 MHz (DECT EU, 40 MHz span, 5/6 LO divider)](docs/sdr-dect-example.jpg)

## Quick Start (With XIAO ESP32-S3)

1. Plug your **Seeed Studio XIAO ESP32-S3** into USB.
2. Open **[https://kavierim.github.io/HotWire-SDR/](https://kavierim.github.io/HotWire-SDR/)** in **Chrome**, **Edge**, or **Opera** (Desktop or Android).
3. Click **Web Flasher** (top right) $\to$ **Flash Firmware** to program the bundled ESP32-S3 SDR firmware directly from your browser via **`esptool-js`**.
4. Click **Start RF** — or open **Scanner** to sweep the entire **1.84–2.79 GHz** band at once.

## Features

- **1.84–2.79 GHz Wideband RF Receiver (`ESP32-S3 RF Dump Engine`):**
  - Direct capture via ESP32-S3 SRAM arbiter (`0x3FCD0000–0x3FCDFFFF`) reserved at boot with `SOC_RESERVE_MEMORY_REGION`.
  - Continuous RFPLL tuning (`2210–2790 MHz` direct VCO, plus `1842–2209 MHz` via `5/6` LO divider in I2C block `0x63`).
  - Selectable span (`40 MHz` default matching the hardware analog baseband LPF, plus `80`, `20`, and `16 MHz`), analog baseband RX filter control (`0x67`), and manual RX gain (`0–72`) with real-time `ADC CLIP` alerting.
- **1.84–2.79 GHz Wideband Scanner (`Scanner` Modal):**
  - Sweeps across the full `948 MHz` range in `40 MHz` steps with a live scanning cursor, stitched **Live** + **Peak-Hold** traces, and **click-to-tune** directly into any active signal.
- **Full-Width Tuner & Dual-Canvas High-DPI RF Plotter:**
  - Full-width frequency slider with `−`/`+` step buttons (`±1 MHz`, `Shift` for `±10 MHz`) and one-tap band pills (`DECT`, `13cm`, `Wi-Fi`, `LTE B7`).
  - Live / Average / Peak-Hold spectrum traces with DECT EU, 13cm Ham, Wi-Fi, BLE, and LTE B7 band overlays, crosshair readout, and draggable `M1`/`M2` delta markers.
  - Scrolling heatmap waterfall with `Turbo`, `Viridis`, and `Inferno` colormaps and interactive `Min / Max dBFS` range sliders.
  - Host & hardware DSP options (`DSP` drawer): `FFT` (`256–2048`), `Rate` (`10–60 FPS`), `Mean` vs `Peak` detector, `DC Notch`, `Spur Blanker`, and `0x32` Sweep.
- **Raw Baseband I/Q Inspector (`0x85`):**
  - Captures single-shot or continuous signed 8-bit I/Q streams for time-domain envelope analysis and 2D constellation visualization.
- **Dedicated Dual-Core Firmware:**
  - Core 0 handles USB CDC binary protocol parsing with zero blocking; Core 1 runs dedicated RF Dump acquisition, Hann windowing, Radix-2 FFT, and high-FPS streaming.

## HotWire Ecosystem

- **[HotWire SDR](https://github.com/kavierim/HotWire-SDR)** ([Live App](https://kavierim.github.io/HotWire-SDR/)) — 1.84–2.79 GHz RF Spectrum Analyzer, Wideband Scanner & Waterfall for XIAO ESP32-S3
- **[HotWire Logic Analyzer](https://github.com/kavierim/HotWire-Logic-Analyzer)** ([Live App](https://kavierim.github.io/HotWire-Logic-Analyzer/)) — 8-Channel Logic Analyzer & Tri-State Force I/O with UART/SPI/I²C decoders
- **[HotWire Serial Terminal](https://github.com/kavierim/HotWire-Serial-Terminal)** ([Live App](https://kavierim.github.io/HotWire-Serial-Terminal/)) — Cross-platform Web Serial & WebUSB terminal for desktop and Android

## Development & Firmware

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

- Sketch: [`firmware/HotWire_SDR_XIAO_ESP32S3/HotWire_SDR_XIAO_ESP32S3.ino`](firmware/HotWire_SDR_XIAO_ESP32S3/HotWire_SDR_XIAO_ESP32S3.ino)
- FQBN: `esp32:esp32:XIAO_ESP32S3:USBMode=hwcdc,CDCOnBoot=default,PSRAM=opi`
- Compiled binaries are bundled in [`public/firmware/`](public/firmware/) for zero-install Web Flasher deployment.

## Credits

- [esp-sdr](https://github.com/ESPARGOS/esp-sdr) (ESPARGOS / Florian Euchner) — foundational ESP32-S3 raw RF dump & LO divider research
- [esptool-js](https://github.com/espressif/esptool-js) (Espressif) — browser-based Web Serial flashing
- [arduino-esp32](https://github.com/espressif/arduino-esp32) / [ESP-IDF](https://github.com/espressif/esp-idf) (Espressif) — ESP32-S3 firmware foundation
- [React](https://react.dev/) & [Vite](https://vite.dev/) — web application UI and build tooling

## License

Licensed under the [Apache License 2.0](LICENSE).
