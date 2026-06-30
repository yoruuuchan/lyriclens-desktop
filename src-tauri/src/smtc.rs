// SMTC (System Media Transport Controls) reader.
//
// Pulls now-playing metadata from whatever player is currently the active
// SMTC source on Windows. Spotify, foobar2000, Groove, Edge media — all of
// them register here. NetEase Cloud Music does NOT, which is the whole
// reason the plugin host exists (see roadmap README).

use serde::Serialize;

#[cfg(windows)]
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

#[derive(Debug, Clone, Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Track length in milliseconds. 0 if SMTC didn't report a duration
    /// (some streams don't).
    pub duration_ms: u64,
    /// Position at the moment of capture, in milliseconds.
    pub position_ms: u64,
    /// Unix epoch ms when SMTC reported the position. Frontend extrapolates
    /// the current position by `position_ms + (now - captured_at)`.
    pub captured_at_ms: i64,
    /// One of: "playing" | "paused" | "stopped" | "changing" | "closed" |
    /// "opened" | "unknown".
    pub status: String,
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

#[cfg(windows)]
fn read_session(session: &GlobalSystemMediaTransportControlsSession) -> Result<NowPlaying, SmtcError> {
    // .get() blocks until the IAsyncOperation completes. SMTC queries
    // return in single-digit ms in practice; we wrap the whole `now_playing`
    // entry point in `spawn_blocking` so this doesn't tie up a tokio worker.
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

    let playback_info = session.GetPlaybackInfo()?;
    let status = status_to_string(playback_info.PlaybackStatus()?).to_string();

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
    })
}

#[cfg(windows)]
fn now_playing_sync() -> Result<NowPlaying, SmtcError> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    let session = manager.GetCurrentSession().map_err(|_| SmtcError::NoSession)?;
    read_session(&session)
}

#[cfg(windows)]
pub async fn now_playing() -> Result<NowPlaying, SmtcError> {
    // Hop onto a blocking thread so the .get() calls don't pin a tokio
    // worker. The join result is collapsed back into our error type.
    tokio::task::spawn_blocking(now_playing_sync)
        .await
        .unwrap_or_else(|err| Err(SmtcError::Other(err.to_string())))
}

#[cfg(not(windows))]
pub async fn now_playing() -> Result<NowPlaying, SmtcError> {
    Err(SmtcError::Unsupported)
}
