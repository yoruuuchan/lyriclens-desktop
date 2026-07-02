// CEFR-J reference-level lookup — data plane for the learning cards'
// 「CEFR-J 参考等级」 badge (A1 / A2 / B1 / B2).
//
// Data source: parent repo docs/schema/cefrj-vocab.md `v1` envelope —
// single verified source (olp-en-cefrj vocabulary profile 1.5, Tono
// Lab TUFS) preprocessed by scripts/preprocess-cefrj.mjs. Same
// manifest + brotli blob distribution as JLPT/enexam, family prefix
// "cefrj/".
//
// The generic fetch/cache/verify bootstrap lives in dict_store.rs;
// this module owns only the cefrj lookup semantics: lowercase exact
// match, word → level. Unlike enexam there is no client-side filter —
// the badge renders unconditionally on hit, symmetric with JLPT
// (schema doc §UI 渲染规则).

use crate::dict_store::{self, DictConfig, DictStore};

pub const CONFIG: DictConfig = DictConfig {
    family: "cefrj",
    manifest_url: "https://dicts.yoru-and-akari.dev/cefrj/manifest.json",
};

pub type CefrjStore = DictStore<String>;

impl DictStore<String> {
    // Lookup per docs/schema/cefrj-vocab.md §客户端 lookup 策略:
    // lowercase → exact match → miss returns None (UI renders no
    // badge). No lemmatization — the LLM prompt already asks for base
    // forms, same decision as JLPT/enexam.
    pub fn lookup_level(&self, word: &str) -> Option<String> {
        let normalized = word.trim().to_lowercase();
        self.entries.get(&normalized).cloned()
    }
}

pub async fn bootstrap(
    app_data_dir: &std::path::Path,
    manifest_url: Option<&str>,
    http_client: Option<reqwest::Client>,
) -> CefrjStore {
    dict_store::bootstrap::<String>(&CONFIG, app_data_dir, manifest_url, http_client).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dict_store::Envelope;
    use std::collections::HashMap;

    fn make_store() -> CefrjStore {
        let mut entries: HashMap<String, String> = HashMap::new();
        entries.insert("above".to_string(), "A1".to_string());
        entries.insert("abandon".to_string(), "B1".to_string());
        entries.insert("according to".to_string(), "B1".to_string());
        CefrjStore {
            entries,
            version: "olp-test.v1".to_string(),
        }
    }

    #[test]
    fn lookup_exact_word_returns_level() {
        let store = make_store();
        assert_eq!(store.lookup_level("abandon"), Some("B1".to_string()));
    }

    #[test]
    fn lookup_normalizes_case_and_whitespace() {
        // Sentence-initial capitalization and stray whitespace from the
        // LLM's vocabulary points; the store key space is all-lowercase
        // by pipeline construction.
        let store = make_store();
        assert_eq!(store.lookup_level("Above"), Some("A1".to_string()));
        assert_eq!(store.lookup_level("  ABANDON  "), Some("B1".to_string()));
    }

    #[test]
    fn lookup_matches_phrases() {
        // The CEFR-J profile has hand-curated multi-word entries
        // ("according to", "alarm clock") — exact match covers them.
        let store = make_store();
        assert_eq!(
            store.lookup_level("According to"),
            Some("B1".to_string())
        );
    }

    #[test]
    fn lookup_miss_returns_none() {
        let store = make_store();
        assert_eq!(store.lookup_level("nonexistentword"), None);
        assert_eq!(store.lookup_level(""), None);
        // Japanese surfaces miss the all-English key space naturally —
        // that's the whole language-detection story (there isn't one).
        assert_eq!(store.lookup_level("食べる"), None);
    }

    #[test]
    fn envelope_deserializes_from_realistic_json() {
        // Mirrors the actual preprocess-cefrj.mjs output shape
        // (metadata fields present but skipped by the generic Envelope).
        let raw = r#"{
            "schema": 1,
            "generated_at": "2026-07-01T23:46:02.272Z",
            "license": "CEFR-J Wordlist v1.5 (Tono Lab, TUFS) — free for research & commercial use with citation; headwords + levels only",
            "sources": { "olp-en-cefrj": "c5c6a64" },
            "entries": {
                "above": "A1",
                "abandon": "B1",
                "café": "A1",
                "cafe": "A1"
            }
        }"#;
        let env: Envelope<String> = serde_json::from_str(raw).unwrap();
        assert_eq!(env.schema, 1);
        assert_eq!(env.entries["above"], "A1");
        assert_eq!(env.entries["café"], "A1");
        assert_eq!(env.entries["cafe"], "A1");
    }

    #[test]
    fn store_round_trips_through_persist_and_load() {
        let tmp = std::env::temp_dir().join(format!(
            "lyriclens-cefrj-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let blob_json = r#"{"schema":1,"entries":{"above":"A1","abandon":"B1"}}"#;
        let blob_bytes = blob_json.as_bytes();
        let blob_sha = dict_store::sha256_hex(blob_bytes);
        let manifest_json = format!(
            r#"{{"schema":1,"latest":"olp-c5c6a64.v1","sources":{{"olp-c5c6a64.v1":{{"url":"file://none","sha256":"{}","bytes":{},"encoding":"br"}}}}}}"#,
            blob_sha,
            blob_bytes.len()
        );

        dict_store::persist_store(&CONFIG, &tmp, manifest_json.as_bytes(), blob_bytes, &blob_sha)
            .unwrap();
        let store = dict_store::load_cached_store::<String>(&CONFIG, &tmp)
            .unwrap()
            .unwrap();
        assert_eq!(store.version, "olp-c5c6a64.v1");
        assert_eq!(store.lookup_level("above"), Some("A1".to_string()));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
