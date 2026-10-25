#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
struct Engine {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Pending,
    sequence: AtomicU64,
}

impl Engine {
    async fn start(app: tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let data = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&data)?;
        let (node, script) = if cfg!(debug_assertions) {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap();
            (
                root.join("src-tauri/resources/node.exe"),
                root.join("engine/dist/bridge.mjs"),
            )
        } else {
            let root = app.path().resource_dir()?.join("engine");
            (root.join("node.exe"), root.join("bridge.mjs"))
        };
        // Tauri canonicalizes resource paths to \\?\C:\... on Windows.
        // Node's entry-point resolver rejects that verbatim prefix (EISDIR).
        let mut command = Command::new(dunce::simplified(&node));
        command
            .arg(dunce::simplified(&script))
            .arg(dunce::simplified(&data))
            .current_dir(dunce::simplified(&data))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or("Entrée du moteur indisponible")?;
        let output = child.stdout.take().ok_or("Sortie du moteur indisponible")?;
        let pending: Pending = Default::default();
        let replies = pending.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message["id"].as_u64() {
                    if let Some(sender) = replies.lock().await.remove(&id) {
                        let result = if let Some(error) = message["error"].as_str() {
                            Err(error.to_owned())
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = sender.send(result);
                    }
                } else if message["event"] == "state" {
                    let _ = app.emit("lights-state", &message["data"]);
                }
            }
            for (_, sender) in replies.lock().await.drain() {
                let _ = sender.send(Err(
                    "Le moteur Matter s’est arrêté. Relancez Home Control.".into()
                ));
            }
            let _ = app.emit(
                "engine-error",
                "Le moteur Matter s’est arrêté. Relancez Home Control.",
            );
        });
        Ok(Self {
            input: Mutex::new(Some(input)),
            child: Mutex::new(child),
            pending,
            sequence: AtomicU64::new(1),
        })
    }

    async fn request(&self, method: String, params: Value) -> Result<Value, String> {
        if ![
            "status",
            "pair",
            "power",
            "brightness",
            "temperature",
            "color",
            "rename",
            "discover",
        ]
        .contains(&method.as_str())
        {
            return Err("Commande inconnue".into());
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = format!("{}\n", json!({"id":id, "method":method, "params":params}));
        let written = {
            let mut input = self.input.lock().await;
            match input.as_mut() {
                Some(input) => input.write_all(line.as_bytes()).await,
                None => Err(std::io::ErrorKind::BrokenPipe.into()),
            }
        };
        if let Err(error) = written {
            self.pending.lock().await.remove(&id);
            return Err(format!("Moteur Matter indisponible : {error}"));
        }
        let result = tokio::time::timeout(Duration::from_secs(130), rx).await;
        self.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("Connexion au moteur interrompue".into()),
            Err(_) => Err("Délai dépassé. Vérifiez la connexion et réessayez.".into()),
        }
    }

    async fn stop(&self) {
        // Dropping the handle sends EOF so Matter can persist and close its sessions.
        self.input.lock().await.take();
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}

#[tauri::command]
async fn engine_request(
    engine: tauri::State<'_, Engine>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    engine.request(method, params).await
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    conceal(&window);
}

#[tauri::command]
fn app_config(settings: tauri::State<'_, config::Settings>) -> config::AppConfig {
    settings.config.clone()
}

fn open_config(app: &tauri::AppHandle) {
    let settings = app.state::<config::Settings>();
    #[cfg(windows)]
    if let Err(error) = std::process::Command::new("notepad.exe")
        .arg(&settings.path)
        .spawn()
    {
        config::show_error(&format!(
            "Impossible d’ouvrir {} : {error}",
            settings.path.display()
        ));
    }
}

fn bottom_right(
    work: tauri::PhysicalRect<i32, u32>,
    size: tauri::PhysicalSize<u32>,
    gap: u32,
) -> tauri::PhysicalPosition<i32> {
    tauri::PhysicalPosition::new(
        work.position.x
            + work
                .size
                .width
                .saturating_sub(size.width.saturating_add(gap)) as i32,
        work.position.y
            + work
                .size
                .height
                .saturating_sub(size.height.saturating_add(gap)) as i32,
    )
}

fn anchor(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) {
        let size = window.outer_size()?;
        let margin = window.state::<config::Settings>().config.window.margin;
        let gap = (f64::from(margin) * monitor.scale_factor()).round() as u32;
        window.set_position(bottom_right(*monitor.work_area(), size, gap))?;
    }
    Ok(())
}

#[tauri::command]
fn resize_panel(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    let settings = window.state::<config::Settings>();
    let mut height = height.clamp(120, 560);
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let available = (monitor.work_area().size.height as f64 / monitor.scale_factor()
            - 2.0 * f64::from(settings.config.window.margin))
        .max(1.0) as u32;
        height = height.min(available);
    }
    window
        .set_size(tauri::LogicalSize::new(
            settings.config.window.width,
            height,
        ))
        .map_err(|error| error.to_string())?;
    anchor(&window).map_err(|error| error.to_string())
}

#[derive(Default)]
struct DismissEpoch {
    epoch: AtomicU64,
    tray_was_open: AtomicBool,
}

fn cancel_dismissal(window: &tauri::WebviewWindow) -> u64 {
    window
        .state::<DismissEpoch>()
        .epoch
        .fetch_add(1, Ordering::Relaxed)
        + 1
}

