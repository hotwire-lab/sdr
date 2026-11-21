use hotwire_core::protocol::{BoardIdentity, FirmwareMismatch, ToolId};
use hotwire_core::transport::HandshakeGuard;
use hotwire_core::ui::{FirmwareMismatchModal, HotWireTheme};
use leptos::prelude::*;

use crate::components::bottom_drawer::BottomDrawer;
use crate::components::raw_iq_inspector::RawIqInspector;
use crate::components::sdr_control_bar::SdrControlBar;
use crate::components::sdr_spectrum_waterfall::SdrSpectrumWaterfall;
use crate::components::top_toolbar::TopToolbar;
use crate::components::wideband_scanner_modal::WidebandScannerModal;
use crate::dsp::sdr_dsp::{
    update_spectrum_traces_in_place, DspProcessOptions, SpectrumTraceState,
};
use crate::protocol::codec::{
    build_sdr_stream_ctrl_cmd, build_sdr_sweep_cfg_cmd, build_sdr_tune_cmd, clamp_sdr_freq_mhz,
    resolve_sdr_rate_preset,
};
use crate::protocol::demuxer::ProtocolDemuxer;
use crate::protocol::types::{
    DecodedFrame, SdrRawIqFrame, SdrSpectrumFrame, SDR_DSP_FLAG_DC_CANCEL, SDR_DSP_FLAG_MAX_HOLD,
    SDR_STREAM_CONT_IQ, SDR_STREAM_FFT, SDR_STREAM_SINGLE_IQ, SDR_STREAM_STOP,
};
use crate::transport::serial::{create_sdr_transport, TransportKind, TransportSnapshot};

fn perf_now() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0)
}

#[component]
pub fn App() -> impl IntoView {
    let serial_transport = StoredValue::new_local(create_sdr_transport());

    let transport = RwSignal::new(serial_transport.with_value(|t| t.snapshot()));
    let identity = RwSignal::new(None::<BoardIdentity>);
    let mismatch = RwSignal::new(None::<FirmwareMismatch>);
    let flasher_mismatch = RwSignal::new(None::<FirmwareMismatch>);
    let handshake_guard = StoredValue::new_local(HandshakeGuard::new(ToolId::Sdr));

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

    let clear_next_peak = StoredValue::new(false);
    let last_frame_ts = StoredValue::new(0.0f64);
    let demuxer = StoredValue::new_local(ProtocolDemuxer::new());

    // Initialize transport listeners
    serial_transport.with_value(|st| {
        st.init(
            move |snap: TransportSnapshot| {
                let disconnected = !snap.status.is_active();
                let is_usb = snap.status.is_usb_connected();
                let dev_name = snap.device_name.clone();
                transport.set(snap);
                if disconnected {
                    handshake_guard.update_value(|g| g.cancel());
                    sdr_streaming.set(false);
                    streaming_cont_iq.set(false);
                    identity.set(None);
                    demuxer.update_value(|d| d.reset());
                } else if is_usb {
                    mismatch.set(None);
                    flasher_mismatch.set(None);
                    handshake_guard.update_value(|g| {
                        g.arm_timeout(dev_name, 5000, move |mm| {
                            mismatch.set(Some(mm.clone()));
                            flasher_mismatch.set(Some(mm));
                            serial_transport.with_value(|t| t.disconnect());
                        });
                    });
                } else {
                    handshake_guard.update_value(|g| g.cancel());
                    mismatch.set(None);
                    flasher_mismatch.set(None);
                }
            },
            move |bytes: &[u8]| {
                demuxer.update_value(|d| {
                    d.feed(
                        bytes,
                        |frame| match frame {
                            DecodedFrame::Capabilities(id, _c) => {
                                serial_transport.with_value(|t| t.notify_handshake_ok());
                                if transport.get_untracked().status.is_usb_connected() {
                                    let mut verdict = Ok(());
                                    handshake_guard.update_value(|g| {
                                        verdict = g.verify(&id);
                                    });
                                    if let Err(mm) = verdict {
                                        mismatch.set(Some(mm.clone()));
                                        flasher_mismatch.set(Some(mm));
                                        serial_transport.with_value(|t| t.disconnect());
                                        return;
                                    }
                                } else {
                                    handshake_guard.update_value(|g| g.cancel());
                                }
                                mismatch.set(None);
                                flasher_mismatch.set(None);
                                identity.set(Some(id));
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

                                let invert =
                                    transport.get_untracked().transport != TransportKind::Demo;
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
                        },
                        |_| {},
                    );
                });
            },
        );
    });

    let send_sdr_tune = move |freq_mhz: u16, bw_code: u8, gain: u8| {
        if !transport.get_untracked().status.is_active() {
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
        if !transport.get_untracked().status.is_active() {
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
    let invert_spectrum =
        Signal::derive(move || transport.get().transport != TransportKind::Demo);
    let sdr_span_mhz =
        Signal::derive(move || resolve_sdr_rate_preset(sdr_rate_bw_code.get()).span_mhz);

    let on_connect = Callback::new(move |_| serial_transport.with_value(|t| t.connect_usb()));
    let on_disconnect = Callback::new(move |_| {
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
            send_sdr_stream_ctrl(SDR_STREAM_STOP, sdr_fft_log2.get_untracked());
        } else {
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                sdr_rate_bw_code.get_untracked(),
                sdr_gain_index.get_untracked(),
            );
            sdr_streaming.set(true);
            streaming_cont_iq.set(false);
            last_frame_ts.set_value(0.0);
            send_sdr_stream_ctrl(SDR_STREAM_FFT, sdr_fft_log2.get_untracked());
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
        sdr_sweep_enabled.set(next);
        if transport.get_untracked().status.is_active() {
            let cmd = build_sdr_sweep_cfg_cmd(2400, if next { 4 } else { 0 }, 4);
            serial_transport.with_value(|t| t.send_bytes(&cmd));
        }
    });

    let on_open_raw_iq = Callback::new(move |_| {
        raw_iq_open.set(true);
        if transport.get_untracked().status.is_active()
            && raw_iq_frame.get_untracked().is_none()
        {
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
        if streaming_cont_iq.get_untracked() {
            streaming_cont_iq.set(false);
            sdr_streaming.set(false);
            send_sdr_stream_ctrl(SDR_STREAM_STOP, raw_iq_kb.get_untracked());
        }
    });

    let on_request_single_iq = Callback::new(move |_| {
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
        } else {
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
            if sdr_rate_bw_code.get_untracked() != 1 {
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
        if transport.get_untracked().status.is_active() {
            send_sdr_tune(
                sdr_center_freq_mhz.get_untracked(),
                sdr_rate_bw_code.get_untracked(),
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
        send_sdr_tune(
            clamped,
            sdr_rate_bw_code.get_untracked(),
            sdr_gain_index.get_untracked(),
        );
    });

    let on_toggle_drawer = Callback::new(move |_| drawer_open.update(|o| *o = !*o));
    let on_close_drawer = Callback::new(move |_| drawer_open.set(false));
    let on_open_flasher_from_mismatch = Callback::new(move |_| {
        mismatch.set(None);
        drawer_open.set(true);
    });

    view! {
        <HotWireTheme />
        <div class="app-shell">
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
