// JLPT reference-level lookup — data plane for the desktop learning
// cards' 「JLPT 参考等级」 badge.
//
// Data source: docs/schema/jlpt-vocab.md `v1` envelope, currently
// Bluskyo/JLPT_Vocabulary (MIT repo + Tanos CC BY upstream). Manifest +
// versioned brotli blob live in the LYRICLENS_DICTS KV namespace behind
// the dicts-cdn Worker (dicts.yoru-and-akari.dev).
//
// The Rust side just consumes this — we don't preprocess, we don't
// tokenize, and we don't ship the blob in the binary. Boot flow:
//
//   1. try manifest from cache dir (fast, offline-safe)
//   2. try manifest from the CDN (revalidate against latest version)
//   3. if manifest changed, download the versioned blob, sha256-verify,
//      brotli-decompress, cache to disk
//   4. load JSON into `HashMap<surface, Vec<JlptEntry>>` and hand back
//      to the setup hook, which parks it in Tauri State
//
// If step 2/3 fail but step 1 has a cached JSON on disk, we use that.
// If step 1 also has nothing, the store is empty and `lookup` returns
// `Vec::new()` — the frontend renders nothing (schema doc §UI 渲染规则
// explicitly says未命中 → 不显示 badge).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MANIFEST_CACHE_FILENAME: &str = "manifest.cache.json";
const JLPT_SUBDIR: &str = "jlpt";
const DEFAULT_MANIFEST_URL: &str = "https://dicts.yoru-and-akari.dev/jlpt/manifest.json";
const USER_AGENT: &str = "LyricLens-Desktop/0.1 (+https://lyriclens.yoru-and-akari.dev)";

#[derive(Debug, Error)]
pub enum JlptError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http: {0}")]
    Http(String),
    #[error("brotli decompress: {0}")]
    Brotli(String),
    #[error("integrity: {0}")]
    Integrity(String),
    #[error("validation: {0}")]
    Validation(String),
}

impl From<reqwest::Error> for JlptError {
    fn from(err: reqwest::Error) -> Self {
        JlptError::Http(err.to_string())
    }
}

// The one field the caller sees. `confidence` gets downgraded to
// `"source-surface"` at lookup time if the input included a `reading`
// but no candidate carried the exact same reading — the badge still
// renders but the frontend can decide whether to mark ambiguity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JlptEntry {
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
    pub source: String,
    pub confidence: String,
}

// Envelope shape produced by scripts/preprocess-jlpt.mjs. We only
// deserialize what we need — `license`, `source`, `generated_at`
// are metadata we don't currently show anywhere but preserving them
// (via `Value`) means future About-panel wiring is a pure UI change.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct JlptEnvelope {
    pub schema: u32,
    #[serde(default)]
    pub source: serde_json::Value,
    pub entries: HashMap<String, Vec<JlptEntry>>,
}

// `bytes` and `encoding` come along for the ride — we don't currently
// consult them (blob length is inferred from the body, and `encoding`
// is always "br" per schema doc §KV 结构) but keeping them decoded
// means future integrity / codec-switching code doesn't need a schema
// bump.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSource {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub encoding: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub latest: String,
    pub sources: HashMap<String, ManifestSource>,
}

impl Manifest {
    pub fn latest_source(&self) -> Result<&ManifestSource, JlptError> {
        self.sources.get(&self.latest).ok_or_else(|| {
            JlptError::Validation(format!(
                "manifest.sources missing entry for latest=\"{}\"",
                self.latest
            ))
        })
    }
}

#[derive(Debug)]
pub struct JlptStore {
    pub entries: HashMap<String, Vec<JlptEntry>>,
    pub version: String,
}

impl JlptStore {
    pub fn empty() -> Self {
        Self {
            entries: HashMap::new(),
            version: String::new(),
        }
    }

    pub fn from_envelope(env: JlptEnvelope, version: String) -> Result<Self, JlptError> {
        if env.schema != 1 {
            return Err(JlptError::Validation(format!(
                "unsupported envelope schema version: {}",
                env.schema
            )));
        }
        Ok(Self {
            entries: env.entries,
            version,
        })
    }

