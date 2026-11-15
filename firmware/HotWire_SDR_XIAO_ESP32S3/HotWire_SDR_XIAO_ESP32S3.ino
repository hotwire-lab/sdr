/*
 * HotWire SDR - Dedicated 1.84–2.79 GHz RF Spectrum Analyzer Firmware for Seeed Studio XIAO ESP32-S3
 *
 * Implements Spec: hotwire_sdr_rf_spectrum_analyzer_extension_specification_xiao_esp32_s3.md
 * - Dual-Core Operation:
 *     Core 0: USB CDC Binary Protocol Demuxer & Serial Command Dispatcher
 *     Core 1: Dedicated ESP32-S3 RF Dump DSP Engine (IQ acquisition, FFT/Windowing, Waterfall/Spectrum stream)
 * - RF Dump Engine Memory Region Reserved: 0x3FCD0000 .. 0x3FCDFFFF
 * - Tuning Range: 1842 .. 2790 MHz (5/6 LO divider via I2C block 0x63 < 2210 MHz)
 *
 * Arduino Tools Settings:
 *   - Board: "XIAO_ESP32S3" (Seeed Studio XIAO ESP32S3)
 *   - USB CDC On Boot: "Enabled"
 *   - CPU Frequency: "240MHz (WiFi)"
 */

#include <Arduino.h>
#include <math.h>
#include "driver/gpio.h"
#include "soc/gpio_struct.h"
#include "soc/soc.h"
#include "soc/soc_caps.h"
#include "soc/rtc_cntl_reg.h"
#include "soc/soc_memory_layout.h"
#include "esp_cpu.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_rom_sys.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_phy_init.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#ifndef CONFIG_IDF_TARGET_ESP32S3
  #error "This SDR firmware targets Seeed Studio XIAO ESP32-S3 (ESP32-S3 RF Dump Engine)."
#endif

// Reserve physical 64 KB SRAM block 0x3FCD0000 - 0x3FCDFFFF from heap allocator
SOC_RESERVE_MEMORY_REGION(0x3fcd0000, 0x3fce0000, s3_rf_dump);

// Internal PHY & ROM radio calibration functions verified for ESP32-S3 (Arduino ESP32 3.3.11)
extern "C" {
  void phy_set_freq(uint16_t freq_mhz, int16_t offset);
  void set_chanfreq(unsigned mhz, unsigned bw);
  void set_rf_freq_offset(unsigned mode, unsigned mhz, int offset_khz);
  void stop_tx_tone(unsigned en);
  void rom_pbus_workmode(void);
  void rom_pbus_xpd_rx_on(unsigned en);
  void rom_pbus_xpd_tx_off(void);
  void rom_set_rxclk_en(unsigned en);
  void rom_rx_gain_force(unsigned enable, unsigned gain);
  unsigned rom_chip_i2c_readReg(unsigned block, unsigned host_id, unsigned reg_add);
  void rom_chip_i2c_writeReg(unsigned block, unsigned host_id, unsigned reg_add, unsigned data);
  uint8_t rom_i2c_readReg(uint8_t block, uint8_t host_id, uint8_t reg_add);
  void rom_i2c_writeReg(uint8_t block, uint8_t host_id, uint8_t reg_add, uint8_t data);
  void rom_i2c_writeReg_Mask(uint8_t block, uint8_t host_id, uint8_t reg_add, uint8_t msb, uint8_t lsb, uint8_t data);
}

// -----------------------------------------------------------------------------
// Hardware Constants (XIAO ESP32-S3)
// -----------------------------------------------------------------------------

#define HOTWIRE_FW_VERSION "2.0.0-sdr"
#define HOTWIRE_BOARD_NAME "XIAO-ESP32-S3"

static const char* const BOARD_NAME = HOTWIRE_BOARD_NAME;
static const uint32_t CPU_FREQ_HZ = 240000000UL;

// -----------------------------------------------------------------------------
// ESP32-S3 RF Dump Engine Constants & Registers
// -----------------------------------------------------------------------------

static const uint32_t RF_DUMP_SRAM_BASE   = 0x3FCD0000UL;
static const uint32_t RF_DUMP_MAX_SAMPLES = 16380UL;
static const uint32_t RF_DUMP_SENTINEL    = 0xA5A0055AUL;

static const uint32_t REG_SRAM_ARBITER    = 0x600C101CUL; // Modify ONLY bits [3:0]
static const uint32_t REG_RF_DUMP_CFG     = 0x60033D90UL;
static const uint32_t REG_RF_DUMP_CTRL    = 0x60033D5CUL;

static const uint16_t SDR_MIN_FREQ_MHZ    = 1842;
static const uint16_t SDR_MAX_FREQ_MHZ    = 2790;
static const uint16_t SDR_LO_DIV_THRESH   = 2210;

static const uint8_t SDR_FLAG_ADC_CLIP         = 0x01;
static const uint8_t SDR_FLAG_CAPTURE_TRUNC    = 0x02;
static const uint8_t SDR_FLAG_LO_DIV_ACTIVE    = 0x04;

static const uint8_t SDR_STREAM_STOP      = 0;
static const uint8_t SDR_STREAM_FFT       = 1;
static const uint8_t SDR_STREAM_SINGLE_IQ = 2;
static const uint8_t SDR_STREAM_CONT_IQ   = 3;

static const uint16_t MAX_FFT_BINS        = 2048;

// -----------------------------------------------------------------------------
// Binary Multiplexing Protocol Definitions
// -----------------------------------------------------------------------------

static const uint8_t SYNC_BYTE_0 = 0xAA;
static const uint8_t SYNC_BYTE_1 = 0x55;

