import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  bookmarkLinks,
  bookmarkTranslations,
  userTranslationSettings,
  users,
} from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { translateSegments } from "@karakeep/shared/translation-client";
import { decryptTranslationKey } from "@karakeep/shared/translation-crypto";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { DEFAULT_TRANSLATION_MODEL } from "@karakeep/shared/types/translations";
import { defaultBeforeEach } from "../testUtils";
import type { CustomTestContext } from "../testUtils";

vi.mock("@karakeep/shared/translation-client", () => ({
  translateSegments: vi.fn(),
}));
const originalMaster = serverConfig.translation.encryptionKey;
const fakeKey = "test-only-openai-key";
beforeEach<CustomTestContext>(defaultBeforeEach(true));
beforeEach(() => {
  serverConfig.translation.encryptionKey = randomBytes(32).toString("base64");
  vi.mocked(translateSegments)
    .mockReset()
    .mockImplementation(async (_key, _model, segments) =>
      Object.fromEntries(segments.map((s) => [s.id, `译文 ${s.text}`])),
    );
});
afterEach(() => {
  serverConfig.translation.encryptionKey = originalMaster;
  vi.unstubAllEnvs();
});

async function seedArticle(
  ctx: CustomTestContext,
  html = "<p>Hello</p><p>World</p>",
) {
  await ctx.apiCallers[0].translations.saveSettings({
    model: DEFAULT_TRANSLATION_MODEL,
    apiKey: fakeKey,
  });
  const bookmark = await ctx.apiCallers[0].bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/article",
  });
  await ctx.db
    .update(bookmarkLinks)
    .set({ htmlContent: html })
    .where(eq(bookmarkLinks.id, bookmark.id));
  return {
    bookmarkId: bookmark.id,
    ...(await ctx.apiCallers[0].translations.get({ bookmarkId: bookmark.id })),
  };
}

