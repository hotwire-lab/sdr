use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColormapId {
    Turbo,
    Viridis,
    Inferno,
}

impl ColormapId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ColormapId::Turbo => "turbo",
            ColormapId::Viridis => "viridis",
            ColormapId::Inferno => "inferno",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "viridis" => ColormapId::Viridis,
            "inferno" => ColormapId::Inferno,
            _ => ColormapId::Turbo,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpectrumTraceStats {
    pub noise_floor_dbfs: f32,
    pub peak_dbfs: f32,
    pub peak_bin_index: usize,
    pub peak_freq_mhz: f64,
    pub snr_db: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpectrumTraceState {
    pub center_freq_mhz: f64,
    pub span_mhz: f64,
    pub fft_bins: usize,
    pub live_dbfs: Vec<f32>,
    pub avg_dbfs: Vec<f32>,
    pub peak_hold_dbfs: Vec<f32>,
    pub stats: SpectrumTraceStats,
}

#[derive(Debug, Clone, Copy)]
pub struct DspProcessOptions {
    pub dc_notch: bool,
    pub spur_blanker: bool,
    pub invert_spectrum: bool,
    pub spur_threshold_db: f32,
    pub avg_alpha: f32,
    pub clear_peak_hold: bool,
    pub peak_decay_db_per_sec: f32,
    pub dt_sec: f32,
}

impl Default for DspProcessOptions {
    fn default() -> Self {
        Self {
            dc_notch: true,
            spur_blanker: false,
            invert_spectrum: false,
            spur_threshold_db: 10.0,
            avg_alpha: 0.28,
            clear_peak_hold: false,
            peak_decay_db_per_sec: 5.0,
            dt_sec: 0.0,
        }
    }
}

const TURBO_STOPS: &[[f64; 3]] = &[
    [48.0, 18.0, 59.0],
    [65.0, 69.0, 171.0],
    [45.0, 133.0, 240.0],
    [27.0, 198.0, 198.0],
    [104.0, 238.0, 114.0],
    [213.0, 224.0, 54.0],
    [253.0, 146.0, 41.0],
    [216.0, 56.0, 20.0],
    [122.0, 4.0, 3.0],
];

const VIRIDIS_STOPS: &[[f64; 3]] = &[
    [68.0, 1.0, 84.0],
    [72.0, 40.0, 120.0],
    [62.0, 74.0, 137.0],
    [49.0, 104.0, 142.0],
    [38.0, 130.0, 142.0],
    [31.0, 158.0, 137.0],
    [53.0, 183.0, 121.0],
    [109.0, 205.0, 89.0],
    [180.0, 222.0, 44.0],
    [253.0, 231.0, 37.0],
];

const INFERNO_STOPS: &[[f64; 3]] = &[
    [0.0, 0.0, 4.0],
    [22.0, 11.0, 57.0],
    [66.0, 10.0, 104.0],
    [106.0, 23.0, 110.0],
    [147.0, 38.0, 103.0],
    [188.0, 55.0, 84.0],
    [221.0, 81.0, 58.0],
    [243.0, 119.0, 26.0],
    [252.0, 165.0, 10.0],
    [246.0, 215.0, 70.0],
    [252.0, 255.0, 164.0],
];

fn build_colormap_lut(stops: &[[f64; 3]]) -> [u8; 256 * 4] {
    let mut lut = [0u8; 256 * 4];
    let seg_count = stops.len() - 1;
    for i in 0..256 {
        let t = (i as f64 / 255.0) * (seg_count as f64);
        let idx = (t.floor() as usize).min(seg_count - 1);
        let frac = t - (idx as f64);
        let a = stops[idx];
        let b = stops[idx + 1];
        let base = i * 4;
        lut[base] = (a[0] + (b[0] - a[0]) * frac).round().clamp(0.0, 255.0) as u8;
        lut[base + 1] = (a[1] + (b[1] - a[1]) * frac).round().clamp(0.0, 255.0) as u8;
        lut[base + 2] = (a[2] + (b[2] - a[2]) * frac).round().clamp(0.0, 255.0) as u8;
        lut[base + 3] = 255;
    }
    lut
}

pub fn colormap_lut(id: ColormapId) -> &'static [u8; 256 * 4] {
    static TURBO: OnceLock<[u8; 256 * 4]> = OnceLock::new();
    static VIRIDIS: OnceLock<[u8; 256 * 4]> = OnceLock::new();
    static INFERNO: OnceLock<[u8; 256 * 4]> = OnceLock::new();

    match id {
        ColormapId::Turbo => TURBO.get_or_init(|| build_colormap_lut(TURBO_STOPS)),
        ColormapId::Viridis => VIRIDIS.get_or_init(|| build_colormap_lut(VIRIDIS_STOPS)),
        ColormapId::Inferno => INFERNO.get_or_init(|| build_colormap_lut(INFERNO_STOPS)),
    }
}

