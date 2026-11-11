/// <reference lib="dom" />
import { TRANSLATION_ATTRIBUTE } from "../types/translations";

export function isTranslationNode(node: Node): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !!element?.closest(`[${TRANSLATION_ATTRIBUTE}]`);
}

export function sourceTextWalker(root: Node): TreeWalker {
  return (root.ownerDocument ?? document).createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        isTranslationNode(node)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
}

export function getSourceText(root: Node): string {
  const walker = sourceTextWalker(root);
  let text = "";
  while (walker.nextNode()) text += walker.currentNode.textContent ?? "";
  return text;
}

export function getSourceRangeText(range: Range): string {
  return getSourceText(range.cloneContents());
}