describe("translation routes", () => {
  test<CustomTestContext>("encrypts persisted keys and returns only safe configuration", async (ctx) => {
    const api = ctx.apiCallers[0].translations;
    await api.saveSettings({
      model: DEFAULT_TRANSLATION_MODEL,
      apiKey: fakeKey,
    });
    const stored = await ctx.db.query.userTranslationSettings.findFirst();
    expect(JSON.stringify(stored)).not.toContain(fakeKey);
    expect(stored).toBeDefined();
    expect(
      decryptTranslationKey(
        stored!,
        stored!.userId,
        serverConfig.translation.encryptionKey,
      ),
    ).toBe(fakeKey);
    expect(await api.settings()).toEqual({
      model: DEFAULT_TRANSLATION_MODEL,
      hasKey: true,
      encryptionAvailable: true,
    });
    await api.saveSettings({ model: "different-model" });
    expect(
      (await ctx.db.query.userTranslationSettings.findFirst())?.ciphertext,
    ).toBe(stored?.ciphertext);
    await api.saveSettings({
      model: DEFAULT_TRANSLATION_MODEL,
      apiKey: fakeKey,
    });
    expect(
      (await ctx.db.query.userTranslationSettings.findFirst())?.nonce,
    ).not.toBe(stored?.nonce);
    await api.deleteKey();
    expect(
      await ctx.db.query.userTranslationSettings.findFirst(),
    ).toBeUndefined();
  });
  test<CustomTestContext>("fails closed without a master key and requires HTTPS in production", async (ctx) => {
    serverConfig.translation.encryptionKey = "invalid";
    await expect(
      ctx.apiCallers[0].translations.saveSettings({
        model: DEFAULT_TRANSLATION_MODEL,
        apiKey: fakeKey,
      }),
    ).rejects.toThrow("TRANSLATION_ENCRYPTION_UNAVAILABLE");
    expect(
      await ctx.db.query.userTranslationSettings.findFirst(),
    ).toBeUndefined();
    serverConfig.translation.encryptionKey = randomBytes(32).toString("base64");
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      ctx.apiCallers[0].translations.saveSettings({
        model: DEFAULT_TRANSLATION_MODEL,
        apiKey: fakeKey,
      }),
    ).rejects.toThrow("TRANSLATION_HTTPS_REQUIRED");
  });
  test<CustomTestContext>("isolates user keys and rejects anonymous and other-owner access", async (ctx) => {
    const article = await seedArticle(ctx);
    expect((await ctx.apiCallers[1].translations.settings()).hasKey).toBe(
      false,
    );
    await expect(ctx.apiCallers[1].translations.get(article)).rejects.toThrow();
    await expect(
      ctx.apiCallers[1].translations.translateNext(article),
    ).rejects.toThrow();
    await expect(
      ctx.apiCallers[1].translations.reset(article),
    ).rejects.toThrow();
    await expect(
      ctx.unauthedAPICaller.translations.settings(),
    ).rejects.toThrow();
    await ctx.apiCallers[1].translations.deleteKey();
    expect((await ctx.apiCallers[0].translations.settings()).hasKey).toBe(true);
    expect(translateSegments).not.toHaveBeenCalled();
  });
  test<CustomTestContext>("saves and reuses batches, and invalidates source/model versions", async (ctx) => {
    const article = await seedArticle(ctx, "<p>Paragraph</p>".repeat(25));
    const api = ctx.apiCallers[0].translations;
    let current = await api.translateNext(article);
    expect(Object.keys(current.translations).length).toBe(8);
    expect((await api.get(article)).translations).toEqual(current.translations);
    while (Object.keys(current.translations).length < current.segments.length)
      current = await api.translateNext({
        bookmarkId: article.bookmarkId,
        ...current,
      });
    const calls = vi.mocked(translateSegments).mock.calls.length;
    await api.translateNext({ bookmarkId: article.bookmarkId, ...current });
    expect(translateSegments).toHaveBeenCalledTimes(calls);
    serverConfig.translation.encryptionKey = undefined;
    expect((await api.get(article)).translations).toEqual(current.translations);
    serverConfig.translation.encryptionKey = randomBytes(32).toString("base64");
    await ctx.db
      .update(bookmarkLinks)
      .set({ htmlContent: "<p>Changed</p>" })
      .where(eq(bookmarkLinks.id, article.bookmarkId));
    expect((await api.get(article)).translations).toEqual({});
    await expect(api.translateNext(article)).rejects.toThrow(
      "TRANSLATION_STALE",
    );
    const changed = await api.get(article);
    await api.saveSettings({ model: "new-model", apiKey: fakeKey });
    expect((await api.get(article)).version).not.toBe(changed.version);
  });
  test<CustomTestContext>("deduplicates concurrent requests and rejects results from before reset", async (ctx) => {
    const article = await seedArticle(ctx);
    let resolve!: (value: Record<string, string>) => void;
    vi.mocked(translateSegments).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const api = ctx.apiCallers[0].translations;
    const first = api.translateNext(article);
    const second = api.translateNext(article);
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(translateSegments).toHaveBeenCalledTimes(1));
    const reset = await api.reset(article);
    resolve(
      Object.fromEntries(article.segments.map((s) => [s.id, "Old result"])),
    );
    expect(
      (await outcomes).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(reset.generation).toBe(1);
    expect((await api.get(article)).translations).toEqual({});
  });
  test<CustomTestContext>("preserves completed batches and sanitizes provider failures", async (ctx) => {
    const article = await seedArticle(ctx, "<p>Paragraph</p>".repeat(20));
    const api = ctx.apiCallers[0].translations;
    const first = await api.translateNext(article);
    vi.mocked(translateSegments).mockRejectedValue(
      new Error(`provider echoed ${fakeKey}`),
    );
    await expect(
      api.translateNext({ bookmarkId: article.bookmarkId, ...first }),
    ).rejects.toThrow("TRANSLATION_FAILED");
    expect((await api.get(article)).translations).toEqual(first.translations);
    await ctx.db
      .update(userTranslationSettings)
      .set({ authTag: randomBytes(16).toString("base64") });
    await expect(api.testConnection()).rejects.toThrow(
      "TRANSLATION_KEY_UNREADABLE",
    );
  });
  test<CustomTestContext>("cascades cached translations and encrypted credentials on deletion", async (ctx) => {
    const article = await seedArticle(ctx);
    await ctx.apiCallers[0].translations.translateNext(article);
    await ctx.apiCallers[0].bookmarks.deleteBookmark(article);
    expect(await ctx.db.select().from(bookmarkTranslations)).toEqual([]);
    const setting = await ctx.db.query.userTranslationSettings.findFirst();
    await ctx.db.delete(users).where(eq(users.id, setting!.userId));
    expect(await ctx.db.select().from(userTranslationSettings)).toEqual([]);
  });
});
