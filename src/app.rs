use hotwire_core::protocol::{FrameRule, ToolId};
use hotwire_core::ui::{FirmwareMismatchModal, HotWireTheme};
use hotwire_core::web::perf_now;
use hotwire_core::{use_hotwire_session, SessionConfig};
use leptos::prelude::*;

use crate::components::bottom_drawer::BottomDrawer;
use crate::components::raw_iq_inspector::RawIqInspector;
use crate::components::sdr_control_bar::SdrControlBar;
use crate::components::sdr_spectrum_waterfall::SdrSpectrumWaterfall;
use crate::components::top_toolbar::TopToolbar;
use crate::components::wideband_scanner_modal::WidebandScannerModal;
use crate::dsp::sdr_dsp::{update_spectrum_traces_in_place, DspProcessOptions, SpectrumTraceState};
use crate::protocol::codec::{
    build_sdr_stream_ctrl_cmd, build_sdr_sweep_cfg_cmd, build_sdr_tune_cmd, clamp_sdr_freq_mhz,
    decode_response_payload, resolve_sdr_rate_preset,
};
use crate::protocol::types::{
    BoardCapabilitiesFrame, DecodedFrame, SdrRawIqFrame, SdrSpectrumFrame, MAX_FRAME_PAYLOAD_LEN,
    SDR_DSP_FLAG_DC_CANCEL, SDR_DSP_FLAG_MAX_HOLD, SDR_STREAM_CONT_IQ, SDR_STREAM_FFT,
    SDR_STREAM_SINGLE_IQ, SDR_STREAM_STOP, TYPE_SDR_RAW_IQ_FRAME, TYPE_SDR_SPECTRUM_FRAME,
};
use crate::transport::serial::{create_sdr_transport, TransportKind};