static const uint8_t CMD_PING_STATUS = 0x01;
static const uint8_t CMD_GET_CAPS    = 0x02;
static const uint8_t CMD_SDR_TUNE    = 0x30;
static const uint8_t CMD_SDR_STREAM  = 0x31;
static const uint8_t CMD_SDR_SWEEP   = 0x32;
static const uint8_t CMD_BOOTLOADER  = 0xF0;

static const uint8_t TYPE_BOARD_CAPABILITIES = 0x83;
static const uint8_t TYPE_SDR_SPECTRUM_FRAME = 0x84;
static const uint8_t TYPE_SDR_RAW_IQ_FRAME   = 0x85;

// -----------------------------------------------------------------------------
// Shared Firmware State & Buffers
// -----------------------------------------------------------------------------

static SemaphoreHandle_t stateMutex = nullptr;
static SemaphoreHandle_t txMutex = nullptr;
static portMUX_TYPE rfSpinlock = portMUX_INITIALIZER_UNLOCKED;

// SDR working buffers (heap allocated outside reserved 0x3FCD0000..0x3FCDFFFF)
static int16_t* sdrIqI = nullptr;
static int16_t* sdrIqQ = nullptr;
static float* sdrFftRe = nullptr;
static float* sdrFftIm = nullptr;
static float* sdrPwrAcc = nullptr;
static float* sdrHann = nullptr;
static uint8_t* sdrQuantBins = nullptr;
static uint8_t* sdrTxFrame = nullptr; // 5 + 8 + max(2048, 32760) + 1 = 32782 bytes max

static TaskHandle_t core0TaskHandle = nullptr;
static TaskHandle_t core1TaskHandle = nullptr;

// SDR Control & Runtime State
struct SdrConfig {
  uint16_t centerFreqMhz;
  uint8_t rateBwCode;
  uint8_t gainIndex;      // 0xFF = AGC, 0..72 = Manual
  uint8_t streamMode;     // 0=Stop, 1=FFT, 2=SingleIQ, 3=ContIQ
  uint8_t sizeParam;      // log2(N) [8..11] in FFT, KB [1..16] in IQ
  uint8_t dspFlags;       // bit0=MaxHold, bit1=DC cancel, bits4..7=subWindows-1
  uint8_t targetFps;
  uint16_t sweepStartMhz;
  uint8_t sweepSteps;
  uint8_t sweepDwellFrames;
};

static volatile SdrConfig sdrCfg = {
  2437, 0, 0xFF, SDR_STREAM_STOP, 10, 0x02 | (3 << 4), 20, 2400, 0, 4
};
static volatile bool sdrTuneDirty = false;
static volatile bool sdrStreamDirty = false;
static volatile bool wifiPhyReady = false;
static volatile int lastWifiErr = 0;
static uint16_t sdrAppliedFreqMhz = 2437;
static uint8_t sdrAppliedBwCode = 0;
static uint8_t sdrAppliedGainIdx = 0xFF;
static bool sdrAppliedLoDiv = false;
static bool sdrTuneInitialized = false;

// -----------------------------------------------------------------------------
// Non-Blocking Chunked Binary Frame Transmitter
// -----------------------------------------------------------------------------

static void writeChunkedLocked(const uint8_t* data, size_t len) {
  static const size_t CHUNK_SIZE = 512;
  size_t offset = 0;
  uint32_t stallCount = 0;

  while (offset < len) {
    size_t remaining = len - offset;
    size_t toSend = (remaining > CHUNK_SIZE) ? CHUNK_SIZE : remaining;

    int avail = Serial.availableForWrite();
    if (avail > 0 && (size_t)avail < toSend) {
      toSend = (size_t)avail;
    }

    if (avail <= 0) {
      stallCount++;
      if (stallCount > 250) break;
      vTaskDelay(1);
      continue;
    }

    size_t written = Serial.write(data + offset, toSend);
    if (written == 0) {
      stallCount++;
      if (stallCount > 250) break;
      vTaskDelay(1);
      continue;
    }

    stallCount = 0;
    offset += written;
    if (offset < len && (offset % 1024U) == 0) {
      vTaskDelay(1);
    }
  }
}

static void sendBinaryFrame(uint8_t typeId, const uint8_t* payload, uint16_t payloadLen) {
  uint8_t header[5] = {
    SYNC_BYTE_0,
    SYNC_BYTE_1,
    typeId,
    (uint8_t)(payloadLen & 0xFFU),
    (uint8_t)((payloadLen >> 8) & 0xFFU)
  };

  uint8_t xorSum = 0;
  for (size_t i = 0; i < sizeof(header); i++) xorSum ^= header[i];
  for (uint16_t i = 0; i < payloadLen; i++) xorSum ^= payload[i];

  if (txMutex) xSemaphoreTake(txMutex, portMAX_DELAY);

  if (payloadLen <= 64) {
    uint8_t smallFrame[70];
    memcpy(smallFrame, header, sizeof(header));
    if (payloadLen > 0 && payload != nullptr) {
      memcpy(smallFrame + sizeof(header), payload, payloadLen);
    }
    smallFrame[sizeof(header) + payloadLen] = xorSum;
    writeChunkedLocked(smallFrame, sizeof(header) + payloadLen + 1);
  } else {
    writeChunkedLocked(header, sizeof(header));
    if (payloadLen > 0 && payload != nullptr) {
      writeChunkedLocked(payload, payloadLen);
    }
    writeChunkedLocked(&xorSum, 1);
  }

  if (txMutex) xSemaphoreGive(txMutex);
}

