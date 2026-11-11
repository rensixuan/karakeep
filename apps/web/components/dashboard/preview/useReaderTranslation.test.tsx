// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReaderTranslation } from "./useReaderTranslation";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  next: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@karakeep/shared-react/trpc", () => ({
  useTRPC: () => ({
    translations: {
      get: {
        queryOptions: (input: unknown, options: object) => ({
          queryKey: ["translation", input],
          queryFn: mocks.get,
          ...options,
        }),
      },
      translateNext: {
        mutationOptions: (options: object) => ({
          mutationFn: mocks.next,
          ...options,
        }),
      },
      reset: {
        mutationOptions: (options: object) => ({
          mutationFn: mocks.reset,
          ...options,
        }),
      },
    },
  }),
}));

const base = {
  html: "<p>Hello</p>",
  titleIds: "",
  segments: [
    { id: "a", text: "Hello" },
    { id: "b", text: "World" },
  ],
  version: "v1",
  generation: 0,
  translations: {} as Record<string, string>,
  model: "test",
  hasKey: true,
  encryptionAvailable: true,
};
let saved = { ...base };
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const hook = renderHook(() => useReaderTranslation("book", true), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client };
}
beforeEach(() => {
  saved = { ...base, translations: {} };
  mocks.get.mockReset().mockImplementation(async () => saved);
  mocks.next.mockReset();
  mocks.reset.mockReset();
});
afterEach(cleanup);

describe("reader translation orchestration", () => {
  it("reloads segment versions after the saved source changes without starting paid work", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, rerender } = renderHook(
      ({ source }) => useReaderTranslation("book", true, source),
      {
        initialProps: { source: "old source" },
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.article?.version).toBe("v1"));
    saved = { ...saved, version: "v2", html: "<p>New source</p>" };
    rerender({ source: "new source" });
    await waitFor(() => expect(result.current.article?.version).toBe("v2"));
    expect(mocks.next).not.toHaveBeenCalled();
  });
  it("shows persisted results without automatically calling OpenAI", async () => {
    saved = { ...saved, translations: { a: "你好", b: "世界" } };
    const { result } = setup();
    await waitFor(() => expect(result.current.done).toBe(2));
    expect(result.current.visible).toBe(true);
    expect(mocks.next).not.toHaveBeenCalled();
  });
  it("pauses scheduling, saves the in-flight batch and resumes only missing work", async () => {
    let finish!: (value: typeof base) => void;
    mocks.next.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.article).toBeDefined());
    let work!: Promise<void>;
    act(() => {
      work = result.current.start();
    });
    await waitFor(() => expect(mocks.next).toHaveBeenCalledOnce());
    act(() => result.current.pause());
    saved = { ...saved, translations: { a: "你好" } };
    await act(async () => {
      finish(saved);
      await work;
    });
    await waitFor(() => expect(result.current.done).toBe(1));
    expect(mocks.next).toHaveBeenCalledOnce();
    mocks.next.mockImplementationOnce(async () => {
      saved = { ...saved, translations: { a: "你好", b: "世界" } };
      return saved;
    });
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(result.current.done).toBe(2));
    expect(mocks.next).toHaveBeenCalledTimes(2);
  });
  it("does not schedule more batches after unmount or repeated clicks", async () => {
    let finish!: (value: typeof base) => void;
    mocks.next.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, unmount } = setup();
    await waitFor(() => expect(result.current.article).toBeDefined());
    let work!: Promise<void>;
    act(() => {
      work = result.current.start();
      void result.current.start();
    });
    await waitFor(() => expect(mocks.next).toHaveBeenCalledOnce());
    unmount();
    await act(async () => {
      finish({ ...base, translations: { a: "你好" } });
      await work;
    });
    expect(mocks.next).toHaveBeenCalledOnce();
  });
  it("discards an old response after a new generation appears in the cache", async () => {
    let finish!: (value: typeof base) => void;
    mocks.next.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, client } = setup();
    await waitFor(() => expect(result.current.article).toBeDefined());
    let work!: Promise<void>;
    act(() => {
      work = result.current.start();
    });
    await waitFor(() => expect(mocks.next).toHaveBeenCalledOnce());
    await act(async () => {
      client.setQueryData(["translation", { bookmarkId: "book" }], {
        ...base,
        generation: 1,
      });
      finish({ ...base, translations: { a: "旧译文" } });
      await work;
    });
    expect(result.current.article?.generation).toBe(1);
    expect(result.current.done).toBe(0);
  });
});
