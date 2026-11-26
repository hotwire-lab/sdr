use hotwire_core::flasher::{FirmwareProfile, FlasherPanel};
use hotwire_core::protocol::{BoardIdentity, FirmwareMismatch, ToolId};
use hotwire_core::ui::BottomSheet;
use leptos::prelude::*;

use crate::transport::serial::SerialTransport;

fn sdr_firmware_profiles() -> Vec<FirmwareProfile> {
    FirmwareProfile::standard_profiles(ToolId::Sdr)
}

#[component]
pub fn BottomDrawer(
    open: RwSignal<bool>,
    on_close: Callback<()>,
    identity: RwSignal<Option<BoardIdentity>>,
    mismatch: RwSignal<Option<FirmwareMismatch>>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
) -> impl IntoView {
    view! {
        <BottomSheet
            open=open
            on_close=on_close
            title="⚡ XIAO ESP32-S3 / ESP32-C6 SDR Web Flasher"
        >
            <div class="drawer-col">
                <h4>"Web Flasher"</h4>
                <FlasherPanel
                    profiles=sdr_firmware_profiles()
                    transport=serial_transport
                    expected_tool=ToolId::Sdr
                    identity=identity
                    mismatch=mismatch
                />
            </div>

            <div class="drawer-col">
                <h4>"RF Hardware & Antenna Notes"</h4>
                <p class="hw-flash-hint">
                    "Connect an external 2.4 GHz U.FL antenna to the XIAO ESP32-S3 or ESP32-C6 before running wideband RF sweeps. Frequencies below 2210 MHz automatically engage the 5/6 LO divider (DECT EU, 13cm Ham)."
                </p>
                <p class="hw-flash-hint">
                    "If the browser cannot re-open the port after flashing, hold BOOT, tap RESET, release BOOT, and click \"Select Other Port\"."
                </p>
            </div>
        </BottomSheet>
    }
}