static void sendCapabilitiesFrame() {
  static const char CAPS_JSON[] =
    "{\"board\":\"XIAO-ESP32-S3\",\"firmware\":\"" HOTWIRE_FW_VERSION "\",\"sdr\":true}";
  sendBinaryFrame(TYPE_BOARD_CAPABILITIES, (const uint8_t*)CAPS_JSON, (uint16_t)(sizeof(CAPS_JSON) - 1));
}

static void sendTextLocked(const char* text) {
  if (txMutex) xSemaphoreTake(txMutex, portMAX_DELAY);
  Serial.print(text);
  if (txMutex) xSemaphoreGive(txMutex);
}

// -----------------------------------------------------------------------------
// ESP32-S3 SDR Hardware Engine: RFPLL Tuning, Baseband Filters & RF Dump Engine
// -----------------------------------------------------------------------------

static void initWifiRadioSubsystem() {
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    nvs_flash_erase();
    nvs_flash_init();
  }

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  cfg.nvs_enable = 0;
  cfg.static_rx_buf_num = 4;
  cfg.dynamic_rx_buf_num = 8;
  cfg.tx_buf_type = 1;
  cfg.dynamic_tx_buf_num = 8;
  esp_err_t err = esp_wifi_init(&cfg);
  lastWifiErr = (int)err;
  if (err != ESP_OK) {
    return;
  }
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_STA);
  esp_wifi_start();
  esp_wifi_set_ps(WIFI_PS_NONE);

  // Keep continuous RX clock running without packet-copy overhead
  wifi_promiscuous_filter_t filt = { .filter_mask = 0 };
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous(true);
  esp_phy_enable(PHY_MODEM_WIFI);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  delay(80);

  wifiPhyReady = true;
}

static void rxLoSelect(bool useLoDiv) {
  unsigned old65 = rom_chip_i2c_readReg(0x65, 1, 0);
  unsigned next65 = (old65 & ~0x10U) | (useLoDiv ? 0x10U : 0U);
  if (next65 != old65) {
    rom_chip_i2c_writeReg(0x65, 1, 0, next65);
  }
  rom_i2c_writeReg_Mask(0x63, 1, 0, 4, 4, useLoDiv ? 0 : 1);
}

static void sdrApplyGain(uint8_t gainIndex) {
  if (gainIndex == 0xFFU || gainIndex > 82U) {
    REG_CLR_BIT(0x6001C02CU, 1UL << 23);
    rom_rx_gain_force(0, 0);
  } else {
    rom_rx_gain_force(0, gainIndex);
    esp_rom_delay_us(2);
    rom_rx_gain_force(1, gainIndex);
    esp_rom_delay_us(2);
  }
}

static void sdrApplyTune(uint16_t freqMhz, uint8_t bwCode, uint8_t gainIndex) {
  if (!wifiPhyReady) return;

  if (freqMhz < SDR_MIN_FREQ_MHZ) freqMhz = SDR_MIN_FREQ_MHZ;
  if (freqMhz > SDR_MAX_FREQ_MHZ) freqMhz = SDR_MAX_FREQ_MHZ;
  bwCode &= 0x03U;

  if (sdrTuneInitialized && freqMhz == sdrAppliedFreqMhz) {
    sdrApplyGain(gainIndex);
    sdrAppliedBwCode = bwCode;
    sdrAppliedGainIdx = gainIndex;
    return;
  }

  // Release manual gain before retuning RFPLL / PBUS RX path
  REG_CLR_BIT(0x6001C02CU, 1UL << 23);
  rom_rx_gain_force(0, 0);
  rxLoSelect(false);

  const bool useLoDiv = (freqMhz < SDR_LO_DIV_THRESH);
  const uint32_t khz = (uint32_t)freqMhz * (useLoDiv ? 1200UL : 1000UL);
  const unsigned pllMhz = (unsigned)(khz / 1000UL);
  const int offsetKhz = (int)(khz % 1000UL);
  const bool isWifiChan = (
    !useLoDiv &&
    ((freqMhz >= 2412 && freqMhz <= 2472 && ((freqMhz - 2412) % 5 == 0)) || freqMhz == 2484)
  );

  set_chanfreq(isWifiChan ? freqMhz : 2412U, 0);
  if (!isWifiChan) {
    set_rf_freq_offset(0, pllMhz, offsetKhz);
  }

  stop_tx_tone(1);
  rom_pbus_workmode();
  rom_pbus_xpd_tx_off();
  rom_pbus_xpd_rx_on(1);
  rom_set_rxclk_en(1);
  rxLoSelect(useLoDiv);
  esp_rom_delay_us(3000);

  sdrApplyGain(gainIndex);

  sdrAppliedFreqMhz = freqMhz;
  sdrAppliedBwCode = bwCode;
  sdrAppliedGainIdx = gainIndex;
  sdrAppliedLoDiv = useLoDiv;
  sdrTuneInitialized = true;
}

