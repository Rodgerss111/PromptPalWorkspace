use tauri::Emitter;

#[cfg(all(debug_assertions, feature = "uia-diagnostics"))]
mod capture;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("single-instance-summon", ());
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(all(debug_assertions, feature = "uia-diagnostics"))]
    let builder = builder.invoke_handler(tauri::generate_handler![capture::perform_target_probe]);

    #[cfg(not(all(debug_assertions, feature = "uia-diagnostics")))]
    let builder = builder;

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
