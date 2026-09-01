// ============================================================================
// Tools verification (plan §5.2 + §9 priority 9)
//   1. URL hardening — scheme lock, bare-domain upgrade, SSRF rejections
//   2. HTML extraction — title/meta/headings, script stripping, entities
//   3. Link discovery — same-origin only, dedupe, asset skip
//   4. fetchPage — non-HTML/!ok → null, byte cap
//   5. crawlSite — page cap, per-page failure tolerance
//   6. Tool registry — ids, crawl modes, prompt rule coverage
// Run: npm run verify:tools
// ============================================================================
import assert from "node:assert/strict";
import {
  crawlSite,
  extractLinks,
  extractPageContent,
  fetchPage,
  normalizeInputUrl,
} from "../lib/tools/crawl";
import { isToolId, TOOLS, TOOL_IDS } from "../lib/tools/prompts";

let passed = 0;
const TOTAL = 22;

let chain: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>): void {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (err: unknown) {
      console.error(`  FAIL - ${name}:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });
}

/** Minimal mock HTML Response with a readable byte stream (fetchPage reads it). */
function htmlResponse(html: string, contentType = "text/html; charset=utf-8"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(html));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": contentType } });
}

// ---------------------------------------------------------------------------
// 1. URL hardening
// ---------------------------------------------------------------------------

check("normalizeInputUrl upgrades a bare domain to https", () => {
  const url = normalizeInputUrl("example.com");
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "example.com");
});

check("normalizeInputUrl keeps an explicit https URL", () => {
  const url = normalizeInputUrl("https://example.com/pricing?x=1");
  assert.equal(url.toString(), "https://example.com/pricing?x=1");
});

check("normalizeInputUrl rejects non-http schemes", () => {
  assert.throws(() => normalizeInputUrl("ftp://example.com"), /Only http and https/);
  assert.throws(() => normalizeInputUrl("file:///etc/passwd"), /Only http and https/);
});

check("normalizeInputUrl rejects empty input", () => {
  assert.throws(() => normalizeInputUrl("   "), /Enter a URL/);
});

check("normalizeInputUrl rejects localhost and internal hostnames", () => {
  assert.throws(() => normalizeInputUrl("http://localhost:3000"), /internal or local/);
  assert.throws(() => normalizeInputUrl("http://metadata.google.internal"), /internal or local/);
  assert.throws(() => normalizeInputUrl("http://my-server.local"), /internal or local/);
});

check("normalizeInputUrl rejects private/loopback/link-local IP literals", () => {
  for (const host of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.5", "169.254.169.254", "0.0.0.0", "100.64.0.1"]) {
    assert.throws(() => normalizeInputUrl(`http://${host}`), /private\/internal/, host);
  }
  assert.throws(() => normalizeInputUrl("http://[::1]/"), /private\/internal/);
});

check("normalizeInputUrl allows public IPs and domains", () => {
  assert.doesNotThrow(() => normalizeInputUrl("https://8.8.8.8"));
  assert.doesNotThrow(() => normalizeInputUrl("https://docs.example.co.uk/guide"));
});

// ---------------------------------------------------------------------------
// 2. HTML extraction
// ---------------------------------------------------------------------------

const SAMPLE_HTML = `<!doctype html><html><head>
<title>Acme Robotics &amp; Automation</title>
<meta name="description" content="We build robots that &quot;just work&quot;.">
<script>window.tracker = 'secret-script-data';</script>
<style>.hidden { color: red }</style>
</head><body>
<h1>Industrial automation</h1>
<h2>Services</h2>
<p>We deploy robotic cells for factories.   Contact us today.</p>
<script>var more = 'hidden';</script>
<h3>Case studies</h3>
<a href="/pricing">Pricing</a>
</body></html>`;

check("extractPageContent pulls title, meta description, headings", () => {
  const page = extractPageContent("https://acme.example/", SAMPLE_HTML);
  assert.equal(page.title, "Acme Robotics & Automation");
  assert.equal(page.description, 'We build robots that "just work".');
  assert.ok(page.headings.includes("Industrial automation"));
  assert.ok(page.headings.includes("Services"));
  assert.ok(page.headings.includes("Case studies"));
});

check("extractPageContent strips script/style content from text", () => {
  const page = extractPageContent("https://acme.example/", SAMPLE_HTML);
  assert.ok(!page.text.includes("secret-script-data"));
  assert.ok(!page.text.includes("hidden"));
  assert.ok(page.text.includes("robotic cells"));
  assert.ok(!/[<>]/.test(page.text));
});

check("extractPageContent collapses whitespace and decodes entities", () => {
  const page = extractPageContent("https://acme.example/", SAMPLE_HTML);
  assert.ok(!/\s{2,}/.test(page.text));
  assert.ok(!page.text.includes("&amp;"));
});

check("extractPageContent caps runaway text", () => {
  const huge = `<html><body>${"<p>word </p>".repeat(50_000)}</body></html>`;
  const page = extractPageContent("https://acme.example/", huge);
  assert.ok(page.text.length <= 12_000);
});

// ---------------------------------------------------------------------------
// 3. Link discovery
// ---------------------------------------------------------------------------