// WebView2's native color chooser is an owned window. Keep the panel open
// while it has focus, but dismiss when focus actually leaves the app.
#[cfg(windows)]
fn owned_popup_has_focus(window: &tauri::WebviewWindow) -> bool {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetAncestor(window: isize, flags: u32) -> isize;
    }
    let Ok(parent) = window.hwnd() else {
        return false;
    };
    unsafe {
        let foreground = GetForegroundWindow();
        foreground != 0 && GetAncestor(foreground, 3) == parent.0 as isize
    }
}

#[cfg(not(windows))]
fn owned_popup_has_focus(_: &tauri::WebviewWindow) -> bool {
    false
}

fn dismiss_after_blur(window: tauri::WebviewWindow) {
    let epoch = cancel_dismissal(&window);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(120)).await;
            if window.state::<DismissEpoch>().epoch.load(Ordering::Relaxed) != epoch
                || !window.is_visible().unwrap_or(false)
                || window.is_focused().unwrap_or(false)
            {
                return;
            }
            if !owned_popup_has_focus(&window) {
                conceal(&window);
                return;
            }
        }
    });
}

fn conceal(window: &tauri::WebviewWindow) {
    cancel_dismissal(window);
    let _ = window.hide();
    let _ = window.emit("panel-hidden", ());
}

fn reveal(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        cancel_dismissal(&window);
        let _ = anchor(&window);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("panel-shown", ());
    }
}

fn main() {
    tauri::Builder::default()
        .manage(DismissEpoch::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| reveal(app)))
        .invoke_handler(tauri::generate_handler![
            engine_request,
            hide_window,
            app_config,
            resize_panel
        ])
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            let settings = config::load(&directory).map_err(|error| {
                let message = format!("Configuration invalide : {}\n\n{error}\n\nCorrigez ce fichier puis relancez Home Control.", directory.join("config.json").display());
                config::show_error(&message);
                message
            })?;
            let width = settings.config.window.width;
            app.manage(settings);
            if let Some(window) = app.get_webview_window("main") {
                window.set_size(tauri::LogicalSize::new(width, 210))?;
            }
            let engine = tauri::async_runtime::block_on(Engine::start(app.handle().clone()))?;
            app.manage(engine);
            let open = MenuItem::with_id(app, "open", "Ouvrir Home Control", true, None::<&str>)?;
            let rename =
                MenuItem::with_id(app, "rename", "Renommer les lampes", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let configuration = MenuItem::with_id(app, "config", "Ouvrir la configuration", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &rename, &configuration, &quit])?;
            TrayIconBuilder::new()
                .tooltip("Home Control · Lumières")
                .icon(app.default_window_icon().ok_or("Icône absente")?.clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => reveal(app),
                    "rename" => {
                        reveal(app);
                        let _ = app.emit("open-settings", ());
                    }
                    "quit" => app.exit(0),
                    "config" => open_config(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let dismissal = app.state::<DismissEpoch>();
                            match button_state {
                                MouseButtonState::Down => {
                                    // Remember before blur can hide the panel during a long click.
                                    dismissal.tray_was_open.store(
                                        window.is_visible().unwrap_or(false),
                                        Ordering::Relaxed,
                                    );
                                }
                                MouseButtonState::Up => {
                                    if dismissal.tray_was_open.swap(false, Ordering::Relaxed) {
                                        conceal(&window);
                                    } else {
                                        reveal(app);
                                    }
                                }
                            }
                        }
                    }
                })
                .build(app)?;
            reveal(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(panel) = window.app_handle().get_webview_window("main") {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        conceal(&panel);
                    }
                    tauri::WindowEvent::Focused(false) => {
                        if panel.try_state::<config::Settings>().is_some_and(|settings| settings.config.window.hide_on_blur) { dismiss_after_blur(panel); }
                    }
                    tauri::WindowEvent::Focused(true) => {
                        cancel_dismissal(&panel);
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Impossible de démarrer Home Control")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(engine) = app.try_state::<Engine>() {
                    tauri::async_runtime::block_on(async {
                        engine.stop().await;
                    });
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work_area(x: i32, y: i32, width: u32, height: u32) -> tauri::PhysicalRect<i32, u32> {
        tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(x, y),
            size: tauri::PhysicalSize::new(width, height),
        }
    }

    #[test]
    fn stays_above_the_taskbar_when_expanding_upwards() {
        let work = work_area(0, 0, 1920, 1040);
        assert_eq!(
            bottom_right(work, tauri::PhysicalSize::new(320, 240), 8),
            tauri::PhysicalPosition::new(1592, 792)
        );
        assert_eq!(
            bottom_right(work, tauri::PhysicalSize::new(320, 500), 8),
            tauri::PhysicalPosition::new(1592, 532)
        );
    }

    #[test]
    fn respects_scaled_sizes_and_a_monitor_with_a_negative_origin() {
        let work = work_area(-1920, 40, 1920, 1000);
        assert_eq!(
            bottom_right(work, tauri::PhysicalSize::new(450, 360), 12),
            tauri::PhysicalPosition::new(-462, 668)
        );
        assert_eq!(
            bottom_right(work, tauri::PhysicalSize::new(2000, 1200), 12),
            work.position
        );
    }
}
