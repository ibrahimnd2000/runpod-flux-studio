import { Fragment, type ReactNode } from "react";

// The little Markdown LLMs write in summaries (paragraphs, - and 1. lists,
// # headings, **bold**, *italic*, `code`), rendered as React elements: no HTML
// from the model ever reaches the DOM.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${m.index}`;
    if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-muted px-1 font-mono text-[0.92em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;

export default function Prose({ text, className = "" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
    if (list) {
      const items: string[] = [];
      while (i < lines.length && (list.test(lines[i]) || (items.length && /^\s{2,}\S/.test(lines[i])))) {
        if (list.test(lines[i])) items.push(lines[i].replace(list, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const Tag = list === BULLET ? "ul" : "ol";
      blocks.push(
        <Tag key={i} className={`space-y-1 pl-5 ${list === BULLET ? "list-disc" : "list-decimal"}`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${i}-${j}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) para.push(lines[i++]);
    const heading = /^#{1,6}\s+/.test(para[0]);
    blocks.push(
      <p key={i} className={heading ? "font-semibold" : undefined}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(heading && j === 0 ? l.replace(/^#{1,6}\s+/, "") : l, `${i}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={`space-y-2 break-words ${className}`}>{blocks}</div>;
}