static bool IRAM_ATTR iqvCaptureSnapshot(
  uint32_t numSamples,
  uint8_t divCode,
  int16_t* outI,
  int16_t* outQ,
  uint8_t* outActiveGain,
  bool* outAdcClip,
  bool* outTruncated
) {
  if (numSamples == 0 || numSamples > RF_DUMP_MAX_SAMPLES) {
    numSamples = RF_DUMP_MAX_SAMPLES;
  }
  divCode &= 0x03U;

  volatile uint32_t* dumpMem = (volatile uint32_t*)RF_DUMP_SRAM_BASE;
  volatile uint32_t* arbiter = (volatile uint32_t*)REG_SRAM_ARBITER;
  volatile uint32_t* rfCfg   = (volatile uint32_t*)REG_RF_DUMP_CFG;
  volatile uint32_t* rfCtrl  = (volatile uint32_t*)REG_RF_DUMP_CTRL;

  // Apply analog baseband filter (I2C block 0x67, host 0, regs 4 & 5) only around capture
  unsigned savedBb4 = 0;
  unsigned savedBb5 = 0;
  if (divCode > 0U) {
    savedBb4 = rom_chip_i2c_readReg(0x67, 0, 4);
    savedBb5 = rom_chip_i2c_readReg(0x67, 0, 5);
    const unsigned dcap = (divCode == 1U) ? 12U : ((divCode == 2U) ? 32U : 48U);
    rom_chip_i2c_writeReg(0x67, 0, 4, (savedBb4 & ~63U) | dcap);
    rom_chip_i2c_writeReg(0x67, 0, 5, (savedBb5 & ~63U) | dcap);
  }

  // Step 1: Stamp end sentinel while CPU still owns SRAM
  dumpMem[numSamples - 1U] = RF_DUMP_SENTINEL;
  __sync_synchronize();

  portENTER_CRITICAL(&rfSpinlock);

  // Step 2: Reset control reg, enable debug lanes & grant SRAM bank (bits [3:0])
  *rfCtrl = 0x00000000UL;
  *rfCfg = 0x000C2040UL; // 0u | (1u << 6) | (2u << 12) | (3u << 18)
  uint32_t arbOrig = *arbiter;
  *arbiter = (arbOrig & ~0x0FUL) | 0x04UL;

  // Step 3: Configure & execute mandatory 3-write trigger sequence
  const uint32_t ctrl = 0x80000000UL
                      | (((uint32_t)divCode & 0x03UL) << 15)
                      | (numSamples & 0x7FFFUL);
  *rfCtrl = ctrl;
  *rfCtrl = ctrl | (1UL << 19);
  *rfCtrl = ctrl;

  // Step 4: Poll completion bit 18 (bounded)
  uint32_t timeout = 120000UL;
  while (((*rfCtrl & (1UL << 18)) == 0UL) && (--timeout > 0UL)) {
    asm volatile("nop");
  }

  // Step 5: Clear capture engine & return SRAM ownership to CPU
  *rfCtrl = 0x00000000UL;
  *arbiter = (*arbiter & ~0x0FUL);
  __sync_synchronize();

  portEXIT_CRITICAL(&rfSpinlock);

  if (divCode > 0U) {
    rom_chip_i2c_writeReg(0x67, 0, 4, savedBb4);
    rom_chip_i2c_writeReg(0x67, 0, 5, savedBb5);
  }

  // Step 7: Inspect sentinel and unpack 10-bit signed I/Q words + active gain
  bool truncated = (timeout == 0UL) || (dumpMem[numSamples - 1U] == RF_DUMP_SENTINEL);
  bool clipped = false;
  uint8_t latestGain = 0;

  for (uint32_t i = 0; i < numSamples; i++) {
    uint32_t w = dumpMem[i];
    int16_t valI = (int16_t)(((int32_t)(w << 22)) >> 22);
    int16_t valQ = (int16_t)(((int32_t)(w << 12)) >> 22);
    if (i + 1U == numSamples) {
      latestGain = (uint8_t)((w >> 20) & 0xFFU);
    }
    if (valI >= 510 || valI <= -510 || valQ >= 510 || valQ <= -510) {
      clipped = true;
    }
    outI[i] = valI;
    outQ[i] = valQ;
  }

  *outActiveGain = latestGain;
  *outAdcClip = clipped;
  *outTruncated = truncated;
  return !truncated;
}

// Radix-2 In-Place Complex FFT (DIT)
static void buildHannWindow(uint16_t n) {
  static uint16_t cachedN = 0;
  if (cachedN == n || sdrHann == nullptr) return;
  const float twoPiOverNm1 = (2.0f * (float)M_PI) / (float)(n - 1U);
  for (uint16_t i = 0; i < n; i++) {
    sdrHann[i] = 0.5f * (1.0f - cosf(twoPiOverNm1 * (float)i));
  }
  cachedN = n;
}

