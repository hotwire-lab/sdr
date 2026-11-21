pub use hotwire_core::transport::{
    HotWireTransport as SerialTransport, SerialConfig, TransportKind, TransportSnapshot,
};

use crate::transport::demo::DemoSimulator;

pub fn create_sdr_transport() -> SerialTransport {
    SerialTransport::with_demo(
        SerialConfig::hotwire_cdc("hotwire_sdr_last_device"),
        DemoSimulator::new(),
    )
}
