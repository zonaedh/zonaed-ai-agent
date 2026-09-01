// ============================================================================
// Dexie-row -> SearchDocument adapters (plan §4 /search, priority 6)
//
// Keeps lib/search/engine.ts pure (no Dexie imports, fully unit-testable) and
// confines the IndexedDB coupling to this file + the UI page.
// ============================================================================
import type { ChatMessageRow, KnowledgeRow, MemoryRow, SkillRow } from "../db/types";
import type { SearchDocument } from "./engine";

export function memoryToSearchDoc(m: MemoryRow): SearchDocument {
  return {
    source: "memory",
    clientId: m.client_id,
    title: m.category,
    body: m.content,
    tags: [m.source],
    updatedAt: m.updated_at,
    row: m as unknown as Record<string, unknown>,
  };
}

export function knowledgeToSearchDoc(k: KnowledgeRow): SearchDocument {
  return {
    source: "knowledge",
    clientId: k.client_id,
    title: k.title,
    body: k.content,
    tags: k.tags,
    updatedAt: k.updated_at,
    row: k as unknown as Record<string, unknown>,
  };
}

export function skillToSearchDoc(s: SkillRow): SearchDocument {
  return {
    source: "skills",
    clientId: s.client_id,
    title: s.title,
    body: s.content,
    tags: s.trigger_keywords,
    updatedAt: s.updated_at,
    row: s as unknown as Record<string, unknown>,
  };
}

export function chatToSearchDoc(c: ChatMessageRow): SearchDocument {
  return {
    source: "chat_history",
    clientId: c.client_id,
    title: c.role,
    body: c.content,
    tags: [],
    updatedAt: c.updated_at,
    row: c as unknown as Record<string, unknown>,
  };
}