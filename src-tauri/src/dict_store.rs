// Generic KV-dictionary data plane, extracted from jlpt.rs when the
// enexam vertical arrived with a byte-identical bootstrap story.
//
// Every reference-dictionary family (jlpt, enexam, cefrj someday)
// shares the same distribution shape, locked in docs/schema/*.md of
// the parent repo:
//
//   dicts.yoru-and-akari.dev/<family>/manifest.json
//   dicts.yoru-and-akari.dev/<family>/<name>.<version>.json.br
//
// and the same client bootstrap:
//
//   1. try manifest from cache dir (fast, offline-safe)
//   2. try manifest from the CDN (revalidate against latest version)
//   3. if manifest changed, download the versioned blob, sha256-verify,
//      brotli-decompress, cache to disk
//   4. deserialize into DictStore<V> and park it in Tauri State
//
// What varies per family is only the entry value type V (jlpt:
// Vec<JlptEntry>, enexam: Vec<String>) and the lookup semantics, which
// live in the family modules as `impl DictStore<TheirV>` blocks.
//
// Failure policy is inherited unchanged from the jlpt original: any
// HTTP / integrity / io failure falls back to the cached copy if one
// exists; if there's no cache either, an empty store is returned and
// the UI renders no badges. Never crash app startup for a badge.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MANIFEST_CACHE_FILENAME: &str = "manifest.cache.json";
const USER_AGENT: &str = "LyricLens-Desktop/0.1 (+https://lyriclens.yoru-and-akari.dev)";

// Per-family knobs. `family` doubles as the cache subdirectory under
// app_data_dir and the log prefix, so keep it short and path-safe.
pub struct DictConfig {
    pub family: &'static str,
    pub manifest_url: &'static str,
}

#[derive(Debug, Error)]
pub enum DictError {
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

impl From<reqwest::Error> for DictError {
    fn from(err: reqwest::Error) -> Self {
        DictError::Http(err.to_string())
    }
}

// Envelope shape produced by the parent repo's preprocess-*.mjs
// scripts. Metadata fields (license, source(s), generated_at) exist in
// the JSON but nothing reads them yet, so serde just skips them; when
// the About panel learns to show provenance, add the fields back here.
#[derive(Debug, Clone, Deserialize)]
pub struct Envelope<V> {
    pub schema: u32,
    pub entries: HashMap<String, V>,
}

// `bytes` and `encoding` come along for the ride — we don't currently
// consult them (blob length is inferred from the body, and `encoding`
// is always "br" per the schema docs) but keeping them decoded means
// future integrity / codec-switching code doesn't need a schema bump.
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
    pub fn latest_source(&self) -> Result<&ManifestSource, DictError> {
        self.sources.get(&self.latest).ok_or_else(|| {
            DictError::Validation(format!(
                "manifest.sources missing entry for latest=\"{}\"",
                self.latest
            ))
        })
    }
}

#[derive(Debug)]
pub struct DictStore<V> {
    pub entries: HashMap<String, V>,
    pub version: String,
}

impl<V> DictStore<V> {
    pub fn empty() -> Self {
        Self {
            entries: HashMap::new(),
            version: String::new(),
        }
    }

    pub fn from_envelope(env: Envelope<V>, version: String) -> Result<Self, DictError> {
        if env.schema != 1 {
            return Err(DictError::Validation(format!(
                "unsupported envelope schema version: {}",
                env.schema
            )));
        }
        Ok(Self {
            entries: env.entries,
            version,
        })
    }
}

