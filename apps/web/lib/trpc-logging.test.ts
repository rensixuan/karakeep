import { describe, expect, it } from "vitest";
import { shouldLogTRPCOperation } from "./trpc-logging";

describe("translation log privacy", () => {
  it("suppresses response logs when a transport does not supply the operation path", () => {
    expect(
      shouldLogTRPCOperation({ direction: "down", result: new Error() }, true),
    ).toBe(false);
  });
  it("excludes credential requests and all translation responses even on development errors", () => {
    for (const development of [true, false]) {
      for (const direction of ["up", "down"] as const) {
        for (const path of [
          "translations.saveSettings",
          "translations.testConnection",
          "translations.get",
          "translations.translateNext",
        ]) {
          expect(
            shouldLogTRPCOperation(
              { path, direction, result: new Error("provider request failed") },
              development,
            ),
          ).toBe(false);
        }
      }
    }
  });
  it("preserves existing logging for unrelated operations", () => {
    expect(
      shouldLogTRPCOperation(
        { path: "bookmarks.getBookmark", direction: "up" },
        true,
      ),
    ).toBe(true);
    expect(
      shouldLogTRPCOperation(
        { path: "bookmarks.getBookmark", direction: "up" },
        false,
      ),
    ).toBe(false);
    expect(
      shouldLogTRPCOperation(
        {
          path: "bookmarks.getBookmark",
          direction: "down",
          result: new Error(),
        },
        false,
      ),
    ).toBe(true);
  });
});