static void computeRadix2Fft(float* re, float* im, uint16_t n) {
  // Bit-reversal permutation
  uint16_t j = 0;
  for (uint16_t i = 0; i < n; i++) {
    if (i < j) {
      float tr = re[i]; float ti = im[i];
      re[i] = re[j]; im[i] = im[j];
      re[j] = tr; im[j] = ti;
    }
    uint16_t bit = n >> 1;
    while (bit > 0 && (j & bit)) {
      j &= ~bit;
      bit >>= 1;
    }
    j |= bit;
  }

  // Iterative Cooley-Tukey stages
  for (uint16_t len = 2; len <= n; len <<= 1) {
    float ang = -2.0f * (float)M_PI / (float)len;
    float wlenRe = cosf(ang);
    float wlenIm = sinf(ang);
    uint16_t half = len >> 1;

    for (uint16_t start = 0; start < n; start += len) {
      float wRe = 1.0f;
      float wIm = 0.0f;
      for (uint16_t k = 0; k < half; k++) {
        uint16_t idxEven = start + k;
        uint16_t idxOdd  = idxEven + half;
        float uRe = re[idxEven];
        float uIm = im[idxEven];
        float tRe = wRe * re[idxOdd] - wIm * im[idxOdd];
        float tIm = wRe * im[idxOdd] + wIm * re[idxOdd];
        re[idxEven] = uRe + tRe;
        im[idxEven] = uIm + tIm;
        re[idxOdd]  = uRe - tRe;
        im[idxOdd]  = uIm - tIm;

        float nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
}

static void sendSdrSpectrumFrame(
  uint16_t centerFreqMhz,
  uint8_t rateBwCode,
  uint8_t activeGainIndex,
  uint16_t fftBins,
  uint8_t statusFlags,
  const uint8_t* quantizedBins
) {
  const uint16_t payloadLen = (uint16_t)(8U + fftBins);
  uint8_t* frame = sdrTxFrame;
  frame[0] = SYNC_BYTE_0;
  frame[1] = SYNC_BYTE_1;
  frame[2] = TYPE_SDR_SPECTRUM_FRAME;
  frame[3] = (uint8_t)(payloadLen & 0xFFU);
  frame[4] = (uint8_t)((payloadLen >> 8) & 0xFFU);

  // 8-byte Spectrum Payload Header
  frame[5] = (uint8_t)(centerFreqMhz & 0xFFU);
  frame[6] = (uint8_t)((centerFreqMhz >> 8) & 0xFFU);
  frame[7] = rateBwCode & 0x03U;
  frame[8] = activeGainIndex;
  frame[9] = (uint8_t)(fftBins & 0xFFU);
  frame[10] = (uint8_t)((fftBins >> 8) & 0xFFU);
  frame[11] = statusFlags;
  frame[12] = 0;

  memcpy(frame + 13, quantizedBins, fftBins);

  uint8_t xorSum = 0;
  const size_t withoutXor = 13U + fftBins;
  for (size_t i = 0; i < withoutXor; i++) {
    xorSum ^= frame[i];
  }
  frame[withoutXor] = xorSum;

  if (txMutex) xSemaphoreTake(txMutex, portMAX_DELAY);
  writeChunkedLocked(frame, withoutXor + 1U);
  if (txMutex) xSemaphoreGive(txMutex);
}

static void sendSdrRawIqFrame(
  uint16_t centerFreqMhz,
  uint8_t rateBwCode,
  uint8_t activeGainIndex,
  uint16_t sampleCount,
  uint8_t statusFlags,
  const int16_t* rawI,
  const int16_t* rawQ,
  bool dcCancel
) {
  int32_t meanI = 0;
  int32_t meanQ = 0;
  if (dcCancel && sampleCount > 0) {
    int64_t sumI = 0;
    int64_t sumQ = 0;
    for (uint16_t i = 0; i < sampleCount; i++) {
      sumI += rawI[i];
      sumQ += rawQ[i];
    }
    meanI = (int32_t)(sumI / sampleCount);
    meanQ = (int32_t)(sumQ / sampleCount);
  }

  const uint16_t payloadLen = (uint16_t)(8U + sampleCount * 2U);
  uint8_t* frame = sdrTxFrame;
  frame[0] = SYNC_BYTE_0;
  frame[1] = SYNC_BYTE_1;
  frame[2] = TYPE_SDR_RAW_IQ_FRAME;
  frame[3] = (uint8_t)(payloadLen & 0xFFU);
  frame[4] = (uint8_t)((payloadLen >> 8) & 0xFFU);

  frame[5] = (uint8_t)(centerFreqMhz & 0xFFU);
  frame[6] = (uint8_t)((centerFreqMhz >> 8) & 0xFFU);
  frame[7] = rateBwCode & 0x03U;
  frame[8] = activeGainIndex;
  frame[9] = (uint8_t)(sampleCount & 0xFFU);
  frame[10] = (uint8_t)((sampleCount >> 8) & 0xFFU);
  frame[11] = statusFlags;
  frame[12] = 0;

  for (uint16_t n = 0; n < sampleCount; n++) {
    int32_t si = ((int32_t)rawI[n] - meanI) >> 2;
    int32_t sq = ((int32_t)rawQ[n] - meanQ) >> 2;
    if (si > 127) si = 127; else if (si < -128) si = -128;
    if (sq > 127) sq = 127; else if (sq < -128) sq = -128;
    frame[13U + n * 2U] = (uint8_t)((int8_t)si);
    frame[13U + n * 2U + 1U] = (uint8_t)((int8_t)sq);
  }

  const size_t withoutXor = 13U + (size_t)sampleCount * 2U;
  uint8_t xorSum = 0;
  for (size_t i = 0; i < withoutXor; i++) {
    xorSum ^= frame[i];
  }
  frame[withoutXor] = xorSum;

  if (txMutex) xSemaphoreTake(txMutex, portMAX_DELAY);
  writeChunkedLocked(frame, withoutXor + 1U);
  if (txMutex) xSemaphoreGive(txMutex);
}

// -----------------------------------------------------------------------------
// Core 1 SDR Engine Task (RF Dump Acquisition & DSP Pipeline)
// -----------------------------------------------------------------------------

static void Engine_Core1_Task(void* arg) {
  (void)arg;

  uint8_t sweepIdx = 0;
  uint8_t sweepDwellCnt = 0;

  for (;;) {
    // Check SDR Tune updates cleanly on Core 1
    SdrConfig cfg;
    cfg.centerFreqMhz    = sdrCfg.centerFreqMhz;
    cfg.rateBwCode       = sdrCfg.rateBwCode;
    cfg.gainIndex        = sdrCfg.gainIndex;
    cfg.streamMode       = sdrCfg.streamMode;
    cfg.sizeParam        = sdrCfg.sizeParam;
    cfg.dspFlags         = sdrCfg.dspFlags;
    cfg.targetFps        = sdrCfg.targetFps;
    cfg.sweepStartMhz    = sdrCfg.sweepStartMhz;
    cfg.sweepSteps       = sdrCfg.sweepSteps;
    cfg.sweepDwellFrames = sdrCfg.sweepDwellFrames;

    if (sdrTuneDirty) {
      sdrTuneDirty = false;
      sweepIdx = 0;
      sweepDwellCnt = 0;
      sdrApplyTune(cfg.centerFreqMhz, cfg.rateBwCode, cfg.gainIndex);
    }

    if (cfg.streamMode == SDR_STREAM_STOP) {
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(50));
      continue;
    }

    const TickType_t frameStartTick = xTaskGetTickCount();
    const bool dcCancel = (cfg.dspFlags & 0x02U) != 0;

    // Raw I/Q Mode (Single-Shot or Continuous 0x85)
    if (cfg.streamMode == SDR_STREAM_SINGLE_IQ || cfg.streamMode == SDR_STREAM_CONT_IQ) {
      uint32_t kb = (cfg.sizeParam < 1U) ? 1U : ((cfg.sizeParam > 16U) ? 16U : cfg.sizeParam);
      uint32_t sampleCount = kb * 1024U;
      if (sampleCount > RF_DUMP_MAX_SAMPLES) sampleCount = RF_DUMP_MAX_SAMPLES;

      uint8_t activeGain = 0;
      bool adcClip = false;
      bool trunc = false;
      iqvCaptureSnapshot(sampleCount, cfg.rateBwCode, sdrIqI, sdrIqQ, &activeGain, &adcClip, &trunc);

      uint8_t sFlags = 0;
      if (adcClip) sFlags |= SDR_FLAG_ADC_CLIP;
      if (trunc) sFlags |= SDR_FLAG_CAPTURE_TRUNC;
      if (sdrAppliedLoDiv) sFlags |= SDR_FLAG_LO_DIV_ACTIVE;

      sendSdrRawIqFrame(
        sdrAppliedFreqMhz,
        cfg.rateBwCode,
        activeGain,
        (uint16_t)sampleCount,
        sFlags,
        sdrIqI,
        sdrIqQ,
        dcCancel
      );

      if (cfg.streamMode == SDR_STREAM_SINGLE_IQ) {
        sdrCfg.streamMode = SDR_STREAM_STOP;
      } else {
        uint8_t fps = (cfg.targetFps < 5) ? 5 : ((cfg.targetFps > 30) ? 30 : cfg.targetFps);
        vTaskDelay(pdMS_TO_TICKS(1000U / fps));
      }
      continue;
    }

    // Spectrum Mode A (0x84 FFT)
    uint8_t log2Bins = cfg.sizeParam;
    if (log2Bins < 8U) log2Bins = 8U;
    if (log2Bins > 11U) log2Bins = 11U;
    const uint16_t fftBins = (uint16_t)(1U << log2Bins);
    const bool maxHold = (cfg.dspFlags & 0x01U) != 0;
    const uint8_t subWindows = (uint8_t)(((cfg.dspFlags >> 4) & 0x0FU) + 1U);

    buildHannWindow(fftBins);
    for (uint16_t k = 0; k < fftBins; k++) {
      sdrPwrAcc[k] = 0.0f;
    }

    uint8_t activeGain = 0;
    bool anyClip = false;
    bool anyTrunc = false;

    for (uint8_t w = 0; w < subWindows; w++) {
      if (sdrCfg.streamMode == SDR_STREAM_STOP || sdrTuneDirty) break;

      bool subClip = false;
      bool subTrunc = false;
      iqvCaptureSnapshot(fftBins, cfg.rateBwCode, sdrIqI, sdrIqQ, &activeGain, &subClip, &subTrunc);
      if (subClip) anyClip = true;
      if (subTrunc) anyTrunc = true;

      float meanI = 0.0f;
      float meanQ = 0.0f;
      if (dcCancel) {
        int32_t sumI = 0;
        int32_t sumQ = 0;
        for (uint16_t n = 0; n < fftBins; n++) {
          sumI += sdrIqI[n];
          sumQ += sdrIqQ[n];
        }
        meanI = (float)sumI / (float)fftBins;
        meanQ = (float)sumQ / (float)fftBins;
      }

      const float invScale = 1.0f / 512.0f;
      for (uint16_t n = 0; n < fftBins; n++) {
        const float win = sdrHann[n];
        sdrFftRe[n] = ((float)sdrIqI[n] - meanI) * invScale * win;
        sdrFftIm[n] = ((float)sdrIqQ[n] - meanQ) * invScale * win;
      }

      computeRadix2Fft(sdrFftRe, sdrFftIm, fftBins);

      // Coherent gain compensation of Hann window: 2.0 / fftBins -> (4.0 / (N*N)) in power
      const float pwrNorm = 4.0f / ((float)fftBins * (float)fftBins);
      for (uint16_t k = 0; k < fftBins; k++) {
        float magSq = (sdrFftRe[k] * sdrFftRe[k] + sdrFftIm[k] * sdrFftIm[k]) * pwrNorm;
        if (maxHold) {
          if (magSq > sdrPwrAcc[k]) sdrPwrAcc[k] = magSq;
        } else {
          sdrPwrAcc[k] += magSq;
        }
      }
    }

    if (sdrCfg.streamMode == SDR_STREAM_STOP || sdrTuneDirty) {
      continue;
    }

    const float invWin = maxHold ? 1.0f : (1.0f / (float)subWindows);
    const uint16_t halfBins = fftBins >> 1;
    for (uint16_t outIdx = 0; outIdx < fftBins; outIdx++) {
      const uint16_t fftIdx = (outIdx + halfBins) & (fftBins - 1U);
      const float pwr = sdrPwrAcc[fftIdx] * invWin;
      float dbfs = 10.0f * log10f(pwr + 1e-13f);
      if (dbfs < -127.5f) dbfs = -127.5f;
      if (dbfs > 0.0f) dbfs = 0.0f;
      long q = lroundf((dbfs + 127.5f) * 2.0f);
      if (q < 0) q = 0; else if (q > 255) q = 255;
      sdrQuantBins[outIdx] = (uint8_t)q;
    }

    uint8_t sFlags = 0;
    if (anyClip) sFlags |= SDR_FLAG_ADC_CLIP;
    if (anyTrunc) sFlags |= SDR_FLAG_CAPTURE_TRUNC;
    if (sdrAppliedLoDiv) sFlags |= SDR_FLAG_LO_DIV_ACTIVE;

    sendSdrSpectrumFrame(
      sdrAppliedFreqMhz,
      cfg.rateBwCode,
      activeGain,
      fftBins,
      sFlags,
      sdrQuantBins
    );

    // Wideband Multi-Step Sweep Progression (0x32)
    if (cfg.sweepSteps > 0) {
      sweepDwellCnt++;
      if (sweepDwellCnt >= (cfg.sweepDwellFrames < 1 ? 1 : cfg.sweepDwellFrames)) {
        sweepDwellCnt = 0;
        sweepIdx = (uint8_t)((sweepIdx + 1U) % cfg.sweepSteps);
        uint16_t nextFreq = (uint16_t)(cfg.sweepStartMhz + sweepIdx * 40U);
        if (nextFreq > SDR_MAX_FREQ_MHZ) nextFreq = SDR_MIN_FREQ_MHZ;
        sdrApplyTune(nextFreq, cfg.rateBwCode, cfg.gainIndex);
      }
    }

    // Pace to Target FPS cleanly while keeping Task Watchdog fed
    uint8_t fps = (cfg.targetFps < 5) ? 5 : ((cfg.targetFps > 60) ? 60 : cfg.targetFps);
    TickType_t targetPeriodTicks = pdMS_TO_TICKS(1000U / fps);
    if (targetPeriodTicks < 1) targetPeriodTicks = 1;
    TickType_t elapsedTicks = xTaskGetTickCount() - frameStartTick;
    if (elapsedTicks < targetPeriodTicks) {
      vTaskDelay(targetPeriodTicks - elapsedTicks);
    } else {
      vTaskDelay(1);
    }
  }
}

// -----------------------------------------------------------------------------
// Command Handlers (Core 0)
// -----------------------------------------------------------------------------

static void handleEnterBootloader(uint8_t p1, uint8_t p2, uint8_t p3, uint8_t p4) {
  if (p1 != 0xB0 || p2 != 0x07 || p3 != 0x10 || p4 != 0xAD) return;
  sdrCfg.streamMode = SDR_STREAM_STOP;
  delay(20);
  REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
  delay(10);
  esp_restart();
}

static void dispatchBinaryCommand(const uint8_t* frame) {
  const uint8_t cmdId = frame[2];
  const uint8_t p1 = frame[3];
  const uint8_t p2 = frame[4];
  const uint8_t p3 = frame[5];
  const uint8_t p4 = frame[6];

  switch (cmdId) {
    case CMD_PING_STATUS:
      sendCapabilitiesFrame();
      break;
    case CMD_GET_CAPS:
      sendCapabilitiesFrame();
      break;
    case CMD_SDR_TUNE: {
      uint16_t freq = (uint16_t)(p1 | ((uint16_t)p2 << 8));
      if (freq < SDR_MIN_FREQ_MHZ) freq = SDR_MIN_FREQ_MHZ;
      if (freq > SDR_MAX_FREQ_MHZ) freq = SDR_MAX_FREQ_MHZ;
      sdrCfg.centerFreqMhz = freq;
      sdrCfg.rateBwCode = p3 & 0x03U;
      sdrCfg.gainIndex = p4;
      sdrTuneDirty = true;
      if (core1TaskHandle != nullptr) xTaskNotifyGive(core1TaskHandle);
      break;
    }
    case CMD_SDR_STREAM:
      sdrCfg.streamMode = p1;
      sdrCfg.sizeParam = p2;
      sdrCfg.dspFlags = p3;
      sdrCfg.targetFps = p4;
      sdrStreamDirty = true;
      if (core1TaskHandle != nullptr) xTaskNotifyGive(core1TaskHandle);
      break;
    case CMD_SDR_SWEEP: {
      uint16_t startFreq = (uint16_t)(p1 | ((uint16_t)p2 << 8));
      if (startFreq < SDR_MIN_FREQ_MHZ) startFreq = SDR_MIN_FREQ_MHZ;
      if (startFreq > SDR_MAX_FREQ_MHZ) startFreq = SDR_MAX_FREQ_MHZ;
      sdrCfg.sweepStartMhz = startFreq;
      sdrCfg.sweepSteps = p3;
      sdrCfg.sweepDwellFrames = p4;
      break;
    }
    case CMD_BOOTLOADER:
      handleEnterBootloader(p1, p2, p3, p4);
      break;
    default:
      break;
  }
}

static void handleAsciiLine(const char* line) {
  if (strcmp(line, "help") == 0) {
    sendTextLocked(
      "\r\nHotWire SDR Console Commands:\r\n"
      "  help        - show command summary\r\n"
      "  status      - print active tuner/gain/LO divider state\r\n"
      "  sdr status  - print active tuner/gain/LO divider state\r\n"
      "  sdr stop    - halt SDR streaming\r\n"
      "  tune <mhz>  - tune SDR frequency (1842..2790 MHz)\r\n"
      "  version     - show firmware version\r\n"
    );
  } else if (strcmp(line, "sdr stop") == 0) {
    sdrCfg.streamMode = SDR_STREAM_STOP;
    sendTextLocked("\r\n[SDR] Stream stopped.\r\n");
  } else if (strcmp(line, "sdr status") == 0 || strcmp(line, "status") == 0) {
    char buf[192];
    snprintf(
      buf, sizeof(buf),
      "\r\n[STATUS] board=%s freq=%uMHz bw=%u gain=%u loDiv=%s mode=%u phy=%u(err=%d)\r\n",
      BOARD_NAME,
      sdrAppliedFreqMhz, sdrAppliedBwCode, sdrAppliedGainIdx,
      sdrAppliedLoDiv ? "5/6" : "1/1", sdrCfg.streamMode,
      wifiPhyReady ? 1U : 0U, lastWifiErr
    );
    sendTextLocked(buf);
  } else if (strncmp(line, "tune ", 5) == 0) {
    int mhz = atoi(line + 5);
    if (mhz >= SDR_MIN_FREQ_MHZ && mhz <= SDR_MAX_FREQ_MHZ) {
      sdrCfg.centerFreqMhz = (uint16_t)mhz;
      sdrTuneDirty = true;
      if (core1TaskHandle != nullptr) xTaskNotifyGive(core1TaskHandle);
      char buf[64];
      snprintf(buf, sizeof(buf), "\r\n[SDR] Tuning to %d MHz...\r\n", mhz);
      sendTextLocked(buf);
    } else {
      sendTextLocked("\r\n[SDR] Frequency out of range (1842..2790 MHz)\r\n");
    }
  } else if (strcmp(line, "version") == 0) {
    sendTextLocked("\r\nHotWire " HOTWIRE_FW_VERSION " (" HOTWIRE_BOARD_NAME ")\r\n");
  } else if (line[0] != '\0') {
    char buf[128];
    snprintf(buf, sizeof(buf), "\r\nUnknown command: %s\r\n", line);
    sendTextLocked(buf);
  }
}

static void Protocol_Core0_Task(void* arg) {
  (void)arg;
  uint8_t rxFrame[8];
  uint8_t rxState = 0;
  char asciiBuf[96];
  size_t asciiLen = 0;

  for (;;) {
    while (Serial.available() > 0) {
      int incoming = Serial.read();
      if (incoming < 0) break;
      const uint8_t b = (uint8_t)incoming;

      if (rxState == 0) {
        if (b == SYNC_BYTE_0) {
          rxFrame[0] = b;
          rxState = 1;
        } else if (b == '\r' || b == '\n') {
          if (asciiLen > 0) {
            asciiBuf[asciiLen] = '\0';
            handleAsciiLine(asciiBuf);
            asciiLen = 0;
          }
        } else if (b >= 32 && b < 127 && asciiLen < sizeof(asciiBuf) - 1U) {
          asciiBuf[asciiLen++] = (char)b;
        }
      } else if (rxState == 1) {
        if (b == SYNC_BYTE_1) {
          rxFrame[1] = b;
          rxState = 2;
        } else {
          rxState = (b == SYNC_BYTE_0) ? 1 : 0;
        }
      } else {
        rxFrame[rxState++] = b;
        if (rxState == 8) {
          uint8_t expectedXor = 0;
          for (uint8_t i = 0; i < 7; i++) expectedXor ^= rxFrame[i];
          if (rxFrame[7] == expectedXor) {
            dispatchBinaryCommand(rxFrame);
          }
          rxState = 0;
        }
      }
    }

    vTaskDelay(1);
  }
}

static void* allocPreferredCaps(size_t bytes, uint32_t primaryCaps, uint32_t fallbackCaps) {
  void* ptr = heap_caps_malloc(bytes, primaryCaps);
  if (ptr == nullptr && fallbackCaps != primaryCaps) {
    ptr = heap_caps_malloc(bytes, fallbackCaps);
  }
  return ptr;
}

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.setTxBufferSize(4096);
  Serial.begin(921600);

  stateMutex = xSemaphoreCreateMutex();
  txMutex = xSemaphoreCreateMutex();

  // Initialize Wi-Fi PHY & RFPLL before large heap allocations so internal DMA DRAM stays ample
  initWifiRadioSubsystem();
  sdrApplyTune(2437, 0, 0xFF);

  // Allocate SDR dynamic buffers safely outside reserved 0x3FCD0000..0x3FCDFFFF
  sdrIqI        = (int16_t*)allocPreferredCaps(RF_DUMP_MAX_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrIqQ        = (int16_t*)allocPreferredCaps(RF_DUMP_MAX_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrFftRe      = (float*)allocPreferredCaps(MAX_FFT_BINS * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrFftIm      = (float*)allocPreferredCaps(MAX_FFT_BINS * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrPwrAcc     = (float*)allocPreferredCaps(MAX_FFT_BINS * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrHann       = (float*)allocPreferredCaps(MAX_FFT_BINS * sizeof(float), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrQuantBins  = (uint8_t*)allocPreferredCaps(MAX_FFT_BINS, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);
  sdrTxFrame    = (uint8_t*)allocPreferredCaps(16U + RF_DUMP_MAX_SAMPLES * 2U, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_8BIT);

  xTaskCreatePinnedToCore(Protocol_Core0_Task, "HotWire_Proto_C0", 4096, nullptr, 3, &core0TaskHandle, 0);
  xTaskCreatePinnedToCore(Engine_Core1_Task, "HotWire_Engine_C1", 8192, nullptr, configMAX_PRIORITIES - 2, &core1TaskHandle, 1);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
