use tauri::{Emitter, Manager};

mod store;

#[cfg(all(debug_assertions, feature = "uia-diagnostics"))]
mod capture;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("single-instance-summon", ());
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let store_dir = app.path().app_data_dir()?;
            let manager = store::PersistenceManager::new(store_dir)
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(manager);
            Ok(())
        });

    #[cfg(all(debug_assertions, feature = "uia-diagnostics"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        load_user_data,
        save_user_data,
        reset_storage,
        restore_storage,
        capture::perform_target_probe,
    ]);

    #[cfg(not(all(debug_assertions, feature = "uia-diagnostics")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        load_user_data,
        save_user_data,
        reset_storage,
        restore_storage,
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn load_user_data(
    manager: tauri::State<'_, store::PersistenceManager>,
) -> Result<store::StoreSnapshot, String> {
    manager.load_snapshot().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_user_data(
    manager: tauri::State<'_, store::PersistenceManager>,
    snapshot: store::StoreSnapshot,
) -> Result<(), String> {
    manager.save_snapshot(&snapshot).map_err(|error| error.to_string())
}

#[tauri::command]
fn reset_storage(
    manager: tauri::State<'_, store::PersistenceManager>,
) -> Result<(), String> {
    manager.reset_to_factory().map_err(|error| error.to_string())
}

#[tauri::command]
fn restore_storage(
    manager: tauri::State<'_, store::PersistenceManager>,
) -> Result<(), String> {
    manager.restore_backup().map_err(|error| error.to_string())
}
