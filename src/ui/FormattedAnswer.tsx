import type { ReactNode } from "react";

// Automation answers come from a small local model, so their Markdown is often
// useful but imperfect. Normalize the common "- **item** - value - **item**"
// shape before rendering it as safe React elements (never injected HTML).
export function normalizeAnswerText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Small models open with filler despite instructions — strip the
      // classic preamble line so the answer leads with the answer.
      .replace(/^\s*(sure[,!.]?|okay[,!.]?|certainly[,!.]?|of course[,!.]?)\s+(here('s| is| are)\b[^\n]*[:.]\s*\n?)?/i, "")
      .replace(/^here('s| is| are)\s[^\n]{0,60}[:.]\s*\n(?=\s*(\d+[.)]|[-*•])\s)/i, "")
      .replace(/([:])\s+-\s+(?=\*\*[^*\n]+\*\*\s*[-—:])/g, "$1\n\n- ")
      .replace(/\s+-\s+(?=\*\*[^*\n]+\*\*\s*[-—:])/g, "\n- ")
      .replace(/\s+(?=\d+[.)]\s+\*\*[^*\n]+\*\*)/g, "\n")
      .trim()
  );
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const tokens = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+?`|\[[^\]\n]+?\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = tokens.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${part++}`;

    if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)]\((https?:\/\/[^)]+)\)$/);
      parts.push(
        link ? (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("http")) {
      const clean = token.replace(/[),.;!?]+$/, "");
      const suffix = token.slice(clean.length);
      parts.push(
        <a key={key} href={clean} target="_blank" rel="noreferrer">
          {clean}
        </a>
      );
      if (suffix) parts.push(suffix);
    } else {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function dataRow(line: string): [string, string] | null {
  const match = line.match(/^([A-Za-z0-9][A-Za-z0-9 &'()/+%.-]{1,31}):\s+(.{1,160})$/);
  if (!match || match[1].split(/\s+/).length > 5) return null;
  return [match[1], match[2]];
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    !line.trim() ||
    /^#{1,4}\s+/.test(line) ||
    /^[-*•]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^```/.test(line) ||
    /^\s*---+\s*$/.test(line) ||
    (line.includes("|") && isTableDivider(lines[index + 1] ?? ""))
  );
}

export function FormattedAnswer({
  text,
  compact = false,
}: {
  text: string;
  compact?: boolean;
}) {
  const lines = normalizeAnswerText(text).split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let block = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const key = `answer-${block++}`;

    if (/^```/.test(trimmed)) {
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key} data-language={language || undefined}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[i + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i++]));
      }
      blocks.push(
        <div className="answer-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inline(cell, `${key}-h${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{inline(row[cellIndex] ?? "", `${key}-r${rowIndex}c${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const Heading = heading[1].length <= 2 ? "h3" : "h4";
      blocks.push(<Heading key={key}>{inline(heading[2], key)}</Heading>);
      i++;
      continue;
    }

    if (/^[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^[-*•]\s+/, ""));
      }
      blocks.push(
        <ul className="answer-list" key={key}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\d+[.)]\s+/, ""));
      }
      blocks.push(
        <ol className="answer-list answer-list-ordered" key={key}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, `${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i++].replace(/^>\s?/, ""));
      }
      blocks.push(<blockquote key={key}>{inline(quote.join(" "), key)}</blockquote>);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }

    const possibleRows: [string, string][] = [];
    let rowIndex = i;
    while (rowIndex < lines.length) {
      const row = dataRow(lines[rowIndex]);
      if (!row) break;
      possibleRows.push(row);
      rowIndex++;
    }
    if (possibleRows.length >= 2) {
      blocks.push(
        <dl className="answer-data" key={key}>
          {possibleRows.map(([label, value], itemIndex) => (
            <div className="answer-data-row" key={itemIndex}>
              <dt>{label}</dt>
              <dd>{inline(value, `${key}-${itemIndex}`)}</dd>
            </div>
          ))}
        </dl>
      );
      i = rowIndex;
      continue;
    }

    const paragraph = [trimmed];
    i++;
    while (i < lines.length && !startsBlock(lines, i) && !dataRow(lines[i])) {
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push(<p key={key}>{inline(paragraph.join(" "), key)}</p>);
  }

  return (
    <div className={`formatted-answer${compact ? " formatted-answer-compact" : ""}`} data-testid="formatted-answer">
      {blocks}
    </div>
  );
}
