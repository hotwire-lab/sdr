export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 s';
  if (seconds === 0) return '0 s';
  const abs = Math.abs(seconds);
  if (abs < 1e-6) return `${(seconds * 1e9).toFixed(abs < 1e-7 ? 1 : 0)} ns`;
  if (abs < 1e-3) return `${(seconds * 1e6).toFixed(abs < 1e-5 ? 2 : 1)} µs`;
  if (abs < 1) return `${(seconds * 1e3).toFixed(abs < 0.01 ? 2 : 1)} ms`;
  return `${seconds.toFixed(2)} s`;
}

export function formatSignedDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${formatDuration(Math.abs(seconds))}`;
}

export function formatResolution(rateHz: number): string {
  if (rateHz <= 0) return '-';
  const periodSec = 1 / rateHz;
  if (periodSec < 1e-6) return `${Math.round(periodSec * 1e9)} ns`;
  if (periodSec < 1e-3) {
    const us = periodSec * 1e6;
    return `${us >= 10 ? Math.round(us) : us.toFixed(1)} µs`;
  }
  return `${(periodSec * 1e3).toFixed(1)} ms`;
}

export function formatFrequency(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '-';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(1)} Hz`;
}