check("extractLinks keeps same-origin pages, drops external + assets, dedupes", () => {
  const base = new URL("https://acme.example/");
  const html = `
    <a href="/pricing">Pricing</a>
    <a href="https://acme.example/about#team">About</a>
    <a href="https://other.example/page">External</a>
    <a href="/logo.png">Logo</a>
    <a href="/pricing">Dup</a>
    <a href="/blog/post?id=2">Post</a>`;
  const links = extractLinks(html, base);
  assert.ok(links.includes("https://acme.example/pricing"));
  assert.ok(links.includes("https://acme.example/about"));
  assert.ok(links.includes("https://acme.example/blog/post?id=2"));
  assert.equal(links.filter((l) => l.includes("other.example")).length, 0);
  assert.equal(links.filter((l) => l.endsWith(".png")).length, 0);
  assert.equal(links.filter((l) => l === "https://acme.example/pricing").length, 1);
});

// ---------------------------------------------------------------------------
// 4. fetchPage
// ---------------------------------------------------------------------------

check("fetchPage returns null on non-2xx and non-HTML content types", async () => {
  const notOk = await fetchPage("https://x.example/", async () => new Response("nope", { status: 404, headers: { "Content-Type": "text/html" } }));
  assert.equal(notOk, null);
  const notHtml = await fetchPage("https://x.example/", async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.equal(notHtml, null);
});

check("fetchPage returns null on network error, html on success", async () => {
  const errored = await fetchPage("https://x.example/", async () => {
    throw new Error("boom");
  });
  assert.equal(errored, null);
  const ok = await fetchPage("https://x.example/", async () => htmlResponse("<html><body>hi</body></html>"));
  assert.ok(ok);
  assert.equal(ok.status, 200);
  assert.ok(ok.html.includes("hi"));
});

// ---------------------------------------------------------------------------
// 5. crawlSite
// ---------------------------------------------------------------------------

function siteFetcher(pages: Record<string, string>) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const html = pages[url];
    if (html === undefined) throw new Error("404");
    return htmlResponse(html);
  };
  return { impl, calls };
}

check("crawlSite follows same-origin links up to maxPages", async () => {
  const { impl, calls } = siteFetcher({
    "https://acme.example/": '<html><body><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></body></html>',
    "https://acme.example/a": "<html><body>Page A</body></html>",
    "https://acme.example/b": "<html><body>Page B</body></html>",
    "https://acme.example/c": "<html><body>Page C</body></html>",
  });
  const result = await crawlSite(new URL("https://acme.example/"), { maxPages: 3, fetchImpl: impl });
  assert.equal(result.pages.length, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(result.pages[0].url, "https://acme.example/");
});

check("crawlSite tolerates dead subpages and reports them", async () => {
  const { impl } = siteFetcher({
    "https://acme.example/": '<html><body><a href="/dead">Dead</a><a href="/alive">Alive</a></body></html>',
    "https://acme.example/alive": "<html><body>Alive page</body></html>",
  });
  const result = await crawlSite(new URL("https://acme.example/"), { maxPages: 5, fetchImpl: impl });
  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.failed, ["https://acme.example/dead"]);
});

check("crawlSite with a dead start page fails cleanly", async () => {
  const { impl } = siteFetcher({});
  const result = await crawlSite(new URL("https://acme.example/"), { maxPages: 3, fetchImpl: impl });
  assert.equal(result.pages.length, 0);
  assert.deepEqual(result.failed, ["https://acme.example/"]);
});

check("crawlSite single mode fetches only the start page", async () => {
  const { impl, calls } = siteFetcher({
    "https://acme.example/": '<html><body><a href="/a">A</a></body></html>',
  });
  const result = await crawlSite(new URL("https://acme.example/"), { maxPages: 1, fetchImpl: impl });
  assert.equal(result.pages.length, 1);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// 6. Tool registry
// ---------------------------------------------------------------------------

check("registry exposes exactly the four §5.2 tool ids", () => {
  assert.deepEqual(TOOL_IDS.sort(), ["competitor-spy", "marketing-plan", "outreach", "report"]);
  assert.equal(isToolId("report"), true);
  assert.equal(isToolId("nope"), false);
  assert.equal(isToolId(42), false);
});

check("marketing-plan crawls the site; the others are single-page", () => {
  assert.equal(TOOLS["marketing-plan"].crawlMode, "site");
  assert.equal(TOOLS["marketing-plan"].maxPages > 1, true);
  for (const id of ["report", "competitor-spy", "outreach"] as const) {
    assert.equal(TOOLS[id].crawlMode, "single", id);
    assert.equal(TOOLS[id].maxPages, 1, id);
  }
});

check("every tool prompt carries the anti-cliché rules", () => {
  for (const id of TOOL_IDS) {
    const spec = TOOLS[id];
    assert.ok(spec.systemPrompt.includes("Never use em-dashes"), id);
    assert.ok(spec.systemPrompt.includes("delve"), id);
    assert.ok(spec.systemPrompt.includes("game-changer"), id);
  }
});

check("userPrompt renders all crawled pages plus user notes", () => {
  const pages = [
    { url: "https://a.example/", title: "A", description: "desc-a", headings: ["H1"], text: "body a" },
    { url: "https://a.example/b", title: "B", description: "", headings: [], text: "body b" },
  ];
  const prompt = TOOLS.report.userPrompt(pages, "sell SEO services");
  assert.ok(prompt.includes("https://a.example/"));
  assert.ok(prompt.includes("https://a.example/b"));
  assert.ok(prompt.includes("body a") && prompt.includes("body b"));
  assert.ok(prompt.includes("sell SEO services"));
  const withoutNotes = TOOLS.report.userPrompt(pages, "");
  assert.ok(!withoutNotes.includes("Extra context"));
});

// ---------------------------------------------------------------------------

await chain;
console.log(`\nverify:tools ${passed}/${TOTAL} checks passed`);
if (passed !== TOTAL) process.exitCode = 1;
