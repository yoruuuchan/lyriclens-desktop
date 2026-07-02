// Typed shim over the Rust `cefrj_lookup` command for the CEFR-J
// reference-level badge.
//
// Store side of the world (src-tauri/src/cefrj.rs) does the network
// bootstrap, sha256, brotli decompression, and HashMap lookup. This
// module is deliberately thin: a typed call plus the badge tooltip
// constant. Unlike enexam there is no filter setting — main.ts renders
// the badge unconditionally on hit, symmetric with JLPT (docs/schema/
// cefrj-vocab.md §UI 渲染规则).

import { invoke } from "@tauri-apps/api/core";

export type CefrjLevel = "A1" | "A2" | "B1" | "B2";

// Wording locked by the schema doc's 文案红线: CEFR-J is Tono Lab's
// Japan-adapted framework, never "CEFR 官方 / 欧标认证"; and our
// snapshot is reference info, not an official endorsement.
export const CEFRJ_BADGE_TITLE =
  "CEFR-J 参考等级 · 数据 © Tono Lab (TUFS)";

export async function cefrjLookup(word: string): Promise<string | null> {
  if (!word || !word.trim()) return null;
  try {
    return await invoke<string | null>("cefrj_lookup", { word });
  } catch {
    // CEFR badges are a nice-to-have. A store that hasn't finished
    // bootstrapping (or a Rust-side error) should render as "no badge",
    // not surface a user-visible failure.
    return null;
  }
}
