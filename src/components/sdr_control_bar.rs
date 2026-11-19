use leptos::prelude::*;

use crate::protocol::types::{
    SDR_BAND_PRESETS, SDR_FFT_SIZE_PRESETS, SDR_LO_DIVIDER_THRESHOLD_MHZ, SDR_MAX_FREQ_MHZ,
    SDR_MAX_MANUAL_GAIN, SDR_MIN_FREQ_MHZ, SDR_SAMPLE_RATE_PRESETS,
};

#[component]
pub fn SdrControlBar(
    connected: Signal<bool>,
    center_freq_mhz: RwSignal<u16>,
    on_center_freq_change: Callback<u16>,
    rate_bw_code: RwSignal<u8>,
    on_rate_bw_change: Callback<u8>,
    fft_log2: RwSignal<u8>,
    target_fps: RwSignal<u8>,
    max_hold_detector: RwSignal<bool>,
    sub_windows: RwSignal<u8>,
    dc_notch: RwSignal<bool>,
    spur_blanker: RwSignal<bool>,
    peak_decay_db_per_sec: RwSignal<f32>,
    on_clear_peak_hold: Callback<()>,
    sweep_enabled: RwSignal<bool>,
    on_toggle_sweep: Callback<()>,
    gain_index: RwSignal<u8>,
    on_gain_index_change: Callback<u8>,
    adc_clip: RwSignal<bool>,
    lo_div_active: RwSignal<bool>,
    capture_truncated: RwSignal<bool>,
    on_open_raw_iq: Callback<()>,
    on_open_scanner: Callback<()>,
) -> impl IntoView {
    let show_dsp = RwSignal::new(false);

    let step_freq = move |delta: i32| {
        let cur = center_freq_mhz.get_untracked() as i32;
        let next = (cur + delta).clamp(SDR_MIN_FREQ_MHZ as i32, SDR_MAX_FREQ_MHZ as i32) as u16;
        on_center_freq_change.run(next);
    };

    let is_sub2210 =
        move || lo_div_active.get() || center_freq_mhz.get() < SDR_LO_DIVIDER_THRESHOLD_MHZ;

    let preset_label = move || {
        let f = center_freq_mhz.get();
        if let Some(p) = SDR_BAND_PRESETS
            .iter()
            .find(|p| (p.freq_mhz as i32 - f as i32).abs() < 1)
        {
            p.label
        } else if is_sub2210() {
            "Sub-2.2 GHz"
        } else {
            "2.4 GHz"
        }
    };

    view! {
        <section class="sdr-control-bar" aria-label="RF Tuner and DSP Controls">
            <div class="sdr-primary-row">
                <div class="control-group">
                    <label for="sdr-span">"Span"</label>
                    <select
                        id="sdr-span"
                        prop:value=move || rate_bw_code.get().to_string()
                        on:change=move |ev| {
                            if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                on_rate_bw_change.run(v);
                            }
                        }
                        disabled=move || !connected.get()
                        title="RF Capture Bandwidth & Sampling Rate"
                    >
                        {SDR_SAMPLE_RATE_PRESETS
                            .iter()
                            .map(|p| {
                                view! {
                                    <option value=p.code.to_string()>
                                        {format!("{} MHz", p.span_mhz as u32)}
                                    </option>
                                }
                            })
                            .collect_view()}
                    </select>
                </div>

                <div class="bar-divider" />

                <div class="gain-cluster">
                    <label for="sdr-gain" class="gain-label">"Gain"</label>
                    <input
                        id="sdr-gain"
                        type="range"
                        aria-label="Manual Gain Slider"
                        class="gain-slider"
                        min="0"
                        max=SDR_MAX_MANUAL_GAIN.to_string()
                        step="1"
                        prop:value=move || gain_index.get().min(SDR_MAX_MANUAL_GAIN).to_string()
                        disabled=move || !connected.get()
                        on:input=move |ev| {
                            if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                on_gain_index_change.run(v);
                            }
                        }
                        title=move || format!("Manual Gain: {}", gain_index.get())
                    />
                    <span class="hw-gain-badge">{move || gain_index.get()}</span>
                    <div class="alert-slot" aria-live="polite">
                        <Show when=move || adc_clip.get()>
                            <span
                                class="clip-alert-badge"
                                title="ADC Clipping! Lower manual gain."
                            >
                                "CLIP"
                            </span>
                        </Show>
                        <Show when=move || capture_truncated.get()>
                            <span class="trunc-alert-badge" title="Capture truncated">
                                "TRUNC"
                            </span>
                        </Show>
                    </div>
                </div>

                <div class="control-spacer" />

                <div class="action-cluster">
                    <button
                        type="button"
                        class=move || {
                            if show_dsp.get() {
                                "btn btn-secondary btn-compact active"
                            } else {
                                "btn btn-secondary btn-compact"
                            }
                        }
                        on:click=move |_| show_dsp.update(|v| *v = !*v)
                        title="Toggle advanced DSP, FFT resolution and detector settings"
                    >
                        <span>"DSP"</span>
                        <span class="expand-indicator">
                            {move || if show_dsp.get() { "▲" } else { "▼" }}
                        </span>
                    </button>

                    <button
                        type="button"
                        class="btn btn-primary btn-compact"
                        on:click=move |_| on_open_scanner.run(())
                        disabled=move || !connected.get()
                        title="Open 1.84–2.79 GHz Wideband RF Scanner"
                    >
                        "Scanner"
                    </button>

                    <button
                        type="button"
                        class="btn btn-secondary btn-compact"
                        on:click=move |_| on_open_raw_iq.run(())
                        disabled=move || !connected.get()
                        title="Capture raw time-domain I/Q snapshot & inspect constellation"
                    >
                        "Raw I/Q"
                    </button>
                </div>
            </div>

            <div class="sdr-fullwidth-tuner" aria-label="Full-Width Frequency Tuner">
                <div class="tuner-track-info">
                    <div class="tuner-track-left">
                        <span class="track-freq-badge">
                            <span class="track-freq-val">{move || center_freq_mhz.get()}</span>
                            <span class="track-freq-unit">"MHz"</span>
                        </span>
                        <span class=move || {
                            if is_sub2210() {
                                "track-mode-badge lo-active"
                            } else {
                                "track-mode-badge lo-direct"
                            }
                        }>
                            {move || if is_sub2210() { "⚡ 5/6 LO" } else { "Direct RF" }}
                        </span>
                        <span class="track-preset-name">{preset_label}</span>
                    </div>

                    <div class="tuner-quick-bands" aria-label="Quick Band Jumps">
                        <button
                            type="button"
                            class="band-pill"
                            on:click=move |_| on_center_freq_change.run(1890)
                            disabled=move || !connected.get()
                            title="Jump to DECT EU (1890 MHz)"
                        >
                            "DECT"
                        </button>
                        <button
                            type="button"
                            class="band-pill"
                            on:click=move |_| on_center_freq_change.run(2350)
                            disabled=move || !connected.get()
                            title="Jump to 13cm Ham (2350 MHz)"
                        >
                            "13cm"
                        </button>
                        <button
                            type="button"
                            class="band-pill"
                            on:click=move |_| on_center_freq_change.run(2437)
                            disabled=move || !connected.get()
                            title="Jump to Wi-Fi Ch 6 (2437 MHz)"
                        >
                            "Wi-Fi"
                        </button>
                        <button
                            type="button"
                            class="band-pill"
                            on:click=move |_| on_center_freq_change.run(2655)
                            disabled=move || !connected.get()
                            title="Jump to LTE Band 7 (2655 MHz)"
                        >
                            "LTE B7"
                        </button>
                    </div>
                </div>

                <div class="tuner-slider-row">
                    <button
                        type="button"
                        class="btn-step"
                        on:click=move |ev: web_sys::MouseEvent| {
                            step_freq(if ev.shift_key() { -10 } else { -1 });
                        }
                        disabled=move || !connected.get() || center_freq_mhz.get() <= SDR_MIN_FREQ_MHZ
                        title="Step -1 MHz (Shift: -10 MHz)"
                        aria-label="Step frequency down"
                    >
                        "−"
                    </button>

                    <div class="tuner-slider-wrap">
                        <input
                            type="range"
                            class="fullwidth-tuner-slider"
                            aria-label="Full-width Frequency Tuner Slider"
                            min=SDR_MIN_FREQ_MHZ.to_string()
                            max=SDR_MAX_FREQ_MHZ.to_string()
                            step="1"
                            prop:value=move || center_freq_mhz.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u16>() {
                                    on_center_freq_change.run(v);
                                }
                            }
                            disabled=move || !connected.get()
                            title=move || {
                                format!(
                                    "{} MHz ({})",
                                    center_freq_mhz.get(),
                                    if is_sub2210() {
                                        "5/6 LO Divider"
                                    } else {
                                        "Direct Synthesizer"
                                    }
                                )
                            }
                        />
                        <div class="tuner-band-ticks" aria-hidden="true">
                            <span class="band-tick" style="left: 5.1%">"DECT"</span>
                            <span class="band-tick band-tick-lo" style="left: 38.8%">"┆ 2210 LO"</span>
                            <span class="band-tick" style="left: 53.6%">"Ham 13cm"</span>
                            <span class="band-tick" style="left: 62.8%">"Wi-Fi / BLE"</span>
                            <span class="band-tick" style="left: 85.8%">"LTE B7"</span>
                        </div>
                    </div>

                    <button
                        type="button"
                        class="btn-step"
                        on:click=move |ev: web_sys::MouseEvent| {
                            step_freq(if ev.shift_key() { 10 } else { 1 });
                        }
                        disabled=move || !connected.get() || (center_freq_mhz.get() >= SDR_MAX_FREQ_MHZ)
                        title="Step +1 MHz (Shift: +10 MHz)"
                        aria-label="Step frequency up"
                    >
                        "+"
                    </button>
                </div>
            </div>

            <Show when=move || show_dsp.get()>
                <div class="sdr-secondary-row" role="region" aria-label="Advanced DSP Settings">
                    <div class="control-group">
                        <label for="sdr-fft">"FFT"</label>
                        <select
                            id="sdr-fft"
                            prop:value=move || fft_log2.get().to_string()
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                    fft_log2.set(v);
                                }
                            }
                            disabled=move || !connected.get()
                        >
                            {SDR_FFT_SIZE_PRESETS
                                .iter()
                                .map(|p| {
                                    view! {
                                        <option value=p.log2.to_string()>{p.label}</option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </div>

                    <div class="control-group">
                        <label for="sdr-fps">"Rate"</label>
                        <select
                            id="sdr-fps"
                            prop:value=move || target_fps.get().to_string()
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                    target_fps.set(v);
                                }
                            }
                            disabled=move || !connected.get()
                        >
                            <option value="10">"10 FPS"</option>
                            <option value="20">"20 FPS"</option>
                            <option value="30">"30 FPS"</option>
                            <option value="60">"60 FPS"</option>
                        </select>
                    </div>

                    <div class="control-group">
                        <label>"Detector"</label>
                        <div class="segmented-mini">
                            <button
                                type="button"
                                class=move || if !max_hold_detector.get() { "active" } else { "" }
                                on:click=move |_| max_hold_detector.set(false)
                                disabled=move || !connected.get()
                            >
                                "Mean"
                            </button>
                            <button
                                type="button"
                                class=move || if max_hold_detector.get() { "active" } else { "" }
                                on:click=move |_| max_hold_detector.set(true)
                                disabled=move || !connected.get()
                            >
                                "Peak"
                            </button>
                        </div>
                        <select
                            aria-label="DSP Sub-windows"
                            prop:value=move || sub_windows.get().to_string()
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                    sub_windows.set(v);
                                }
                            }
                            disabled=move || !connected.get()
                            title="Sub-windows accumulated per frame"
                        >
                            <option value="1">"1x"</option>
                            <option value="4">"4x"</option>
                            <option value="8">"8x"</option>
                        </select>
                    </div>

                    <div class="control-group">
                        <label for="sdr-peak-decay">"Peak Decay"</label>
                        <select
                            id="sdr-peak-decay"
                            prop:value=move || (peak_decay_db_per_sec.get() as i32).to_string()
                            on:change=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<f32>() {
                                    peak_decay_db_per_sec.set(v);
                                }
                            }
                            title="Peak-hold envelope decay speed (dB/s)"
                        >
                            <option value="0">"Hold (∞)"</option>
                            <option value="2">"2 dB/s"</option>
                            <option value="5">"5 dB/s"</option>
                            <option value="10">"10 dB/s"</option>
                            <option value="20">"20 dB/s"</option>
                        </select>
                    </div>

                    <div class="dsp-toggles">
                        <button
                            type="button"
                            class=move || {
                                if dc_notch.get() { "toggle-chip active" } else { "toggle-chip" }
                            }
                            on:click=move |_| dc_notch.update(|v| *v = !*v)
                            title="Cancel LO leakage at DC center bin"
                        >
                            "DC Notch"
                        </button>
                        <button
                            type="button"
                            class=move || {
                                if spur_blanker.get() { "toggle-chip active" } else { "toggle-chip" }
                            }
                            on:click=move |_| spur_blanker.update(|v| *v = !*v)
                            title="Suppress single-bin clock spurs"
                        >
                            "Spur Blanker"
                        </button>
                        <button
                            type="button"
                            class=move || {
                                if sweep_enabled.get() {
                                    "toggle-chip sweep-active"
                                } else {
                                    "toggle-chip"
                                }
                            }
                            on:click=move |_| on_toggle_sweep.run(())
                            disabled=move || !connected.get()
                            title="Automated 40 MHz multi-band sweep"
                        >
                            {move || if sweep_enabled.get() { "Sweep ON" } else { "Sweep" }}
                        </button>
                        <button
                            type="button"
                            class="toggle-chip"
                            on:click=move |_| on_clear_peak_hold.run(())
                            title="Reset peak-hold envelope"
                        >
                            "Reset Peak"
                        </button>
                    </div>
                </div>
            </Show>
        </section>
    }
}
