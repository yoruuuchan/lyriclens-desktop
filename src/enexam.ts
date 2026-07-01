// Typed shim over the Rust `enexam_lookup` command + display-label
// mapping for the English exam reference-tag badge.
//
// Store side of the world (src-tauri/src/enexam.rs) does the network
// bootstrap, sha256, brotli decompression, and HashMap lookup. This
// module is deliberately thin: a typed call plus the tag → label
// table. Which tag (if any) actually renders is main.ts's call — it
// filters by the user's targetExam setting per docs/schema/
// en-exam-vocab.md §UI 渲染规则.

import { invoke } from "@tauri-apps/api/core";

export type ExamTag = "gaokao" | "cet4" | "cet6" | "kaoyan";
export type TargetExam = "off" | ExamTag;

export const TARGET_EXAMS: TargetExam[] = [
  "off", "gaokao", "cet4", "cet6", "kaoyan",
];

// Badge pill text. Deliberately short — it sits in the same third
// column as the JLPT badge and long labels would wrap the point-row.
export const EXAM_TAG_LABELS: Record<ExamTag, string> = {
  gaokao: "高考",
  cet4: "CET-4",
  cet6: "CET-6",
  kaoyan: "考研",
};

// Wording locked by the schema doc's 文案红线: reference labels from
// community-derived word lists, never "官方词表 / 官方授权".
export const EXAM_BADGE_TITLE =
  "考试参考标签 · 社区词表交叉整理 · 非官方授权";

export async function enexamLookup(word: string): Promise<string[]> {
  if (!word || !word.trim()) return [];
  try {
    return await invoke<string[]>("enexam_lookup", { word });
  } catch {
    // Exam badges are a nice-to-have. A store that hasn't finished
    // bootstrapping (or a Rust-side error) should render as "no badge",
    // not surface a user-visible failure.
    return [];
  }
}
