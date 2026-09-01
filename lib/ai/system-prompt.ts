// ============================================================================
// System prompt builder (plan §5.1 — port of extension src/lib/system-prompt.ts)
//
// Assembles, in order: persona → language mode rules → anti-cliché rules →
// memory preamble → skill preamble → few-shot examples. The same prompt shape
// is used for every provider so persona/tone stay consistent across surfaces.
// ============================================================================
import { BANNED_WORDS } from "./anti-cliche";
import { isEmptyPreamble, type Preamble } from "./matching";
import type { LanguageMode } from "./tone";

const PERSONA = `You are Zonaed's personal AI assistant. Direct, practical, no fluff.
You help with writing, planning, research summaries, marketing, and day-to-day decisions.
Prefer concrete specifics over generic advice. If a request is ambiguous, make the most
reasonable assumption and state it in one short line rather than interrogating the user.`;

const LANGUAGE_RULES: Record<LanguageMode, string> = {
  bengali: `The user wrote in Bengali script. Reply fully in Bengali (বাংলা), natural and conversational, not formal textbook Bengali.`,
  banglish: `The user writes Banglish (Bengali in Latin script). Reply in the same style: Bengali words written with Latin letters, mixed with English where natural. Do NOT switch to pure English or pure Bengali script.`,
  english: `Reply in clear English.`,
};

const ANTI_CLICHE_RULES = `Hard output rules (never break):
- NEVER use em-dashes or en-dashes. Use commas, periods, or colons instead.
- NEVER use these words (or close variants): ${BANNED_WORDS.join(", ")}.
- No filler openings like "Great question" or "Certainly". Start with the substance.
- No bullet-point padding: every line must carry information.`;

function preambleBlock(p: Preamble): string {
  const parts: string[] = [];
  if (p.memories.length > 0) {
    parts.push(
      "Known facts about the user (from long-term memory; treat as ground truth):",
      ...p.memories.map((m) => `- [${m.category}] ${m.content}`),
    );
  }
  if (p.skills.length > 0) {
    parts.push(
      "Relevant personal skills/knowledge files (treat as durable instructions and context):",
      ...p.skills.map((s) => `--- Skill: ${s.title} ---\n${s.content}`),
    );
  }
  if (p.examples.length > 0) {
    parts.push(
      "Style examples the user approved (imitate this output style, not the content):",
      ...p.examples.map((e, i) => `Example ${i + 1}\nUser: ${e.input}\nAssistant: ${e.output}`),
    );
  }
  return parts.join("\n");
}

export interface BuildPromptOptions {
  languageMode: LanguageMode;
  preamble?: Preamble;
  /** Chain-of-draft outline mode: ask for an outline only, not the full answer. */
  outlineOnly?: boolean;
}

/**
 * Build the full system prompt. Deterministic given the inputs (the extension
 * contract: same prompt shape every call, so tone never drifts).
 */
export function buildSystemPrompt(opts: BuildPromptOptions): string {
  const blocks: string[] = [PERSONA, LANGUAGE_RULES[opts.languageMode], ANTI_CLICHE_RULES];
  if (opts.preamble && !isEmptyPreamble(opts.preamble)) {
    blocks.push(preambleBlock(opts.preamble));
  }
  if (opts.outlineOnly) {
    blocks.push(
      `CHAIN-OF-DRAFT MODE: The user asked for long-form output. Do NOT write the final piece.
First produce a tight outline: section headings plus one line each on what goes in it and the
key points/numbers to include. End with the question: "Approve this outline, or tell me what to change?"`,
    );
  }
  return blocks.join("\n\n");
}
