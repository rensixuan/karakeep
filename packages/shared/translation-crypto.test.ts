import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptTranslationKey,
  encryptTranslationKey,
  readTranslationEncryptionKey,
} from "./translation-crypto";

describe("translation credential encryption", () => {
  const master = randomBytes(32).toString("base64");
  const secret = "test-only-provider-credential";
  it("round trips with independent nonces and no plaintext fields", () => {
    const first = encryptTranslationKey(secret, "user-1", master);
    const second = encryptTranslationKey(secret, "user-1", master);
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptTranslationKey(first, "user-1", master)).toBe(secret);
  });
  it("rejects another user, another master key and tampered authenticated data", () => {
    const encrypted = encryptTranslationKey(secret, "user-1", master);
    expect(() => decryptTranslationKey(encrypted, "user-2", master)).toThrow(
      "TRANSLATION_KEY_UNREADABLE",
    );
    expect(() =>
      decryptTranslationKey(
        encrypted,
        "user-1",
        randomBytes(32).toString("base64"),
      ),
    ).toThrow("TRANSLATION_KEY_UNREADABLE");
    for (const field of ["nonce", "ciphertext", "authTag"] as const) {
      const bytes = Buffer.from(encrypted[field], "base64");
      bytes[0] ^= 1;
      expect(() =>
        decryptTranslationKey(
          { ...encrypted, [field]: bytes.toString("base64") },
          "user-1",
          master,
        ),
      ).toThrow("TRANSLATION_KEY_UNREADABLE");
    }
    expect(() =>
      decryptTranslationKey(
        { ...encrypted, encryptionVersion: 2 },
        "user-1",
        master,
      ),
    ).toThrow("TRANSLATION_KEY_UNREADABLE");
  });
  it.each([
    undefined,
    "",
    "short",
    "a".repeat(44),
    randomBytes(31).toString("base64"),
    randomBytes(33).toString("base64"),
  ])("fails closed for malformed master keys", (value) => {
    expect(() => readTranslationEncryptionKey(value)).toThrow(
      "TRANSLATION_ENCRYPTION_UNAVAILABLE",
    );
    expect(() => encryptTranslationKey(secret, "user-1", value)).toThrow(
      "TRANSLATION_ENCRYPTION_UNAVAILABLE",
    );
  });
});
