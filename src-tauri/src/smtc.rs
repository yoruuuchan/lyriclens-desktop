// SMTC (System Media Transport Controls) reader.
//
// Pulls now-playing metadata from whatever player is currently the active
// SMTC source on Windows. Spotify, foobar2000, Groove, Edge media — all of
// them register here. NetEase Cloud Music does NOT, which is the whole
// reason the plugin host exists (see roadmap README).
//
// We expose two entry points:
//   - now_playing()    → only the focused session, used by the main poll
//   - all_sessions()   → every registered session, used by the debug panel
//     to triage "why is timeline missing".

use serde::Serialize;

#[cfg(windows)]
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Track length in milliseconds. 0 if SMTC didn't report a duration
    /// (some streams don't).
    pub duration_ms: u64,
    /// Position at the moment of capture, in milliseconds.
    pub position_ms: u64,
    /// Unix epoch ms when WE captured this snapshot. Frontend extrapolates
    /// the current position by `position_ms + (now - captured_at)`.
    pub captured_at_ms: i64,
    /// One of: "playing" | "paused" | "stopped" | "changing" | "closed" |
    /// "opened" | "unknown".
    pub status: String,
    /// Unix epoch ms when the SOURCE player last updated its timeline
    /// (SMTC `LastUpdatedTime`). 0 means the player has never reported
    /// timeline. If this value stops changing while `status == "playing"`,
    /// the source isn't pushing updates and we should not trust position.
    pub last_updated_raw_ms: i64,
    /// SMTC `PlaybackRate` (nullable double). 1.0 = normal. None means the
    /// player doesn't report rate — extrapolate as if 1.0.
    pub playback_rate: Option<f64>,
    /// e.g. `"Spotify.exe"`, `"AppleInc.AppleMusicWin_…!App"`. Used by the
    /// debug panel to disambiguate sibling sessions.
    pub source_app_user_model_id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SmtcError {
    #[error("no active SMTC session")]
    NoSession,
    #[cfg(windows)]
    #[error("windows api error: {0}")]
    Windows(#[from] windows::core::Error),
    #[error("system time error: {0}")]
    Time(#[from] std::time::SystemTimeError),
    #[error("{0}")]
    Other(String),
    #[cfg(not(windows))]
    #[error("SMTC is only available on Windows")]
    Unsupported,
}

#[cfg(windows)]
fn status_to_string(s: PlaybackStatus) -> &'static str {
    match s {
        PlaybackStatus::Closed => "closed",
        PlaybackStatus::Opened => "opened",
        PlaybackStatus::Changing => "changing",
        PlaybackStatus::Stopped => "stopped",
        PlaybackStatus::Playing => "playing",
        PlaybackStatus::Paused => "paused",
        _ => "unknown",
    }
}

/// 100-nanosecond ticks between the WinRT DateTime epoch (1601-01-01 UTC)
/// and the Unix epoch (1970-01-01 UTC). Used to convert SMTC's
/// `LastUpdatedTime` (which is a WinRT `DateTime`) into Unix ms so the
/// frontend can put it on the same axis as `captured_at_ms`.
#[cfg(windows)]
const TICKS_BETWEEN_EPOCHS: i64 = 116_444_736_000_000_000;

#[cfg(windows)]
fn read_session(session: &GlobalSystemMediaTransportControlsSession) -> Result<NowPlaying, SmtcError> {
    // .get() blocks until the IAsyncOperation completes. SMTC queries
    // return in single-digit ms in practice; we wrap the whole entry
    // point in `spawn_blocking` so this doesn't tie up a tokio worker.
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();

    let timeline = session.GetTimelineProperties()?;
    // Windows::Foundation::TimeSpan is 100ns ticks. Divide by 10_000 → ms.
    let position_100ns = timeline.Position()?.Duration;
    let end_100ns = timeline.EndTime()?.Duration;
    let start_100ns = timeline.StartTime()?.Duration;
    let position_ms = (position_100ns.max(0) / 10_000) as u64;
    let duration_ms = ((end_100ns - start_100ns).max(0) / 10_000) as u64;

    // LastUpdatedTime: WinRT DateTime is i64 100ns ticks since 1601-01-01.
    // Convert to Unix ms. A literal 0 means the source has never published
    // any timeline update — keep it as 0 so the frontend can branch on
    // "never updated" vs "stale".
    let last_updated_raw = timeline.LastUpdatedTime()?.UniversalTime;
    let last_updated_raw_ms = if last_updated_raw == 0 {
        0
    } else {
        (last_updated_raw - TICKS_BETWEEN_EPOCHS) / 10_000
    };

    let playback_info = session.GetPlaybackInfo()?;
    let status = status_to_string(playback_info.PlaybackStatus()?).to_string();
    // PlaybackRate is nullable double. windows-rs surfaces it as an
    // IReference<f64>; .Value() collapses Some → f64, None → Err. We
    // map any failure to None so a missing rate doesn't kill the whole
    // snapshot.
    let playback_rate = playback_info
        .PlaybackRate()
        .ok()
        .and_then(|reference| reference.Value().ok());

    let source_app_user_model_id = session
        .SourceAppUserModelId()
        .map(|s| s.to_string())
        .unwrap_or_default();

    let captured_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;

    Ok(NowPlaying {
        title,
        artist,
        album,
        duration_ms,
        position_ms,
        captured_at_ms,
        status,
        last_updated_raw_ms,
        playback_rate,
        source_app_user_model_id,
    })
}

#[cfg(windows)]
fn now_playing_sync() -> Result<NowPlaying, SmtcError> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    let session = manager.GetCurrentSession().map_err(|_| SmtcError::NoSession)?;
    read_session(&session)
}

#[cfg(windows)]
fn all_sessions_sync() -> Result<Vec<NowPlaying>, SmtcError> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    let sessions = manager.GetSessions()?;
    let size = sessions.Size()?;
    let mut result = Vec::with_capacity(size as usize);
    for i in 0..size {
        let session = sessions.GetAt(i)?;
        // A single broken session shouldn't poison the whole list — the
        // debug panel still wants to show the others.
        if let Ok(np) = read_session(&session) {
            result.push(np);
        }
    }
    Ok(result)
}

#[cfg(windows)]
pub async fn now_playing() -> Result<NowPlaying, SmtcError> {
    // Hop onto a blocking thread so the .get() calls don't pin a tokio
    // worker. The join result is collapsed back into our error type.
    tokio::task::spawn_blocking(now_playing_sync)
        .await
        .unwrap_or_else(|err| Err(SmtcError::Other(err.to_string())))
}

#[cfg(windows)]
pub async fn all_sessions() -> Result<Vec<NowPlaying>, SmtcError> {
    tokio::task::spawn_blocking(all_sessions_sync)
        .await
        .unwrap_or_else(|err| Err(SmtcError::Other(err.to_string())))
}

#[cfg(not(windows))]
pub async fn now_playing() -> Result<NowPlaying, SmtcError> {
    Err(SmtcError::Unsupported)
}

#[cfg(not(windows))]
pub async fn all_sessions() -> Result<Vec<NowPlaying>, SmtcError> {
    Err(SmtcError::Unsupported)
}
