use leptos::prelude::*;

use crate::protocol::types::BoardCapabilitiesFrame;
use crate::transport::serial::{ConnectionStatus, TransportKind, TransportSnapshot};

#[component]
pub fn TopToolbar(
    transport: RwSignal<TransportSnapshot>,
    caps: RwSignal<Option<BoardCapabilitiesFrame>>,
    on_connect: Callback<()>,
    on_disconnect: Callback<()>,
    on_start_demo: Callback<()>,
    sdr_streaming: RwSignal<bool>,
    on_toggle_sdr_stream: Callback<()>,
    drawer_open: RwSignal<bool>,
    on_toggle_drawer: Callback<()>,
) -> impl IntoView {
    let is_connected = move || transport.get().status == ConnectionStatus::Connected;
    let is_connecting = move || transport.get().status == ConnectionStatus::Connecting;

    let status_class = move || format!("status-pill status-{}", transport.get().status.as_class());
    let status_title = move || {
        let t = transport.get();
        t.error_message.unwrap_or(t.device_name)
    };
    let status_label = move || {
        let t = transport.get();
        if t.status == ConnectionStatus::Connected {
            if let Some(c) = caps.get() {
                if t.transport == TransportKind::Demo {
                    format!("{} (Demo)", c.board)
                } else {
                    c.board
                }
            } else {
                t.device_name
            }
        } else if t.status == ConnectionStatus::Connecting {
            "Connecting...".to_string()
        } else {
            "Disconnected".to_string()
        }
    };

    view! {
        <header class="top-toolbar">
            <div class="toolbar-row">
                <div class="brand-cluster">
                    <div class="brand-logo" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="20" height="20">
                            <path
                                d="M2 12h4l2.5-6 3 12 3-9 2 3H22"
                                fill="none"
                                stroke="#38bdf8"
                                stroke-width="2.2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />
                        </svg>
                    </div>
                    <div class="brand-text">
                        <span class="brand-title">"HotWire SDR"</span>
                        <span class="brand-badge">"1.8–2.8 GHz · Rust"</span>
                    </div>
                </div>

                <div class=status_class title=status_title>
                    <span class="status-dot" />
                    <span class="status-label">{status_label}</span>
                    {move || {
                        let t = transport.get();
                        if t.status == ConnectionStatus::Connected && !t.vid_pid.is_empty() {
                            Some(view! { <span class="status-vidpid">{t.vid_pid}</span> })
                        } else {
                            None
                        }
                    }}
                </div>

                <div class="control-spacer" />

                <div class="action-cluster">
                    <button
                        type="button"
                        class=move || {
                            if sdr_streaming.get() {
                                "btn btn-stream btn-danger"
                            } else {
                                "btn btn-stream btn-accent"
                            }
                        }
                        on:click=move |_| on_toggle_sdr_stream.run(())
                        disabled=move || !is_connected()
                        title=move || {
                            if sdr_streaming.get() {
                                "Halt live RF streaming"
                            } else {
                                "Start live RF spectrum streaming"
                            }
                        }
                    >
                        <span class="btn-icon" aria-hidden="true">
                            {move || if sdr_streaming.get() { "⏹" } else { "▶" }}
                        </span>
                        <span>{move || if sdr_streaming.get() { "Stop RF" } else { "Start RF" }}</span>
                    </button>

                    <Show
                        when=move || !is_connected()
                        fallback=move || {
                            view! {
                                <button
                                    type="button"
                                    class="btn btn-secondary"
                                    on:click=move |_| on_disconnect.run(())
                                >
                                    "Disconnect"
                                </button>
                            }
                        }
                    >
                        <button
                            type="button"
                            class="btn btn-primary"
                            on:click=move |_| on_connect.run(())
                            disabled=is_connecting
                        >
                            "Connect USB"
                        </button>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            on:click=move |_| on_start_demo.run(())
                            disabled=is_connecting
                        >
                            "Demo"
                        </button>
                    </Show>

                    <button
                        type="button"
                        class=move || {
                            if drawer_open.get() { "btn btn-ghost active" } else { "btn btn-ghost" }
                        }
                        on:click=move |_| on_toggle_drawer.run(())
                        title="Open XIAO ESP32-S3 / ESP32-C6 Web Flasher (esptool-js)"
                    >
                        "Web Flasher"
                    </button>
                </div>
            </div>

            {move || {
                transport.get().error_message.map(|err| {
                    view! {
                        <div class="toolbar-error-banner" role="alert">
                            <span>{err}</span>
                        </div>
                    }
                })
            }}
        </header>
    }
}
