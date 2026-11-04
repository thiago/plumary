//! Host implementations of the core's SecretStore / SettingsStore ports.
//! Settings live in a JSON file in the app config dir. Secrets live in the macOS Keychain in
//! release builds; debug builds use a 0600 JSON file instead, because an unsigned dev binary
//! changes on every rebuild and the Keychain would prompt for access each time.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(not(debug_assertions))]
const SERVICE: &str = "app.plumary.desktop";
const SETTINGS_FILE: &str = "settings.json";
#[cfg(debug_assertions)]
const DEV_SECRETS_FILE: &str = "secrets.dev.json";

#[tauri::command]
pub fn secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    secrets::get(&app, &key)
}

#[tauri::command]
pub fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    secrets::set(&app, &key, &value)
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    secrets::delete(&app, &key)
}

#[cfg(not(debug_assertions))]
mod secrets {
    use super::{err, SERVICE};
    use tauri::AppHandle;

    pub fn get(_app: &AppHandle, key: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(SERVICE, key).map_err(err)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set(_app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key).map_err(err)?.set_password(value).map_err(err)
    }

    pub fn delete(_app: &AppHandle, key: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, key).map_err(err)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(debug_assertions)]
mod secrets {
    use super::{config_path, err, BTreeMap, DEV_SECRETS_FILE};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tauri::AppHandle;

    const OWNER_ONLY: u32 = 0o600;

    type Map = BTreeMap<String, String>;

    pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
        Ok(load(app)?.get(key).cloned())
    }

    pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
        let mut map = load(app)?;
        map.insert(key.to_owned(), value.to_owned());
        save(app, &map)
    }

    pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
        let mut map = load(app)?;
        map.remove(key);
        save(app, &map)
    }

    fn load(app: &AppHandle) -> Result<Map, String> {
        let path = config_path(app, DEV_SECRETS_FILE)?;
        if !path.exists() {
            return Ok(Map::new());
        }
        serde_json::from_str(&fs::read_to_string(path).map_err(err)?).map_err(err)
    }

    fn save(app: &AppHandle, map: &Map) -> Result<(), String> {
        let path = config_path(app, DEV_SECRETS_FILE)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        fs::write(&path, serde_json::to_string_pretty(map).map_err(err)?).map_err(err)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(OWNER_ONLY)).map_err(err)
    }
}

#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(err)?;
    serde_json::from_str(&raw).map(Some).map_err(err)
}

#[tauri::command]
pub fn settings_save(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(path, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    config_path(app, SETTINGS_FILE)
}

fn config_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(err)?.join(file))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
