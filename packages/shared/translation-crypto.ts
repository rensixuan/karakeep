import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedTranslationKey {
  ciphertext: string;
  nonce: string;
  authTag: string;
  encryptionVersion: number;
}

export function readTranslationEncryptionKey(
  value: string | undefined,
): Buffer {
  // Buffer.from alone accepts malformed/noncanonical base64. Fail closed.
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("TRANSLATION_ENCRYPTION_UNAVAILABLE");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("TRANSLATION_ENCRYPTION_UNAVAILABLE");
  }
  return key;
}

export function encryptTranslationKey(
  apiKey: string,
  userId: string,
  masterKey: string | undefined,
): EncryptedTranslationKey {
  const key = readTranslationEncryptionKey(masterKey);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`karakeep:translation-key:v1:${userId}`));
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      encryptionVersion: 1,
    };
  } finally {
    key.fill(0);
  }
}

export function decryptTranslationKey(
  encrypted: EncryptedTranslationKey,
  userId: string,
  masterKey: string | undefined,
): string {
  const key = readTranslationEncryptionKey(masterKey);
  try {
    if (encrypted.encryptionVersion !== 1) throw new Error();
    const nonce = Buffer.from(encrypted.nonce, "base64");
    const tag = Buffer.from(encrypted.authTag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`karakeep:translation-key:v1:${userId}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never propagate crypto/provider exceptions with credential material.
    throw new Error("TRANSLATION_KEY_UNREADABLE");
  } finally {
    key.fill(0);
  }
}
