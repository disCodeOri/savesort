use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;

/// Builds the tray icon and its menu. The menu is rebuilt on demand rather
/// than mutated, which keeps the status line accurate without tracking item
/// handles across threads.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("SaveSort Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .build(app)?;

    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let status_label = app
        .try_state::<AppState>()
        .map(|state| state.current_phase().label().to_string())
        .unwrap_or_else(|| "Starting…".to_string());

    // The status line is a disabled item: informational, not clickable.
    let status = MenuItem::with_id(app, "status", status_label, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open dashboard", true, None::<&str>)?;
    let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause syncing", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Resume syncing", true, None::<&str>)?;
    let open_web = MenuItem::with_id(app, "open_web", "Open SaveSort website", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit SaveSort", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &sync_now,
            &pause,
            &resume,
            &PredefinedMenuItem::separator(app)?,
            &open_web,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_dashboard(app),
        "sync_now" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if let Err(error) = crate::commands::sync_now(state).await {
                    tracing::warn!(error = %error, "manual sync failed");
                }
            });
        }
        "pause" | "resume" => {
            let paused = event.id().as_ref() == "pause";
            let state = app.state::<AppState>();
            if let Err(error) = crate::commands::set_paused(state, paused) {
                tracing::warn!(error = %error, "could not change pause state");
            }
        }
        "open_web" => {
            // Honours SAVESORT_BASE_URL so a dev build opens the dev server's
            // library rather than production.
            let base = crate::resolved_base_url();
            let _ = tauri_plugin_opener::open_url(format!("{base}/library"), None::<&str>);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn show_dashboard<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // The window is created lazily: a background sync utility should not pay
    // for a webview until the user actually opens the dashboard.
    let result = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("SaveSort Desktop")
    .inner_size(520.0, 640.0)
    .resizable(true)
    .build();

    if let Err(error) = result {
        tracing::error!(error = %error, "could not open the dashboard window");
    }
}
