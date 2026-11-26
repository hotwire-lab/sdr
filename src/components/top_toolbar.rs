use hotwire_core::protocol::{BoardIdentity, ToolId};
use hotwire_core::ui::HotWireToolbar;
use leptos::prelude::*;

use crate::transport::serial::TransportSnapshot;

#[component]
pub fn TopToolbar(
    transport: RwSignal<TransportSnapshot>,
    identity: RwSignal<Option<BoardIdentity>>,
    on_connect: Callback<()>,
    on_disconnect: Callback<()>,
    on_start_demo: Callback<()>,
    sdr_streaming: RwSignal<bool>,
    on_toggle_sdr_stream: Callback<()>,
    drawer_open: RwSignal<bool>,
    on_toggle_drawer: Callback<()>,
) -> impl IntoView {
    let is_active = move || transport.get().status.is_active();

    view! {
        <HotWireToolbar
            active_tool=ToolId::Sdr
            subtitle="1.8–2.8 GHz · Rust/WASM"
            transport=transport
            identity=identity
            on_connect=on_connect
            on_disconnect=on_disconnect
            on_start_demo=on_start_demo
            flasher_open=drawer_open
            on_toggle_flasher=on_toggle_drawer
            app_version=env!("CARGO_PKG_VERSION")
        >
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
                disabled=move || !is_active()
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
        </HotWireToolbar>
    }
}