fn cache_dir(cfg: &DictConfig, app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(cfg.family)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn decompress_brotli(compressed: &[u8]) -> Result<Vec<u8>, DictError> {
    let mut out = Vec::with_capacity(compressed.len() * 6);
    let mut reader = brotli::Decompressor::new(compressed, 4096);
    std::io::copy(&mut reader, &mut out).map_err(|e| DictError::Brotli(e.to_string()))?;
    Ok(out)
}

fn cached_blob_path(cfg: &DictConfig, app_data_dir: &Path, sha256: &str) -> PathBuf {
    // Blob files are content-addressed by sha256 so a new manifest can
    // drop next to the old one, and stale versions age out naturally
    // (we never delete — the desktop cache dir is small and users
    // occasionally roll back).
    cache_dir(cfg, app_data_dir).join(format!("blob-{}.json", sha256))
}

fn cached_manifest_path(cfg: &DictConfig, app_data_dir: &Path) -> PathBuf {
    cache_dir(cfg, app_data_dir).join(MANIFEST_CACHE_FILENAME)
}

// Read whatever we have on disk from a prior run. Returns Ok(None) if
// no cache exists yet — the "first-ever-run cold" path treats that as
// non-error.
pub fn load_cached_store<V: DeserializeOwned>(
    cfg: &DictConfig,
    app_data_dir: &Path,
) -> Result<Option<DictStore<V>>, DictError> {
    let manifest_path = cached_manifest_path(cfg, app_data_dir);
    if !manifest_path.exists() {
        return Ok(None);
    }
    let manifest_raw = std::fs::read(&manifest_path)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)?;
    if manifest.schema != 1 {
        return Err(DictError::Validation(format!(
            "unsupported cached manifest schema: {}",
            manifest.schema
        )));
    }
    let src = manifest.latest_source()?;
    let blob_path = cached_blob_path(cfg, app_data_dir, &src.sha256);
    if !blob_path.exists() {
        return Ok(None);
    }
    let blob_raw = std::fs::read(&blob_path)?;
    let env: Envelope<V> = serde_json::from_slice(&blob_raw)?;
    Ok(Some(DictStore::from_envelope(env, manifest.latest.clone())?))
}

// Persist a freshly-downloaded blob + manifest for the next cold start.
// The blob is cached decompressed — brotli decode dominates cold-start
// wall time and we've already paid that cost once.
pub fn persist_store(
    cfg: &DictConfig,
    app_data_dir: &Path,
    manifest_raw: &[u8],
    blob_decompressed: &[u8],
    blob_sha256: &str,
) -> Result<(), DictError> {
    let dir = cache_dir(cfg, app_data_dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(cached_manifest_path(cfg, app_data_dir), manifest_raw)?;
    std::fs::write(
        cached_blob_path(cfg, app_data_dir, blob_sha256),
        blob_decompressed,
    )?;
    Ok(())
}

// Whole-fat bootstrap. On first run this hits the network; on repeat
// runs where the CDN manifest still points at the same blob we already
// cached, it short-circuits back to the disk cache in ~10ms.
pub async fn bootstrap<V: DeserializeOwned + Clone>(
    cfg: &DictConfig,
    app_data_dir: &Path,
    manifest_url: Option<&str>,
    http_client: Option<reqwest::Client>,
) -> DictStore<V> {
    let url = manifest_url.unwrap_or(cfg.manifest_url);
    let cached = load_cached_store::<V>(cfg, app_data_dir).unwrap_or(None);

    let client = match http_client {
        Some(c) => c,
        None => match reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(err) => {
                log::warn!(
                    "{}: reqwest client build failed: {err}; using cached store",
                    cfg.family
                );
                return cached.unwrap_or_else(DictStore::empty);
            }
        },
    };

    match refresh_from_network(cfg, app_data_dir, url, &client, cached.as_ref()).await {
        Ok(store) => store,
        Err(err) => {
            log::warn!(
                "{}: network refresh failed: {err}; falling back to cache",
                cfg.family
            );
            cached.unwrap_or_else(DictStore::empty)
        }
    }
}

