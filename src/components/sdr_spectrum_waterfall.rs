use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::Clamped;
use wasm_bindgen::JsCast;

use crate::dsp::sdr_dsp::{
    bin_to_freq_mhz, colormap_lut, freq_mhz_to_bin, map_db_to_lut_index, ColormapId,
    SpectrumTraceState,
};

struct BandOverlay {
    label: &'static str,
    start_mhz: f64,
    end_mhz: f64,
    color: &'static str,
}

const BAND_OVERLAYS: &[BandOverlay] = &[
    BandOverlay {
        label: "DECT EU",
        start_mhz: 1880.0,
        end_mhz: 1900.0,
        color: "rgba(244, 114, 182, 0.16)",
    },
    BandOverlay {
        label: "13cm Ham",
        start_mhz: 2320.0,
        end_mhz: 2400.0,
        color: "rgba(34, 197, 94, 0.12)",
    },
    BandOverlay {
        label: "BLE 37",
        start_mhz: 2401.0,
        end_mhz: 2403.0,
        color: "rgba(167, 139, 250, 0.22)",
    },
    BandOverlay {
        label: "Wi-Fi Ch 1",
        start_mhz: 2402.0,
        end_mhz: 2422.0,
        color: "rgba(56, 189, 248, 0.14)",
    },
    BandOverlay {
        label: "BLE 38",
        start_mhz: 2425.0,
        end_mhz: 2427.0,
        color: "rgba(167, 139, 250, 0.22)",
    },
    BandOverlay {
        label: "Wi-Fi Ch 6",
        start_mhz: 2427.0,
        end_mhz: 2447.0,
        color: "rgba(52, 211, 153, 0.14)",
    },
    BandOverlay {
        label: "Wi-Fi Ch 11",
        start_mhz: 2452.0,
        end_mhz: 2472.0,
        color: "rgba(251, 191, 36, 0.14)",
    },
    BandOverlay {
        label: "Wi-Fi Ch 13",
        start_mhz: 2462.0,
        end_mhz: 2482.0,
        color: "rgba(249, 115, 22, 0.14)",
    },
    BandOverlay {
        label: "BLE 39",
        start_mhz: 2479.0,
        end_mhz: 2481.0,
        color: "rgba(167, 139, 250, 0.22)",
    },
    BandOverlay {
        label: "LTE B7 DL",
        start_mhz: 2620.0,
        end_mhz: 2690.0,
        color: "rgba(251, 146, 60, 0.14)",
    },
];

const PLOT_PAD_LEFT: f64 = 54.0;
const PLOT_PAD_RIGHT: f64 = 16.0;
const PLOT_PAD_TOP: f64 = 18.0;
const PLOT_PAD_BOTTOM: f64 = 24.0;

const WF_WIDTH: u32 = 512;
const WF_HEIGHT: u32 = 240;

#[derive(Debug, Clone, Copy)]
struct MarkerState {
    freq_mhz: f64,
    active: bool,
}

#[derive(Debug, Clone, Copy)]
struct HoverInfo {
    x: f64,
    y: f64,
    freq_mhz: f64,
    db_fs: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DraggingMarker {
    None,
    M1,
    M2,
}

fn create_offscreen_canvas() -> Option<web_sys::HtmlCanvasElement> {
    let doc = web_sys::window()?.document()?;
    let el = doc.create_element("canvas").ok()?;
    let canvas: web_sys::HtmlCanvasElement = el.dyn_into().ok()?;
    canvas.set_width(WF_WIDTH);
    canvas.set_height(WF_HEIGHT);
    if let Ok(Some(ctx_obj)) = canvas.get_context("2d") {
        if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
            ctx.set_fill_style_str("#020617");
            ctx.fill_rect(0.0, 0.0, WF_WIDTH as f64, WF_HEIGHT as f64);
        }
    }
    Some(canvas)
}

fn sample_trace_at_freq(trace: Option<&SpectrumTraceState>, freq_mhz: f64) -> Option<f32> {
    let t = trace?;
    if t.fft_bins == 0 {
        return None;
    }
    let bin_f = freq_mhz_to_bin(freq_mhz, t.fft_bins, t.center_freq_mhz, t.span_mhz);
    let idx = (bin_f.round() as isize).clamp(0, (t.fft_bins - 1) as isize) as usize;
    Some(t.live_dbfs[idx])
}

