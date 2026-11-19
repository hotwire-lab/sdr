use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::protocol::codec::{build_bootloader_cmd, build_get_caps_cmd, build_ping_status_cmd};
use crate::transport::demo::DemoSimulator;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    None,
    WebSerial,
    WebUsb,
    Demo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Waiting,
    Connecting,
    Connected,
}

impl ConnectionStatus {
    pub fn as_class(&self) -> &'static str {
        match self {
            ConnectionStatus::Waiting => "waiting",
            ConnectionStatus::Connecting => "connecting",
            ConnectionStatus::Connected => "connected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSnapshot {
    pub status: ConnectionStatus,
    pub transport: TransportKind,
    pub device_name: String,
    pub vid_pid: String,
    pub error_message: Option<String>,
}

impl Default for TransportSnapshot {
    fn default() -> Self {
        Self {
            status: ConnectionStatus::Waiting,
            transport: TransportKind::None,
            device_name: "Waiting for USB...".to_string(),
            vid_pid: String::new(),
            error_message: None,
        }
    }
}

#[wasm_bindgen(module = "/js/web_serial_bridge.js")]
extern "C" {
    fn js_init_transport(on_state: &js_sys::Function, on_bytes: &js_sys::Function, init_cmds: &[u8]);
    fn js_connect_usb(init_cmds: &[u8]) -> js_sys::Promise;
    fn js_disconnect_usb() -> js_sys::Promise;
    fn js_write_bytes(bytes: &[u8]) -> js_sys::Promise;
    fn js_flash_firmware(
        board_id: &str,
        force_other_port: bool,
        flash_offset: &str,
        custom_file: Option<&web_sys::File>,
        bootloader_cmd: &[u8],
        init_cmds: &[u8],
        on_log: &js_sys::Function,
        on_progress: &js_sys::Function,
    ) -> js_sys::Promise;
}

fn init_command_bytes() -> Vec<u8> {
    let mut cmds = Vec::with_capacity(16);
    cmds.extend_from_slice(&build_get_caps_cmd());
    cmds.extend_from_slice(&build_ping_status_cmd());
    cmds
}

type StateCallback = Rc<RefCell<Option<Box<dyn FnMut(TransportSnapshot)>>>>;
type BytesCallback = Rc<RefCell<Option<Box<dyn FnMut(&[u8])>>>>;

#[derive(Clone)]
pub struct SerialTransport {
    snapshot: Rc<RefCell<TransportSnapshot>>,
    demo: Rc<RefCell<DemoSimulator>>,
    demo_timer_id: Rc<RefCell<Option<i32>>>,
    demo_closure: Rc<RefCell<Option<Closure<dyn FnMut()>>>>,
    on_state: StateCallback,
    on_bytes: BytesCallback,
    _js_closures: Rc<RefCell<Vec<Closure<dyn FnMut(JsValue)>>>>,
}

impl Default for SerialTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialTransport {
    pub fn new() -> Self {
        Self {
            snapshot: Rc::new(RefCell::new(TransportSnapshot::default())),
            demo: Rc::new(RefCell::new(DemoSimulator::new())),
            demo_timer_id: Rc::new(RefCell::new(None)),
            demo_closure: Rc::new(RefCell::new(None)),
            on_state: Rc::new(RefCell::new(None)),
            on_bytes: Rc::new(RefCell::new(None)),
            _js_closures: Rc::new(RefCell::new(Vec::new())),
        }
    }

    pub fn snapshot(&self) -> TransportSnapshot {
        self.snapshot.borrow().clone()
    }

    pub fn init<FS, FB>(&self, on_state: FS, on_bytes: FB)
    where
        FS: FnMut(TransportSnapshot) + 'static,
        FB: FnMut(&[u8]) + 'static,
    {
        *self.on_state.borrow_mut() = Some(Box::new(on_state));
        *self.on_bytes.borrow_mut() = Some(Box::new(on_bytes));

        let snap_ref = self.snapshot.clone();
        let on_state_ref = self.on_state.clone();
        let js_state_cb = Closure::<dyn FnMut(String, String, String, String, String)>::new(
            move |status_s: String,
                  transport_s: String,
                  device_name: String,
                  vid_pid: String,
                  error_s: String| {
                let status = match status_s.as_str() {
                    "connected" => ConnectionStatus::Connected,
                    "connecting" => ConnectionStatus::Connecting,
                    _ => ConnectionStatus::Waiting,
                };
                let transport = match transport_s.as_str() {
                    "webserial" => TransportKind::WebSerial,
                    "webusb" => TransportKind::WebUsb,
                    "demo" => TransportKind::Demo,
                    _ => TransportKind::None,
                };
                let snap = TransportSnapshot {
                    status,
                    transport,
                    device_name,
                    vid_pid,
                    error_message: if error_s.is_empty() { None } else { Some(error_s) },
                };
                *snap_ref.borrow_mut() = snap.clone();
                if let Some(cb) = on_state_ref.borrow_mut().as_mut() {
                    cb(snap);
                }
            },
        );

        let on_bytes_ref = self.on_bytes.clone();
        let js_bytes_cb = Closure::<dyn FnMut(js_sys::Uint8Array)>::new(move |arr: js_sys::Uint8Array| {
            let data = arr.to_vec();
            if let Some(cb) = on_bytes_ref.borrow_mut().as_mut() {
                cb(&data);
            }
        });

        let init_cmds = init_command_bytes();
        js_init_transport(
            js_state_cb.as_ref().unchecked_ref(),
            js_bytes_cb.as_ref().unchecked_ref(),
            &init_cmds,
        );

        // Keep closures alive for the lifetime of the app
        js_state_cb.forget();
        js_bytes_cb.forget();
    }

