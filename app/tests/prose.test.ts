import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Prose from "@/components/ui/Prose";

// The Markdown agents write in their summaries, rendered without passing model
// output through as HTML.

const html = (text: string) => renderToStaticMarkup(createElement(Prose, { text }));

describe("Prose", () => {
  it("renders paragraphs, lists, headings and inline marks", () => {
    const out = html("## Picks\n\n1. **The pick:** jellyfish\n2. Submarine, *dramatic*\n\n- uses `wan22`\n- costs $0.04\nLine one\nline two");
    expect(out).toContain('<p class="font-semibold">Picks</p>');
    expect(out).toContain('<ol class="space-y-1 pl-5 list-decimal"><li><strong>The pick:</strong> jellyfish</li><li>Submarine, <em>dramatic</em></li></ol>');
    expect(out).toMatch(/<ul[^>]*list-disc[^>]*><li>uses <code[^>]*>wan22<\/code><\/li><li>costs \$0.04<\/li><\/ul>/);
    expect(out).toContain("<p>Line one<br/>line two</p>");
  });

  it("joins indented continuation lines into the list item", () => {
    expect(html("1. First item\n   continues here\n2. Second")).toContain("<li>First item continues here</li><li>Second</li>");
  });

  it("escapes HTML in model output", () => {
    const out = html('<img src=x onerror="alert(1)"> **<b>hi</b>**');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x");
    expect(out).toContain("<strong>&lt;b&gt;hi&lt;/b&gt;</strong>");
  });

  it("leaves lone asterisks and arithmetic alone", () => {
    expect(html("2 * 3 = 6 and 4 * 5")).toBe('<div class="space-y-2 break-words "><p>2 * 3 = 6 and 4 * 5</p></div>');
  });
});