    // Three-tier lookup per docs/schema/jlpt-vocab.md §客户端 lookup 策略.
    // 1) exact(surface, reading) — highest confidence, returns entries
    //    whose stored reading matches the input reading exactly.
    // 2) exact(surface) — surface hits but reading doesn't match / isn't
    //    given. All candidates come back with confidence rewritten to
    //    "source-surface" so the UI can decide whether to show the
    //    ambiguity marker.
    // 3) miss — empty vec, UI renders no badge.
    pub fn lookup(&self, surface: &str, reading: Option<&str>) -> Vec<JlptEntry> {
        let Some(candidates) = self.entries.get(surface) else {
            return Vec::new();
        };
        if let Some(r) = reading {
            let matching: Vec<JlptEntry> = candidates
                .iter()
                .filter(|e| e.reading.as_deref() == Some(r))
                .cloned()
                .collect();
            if !matching.is_empty() {
                return matching;
            }
            // Surface matched, reading didn't — downgrade every returned
            // candidate's confidence label so the UI knows the reading
            // path didn't resolve.
            return candidates
                .iter()
                .cloned()
                .map(|mut e| {
                    e.confidence = "source-surface".to_string();
                    e
                })
                .collect();
        }
        candidates.clone()
    }
}

fn cache_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(JLPT_SUBDIR)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn decompress_brotli(compressed: &[u8]) -> Result<Vec<u8>, JlptError> {
    let mut out = Vec::with_capacity(compressed.len() * 6);
    let mut reader = brotli::Decompressor::new(compressed, 4096);
    std::io::copy(&mut reader, &mut out).map_err(|e| JlptError::Brotli(e.to_string()))?;
    Ok(out)
}

fn cached_blob_path(app_data_dir: &Path, sha256: &str) -> PathBuf {
    // Blob files are content-addressed by sha256 so a new manifest can
    // drop next to the old one, and stale versions age out naturally
    // (we never delete — the desktop cache dir is small and users
    // occasionally roll back).
    cache_dir(app_data_dir).join(format!("blob-{}.json", sha256))
}

fn cached_manifest_path(app_data_dir: &Path) -> PathBuf {
    cache_dir(app_data_dir).join(MANIFEST_CACHE_FILENAME)
}

// Read whatever we have on disk from a prior run. Returns Ok(None) if
// no cache exists yet — the "first-ever-run cold" path treats that as
// non-error.
pub fn load_cached_store(app_data_dir: &Path) -> Result<Option<JlptStore>, JlptError> {
    let manifest_path = cached_manifest_path(app_data_dir);
    if !manifest_path.exists() {
        return Ok(None);
    }
    let manifest_raw = std::fs::read(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)?;
    if manifest.schema != 1 {
        return Err(JlptError::Validation(format!(
            "unsupported cached manifest schema: {}",
            manifest.schema
        )));
    }
    let src = manifest.latest_source()?;
    let blob_path = cached_blob_path(app_data_dir, &src.sha256);
    if !blob_path.exists() {
        return Ok(None);
    }
    let blob_raw = std::fs::read(&blob_path)?;
    let env: JlptEnvelope = serde_json::from_slice(&blob_raw)?;
    Ok(Some(JlptStore::from_envelope(env, manifest.latest.clone())?))
}

// Persist a freshly-downloaded blob + manifest for the next cold start.
// The blob is cached decompressed — brotli decode dominates cold-start
// wall time and we've already paid that cost once.
pub fn persist_store(
    app_data_dir: &Path,
    manifest_raw: &[u8],
    blob_decompressed: &[u8],
    blob_sha256: &str,
) -> Result<(), JlptError> {
    let dir = cache_dir(app_data_dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(cached_manifest_path(app_data_dir), manifest_raw)?;
    std::fs::write(cached_blob_path(app_data_dir, blob_sha256), blob_decompressed)?;
    Ok(())
}

// Whole-fat bootstrap. On first run this hits the network; on repeat
// runs where the CDN manifest still points at the same blob we already
// cached, it short-circuits back to the disk cache in ~10ms.
//
// Any HTTP / integrity / io failure falls back to the cached copy if
// one exists — we never crash the app startup path for a JLPT badge.
// If neither path works, JlptStore::empty() is returned and the UI
// silently renders no badges (schema doc §UI 渲染规则).
pub async fn bootstrap(
    app_data_dir: &Path,
    manifest_url: Option<&str>,
    http_client: Option<reqwest::Client>,
) -> JlptStore {
    let url = manifest_url.unwrap_or(DEFAULT_MANIFEST_URL);
    let cached = load_cached_store(app_data_dir).unwrap_or(None);

    let client = match http_client {
        Some(c) => c,
        None => match reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(err) => {
                log::warn!("jlpt: reqwest client build failed: {err}; using cached store");
                return cached.unwrap_or_else(JlptStore::empty);
            }
        },
    };

    match refresh_from_network(app_data_dir, url, &client, cached.as_ref()).await {
        Ok(store) => store,
        Err(err) => {
            log::warn!("jlpt: network refresh failed: {err}; falling back to cache");
            cached.unwrap_or_else(JlptStore::empty)
        }
    }
}

