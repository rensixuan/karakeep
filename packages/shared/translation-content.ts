import { createHash } from "node:crypto";
import { load } from "cheerio";
import { isTag } from "domhandler";

import {
  TRANSLATION_ATTRIBUTE,
  TRANSLATION_RULE_VERSION,
  TRANSLATION_SEGMENT_ATTRIBUTE,
  TRANSLATION_TARGET,
} from "./types/translations";
import type { TranslationSegment } from "./types/translations";

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,figcaption,dt,dd";
const SKIP = "pre,code,script,style,svg,math,kbd,samp,textarea";
export const MAX_TRANSLATION_SEGMENT_CHARS = 2000;
export const MAX_TRANSLATION_BATCH_CHARS = 6000;

export function splitTranslationText(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + MAX_TRANSLATION_SEGMENT_CHARS, chars.length);
    if (end < chars.length) {
      for (let i = end; i > start + MAX_TRANSLATION_SEGMENT_CHARS / 2; i--) {
        if (/[\s。！？.!?]/u.test(chars[i - 1])) {
          end = i;
          break;
        }
      }
    }
    result.push(chars.slice(start, end).join(""));
    start = end;
  }
  return result;
}

export function prepareTranslationContent(
  html: string,
  title: string,
  model: string,
  userId: string,
) {
  const $ = load(html, {}, false);
  // Crawled attributes cannot masquerade as our trusted UI markers.
  $(`[${TRANSLATION_ATTRIBUTE}]`).removeAttr(TRANSLATION_ATTRIBUTE);
  $(`[${TRANSLATION_SEGMENT_ATTRIBUTE}]`).removeAttr(
    TRANSLATION_SEGMENT_ATTRIBUTE,
  );
  $("[data-translation-inline-run]").removeAttr("data-translation-inline-run");
  const segments: TranslationSegment[] = [];
  const add = (text: string, prefix: string) => {
    const ids: string[] = [];
    splitTranslationText(text).forEach((part, index) => {
      const id = `${prefix}-${index}`;
      segments.push({ id, text: part });
      ids.push(id);
    });
    return ids.join(" ");
  };
  const titleIds = title.trim() ? add(title.trim(), "title") : "";
  // Wrap only direct inline runs in mixed blocks. Nested lists, quotes and
  // tables are processed at their leaves, so no text is translated twice.
  const root = $("<article></article>");
  root.append($.root().contents());
  $.root().append(root);
  $(BLOCKS)
    .add("div,section,article")
    .toArray()
    .reverse()
    .forEach((element) => {
      if ($(element).closest(SKIP).length) return;
      if (
        !$(element).find(BLOCKS).length &&
        !$(element).find("div,section,article").length
      )
        return;
      let run: (typeof element)[] = [];
      const flush = () => {
        if (run.some((node) => $(node).text().trim())) {
          // before() ignores text nodes in Cheerio; insertBefore() handles them.
          const wrapper = $("<span></span>").insertBefore(run[0]);
          run.forEach((node) => wrapper.append(node));
          wrapper.attr("data-translation-inline-run", "");
        }
        run = [];
      };
      $(element)
        .contents()
        .toArray()
        .forEach((node) => {
          if (
            isTag(node) &&
            ($(node).is(`${BLOCKS},div,section,article,${SKIP}`) ||
              $(node).find(BLOCKS).length)
          )
            flush();
          else run.push(node);
        });
      flush();
    });
  const candidates = $(
    `${BLOCKS},[data-translation-inline-run],div,section,article`,
  )
    .toArray()
    .filter(
      (el) =>
        !$(el).closest(SKIP).length &&
        !$(el).find(
          `${BLOCKS},[data-translation-inline-run],div,section,article`,
        ).length,
    );
  // Text-only HTML fragments have no block to annotate.
  if (!candidates.length && $.root().text().trim()) {
    $.root().wrapInner("<div></div>");
    candidates.push($.root().children()[0]);
  }
  candidates.forEach((element, index) => {
    const clone = $(element).clone();
    clone.find(SKIP.replace("code,", "")).remove();
    const text = clone.text().trim();
    if (text)
      $(element).attr(
        TRANSLATION_SEGMENT_ATTRIBUTE,
        add(text, `block-${index}`),
      );
  });
  $("[data-translation-inline-run]").removeAttr("data-translation-inline-run");
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        userId,
        html,
        title,
        model,
        TRANSLATION_TARGET,
        TRANSLATION_RULE_VERSION,
      ]),
    )
    .digest("hex");
  return { html: $.html(), titleIds, segments, version };
}

export function nextTranslationBatch(
  segments: TranslationSegment[],
  translations: Record<string, string>,
) {
  const batch: TranslationSegment[] = [];
  let length = 0;
  for (const segment of segments) {
    if (Object.prototype.hasOwnProperty.call(translations, segment.id))
      continue;
    if (
      batch.length &&
      (length + segment.text.length > MAX_TRANSLATION_BATCH_CHARS ||
        batch.length >= 8)
    )
      break;
    batch.push(segment);
    length += segment.text.length;
  }
  return batch;
}
