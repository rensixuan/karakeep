import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "@karakeep/db";
import {
  bookmarkLinks,
  bookmarks,
  bookmarkTranslations,
  userTranslationSettings,
} from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { translateSegments } from "@karakeep/shared/translation-client";
import {
  nextTranslationBatch,
  prepareTranslationContent,
} from "@karakeep/shared/translation-content";
import {
  decryptTranslationKey,
  encryptTranslationKey,
  readTranslationEncryptionKey,
} from "@karakeep/shared/translation-crypto";
import {
  DEFAULT_TRANSLATION_MODEL,
  zTranslationRequest,
  zTranslationSettingsInput,
} from "@karakeep/shared/types/translations";

import { createRateLimitMiddleware, router, sessionProcedure } from "../index";
import type { AuthedContext } from "../index";
import { Bookmark } from "../models/bookmarks";

function fail(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function encryptionAvailable() {
  try {
    readTranslationEncryptionKey(serverConfig.translation.encryptionKey).fill(
      0,
    );
    return true;
  } catch {
    return false;
  }
}

function requireEncryption() {
  if (!encryptionAvailable()) fail("TRANSLATION_ENCRYPTION_UNAVAILABLE");
}

async function getSettings(ctx: AuthedContext) {
  return ctx.db.query.userTranslationSettings.findFirst({
    where: eq(userTranslationSettings.userId, ctx.user.id),
  });
}

async function getArticle(ctx: AuthedContext, bookmarkId: string) {
  const [row] = await ctx.db
    .select({ bookmark: bookmarks, link: bookmarkLinks })
    .from(bookmarks)
    .innerJoin(bookmarkLinks, eq(bookmarks.id, bookmarkLinks.id))
    .where(
      and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, ctx.user.id)),
    );
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  const html = await Bookmark.getBookmarkHtmlContent(row.link, ctx.user.id);
  if (!html?.trim()) fail("TRANSLATION_NO_CONTENT");
  const settings = await getSettings(ctx);
  const model = settings?.model ?? DEFAULT_TRANSLATION_MODEL;
  const article = prepareTranslationContent(
    html,
    row.bookmark.title ?? row.link.title ?? "",
    model,
    ctx.user.id,
  );
  const cache = await ctx.db.query.bookmarkTranslations.findFirst({
    where: and(
      eq(bookmarkTranslations.bookmarkId, bookmarkId),
      eq(bookmarkTranslations.userId, ctx.user.id),
    ),
  });
  const matchingCache = cache?.version === article.version ? cache : undefined;
  return {
    ...article,
    model,
    generation: matchingCache?.generation ?? 0,
    translations: matchingCache?.translations ?? {},
    hasKey: !!settings,
    encryptionAvailable: encryptionAvailable(),
  };
}

type Article = Awaited<ReturnType<typeof getArticle>>;
type Request = z.infer<typeof zTranslationRequest>;
function checkVersion(article: Article, input: Request) {
  if (
    article.version !== input.version ||
    article.generation !== input.generation
  ) {
    throw new TRPCError({ code: "CONFLICT", message: "TRANSLATION_STALE" });
  }
}

function readKey(
  settings: NonNullable<Awaited<ReturnType<typeof getSettings>>>,
  userId: string,
) {
  try {
    return decryptTranslationKey(
      settings,
      userId,
      serverConfig.translation.encryptionKey,
    );
  } catch {
    return fail("TRANSLATION_KEY_UNREADABLE");
  }
}

async function invokeTranslation(
  key: string,
  model: string,
  segments: Parameters<typeof translateSegments>[2],
) {
  try {
    return await translateSegments(key, model, segments);
  } catch (error) {
    const allowed = [
      "TRANSLATION_INVALID_KEY",
      "TRANSLATION_RATE_LIMITED",
      "TRANSLATION_MODEL_UNAVAILABLE",
      "TRANSLATION_TIMEOUT",
      "TRANSLATION_REFUSED",
      "TRANSLATION_INCOMPLETE",
    ];
    fail(
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "TRANSLATION_FAILED",
    );
  }
}

