import { z } from "zod";

export const DEFAULT_TRANSLATION_MODEL = "gpt-5.4-mini";
export const TRANSLATION_RULE_VERSION = 1;
export const TRANSLATION_TARGET = "zh-CN";
export const TRANSLATION_ATTRIBUTE = "data-reader-translation";
export const TRANSLATION_SEGMENT_ATTRIBUTE = "data-translation-segment";

export const zTranslationModel = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const zTranslationSettingsInput = z.object({
  model: zTranslationModel,
  apiKey: z.string().trim().min(1).max(512).optional(),
});
export const zTranslationRequest = z.object({
  bookmarkId: z.string(),
  version: z.string(),
  generation: z.number().int().nonnegative(),
});
export interface TranslationSegment {
  id: string;
  text: string;
}
export type TranslationTexts = Record<string, string>;