    pub fn connect(&self) {
        self.stop_demo_timer();
        let init_cmds = init_command_bytes();
        let promise = js_connect_usb(&init_cmds);
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub fn disconnect(&self) {
        self.stop_demo_timer();
        let kind = self.snapshot.borrow().transport;
        if kind == TransportKind::Demo {
            let snap = TransportSnapshot::default();
            *self.snapshot.borrow_mut() = snap.clone();
            if let Some(cb) = self.on_state.borrow_mut().as_mut() {
                cb(snap);
            }
            return;
        }
        let promise = js_disconnect_usb();
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub fn start_demo(&self) {
        self.stop_demo_timer();
        let promise = js_disconnect_usb();
        let this = self.clone();
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
            this.demo.borrow_mut().reset();
            let snap = TransportSnapshot {
                status: ConnectionStatus::Connected,
                transport: TransportKind::Demo,
                device_name: "HotWire SDR (Demo Simulator)".to_string(),
                vid_pid: "303A:1001".to_string(),
                error_message: None,
            };
            *this.snapshot.borrow_mut() = snap.clone();
            if let Some(cb) = this.on_state.borrow_mut().as_mut() {
                cb(snap);
            }
            let caps = this.demo.borrow().build_caps_frame();
            this.emit_bytes(&caps);
        });
    }

    pub fn write_bytes(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let snap = self.snapshot.borrow().clone();
        if snap.status != ConnectionStatus::Connected {
            return;
        }

        if snap.transport == TransportKind::Demo {
            let (outputs, timer_action) = self.demo.borrow_mut().handle_tx(bytes);
            for chunk in outputs {
                self.emit_bytes(&chunk);
            }
            match timer_action {
                Some(true) => self.start_demo_timer(),
                Some(false) => self.stop_demo_timer(),
                None => {}
            }
            return;
        }

        let promise = js_write_bytes(bytes);
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        });
    }

    pub async fn flash_firmware(
        &self,
        board_id: &str,
        force_other_port: bool,
        flash_offset: &str,
        custom_file: Option<&web_sys::File>,
        on_log: impl FnMut(String) + 'static,
        on_progress: impl FnMut(u32) + 'static,
    ) -> Result<(), String> {
        self.stop_demo_timer();
        let boot_cmd = build_bootloader_cmd();
        let init_cmds = init_command_bytes();

        let log_cb = Closure::<dyn FnMut(String)>::new(on_log);
        let prog_cb = Closure::<dyn FnMut(u32)>::new(on_progress);

        let promise = js_flash_firmware(
            board_id,
            force_other_port,
            flash_offset,
            custom_file,
            &boot_cmd,
            &init_cmds,
            log_cb.as_ref().unchecked_ref(),
            prog_cb.as_ref().unchecked_ref(),
        );

        let res = wasm_bindgen_futures::JsFuture::from(promise).await;
        drop(log_cb);
        drop(prog_cb);

        match res {
            Ok(_) => Ok(()),
            Err(err) => {
                let msg = err
                    .as_string()
                    .or_else(|| {
                        js_sys::Reflect::get(&err, &JsValue::from_str("message"))
                            .ok()
                            .and_then(|v| v.as_string())
                    })
                    .unwrap_or_else(|| format!("{err:?}"));
                Err(msg)
            }
        }
    }

    fn emit_bytes(&self, bytes: &[u8]) {
        if let Some(cb) = self.on_bytes.borrow_mut().as_mut() {
            cb(bytes);
        }
    }

    fn start_demo_timer(&self) {
        self.stop_demo_timer();

        // Emit first frame immediately
        if let Some(frame) = self.demo.borrow_mut().tick_frame() {
            self.emit_bytes(&frame);
        }

        let interval_ms = self.demo.borrow().interval_ms() as i32;
        let this = self.clone();
        let cb = Closure::<dyn FnMut()>::new(move || {
            if let Some(frame) = this.demo.borrow_mut().tick_frame() {
                this.emit_bytes(&frame);
            }
        });

        if let Some(win) = web_sys::window() {
            if let Ok(id) = win.set_interval_with_callback_and_timeout_and_arguments_0(
                cb.as_ref().unchecked_ref(),
                interval_ms,
            ) {
                *self.demo_timer_id.borrow_mut() = Some(id);
                *self.demo_closure.borrow_mut() = Some(cb);
            }
        }
    }

    fn stop_demo_timer(&self) {
        if let Some(id) = self.demo_timer_id.borrow_mut().take() {
            if let Some(win) = web_sys::window() {
                win.clear_interval_with_handle(id);
            }
        }
        *self.demo_closure.borrow_mut() = None;
    }
}
