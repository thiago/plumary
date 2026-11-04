mod ax;
mod clipboard;
mod stores;
mod typing;

use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PANEL_WINDOW: &str = "panel";
const SETTINGS_WINDOW: &str = "settings";
const PANEL_WIDTH: f64 = 380.0;
const PANEL_HEIGHT: f64 = 440.0;
const PANEL_GAP: f64 = 8.0;
const ACTIVATE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);
const TYPED_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);
const SHORTCUT_MODS: Modifiers = Modifiers::SUPER.union(Modifiers::SHIFT);
const SHORTCUT_KEY: Code = Code::KeyG;

/// How the current text was obtained; decides how edits are written back.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    /// Read and written through the Accessibility API.
    Accessibility,
    /// Read through Accessibility; written by selecting the range and pasting (Chromium/Electron).
    Paste,
    /// Read via simulated ⌘C; the replacement is only copied to the clipboard.
    Clipboard,
}

#[derive(Debug, Clone, Serialize)]
struct CheckRequest {
    text: String,
    selection_start: usize,
    selection_end: usize,
    mode: Mode,
}

/// The field captured at shortcut time; edits are applied to it even after focus moved to us.
#[derive(Default)]
struct Captured {
    element: Option<ax::Element>,
    pid: Option<i32>,
    mode: Option<Mode>,
    /// Text the panel is working on and how its offsets translate to the app's ranges.
    text: String,
    offsets: ax::OffsetMap,
}

type Shared = Mutex<Captured>;

#[tauri::command]
fn apply_edit(state: State<'_, Shared>, start: usize, end: usize, replacement: String) -> Result<Mode, String> {
    let mut captured = state.lock().map_err(|e| e.to_string())?;
    let Captured { mode, element, pid, text, offsets } = &mut *captured;
    match (*mode, element.as_ref()) {
        (Some(Mode::Accessibility | Mode::Paste), Some(element)) => {
            let value: Vec<u16> = text.encode_utf16().collect();
            let expected = String::from_utf16_lossy(value.get(start..end).ok_or("edit range is outside the text")?);
            let (ax_start, ax_end) = (offsets.to_ax(start), offsets.to_ax(end));
            // Never overwrite something other than what the panel showed: the user may have typed
            // since the check. Verify with AXStringForRange, which reads the same whether or not
            // the field is focused; AXSelectedText reads empty in Chromium, so it can't be trusted.
            match element.string_for_range(ax_start, ax_end) {
                Ok(current) if current == expected => {}
                Ok(current) => return Err(format!("the field no longer matches: expected {expected:?}, found {current:?}. Run the check again.")),
                Err(_) => {} // app can't read ranges; proceed on the capture-time match
            }
            element.select_range(ax_start, ax_end).map_err(|e| e.to_string())?;
            let before = element.text().map_err(|e| e.to_string())?;
            let applied = write_selection(element, *pid, &before, &replacement)?;
            // Keep our copy of the text and the offset map in step with the field.
            let mut updated = value;
            updated.splice(start..end, replacement.encode_utf16());
            *text = String::from_utf16_lossy(&updated);
            *offsets = element.offset_map(text);
            Ok(applied)
        }
        _ => {
            if clipboard::set_text(&replacement) {
                Ok(Mode::Clipboard)
            } else {
                Err("could not write to clipboard".into())
            }
        }
    }
}

