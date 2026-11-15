# Project Specification: HotWire SDR Extension — Native 1.84–2.79 GHz I/Q Capture & Spectrum Analyzer (XIAO ESP32-S3)

## 1. Architectural Context & Objective
The base **HotWire PWA** (WebUSB / Web Serial transport, `0xAA 0x55` binary framing demultiplexer, `xterm.js` terminal, and 8-channel Tri-State Logic Analyzer) is already implemented. This specification defines the **Software Defined Radio (SDR) & RF Spectrum Analyzer module** for the **Seeed Studio XIAO ESP32-S3** utilizing the undocumented on-chip RF debug dump engine in Espressif's PHY/RF subsystem (reference architecture: `ESPARGOS/esp-sdr`).

No external RF hardware is required beyond the standard 2.4 GHz antenna connected to the XIAO ESP32-S3 U.FL connector.

---

## 2. ESP32-S3 Internal SDR Hardware Architecture (Knowledge Base for Coding Agent)

Normally, the ESP32-S3 RF front-end (LNA $\rightarrow$ Quadrature Mixer $\rightarrow$ Programmable Analog Baseband Filter $\rightarrow$ High-Speed ADC) feeds directly into the internal Wi-Fi/BLE baseband modem. However, the silicon contains an internal factory RF test block (**"Dump Engine"**, exercised by `adctrig` in `librftest.a`) that routes raw, pre-demodulation 10-bit complex $(I, Q)$ ADC samples directly into a dedicated 64 KiB physical SRAM bank at up to **80 MSa/s**.

### 2.1 Critical Hardware Addresses & Registers (ESP32-S3 Verified)
The coding agent must use these exact physical addresses and bit masks for the **ESP32-S3** target:

| Component / Register | ESP32-S3 Address | Exact Bitfields & Required Operation |
| :--- | :--- | :--- |
| **Snapshot Capture SRAM Bank** | `0x3FCD0000` – `0x3FCDFFFF` | 64 KiB physical internal DRAM block (holds up to `16,380` 32-bit sample words). |
| **SRAM Ownership Register** | `0x600C101C` | Controls ownership of the `0x3FCD0000` SRAM bank. **Modify ONLY bits `[3:0]`!**<br>• Grant to RF Dump Engine (Bank 2): `REG = (REG & ~0x0FUL) \| 0x04UL`<br>• Restore to CPU (Idle): `REG = (REG & ~0x0FUL)` |
| **Debug Lane Select Register** | `0x60033D90` | Routes receiver $I/Q$ signals via four 6-bit mux fields:<br>Write `(0UL << 0) \| (1UL << 6) \| (2UL << 12) \| (3UL << 18)` (`0x000C1040`). |
| **Dump Control Register** | `0x60033D5C` | Controls sample count, clock divider, start trigger pulse, master enable, and completion flag. |

### 2.2 Dump Control Register (`0x60033D5C`) Bit Map & Exact 3-Step Trigger Sequence
* **Bits `0..14` (`0x00007FFF`):** Number of 32-bit sample words to record (`N`, maximum `16380`, must be a multiple of 4).
* **Bits `15..16` (`(div & 0x3) << 15`):** Sample rate clock divider:
  * `0` = **80 MSa/s** ($12.5\text{ ns}$ period)
  * `1` = **40 MSa/s** ($25.0\text{ ns}$ period)
  * `2` = **20 MSa/s** ($50.0\text{ ns}$ period)
  * `3` = **16 MSa/s** ($62.5\text{ ns}$ period)
* **Bit `18` (`1UL << 18` = `0x00040000`):** Hardware `DONE` status flag (read-only; set to `1` by hardware when all $N$ samples have been written).
* **Bit `19` (`1UL << 19` = `0x00080000`):** Start trigger pulse bit (requires `0` $\rightarrow$ `1` $\rightarrow$ `0` transition while Bit 31 is already enabled).
* **Bits `20+`:** Data source and mode selector (`0` selects raw receiver $I/Q$).
* **Bit `31` (`1UL << 31` = `0x80000000`):** Dump Engine Master Enable.

