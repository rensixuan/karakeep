import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import {
  nextTranslationBatch,
  prepareTranslationContent,
  splitTranslationText,
} from "./translation-content";

describe("reader translation content", () => {
  const prepare = (html: string) =>
    prepareTranslationContent(html, "Title", "model", "owner");
  it("segments nested lists, quotes, tables and loose text exactly once without changing original text", () => {
    const html =
      'Intro<p>Hello <a href="https://example.com">link</a> and <code>foo()</code>.</p><ul><li>Outer<ul><li>Inner</li></ul>Tail</li></ul><blockquote><p>Quote</p></blockquote><table><tbody><tr><td>Cell</td></tr></tbody></table><pre>skip code</pre><img src="/image.png">End';
    const article = prepare(html);
    expect(article.segments.map((s) => s.text)).toEqual([
      "Title",
      "Intro",
      "Hello link and foo().",
      "Outer",
      "Inner",
      "Tail",
      "Quote",
      "Cell",
      "End",
    ]);
    expect(load(article.html).text()).toBe(load(html).text());
    expect(article.html).toContain('href="https://example.com"');
    expect(article.html).toContain("<pre>skip code</pre>");
    expect(article.html).toContain('src="/image.png"');
    const marked = load(article.html)("[data-translation-segment]");
    expect(marked.length).toBe(8);
  });
  it("annotates text-only fragments and removes untrusted marker attributes", () => {
    expect(prepare("Just text").html).toContain(
      'data-translation-segment="block-0-0"',
    );
    const article = prepare(
      '<p data-reader-translation="" data-translation-segment="bad">Words</p>',
    );
    expect(article.html).not.toContain("data-reader-translation");
    expect(article.html).not.toContain('="bad"');
  });
  it("splits long Unicode text without loss or broken surrogate pairs", () => {
    const text = "A sentence 😀。".repeat(900);
    const parts = splitTranslationText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => Array.from(part).length <= 2000)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
  it("bounds batches and excludes saved segments", () => {
    const article = prepare(`<p>${"word ".repeat(4000)}</p>`);
    const batch = nextTranslationBatch(article.segments, {
      [article.segments[0].id]: "已翻译",
    });
    expect(batch.some((s) => s.id === article.segments[0].id)).toBe(false);
    expect(batch.length).toBeLessThanOrEqual(8);
    expect(
      batch.reduce((sum, s) => sum + s.text.length, 0),
    ).toBeLessThanOrEqual(6000);
  });
  it("invalidates cached translations when source, model or user changes", () => {
    const version = prepare("Hello").version;
    expect(prepare("Hello").version).toBe(version);
    expect(prepare("Changed").version).not.toBe(version);
    expect(
      prepareTranslationContent("Hello", "Title", "other", "owner").version,
    ).not.toBe(version);
    expect(
      prepareTranslationContent("Hello", "Title", "model", "other-user")
        .version,
    ).not.toBe(version);
  });
});