async fn refresh_from_network<V: DeserializeOwned + Clone>(
    cfg: &DictConfig,
    app_data_dir: &Path,
    manifest_url: &str,
    client: &reqwest::Client,
    cached: Option<&DictStore<V>>,
) -> Result<DictStore<V>, DictError> {
    let manifest_res = client.get(manifest_url).send().await?;
    if !manifest_res.status().is_success() {
        return Err(DictError::Http(format!(
            "manifest HTTP {}",
            manifest_res.status()
        )));
    }
    let manifest_bytes = manifest_res.bytes().await?.to_vec();
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.schema != 1 {
        return Err(DictError::Validation(format!(
            "unsupported manifest schema: {}",
            manifest.schema
        )));
    }
    if let Some(existing) = cached {
        if existing.version == manifest.latest {
            // The blob on the CDN is still what we cached. No need to
            // download it again — reuse in-memory state (we already
            // paid the deserialize cost when we loaded the cache).
            return Ok(DictStore {
                entries: existing.entries.clone(),
                version: existing.version.clone(),
            });
        }
    }

    let src = manifest.latest_source()?;
    let blob_res = client.get(&src.url).send().await?;
    if !blob_res.status().is_success() {
        return Err(DictError::Http(format!("blob HTTP {}", blob_res.status())));
    }
    let blob_compressed = blob_res.bytes().await?.to_vec();
    let observed = sha256_hex(&blob_compressed);
    if observed != src.sha256 {
        return Err(DictError::Integrity(format!(
            "blob sha256 mismatch: manifest={} observed={}",
            src.sha256, observed
        )));
    }
    let blob_decompressed = decompress_brotli(&blob_compressed)?;
    let env: Envelope<V> = serde_json::from_slice(&blob_decompressed)?;

    persist_store(
        cfg,
        app_data_dir,
        &manifest_bytes,
        &blob_decompressed,
        &src.sha256,
    )?;

    DictStore::from_envelope(env, manifest.latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_CFG: DictConfig = DictConfig {
        family: "dicttest",
        manifest_url: "https://example.invalid/dicttest/manifest.json",
    };

    #[test]
    fn from_envelope_rejects_wrong_schema() {
        let env: Envelope<Vec<String>> = Envelope {
            schema: 99,
            entries: HashMap::new(),
        };
        let err = DictStore::from_envelope(env, "v99".to_string()).unwrap_err();
        assert!(matches!(err, DictError::Validation(_)));
    }

    #[test]
    fn manifest_latest_source_missing_is_validation_error() {
        let m = Manifest {
            schema: 1,
            latest: "ghost-v1".to_string(),
            sources: HashMap::new(),
        };
        let err = m.latest_source().unwrap_err();
        assert!(matches!(err, DictError::Validation(_)));
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
        // "abc" → ba7816bf... (nist test vector, hex-encoded)
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn decompress_brotli_roundtrips_a_tiny_payload() {
        // Compress with the standalone brotli::CompressorWriter; if we
        // can decompress what our sibling encoder produces, the same
        // path decompresses what the preprocess scripts' brotli-
        // quality-11 output produces (bit-compatible per RFC 7932).
        let raw = b"{\"schema\":1,\"entries\":{}}";
        let mut compressed = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 11, 22);
            use std::io::Write;
            writer.write_all(raw).unwrap();
        }
        let out = decompress_brotli(&compressed).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn store_round_trips_through_persist_and_load() {
        // Simulate a bootstrap for a Vec<String>-valued family (the
        // enexam shape): write manifest.cache.json + a decompressed
        // blob-<sha>.json into a tmpdir, then load them back.
        let tmp = std::env::temp_dir().join(format!(
            "lyriclens-dictstore-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let blob_json = r#"{"schema":1,"entries":{"abandon":["gaokao","cet4","kaoyan"]}}"#;
        let blob_bytes = blob_json.as_bytes();
        let blob_sha = sha256_hex(blob_bytes);
        let manifest_json = format!(
            r#"{{"schema":1,"latest":"multi-test.v1","sources":{{"multi-test.v1":{{"url":"file://none","sha256":"{}","bytes":{},"encoding":"br"}}}}}}"#,
            blob_sha,
            blob_bytes.len()
        );

        persist_store(&TEST_CFG, &tmp, manifest_json.as_bytes(), blob_bytes, &blob_sha).unwrap();
        let store = load_cached_store::<Vec<String>>(&TEST_CFG, &tmp)
            .unwrap()
            .unwrap();
        assert_eq!(store.version, "multi-test.v1");
        assert_eq!(store.entries["abandon"], vec!["gaokao", "cet4", "kaoyan"]);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_cached_store_missing_dir_is_none() {
        let tmp = std::env::temp_dir().join(format!(
            "lyriclens-dictstore-missing-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let loaded = load_cached_store::<Vec<String>>(&TEST_CFG, &tmp).unwrap();
        assert!(loaded.is_none());
    }
}