#### Exact Hardware Capture Sequence (Must Run on Core 1):
1. **Sentinel Pre-Fill (While CPU Still Owns SRAM):** Write the sentinel marker word `0xA5A0055A` into the capture region (or at least the final words of the target capture range in `0x3FCD0000`) so truncated or failed hardware transfers are immediately detected.
2. **Enter Short Critical Section:** Call `portENTER_CRITICAL` ONLY for the hardware capture window (`~205 µs` at 80 MSa/s for 16,380 samples).
3. **Hand Over SRAM Bank Ownership:** Read-modify-write `0x600C101C` so bits `[3:0]` equal `0x04` (`(val & ~0x0FUL) | 0x04UL`). **WARNING:** While the dump engine owns the bank, the CPU must NEVER read or write `0x3FCD0000–0x3FCDFFFF`.
4. **Select Debug Lanes:** Write `0x000C1040` to `0x60033D90`.
5. **Execute 3-Write Enable & Trigger Pulse on `0x60033D5C`:**
   * Compute `ctrl = 0x80000000UL | ((div & 0x3UL) << 15) | (num_samples & 0x7FFFUL)`.
   * **Write 1 (Arm Enable):** Write `ctrl` to `0x60033D5C`.
   * **Write 2 (Raise Trigger):** Write `ctrl | (1UL << 19)` to `0x60033D5C`.
   * **Write 3 (Clear Trigger):** Write `ctrl` to `0x60033D5C`.
6. **Wait for Completion:** Poll `0x60033D5C` until Bit 18 (`1UL << 18`) is `1` (include a bounded timeout counter of `100,000` iterations so hardware lockup can never freeze the CPU).
7. **Restore State:** Write `0x00000000` to `0x60033D5C`, restore CPU ownership of the SRAM bank at `0x600C101C` (`val & ~0x0FUL`), and execute a memory barrier (`__sync_synchronize()`).
8. **Exit Critical Section:** Call `portEXIT_CRITICAL`.
9. **Verify Sentinel:** Confirm that the final word at `((volatile uint32_t*)0x3FCD0000)[num_samples - 1]` no longer equals `0xA5A0055A`. **All subsequent unpacking, DC removal, and FFT math MUST run outside the critical section** so USB CDC interrupts and FreeRTOS timers never stall!