async fn refresh_from_network(
    app_data_dir: &Path,
    manifest_url: &str,
    client: &reqwest::Client,
    cached: Option<&JlptStore>,
) -> Result<JlptStore, JlptError> {
    let manifest_res = client.get(manifest_url).send().await?;
    if !manifest_res.status().is_success() {
        return Err(JlptError::Http(format!(
            "manifest HTTP {}",
            manifest_res.status()
        )));
    }
    let manifest_bytes = manifest_res.bytes().await?.to_vec();
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.schema != 1 {
        return Err(JlptError::Validation(format!(
            "unsupported manifest schema: {}",
            manifest.schema
        )));
    }
    if let Some(existing) = cached {
        if existing.version == manifest.latest {
            // The blob on the CDN is still what we cached. No need to
            // download it again — reuse in-memory state (we already
            // paid the deserialize cost when we loaded the cache).
            return Ok(JlptStore {
                entries: existing.entries.clone(),
                version: existing.version.clone(),
            });
        }
    }

    let src = manifest.latest_source()?;
    let blob_res = client.get(&src.url).send().await?;
    if !blob_res.status().is_success() {
        return Err(JlptError::Http(format!("blob HTTP {}", blob_res.status())));
    }
    let blob_compressed = blob_res.bytes().await?.to_vec();
    let observed = sha256_hex(&blob_compressed);
    if observed != src.sha256 {
        return Err(JlptError::Integrity(format!(
            "blob sha256 mismatch: manifest={} observed={}",
            src.sha256, observed
        )));
    }
    let blob_decompressed = decompress_brotli(&blob_compressed)?;
    let env: JlptEnvelope = serde_json::from_slice(&blob_decompressed)?;

    persist_store(
        app_data_dir,
        &manifest_bytes,
        &blob_decompressed,
        &src.sha256,
    )?;

    JlptStore::from_envelope(env, manifest.latest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_store() -> JlptStore {
        let mut entries: HashMap<String, Vec<JlptEntry>> = HashMap::new();
        entries.insert(
            "挨拶".to_string(),
            vec![JlptEntry {
                level: "N3".to_string(),
                reading: Some("あいさつ".to_string()),
                source: "bluskyo".to_string(),
                confidence: "source".to_string(),
            }],
        );
        entries.insert(
            "あいさつ".to_string(),
            vec![JlptEntry {
                level: "N4".to_string(),
                reading: Some("あいさつ".to_string()),
                source: "bluskyo".to_string(),
                confidence: "source".to_string(),
            }],
        );
        entries.insert(
            "年".to_string(),
            vec![
                JlptEntry {
                    level: "N5".to_string(),
                    reading: Some("とし".to_string()),
                    source: "bluskyo".to_string(),
                    confidence: "source".to_string(),
                },
                JlptEntry {
                    level: "N4".to_string(),
                    reading: Some("ねん".to_string()),
                    source: "bluskyo".to_string(),
                    confidence: "source".to_string(),
                },
            ],
        );
        JlptStore {
            entries,
            version: "test-v1".to_string(),
        }
    }

    #[test]
    fn lookup_exact_surface_and_reading_returns_matching_entry() {
        let store = make_store();
        let hits = store.lookup("年", Some("とし"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].level, "N5");
        assert_eq!(hits[0].confidence, "source");
    }

    #[test]
    fn lookup_exact_surface_no_reading_returns_all_candidates() {
        let store = make_store();
        let hits = store.lookup("年", None);
        assert_eq!(hits.len(), 2);
        // Both candidates preserved, both with source-confidence.
        let levels: Vec<_> = hits.iter().map(|e| e.level.as_str()).collect();
        assert!(levels.contains(&"N5"));
        assert!(levels.contains(&"N4"));
        assert!(hits.iter().all(|e| e.confidence == "source"));
    }

    #[test]
    fn lookup_surface_hits_reading_misses_downgrades_confidence() {
        let store = make_store();
        // "年" exists but no candidate has reading "とせ"
        let hits = store.lookup("年", Some("とせ"));
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|e| e.confidence == "source-surface"));
    }

    #[test]
    fn lookup_miss_returns_empty() {
        let store = make_store();
        let hits = store.lookup("存在しない", Some("ぞんざい"));
        assert!(hits.is_empty());
        let hits2 = store.lookup("存在しない", None);
        assert!(hits2.is_empty());
    }

    #[test]
    fn lookup_distinguishes_kanji_and_kana_keys() {
        // Schema-doc example: "挨拶" hits N3, "あいさつ" hits N4.
        // The store treats them as independent surface keys.
        let store = make_store();
        let kanji = store.lookup("挨拶", Some("あいさつ"));
        assert_eq!(kanji.len(), 1);
        assert_eq!(kanji[0].level, "N3");
        let kana = store.lookup("あいさつ", Some("あいさつ"));
        assert_eq!(kana.len(), 1);
        assert_eq!(kana[0].level, "N4");
    }

    #[test]
    fn from_envelope_rejects_wrong_schema() {
        let env = JlptEnvelope {
            schema: 99,
            source: json!(null),
            entries: HashMap::new(),
        };
        let err = JlptStore::from_envelope(env, "v99".to_string()).unwrap_err();
        assert!(matches!(err, JlptError::Validation(_)));
    }

    #[test]
    fn manifest_latest_source_missing_is_validation_error() {
        let m = Manifest {
            schema: 1,
            latest: "ghost-v1".to_string(),
            sources: HashMap::new(),
        };
        let err = m.latest_source().unwrap_err();
        assert!(matches!(err, JlptError::Validation(_)));
    }

    #[test]
    fn manifest_latest_source_present_returns_it() {
        let mut sources = HashMap::new();
        sources.insert(
            "bluskyo-abc.v1".to_string(),
            ManifestSource {
                url: "https://example.com/blob.json.br".to_string(),
                sha256: "deadbeef".to_string(),
                bytes: 100,
                encoding: "br".to_string(),
            },
        );
        let m = Manifest {
            schema: 1,
            latest: "bluskyo-abc.v1".to_string(),
            sources,
        };
        let src = m.latest_source().unwrap();
        assert_eq!(src.sha256, "deadbeef");
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // "abc" → ba7816bf...
        // (nist test vector, hex-encoded)
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn decompress_brotli_roundtrips_a_tiny_payload() {
        // Compress with the standalone brotli::CompressorReader; if we
        // can decompress what our sibling encoder produces, the same
        // path decompresses what preprocess-jlpt.mjs's brotli-quality-11
        // output produces (they're bit-compatible per RFC 7932).
        let raw = b"{\"schema\":1,\"entries\":{}}";
        let mut compressed = Vec::new();
        {
            let mut writer =
                brotli::CompressorWriter::new(&mut compressed, 4096, 11, 22);
            use std::io::Write;
            writer.write_all(raw).unwrap();
        }
        let out = decompress_brotli(&compressed).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn envelope_deserializes_from_realistic_json() {
        let raw = r#"{
            "schema": 1,
            "generated_at": "2026-07-01T00:00:00Z",
            "source": { "name": "Bluskyo/JLPT_Vocabulary", "version": "d29a678" },
            "entries": {
                "挨拶": [{ "level": "N3", "reading": "あいさつ", "source": "bluskyo", "confidence": "source" }]
            }
        }"#;
        let env: JlptEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.schema, 1);
        assert_eq!(env.entries["挨拶"][0].level, "N3");
        assert_eq!(
            env.entries["挨拶"][0].reading.as_deref(),
            Some("あいさつ")
        );
    }

    #[test]
    fn store_round_trips_through_persist_and_load() {
        // Simulate a bootstrap: write manifest.cache.json + a
        // decompressed blob-<sha>.json into a tmpdir, then load them
        // back and confirm the store has the entries.
        let tmp = std::env::temp_dir().join(format!(
            "lyriclens-jlpt-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let blob_json = r#"{"schema":1,"entries":{"挨拶":[{"level":"N3","reading":"あいさつ","source":"bluskyo","confidence":"source"}]}}"#;
        let blob_bytes = blob_json.as_bytes();
        let blob_sha = sha256_hex(blob_bytes);
        let manifest_json = format!(
            r#"{{"schema":1,"latest":"bluskyo-test.v1","sources":{{"bluskyo-test.v1":{{"url":"file://none","sha256":"{}","bytes":{},"encoding":"br"}}}}}}"#,
            blob_sha,
            blob_bytes.len()
        );

        persist_store(&tmp, manifest_json.as_bytes(), blob_bytes, &blob_sha).unwrap();
        let store = load_cached_store(&tmp).unwrap().unwrap();
        assert_eq!(store.version, "bluskyo-test.v1");
        assert_eq!(store.entries["挨拶"][0].level, "N3");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
