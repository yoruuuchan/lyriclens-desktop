// JLPT reference-level lookup — data plane for the desktop learning
// cards' 「JLPT 参考等级」 badge.
//
// Data source: docs/schema/jlpt-vocab.md `v1` envelope, currently
// Bluskyo/JLPT_Vocabulary (MIT repo + Tanos CC BY upstream). Manifest +
// versioned brotli blob live in the LYRICLENS_DICTS KV namespace behind
// the dicts-cdn Worker (dicts.yoru-and-akari.dev).
//
// The generic fetch/cache/verify bootstrap lives in dict_store.rs
// (shared with the enexam family); this module owns only what is
// JLPT-specific — the entry shape and the three-tier lookup semantics.

use serde::{Deserialize, Serialize};

use crate::dict_store::{self, DictConfig, DictStore};

pub const CONFIG: DictConfig = DictConfig {
    family: "jlpt",
    manifest_url: "https://dicts.yoru-and-akari.dev/jlpt/manifest.json",
};

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

pub type JlptStore = DictStore<Vec<JlptEntry>>;

impl DictStore<Vec<JlptEntry>> {
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

// Signature kept identical to the pre-dict_store version so lib.rs and
// its setup hook didn't have to change.
pub async fn bootstrap(
    app_data_dir: &std::path::Path,
    manifest_url: Option<&str>,
    http_client: Option<reqwest::Client>,
) -> JlptStore {
    dict_store::bootstrap::<Vec<JlptEntry>>(&CONFIG, app_data_dir, manifest_url, http_client).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dict_store::Envelope;
    use std::collections::HashMap;

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
    fn envelope_deserializes_from_realistic_json() {
        let raw = r#"{
            "schema": 1,
            "generated_at": "2026-07-01T00:00:00Z",
            "source": { "name": "Bluskyo/JLPT_Vocabulary", "version": "d29a678" },
            "entries": {
                "挨拶": [{ "level": "N3", "reading": "あいさつ", "source": "bluskyo", "confidence": "source" }]
            }
        }"#;
        let env: Envelope<Vec<JlptEntry>> = serde_json::from_str(raw).unwrap();
        assert_eq!(env.schema, 1);
        assert_eq!(env.entries["挨拶"][0].level, "N3");
        assert_eq!(env.entries["挨拶"][0].reading.as_deref(), Some("あいさつ"));
    }

    #[test]
    fn store_round_trips_through_persist_and_load() {
        // Jlpt-shaped persist/load through the generic dict_store layer —
        // guards the JlptEntry serde shape end to end.
        let tmp = std::env::temp_dir().join(format!("lyriclens-jlpt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let blob_json = r#"{"schema":1,"entries":{"挨拶":[{"level":"N3","reading":"あいさつ","source":"bluskyo","confidence":"source"}]}}"#;
        let blob_bytes = blob_json.as_bytes();
        let blob_sha = dict_store::sha256_hex(blob_bytes);
        let manifest_json = format!(
            r#"{{"schema":1,"latest":"bluskyo-test.v1","sources":{{"bluskyo-test.v1":{{"url":"file://none","sha256":"{}","bytes":{},"encoding":"br"}}}}}}"#,
            blob_sha,
            blob_bytes.len()
        );

        dict_store::persist_store(&CONFIG, &tmp, manifest_json.as_bytes(), blob_bytes, &blob_sha)
            .unwrap();
        let store = dict_store::load_cached_store::<Vec<JlptEntry>>(&CONFIG, &tmp)
            .unwrap()
            .unwrap();
        assert_eq!(store.version, "bluskyo-test.v1");
        assert_eq!(store.entries["挨拶"][0].level, "N3");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
