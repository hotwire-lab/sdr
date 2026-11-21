use leptos::html;
use leptos::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;

use crate::protocol::types::BoardCapabilitiesFrame;
use crate::transport::serial::SerialTransport;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoardId {
    Esp32S3,
    Esp32C6,
}

impl BoardId {
    fn as_str(&self) -> &'static str {
        match self {
            BoardId::Esp32S3 => "esp32s3",
            BoardId::Esp32C6 => "esp32c6",
        }
    }

    fn from_str(s: &str) -> Self {
        if s == "esp32c6" {
            BoardId::Esp32C6
        } else {
            BoardId::Esp32S3
        }
    }

    fn label(&self) -> &'static str {
        match self {
            BoardId::Esp32S3 => "Seeed Studio XIAO ESP32-S3",
            BoardId::Esp32C6 => "Seeed Studio XIAO ESP32-C6",
        }
    }

    fn prefix(&self) -> &'static str {
        match self {
            BoardId::Esp32S3 => "HotWire_SDR_XIAO_ESP32S3.ino",
            BoardId::Esp32C6 => "HotWire_SDR_XIAO_ESP32C6.ino",
        }
    }

    fn flash_size(&self) -> &'static str {
        match self {
            BoardId::Esp32S3 => "8MB",
            BoardId::Esp32C6 => "4MB",
        }
    }

    fn hint(&self) -> &'static str {
        match self {
            BoardId::Esp32S3 => "1.84–2.79 GHz RF Spectrum Analyzer",
            BoardId::Esp32C6 => "1.84–2.79 GHz RF Spectrum Analyzer (External U.FL Antenna)",
        }
    }
}

