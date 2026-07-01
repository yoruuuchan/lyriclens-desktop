// API credentials persisted as a small JSON file under app_data_dir.
// These used to live in localStorage, but localStorage is per-origin:
// dev (http://localhost:<port>) and release (tauri://localhost) each
// get their own copy, so every build-target or dev-port switch lost
// the key. A file on the Rust side survives all of that.
//
// Only the three unrecoverable fields live here. UI preferences
// (theme / fontSize / panelOpacity / ...) stay in localStorage on
// purpose — resetting to defaults is harmless and not worth the
// async round-trip.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CredentialsError {
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    #[serde(default)]
    pub api_endpoint: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model_name: String,
}

fn file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("credentials.json")
}

// Missing file reads as all-empty defaults: first launch and "never
// saved" are the same state to the frontend. A corrupted file is a
// real error — the frontend logs it and falls back to empty fields,
// and the next save overwrites the bad file.
pub fn read(app_data_dir: &Path) -> Result<Credentials, CredentialsError> {
    match std::fs::read_to_string(file_path(app_data_dir)) {
        Ok(raw) => Ok(serde_json::from_str(&raw)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::default()),
        Err(e) => Err(e.into()),
    }
}

// Temp-file + rename so a crash mid-write can't leave a truncated
// credentials.json — the key is the one thing the user can't recover
// from anywhere else in the app.
pub fn write(app_data_dir: &Path, creds: &Credentials) -> Result<(), CredentialsError> {
    std::fs::create_dir_all(app_data_dir)?;
    let tmp = app_data_dir.join("credentials.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(creds)?)?;
    std::fs::rename(&tmp, &file_path(app_data_dir))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Same trick as the notebook export tests: tempfile is one more
    // dep we don't otherwise need, so cobble a unique dir out of
    // pid + nanos and clean up at the end.
    fn temp_data_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lyriclens-test-credentials-{tag}-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn read_missing_file_returns_default() {
        // Deliberately never created — read must not require the dir
        // to exist either (fresh install, nothing saved yet).
        let dir = temp_data_dir("missing");
        assert_eq!(read(&dir).unwrap(), Credentials::default());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = temp_data_dir("roundtrip");
        let creds = Credentials {
            api_endpoint: "https://api.example.com/v1/chat/completions".into(),
            api_key: "sk-test-123".into(),
            model_name: "some-model".into(),
        };
        write(&dir, &creds).unwrap();
        assert_eq!(read(&dir).unwrap(), creds);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_overwrites_previous_value() {
        let dir = temp_data_dir("overwrite");
        let first = Credentials { api_key: "old".into(), ..Default::default() };
        let second = Credentials { api_key: "new".into(), ..Default::default() };
        write(&dir, &first).unwrap();
        write(&dir, &second).unwrap();
        assert_eq!(read(&dir).unwrap().api_key, "new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_corrupted_json_is_an_error() {
        let dir = temp_data_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("credentials.json"), "{not json").unwrap();
        assert!(matches!(read(&dir), Err(CredentialsError::Json(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Hand-edited or older-shape JSON fills missing fields with empty
    // strings instead of failing the whole read.
    #[test]
    fn read_partial_json_defaults_missing_fields() {
        let dir = temp_data_dir("partial");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("credentials.json"), r#"{"apiKey":"sk-only"}"#).unwrap();
        let creds = read(&dir).unwrap();
        assert_eq!(creds.api_key, "sk-only");
        assert_eq!(creds.api_endpoint, "");
        assert_eq!(creds.model_name, "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
