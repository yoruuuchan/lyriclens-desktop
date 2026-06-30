mod lrclib;
mod notebook;
mod smtc;

use serde::Serialize;
use tauri::Manager;

// Per-kind variants so the frontend can decide whether to show
// "请求超时", "连不上 LRCLIB", "LRCLIB 服务异常 (HTTP NNN)", or just
// the raw message. Without these, every transport failure rendered as
// the same "查询出错 · http error: ..." string with reqwest internals
// leaking through.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum CmdError {
    #[serde(rename = "no_session")]
    NoSession,
    #[serde(rename = "not_found")]
    NotFound,
    #[serde(rename = "timeout")]
    Timeout { message: String },
    #[serde(rename = "connect")]
    Connect { message: String },
    #[serde(rename = "http_status")]
    HttpStatus { message: String, status: u16 },
    #[serde(rename = "storage")]
    Storage { message: String },
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
            lrclib::LrcError::Timeout(message) => CmdError::Timeout { message },
            lrclib::LrcError::Connect(message) => CmdError::Connect { message },
            lrclib::LrcError::Status(status) => CmdError::HttpStatus {
                message: format!("HTTP {status}"),
                status,
            },
            lrclib::LrcError::Http(message) => CmdError::Other { message },
        }
    }
}

impl From<notebook::NotebookError> for CmdError {
    fn from(err: notebook::NotebookError) -> Self {
        CmdError::Storage { message: err.to_string() }
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

#[tauri::command]
async fn notebook_upsert(
    db: tauri::State<'_, notebook::DbHandle>,
    entry: notebook::NotebookEntry,
) -> Result<notebook::NotebookEntry, CmdError> {
    let conn = db.lock().await;
    Ok(notebook::upsert(&conn, &entry)?)
}

#[tauri::command]
async fn notebook_list(
    db: tauri::State<'_, notebook::DbHandle>,
) -> Result<Vec<notebook::NotebookEntry>, CmdError> {
    let conn = db.lock().await;
    Ok(notebook::list(&conn)?)
}

#[tauri::command]
async fn notebook_remove(
    db: tauri::State<'_, notebook::DbHandle>,
    id: String,
) -> Result<bool, CmdError> {
    let conn = db.lock().await;
    Ok(notebook::remove(&conn, &id)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // app_data_dir lands under %APPDATA%/dev.lyriclens.desktop on
            // Windows. We create the directory eagerly because the user's
            // first action might be a star — no point letting the disk
            // failure mode escape into a confusing storage error later.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = notebook::open_db(&data_dir.join("notebook.sqlite"))?;
            app.manage::<notebook::DbHandle>(tokio::sync::Mutex::new(conn));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            smtc_now_playing,
            smtc_all_sessions,
            lrclib_find,
            lrclib_parse_synced,
            notebook_upsert,
            notebook_list,
            notebook_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