#[component]
pub fn App() -> impl IntoView {
    let serial_transport = StoredValue::new_local(create_sdr_transport());

    let board_caps = RwSignal::new(None::<BoardCapabilitiesFrame>);
    let max_iq_kb = RwSignal::new(8u8);

    // SDR state
    let sdr_streaming = RwSignal::new(false);
    let sdr_center_freq_mhz = RwSignal::new(2437u16);
    let sdr_rate_bw_code = RwSignal::new(1u8);
    let sdr_fft_log2 = RwSignal::new(10u8);
    let sdr_max_hold_detector = RwSignal::new(false);
    let sdr_sub_windows = RwSignal::new(4u8);
    let sdr_dc_notch = RwSignal::new(true);
    let sdr_spur_blanker = RwSignal::new(false);
    let sdr_peak_decay_db_per_sec = RwSignal::new(5.0f32);
    let sdr_gain_index = RwSignal::new(42u8);
    let sdr_target_fps = RwSignal::new(20u8);
    let sdr_sweep_enabled = RwSignal::new(false);

    let sdr_adc_clip = RwSignal::new(false);
    let sdr_lo_div_active = RwSignal::new(false);
    let sdr_capture_truncated = RwSignal::new(false);
    let sdr_trace = RwSignal::new(None::<SpectrumTraceState>);
    let latest_sdr_frame = RwSignal::new(None::<SdrSpectrumFrame>);
    let sdr_frame_version = RwSignal::new(0u64);
    let sdr_fps = RwSignal::new(0.0f64);

    // Modals & drawers
    let scanner_open = RwSignal::new(false);
    let raw_iq_open = RwSignal::new(false);
    let raw_iq_frame = RwSignal::new(None::<SdrRawIqFrame>);
    let raw_iq_kb = RwSignal::new(2u8);
    let streaming_cont_iq = RwSignal::new(false);
    let drawer_open = RwSignal::new(false);
    let mobile_controls_open = RwSignal::new(false);

    let clear_next_peak = StoredValue::new(false);
    let scanner_saved_rate_code = StoredValue::new(None::<u8>);
    let sweep_saved_rate_code = StoredValue::new(None::<u8>);
    let resume_fft_after_raw_iq = StoredValue::new(false);
    let last_frame_ts = StoredValue::new(0.0f64);

    let send_sdr_tune = move |freq_mhz: u16, bw_code: u8, gain: u8| {
        if !serial_transport.with_value(|t| t.snapshot().status.is_active()) {
            return;
        }
        let cmd = build_sdr_tune_cmd(freq_mhz as i32, bw_code, gain as i32);
        serial_transport.with_value(|t| t.send_bytes(&cmd));
    };

    let build_dsp_flags = move || -> u8 {
        let mut flags = 0u8;
        if sdr_max_hold_detector.get_untracked() {
            flags |= SDR_DSP_FLAG_MAX_HOLD;
        }
        if sdr_dc_notch.get_untracked() {
            flags |= SDR_DSP_FLAG_DC_CANCEL;
        }
        let sw = sdr_sub_windows.get_untracked().clamp(1, 16);
        flags |= ((sw - 1) & 0x0f) << 4;
        flags
    };

    let send_sdr_stream_ctrl = move |mode: u8, size_param: u8| {
        if !serial_transport.with_value(|t| t.snapshot().status.is_active()) {
            return;
        }
        let cmd = build_sdr_stream_ctrl_cmd(
            mode,
            size_param,
            build_dsp_flags(),
            sdr_target_fps.get_untracked(),
        );
        serial_transport.with_value(|t| t.send_bytes(&cmd));
    };

    let resume_fft_stream = move || {
        if !serial_transport.with_value(|t| t.snapshot().status.is_active()) {
            return;
        }
        send_sdr_tune(
            sdr_center_freq_mhz.get_untracked(),
            sdr_rate_bw_code.get_untracked(),
            sdr_gain_index.get_untracked(),
        );
        sdr_streaming.set(true);
        streaming_cont_iq.set(false);
        last_frame_ts.set_value(0.0);
        send_sdr_stream_ctrl(SDR_STREAM_FFT, sdr_fft_log2.get_untracked());
    };

    let session = use_hotwire_session(
        serial_transport.with_value(|t| t.clone()),
        SessionConfig::new(
            ToolId::Sdr,
            vec![
                FrameRule::new(TYPE_SDR_SPECTRUM_FRAME, 8 + 256, 8 + 2048),
                FrameRule::new(TYPE_SDR_RAW_IQ_FRAME, 8 + 2, MAX_FRAME_PAYLOAD_LEN),
            ],
        ),
        move |id, _is_usb| {
            let caps = BoardCapabilitiesFrame::from_identity(id);
            drawer_open.set(false);
            let max_iq = caps.max_iq_kb.clamp(1, 16);
            max_iq_kb.set(max_iq);
            if raw_iq_kb.get_untracked() > max_iq {
                raw_iq_kb.set(max_iq);
            }
            scanner_saved_rate_code.set_value(None);
            sweep_saved_rate_code.set_value(None);
            resume_fft_after_raw_iq.set_value(false);
            // The firmware keeps its sweep configuration across USB reconnects;
            // explicitly return to a clean single-tune state before streaming.
            let sweep_off = build_sdr_sweep_cfg_cmd(2400, 0, 4);
            serial_transport.with_value(|t| t.send_bytes(&sweep_off));
            sdr_sweep_enabled.set(false);
            // Auto-start live RF spectrum streaming on verified connect.
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                sdr_rate_bw_code.get_untracked(),
                sdr_gain_index.get_untracked(),
            );
            sdr_streaming.set(true);
            streaming_cont_iq.set(false);
            last_frame_ts.set_value(0.0);
            send_sdr_stream_ctrl(SDR_STREAM_FFT, sdr_fft_log2.get_untracked());
            board_caps.set(Some(caps));
        },
        move || {
            sdr_streaming.set(false);
            streaming_cont_iq.set(false);
            sdr_sweep_enabled.set(false);
            scanner_saved_rate_code.set_value(None);
            sweep_saved_rate_code.set_value(None);
            resume_fft_after_raw_iq.set_value(false);
            sdr_adc_clip.set(false);
            sdr_capture_truncated.set(false);
            sdr_lo_div_active.set(false);
            board_caps.set(None);
            max_iq_kb.set(8);
            sdr_fps.set(0.0);
            last_frame_ts.set_value(0.0);
        },
        move |frame_type, payload| {
            let Some(frame) = decode_response_payload(frame_type, payload) else {
                return;
            };
            match frame {
                DecodedFrame::Capabilities(_, _) => {
                    // Capabilities are intercepted by the shared session.
                }
                DecodedFrame::SdrSpectrum(spec) => {
                    let now = perf_now();
                    let prev_ts = last_frame_ts.get_value();
                    let mut dt_sec = 0.0f32;
                    if prev_ts > 0.0 {
                        let dt = now - prev_ts;
                        if dt > 1.0 {
                            dt_sec = (dt / 1000.0).clamp(0.0, 1.0) as f32;
                            let inst_fps = 1000.0 / dt;
                            sdr_fps.update(|prev| {
                                *prev = if *prev == 0.0 {
                                    inst_fps
                                } else {
                                    *prev * 0.75 + inst_fps * 0.25
                                };
                            });
                        }
                    }
                    last_frame_ts.set_value(now);

                    sdr_adc_clip.set(spec.adc_clip);
                    sdr_lo_div_active.set(spec.lo_div_active);
                    sdr_capture_truncated.set(spec.capture_truncated);

                    let invert = serial_transport
                        .with_value(|t| t.snapshot().transport != TransportKind::Demo);
                    let clear_peak = clear_next_peak.get_value();
                    if clear_peak {
                        clear_next_peak.set_value(false);
                    }
                    let opts = DspProcessOptions {
                        dc_notch: sdr_dc_notch.get_untracked(),
                        spur_blanker: sdr_spur_blanker.get_untracked(),
                        invert_spectrum: invert,
                        clear_peak_hold: clear_peak,
                        peak_decay_db_per_sec: sdr_peak_decay_db_per_sec.get_untracked(),
                        dt_sec,
                        ..Default::default()
                    };

                    sdr_trace.update(|prev| {
                        update_spectrum_traces_in_place(
                            prev,
                            &spec.power_dbfs,
                            spec.center_freq_mhz as f64,
                            spec.span_mhz,
                            opts,
                        );
                    });
                    latest_sdr_frame.set(Some(spec));
                    sdr_frame_version.update(|v| *v += 1);
                }
                DecodedFrame::SdrRawIq(iq) => {
                    sdr_adc_clip.set(iq.adc_clip);
                    sdr_lo_div_active.set(iq.lo_div_active);
                    raw_iq_frame.set(Some(iq));
                }
            }
        },
        |_| {},
    );
    let transport = session.transport;
    let identity = session.identity;
    let mismatch = session.mismatch;
    let flasher_mismatch = session.flasher_mismatch;

    // Re-send stream ctrl when DSP/FFT/FPS settings change while streaming
    Effect::new(move |_| {
        let streaming = sdr_streaming.get();
        let cont_iq = streaming_cont_iq.get();
        let conn = transport.get().status.is_active();
        let fft = sdr_fft_log2.get();
        let _mh = sdr_max_hold_detector.get();
        let _sw = sdr_sub_windows.get();
        let _dc = sdr_dc_notch.get();
        let _fps = sdr_target_fps.get();
        if streaming && !cont_iq && conn {
            send_sdr_stream_ctrl(SDR_STREAM_FFT, fft);
        }
    });

    let connected = Signal::derive(move || transport.get().status.is_active());
    let invert_spectrum = Signal::derive(move || transport.get().transport != TransportKind::Demo);
    let sdr_span_mhz =
        Signal::derive(move || resolve_sdr_rate_preset(sdr_rate_bw_code.get()).span_mhz);

    let on_connect = Callback::new(move |_| serial_transport.with_value(|t| t.connect_usb()));
    let on_disconnect = Callback::new(move |_| {
        if sdr_sweep_enabled.get_untracked() {
            sdr_sweep_enabled.set(false);
            let cmd = build_sdr_sweep_cfg_cmd(2400, 0, 4);
            serial_transport.with_value(|t| t.send_bytes(&cmd));
            let restored = sweep_saved_rate_code
                .get_value()
                .unwrap_or(sdr_rate_bw_code.get_untracked());
            sweep_saved_rate_code.set_value(None);
            sdr_rate_bw_code.set(restored);
        }
        if sdr_streaming.get_untracked() || streaming_cont_iq.get_untracked() {
            sdr_streaming.set(false);
            streaming_cont_iq.set(false);
            send_sdr_stream_ctrl(SDR_STREAM_STOP, sdr_fft_log2.get_untracked());
        }
        serial_transport.with_value(|t| t.disconnect());
    });
    let on_start_demo = Callback::new(move |_| serial_transport.with_value(|t| t.start_demo()));

    let on_toggle_sdr_stream = Callback::new(move |_| {
        if sdr_streaming.get_untracked() {
            sdr_streaming.set(false);
            streaming_cont_iq.set(false);
            if sdr_sweep_enabled.get_untracked() {
                sdr_sweep_enabled.set(false);
                let cmd = build_sdr_sweep_cfg_cmd(2400, 0, 4);
                serial_transport.with_value(|t| t.send_bytes(&cmd));
                let restored = sweep_saved_rate_code
                    .get_value()
                    .unwrap_or(sdr_rate_bw_code.get_untracked());
                sweep_saved_rate_code.set_value(None);
                sdr_rate_bw_code.set(restored);
                send_sdr_tune(
                    sdr_center_freq_mhz.get_untracked(),
                    restored,
                    sdr_gain_index.get_untracked(),
                );
            }
            send_sdr_stream_ctrl(SDR_STREAM_STOP, sdr_fft_log2.get_untracked());
        } else {
            resume_fft_stream();
        }
    });

    let on_center_freq_change = Callback::new(move |freq: u16| {
        let clamped = clamp_sdr_freq_mhz(freq as i32);
        sdr_center_freq_mhz.set(clamped);
        clear_next_peak.set_value(true);
        send_sdr_tune(
            clamped,
            sdr_rate_bw_code.get_untracked(),
            sdr_gain_index.get_untracked(),
        );
    });

    let on_rate_bw_change = Callback::new(move |code: u8| {
        sdr_rate_bw_code.set(code);
        clear_next_peak.set_value(true);
        send_sdr_tune(
            sdr_center_freq_mhz.get_untracked(),
            code,
            sdr_gain_index.get_untracked(),
        );
    });

    let on_gain_index_change = Callback::new(move |gain: u8| {
        sdr_gain_index.set(gain);
        send_sdr_tune(
            sdr_center_freq_mhz.get_untracked(),
            sdr_rate_bw_code.get_untracked(),
            gain,
        );
    });

    let on_clear_peak_hold = Callback::new(move |_| {
        clear_next_peak.set_value(true);
    });

    let on_toggle_sweep = Callback::new(move |_| {
        let next = !sdr_sweep_enabled.get_untracked();
        if next {
            let prev_rate = sdr_rate_bw_code.get_untracked();
            if prev_rate != 1 {
                sweep_saved_rate_code.set_value(Some(prev_rate));
            }
            sdr_rate_bw_code.set(1);
            sdr_sweep_enabled.set(true);
            send_sdr_tune(2400, 1, sdr_gain_index.get_untracked());
            let cmd = build_sdr_sweep_cfg_cmd(2400, 4, 4);
            serial_transport.with_value(|t| t.send_bytes(&cmd));
            if !sdr_streaming.get_untracked() {
                sdr_streaming.set(true);
                last_frame_ts.set_value(0.0);
                send_sdr_stream_ctrl(SDR_STREAM_FFT, sdr_fft_log2.get_untracked());
            }
        } else {
            sdr_sweep_enabled.set(false);
            let cmd = build_sdr_sweep_cfg_cmd(2400, 0, 4);
            serial_transport.with_value(|t| t.send_bytes(&cmd));
            let restored = sweep_saved_rate_code
                .get_value()
                .unwrap_or(sdr_rate_bw_code.get_untracked());
            sweep_saved_rate_code.set_value(None);
            sdr_rate_bw_code.set(restored);
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                restored,
                sdr_gain_index.get_untracked(),
            );
            clear_next_peak.set_value(true);
        }
    });

    let on_open_raw_iq = Callback::new(move |_| {
        raw_iq_open.set(true);
        let was_fft_streaming = sdr_streaming.get_untracked() && !streaming_cont_iq.get_untracked();
        if !streaming_cont_iq.get_untracked() {
            resume_fft_after_raw_iq.set_value(was_fft_streaming);
        }
        if transport.get_untracked().status.is_active() && !streaming_cont_iq.get_untracked() {
            sdr_streaming.set(false);
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                sdr_rate_bw_code.get_untracked(),
                sdr_gain_index.get_untracked(),
            );
            send_sdr_stream_ctrl(SDR_STREAM_SINGLE_IQ, raw_iq_kb.get_untracked());
        }
    });

    let on_close_raw_iq = Callback::new(move |_| {
        raw_iq_open.set(false);
        let resume = resume_fft_after_raw_iq.get_value();
        resume_fft_after_raw_iq.set_value(false);
        if streaming_cont_iq.get_untracked() {
            streaming_cont_iq.set(false);
            sdr_streaming.set(false);
            send_sdr_stream_ctrl(SDR_STREAM_STOP, raw_iq_kb.get_untracked());
        }
        if resume {
            resume_fft_stream();
        }
    });

    let on_request_single_iq = Callback::new(move |_| {
        if sdr_streaming.get_untracked() && !streaming_cont_iq.get_untracked() {
            resume_fft_after_raw_iq.set_value(true);
        }
        streaming_cont_iq.set(false);
        sdr_streaming.set(false);
        send_sdr_tune(
            sdr_center_freq_mhz.get_untracked(),
            sdr_rate_bw_code.get_untracked(),
            sdr_gain_index.get_untracked(),
        );
        send_sdr_stream_ctrl(SDR_STREAM_SINGLE_IQ, raw_iq_kb.get_untracked());
    });

    let on_toggle_cont_iq = Callback::new(move |_| {
        if streaming_cont_iq.get_untracked() {
            streaming_cont_iq.set(false);
            sdr_streaming.set(false);
            send_sdr_stream_ctrl(SDR_STREAM_STOP, raw_iq_kb.get_untracked());
            if resume_fft_after_raw_iq.get_value() {
                resume_fft_after_raw_iq.set_value(false);
                resume_fft_stream();
            }
        } else {
            if sdr_streaming.get_untracked() && !streaming_cont_iq.get_untracked() {
                resume_fft_after_raw_iq.set_value(true);
            }
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                sdr_rate_bw_code.get_untracked(),
                sdr_gain_index.get_untracked(),
            );
            streaming_cont_iq.set(true);
            sdr_streaming.set(true);
            send_sdr_stream_ctrl(SDR_STREAM_CONT_IQ, raw_iq_kb.get_untracked());
        }
    });

    let on_open_scanner = Callback::new(move |_| {
        scanner_open.set(true);
        if transport.get_untracked().status.is_active() {
            if sdr_sweep_enabled.get_untracked() {
                sdr_sweep_enabled.set(false);
                let cmd = build_sdr_sweep_cfg_cmd(2400, 0, 4);
                serial_transport.with_value(|t| t.send_bytes(&cmd));
                let sweep_rate = sweep_saved_rate_code
                    .get_value()
                    .unwrap_or(sdr_rate_bw_code.get_untracked());
                sweep_saved_rate_code.set_value(None);
                sdr_rate_bw_code.set(sweep_rate);
            }
            let cur_rate = sdr_rate_bw_code.get_untracked();
            if cur_rate != 1 {
                scanner_saved_rate_code.set_value(Some(cur_rate));
                sdr_rate_bw_code.set(1);
            }
            if !sdr_streaming.get_untracked() || streaming_cont_iq.get_untracked() {
                streaming_cont_iq.set(false);
                sdr_streaming.set(true);
                last_frame_ts.set_value(0.0);
                send_sdr_stream_ctrl(SDR_STREAM_FFT, sdr_fft_log2.get_untracked());
            }
        }
    });

    let on_close_scanner = Callback::new(move |_| {
        scanner_open.set(false);
        clear_next_peak.set_value(true);
        let restored = scanner_saved_rate_code
            .get_value()
            .unwrap_or(sdr_rate_bw_code.get_untracked());
        scanner_saved_rate_code.set_value(None);
        sdr_rate_bw_code.set(restored);
        if transport.get_untracked().status.is_active() {
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                restored,
                sdr_gain_index.get_untracked(),
            );
        }
    });

    let on_request_scan_step = Callback::new(move |freq_mhz: u16| {
        send_sdr_tune(freq_mhz, 1, sdr_gain_index.get_untracked());
    });

    let on_tune_and_inspect = Callback::new(move |freq_mhz: u16| {
        let clamped = clamp_sdr_freq_mhz(freq_mhz as i32);
        scanner_open.set(false);
        sdr_center_freq_mhz.set(clamped);
        clear_next_peak.set_value(true);
        let restored = scanner_saved_rate_code
            .get_value()
            .unwrap_or(sdr_rate_bw_code.get_untracked());
        scanner_saved_rate_code.set_value(None);
        sdr_rate_bw_code.set(restored);
        send_sdr_tune(clamped, restored, sdr_gain_index.get_untracked());
    });

    let on_toggle_drawer = Callback::new(move |_| drawer_open.update(|o| *o = !*o));
    let on_close_drawer = Callback::new(move |_| drawer_open.set(false));
    let on_open_flasher_from_mismatch = Callback::new(move |_| {
        mismatch.set(None);
        drawer_open.set(true);
    });

    view! {
        <HotWireTheme />
        <div class=move || {
            if mobile_controls_open.get() {
                "app-shell sdr-mobile-controls-open"
            } else {
                "app-shell"
            }
        }>
            <TopToolbar
                transport=transport
                identity=identity
                on_connect=on_connect
                on_disconnect=on_disconnect
                on_start_demo=on_start_demo
                sdr_streaming=sdr_streaming
                on_toggle_sdr_stream=on_toggle_sdr_stream
                drawer_open=drawer_open
                on_toggle_drawer=on_toggle_drawer
            />

            <main class="main-workspace sdr-only-workspace">
                <SdrControlBar
                    connected=connected
                    mobile_controls_open=mobile_controls_open
                    center_freq_mhz=sdr_center_freq_mhz
                    on_center_freq_change=on_center_freq_change
                    rate_bw_code=sdr_rate_bw_code
                    on_rate_bw_change=on_rate_bw_change
                    fft_log2=sdr_fft_log2
                    target_fps=sdr_target_fps
                    max_hold_detector=sdr_max_hold_detector
                    sub_windows=sdr_sub_windows
                    dc_notch=sdr_dc_notch
                    spur_blanker=sdr_spur_blanker
                    peak_decay_db_per_sec=sdr_peak_decay_db_per_sec
                    on_clear_peak_hold=on_clear_peak_hold
                    sweep_enabled=sdr_sweep_enabled
                    on_toggle_sweep=on_toggle_sweep
                    gain_index=sdr_gain_index
                    on_gain_index_change=on_gain_index_change
                    adc_clip=sdr_adc_clip
                    lo_div_active=sdr_lo_div_active
                    capture_truncated=sdr_capture_truncated
                    on_open_raw_iq=on_open_raw_iq
                    on_open_scanner=on_open_scanner
                />
                <SdrSpectrumWaterfall
                    trace=sdr_trace
                    center_freq_mhz=sdr_center_freq_mhz
                    span_mhz=sdr_span_mhz
                    fps=sdr_fps
                    streaming=sdr_streaming
                    frame_version=sdr_frame_version
                />
            </main>

            <RawIqInspector
                open=raw_iq_open
                on_close=on_close_raw_iq
                frame=raw_iq_frame
                iq_kb=raw_iq_kb
                max_iq_kb=max_iq_kb
                streaming_cont_iq=streaming_cont_iq
                on_request_single_shot=on_request_single_iq
                on_toggle_cont_iq=on_toggle_cont_iq
            />

            <WidebandScannerModal
                open=scanner_open
                on_close=on_close_scanner
                connected=connected
                latest_frame=latest_sdr_frame
                frame_version=sdr_frame_version
                invert_spectrum=invert_spectrum
                on_request_scan_step=on_request_scan_step
                on_tune_and_inspect=on_tune_and_inspect
            />

            <BottomDrawer
                open=drawer_open
                on_close=on_close_drawer
                identity=identity
                mismatch=flasher_mismatch
                serial_transport=serial_transport
            />

            <FirmwareMismatchModal
                mismatch=mismatch
                on_open_flasher=on_open_flasher_from_mismatch
            />
        </div>
    }
}