// Shared by all callers in this web process (including multiple browser tabs).
// Database/version guards additionally prevent stale writes across processes.
const inFlight = new WeakMap<DB, Map<string, Promise<Article>>>();
function translateNext(ctx: AuthedContext, input: Request): Promise<Article> {
  let pending = inFlight.get(ctx.db);
  if (!pending) {
    pending = new Map();
    inFlight.set(ctx.db, pending);
  }
  const key = JSON.stringify([ctx.user.id, input]);
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const article = await getArticle(ctx, input.bookmarkId);
    checkVersion(article, input);
    const batch = nextTranslationBatch(article.segments, article.translations);
    if (!batch.length) return article;
    requireEncryption();
    const settings = await getSettings(ctx);
    if (!settings) fail("TRANSLATION_KEY_REQUIRED");
    if (settings.model !== article.model)
      throw new TRPCError({ code: "CONFLICT", message: "TRANSLATION_STALE" });
    const previousCache = await ctx.db.query.bookmarkTranslations.findFirst({
      where: eq(bookmarkTranslations.bookmarkId, input.bookmarkId),
    });
    const translated = await invokeTranslation(
      readKey(settings, ctx.user.id),
      settings.model,
      batch,
    );
    // Re-read source/model after the network call, before opening a transaction.
    const current = await getArticle(ctx, input.bookmarkId);
    checkVersion(current, input);
    ctx.db.transaction((tx) => {
      const cached = tx
        .select()
        .from(bookmarkTranslations)
        .where(eq(bookmarkTranslations.bookmarkId, input.bookmarkId))
        .get();
      const generation =
        cached?.version === input.version ? cached.generation : 0;
      if (
        cached &&
        cached.version !== input.version &&
        (cached.version !== previousCache?.version ||
          cached.generation !== previousCache?.generation)
      )
        throw new TRPCError({ code: "CONFLICT", message: "TRANSLATION_STALE" });
      if (generation !== input.generation)
        throw new TRPCError({ code: "CONFLICT", message: "TRANSLATION_STALE" });
      const translations = {
        ...(cached?.version === input.version ? cached.translations : {}),
        ...translated,
      };
      tx.insert(bookmarkTranslations)
        .values({
          bookmarkId: input.bookmarkId,
          userId: ctx.user.id,
          version: input.version,
          generation,
          translations,
        })
        .onConflictDoUpdate({
          target: bookmarkTranslations.bookmarkId,
          set: { version: input.version, generation, translations },
        })
        .run();
    });
    return getArticle(ctx, input.bookmarkId);
  })();
  pending.set(key, promise);
  void promise.finally(() => pending.delete(key)).catch(() => undefined);
  return promise;
}

const limitedProcedure = sessionProcedure.use(
  createRateLimitMiddleware({
    name: "translations",
    windowMs: 60_000,
    maxRequests: 60,
  }),
);

export const translationsAppRouter = router({
  settings: sessionProcedure.query(async ({ ctx }) => {
    const settings = await getSettings(ctx);
    return {
      hasKey: !!settings,
      model: settings?.model ?? DEFAULT_TRANSLATION_MODEL,
      encryptionAvailable: encryptionAvailable(),
    };
  }),
  saveSettings: sessionProcedure
    .input(zTranslationSettingsInput)
    .mutation(async ({ ctx, input }) => {
      requireEncryption();
      if (
        process.env.NODE_ENV === "production" &&
        new URL(serverConfig.publicUrl).protocol !== "https:"
      )
        fail("TRANSLATION_HTTPS_REQUIRED");
      const old = await getSettings(ctx);
      if (!input.apiKey && !old) fail("TRANSLATION_KEY_REQUIRED");
      // Saving a model without a new key preserves the existing ciphertext.
      const encrypted = input.apiKey
        ? encryptTranslationKey(
            input.apiKey,
            ctx.user.id,
            serverConfig.translation.encryptionKey,
          )
        : old!;
      await ctx.db
        .insert(userTranslationSettings)
        .values({ ...encrypted, userId: ctx.user.id, model: input.model })
        .onConflictDoUpdate({
          target: userTranslationSettings.userId,
          set: {
            model: input.model,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag,
            encryptionVersion: encrypted.encryptionVersion,
          },
        });
      return { hasKey: true };
    }),
  deleteKey: sessionProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .delete(userTranslationSettings)
      .where(eq(userTranslationSettings.userId, ctx.user.id));
    return { hasKey: false };
  }),
  testConnection: limitedProcedure.mutation(async ({ ctx }) => {
    requireEncryption();
    const settings = await getSettings(ctx);
    if (!settings) fail("TRANSLATION_KEY_REQUIRED");
    await invokeTranslation(readKey(settings, ctx.user.id), settings.model, [
      { id: "test", text: "Hello" },
    ]);
    return { success: true };
  }),
  get: sessionProcedure
    .input(z.object({ bookmarkId: z.string() }))
    .query(({ ctx, input }) => getArticle(ctx, input.bookmarkId)),
  translateNext: limitedProcedure
    .input(zTranslationRequest)
    .mutation(({ ctx, input }) => translateNext(ctx, input)),
  reset: sessionProcedure
    .input(zTranslationRequest)
    .mutation(async ({ ctx, input }) => {
      const article = await getArticle(ctx, input.bookmarkId);
      checkVersion(article, input);
      ctx.db.transaction((tx) => {
        const cached = tx
          .select()
          .from(bookmarkTranslations)
          .where(eq(bookmarkTranslations.bookmarkId, input.bookmarkId))
          .get();
        const generation =
          (cached?.version === input.version ? cached.generation : 0) + 1;
        tx.insert(bookmarkTranslations)
          .values({
            userId: ctx.user.id,
            bookmarkId: input.bookmarkId,
            version: input.version,
            generation,
            translations: {},
          })
          .onConflictDoUpdate({
            target: bookmarkTranslations.bookmarkId,
            set: { version: input.version, generation, translations: {} },
          })
          .run();
      });
      return getArticle(ctx, input.bookmarkId);
    }),
});