pub fn map_db_to_lut_index(db_fs: f32, min_dbfs: f32, max_dbfs: f32) -> usize {
    let span = max_dbfs - min_dbfs;
    if span <= 0.001 {
        return 0;
    }
    let norm = ((db_fs - min_dbfs) / span).clamp(0.0, 1.0);
    (norm * 255.0).round() as usize
}

pub fn bin_to_freq_mhz(
    bin_index: f64,
    fft_bins: usize,
    center_freq_mhz: f64,
    span_mhz: f64,
) -> f64 {
    if fft_bins == 0 {
        return center_freq_mhz;
    }
    let n = fft_bins as f64;
    center_freq_mhz + ((bin_index - n / 2.0) * span_mhz) / n
}

pub fn freq_mhz_to_bin(freq_mhz: f64, fft_bins: usize, center_freq_mhz: f64, span_mhz: f64) -> f64 {
    if span_mhz <= 0.0 || fft_bins == 0 {
        return 0.0;
    }
    let n = fft_bins as f64;
    ((freq_mhz - center_freq_mhz) / span_mhz) * n + n / 2.0
}

pub fn apply_dc_spike_notch_in_place(bins: &mut [f32]) {
    let n = bins.len();
    if n < 8 {
        return;
    }
    let center = n / 2;
    let left_val = bins[center - 2];
    let right_val = bins[center + 2];

    bins[center - 1] = left_val * 0.75 + right_val * 0.25;
    bins[center] = (left_val + right_val) * 0.5;
    bins[center + 1] = left_val * 0.25 + right_val * 0.75;
}

pub fn apply_dc_spike_notch(bins: &[f32]) -> Vec<f32> {
    let mut out = bins.to_vec();
    apply_dc_spike_notch_in_place(&mut out);
    out
}

pub fn apply_spur_blanker_in_place(bins: &mut [f32], threshold_db: f32) {
    let n = bins.len();
    if n < 6 {
        return;
    }
    // Track unmodified previous bin so neighboring replacements never cascade.
    let mut prev_orig = bins[0];
    for i in 1..(n - 1) {
        let curr = bins[i];
        let right = bins[i + 1];
        let neighbor_peak = prev_orig.max(right);
        if curr - neighbor_peak > threshold_db {
            bins[i] = (prev_orig + right) * 0.5;
        }
        prev_orig = curr;
    }
}

#[allow(dead_code)]
pub fn apply_spur_blanker(bins: &[f32], threshold_db: f32) -> Vec<f32> {
    let mut out = bins.to_vec();
    apply_spur_blanker_in_place(&mut out, threshold_db);
    out
}

