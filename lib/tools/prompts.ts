// ============================================================================
// Tool registry + prompts for the §5.2 webapp-native analysis tools.
//
// Each tool declares how it crawls (single page vs. multi-page site) and how
// the crawled content is turned into provider messages. System prompts embed
// the §5.1 anti-cliché rules so tool output follows the same voice rules as
// chat; the route re-checks with scanOutput() after generation.
// ============================================================================

import { BANNED_WORDS } from "../ai/anti-cliche";
import type { PageContent } from "./crawl";

export type ToolId = "report" | "marketing-plan" | "competitor-spy" | "outreach";

export const TOOL_IDS: ToolId[] = ["report", "marketing-plan", "competitor-spy", "outreach"];

export function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && (TOOL_IDS as string[]).includes(value);
}

export interface ToolSpec {
  id: ToolId;
  label: string;
  /** "single" fetches the given URL only; "site" crawls same-origin subpages. */
  crawlMode: "single" | "site";
  maxPages: number;
  /** Prompt text after the shared rules block. */
  systemPrompt: string;
  /** Builds the user turn from the crawled pages (+ optional user notes). */
  userPrompt: (pages: PageContent[], notes: string) => string;
}

const SHARED_RULES = `
Voice rules (hard requirements):
- Never use em-dashes or en-dashes.
- Banned words, never write them: ${BANNED_WORDS.join(", ")}.
- Be concrete. Use the actual products, services, and wording found on the site.
- Output Markdown the user can paste straight into a document or email.
`.trim();

function renderPages(pages: PageContent[]): string {
  return pages
    .map((p) => {
      const parts = [`URL: ${p.url}`, `Title: ${p.title || "(none)"}`];
      if (p.description) parts.push(`Meta description: ${p.description}`);
      if (p.headings.length > 0) parts.push(`Headings: ${p.headings.join(" | ")}`);
      parts.push(`Page text: ${p.text || "(empty)"}`);
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

export const TOOLS: Record<ToolId, ToolSpec> = {
  report: {
    id: "report",
    label: "Website audit + client proposal",
    crawlMode: "single",
    maxPages: 1,
    systemPrompt: `You are a senior web consultant auditing a client's website and writing a client-facing proposal. Audit what the page content reveals: offer clarity, message hierarchy, trust signals (testimonials, case studies, guarantees, contactability), SEO basics visible in the content (title, meta description, heading structure), conversion paths (calls to action), and content gaps. Be honest about weaknesses but constructive; the reader is the prospective client.

${SHARED_RULES}`,
    userPrompt: (pages, notes) =>
      `Audit this website homepage and write a client-facing proposal/report.\n\n${notes ? `Extra context from the user:\n${notes}\n\n` : ""}Website content:\n\n${renderPages(pages)}`,
  },
  "marketing-plan": {
    id: "marketing-plan",
    label: "Marketing plan generator",
    crawlMode: "site",
    maxPages: 6,
    systemPrompt: `You are a growth marketer building a practical marketing plan for a business, based on a crawl of its website. Cover: target audience, core positioning and differentiators, 3 to 5 marketing channels suited to the business with concrete first actions for each, a content strategy grounded in what the site already publishes, and a 30/60/90-day priority order. Every recommendation must reference something actually observed on the crawled pages.

${SHARED_RULES}`,
    userPrompt: (pages, notes) =>
      `Here is a crawl of the business website (${pages.length} page${pages.length === 1 ? "" : "s"}). Write a marketing plan.\n\n${notes ? `Extra context from the user:\n${notes}\n\n` : ""}Crawled content:\n\n${renderPages(pages)}`,
  },
  "competitor-spy": {
    id: "competitor-spy",
    label: "Competitor strategy analysis",
    crawlMode: "single",
    maxPages: 1,
    systemPrompt: `You are a competitive-intelligence analyst. From a competitor's landing page, infer their positioning: who they target, the promise they lead with, pricing/packaging signals, trust and social proof tactics, feature emphasis, and tone. Then list exploitable gaps: claims they make that could be countered, audiences they ignore, and angles a rival could own. Label inferences as inferences; do not state internal facts you cannot see.

${SHARED_RULES}`,
    userPrompt: (pages, notes) =>
      `Analyze this competitor landing page and produce a strategy breakdown with exploitable gaps.\n\n${notes ? `Extra context from the user:\n${notes}\n\n` : ""}Competitor page content:\n\n${renderPages(pages)}`,
  },
  outreach: {
    id: "outreach",
    label: "LinkedIn + cold outreach generator",
    crawlMode: "single",
    maxPages: 1,
    systemPrompt: `You are an outbound specialist writing outreach a prospect would actually answer. From the prospect's page, write: (1) a 3-sentence LinkedIn connection note (under 300 characters), (2) a LinkedIn InMail (under 120 words), (3) a cold email with a specific subject line (under 120 words), and (4) one follow-up message. Reference something specific from their site in the first line of each. No flattery openers, no "I hope this finds you well", no generic praise.

${SHARED_RULES}`,
    userPrompt: (pages, notes) =>
      `Write outreach copy for this prospect based on their page.\n\n${notes ? `Extra context from the user (your offer, the angle, etc.):\n${notes}\n\n` : ""}Prospect page content:\n\n${renderPages(pages)}`,
  },
};