/// Writes `replacement` over the current selection. First it asks the app to apply it through
/// Accessibility, which native Cocoa fields honour. When that is silently ignored (Chromium and
/// Electron accept `AXSelectedText` and do nothing), it synthesises Unicode key events straight to
/// the app's process, overwriting the still-selected range without touching the clipboard.
fn write_selection(element: &ax::Element, pid: Option<i32>, before: &str, replacement: &str) -> Result<Mode, String> {
    element.replace_selection(replacement).map_err(|e| e.to_string())?;
    if element.text().map_err(|e| e.to_string())? != before {
        return Ok(Mode::Accessibility);
    }
    let pid = pid.ok_or("no target app to type into")?;
    // Our panel takes focus when it opens, so hand it back before typing; once we move to a
    // non-activating panel this step becomes unnecessary (CGEventPostToPid targets the process).
    if !ax::activate_and_wait(pid, ACTIVATE_TIMEOUT) {
        return Err("the target app did not come to the front".into());
    }
    if !typing::type_text_to_pid(pid, replacement) {
        return Err("could not synthesise keyboard input".into());
    }
    // Wait for the typed characters to register in the field.
    let deadline = std::time::Instant::now() + TYPED_TIMEOUT;
    while element.text().map(|now| now == before).unwrap_or(false) {
        if std::time::Instant::now() >= deadline {
            return Err("the target app did not accept the typed text".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Ok(Mode::Paste)
}

#[tauri::command]
fn dismiss_panel(app: AppHandle, state: State<'_, Shared>) {
    if let Some(panel) = app.get_webview_window(PANEL_WINDOW) {
        panel.hide().ok();
    }
    if let Ok(captured) = state.lock() {
        if let Some(pid) = captured.pid {
            ax::activate_pid(pid);
        }
    }
}

#[tauri::command]
fn accessibility_status(prompt: bool) -> bool {
    ax::is_trusted(prompt)
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SETTINGS_WINDOW) {
        w.show().ok();
        w.set_focus().ok();
    }
}

#[cfg(debug_assertions)]
fn dev_apply_edit(app: &AppHandle) {
    let Ok(spec) = std::env::var("PLUMARY_DEV_EDIT_FILE").and_then(|p| std::fs::read_to_string(p).map_err(|_| std::env::VarError::NotPresent)) else {
        eprintln!("dev apply_edit: set PLUMARY_DEV_EDIT_FILE to a file with `[focus ]start end replacement`");
        return;
    };
    let mut spec = spec.trim_end_matches('\n');
    let focus = spec.starts_with("focus ");
    if focus {
        spec = &spec["focus ".len()..];
        if let Some(panel) = app.get_webview_window(PANEL_WINDOW) {
            panel.set_focus().ok();
        }
    }
    let mut parts = spec.splitn(3, ' ');
    let (Some(start), Some(end), Some(replacement)) = (parts.next().and_then(|s| s.parse().ok()), parts.next().and_then(|s| s.parse().ok()), parts.next()) else {
        eprintln!("dev apply_edit: bad spec {spec:?}");
        return;
    };
    let app = app.clone();
    let replacement = replacement.to_owned();
    // Give the focus change time to land, as it would between a click and the command.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        eprintln!("dev apply_edit {start}..{end} -> {replacement:?} (focus={focus}, frontmost={:?})", ax::frontmost_pid());
        let result = apply_edit(app.state::<Shared>(), start, end, replacement);
        eprintln!("dev apply_edit -> {result:?}");
    });
}

/// Shortcut handler: snapshot the focused field, position the panel next to it, send the text over.
fn on_shortcut(app: &AppHandle) {
    let Some(panel) = app.get_webview_window(PANEL_WINDOW) else { return };
    let state = app.state::<Shared>();
    let mut captured = state.lock().unwrap_or_else(|p| p.into_inner());

    let request = match ax::focused_element().and_then(|el| el.snapshot().map(|s| (el, s))) {
        Ok((element, snap)) => {
            eprintln!("captured pid={} len={} sel={}..{} bounds={:?} text={:?}", snap.pid, snap.text.len(), snap.selection_start, snap.selection_end, snap.bounds, snap.text.chars().take(40).collect::<String>());
            captured.pid = Some(snap.pid);
            captured.element = Some(element);
            captured.mode = Some(Mode::Accessibility);
            captured.text = snap.text.clone();
            captured.offsets = snap.offsets;
            position_panel(&panel, snap.bounds.as_ref());
            CheckRequest { text: snap.text, selection_start: snap.selection_start, selection_end: snap.selection_end, mode: Mode::Accessibility }
        }
        Err(e) => {
            eprintln!("accessibility read failed ({e}), falling back to clipboard");
            captured.element = None;
            captured.pid = None;
            captured.mode = Some(Mode::Clipboard);
            captured.text.clear();
            captured.offsets = ax::OffsetMap::default();
            let Some(text) = clipboard::copy_selection() else {
                eprintln!("nothing selected / clipboard fallback empty");
                return;
            };
            position_panel(&panel, None);
            CheckRequest { selection_start: 0, selection_end: text.len(), text, mode: Mode::Clipboard }
        }
    };
    drop(captured);

    panel.show().ok();
    panel.set_focus().ok();
    app.emit_to(PANEL_WINDOW, "check-request", request).ok();
}

