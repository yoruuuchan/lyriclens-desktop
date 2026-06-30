mod lrclib;
mod smtc;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum CmdError {
    #[serde(rename = "no_session")]
    NoSession,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "error")]
    Other { message: String },
}

impl From<smtc::SmtcError> for CmdError {
    fn from(err: smtc::SmtcError) -> Self {
        match err {
            smtc::SmtcError::NoSession => CmdError::NoSession,
            other => CmdError::Other { message: other.to_string() },
        }
    }
}

impl From<lrclib::LrcError> for CmdError {
    fn from(err: lrclib::LrcError) -> Self {
        match err {
            lrclib::LrcError::NotFound => CmdError::NotFound,
            other => CmdError::Other { message: other.to_string() },
        }
    }
}

#[tauri::command]
async fn smtc_now_playing() -> Result<smtc::NowPlaying, CmdError> {
    Ok(smtc::now_playing().await?)
}

#[tauri::command]
async fn smtc_all_sessions() -> Result<Vec<smtc::NowPlaying>, CmdError> {
    Ok(smtc::all_sessions().await?)
}

#[tauri::command]
async fn lrclib_find(
    track_name: String,
    artist_name: String,
    album_name: Option<String>,
    duration_secs: Option<f64>,
) -> Result<lrclib::LyricResult, CmdError> {
    let album_ref = album_name.as_deref();
    Ok(lrclib::find(&track_name, &artist_name, album_ref, duration_secs).await?)
}

#[tauri::command]
fn lrclib_parse_synced(synced: String) -> Vec<lrclib::LyricLine> {
    lrclib::parse_synced(&synced)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            smtc_now_playing,
            smtc_all_sessions,
            lrclib_find,
            lrclib_parse_synced,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