#[component]
pub fn BottomDrawer(
    open: RwSignal<bool>,
    on_close: Callback<()>,
    caps: RwSignal<Option<BoardCapabilitiesFrame>>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
) -> impl IntoView {
    let selected_board = RwSignal::new(BoardId::Esp32S3);
    let flash_logs = RwSignal::new(Vec::<String>::new());
    let flash_progress = RwSignal::new(0u32);
    let flashing = RwSignal::new(false);
    let flash_error = RwSignal::new(None::<String>);
    let show_custom_bin = RwSignal::new(false);
    let selected_file_name = RwSignal::new(None::<String>);
    let selected_file = StoredValue::new_local(None::<web_sys::File>);
    let flash_offset = RwSignal::new("full".to_string());
    let log_div_ref = NodeRef::<html::Div>::new();

    Effect::new(move |_| {
        if let Some(c) = caps.get() {
            let upper = c.board.to_uppercase();
            if upper.contains("C6") {
                selected_board.set(BoardId::Esp32C6);
            } else if upper.contains("S3") {
                selected_board.set(BoardId::Esp32S3);
            }
        }
    });

    Effect::new(move |_| {
        let _ = flash_logs.get();
        if let Some(div) = log_div_ref.get() {
            div.set_scroll_top(div.scroll_height());
        }
    });

    let start_flash = move |force_other_port: bool| {
        if flashing.get_untracked() {
            return;
        }
        flashing.set(true);
        flash_error.set(None);
        flash_progress.set(0);
        flash_logs.set(Vec::new());

        let board = selected_board.get_untracked().as_str().to_string();
        let offset = flash_offset.get_untracked();
        let file = selected_file.get_value();
        let transport = serial_transport.get_value();

        spawn_local(async move {
            let res = transport
                .flash_firmware(
                    &board,
                    force_other_port,
                    &offset,
                    file.as_ref(),
                    move |line| {
                        flash_logs.update(|logs| {
                            logs.push(line);
                            if logs.len() > 140 {
                                let drain = logs.len() - 140;
                                logs.drain(0..drain);
                            }
                        });
                    },
                    move |pct| {
                        flash_progress.set(pct);
                    },
                )
                .await;

            if let Err(msg) = res {
                flash_error.set(Some(format!(
                    "{msg} (If USB re-enumerated, hold BOOT + tap RESET and click \"Select Port & Flash\")"
                )));
                flash_logs.update(|logs| logs.push(format!("ERROR: {msg}")));
            }
            flashing.set(false);
        });
    };

    view! {
        <Show when=move || open.get()>
            <section class="bottom-drawer" aria-label="XIAO ESP32 Web Flasher">
                <div class="drawer-header">
                    <div class="drawer-tabs">
                        <span class="drawer-title">"Web Flasher"</span>
                        <span class="flasher-board-badge">
                            {move || {
                                let b = selected_board.get();
                                format!("{} • {}", b.label(), b.flash_size())
                            }}
                        </span>
                    </div>

                    <span class="flasher-hint">
                        {move || {
                            if let Some(c) = caps.get() {
                                format!("Connected: {} ({})", c.board, c.firmware)
                            } else {
                                selected_board.get().hint().to_string()
                            }
                        }}
                    </span>

                    <button type="button" class="btn-mini" on:click=move |_| on_close.run(())>
                        "Hide"
                    </button>
                </div>

                <div class="drawer-body">
                    <div class="flasher-pane">
                        <div class="flasher-controls">
                            <div class="control-group">
                                <label for="flash-board">"Board"</label>
                                <select
                                    id="flash-board"
                                    prop:value=move || selected_board.get().as_str()
                                    disabled=move || flashing.get()
                                    on:change=move |ev| {
                                        selected_board.set(BoardId::from_str(&event_target_value(&ev)));
                                    }
                                >
                                    <option value="esp32s3">"XIAO ESP32-S3 (8MB)"</option>
                                    <option value="esp32c6">"XIAO ESP32-C6 (4MB)"</option>
                                </select>
                            </div>

                            <button
                                type="button"
                                class="btn btn-accent"
                                on:click=move |_| start_flash(false)
                                disabled=move || flashing.get()
                            >
                                {move || {
                                    if flashing.get() {
                                        format!("Flashing {}%...", flash_progress.get())
                                    } else {
                                        "Flash Firmware".to_string()
                                    }
                                }}
                            </button>

                            <button
                                type="button"
                                class="btn btn-secondary btn-compact"
                                disabled=move || flashing.get()
                                on:click=move |_| start_flash(true)
                                title="Choose a specific COM/USB serial port manually"
                            >
                                "Select Port & Flash..."
                            </button>

                            <button
                                type="button"
                                class=move || {
                                    if show_custom_bin.get() {
                                        "btn btn-secondary btn-compact active"
                                    } else {
                                        "btn btn-secondary btn-compact"
                                    }
                                }
                                disabled=move || flashing.get()
                                on:click=move |_| {
                                    let next = !show_custom_bin.get_untracked();
                                    show_custom_bin.set(next);
                                    if !next {
                                        selected_file.set_value(None);
                                        selected_file_name.set(None);
                                        flash_offset.set("full".to_string());
                                    }
                                }
                            >
                                "Custom .bin..."
                            </button>

                            <Show when=move || show_custom_bin.get()>
                                <div class="control-group">
                                    <label for="flash-offset">"Target Image"</label>
                                    <select
                                        id="flash-offset"
                                        prop:value=move || flash_offset.get()
                                        disabled=move || flashing.get()
                                        on:change=move |ev| flash_offset.set(event_target_value(&ev))
                                    >
                                        <option value="full">"Bundled Full Image (Boot + Partitions + App)"</option>
                                        <option value="0x10000">"App Firmware @ 0x10000"</option>
                                        <option value="0x0">"Merged .bin @ 0x0"</option>
                                    </select>
                                </div>

                                <label class="file-picker-label">
                                    <span>
                                        {move || {
                                            selected_file_name.get().unwrap_or_else(|| {
                                                format!("Choose .bin ({})", selected_board.get().prefix())
                                            })
                                        }}
                                    </span>
                                    <input
                                        type="file"
                                        accept=".bin"
                                        disabled=move || flashing.get()
                                        on:change=move |ev| {
                                            let input = ev
                                                .target()
                                                .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                            let file = input
                                                .and_then(|i| i.files())
                                                .and_then(|fl| fl.get(0));
                                            if let Some(f) = file {
                                                selected_file_name.set(Some(f.name()));
                                                selected_file.set_value(Some(f));
                                                if flash_offset.get_untracked() == "full" {
                                                    flash_offset.set("0x10000".to_string());
                                                }
                                            } else {
                                                selected_file_name.set(None);
                                                selected_file.set_value(None);
                                            }
                                        }
                                    />
                                </label>

                                <Show when=move || selected_file_name.get().is_some()>
                                    <button
                                        type="button"
                                        class="btn btn-secondary btn-compact"
                                        disabled=move || flashing.get()
                                        on:click=move |_| {
                                            selected_file.set_value(None);
                                            selected_file_name.set(None);
                                        }
                                    >
                                        "Use Bundled"
                                    </button>
                                </Show>
                            </Show>
                        </div>

                        <Show when=move || flashing.get()>
                            <div class="flash-progress-track" aria-label="Flashing progress">
                                <div
                                    class="flash-progress-fill"
                                    style=move || format!("width: {}%", flash_progress.get())
                                />
                            </div>
                        </Show>

                        {move || {
                            flash_error
                                .get()
                                .map(|err| view! { <div class="flasher-error">{err}</div> })
                        }}

                        <div class="flasher-log" node_ref=log_div_ref>
                            {move || {
                                let logs = flash_logs.get();
                                if logs.is_empty() {
                                    view! {
                                        <div class="flasher-placeholder">
                                            "Select your board and click Flash Firmware to program bundled SDR binaries directly from your browser via Web Serial / WebUSB."
                                        </div>
                                    }
                                    .into_any()
                                } else {
                                    logs.into_iter()
                                        .map(|line| {
                                            let text = if line.is_empty() {
                                                "\u{00a0}".to_string()
                                            } else {
                                                line
                                            };
                                            view! { <div>{text}</div> }
                                        })
                                        .collect_view()
                                        .into_any()
                                }
                            }}
                        </div>
                    </div>
                </div>
            </section>
        </Show>
    }
}