### 2.3 32-Bit Sample Word Format & Two's Complement Sign Extension
Each 32-bit word `w` at `((volatile uint32_t*)0x3FCD0000)[i]` has the following layout:
```text
 31        28 27                20 19                10 9                  0
┌────────────┬────────────────────┬────────────────────┬────────────────────┐
│  (AGC fsm) │  gain index (8 b)  │   Q (10-bit signed)│   I (10-bit signed)│
└────────────┴────────────────────┴────────────────────┴────────────────────┘
```
* **Bits `0..9` (10-bit signed two's complement):** Raw $I$ component (`-512` to `+511`).
  * Exact sign-extension formula: `int16_t I = (int16_t)(((int32_t)(w << 22)) >> 22);`
* **Bits `10..19` (10-bit signed two's complement):** Raw $Q$ component (`-512` to `+511`).
  * Exact sign-extension formula: `int16_t Q = (int16_t)(((int32_t)(w << 12)) >> 22);`
  * *(Note: Both $I$ and $Q$ are standard signed two's complement values directly from the ADC side of the receiver; do NOT invert the sign of $Q$, as doing so mirrors the upper and lower sidebands around $f_c$.)*
* **Bits `20..27` (8-bit unsigned):** Active hardware receiver gain index (`uint8_t gain = (w >> 20) & 0xFF`, range `0..~75` in roughly 1 dB steps).
* **Bits `28..31` (4 bits):** Internal AGC state bits.

### 2.4 Memory Reservation at `0x3FCD0000` (Preventing Heap/Stack Corruption)
If FreeRTOS places a task stack or Wi-Fi buffer inside `0x3FCD0000–0x3FCDFFFF`, the dump engine will overwrite live program memory and crash the chip immediately.
* **Mandatory Reservation:** Reserve the entire 64 KiB block using `SOC_RESERVE_MEMORY_REGION(0x3fcd0000, 0x3fce0000, s3_rf_dump);` at file scope AND provide a linker fragment (`sram_guard.ld`) or static section placement so neither the dynamic heap allocator nor static `.bss`/`.data` variables ever land inside `0x3FCD0000–0x3FCDFFFF`.

### 2.5 ESP32-S3 PHY/RF Controls: Wideband Tuning (`1842–2790 MHz`), Filter BW & Gain
Standard Wi-Fi channel APIs only cover `2412–2484 MHz`. To tune continuously across **`1842 MHz` – `2790 MHz`**, adjust the analog baseband anti-aliasing filter, and control receiver gain, use the internal functions in `libphy.a` / `librftest.a` and the internal RF I2C bus (`rom_i2c_readReg` / `rom_i2c_writeReg` / `rom_i2c_writeReg_Mask`):

1. **ESP32-S3 Synthesizer Function (`set_chan_freq_sw_start`):**
   * On the ESP32-S3, `libphy.a` programs the RF synthesizer directly via `set_chan_freq_sw_start(freq_mhz, ...)` (unlike the original ESP32 which used `chip_v7_set_chan_nomask`).
   * The native VCO locks reliably from **`2210 MHz` to `2790 MHz`**.
2. **Sub-Band Tuning (`1842 MHz` – `2209 MHz` via the Internal `5/6` LO Divider):**
   * On the ESP32-S3, an optional hardware `5/6` divider sits between the VCO and the mixer on the internal RF I2C bus.
   * **Polarity Rule:** Normally the divider bit is set (`1`), feeding the VCO frequency directly to the mixer. When the divider bit is **cleared (`0`)**, the mixer receives $\frac{5}{6}$ of the VCO frequency ($\text{VCO range } 2210\text{--}2790\text{ MHz} \times \frac{5}{6} = 1842\text{--}2325\text{ MHz}$).
   * Therefore, when `target_freq_mhz < 2210`:
     1. Call `set_chan_freq_sw_start` with $f_{VCO} = \text{round}\left(f_{target} \times \frac{6}{5}\right)$.
     2. Clear the `5/6` divider bit on the internal RF I2C bus via `rom_i2c_writeReg`.
     3. When tuning to $\ge 2210\text{ MHz}$, set the divider bit back to `1` (direct VCO feed).
3. **DC Offset Calibration Without On-Air Blips (`pbus_rx_dco_cal`):**
   * After every frequency change, call **only** the PHY DC-offset calibration routine (`pbus_rx_dco_cal()`) to suppress the mixer's $0\text{ Hz}$ DC spike.
   * **NEVER** call the full PHY calibration function on every tune step, because full calibration triggers an internal I/Q mismatch loopback routine that briefly leaks a test tone onto the antenna port and slows down sweeping.
4. **Automatic Analog Baseband Filter Bandwidth Coupling (Anti-Aliasing):**
   * Because the dump engine clock dividers (`40`, `20`, `16 MSa/s`) skip samples without digital decimation filtering, leaving the analog baseband filter wide open at lower sample rates causes out-of-band signals to alias into the spectrum.
   * Program the baseband filter registers over the internal RF I2C bus (8 steps from `~8 MHz` to `~54 MHz` 3 dB double-sided bandwidth) automatically whenever the sample rate changes so the analog passband never exceeds the Nyquist bandwidth ($f_s$).
5. **Gain & AGC Override:**
   * **AGC Mode (`gain == 0xFF`):** Clear the gain override bit in the AGC/FE register block so hardware AGC tracks signal levels automatically.
   * **Manual Gain Mode (`gain` in `0..72`):** Set the AGC override bit and write the manual gain index into the AGC/FE register field. Verify that bits `20..27` of captured words report the exact locked gain index.

---

## 3. Operational Modes & Protocol Extension

To integrate cleanly into the existing HotWire `0xAA 0x55` binary framing without breaking the Terminal or 8-Channel Logic Analyzer, add the **SDR Command Group (`0x30–0x32`)** and **SDR Response Frames (`0x84–0x85`)**.

### 3.1 Two Supported SDR Transfer Modes
Because native USB Full-Speed CDC throughput is ~800 KB/s, the firmware must support two complementary modes:

1. **Mode A: On-Chip Welch / Averaged FFT Spectrum Mode (Default, `30–60 FPS`):**
   * Core 1 captures a 16,380-sample burst (`8 x 2048` or `16 x 1024` segments) into `0x3FCD0000`.
   * Outside the critical section, Core 1 unpacks each segment of $N \in \{256, 512, 1024, 2048\}$ samples, subtracts the segment mean $(\bar{I}, \bar{Q})$ to remove residual DC offset, applies a precomputed **Hann window**, and executes an in-place radix-2 complex FFT.
   * Core 1 accumulates magnitude-squared power $|X[k]|^2$ across the sub-windows using either **Mean Averaging** (smooth noise floor) or **Max-Hold Peak Detection** (catches brief microsecond Wi-Fi/BLE/DECT packet bursts within the capture window).
   * Core 1 performs an **FFT shift** (putting $-f_s/2$ at bin `0`, $f_c$ at bin $N/2$, and $+f_s/2$ at bin $N-1$), converts to logarithmic $0.5\text{ dB}$ steps (`uint8_t`, where `0..255` maps to `-127.5..0.0 dBFS`), and transmits a compact `0x84` frame.
2. **Mode B: Raw I/Q Snapshot Mode (`0x85` for Time-Domain, Constellation & Browser Demodulation):**
   * Core 1 captures $N \in \{1024, 2048, 4096, 8192, 16380\}$ samples, sign-extends the 10-bit $(I, Q)$ values, scales them to signed 8-bit pairs (`int8_t I = raw_I >> 2`, `int8_t Q = raw_Q >> 2`), and transmits the interleaved `[I0, Q0, I1, Q1, ...]` buffer to the PWA.

### 3.2 Host-to-Device SDR Commands (8-Byte Fixed Frame)
Structure: `[0xAA, 0x55, CMD_ID, P1, P2, P3, P4, XOR_CHECKSUM]`

1. **`0x30 (CMD_SDR_TUNE)` — Tune Frequency, Sample Rate / BW & Gain:**
   * `P1..P2`: `uint16_t center_freq_mhz` (Little Endian, `1842` to `2790` MHz).
   * `P3 (RATE_BW_CODE)`:
     * `0` = `80 MSa/s` (80 MHz span, ~54 MHz analog 3dB BW)
     * `1` = `40 MSa/s` (40 MHz span, ~28 MHz analog 3dB BW)
     * `2` = `20 MSa/s` (20 MHz span, ~16 MHz analog 3dB BW)
     * `3` = `16 MSa/s` (16 MHz span, ~12 MHz analog 3dB BW)
   * `P4 (GAIN_INDEX)`:
     * `0xFF` = Hardware Automatic Gain Control (AGC).
     * `0x00..0x48` (`0..72`) = Manual fixed gain index.

2. **`0x31 (CMD_SDR_STREAM_CTRL)` — Start / Stop SDR Engine:**
   * `P1 (STREAM_MODE)`:
     * `0` = **Stop SDR** (Halts Core 1 SDR loop and releases Core 1 for Logic Analyzer captures).
     * `1` = **Continuous On-Chip FFT Spectrum Stream (`0x84`)**.
     * `2` = **Single Raw I/Q Snapshot (`0x85`)**.
     * `3` = **Continuous Raw I/Q Stream (`0x85`)**.
   * `P2 (SIZE_PARAM)`:
     * In FFT mode (`P1 == 1`): `log2(N_BINS)` where `8` = 256, `9` = 512, `10` = 1024, `11` = 2048 bins.
     * In Raw I/Q mode (`P1 == 2` or `3`): Sample count in multiples of 1024 (`1..16`, where `16` = 16,380 max samples).
   * `P3 (DSP_FLAGS)`:
     * Bit `0`: `0` = Mean Power averaging across burst sub-windows, `1` = Max-Hold Peak detector across sub-windows.
     * Bit `1`: `1` = Enable software mean DC subtraction & 3-bin center LO notch interpolation.
     * Bits `4..7`: Number of sub-windows to average per frame (`1..16`, default `8`).
   * `P4 (TARGET_FPS)`: Target frame rate (`5..60` FPS, default `30`).

3. **`0x32 (CMD_SDR_SWEEP_CFG)` — Wideband Panoramic Frequency Sweep (Optional Ultra-Wide Mode):**
   * Steps `center_freq_mhz` automatically from `start_mhz` (`P1..P2`) across `P3` steps of `40 MHz` (`P4` = dwell frames), stitching a panoramic `1.84–2.79 GHz` sweep in the PWA.

### 3.3 Device-to-Host SDR Frames
Structure: `[0xAA, 0x55, TYPE_ID, LEN_L, LEN_H, ...PAYLOAD..., XOR_CHECKSUM]`

1. **`TYPE_ID = 0x84 (SDR_SPECTRUM_FRAME)` (`LEN = 8 + N_BINS` Bytes):**
   * `Bytes 0..1`: `uint16_t center_freq_mhz` (Exact frequency of this frame).
   * `Byte 2`: `uint8_t rate_bw_code` (`0`..`3`).
   * `Byte 3`: `uint8_t active_gain_index` (Hardware gain index read from bits `20..27` of captured words).
   * `Bytes 4..5`: `uint16_t fft_bins` ($N \in \{256, 512, 1024, 2048\}$).
   * `Byte 6`: `uint8_t status_flags`:
     * `Bit 0`: `1` if any sample in the burst hit $\pm 511$ ADC saturation (`ADC_CLIP`).
     * `Bit 1`: `1` if sentinel verification failed (`CAPTURE_TRUNCATED`).
   * `Byte 7`: `uint8_t reserved`.
   * `Bytes 8..(8+N-1)`: `uint8_t power_bins[N]` in **FFT-shifted order** (`bin[0]` = $-f_s/2$, `bin[N/2]` = $f_c$, `bin[N-1]` = $+f_s/2$). Value encoding: `dBFS = (byte_val * 0.5) - 127.5`.

2. **`TYPE_ID = 0x85 (SDR_RAW_IQ_FRAME)` (`LEN = 8 + 2 * N_SAMPLES` Bytes):**
   * `Bytes 0..1`: `uint16_t center_freq_mhz`.
   * `Byte 2`: `uint8_t rate_bw_code`.
   * `Byte 3`: `uint8_t active_gain_index`.
   * `Bytes 4..5`: `uint16_t sample_count` ($N$).
   * `Byte 6`: `uint8_t status_flags` (`ADC_CLIP` / `CAPTURE_TRUNCATED`).
   * `Byte 7`: `uint8_t reserved`.
   * `Bytes 8..end`: Interleaved signed 8-bit pairs `[int8_t I_0, int8_t Q_0, ...]`.

---

## 4. Resource Arbitration: Logic Analyzer + Force I/O + SDR Coexistence

1. **Core 1 Task Arbitration:**
   * A single Core 1 worker task manages both **Logic Analyzer Capture (`0x20`)** and **SDR Acquisition (`0x31`)**.
   * If SDR streaming is active and the user triggers a Logic Analyzer capture (`0x20`), Core 1 pauses SDR acquisition for the duration of the logic capture, sends the `0x82` logic frame, and automatically resumes SDR streaming.
2. **Simultaneous GPIO Force I/O During SDR Operation (Hardware-in-the-Loop):**
   * The 8-channel Tri-State Force outputs (`D0`–`D7` driven to `0`, `1`, or `Z`) and 20 ms contention protection on Core 0 remain **100% active while SDR is running**.
   * This enables interactive RF hardware debugging: the user can toggle or pulse a target board's `TX_EN`, `CHIP_EN`, or `BOOT` pin via `D0`–`D7` and immediately observe the resulting 1.9 GHz / 2.4 GHz RF burst on the SDR waterfall.

---

## 5. PWA Frontend Specification: `[ RF / SDR ]` Workspace (`/web`)

Extend the existing PWA top navigation bar with a mode switcher: **`[ Logic Analyzer (8ch) ]` | `[ RF Spectrum (SDR) ]`** while keeping the bottom collapsible `xterm.js` drawer accessible in both views.

### 5.1 SDR Top Control Bar
1. **Center Frequency Tuner (`1842` – `2790 MHz`):**
   * Large interactive MHz readout supporting per-digit scroll/touch-drag and direct keyboard entry, plus an amber badge when tuned below `2210 MHz` showing `5/6 LO Divider Active`.
   * **Band Quick-Jump Chips:**
     * `[ DECT 1910 ]`
     * `[ 13cm Ham 2350 ]`
     * `[ Wi-Fi Ch1 2412 ]` `[ Ch6 2437 ]` `[ Ch11 2462 ]`
     * `[ BLE Adv 2402 / 2426 / 2480 ]`
     * `[ LTE B7 2650 ]`
2. **Sample Rate / Anti-Aliased Span Selector:** `80 MHz`, `40 MHz`, `20 MHz`, `16 MHz`.
3. **Resolution & Detector Controls:**
   * FFT Size: `256`, `512`, `1024`, `2048` bins.
   * On-Chip Detector: `[ Mean Avg ]` vs. `[ Max-Hold Burst ]` (default to `Max-Hold` when inspecting packetized Wi-Fi/BLE traffic so microsecond packets are never averaged out).
   * `[ DC Spike Notch ]` toggle, `[ Spur Blanker ]` toggle (suppresses known S3 crystal harmonics), & `[ Clear Peak Hold ]` button.
4. **Gain & Overload Indicator:**
   * `[ AGC ]` toggle + Manual Gain slider (`0..72`).
   * Live telemetry pill displaying `HW Gain: <active_gain_index> dB` and a red `ADC CLIP` badge when `status_flags & 1` is non-zero.
5. **Inline Mini Force-I/O Strip (`D0`–`D7`):**
   * A compact single-line strip showing the 8 pins (`D0`–`D7`) with quick `[Z / 0 / 1 / ⚡]` toggles right inside the SDR view so the user can trigger an external transmitter without switching tabs.

### 5.2 High-DPI Dual-Canvas Display (60 FPS Spectrum + Waterfall)
1. **Upper Canvas (40% height) — Real-Time FFT Spectrum Plot:**
   * Renders the live dBFS spectrum trace (cyan), an exponential moving-average trace (blue), and an optional Peak-Hold envelope trace (amber).
   * Calibrated frequency grid in MHz ($f_c - f_s/2$ to $f_c + f_s/2$) with vertical dashed markers for standard Wi-Fi/BLE channel boundaries when inside `2400–2485 MHz`.
   * Interactive crosshair cursor + draggable **Peak Marker (`M1`)** and **Delta Marker (`M2`)** displaying exact frequency (MHz), channel power (dBFS), SNR above noise floor, and $\Delta f$ bandwidth.
2. **Lower Canvas (60% height) — High-Speed Scrolling Waterfall:**
   * Uses a persistent offscreen `ImageData` / WebGL texture that shifts down by 1 pixel row on each `0x84` frame and writes the new color-mapped FFT row at `y = 0` using a 256-entry precomputed RGBA lookup table (`Turbo`, `Viridis`, or `Inferno` colormap).
   * Interactive `Min dBFS` (Floor) and `Max dBFS` (Ceiling) range sliders to optimize waterfall contrast dynamically.
3. **Raw I/Q Inspector Drawer / Modal (Mode B — `0x85` Frames):**
   * When switched to `Raw I/Q Snapshot`, renders:
     * **Time-Domain Plot:** $I(t)$ (cyan), $Q(t)$ (magenta), and instantaneous envelope $\sqrt{I^2 + Q^2}$ (white) to measure packet length and symbol rate in microseconds.
     * **Constellation Diagram:** 2D $I$ vs. $Q$ scatter plot with density persistence to inspect phase noise, DC offset, and modulation states (BPSK/QPSK/GFSK/OFDM).