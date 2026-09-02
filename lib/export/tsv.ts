// ============================================================================
// Sheets Export (plan Tool Split table: "Markdown table → TSV, clipboard
// action inside /chat, no dedicated route needed")
//
// Pure parser: converts Markdown tables in an assistant reply into TSV
// (tab-separated values) ready to paste straight into Google Sheets / Excel.
// ============================================================================

export interface TsvResult {
  /** TSV rows joined with \n (empty when the input has no Markdown table). */
  tsv: string;
  /** Number of Markdown tables found. */
  tables: number;
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Split on unescaped pipes only (negative lookbehind), then unescape.
  return body
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Convert every Markdown table in `markdown` to TSV. Multiple tables are
 * separated by a blank line, mirroring the source layout. Returns an empty
 * `tsv` with `tables: 0` when the input contains no Markdown table.
 */
export function markdownTableToTsv(markdown: string): TsvResult {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[][][] = [];
  let current: string[][] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const isRow = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length >= 2;
    if (isRow) {
      const cells = splitRow(trimmed);
      if (isSeparatorRow(cells)) continue; // |---|---| alignment rows
      if (!current) current = [];
      current.push(cells);
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) return { tsv: "", tables: 0 };

  const tsv = blocks
    .map((rows) => rows.map((cells) => cells.map((c) => c.replace(/\t/g, " ")).join("\t")).join("\n"))
    .join("\n\n");
  return { tsv, tables: blocks.length };
}

/** True when the message contains at least one Markdown table (for UI gating). */
export function hasMarkdownTable(markdown: string): boolean {
  return markdownTableToTsv(markdown).tables > 0;
}
