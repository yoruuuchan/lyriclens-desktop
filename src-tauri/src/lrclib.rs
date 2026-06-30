// LRCLIB client.
//
// API docs: https://lrclib.net/docs
// We use the /api/get endpoint with track_name, artist_name, album_name,
// duration. LRCLIB matches with a tolerance of ±2s on duration and a
// normalized comparison on artist/track names. If /api/get misses, fall
// back to /api/search and pick the best candidate.
//
// We route through `lrclib.yoru-and-akari.dev`, a Cloudflare Worker
// reverse-proxy whose source lives in this repo at
// `cloudflare-worker/`. The proxy exists because direct TLS to
// lrclib.net regularly gets reset by the GFW on mainland China
// networks — Cloudflare's HK/SG edge terminates the user's TLS and
// then the server-to-server hop to lrclib.net runs from CF's backbone
// instead of the consumer path. The proxy also caches 200 responses
// at the edge so repeated lookups of the same song never re-hit
// upstream.
//
// If the proxy ever has to be bypassed, swap this back to the direct
// URL — the surface (path + query + JSON shape) is identical.

use serde::{Deserialize, Serialize};

const BASE_URL: &str = "https://lrclib.yoru-and-akari.dev/api";
const USER_AGENT: &str = concat!(
    "LyricLens-Desktop/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/yoruuuchan/LyricLens)",
);

// LRCLIB returns camelCase JSON (trackName, syncedLyrics, …). Tauri
// also serializes Rust struct fields to camelCase when crossing into
// JS by default. rename_all = "camelCase" makes BOTH directions line
// up so the Deserialize from LRCLIB and the Serialize to the frontend
// share one field convention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricResult {
    pub id: i64,
    pub track_name: String,
    pub artist_name: String,
    #[serde(default)]
    pub album_name: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
}

// Split out so the frontend can show "请求超时" vs "连不上 LRCLIB" vs
// "LRCLIB 服务异常" instead of a raw reqwest debug string. Transport-
// level failures (Timeout, Connect) are the ones worth retrying — the
// caller does that inside send_with_retry below. Status / Http / Decode
// errors are server-shaped and a retry won't change the outcome.
#[derive(Debug, thiserror::Error)]
pub enum LrcError {
    #[error("not found")]
    NotFound,
    #[error("timed out: {0}")]
    Timeout(String),
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("unexpected status: {0}")]
    Status(u16),
}

impl From<reqwest::Error> for LrcError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            LrcError::Timeout(e.to_string())
        } else if e.is_connect() {
            LrcError::Connect(e.to_string())
        } else {
            // Decode errors, redirect loops, builder errors, etc. — generic
            // bucket. Not retried because they're not transport flakes.
            LrcError::Http(e.to_string())
        }
    }
}

fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
}

// One retry on transient transport failures (timeout / connect). 500ms
// backoff before the second attempt — short enough that the user
// doesn't visibly wait, long enough to ride out a momentary blip
// (TLS handshake reset, DNS hiccup). HTTP-status errors and decode
// errors short-circuit out of the loop because retry won't fix them.
//
// Takes a builder closure rather than a RequestBuilder so each attempt
// constructs a fresh request — RequestBuilder isn't Clone in the
// public API and try_clone() returns Option, both clumsier than this.
async fn send_with_retry(
    make_req: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, LrcError> {
    let mut last_err: Option<LrcError> = None;
    for attempt in 0..=1u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        match make_req().send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                let transient = e.is_timeout() || e.is_connect();
                last_err = Some(LrcError::from(e));
                if !transient {
                    break;
                }
            }
        }
    }
    Err(last_err.expect("retry loop must observe at least one error before exit"))
}