/// Anchors the panel below the field's selection, kept inside the monitor that contains the
/// field. AX reports logical points in the global space whose origin is the primary display.
fn position_panel(panel: &WebviewWindow, bounds: Option<&ax::Rect>) {
    panel.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT)).ok();
    let Some(r) = bounds else { panel.center().ok(); return };

    let monitor = panel.available_monitors().unwrap_or_default().into_iter().map(|m| {
        let scale = m.scale_factor();
        let (x, y) = (m.position().x as f64 / scale, m.position().y as f64 / scale);
        let (w, h) = (m.size().width as f64 / scale, m.size().height as f64 / scale);
        (x, y, w, h)
    }).find(|&(x, y, w, h)| r.x >= x && r.x < x + w && r.y >= y && r.y < y + h);
    let Some((mx, my, mw, mh)) = monitor else {
        eprintln!("anchor {r:?} is on no monitor, centering panel");
        panel.center().ok();
        return;
    };

    let below = r.y + r.height + PANEL_GAP;
    let y = if below + PANEL_HEIGHT <= my + mh { below } else { (r.y - PANEL_HEIGHT - PANEL_GAP).max(my) };
    let x = r.x.min(mx + mw - PANEL_WIDTH).max(mx);
    eprintln!("panel -> ({x}, {y}) on monitor {:?}", monitor);
    panel.set_position(LogicalPosition::new(x, y)).ok();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            apply_edit,
            dismiss_panel,
            accessibility_status,
            open_settings,
            stores::secret_get,
            stores::secret_set,
            stores::secret_delete,
            stores::settings_load,
            stores::settings_save,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let shortcut = Shortcut::new(Some(SHORTCUT_MODS), SHORTCUT_KEY);
            app.global_shortcut().on_shortcut(shortcut, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    on_shortcut(app);
                }
            })?;

            let check = MenuItem::with_id(app, "check", "Check focused text   ⌘⇧G", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Plumary", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&check, &settings, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("icon"))
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "check" => on_shortcut(app),
                    "settings" => show_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if !ax::is_trusted(true) {
                show_settings(app.handle());
            }

            // Dev hooks, so the accessibility flow can be exercised from a shell without
            // sending keystrokes: `kill -USR1 <pid>` runs the shortcut path; `kill -USR2 <pid>`
            // applies the edit described in $PLUMARY_DEV_EDIT_FILE ("start end replacement",
            // prefixed with "focus " to first focus the panel like a real click would).
            #[cfg(debug_assertions)]
            {
                use signal_hook::consts::{SIGUSR1, SIGUSR2};
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut signals = signal_hook::iterator::Signals::new([SIGUSR1, SIGUSR2]).expect("signals");
                    for signal in signals.forever() {
                        let h = handle.clone();
                        handle.run_on_main_thread(move || {
                            if signal == SIGUSR1 {
                                on_shortcut(&h);
                            } else {
                                dev_apply_edit(&h);
                            }
                        }).ok();
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Plumary");
}
