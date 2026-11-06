/**
 * The weekly wrap's markdown as plain blocks for the email: section
 * headings and bullet lines. The title, the date lines and the footer are
 * left out (the email has its own). Pure, so it can be tested.
 */
export interface WrapBlock {
  heading: string;
  lines: { bold: string; rest: string }[];
}

export function wrapBlocks(markdown: string): WrapBlock[] {
  const blocks: WrapBlock[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      blocks.push({ heading: line.slice(3).trim(), lines: [] });
    } else if (line.startsWith("- ") && blocks.length) {
      const text = line.slice(2).trim();
      const m = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      blocks[blocks.length - 1].lines.push(m ? { bold: m[1], rest: m[2] } : { bold: "", rest: text });
    }
  }
  return blocks.filter((b) => b.lines.length);
}