#[component]
pub fn SdrSpectrumWaterfall(
    trace: RwSignal<Option<SpectrumTraceState>>,
    center_freq_mhz: RwSignal<u16>,
    span_mhz: Signal<f64>,
    fps: RwSignal<f64>,
    streaming: RwSignal<bool>,
    frame_version: RwSignal<u64>,
) -> impl IntoView {
    let spectrum_canvas_ref = NodeRef::<html::Canvas>::new();
    let waterfall_canvas_ref = NodeRef::<html::Canvas>::new();
    let offscreen_wf = StoredValue::new_local(None::<web_sys::HtmlCanvasElement>);
    let wf_row_buf = StoredValue::new_local(vec![0u8; (WF_WIDTH as usize) * 4]);
    let resize_ver = RwSignal::new(0u64);
    let raf_pending = StoredValue::new(false);

    if let Some(win) = web_sys::window() {
        let cb = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || {
            resize_ver.update(|v| *v = v.wrapping_add(1));
        });
        let _ = win.add_event_listener_with_callback("resize", cb.as_ref().unchecked_ref());
        cb.forget();
    }

    let colormap = RwSignal::new(ColormapId::Turbo);
    let min_dbfs = RwSignal::new(-115i32);
    let max_dbfs = RwSignal::new(-15i32);
    let show_band_overlays = RwSignal::new(true);
    let waterfall_paused = RwSignal::new(false);
    let wf_clear_rev = RwSignal::new(0u64);

    let hover_info = RwSignal::new(None::<HoverInfo>);
    let m1 = RwSignal::new(MarkerState {
        freq_mhz: 2437.0,
        active: false,
    });
    let m2 = RwSignal::new(MarkerState {
        freq_mhz: 2447.0,
        active: false,
    });
    let dragging_marker = StoredValue::new(DraggingMarker::None);

    let ensure_offscreen = move || -> Option<web_sys::HtmlCanvasElement> {
        let existing = offscreen_wf.get_value();
        if existing.is_some() {
            return existing;
        }
        let created = create_offscreen_canvas();
        offscreen_wf.set_value(created.clone());
        created
    };

    let clear_waterfall = move |_| {
        if let Some(c) = ensure_offscreen() {
            if let Ok(Some(ctx_obj)) = c.get_context("2d") {
                if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
                    ctx.set_fill_style_str("#020617");
                    ctx.fill_rect(0.0, 0.0, WF_WIDTH as f64, WF_HEIGHT as f64);
                }
            }
        }
        wf_clear_rev.update(|v| *v += 1);
    };

    // Append one waterfall line per received spectrum frame
    Effect::new(move |_| {
        let ver = frame_version.get();
        if ver == 0 || waterfall_paused.get_untracked() {
            return;
        }
        let cur_trace = trace.get_untracked();
        let Some(ref t) = cur_trace else {
            return;
        };
        let Some(offscreen) = ensure_offscreen() else {
            return;
        };
        let Ok(Some(ctx_obj)) = offscreen.get_context("2d") else {
            return;
        };
        let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() else {
            return;
        };

        let _ = ctx.draw_image_with_html_canvas_element_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
            &offscreen,
            0.0,
            0.0,
            WF_WIDTH as f64,
            (WF_HEIGHT - 1) as f64,
            0.0,
            1.0,
            WF_WIDTH as f64,
            (WF_HEIGHT - 1) as f64,
        );

        let lut = colormap_lut(colormap.get_untracked());
        let min_db = min_dbfs.get_untracked() as f32;
        let max_db = max_dbfs.get_untracked() as f32;
        let bins = &t.live_dbfs;
        let n_bins = bins.len();

        wf_row_buf.update_value(|row_bytes| {
            for x in 0..(WF_WIDTH as usize) {
                let bin_start = (x * n_bins) / (WF_WIDTH as usize);
                let bin_end = (((x + 1) * n_bins) / (WF_WIDTH as usize)).max(bin_start + 1);
                let mut peak_val = -130.0f32;
                for &v in &bins[bin_start..bin_end.min(n_bins)] {
                    if v > peak_val {
                        peak_val = v;
                    }
                }
                let lut_idx = map_db_to_lut_index(peak_val, min_db, max_db) * 4;
                let p = x * 4;
                row_bytes[p] = lut[lut_idx];
                row_bytes[p + 1] = lut[lut_idx + 1];
                row_bytes[p + 2] = lut[lut_idx + 2];
                row_bytes[p + 3] = 255;
            }

            if let Ok(img) = web_sys::ImageData::new_with_u8_clamped_array_and_sh(
                Clamped(row_bytes.as_slice()),
                WF_WIDTH,
                1,
            ) {
                let _ = ctx.put_image_data(&img, 0.0, 0.0);
            }
        });
    });

    let render_canvases = move || {
        let cur_trace = trace.get_untracked();
        let active_center = cur_trace
            .as_ref()
            .map(|t| t.center_freq_mhz)
            .unwrap_or_else(|| center_freq_mhz.get_untracked() as f64);
        let active_span = cur_trace
            .as_ref()
            .map(|t| t.span_mhz)
            .unwrap_or_else(|| span_mhz.get_untracked());
        let start_freq = active_center - active_span / 2.0;
        let end_freq = active_center + active_span / 2.0;
        let min_db = min_dbfs.get_untracked() as f64;
        let max_db = max_dbfs.get_untracked() as f64;
        let bands_on = show_band_overlays.get_untracked();
        let cur_m1 = m1.get_untracked();
        let cur_m2 = m2.get_untracked();
        let cur_hover = hover_info.get_untracked();
        let cur_cmap = colormap.get_untracked();
        let dpr = hotwire_core::web::capped_device_pixel_ratio();

        // 1. Spectrum Canvas
        if let Some(spec_canvas) = spectrum_canvas_ref.get() {
            let rect = spec_canvas.get_bounding_client_rect();
            let w = rect.width().floor().max(100.0);
            let h = rect.height().floor().max(80.0);
            let pw = (w * dpr).floor() as u32;
            let ph = (h * dpr).floor() as u32;
            if spec_canvas.width() != pw || spec_canvas.height() != ph {
                spec_canvas.set_width(pw);
                spec_canvas.set_height(ph);
            }

            if let Ok(Some(ctx_obj)) = spec_canvas.get_context("2d") {
                if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
                    ctx.save();
                    let _ = ctx.scale(dpr, dpr);
                    ctx.set_fill_style_str("#020617");
                    ctx.fill_rect(0.0, 0.0, w, h);

                    let plot_w = (w - PLOT_PAD_LEFT - PLOT_PAD_RIGHT).max(10.0);
                    let plot_h = (h - PLOT_PAD_TOP - PLOT_PAD_BOTTOM).max(10.0);
                    let freq_to_x =
                        |f: f64| PLOT_PAD_LEFT + ((f - start_freq) / active_span) * plot_w;
                    let db_to_y = |db: f64| {
                        let norm = ((db - min_db) / (max_db - min_db).max(1.0)).clamp(0.0, 1.0);
                        PLOT_PAD_TOP + (1.0 - norm) * plot_h
                    };

                    if bands_on {
                        ctx.set_font("10px ui-monospace, SFMono-Regular, Menlo, monospace");
                        ctx.set_text_align("left");
                        for ov in BAND_OVERLAYS {
                            if ov.end_mhz < start_freq || ov.start_mhz > end_freq {
                                continue;
                            }
                            let x0 = freq_to_x(ov.start_mhz).max(PLOT_PAD_LEFT);
                            let x1 = freq_to_x(ov.end_mhz).min(PLOT_PAD_LEFT + plot_w);
                            if x1 <= x0 {
                                continue;
                            }
                            ctx.set_fill_style_str(ov.color);
                            ctx.fill_rect(x0, PLOT_PAD_TOP, x1 - x0, plot_h);
                            ctx.set_fill_style_str("rgba(226, 232, 240, 0.72)");
                            let _ = ctx.fill_text(ov.label, x0 + 4.0, PLOT_PAD_TOP + 12.0);
                        }
                    }

                    ctx.set_line_width(1.0);
                    ctx.set_font("10px ui-monospace, SFMono-Regular, Menlo, monospace");
                    let db_step = if max_db - min_db > 75.0 { 20 } else { 10 };
                    let first_db = ((min_db / db_step as f64).ceil() as i32) * db_step;
                    let mut db = first_db;
                    while (db as f64) <= max_db {
                        let y = db_to_y(db as f64).round() + 0.5;
                        ctx.set_stroke_style_str("rgba(51, 65, 85, 0.55)");
                        ctx.begin_path();
                        ctx.move_to(PLOT_PAD_LEFT, y);
                        ctx.line_to(PLOT_PAD_LEFT + plot_w, y);
                        ctx.stroke();

                        ctx.set_fill_style_str("#94a3b8");
                        ctx.set_text_align("right");
                        let _ = ctx.fill_text(&db.to_string(), PLOT_PAD_LEFT - 6.0, y + 3.0);
                        db += db_step;
                    }

                    let freq_steps = 8;
                    ctx.set_text_align("center");
                    for k in 0..=freq_steps {
                        let f = start_freq + (k as f64 / freq_steps as f64) * active_span;
                        let x = freq_to_x(f).round() + 0.5;
                        ctx.set_stroke_style_str(if k == freq_steps / 2 {
                            "rgba(56, 189, 248, 0.35)"
                        } else {
                            "rgba(51, 65, 85, 0.45)"
                        });
                        ctx.begin_path();
                        ctx.move_to(x, PLOT_PAD_TOP);
                        ctx.line_to(x, PLOT_PAD_TOP + plot_h);
                        ctx.stroke();

                        ctx.set_fill_style_str(if k == freq_steps / 2 {
                            "#38bdf8"
                        } else {
                            "#94a3b8"
                        });
                        let _ = ctx.fill_text(&format!("{f:.1}"), x, PLOT_PAD_TOP + plot_h + 15.0);
                    }

                    if let Some(ref tr) = cur_trace {
                        let draw_trace =
                            |arr: &[f32], stroke: &str, lw: f64, fill_grad: bool, dashed: bool| {
                                ctx.save();
                                ctx.begin_path();
                                for (i, &val) in arr.iter().enumerate() {
                                    let freq = bin_to_freq_mhz(
                                        i as f64,
                                        arr.len(),
                                        active_center,
                                        active_span,
                                    );
                                    let x = freq_to_x(freq);
                                    let y = db_to_y(val as f64);
                                    if i == 0 {
                                        ctx.move_to(x, y);
                                    } else {
                                        ctx.line_to(x, y);
                                    }
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

                                if fill_grad && !arr.is_empty() {
                                    let last_freq = bin_to_freq_mhz(
                                        (arr.len() - 1) as f64,
                                        arr.len(),
                                        active_center,
                                        active_span,
                                    );
                                    let last_x = freq_to_x(last_freq);
                                    ctx.line_to(last_x, PLOT_PAD_TOP + plot_h);
                                    ctx.line_to(PLOT_PAD_LEFT, PLOT_PAD_TOP + plot_h);
                                    ctx.close_path();
                                    let grad = ctx.create_linear_gradient(
                                        0.0,
                                        PLOT_PAD_TOP,
                                        0.0,
                                        PLOT_PAD_TOP + plot_h,
                                    );
                                    let _ = grad.add_color_stop(0.0, "rgba(52, 211, 153, 0.28)");
                                    let _ = grad.add_color_stop(1.0, "rgba(52, 211, 153, 0.01)");
                                    ctx.set_fill_style_canvas_gradient(&grad);
                                    ctx.fill();
                                }
                                ctx.restore();
                            };

                        draw_trace(
                            &tr.peak_hold_dbfs,
                            "rgba(251, 191, 36, 0.72)",
                            1.25,
                            false,
                            true,
                        );
                        draw_trace(&tr.avg_dbfs, "rgba(56, 189, 248, 0.85)", 1.35, false, false);
                        draw_trace(&tr.live_dbfs, "#34d399", 1.6, true, false);
                    }

                    let draw_marker = |mk: MarkerState, tag: &str, color: &str| {
                        if !mk.active || mk.freq_mhz < start_freq || mk.freq_mhz > end_freq {
                            return;
                        }
                        let x = freq_to_x(mk.freq_mhz);
                        let db = sample_trace_at_freq(cur_trace.as_ref(), mk.freq_mhz);
                        let y = db.map(|d| db_to_y(d as f64)).unwrap_or(PLOT_PAD_TOP + 20.0);

                        ctx.save();
                        ctx.set_stroke_style_str(color);
                        ctx.set_line_width(1.0);
                        let dash = js_sys::Array::new();
                        dash.push(&3.0.into());
                        dash.push(&3.0.into());
                        let _ = ctx.set_line_dash(&dash);
                        ctx.begin_path();
                        ctx.move_to(x, PLOT_PAD_TOP);
                        ctx.line_to(x, PLOT_PAD_TOP + plot_h);
                        ctx.stroke();

                        let _ = ctx.set_line_dash(&js_sys::Array::new());
                        ctx.set_fill_style_str(color);
                        ctx.begin_path();
                        ctx.move_to(x, y - 6.0);
                        ctx.line_to(x + 6.0, y);
                        ctx.line_to(x, y + 6.0);
                        ctx.line_to(x - 6.0, y);
                        ctx.close_path();
                        ctx.fill();

                        let label = match db {
                            Some(d) => format!("{tag} {:.2} MHz ({d:.1} dBFS)", mk.freq_mhz),
                            None => format!("{tag} {:.2} MHz", mk.freq_mhz),
                        };
                        let tw = ctx.measure_text(&label).map(|m| m.width()).unwrap_or(90.0) + 10.0;
                        let bx = (x - tw / 2.0)
                            .max(PLOT_PAD_LEFT + 2.0)
                            .min(PLOT_PAD_LEFT + plot_w - tw - 2.0);
                        ctx.set_fill_style_str("rgba(15, 23, 42, 0.9)");
                        ctx.fill_rect(bx, PLOT_PAD_TOP + 2.0, tw, 16.0);
                        ctx.set_stroke_style_str(color);
                        ctx.stroke_rect(bx, PLOT_PAD_TOP + 2.0, tw, 16.0);
                        ctx.set_fill_style_str(color);
                        ctx.set_text_align("left");
                        let _ = ctx.fill_text(&label, bx + 5.0, PLOT_PAD_TOP + 13.0);
                        ctx.restore();
                    };

                    draw_marker(cur_m1, "M1", "#fbbf24");
                    draw_marker(cur_m2, "M2", "#f472b6");

                    if let Some(hinfo) = cur_hover {
                        if hinfo.x >= PLOT_PAD_LEFT && hinfo.x <= PLOT_PAD_LEFT + plot_w {
                            ctx.save();
                            ctx.set_stroke_style_str("rgba(226, 232, 240, 0.35)");
                            ctx.set_line_width(1.0);
                            ctx.begin_path();
                            ctx.move_to(hinfo.x, PLOT_PAD_TOP);
                            ctx.line_to(hinfo.x, PLOT_PAD_TOP + plot_h);
                            ctx.move_to(PLOT_PAD_LEFT, hinfo.y);
                            ctx.line_to(PLOT_PAD_LEFT + plot_w, hinfo.y);
                            ctx.stroke();
                            ctx.restore();
                        }
                    }

                    ctx.set_stroke_style_str("#334155");
                    ctx.set_line_width(1.0);
                    ctx.stroke_rect(PLOT_PAD_LEFT, PLOT_PAD_TOP, plot_w, plot_h);
                    ctx.restore();
                }
            }
        }

        // 2. Waterfall Canvas
        if let Some(wf_canvas) = waterfall_canvas_ref.get() {
            let rect = wf_canvas.get_bounding_client_rect();
            let w = rect.width().floor().max(100.0);
            let h = rect.height().floor().max(80.0);
            let pw = (w * dpr).floor() as u32;
            let ph = (h * dpr).floor() as u32;
            if wf_canvas.width() != pw || wf_canvas.height() != ph {
                wf_canvas.set_width(pw);
                wf_canvas.set_height(ph);
            }

            if let Ok(Some(ctx_obj)) = wf_canvas.get_context("2d") {
                if let Ok(ctx) = ctx_obj.dyn_into::<web_sys::CanvasRenderingContext2d>() {
                    ctx.save();
                    let _ = ctx.scale(dpr, dpr);
                    ctx.set_fill_style_str("#020617");
                    ctx.fill_rect(0.0, 0.0, w, h);

                    let plot_w = (w - PLOT_PAD_LEFT - PLOT_PAD_RIGHT).max(10.0);
                    let plot_h = (h - 10.0).max(10.0);
                    if let Some(offscreen) = ensure_offscreen() {
                        ctx.set_image_smoothing_enabled(false);
                        let _ = ctx.draw_image_with_html_canvas_element_and_sw_and_sh_and_dx_and_dy_and_dw_and_dh(
                            &offscreen,
                            0.0,
                            0.0,
                            WF_WIDTH as f64,
                            WF_HEIGHT as f64,
                            PLOT_PAD_LEFT,
                            2.0,
                            plot_w,
                            plot_h,
                        );
                    }

                    let lut = colormap_lut(cur_cmap);
                    let bar_x = 14.0;
                    let bar_w = 12.0;
                    let bar_y = 12.0;
                    let bar_h = (plot_h - 24.0).max(40.0);
                    let grad = ctx.create_linear_gradient(0.0, bar_y, 0.0, bar_y + bar_h);
                    for s in 0..=16usize {
                        let stop = (s as f32) / 16.0;
                        let lut_entry = (((1.0 - stop) * 255.0).round() as usize).min(255) * 4;
                        let _ = grad.add_color_stop(
                            stop,
                            &format!(
                                "rgb({},{},{})",
                                lut[lut_entry],
                                lut[lut_entry + 1],
                                lut[lut_entry + 2]
                            ),
                        );
                    }
                    ctx.set_fill_style_canvas_gradient(&grad);
                    ctx.fill_rect(bar_x, bar_y, bar_w, bar_h);
                    ctx.set_stroke_style_str("#475569");
                    ctx.stroke_rect(bar_x, bar_y, bar_w, bar_h);
                    ctx.set_fill_style_str("#94a3b8");
                    ctx.set_font("9px ui-monospace, SFMono-Regular, Menlo, monospace");
                    ctx.set_text_align("left");
                    let _ = ctx.fill_text(
                        &format!("{}", max_db as i32),
                        bar_x + bar_w + 4.0,
                        bar_y + 7.0,
                    );
                    let _ = ctx.fill_text(
                        &format!("{}", min_db as i32),
                        bar_x + bar_w + 4.0,
                        bar_y + bar_h,
                    );

                    ctx.set_stroke_style_str("#334155");
                    ctx.stroke_rect(PLOT_PAD_LEFT, 2.0, plot_w, plot_h);
                    ctx.restore();
                }
            }
        }
    };

    // Coalesce high-DPI canvas repaints onto browser requestAnimationFrame
    Effect::new(move |_| {
        let _r = resize_ver.get();
        let _ver = frame_version.get();
        let _clr = wf_clear_rev.get();
        let _has_trace = trace.with(|t| t.is_some());
        let _cf = center_freq_mhz.get();
        let _sp = span_mhz.get();
        let _min = min_dbfs.get();
        let _max = max_dbfs.get();
        let _b = show_band_overlays.get();
        let _m1 = m1.get();
        let _m2 = m2.get();
        let _h = hover_info.get();
        let _cm = colormap.get();

        if raf_pending.get_value() {
            return;
        }
        raf_pending.set_value(true);
        if let Some(win) = web_sys::window() {
            let cb = wasm_bindgen::closure::Closure::once_into_js(move || {
                raf_pending.set_value(false);
                render_canvases();
            });
            let _ = win.request_animation_frame(cb.unchecked_ref());
        } else {
            raf_pending.set_value(false);
            render_canvases();
        }
    });

    let client_x_to_freq = move |client_x: f64, rect: &web_sys::DomRect| -> f64 {
        let cur_trace = trace.get_untracked();
        let active_center = cur_trace
            .as_ref()
            .map(|t| t.center_freq_mhz)
            .unwrap_or_else(|| center_freq_mhz.get_untracked() as f64);
        let active_span = cur_trace
            .as_ref()
            .map(|t| t.span_mhz)
            .unwrap_or_else(|| span_mhz.get_untracked());
        let plot_w = (rect.width() - PLOT_PAD_LEFT - PLOT_PAD_RIGHT).max(10.0);
        let rel = ((client_x - rect.left() - PLOT_PAD_LEFT) / plot_w).clamp(0.0, 1.0);
        active_center - active_span / 2.0 + rel * active_span
    };

    let on_pointer_down = move |ev: web_sys::PointerEvent| {
        let Some(canvas) = spectrum_canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let click_freq = client_x_to_freq(ev.client_x() as f64, &rect);
        let active_span = trace
            .get_untracked()
            .map(|t| t.span_mhz)
            .unwrap_or_else(|| span_mhz.get_untracked());
        let hit_tol = active_span * 0.02;

        let cur_m1 = m1.get_untracked();
        let cur_m2 = m2.get_untracked();
        if cur_m1.active && (click_freq - cur_m1.freq_mhz).abs() < hit_tol {
            dragging_marker.set_value(DraggingMarker::M1);
        } else if cur_m2.active && (click_freq - cur_m2.freq_mhz).abs() < hit_tol {
            dragging_marker.set_value(DraggingMarker::M2);
        } else if ev.shift_key() || ev.button() == 2 {
            m2.set(MarkerState {
                freq_mhz: click_freq,
                active: true,
            });
            dragging_marker.set_value(DraggingMarker::M2);
        } else {
            m1.set(MarkerState {
                freq_mhz: click_freq,
                active: true,
            });
            dragging_marker.set_value(DraggingMarker::M1);
        }
        let _ = canvas.set_pointer_capture(ev.pointer_id());
    };

    let on_pointer_move = move |ev: web_sys::PointerEvent| {
        let Some(canvas) = spectrum_canvas_ref.get() else {
            return;
        };
        let rect = canvas.get_bounding_client_rect();
        let x = ev.client_x() as f64 - rect.left();
        let y = ev.client_y() as f64 - rect.top();
        let freq_mhz = client_x_to_freq(ev.client_x() as f64, &rect);

        match dragging_marker.get_value() {
            DraggingMarker::M1 => m1.set(MarkerState {
                freq_mhz,
                active: true,
            }),
            DraggingMarker::M2 => m2.set(MarkerState {
                freq_mhz,
                active: true,
            }),
            DraggingMarker::None => {}
        }

        let cur_trace = trace.get_untracked();
        let db = sample_trace_at_freq(cur_trace.as_ref(), freq_mhz);
        let plot_h = (rect.height() - PLOT_PAD_TOP - PLOT_PAD_BOTTOM).max(10.0);
        let rel_y = (1.0 - (y - PLOT_PAD_TOP) / plot_h).clamp(0.0, 1.0);
        let min_db = min_dbfs.get_untracked() as f64;
        let max_db = max_dbfs.get_untracked() as f64;
        let cursor_db = (min_db + rel_y * (max_db - min_db)) as f32;

        hover_info.set(Some(HoverInfo {
            x,
            y,
            freq_mhz,
            db_fs: db.unwrap_or(cursor_db),
        }));
    };

    let on_pointer_up = move |ev: web_sys::PointerEvent| {
        dragging_marker.set_value(DraggingMarker::None);
        if let Some(canvas) = spectrum_canvas_ref.get() {
            let _ = canvas.release_pointer_capture(ev.pointer_id());
        }
    };

    let rbw_khz = move || {
        if let Some(t) = trace.get() {
            (t.span_mhz * 1000.0) / (t.fft_bins.max(1) as f64)
        } else {
            (span_mhz.get() * 1000.0) / 1024.0
        }
    };

    view! {
        <div class="sdr-visualizer">
            <div class="sdr-hud-bar">
                <div class="hud-metrics">
                    <span class="hud-item">
                        <strong>"RBW:"</strong>
                        {move || format!(" {:.1} kHz", rbw_khz())}
                    </span>
                    {move || {
                        trace.get().map(|t| {
                            view! {
                                <span class="hud-item">
                                    <strong>"Peak:"</strong>
                                    {format!(
                                        " {:.2} MHz ({:.1} dBFS)",
                                        t.stats.peak_freq_mhz, t.stats.peak_dbfs
                                    )}
                                </span>
                                <span class="hud-item">
                                    <strong>"Noise:"</strong>
                                    {format!(" {:.1} dBFS", t.stats.noise_floor_dbfs)}
                                </span>
                                <span class="hud-item">
                                    <strong>"SNR:"</strong>
                                    {format!(" {:.1} dB", t.stats.snr_db)}
                                </span>
                            }
                        })
                    }}
                    <span class=move || {
                        if streaming.get() { "hud-fps live" } else { "hud-fps" }
                    }>
                        {move || {
                            if streaming.get() {
                                format!("{:.1} FPS", fps.get())
                            } else {
                                "PAUSED".to_string()
                            }
                        }}
                    </span>
                    {move || {
                        let cur_m1 = m1.get();
                        let cur_m2 = m2.get();
                        let cur_trace = trace.get();
                        if cur_m1.active && cur_m2.active {
                            if let (Some(d1), Some(d2)) = (
                                sample_trace_at_freq(cur_trace.as_ref(), cur_m1.freq_mhz),
                                sample_trace_at_freq(cur_trace.as_ref(), cur_m2.freq_mhz),
                            ) {
                                return Some(view! {
                                    <span class="hud-delta">
                                        {format!(
                                            "ΔM2-M1: {:.2} MHz | {:.1} dB",
                                            cur_m2.freq_mhz - cur_m1.freq_mhz,
                                            d2 - d1
                                        )}
                                    </span>
                                });
                            }
                        }
                        None
                    }}
                    {move || {
                        hover_info.get().map(|h| {
                            view! {
                                <span class="hover-readout">
                                    {format!("⊕ {:.2} MHz ({:.1} dBFS)", h.freq_mhz, h.db_fs)}
                                </span>
                            }
                        })
                    }}
                </div>

                <div class="hud-controls">
                    <button
                        type="button"
                        class=move || {
                            if show_band_overlays.get() { "btn-mini active" } else { "btn-mini" }
                        }
                        on:click=move |_| show_band_overlays.update(|v| *v = !*v)
                        title="Toggle Wi-Fi and BLE band overlay guides"
                    >
                        "Bands"
                    </button>
                    <button
                        type="button"
                        class=move || if m1.get().active { "btn-mini active" } else { "btn-mini" }
                        on:click=move |_| {
                            let c = trace
                                .get_untracked()
                                .map(|t| t.center_freq_mhz)
                                .unwrap_or_else(|| center_freq_mhz.get_untracked() as f64);
                            m1.update(|prev| {
                                prev.freq_mhz = c;
                                prev.active = !prev.active;
                            });
                        }
                        title="Toggle Marker 1 (click/drag on spectrum)"
                    >
                        "M1"
                    </button>
                    <button
                        type="button"
                        class=move || if m2.get().active { "btn-mini active" } else { "btn-mini" }
                        on:click=move |_| {
                            let c = trace
                                .get_untracked()
                                .map(|t| t.center_freq_mhz)
                                .unwrap_or_else(|| center_freq_mhz.get_untracked() as f64);
                            m2.update(|prev| {
                                prev.freq_mhz = c + 10.0;
                                prev.active = !prev.active;
                            });
                        }
                        title="Toggle Marker 2 (click/drag on spectrum)"
                    >
                        "M2"
                    </button>
                </div>
            </div>

            <div class="sdr-canvas-stack">
                <div class="spectrum-pane">
                    <canvas
                        node_ref=spectrum_canvas_ref
                        class="spectrum-canvas"
                        on:pointerdown=on_pointer_down
                        on:pointermove=on_pointer_move
                        on:pointerup=on_pointer_up
                        on:pointerleave=move |_| hover_info.set(None)
                        on:contextmenu=move |ev: web_sys::MouseEvent| {
                            ev.prevent_default();
                            if let Some(canvas) = spectrum_canvas_ref.get() {
                                let rect = canvas.get_bounding_client_rect();
                                let f = client_x_to_freq(ev.client_x() as f64, &rect);
                                m2.set(MarkerState {
                                    freq_mhz: f,
                                    active: true,
                                });
                            }
                        }
                    />
                    <Show when=move || trace.get().is_none()>
                        <div class="sdr-empty-overlay">
                            <p>"Connect XIAO ESP32-S3 / ESP32-C6 or click Demo, then press Start RF."</p>
                        </div>
                    </Show>
                </div>

                <div class="waterfall-toolbar">
                    <div class="wf-group">
                        <label for="wf-lut">"Palette"</label>
                        <select
                            id="wf-lut"
                            prop:value=move || colormap.get().as_str()
                            on:change=move |ev| {
                                colormap.set(ColormapId::from_str(&event_target_value(&ev)));
                            }
                        >
                            <option value="turbo">"Turbo"</option>
                            <option value="viridis">"Viridis"</option>
                            <option value="inferno">"Inferno"</option>
                        </select>
                    </div>
                    <div class="wf-group">
                        <label for="wf-min">{move || format!("Min {} dB", min_dbfs.get())}</label>
                        <input
                            id="wf-min"
                            type="range"
                            min="-125"
                            max=move || (max_dbfs.get() - 10).to_string()
                            step="1"
                            prop:value=move || min_dbfs.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<i32>() {
                                    min_dbfs.set(v);
                                }
                            }
                        />
                    </div>
                    <div class="wf-group">
                        <label for="wf-max">{move || format!("Max {} dB", max_dbfs.get())}</label>
                        <input
                            id="wf-max"
                            type="range"
                            min=move || (min_dbfs.get() + 10).to_string()
                            max="0"
                            step="1"
                            prop:value=move || max_dbfs.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<i32>() {
                                    max_dbfs.set(v);
                                }
                            }
                        />
                    </div>
                    <div class="wf-spacer" />
                    <div class="wf-actions">
                        <button
                            type="button"
                            class=move || {
                                if waterfall_paused.get() {
                                    "btn-mini btn-pause active"
                                } else {
                                    "btn-mini btn-pause"
                                }
                            }
                            on:click=move |_| waterfall_paused.update(|p| *p = !*p)
                            title=move || {
                                if waterfall_paused.get() {
                                    "Resume waterfall roll"
                                } else {
                                    "Pause waterfall roll"
                                }
                            }
                        >
                            {move || if waterfall_paused.get() { "Resume" } else { "Pause" }}
                        </button>
                        <button
                            type="button"
                            class="btn-mini btn-clear"
                            on:click=clear_waterfall
                            title="Clear waterfall display"
                        >
                            "Clear"
                        </button>
                    </div>
                </div>

                <div class="waterfall-pane">
                    <canvas node_ref=waterfall_canvas_ref class="waterfall-canvas" />
                </div>
            </div>
        </div>
    }
}
