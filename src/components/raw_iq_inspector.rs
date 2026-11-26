use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::protocol::types::SdrRawIqFrame;

#[component]
pub fn RawIqInspector(
    open: RwSignal<bool>,
    on_close: Callback<()>,
    frame: RwSignal<Option<SdrRawIqFrame>>,
    iq_kb: RwSignal<u8>,
    max_iq_kb: RwSignal<u8>,
    streaming_cont_iq: RwSignal<bool>,
    on_request_single_shot: Callback<()>,
    on_toggle_cont_iq: Callback<()>,
) -> impl IntoView {
    let time_canvas_ref = NodeRef::<html::Canvas>::new();
    let const_canvas_ref = NodeRef::<html::Canvas>::new();
    let view_window = RwSignal::new(512usize);

    Effect::new(move |_| {
        if !open.get() {
            return;
        }
        let cur_frame = frame.get();
        let vw = view_window.get();
        let dpr = hotwire_core::web::capped_device_pixel_ratio();

        // 1. Time-Domain Canvas
        if let Some(t_canvas) = time_canvas_ref.get() {
            let rect = t_canvas.get_bounding_client_rect();
            let w = rect.width().floor().max(120.0);
            let h = rect.height().floor().max(120.0);
            let pw = (w * dpr).floor() as u32;
            let ph = (h * dpr).floor() as u32;
            if t_canvas.width() != pw || t_canvas.height() != ph {
                t_canvas.set_width(pw);
                t_canvas.set_height(ph);
            }

            if let Ok(Some(ctx_obj)) = t_canvas.get_context("2d") {
                if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
                    ctx.save();
                    let _ = ctx.scale(dpr, dpr);
                    ctx.set_fill_style_str("#020617");
                    ctx.fill_rect(0.0, 0.0, w, h);

                    ctx.set_stroke_style_str("rgba(51, 65, 85, 0.55)");
                    ctx.set_line_width(1.0);
                    ctx.begin_path();
                    ctx.move_to(0.0, h / 2.0);
                    ctx.line_to(w, h / 2.0);
                    ctx.stroke();

                    if let Some(ref f) = cur_frame {
                        let count = f.sample_count.min(vw);
                        let mid_y = h / 2.0;
                        let amp_scale = (h * 0.44) / 128.0;
                        let denom = (count.saturating_sub(1)).max(1) as f64;

                        // Envelope
                        ctx.begin_path();
                        for i in 0..count {
                            let x = (i as f64 / denom) * w;
                            let mag = (f.i_samples[i] as f64).hypot(f.q_samples[i] as f64);
                            let y = mid_y - mag * amp_scale;
                            if i == 0 {
                                ctx.move_to(x, y);
                            } else {
                                ctx.line_to(x, y);
                            }
                        }
                        ctx.set_stroke_style_str("rgba(251, 191, 36, 0.45)");
                        ctx.set_line_width(1.0);
                        ctx.stroke();

                        // I(t)
                        ctx.begin_path();
                        for (i, &sample) in f.i_samples.iter().enumerate().take(count) {
                            let x = (i as f64 / denom) * w;
                            let y = mid_y - (sample as f64) * amp_scale;
                            if i == 0 {
                                ctx.move_to(x, y);
                            } else {
                                ctx.line_to(x, y);
                            }
                        }
                        ctx.set_stroke_style_str("#38bdf8");
                        ctx.set_line_width(1.4);
                        ctx.stroke();

                        // Q(t)
                        ctx.begin_path();
                        for (i, &sample) in f.q_samples.iter().enumerate().take(count) {
                            let x = (i as f64 / denom) * w;
                            let y = mid_y - (sample as f64) * amp_scale;
                            if i == 0 {
                                ctx.move_to(x, y);
                            } else {
                                ctx.line_to(x, y);
                            }
                        }
                        ctx.set_stroke_style_str("#f472b6");
                        ctx.set_line_width(1.4);
                        ctx.stroke();
                    }
                    ctx.restore();
                }
            }
        }

        // 2. Constellation Scatter Plot
        if let Some(c_canvas) = const_canvas_ref.get() {
            let rect = c_canvas.get_bounding_client_rect();
            let w = rect.width().floor().max(120.0);
            let h = rect.height().floor().max(120.0);
            let pw = (w * dpr).floor() as u32;
            let ph = (h * dpr).floor() as u32;
            if c_canvas.width() != pw || c_canvas.height() != ph {
                c_canvas.set_width(pw);
                c_canvas.set_height(ph);
            }

            if let Ok(Some(ctx_obj)) = c_canvas.get_context("2d") {
                if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
                    ctx.save();
                    let _ = ctx.scale(dpr, dpr);
                    ctx.set_fill_style_str("#020617");
                    ctx.fill_rect(0.0, 0.0, w, h);

                    let cx = w / 2.0;
                    let cy = h / 2.0;
                    let radius = w.min(h) * 0.44;

                    ctx.set_stroke_style_str("rgba(51, 65, 85, 0.65)");
                    ctx.set_line_width(1.0);
                    ctx.begin_path();
                    ctx.move_to(0.0, cy);
                    ctx.line_to(w, cy);
                    ctx.move_to(cx, 0.0);
                    ctx.line_to(cx, h);
                    ctx.stroke();

                    for frac in [0.5, 1.0] {
                        ctx.begin_path();
                        let _ = ctx.arc(cx, cy, radius * frac, 0.0, std::f64::consts::TAU);
                        ctx.stroke();
                    }

                    if let Some(ref f) = cur_frame {
                        let step = (f.sample_count / 1600).max(1);
                        // Pass 1: Normal points (single fillStyle change)
                        ctx.set_fill_style_str("rgba(52, 211, 153, 0.65)");
                        let mut i = 0;
                        let mut any_clipped = false;
                        while i < f.sample_count {
                            let iv = f.i_samples[i] as f64;
                            let qv = f.q_samples[i] as f64;
                            if iv.abs() >= 126.0 || qv.abs() >= 126.0 {
                                any_clipped = true;
                            } else {
                                let x = cx + (iv / 128.0) * radius;
                                let y = cy - (qv / 128.0) * radius;
                                ctx.fill_rect(x - 1.0, y - 1.0, 2.5, 2.5);
                            }
                            i += step;
                        }
                        // Pass 2: Clipped points only if any occurred
                        if any_clipped {
                            ctx.set_fill_style_str("rgba(248, 113, 113, 0.85)");
                            i = 0;
                            while i < f.sample_count {
                                let iv = f.i_samples[i] as f64;
                                let qv = f.q_samples[i] as f64;
                                if iv.abs() >= 126.0 || qv.abs() >= 126.0 {
                                    let x = cx + (iv / 128.0) * radius;
                                    let y = cy - (qv / 128.0) * radius;
                                    ctx.fill_rect(x - 1.0, y - 1.0, 2.5, 2.5);
                                }
                                i += step;
                            }
                        }
                    }
                    ctx.restore();
                }
            }
        }
    });

    let metrics_view = move || {
        frame.get().map(|f| {
            let mut dc_i = 0.0f64;
            let mut dc_q = 0.0f64;
            let mut sum_sq = 0.0f64;
            if f.sample_count > 0 {
                for i in 0..f.sample_count {
                    let iv = f.i_samples[i] as f64;
                    let qv = f.q_samples[i] as f64;
                    dc_i += iv;
                    dc_q += qv;
                    sum_sq += iv * iv + qv * qv;
                }
                let n = f.sample_count as f64;
                dc_i /= n;
                dc_q /= n;
                sum_sq = (sum_sq / n).sqrt();
            }
            view! {
                <div class="iq-metrics">
                    <span>{format!("{} MHz", f.center_freq_mhz)}</span>
                    <span>{format!("Gain {}", f.active_gain_index)}</span>
                    <span>{format!("RMS {:.1}", sum_sq)}</span>
                    <span>{format!("DC ({:.1}, {:.1})", dc_i, dc_q)}</span>
                    {f.adc_clip.then(|| view! { <span class="clip-alert-badge">"CLIP"</span> })}
                </div>
            }
        })
    };

    view! {
        <Show when=move || open.get()>
            <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Raw I/Q Inspector">
                <div class="iq-modal">
                    <div class="iq-modal-header">
                        <div>
                            <h3>"Raw Baseband I/Q Inspector (0x85)"</h3>
                            <p class="iq-subtitle">
                                "Inspect unwrapped 8-bit signed I/Q streams, constellation rings, and ADC clipping rails"
                            </p>
                        </div>
                        <button
                            type="button"
                            class="btn btn-secondary btn-compact"
                            on:click=move |_| on_close.run(())
                        >
                            "Close"
                        </button>
                    </div>

                    <div class="iq-controls">
                        <div class="control-group">
                            <label for="iq-depth">"Samples"</label>
                            <select
                                id="iq-depth"
                                prop:value=move || iq_kb.get().to_string()
                                on:change=move |ev| {
                                    if let Ok(v) = event_target_value(&ev).parse::<u8>() {
                                        iq_kb.set(v);
                                    }
                                }
                            >
                                {move || {
                                    let max = max_iq_kb.get();
                                    [(1u8, "1,024"), (2, "2,048"), (4, "4,096"), (8, "8,192")]
                                        .into_iter()
                                        .filter(|(kb, _)| *kb <= max)
                                        .map(|(kb, label)| {
                                            view! { <option value=kb.to_string()>{label}</option> }
                                        })
                                        .collect_view()
                                }}
                            </select>
                        </div>

                        <div class="control-group">
                            <label for="iq-window">"Time Window"</label>
                            <select
                                id="iq-window"
                                prop:value=move || view_window.get().to_string()
                                on:change=move |ev| {
                                    if let Ok(v) = event_target_value(&ev).parse::<usize>() {
                                        view_window.set(v);
                                    }
                                }
                            >
                                <option value="128">"128 samples"</option>
                                <option value="256">"256 samples"</option>
                                <option value="512">"512 samples"</option>
                                <option value="1024">"1,024 samples"</option>
                            </select>
                        </div>

                        <button
                            type="button"
                            class="btn btn-primary btn-compact"
                            on:click=move |_| on_request_single_shot.run(())
                        >
                            "Capture Snapshot"
                        </button>
                        <button
                            type="button"
                            class=move || {
                                if streaming_cont_iq.get() {
                                    "btn btn-compact btn-danger"
                                } else {
                                    "btn btn-compact btn-accent"
                                }
                            }
                            on:click=move |_| on_toggle_cont_iq.run(())
                        >
                            {move || {
                                if streaming_cont_iq.get() {
                                    "Stop Cont I/Q"
                                } else {
                                    "Stream Cont I/Q"
                                }
                            }}
                        </button>

                        {metrics_view}
                    </div>

                    <div class="iq-canvas-grid">
                        <div class="iq-card">
                            <div class="iq-card-head">
                                <span>"Time Domain: I(t) / Q(t) / Envelope"</span>
                                <span class="iq-legend">
                                    <i style="color: #38bdf8">"■ I"</i>
                                    " "
                                    <i style="color: #f472b6">"■ Q"</i>
                                    " "
                                    <i style="color: #fbbf24">"■ |z|"</i>
                                </span>
                            </div>
                            <canvas node_ref=time_canvas_ref class="iq-canvas" />
                        </div>

                        <div class="iq-card">
                            <div class="iq-card-head">
                                <span>"2D I/Q Constellation"</span>
                                <span class="iq-legend">
                                    <i style="color: #34d399">"● Normal"</i>
                                    " "
                                    <i style="color: #f87171">"● Clipped"</i>
                                </span>
                            </div>
                            <canvas node_ref=const_canvas_ref class="iq-canvas" />
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    }
}
