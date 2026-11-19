use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

use crate::dsp::sdr_dsp::{apply_dc_spike_notch, bin_to_freq_mhz};
use crate::protocol::types::{SdrSpectrumFrame, SDR_MAX_FREQ_MHZ, SDR_MIN_FREQ_MHZ};

const TOTAL_SPAN_MHZ: f64 = (SDR_MAX_FREQ_MHZ - SDR_MIN_FREQ_MHZ) as f64;
const BUCKET_RES_MHZ: f64 = 0.5;
const BUCKET_COUNT: usize = 1896;
const STEP_SPAN_MHZ: u16 = 40;

const PAD_LEFT: f64 = 48.0;
const PAD_RIGHT: f64 = 14.0;
const PAD_TOP: f64 = 20.0;
const PAD_BOTTOM: f64 = 24.0;

struct ScannerBand {
    label: &'static str,
    start_mhz: f64,
    end_mhz: f64,
    color: &'static str,
}

const SCANNER_BANDS: &[ScannerBand] = &[
    ScannerBand { label: "DECT EU", start_mhz: 1880.0, end_mhz: 1900.0, color: "rgba(244, 114, 182, 0.16)" },
    ScannerBand { label: "5/6 LO", start_mhz: 1842.0, end_mhz: 2210.0, color: "rgba(245, 158, 11, 0.05)" },
    ScannerBand { label: "13cm Ham", start_mhz: 2320.0, end_mhz: 2400.0, color: "rgba(34, 197, 94, 0.14)" },
    ScannerBand { label: "Wi-Fi / BLE", start_mhz: 2400.0, end_mhz: 2484.0, color: "rgba(56, 189, 248, 0.16)" },
    ScannerBand { label: "LTE B7 DL", start_mhz: 2620.0, end_mhz: 2690.0, color: "rgba(251, 146, 60, 0.16)" },
];

fn build_scan_steps() -> Vec<u16> {
    let mut steps = Vec::new();
    let half = STEP_SPAN_MHZ / 2;
    let last_target = SDR_MAX_FREQ_MHZ - half;
    let mut f = SDR_MIN_FREQ_MHZ + half;
    while f < SDR_MAX_FREQ_MHZ {
        steps.push(f.min(last_target));
        f += STEP_SPAN_MHZ;
    }
    if steps.last().copied().unwrap_or(0) < last_target {
        steps.push(last_target);
    }
    steps
}

fn perf_now() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0)
}

#[derive(Debug, Clone, Copy)]
struct ScannerHover {
    x: f64,
    freq_mhz: f64,
    db_fs: Option<f32>,
}