pub fn compute_spectrum_stats(
    bins: &[f32],
    center_freq_mhz: f64,
    span_mhz: f64,
) -> SpectrumTraceStats {
    let n = bins.len();
    if n == 0 {
        return SpectrumTraceStats {
            noise_floor_dbfs: -120.0,
            peak_dbfs: -120.0,
            peak_bin_index: 0,
            peak_freq_mhz: center_freq_mhz,
            snr_db: 0.0,
        };
    }

    let mut peak_dbfs = f32::NEG_INFINITY;
    let mut peak_bin_index = 0usize;
    for (i, &val) in bins.iter().enumerate() {
        if val > peak_dbfs {
            peak_dbfs = val;
            peak_bin_index = i;
        }
    }

    // O(n) quickselect for the 25th-percentile noise floor estimate (instead of O(n log n) full sort)
    let mut scratch = bins.to_vec();
    let (_, nth, _) = scratch.select_nth_unstable_by(n / 4, |a, b| a.total_cmp(b));
    let noise_floor_dbfs = *nth;
    let peak_freq_mhz = bin_to_freq_mhz(peak_bin_index as f64, n, center_freq_mhz, span_mhz);

    SpectrumTraceStats {
        noise_floor_dbfs,
        peak_dbfs,
        peak_bin_index,
        peak_freq_mhz,
        snr_db: peak_dbfs - noise_floor_dbfs,
    }
}

/// Updates `slot` in place when dimensions match, avoiding per-frame Vec reallocations.
pub fn update_spectrum_traces_in_place(
    slot: &mut Option<SpectrumTraceState>,
    raw_dbfs: &[f32],
    center_freq_mhz: f64,
    span_mhz: f64,
    options: DspProcessOptions,
) {
    let fft_bins = raw_dbfs.len();
    let avg_alpha = options.avg_alpha;

    let can_reuse = matches!(slot, Some(prev) if prev.fft_bins == fft_bins);
    if !can_reuse {
        *slot = Some(update_spectrum_traces(
            raw_dbfs,
            center_freq_mhz,
            span_mhz,
            slot.as_ref(),
            options,
        ));
        return;
    }

    let state = slot.as_mut().unwrap();
    let reset_required = options.clear_peak_hold
        || (state.center_freq_mhz - center_freq_mhz).abs() > 0.01
        || (state.span_mhz - span_mhz).abs() > 0.01;

    state.live_dbfs.clear();
    state.live_dbfs.extend_from_slice(raw_dbfs);
    if options.invert_spectrum {
        state.live_dbfs.reverse();
    }
    if options.dc_notch {
        apply_dc_spike_notch_in_place(&mut state.live_dbfs);
    }
    if options.spur_blanker {
        apply_spur_blanker_in_place(&mut state.live_dbfs, options.spur_threshold_db);
    }

    if reset_required {
        state.avg_dbfs.copy_from_slice(&state.live_dbfs);
        state.peak_hold_dbfs.copy_from_slice(&state.live_dbfs);
    } else {
        let decay_step = options.peak_decay_db_per_sec.max(0.0) * options.dt_sec.clamp(0.0, 1.0);
        let one_minus_alpha = 1.0 - avg_alpha;
        for i in 0..fft_bins {
            let val = state.live_dbfs[i];
            state.avg_dbfs[i] = state.avg_dbfs[i] * one_minus_alpha + val * avg_alpha;
            state.peak_hold_dbfs[i] = (state.peak_hold_dbfs[i] - decay_step).max(val);
        }
    }

    state.center_freq_mhz = center_freq_mhz;
    state.span_mhz = span_mhz;
    state.stats = compute_spectrum_stats(&state.live_dbfs, center_freq_mhz, span_mhz);
}

