use hotwire_core::protocol::build_get_caps_cmd;
pub use hotwire_core::transport::{
    HotWireTransport as SerialTransport, SerialConfig, TransportKind, TransportSnapshot,
};

use crate::protocol::codec::build_sdr_stream_ctrl_cmd;
use crate::protocol::types::SDR_STREAM_STOP;
use crate::transport::demo::DemoSimulator;

pub fn create_sdr_transport() -> SerialTransport {
    let transport = SerialTransport::with_demo(
        SerialConfig::hotwire_cdc("hotwire_sdr_last_device"),
        DemoSimulator::new(),
    );
    // Silence any previously active RF stream before requesting 0x83 capabilities
    let mut init_cmds = Vec::with_capacity(16);
    init_cmds.extend_from_slice(&build_sdr_stream_ctrl_cmd(SDR_STREAM_STOP, 10, 0, 20));
    init_cmds.extend_from_slice(&build_get_caps_cmd());
    transport.set_init_commands(init_cmds);
    transport
}
