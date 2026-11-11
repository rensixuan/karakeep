import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { Languages, Pause, RotateCcw } from "lucide-react";

import type { useReaderTranslation } from "./useReaderTranslation";

export function translationErrorKey(message: string) {
  const known = [
    "TRANSLATION_ENCRYPTION_UNAVAILABLE",
    "TRANSLATION_KEY_UNREADABLE",
    "TRANSLATION_HTTPS_REQUIRED",
    "TRANSLATION_KEY_REQUIRED",
    "TRANSLATION_INVALID_KEY",
    "TRANSLATION_RATE_LIMITED",
    "TRANSLATION_MODEL_UNAVAILABLE",
    "TRANSLATION_TIMEOUT",
    "TRANSLATION_REFUSED",
    "TRANSLATION_INCOMPLETE",
    "TRANSLATION_NO_CONTENT",
    "TRANSLATION_STALE",
  ] as const;
  return `reader_translation.errors.${known.find((code) => code === message) ?? "TRANSLATION_FAILED"}` as const;
}

export default function ReaderTranslationControls({
  state,
}: {
  state: ReturnType<typeof useReaderTranslation>;
}) {
  const { t } = useTranslation();
  const { article, running, pending, done, total, visible, error } = state;
  const configured = article?.hasKey && article.encryptionAvailable;
  return (
    <div
      className="mb-4 space-y-2 font-sans text-sm print:hidden"
      data-reader-translation=""
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            state.loading ||
            (!running &&
              (pending || !configured || total === 0 || done === total))
          }
          onClick={() => (running ? state.pause() : void state.start())}
        >
          {running ? (
            <Pause className="mr-2 size-4" />
          ) : (
            <Languages className="mr-2 size-4" />
          )}
          {t(
            running
              ? "reader_translation.pause"
              : done > 0 && done < total
                ? "reader_translation.continue"
                : "reader_translation.translate",
          )}
        </Button>
        {done > 0 && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={visible}
            onClick={state.toggle}
          >
            {t(visible ? "reader_translation.hide" : "reader_translation.show")}
          </Button>
        )}
        {done > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={running || pending || !configured}
            onClick={() => void state.start(true)}
          >
            <RotateCcw className="mr-2 size-4" />
            {t("reader_translation.restart")}
          </Button>
        )}
        {total > 0 && (
          <span
            role="status"
            aria-live="polite"
            className="text-muted-foreground"
          >
            {t("reader_translation.progress", { done, total })}
          </span>
        )}
        {article && !article.hasKey && (
          <Link className="underline" href="/settings/ai#reader-translation">
            {t("reader_translation.configure")}
          </Link>
        )}
      </div>
      {article && !article.encryptionAvailable && (
        <p className="text-muted-foreground">
          {t("reader_translation.errors.TRANSLATION_ENCRYPTION_UNAVAILABLE")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {t(translationErrorKey(error))}
        </p>
      )}
    </div>
  );
}