/// Direct lookup. LRCLIB applies its own normalization, so passing the raw
/// SMTC values is fine. duration_secs is optional but improves match rate.
pub async fn get(
    track_name: &str,
    artist_name: &str,
    album_name: Option<&str>,
    duration_secs: Option<f64>,
) -> Result<LyricResult, LrcError> {
    let client = client()?;
    let resp = send_with_retry(|| {
        let mut req = client
            .get(format!("{}/get", BASE_URL))
            .query(&[("track_name", track_name), ("artist_name", artist_name)]);
        if let Some(album) = album_name {
            if !album.is_empty() {
                req = req.query(&[("album_name", album)]);
            }
        }
        if let Some(dur) = duration_secs {
            // LRCLIB expects an integer-second duration.
            req = req.query(&[("duration", format!("{:.0}", dur))]);
        }
        req
    })
    .await?;
    match resp.status().as_u16() {
        200 => Ok(resp.json::<LyricResult>().await?),
        404 => Err(LrcError::NotFound),
        s => Err(LrcError::Status(s)),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCandidate {
    id: i64,
    track_name: String,
    artist_name: String,
    #[serde(default)]
    album_name: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    plain_lyrics: Option<String>,
    #[serde(default)]
    synced_lyrics: Option<String>,
}

/// Fallback search when /api/get misses. Candidates are ranked first
/// by whether they have synced lyrics (a plain-only candidate with the
/// "perfect" duration is far worse for our use case than a synced one
/// a couple seconds off), then by duration closeness to the SMTC
/// duration when one was given. Discovered when Aimer / EGOIST · ninelie
/// fell back to a romaji-only plain candidate whose last line was
/// "(End)" — every lyric line ended up with timeMs=0 and the active-
/// line tracker pinned to the final "(End)" forever.
pub async fn search(
    track_name: &str,
    artist_name: &str,
    duration_secs: Option<f64>,
) -> Result<LyricResult, LrcError> {
    let client = client()?;
    let resp = send_with_retry(|| {
        client
            .get(format!("{}/search", BASE_URL))
            .query(&[("track_name", track_name), ("artist_name", artist_name)])
    })
    .await?;
    if !resp.status().is_success() {
        return Err(LrcError::Status(resp.status().as_u16()));
    }
    let candidates: Vec<SearchCandidate> = resp.json().await?;
    if candidates.is_empty() {
        return Err(LrcError::NotFound);
    }

    let pick = candidates
        .iter()
        .min_by(|a, b| {
            // Synced-first. Treat empty strings the same as None — the
            // LRCLIB response sometimes carries a syncedLyrics field
            // whose value is the empty string for plain-only rows.
            let a_synced = a.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty());
            let b_synced = b.synced_lyrics.as_deref().is_some_and(|s| !s.is_empty());
            match (a_synced, b_synced) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => {
                    // Same tier on synced-availability — break the tie
                    // by duration closeness when we have a target. If
                    // no target, fall back to the API's own order
                    // (stable min_by returns the first equal-key one).
                    if let Some(target) = duration_secs {
                        let da = a.duration.map(|d| (d - target).abs()).unwrap_or(f64::INFINITY);
                        let db = b.duration.map(|d| (d - target).abs()).unwrap_or(f64::INFINITY);
                        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                    } else {
                        std::cmp::Ordering::Equal
                    }
                }
            }
        })
        .unwrap();

    Ok(LyricResult {
        id: pick.id,
        track_name: pick.track_name.clone(),
        artist_name: pick.artist_name.clone(),
        album_name: pick.album_name.clone(),
        duration: pick.duration,
        instrumental: pick.instrumental,
        plain_lyrics: pick.plain_lyrics.clone(),
        synced_lyrics: pick.synced_lyrics.clone(),
    })
}

/// Try /api/get first, then fall back to /api/search. This is the call
/// the frontend wants.
pub async fn find(
    track_name: &str,
    artist_name: &str,
    album_name: Option<&str>,
    duration_secs: Option<f64>,
) -> Result<LyricResult, LrcError> {
    match get(track_name, artist_name, album_name, duration_secs).await {
        Ok(r) => Ok(r),
        Err(LrcError::NotFound) => search(track_name, artist_name, duration_secs).await,
        Err(e) => Err(e),
    }
}

// Matches the camelCase convention shared with LyricResult above and
// with NowPlaying in smtc.rs. Without this the field crossed into JS as
// `time_ms`, the frontend reads `state.lines[i].timeMs` as undefined,
// and `undefined <= pos` is always false — every line stays
// non-active forever, no inline card ever attaches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time_ms: u64,
    pub text: String,
}

/// Parse synced lyrics ([mm:ss.xx] text) into a sorted list of lines.
/// Lines without a timestamp are dropped. Empty-text lines are kept (they
/// are usually intentional gaps between verses).
pub fn parse_synced(synced: &str) -> Vec<LyricLine> {
    let mut out = Vec::new();
    for raw in synced.lines() {
        let line = raw.trim_end_matches('\r');
        let mut rest = line;
        let mut stamps: Vec<u64> = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(close) = stripped.find(']') else { break };
            let stamp = &stripped[..close];
            if let Some(ms) = parse_stamp(stamp) {
                stamps.push(ms);
                rest = &stripped[close + 1..];
            } else {
                break;
            }
        }
        if stamps.is_empty() {
            continue;
        }
        let text = rest.trim().to_string();
        for ms in stamps {
            out.push(LyricLine { time_ms: ms, text: text.clone() });
        }
    }
    out.sort_by_key(|l| l.time_ms);
    out
}

fn parse_stamp(s: &str) -> Option<u64> {
    // Accept mm:ss.xx, mm:ss.xxx, mm:ss
    let (mm, rest) = s.split_once(':')?;
    let mm: u64 = mm.parse().ok()?;
    let (ss, sub) = match rest.split_once('.') {
        Some((s, x)) => (s, x),
        None => (rest, "0"),
    };
    let ss: u64 = ss.parse().ok()?;
    if ss >= 60 {
        return None;
    }
    // Pad or truncate sub-second portion to 3 digits.
    let sub3: String = sub.chars().chain(std::iter::repeat('0')).take(3).collect();
    let sub_ms: u64 = sub3.parse().ok()?;
    Some(mm * 60_000 + ss * 1_000 + sub_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_lrc() {
        let lrc = "[00:00.00]intro\n[00:12.34]first line\n[01:05.5]later";
        let parsed = parse_synced(lrc);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].time_ms, 0);
        assert_eq!(parsed[1].time_ms, 12_340);
        assert_eq!(parsed[2].time_ms, 65_500);
        assert_eq!(parsed[1].text, "first line");
    }

    #[test]
    fn handles_multi_stamp_line() {
        let lrc = "[00:10.00][00:50.00]repeated";
        let parsed = parse_synced(lrc);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].time_ms, 10_000);
        assert_eq!(parsed[1].time_ms, 50_000);
        assert_eq!(parsed[0].text, "repeated");
    }

    #[test]
    fn drops_unstamped_lines() {
        let lrc = "no stamp here\n[00:01.00]stamped";
        let parsed = parse_synced(lrc);
        assert_eq!(parsed.len(), 1);
    }
}
