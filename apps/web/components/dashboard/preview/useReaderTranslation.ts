import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

export function useReaderTranslation(
  bookmarkId: string,
  enabled: boolean,
  sourceContent?: string | null,
) {
  const api = useTRPC();
  const client = useQueryClient();
  const options = api.translations.get.queryOptions(
    { bookmarkId },
    { enabled, retry: false, staleTime: 0 },
  );
  const query = useQuery(options);
  const next = useMutation(
    api.translations.translateNext.mutationOptions({ retry: false }),
  );
  const reset = useMutation(
    api.translations.reset.mutationOptions({ retry: false }),
  );
  const [running, setRunning] = useState(false);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const previousSource = useRef(sourceContent);
  const pause = () => {
    run.current++;
    setRunning(false);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      run.current++;
    };
  }, [bookmarkId]);
  useEffect(() => {
    if (!enabled) pause();
  }, [enabled]);
  useEffect(() => {
    if (previousSource.current === sourceContent) return;
    previousSource.current = sourceContent;
    // A crawl refresh is external to this hook. Stop the old run and reload
    // server-owned segment IDs before offering another translation request.
    pause();
    if (enabled) void query.refetch();
  }, [sourceContent, enabled, query.refetch]);
  useEffect(() => {
    const leave = () => {
      if (document.visibilityState === "hidden") pause();
    };
    document.addEventListener("visibilitychange", leave);
    window.addEventListener("pagehide", pause);
    return () => {
      document.removeEventListener("visibilitychange", leave);
      window.removeEventListener("pagehide", pause);
    };
  }, []);

  const start = async (restart = false) => {
    if (busy.current || !enabled) return;
    busy.current = true;
    const token = ++run.current;
    setRunning(true);
    setVisible(true);
    setError(null);
    try {
      const fresh = await query.refetch({ throwOnError: true });
      if (!fresh.data || run.current !== token) return;
      let article = fresh.data;
      if (restart) {
        article = await reset.mutateAsync({
          bookmarkId,
          version: article.version,
          generation: article.generation,
        });
        if (!mounted.current || run.current !== token) return;
        client.setQueryData(options.queryKey, article);
      }
      while (
        mounted.current &&
        run.current === token &&
        article.segments.some((s) => !Object.hasOwn(article.translations, s.id))
      ) {
        const result = await next.mutateAsync({
          bookmarkId,
          version: article.version,
          generation: article.generation,
        });
        if (!mounted.current) return;
        // An explicit pause stops scheduling; the completed batch is still useful.
        const current = client.getQueryData(options.queryKey);
        if (
          current &&
          (current.version !== result.version ||
            current.generation !== result.generation)
        )
          break;
        client.setQueryData(options.queryKey, result);
        article = result;
      }
    } catch (err) {
      if (mounted.current && run.current === token) {
        setError(err instanceof Error ? err.message : "TRANSLATION_FAILED");
        // Another tab may have reset the translation or edited the article.
        void query.refetch();
      }
    } finally {
      busy.current = false;
      if (mounted.current && run.current === token) setRunning(false);
    }
  };
  const article = enabled ? query.data : undefined;
  return {
    article,
    running,
    visible,
    start,
    pause,
    pending: next.isPending || reset.isPending,
    error: error ?? (query.error?.message || null),
    loading: enabled && query.isPending,
    toggle: () => {
      if (visible) pause();
      setVisible(!visible);
    },
    done:
      article?.segments.filter((s) => Object.hasOwn(article.translations, s.id))
        .length ?? 0,
    total: article?.segments.length ?? 0,
  };
}
