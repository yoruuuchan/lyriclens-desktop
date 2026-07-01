mod jlpt;
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

// JSON export — the JS side picks the save path via the dialog plugin
// and hands it to us. Returns the entry count for the success toast.
// The file write is sync because there's no contention (single-writer
// SQLite, single in-flight export per user gesture) and tokio::fs would
// only add wakeup overhead.
#[tauri::command]
async fn notebook_export_json_to_path(
    db: tauri::State<'_, notebook::DbHandle>,
    path: String,
) -> Result<usize, CmdError> {
    let conn = db.lock().await;
    Ok(notebook::export_to_path(&conn, std::path::Path::new(&path))?)
}

// Anki TSV export — same shape as the JSON command: JS picks the path,
// we write the file, return the entry count for the toast.
#[tauri::command]
async fn notebook_export_anki_to_path(
    db: tauri::State<'_, notebook::DbHandle>,
    path: String,
) -> Result<usize, CmdError> {
    let conn = db.lock().await;
    Ok(notebook::export_anki_to_path(&conn, std::path::Path::new(&path))?)
}

// JSON import — JS picks the source file via the dialog plugin's open
// API, Rust reads + validates the v1 envelope, transactionally merges
// each entry, returns the ImportSummary so the toast can report the
// new / merged / skipped counts.
#[tauri::command]
async fn notebook_import_from_path(
    db: tauri::State<'_, notebook::DbHandle>,
    path: String,
) -> Result<notebook::ImportSummary, CmdError> {
    let mut conn = db.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis();
    Ok(notebook::import_from_path(
        &mut conn,
        std::path::Path::new(&path),
        now_ms,
    )?)
}

// JLPT reference-level lookup for the analysis card's badge. Frontend
// passes the point's `surface` (base form) and optional `reading` (kana);
// Rust consults the in-memory HashMap populated at boot from the KV
// blob. Returns [] on miss so the UI can render nothing per schema doc
// §UI 渲染规则.
#[tauri::command]
async fn jlpt_lookup(
    store: tauri::State<'_, tokio::sync::RwLock<jlpt::JlptStore>>,
    surface: String,
    reading: Option<String>,
) -> Result<Vec<jlpt::JlptEntry>, CmdError> {
    let guard = store.read().await;
    Ok(guard.lookup(&surface, reading.as_deref()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // app_data_dir lands under %APPDATA%/dev.lyriclens.desktop on
            // Windows. We create the directory eagerly because the user's
            // first action might be a star — no point letting the disk
            // failure mode escape into a confusing storage error later.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = notebook::open_db(&data_dir.join("notebook.sqlite"))?;
            app.manage::<notebook::DbHandle>(tokio::sync::Mutex::new(conn));

            // JLPT store: register an empty store synchronously so the
            // `jlpt_lookup` command always has State to lock, then kick
            // off the network bootstrap on the async runtime. First few
            // hundred ms of app life may miss badges — the frontend
            // re-renders on subsequent card updates and the store is
            // hot by then. Cold cache from disk beats going to network.
            let store = tokio::sync::RwLock::new(jlpt::JlptStore::empty());
            app.manage::<tokio::sync::RwLock<jlpt::JlptStore>>(store);
            let handle = app.handle().clone();
            let bootstrap_dir = data_dir.clone();
            tauri::async_runtime::spawn(async move {
                let loaded = jlpt::bootstrap(&bootstrap_dir, None, None).await;
                let state = handle.state::<tokio::sync::RwLock<jlpt::JlptStore>>();
                let mut guard = state.write().await;
                *guard = loaded;
                log::info!(
                    "jlpt: store ready, {} surfaces loaded (version={:?})",
                    guard.entries.len(),
                    guard.version
                );
            });

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
            notebook_export_json_to_path,
            notebook_export_anki_to_path,
            notebook_import_from_path,
            jlpt_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
