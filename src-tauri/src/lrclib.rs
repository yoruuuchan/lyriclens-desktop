// LRCLIB client.
//
// API docs: https://lrclib.net/docs
// We use the /api/get endpoint with track_name, artist_name, album_name,
// duration. LRCLIB matches with a tolerance of ±2s on duration and a
// normalized comparison on artist/track names. If /api/get misses, fall
// back to /api/search and pick the best candidate.

use serde::{Deserialize, Serialize};

const BASE_URL: &str = "https://lrclib.net/api";
const USER_AGENT: &str = concat!(
    "LyricLens-Desktop/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/yoruuuchan/LyricLens)",
);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricResult {
    pub id: i64,
    pub track_name: String,
    pub artist_name: String,
    pub album_name: Option<String>,
    pub duration: Option<f64>,
    pub instrumental: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum LrcError {
    #[error("not found")]
    NotFound,
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unexpected status: {0}")]
    Status(u16),
}

fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
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

    let resp = req.send().await?;
    match resp.status().as_u16() {
        200 => Ok(resp.json::<LyricResult>().await?),
        404 => Err(LrcError::NotFound),
        s => Err(LrcError::Status(s)),
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SearchCandidate {
    id: i64,
    #[serde(rename = "trackName")]
    track_name: String,
    #[serde(rename = "artistName")]
    artist_name: String,
    #[serde(rename = "albumName", default)]
    album_name: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    instrumental: bool,
    #[serde(rename = "plainLyrics", default)]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics", default)]
    synced_lyrics: Option<String>,
}

/// Fallback search when /api/get misses. Returns the closest match by
/// duration if one is within 5 seconds, else the first candidate.
pub async fn search(
    track_name: &str,
    artist_name: &str,
    duration_secs: Option<f64>,
) -> Result<LyricResult, LrcError> {
    let client = client()?;
    let resp = client
        .get(format!("{}/search", BASE_URL))
        .query(&[("track_name", track_name), ("artist_name", artist_name)])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(LrcError::Status(resp.status().as_u16()));
    }
    let candidates: Vec<SearchCandidate> = resp.json().await?;
    if candidates.is_empty() {
        return Err(LrcError::NotFound);
    }

    let pick = if let Some(target) = duration_secs {
        candidates
            .iter()
            .min_by(|a, b| {
                let da = a.duration.map(|d| (d - target).abs()).unwrap_or(f64::INFINITY);
                let db = b.duration.map(|d| (d - target).abs()).unwrap_or(f64::INFINITY);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap()
    } else {
        &candidates[0]
    };

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

#[derive(Debug, Clone, Serialize)]
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
