// ============================================================================
// Server-side page fetch + text extraction (plan §5.2)
//
// The four webapp-native tools (/report /marketing-plan /competitor-spy
// /outreach) take a URL, fetch it server-side, and reduce the HTML to a
// compact text profile the AI provider can reason about.
//
// Safety rails (plan §7 hardening):
//   * URL scheme locked to http/https; hostnames/IPs inside the server
//     network (localhost, private ranges, link-local, metadata) are rejected
//     before any request is made (SSRF guard).
//   * Response body is capped (byte budget) and fetched with a hard timeout.
//   * Crawl is same-origin only, bounded page count, per-page failures are
//     tolerated (a dead subpage never kills the whole crawl).
//
// Pure functions are deterministic and injectable-fetch for tests.
// ============================================================================

const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 750_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_HEADINGS = 40;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ZonaedAIAgent/1.0; +https://agent.thesharkweb.com)";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata.google.internal",
  "instance-data",
]);

/** True when the host is an IP literal in a private/reserved range. */
function isPrivateIpLiteral(host: string): boolean {
  // IPv6 literal arrives bracketed in URL.hostname.
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) {
    const lower = bare.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80")
    );
  }
  const parts = bare.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Parse and harden a user-supplied URL. Accepts bare domains
 * ("example.com") and upgrades them to https. Throws Error with a
 * user-presentable message on anything that must not be fetched.
 */
export function normalizeInputUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error("This tool cannot fetch internal or local hostnames.");
  }
  if ((host.length === 0 || !host.includes(".")) && !host.includes(":")) {
    throw new Error("Enter a full public domain, e.g. example.com.");
  }
  if (isPrivateIpLiteral(host)) {
    throw new Error("This tool cannot fetch private/internal IP addresses.");
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTML → compact text profile
// ---------------------------------------------------------------------------

export interface PageContent {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

function stripDangerous(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const codePoint = Number(code);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : " ";
    });
}

function tagText(html: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  for (const match of html.matchAll(re)) {
    const inner = decodeEntities(match[1].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (inner.length > 0) out.push(inner.slice(0, 300));
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

function metaContent(html: string, name: string): string {
  const re = new RegExp(
    `<meta\\b[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']|<meta\\b[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`,
    "i",
  );
  const match = re.exec(html);
  const value = match?.[1] ?? match?.[2] ?? "";
  return decodeEntities(value).replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Reduce a fetched HTML document to the text profile used by the tool prompts. */
export function extractPageContent(url: string, html: string): PageContent {
  const cleaned = stripDangerous(html);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned);
  const title = decodeEntities(titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const headings = [
    ...tagText(cleaned, "h1"),
    ...tagText(cleaned, "h2"),
    ...tagText(cleaned, "h3"),
  ].slice(0, MAX_HEADINGS);
  const bodyStart = /<body\b[^>]*>/i.exec(cleaned);
  const body = bodyStart ? cleaned.slice(bodyStart.index + bodyStart[0].length) : cleaned;
  const text = decodeEntities(body.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { url, title, description: metaContent(cleaned, "description"), headings, text };
}

// ---------------------------------------------------------------------------
// Link discovery + crawl
// ---------------------------------------------------------------------------

const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf)$/i;

/** Same-origin, page-like absolute URLs found in anchors. Deduplicated. */
export function extractLinks(html: string, baseUrl: URL): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(match[1]).trim();
    if (raw.startsWith("#")) continue; // in-page fragment
    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.origin !== baseUrl.origin) continue;
      if (SKIP_EXTENSIONS.test(resolved.pathname)) continue;
      resolved.hash = "";
      seen.add(resolved.toString());
    } catch {
      // Malformed href — skip.
    }
  }
  return [...seen];
}

export interface FetchResult {
  status: number;
  contentType: string;
  html: string;
}

/**
 * Fetch a page with timeout + byte cap. Returns null when the response is
 * unusable (network error, non-HTML content type, non-2xx). Never throws for
 * "page unavailable" — callers treat null as a skip.
 */
export async function fetchPage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchResult | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/i.test(contentType)) return null;
  // Read at most MAX_PAGE_BYTES so a huge response cannot exhaust memory.
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, contentType, html: "" };
  const decoder = new TextDecoder();
  let html = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (received >= MAX_PAGE_BYTES) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  return { status: res.status, contentType, html: html.slice(0, MAX_PAGE_BYTES) };
}

export interface CrawlResult {
  pages: PageContent[];
  /** URLs attempted but not usable (dead, non-HTML, blocked). */
  failed: string[];
}

/**
 * Crawl a site: fetch the start page, then up to `maxPages - 1` additional
 * same-origin subpages discovered from its links. Per-page failures are
 * recorded in `failed` and skipped. A failed start page is fatal (empty
 * result with the start URL in `failed`).
 */
export async function crawlSite(
  startUrl: URL,
  options: { maxPages?: number; fetchImpl?: typeof fetch } = {},
): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 6, 10));
  const fetchImpl = options.fetchImpl ?? fetch;
  const pages: PageContent[] = [];
  const failed: string[] = [];

  const start = await fetchPage(startUrl.toString(), fetchImpl);
  if (!start) {
    failed.push(startUrl.toString());
    return { pages, failed };
  }
  pages.push(extractPageContent(startUrl.toString(), start.html));
  if (maxPages === 1) return { pages, failed };

  const candidates = extractLinks(start.html, startUrl).filter((c) => c !== startUrl.toString());
  for (const candidate of candidates) {
    if (pages.length >= maxPages) break;
    const res = await fetchPage(candidate, fetchImpl);
    if (!res) {
      failed.push(candidate);
      continue;
    }
    pages.push(extractPageContent(candidate, res.html));
  }
  return { pages, failed };
}
