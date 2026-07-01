// English exam reference-tag lookup — data plane for the learning
// cards' 「考试参考标签」 badge (高考 / CET-4 / CET-6 / 考研).
//
// Data source: parent repo docs/schema/en-exam-vocab.md `v1` envelope —
// three MIT sources cross-verified (cet-word-list × ECDICT × word3500)
// by scripts/preprocess-enexam.mjs. Same manifest + brotli blob
// distribution as JLPT, family prefix "enexam/".
//
// The generic fetch/cache/verify bootstrap lives in dict_store.rs;
// this module owns only the enexam lookup semantics: lowercase exact
// match, word → tags[]. Which tag (if any) actually renders is the
// frontend's call — it filters by the user's `targetExam` setting and
// shows nothing when the setting is off (schema doc §UI 渲染规则).

use crate::dict_store::{self, DictConfig, DictStore};

pub const CONFIG: DictConfig = DictConfig {
    family: "enexam",
    manifest_url: "https://dicts.yoru-and-akari.dev/enexam/manifest.json",
};

pub type EnexamStore = DictStore<Vec<String>>;

impl DictStore<Vec<String>> {
    // Lookup per docs/schema/en-exam-vocab.md §客户端 lookup 策略:
    // lowercase → exact match → miss returns empty (UI renders no
    // badge). No lemmatization — the LLM prompt already asks for base
    // forms, same decision as JLPT's "no tokenization".
    pub fn lookup_tags(&self, word: &str) -> Vec<String> {
        let normalized = word.trim().to_lowercase();
        self.entries.get(&normalized).cloned().unwrap_or_default()
    }
}

pub async fn bootstrap(
    app_data_dir: &std::path::Path,
    manifest_url: Option<&str>,
    http_client: Option<reqwest::Client>,
) -> EnexamStore {
    dict_store::bootstrap::<Vec<String>>(&CONFIG, app_data_dir, manifest_url, http_client).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dict_store::Envelope;
    use std::collections::HashMap;

    fn make_store() -> EnexamStore {
        let mut entries: HashMap<String, Vec<String>> = HashMap::new();
        entries.insert(
            "abandon".to_string(),
            vec!["gaokao".to_string(), "cet4".to_string(), "kaoyan".to_string()],
        );
        entries.insert("fabrication".to_string(), vec!["cet6".to_string()]);
        EnexamStore {
            entries,
            version: "multi-test.v1".to_string(),
        }
    }

    #[test]
    fn lookup_exact_word_returns_tags_in_stored_order() {
        let store = make_store();
        let tags = store.lookup_tags("abandon");
        assert_eq!(tags, vec!["gaokao", "cet4", "kaoyan"]);
    }

    #[test]
    fn lookup_normalizes_case_and_whitespace() {
        // The LLM's vocabulary points occasionally arrive capitalized
        // (sentence-initial words) or with stray whitespace; the store
        // key space is all-lowercase by pipeline construction.
        let store = make_store();
        assert_eq!(store.lookup_tags("Abandon"), vec!["gaokao", "cet4", "kaoyan"]);
        assert_eq!(store.lookup_tags("  ABANDON  "), vec!["gaokao", "cet4", "kaoyan"]);
    }

    #[test]
    fn lookup_miss_returns_empty() {
        let store = make_store();
        assert!(store.lookup_tags("nonexistentword").is_empty());
        assert!(store.lookup_tags("").is_empty());
    }

    #[test]
    fn envelope_deserializes_from_realistic_json() {
        // Mirrors the actual preprocess-enexam.mjs output shape
        // (metadata fields present but skipped by the generic Envelope).
        let raw = r#"{
            "schema": 1,
            "generated_at": "2026-07-01T22:54:27.910Z",
            "license": "MIT sources, cross-verified; headwords + tags only",
            "sources": { "cet-word-list": "f18dedd", "ECDICT": "82c9872", "word3500": "36da565" },
            "entries": {
                "abandon": ["gaokao", "cet4", "kaoyan"],
                "abolish": ["gaokao", "cet6", "kaoyan"]
            }
        }"#;
        let env: Envelope<Vec<String>> = serde_json::from_str(raw).unwrap();
        assert_eq!(env.schema, 1);
        assert_eq!(env.entries["abandon"], vec!["gaokao", "cet4", "kaoyan"]);
        assert_eq!(env.entries["abolish"], vec!["gaokao", "cet6", "kaoyan"]);
    }

    #[test]
    fn store_round_trips_through_persist_and_load() {
        let tmp = std::env::temp_dir().join(format!(
            "lyriclens-enexam-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let blob_json = r#"{"schema":1,"entries":{"abandon":["gaokao","cet4","kaoyan"]}}"#;
        let blob_bytes = blob_json.as_bytes();
        let blob_sha = dict_store::sha256_hex(blob_bytes);
        let manifest_json = format!(
            r#"{{"schema":1,"latest":"multi-20260701.v1","sources":{{"multi-20260701.v1":{{"url":"file://none","sha256":"{}","bytes":{},"encoding":"br"}}}}}}"#,
            blob_sha,
            blob_bytes.len()
        );

        dict_store::persist_store(&CONFIG, &tmp, manifest_json.as_bytes(), blob_bytes, &blob_sha)
            .unwrap();
        let store = dict_store::load_cached_store::<Vec<String>>(&CONFIG, &tmp)
            .unwrap()
            .unwrap();
        assert_eq!(store.version, "multi-20260701.v1");
        assert_eq!(store.lookup_tags("abandon"), vec!["gaokao", "cet4", "kaoyan"]);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
