// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BookmarkHTMLHighlighter from "@karakeep/shared-react/components/BookmarkHtmlHighlighter";
import {
  getSourceRangeText,
  getSourceText,
} from "@karakeep/shared/utils/reader-source-dom";
import {
  getReadingPosition,
  scrollToReadingPosition,
} from "@karakeep/shared/utils/reading-progress-dom";

const html =
  '<p data-translation-segment="first">First paragraph.</p><p data-translation-segment="second">Second paragraph.</p>';
const translations = {
  first: "第一段。",
  second: '<img src=x onerror="alert(1)">第二段。',
};

describe("bilingual reader DOM", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 100, 20),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.getSelection()?.removeAllRanges();
  });

  it("renders translations as text and keeps original DOM/selection when translations update", () => {
    const view = render(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations
      />,
    );
    const first = view.container.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, 5);
    window.getSelection()!.addRange(range);
    view.rerender(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={{ ...translations, first: "更新译文" }}
        showTranslations
      />,
    );
    expect(view.container.querySelector("p")!.firstChild).toBe(first);
    expect(window.getSelection()!.toString()).toBe("First");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
    const article = view.container.querySelector("[role=presentation]")!;
    expect(getSourceText(article)).toBe("First paragraph.Second paragraph.");
    view.rerender(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations={false}
      />,
    );
    expect(
      view.container.querySelector("[data-reader-translation]"),
    ).toBeNull();
    expect(view.container.querySelector("p")!.firstChild).toBe(first);
  });
  it("keeps saved highlight anchors in original text", () => {
    const view = render(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations
        highlights={[
          {
            id: "highlight",
            startOffset: 16,
            endOffset: 22,
            text: "Second",
            prefix: "First paragraph.",
            color: "yellow",
          },
        ]}
      />,
    );
    expect(
      view.container.querySelector('[data-highlight-id="highlight"]')
        ?.textContent,
    ).toBe("Second");
    expect(
      view.container.querySelector(
        "[data-reader-translation] [data-highlight]",
      ),
    ).toBeNull();
  });
  it("creates cross-paragraph highlights using only source text and ignores translated selections", () => {
    const onHighlight = vi.fn();
    const view = render(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations
        onHighlight={onHighlight}
      />,
    );
    const paragraphs = view.container.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild!, 0);
    range.setEnd(paragraphs[1].firstChild!, 6);
    expect(getSourceRangeText(range)).toBe("First paragraph.Second");
    window.getSelection()!.addRange(range);
    fireEvent.pointerDown(paragraphs[0]);
    fireEvent.pointerUp(paragraphs[1]);
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onHighlight).toHaveBeenCalledWith(
      expect.objectContaining({
        startOffset: 0,
        endOffset: 22,
        text: "First paragraph.Second",
      }),
    );
    const translated = view.container.querySelector(
      "[data-reader-translation]",
    )!;
    const translatedRange = document.createRange();
    translatedRange.selectNodeContents(translated);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(translatedRange);
    fireEvent.pointerDown(translated);
    fireEvent.pointerUp(translated);
    expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  });
  it("calculates/restores source reading positions identically with translation visible", () => {
    const view = render(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations={false}
      />,
    );
    const article = view.container.querySelector<HTMLElement>(
      "[role=presentation]",
    )!;
    const paragraphs = article.querySelectorAll("p");
    vi.spyOn(paragraphs[0], "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, -100, 200, 20),
    );
    vi.spyOn(paragraphs[1], "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 20),
    );
    Object.defineProperty(document.body, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    const original = getReadingPosition(article);
    expect(original?.anchor).toBe("Second paragraph.");
    view.rerender(
      <BookmarkHTMLHighlighter
        htmlContent={html}
        translations={translations}
        showTranslations
      />,
    );
    expect(getReadingPosition(article)).toEqual(original);
    const scroll = vi.fn();
    paragraphs[1].scrollIntoView = scroll;
    expect(
      scrollToReadingPosition(
        article,
        original!.offset,
        "instant",
        original!.anchor,
      ),
    ).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
  });
});
