"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n/client";
import { translationErrorKey } from "@/components/dashboard/preview/ReaderTranslationControls";

import { useTRPC } from "@karakeep/shared-react/trpc";
import { DEFAULT_TRANSLATION_MODEL } from "@karakeep/shared/types/translations";

import { SettingsSection } from "./SettingsPage";

export default function TranslationSettings() {
  const { t } = useTranslation();
  const api = useTRPC();
  const client = useQueryClient();
  const settings = useQuery(api.translations.settings.queryOptions());
  const [apiKey, setApiKey] = useState("");
  const [modelDraft, setModel] = useState<string | null>(null);
  const model = modelDraft ?? settings.data?.model ?? DEFAULT_TRANSLATION_MODEL;
  type SuccessMessage =
    | "reader_translation.saved"
    | "reader_translation.connected"
    | "reader_translation.deleted";
  const [message, setMessage] = useState<SuccessMessage | null>(null);
  const [error, setError] = useState<ReturnType<
    typeof translationErrorKey
  > | null>(null);
  // Credentials must not linger in the React Query mutation cache.
  const save = useMutation(
    api.translations.saveSettings.mutationOptions({ gcTime: 0, retry: false }),
  );
  const remove = useMutation(
    api.translations.deleteKey.mutationOptions({ retry: false }),
  );
  const test = useMutation(
    api.translations.testConnection.mutationOptions({ retry: false }),
  );
  const busy = save.isPending || remove.isPending || test.isPending;
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: api.translations.settings.queryKey(),
      }),
      client.invalidateQueries({ queryKey: api.translations.get.queryKey() }),
    ]);
  };
  const perform = async (
    operation: () => Promise<unknown>,
    success: SuccessMessage,
  ) => {
    setError(null);
    setMessage(null);
    try {
      await operation();
      setMessage(success);
    } catch (err) {
      setError(translationErrorKey(err instanceof Error ? err.message : ""));
    }
  };
  return (
    <div id="reader-translation">
      <SettingsSection title={t("reader_translation.settings_title")}>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("reader_translation.settings_description")}
        </p>
        <form
          className="max-w-xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const local = ["localhost", "127.0.0.1", "[::1]"].includes(
                window.location.hostname,
              );
              if (window.location.protocol !== "https:" && !local)
                throw new Error("TRANSLATION_HTTPS_REQUIRED");
              try {
                await save.mutateAsync({
                  model,
                  ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                });
                setApiKey("");
                await refresh();
                setModel(null);
              } finally {
                save.reset();
              }
            }, "reader_translation.saved");
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="translation-api-key"
              className="text-sm font-medium"
            >
              OpenAI API Key
            </label>
            <Input
              id="translation-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t(
                settings.data?.hasKey
                  ? "reader_translation.key_saved"
                  : "reader_translation.key_placeholder",
              )}
              disabled={busy || !settings.data?.encryptionAvailable}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                settings.data?.hasKey
                  ? "reader_translation.key_saved_help"
                  : "reader_translation.key_help",
              )}
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="translation-model" className="text-sm font-medium">
              {t("reader_translation.model")}
            </label>
            <Input
              id="translation-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
              maxLength={100}
              disabled={busy}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                busy ||
                !settings.data?.encryptionAvailable ||
                (!settings.data.hasKey && !apiKey.trim())
              }
            >
              {t("reader_translation.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                busy ||
                !settings.data?.hasKey ||
                !settings.data.encryptionAvailable
              }
              onClick={() =>
                void perform(
                  () => test.mutateAsync(),
                  "reader_translation.connected",
                )
              }
            >
              {t("reader_translation.test")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || !settings.data?.hasKey}
              onClick={() =>
                void perform(async () => {
                  await remove.mutateAsync();
                  setApiKey("");
                  await refresh();
                }, "reader_translation.deleted")
              }
            >
              {t("reader_translation.delete_key")}
            </Button>
          </div>
          {settings.data && !settings.data.encryptionAvailable && (
            <p role="alert" className="text-sm text-destructive">
              {t(
                "reader_translation.errors.TRANSLATION_ENCRYPTION_UNAVAILABLE",
              )}
            </p>
          )}
          {settings.error && (
            <p role="alert" className="text-sm text-destructive">
              {t("reader_translation.errors.TRANSLATION_FAILED")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {t(message)}
            </p>
          )}
        </form>
      </SettingsSection>
    </div>
  );
}