pub fn update_spectrum_traces(
    raw_dbfs: &[f32],
    center_freq_mhz: f64,
    span_mhz: f64,
    prev_state: Option<&SpectrumTraceState>,
    options: DspProcessOptions,
) -> SpectrumTraceState {
    let mut processed = raw_dbfs.to_vec();
    if options.invert_spectrum {
        processed.reverse();
    }
    if options.dc_notch {
        apply_dc_spike_notch_in_place(&mut processed);
    }
    if options.spur_blanker {
        apply_spur_blanker_in_place(&mut processed, options.spur_threshold_db);
    }

    let fft_bins = processed.len();
    let avg_alpha = options.avg_alpha;
    let reset_required = match prev_state {
        None => true,
        Some(prev) => {
            options.clear_peak_hold
                || prev.fft_bins != fft_bins
                || (prev.center_freq_mhz - center_freq_mhz).abs() > 0.01
                || (prev.span_mhz - span_mhz).abs() > 0.01
        }
    };

    let (avg_dbfs, peak_hold_dbfs) = if reset_required {
        (processed.clone(), processed.clone())
    } else {
        let prev = prev_state.unwrap();
        let mut avg = Vec::with_capacity(fft_bins);
        let mut peak = Vec::with_capacity(fft_bins);
        let decay_step = options.peak_decay_db_per_sec.max(0.0) * options.dt_sec.clamp(0.0, 1.0);
        for i in 0..fft_bins {
            let val = processed[i];
            avg.push(prev.avg_dbfs[i] * (1.0 - avg_alpha) + val * avg_alpha);
            let decayed = prev.peak_hold_dbfs[i] - decay_step;
            peak.push(decayed.max(val));
        }
        (avg, peak)
    };

    let stats = compute_spectrum_stats(&processed, center_freq_mhz, span_mhz);
    SpectrumTraceState {
        center_freq_mhz,
        span_mhz,
        fft_bins,
        live_dbfs: processed,
        avg_dbfs,
        peak_hold_dbfs,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_center_dc_bins() {
        let mut bins = vec![-90.0f32; 16];
        bins[6] = -80.0;
        bins[7] = -25.0;
        bins[8] = -12.0;
        bins[9] = -30.0;
        bins[10] = -84.0;

        let cleaned = apply_dc_spike_notch(&bins);
        assert!((cleaned[8] - (-82.0)).abs() < 1e-4);
        assert!((cleaned[7] - (-81.0)).abs() < 1e-4);
        assert!((cleaned[9] - (-83.0)).abs() < 1e-4);
    }

    #[test]
    fn suppresses_isolated_spurs_without_flattening_wide_lobes() {
        let mut bins = vec![-95.0f32; 16];
        bins[3] = -52.0;
        bins[4] = -50.0;
        bins[5] = -53.0;
        bins[12] = -32.0;

        let blanked = apply_spur_blanker(&bins, 10.0);
        assert_eq!(blanked[4], -50.0);
        assert_eq!(blanked[12], -95.0);
    }

    #[test]
    fn tracks_peak_hold_ema_and_clear() {
        let mut frame1 = vec![-95.0f32; 32];
        frame1[10] = -30.0;
        let opts = DspProcessOptions {
            dc_notch: false,
            spur_blanker: false,
            ..Default::default()
        };
        let s1 = update_spectrum_traces(&frame1, 2437.0, 80.0, None, opts);
        assert_eq!(s1.peak_hold_dbfs[10], -30.0);
        assert_eq!(s1.stats.peak_dbfs, -30.0);

        let mut frame2 = vec![-95.0f32; 32];
        frame2[20] = -40.0;
        let s2 = update_spectrum_traces(&frame2, 2437.0, 80.0, Some(&s1), opts);
        assert_eq!(s2.peak_hold_dbfs[10], -30.0);
        assert_eq!(s2.peak_hold_dbfs[20], -40.0);
        assert!(s2.avg_dbfs[10] < -30.0);

        let clear_opts = DspProcessOptions {
            clear_peak_hold: true,
            ..opts
        };
        let s3 = update_spectrum_traces(&frame2, 2437.0, 80.0, Some(&s2), clear_opts);
        assert_eq!(s3.peak_hold_dbfs[10], -95.0);
    }

    #[test]
    fn decays_peak_hold_smoothly_over_time() {
        let mut frame1 = vec![-95.0f32; 32];
        frame1[10] = -30.0;
        let opts = DspProcessOptions {
            dc_notch: false,
            spur_blanker: false,
            peak_decay_db_per_sec: 10.0,
            dt_sec: 0.5,
            ..Default::default()
        };
        let s1 = update_spectrum_traces(&frame1, 2437.0, 80.0, None, opts);
        assert_eq!(s1.peak_hold_dbfs[10], -30.0);

        let frame2 = vec![-95.0f32; 32];
        let s2 = update_spectrum_traces(&frame2, 2437.0, 80.0, Some(&s1), opts);
        // 10 dB/s * 0.5 s = 5 dB decay
        assert!((s2.peak_hold_dbfs[10] - (-35.0)).abs() < 1e-4);

        // Decays down to live floor and never below it
        let fast_decay = DspProcessOptions {
            peak_decay_db_per_sec: 200.0,
            dt_sec: 1.0,
            ..opts
        };
        let s3 = update_spectrum_traces(&frame2, 2437.0, 80.0, Some(&s2), fast_decay);
        assert_eq!(s3.peak_hold_dbfs[10], -95.0);
    }

    #[test]
    fn inverts_spectrum_axis() {
        let mut frame = vec![-90.0f32; 32];
        frame[5] = -25.0;
        let normal = update_spectrum_traces(
            &frame,
            2437.0,
            80.0,
            None,
            DspProcessOptions {
                dc_notch: false,
                spur_blanker: false,
                invert_spectrum: false,
                ..Default::default()
            },
        );
        assert_eq!(normal.live_dbfs[5], -25.0);

        let inverted = update_spectrum_traces(
            &frame,
            2437.0,
            80.0,
            None,
            DspProcessOptions {
                dc_notch: false,
                spur_blanker: false,
                invert_spectrum: true,
                ..Default::default()
            },
        );
        assert_eq!(inverted.live_dbfs[26], -25.0);
        assert_eq!(inverted.live_dbfs[5], -90.0);
    }

    #[test]
    fn builds_256_entry_luts_and_clamps_dbfs() {
        assert_eq!(colormap_lut(ColormapId::Turbo).len(), 256 * 4);
        assert_eq!(colormap_lut(ColormapId::Viridis).len(), 256 * 4);
        assert_eq!(colormap_lut(ColormapId::Inferno).len(), 256 * 4);
        assert_eq!(map_db_to_lut_index(-140.0, -115.0, -15.0), 0);
        assert_eq!(map_db_to_lut_index(-15.0, -115.0, -15.0), 255);
        assert_eq!(map_db_to_lut_index(-65.0, -115.0, -15.0), 128);
    }

    #[test]
    fn bin_freq_mapping_symmetry() {
        assert_eq!(bin_to_freq_mhz(512.0, 1024, 2437.0, 80.0), 2437.0);
        assert_eq!(freq_mhz_to_bin(2437.0, 1024, 2437.0, 80.0), 512.0);
        assert_eq!(bin_to_freq_mhz(0.0, 1024, 2437.0, 80.0), 2397.0);
        assert_eq!(freq_mhz_to_bin(2397.0, 1024, 2437.0, 80.0), 0.0);
        assert_eq!(bin_to_freq_mhz(1024.0, 1024, 2437.0, 80.0), 2477.0);
        assert_eq!(freq_mhz_to_bin(2477.0, 1024, 2437.0, 80.0), 1024.0);

        let bin_f = freq_mhz_to_bin(2412.5, 1024, 2437.0, 80.0);
        assert!((bin_to_freq_mhz(bin_f, 1024, 2437.0, 80.0) - 2412.5).abs() < 1e-6);

        assert_eq!(bin_to_freq_mhz(0.0, 1024, 1890.0, 20.0), 1880.0);
        assert_eq!(bin_to_freq_mhz(512.0, 1024, 1890.0, 20.0), 1890.0);
        assert_eq!(bin_to_freq_mhz(1024.0, 1024, 1890.0, 20.0), 1900.0);
    }
}