#[component]
pub fn WidebandScannerModal(
    open: RwSignal<bool>,
    on_close: Callback<()>,
    connected: Signal<bool>,
    latest_frame: RwSignal<Option<SdrSpectrumFrame>>,
    frame_version: RwSignal<u64>,
    invert_spectrum: Signal<bool>,
    on_request_scan_step: Callback<u16>,
    on_tune_and_inspect: Callback<u16>,
) -> impl IntoView {
    let scan_steps = StoredValue::new(build_scan_steps());
    let canvas_ref = NodeRef::<html::Canvas>::new();
    let live_buckets = StoredValue::new(vec![f32::NAN; BUCKET_COUNT]);
    let peak_buckets = StoredValue::new(vec![f32::NAN; BUCKET_COUNT]);

    let scanning = RwSignal::new(false);
    let scan_step_idx = RwSignal::new(0usize);
    let pass_count = RwSignal::new(0u32);
    let hover_info = RwSignal::new(None::<ScannerHover>);
    let redraw_rev = RwSignal::new(0u64);

    let awaiting_center = StoredValue::new(None::<u16>);
    let last_advance_ts = StoredValue::new(0.0f64);
    let timer_id = StoredValue::new(None::<i32>);
    let timer_cb = StoredValue::new_local(None::<Closure<dyn FnMut()>>);

    let clear_scan_data = move |_| {
        live_buckets.update_value(|v| v.fill(f32::NAN));
        peak_buckets.update_value(|v| v.fill(f32::NAN));
        pass_count.set(0);
        redraw_rev.update(|v| *v += 1);
    };

    // Auto-start scan when modal opens
    Effect::new(move |_| {
        let is_open = open.get();
        let is_conn = connected.get();
        if is_open && is_conn {
            scan_step_idx.set(0);
            scanning.set(true);
            let first = scan_steps.with_value(|s| s[0]);
            awaiting_center.set_value(Some(first));
            last_advance_ts.set_value(perf_now());
            on_request_scan_step.run(first);
        } else if !is_open {
            scanning.set(false);
            awaiting_center.set_value(None);
        }
    });

    // Watchdog timer
    Effect::new(move |_| {
        let active = open.get() && scanning.get() && connected.get();
        if let Some(id) = timer_id.get_value() {
            if let Some(w) = web_sys::window() {
                w.clear_interval_with_handle(id);
            }
            timer_id.set_value(None);
        }
        timer_cb.set_value(None);

        if active {
            let cb = Closure::<dyn FnMut()>::new(move || {
                let now = perf_now();
                if now - last_advance_ts.get_value() > 450.0 {
                    let (next_idx, next_freq) = scan_steps.with_value(|steps| {
                        let ni = (scan_step_idx.get_untracked() + 1) % steps.len();
                        (ni, steps[ni])
                    });
                    if next_idx == 0 {
                        pass_count.update(|p| *p += 1);
                    }
                    scan_step_idx.set(next_idx);
                    awaiting_center.set_value(Some(next_freq));
                    last_advance_ts.set_value(now);
                    on_request_scan_step.run(next_freq);
                }
            });
            if let Some(w) = web_sys::window() {
                if let Ok(id) = w.set_interval_with_callback_and_timeout_and_arguments_0(
                    cb.as_ref().unchecked_ref(),
                    150,
                ) {
                    timer_id.set_value(Some(id));
                    timer_cb.set_value(Some(cb));
                }
            }
        }
    });

    // Stitch incoming 40 MHz frames
    Effect::new(move |_| {
        let ver = frame_version.get();
        if ver == 0 || !open.get_untracked() || !scanning.get_untracked() {
            return;
        }
        let Some(frame) = latest_frame.get_untracked() else {
            return;
        };
        let Some(expected) = awaiting_center.get_value() else {
            return;
        };
        if (frame.center_freq_mhz as f64 - expected as f64).abs() > 1.5 {
            return;
        }

        let mut bins = frame.power_dbfs.clone();
        if invert_spectrum.get_untracked() {
            bins.reverse();
        }
        bins = apply_dc_spike_notch(&bins);

        let n = bins.len();
        let mut step_seen = vec![f32::NEG_INFINITY; BUCKET_COUNT];
        for (i, &val) in bins.iter().enumerate() {
            let freq = bin_to_freq_mhz(
                i as f64,
                n,
                frame.center_freq_mhz as f64,
                frame.span_mhz,
            );
            if freq < SDR_MIN_FREQ_MHZ as f64 || freq > SDR_MAX_FREQ_MHZ as f64 {
                continue;
            }
            let b = (((freq - SDR_MIN_FREQ_MHZ as f64) / BUCKET_RES_MHZ).floor() as isize)
                .clamp(0, (BUCKET_COUNT - 1) as isize) as usize;
            if val > step_seen[b] {
                step_seen[b] = val;
            }
        }

        live_buckets.update_value(|live| {
            peak_buckets.update_value(|peak| {
                for b in 0..BUCKET_COUNT {
                    let val = step_seen[b];
                    if val > f32::NEG_INFINITY {
                        live[b] = val;
                        peak[b] = if peak[b].is_nan() {
                            val
                        } else {
                            peak[b].max(val)
                        };
                    }
                }
            });
        });

        let (next_idx, next_freq) = scan_steps.with_value(|steps| {
            let ni = (scan_step_idx.get_untracked() + 1) % steps.len();
            (ni, steps[ni])
        });
        if next_idx == 0 {
            pass_count.update(|p| *p += 1);
        }
        scan_step_idx.set(next_idx);
        awaiting_center.set_value(Some(next_freq));
        last_advance_ts.set_value(perf_now());
        on_request_scan_step.run(next_freq);
    });

    // Draw wideband scanner canvas
    Effect::new(move |_| {
        let _ver = frame_version.get();
        let _rev = redraw_rev.get();
        let is_open = open.get();
        let is_scanning = scanning.get();
        let step_i = scan_step_idx.get();
        let cur_hover = hover_info.get();

        if !is_open {
            return;
        }
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let dpr = web_sys::window()
            .map(|w| w.device_pixel_ratio())
            .unwrap_or(1.0);
        let w = rect.width().floor().max(200.0);
        let h = rect.height().floor().max(160.0);
        let pw = (w * dpr).floor() as u32;
        let ph = (h * dpr).floor() as u32;
        if canvas.width() != pw || canvas.height() != ph {
            canvas.set_width(pw);
            canvas.set_height(ph);
        }

        let Ok(Some(ctx_obj)) = canvas.get_context("2d") else {
            return;
        };
        let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() else {
            return;
        };

        ctx.save();
        let _ = ctx.scale(dpr, dpr);
        ctx.set_fill_style_str("#020617");
        ctx.fill_rect(0.0, 0.0, w, h);

        let plot_w = (w - PAD_LEFT - PAD_RIGHT).max(10.0);
        let plot_h = (h - PAD_TOP - PAD_BOTTOM).max(10.0);
        let min_db = -115.0f64;
        let max_db = -15.0f64;
        let freq_to_x =
            |f: f64| PAD_LEFT + ((f - SDR_MIN_FREQ_MHZ as f64) / TOTAL_SPAN_MHZ) * plot_w;
        let db_to_y = |db: f64| {
            let norm = ((db - min_db) / (max_db - min_db)).clamp(0.0, 1.0);
            PAD_TOP + (1.0 - norm) * plot_h
        };

        ctx.set_font("10px ui-monospace, SFMono-Regular, Menlo, monospace");
        ctx.set_text_align("left");
        for band in SCANNER_BANDS {
            let x0 = freq_to_x(band.start_mhz).max(PAD_LEFT);
            let x1 = freq_to_x(band.end_mhz).min(PAD_LEFT + plot_w);
            if x1 <= x0 {
                continue;
            }
            ctx.set_fill_style_str(band.color);
            ctx.fill_rect(x0, PAD_TOP, x1 - x0, plot_h);
            ctx.set_fill_style_str("rgba(226, 232, 240, 0.72)");
            let _ = ctx.fill_text(band.label, x0 + 4.0, PAD_TOP + 12.0);
        }

        ctx.set_line_width(1.0);
        let mut db = -100;
        while db <= -20 {
            let y = db_to_y(db as f64).round() + 0.5;
            ctx.set_stroke_style_str("rgba(51, 65, 85, 0.55)");
            ctx.begin_path();
            ctx.move_to(PAD_LEFT, y);
            ctx.line_to(PAD_LEFT + plot_w, y);
            ctx.stroke();

            ctx.set_fill_style_str("#94a3b8");
            ctx.set_text_align("right");
            let _ = ctx.fill_text(&db.to_string(), PAD_LEFT - 6.0, y + 3.0);
            db += 20;
        }

        ctx.set_text_align("center");
        let mut f = 1900;
        while f <= 2700 {
            let x = freq_to_x(f as f64).round() + 0.5;
            ctx.set_stroke_style_str(if f == 2200 {
                "rgba(245, 158, 11, 0.3)"
            } else {
                "rgba(51, 65, 85, 0.45)"
            });
            ctx.begin_path();
            ctx.move_to(x, PAD_TOP);
            ctx.line_to(x, PAD_TOP + plot_h);
            ctx.stroke();

            ctx.set_fill_style_str("#94a3b8");
            let _ = ctx.fill_text(&f.to_string(), x, PAD_TOP + plot_h + 15.0);
            f += 100;
        }

        let draw_buckets =
            |arr: &[f32], stroke: &str, lw: f64, fill_grad: bool, dashed: bool| {
                ctx.save();
                ctx.begin_path();
                let mut started = false;
                let mut first_x = PAD_LEFT;
                let mut last_x = PAD_LEFT;

                for (b, &val) in arr.iter().enumerate() {
                    if val.is_nan() {
                        started = false;
                        continue;
                    }
                    let freq = SDR_MIN_FREQ_MHZ as f64 + (b as f64 + 0.5) * BUCKET_RES_MHZ;
                    let x = freq_to_x(freq);
                    let y = db_to_y(val as f64);
                    if !started {
                        ctx.move_to(x, y);
                        first_x = x;
                        started = true;
                    } else {
                        ctx.line_to(x, y);
                    }
                    last_x = x;
                }

                if dashed {
                    let dash = js_sys::Array::new();
                    dash.push(&4.0.into());
                    dash.push(&3.0.into());
                    let _ = ctx.set_line_dash(&dash);
                }
                ctx.set_stroke_style_str(stroke);
                ctx.set_line_width(lw);
                ctx.stroke();

                if fill_grad && last_x > first_x {
                    let _ = ctx.set_line_dash(&js_sys::Array::new());
                    ctx.line_to(last_x, PAD_TOP + plot_h);
                    ctx.line_to(first_x, PAD_TOP + plot_h);
                    ctx.close_path();
                    let grad = ctx.create_linear_gradient(0.0, PAD_TOP, 0.0, PAD_TOP + plot_h);
                    let _ = grad.add_color_stop(0.0, "rgba(52, 211, 153, 0.25)");
                    let _ = grad.add_color_stop(1.0, "rgba(52, 211, 153, 0.01)");
                    ctx.set_fill_style_canvas_gradient(&grad);
                    ctx.fill();
                }
                ctx.restore();
            };

        peak_buckets.with_value(|pk| {
            draw_buckets(pk, "rgba(251, 191, 36, 0.78)", 1.2, false, true);
        });
        live_buckets.with_value(|lv| {
            draw_buckets(lv, "#34d399", 1.5, true, false);
        });

        let active_center = scan_steps.with_value(|s| {
            s.get(step_i).copied().unwrap_or(SDR_MIN_FREQ_MHZ) as f64
        });
        let win_x0 = freq_to_x(active_center - STEP_SPAN_MHZ as f64 / 2.0).max(PAD_LEFT);
        let win_x1 = freq_to_x(active_center + STEP_SPAN_MHZ as f64 / 2.0).min(PAD_LEFT + plot_w);
        let scan_x = freq_to_x(active_center);

        if is_scanning {
            ctx.set_fill_style_str("rgba(56, 189, 248, 0.1)");
            ctx.fill_rect(win_x0, PAD_TOP, (win_x1 - win_x0).max(1.0), plot_h);
        }

        ctx.save();
        ctx.set_stroke_style_str(if is_scanning {
            "#38bdf8"
        } else {
            "rgba(148, 163, 184, 0.6)"
        });
        ctx.set_line_width(2.0);
        ctx.begin_path();
        ctx.move_to(scan_x, PAD_TOP);
        ctx.line_to(scan_x, PAD_TOP + plot_h);
        ctx.stroke();

        let tag = format!("{} MHz", active_center as u16);
        ctx.set_font("bold 10px ui-monospace, SFMono-Regular, Menlo, monospace");
        let tw = ctx.measure_text(&tag).map(|m| m.width()).unwrap_or(60.0) + 10.0;
        let bx = (scan_x - tw / 2.0)
            .max(PAD_LEFT + 2.0)
            .min(PAD_LEFT + plot_w - tw - 2.0);
        ctx.set_fill_style_str("rgba(15, 23, 42, 0.92)");
        ctx.fill_rect(bx, PAD_TOP + 2.0, tw, 16.0);
        ctx.set_stroke_style_str(if is_scanning { "#38bdf8" } else { "#64748b" });
        ctx.set_line_width(1.0);
        ctx.stroke_rect(bx, PAD_TOP + 2.0, tw, 16.0);
        ctx.set_fill_style_str(if is_scanning { "#38bdf8" } else { "#cbd5e1" });
        ctx.set_text_align("left");
        let _ = ctx.fill_text(&tag, bx + 5.0, PAD_TOP + 13.0);
        ctx.restore();

        if let Some(hinfo) = cur_hover {
            if hinfo.x >= PAD_LEFT && hinfo.x <= PAD_LEFT + plot_w {
                ctx.save();
                ctx.set_stroke_style_str("rgba(226, 232, 240, 0.35)");
                ctx.set_line_width(1.0);
                ctx.begin_path();
                ctx.move_to(hinfo.x, PAD_TOP);
                ctx.line_to(hinfo.x, PAD_TOP + plot_h);
                ctx.stroke();
                ctx.restore();
            }
        }

        ctx.set_stroke_style_str("#334155");
        ctx.set_line_width(1.0);
        ctx.stroke_rect(PAD_LEFT, PAD_TOP, plot_w, plot_h);
        ctx.restore();
    });

    let client_x_to_freq = |client_x: f64, rect: &web_sys::DomRect| -> f64 {
        let plot_w = (rect.width() - PAD_LEFT - PAD_RIGHT).max(10.0);
        let rel = ((client_x - rect.left() - PAD_LEFT) / plot_w).clamp(0.0, 1.0);
        SDR_MIN_FREQ_MHZ as f64 + rel * TOTAL_SPAN_MHZ
    };

    let on_pointer_move = move |ev: web_sys::PointerEvent| {
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let freq_mhz = client_x_to_freq(ev.client_x() as f64, &rect);
        let b = (((freq_mhz - SDR_MIN_FREQ_MHZ as f64) / BUCKET_RES_MHZ).floor() as isize)
            .clamp(0, (BUCKET_COUNT - 1) as isize) as usize;
        let live_v = live_buckets.with_value(|v| v[b]);
        let peak_v = peak_buckets.with_value(|v| v[b]);
        let db = if !live_v.is_nan() {
            Some(live_v)
        } else if !peak_v.is_nan() {
            Some(peak_v)
        } else {
            None
        };
        hover_info.set(Some(ScannerHover {
            x: ev.client_x() as f64 - rect.left(),
            freq_mhz,
            db_fs: db,
        }));
    };

    let on_pointer_down = move |ev: web_sys::PointerEvent| {
        let Some(canvas) = canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let freq_mhz = client_x_to_freq(ev.client_x() as f64, &rect).round() as u16;
        scanning.set(false);
        on_tune_and_inspect.run(freq_mhz);
    };

    view! {
        <Show when=move || open.get()>
            <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Wideband RF Scanner">
                <div class="modal-card scanner-modal-card">
                    <div class="modal-header">
                        <div>
                            <h3>"Wideband Scanner (1.84–2.79 GHz)"</h3>
                            <span class="modal-subtitle">
                                {move || {
                                    let idx = scan_step_idx.get();
                                    let (active_f, total_steps) = scan_steps.with_value(|s| {
                                        (s.get(idx).copied().unwrap_or(SDR_MIN_FREQ_MHZ), s.len())
                                    });
                                    let mut s = if scanning.get() {
                                        format!(
                                            "Scanning {} MHz ({}/{}) • Pass #{}",
                                            active_f,
                                            idx + 1,
                                            total_steps,
                                            pass_count.get() + 1
                                        )
                                    } else {
                                        format!("Paused at {} MHz • Click spectrum to tune", active_f)
                                    };
                                    if let Some(h) = hover_info.get() {
                                        s.push_str(&format!(" • ⊕ {:.1} MHz", h.freq_mhz));
                                        if let Some(db) = h.db_fs {
                                            s.push_str(&format!(" ({db:.1} dBFS)"));
                                        }
                                    }
                                    s
                                }}
                            </span>
                        </div>

                        <div class="modal-actions">
                            <button
                                type="button"
                                class=move || {
                                    if scanning.get() {
                                        "btn btn-compact btn-danger"
                                    } else {
                                        "btn btn-compact btn-accent"
                                    }
                                }
                                disabled=move || !connected.get()
                                on:click=move |_| {
                                    if scanning.get_untracked() {
                                        scanning.set(false);
                                    } else {
                                        scanning.set(true);
                                        let cur_f = scan_steps.with_value(|s| {
                                            s[scan_step_idx.get_untracked() % s.len()]
                                        });
                                        awaiting_center.set_value(Some(cur_f));
                                        last_advance_ts.set_value(perf_now());
                                        on_request_scan_step.run(cur_f);
                                    }
                                }
                            >
                                {move || if scanning.get() { "Pause Scan" } else { "Start Scan" }}
                            </button>
                            <button
                                type="button"
                                class="btn btn-secondary btn-compact"
                                on:click=clear_scan_data
                            >
                                "Clear Peak"
                            </button>
                            <button
                                type="button"
                                class="btn btn-ghost btn-compact"
                                on:click=move |_| on_close.run(())
                            >
                                "✕ Close"
                            </button>
                        </div>
                    </div>

                    <div class="scanner-body">
                        <canvas
                            node_ref=canvas_ref
                            class="scanner-canvas"
                            on:pointermove=on_pointer_move
                            on:pointerleave=move |_| hover_info.set(None)
                            on:pointerdown=on_pointer_down
                            title="Click any frequency to tune main analyzer"
                        />
                        <div class="scanner-legend">
                            <span><i class="dot-live" />" Live Sweep"</span>
                            <span><i class="dot-peak" />" Peak-Hold (Burst Traffic)"</span>
                            <span><i class="dot-cursor" />" Active Scan Window (40 MHz)"</span>
                            <span class="scanner-hint">"Click anywhere on the graph to tune & inspect"</span>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    }
}
