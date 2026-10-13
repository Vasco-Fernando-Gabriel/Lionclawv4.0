import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDashboardFreshnessReport,
  requestFreshnessReport,
  startFreshnessRefresh,
  type DashboardFreshnessReport,
  type FreshnessBridge,
} from "../freshness";
import type { BridgeResponse } from "../bridge";

function bridgeResponse(partial: Partial<BridgeResponse> & { body?: unknown }): BridgeResponse {
  const body = partial.body;
  return {
    ok: partial.ok ?? true,
    status: partial.status ?? (partial.ok === false ? 500 : 200),
    json: partial.json ?? (async () => body),
    text: partial.text ?? (async () => JSON.stringify(body)),
  };
}

function stubBridge(response: BridgeResponse): FreshnessBridge & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(async () => response) };
}

const freshReport: DashboardFreshnessReport = {
  graphs: {
    knowledge: {
      status: "fresh",
      graphCommitHash: "a".repeat(40),
      headCommitHash: "a".repeat(40),
      changedFileCount: 0,
      changedFiles: [],
      commitsBehind: 0,
      commitsAhead: 0,
    },
  },
};

const staleReport: DashboardFreshnessReport = {
  graphs: {
    knowledge: {
      status: "stale",
      relation: "behind",
      graphCommitHash: "a".repeat(40),
      headCommitHash: "b".repeat(40),
      changedFileCount: 1,
      changedFiles: ["src/index.ts"],
      commitsBehind: 1,
      commitsAhead: 0,
    },
  },
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isDashboardFreshnessReport", () => {
  it("accepts complete fresh, dirty, stale, and unknown graph results", () => {
    expect(isDashboardFreshnessReport(freshReport)).toBe(true);
    expect(
      isDashboardFreshnessReport({
        graphs: {
          knowledge: {
            status: "dirty",
            graphCommitHash: "a".repeat(40),
            headCommitHash: "a".repeat(40),
            changedFileCount: 1,
            changedFiles: ["src/dirty.ts"],
            commitsBehind: 0,
            commitsAhead: 0,
          },
          domain: staleReport.graphs.knowledge,
        },
      }),
    ).toBe(true);
    expect(
      isDashboardFreshnessReport({
        graphs: {
          knowledge: {
            status: "unknown",
            reason: "git-command-timeout",
            graphCommitHash: "a".repeat(40),
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    { graphs: { knowledge: { status: "fresh" } } },
    { graphs: { knowledge: { status: "stale" } } },
    { graphs: { knowledge: { status: "dirty" } } },
    { graphs: { knowledge: { status: "unknown" } } },
    { graphs: {} },
    { graphs: { knowledge: freshReport.graphs.knowledge, domain: null } },
    {
      graphs: {
        knowledge: {
          ...freshReport.graphs.knowledge,
          changedFileCount: 1,
        },
      },
    },
    {
      graphs: {
        knowledge: {
          ...staleReport.graphs.knowledge,
          relation: "sideways",
        },
      },
    },
    {
      graphs: {
        knowledge: {
          ...staleReport.graphs.knowledge,
          changedFiles: [42],
        },
      },
    },
    {
      graphs: {
        knowledge: {
          status: "unknown",
          reason: "unexpected-reason",
        },
      },
    },
  ])("rejects malformed payload %#", (payload) => {
    expect(isDashboardFreshnessReport(payload)).toBe(false);
  });
});

describe("requestFreshnessReport", () => {
  it("accepts the LionCode response with a full count and a capped list of 200 paths", async () => {
    const payload = { graphs: { knowledge: { ...staleReport.graphs.knowledge,
      changedFileCount: 327, changedFiles: Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`),
    } } };
    const bridge = stubBridge(bridgeResponse({ body: payload }));
    await expect(requestFreshnessReport(bridge, new AbortController().signal)).resolves.toEqual(payload);
    expect(isDashboardFreshnessReport({ graphs: { knowledge: { ...payload.graphs.knowledge, changedFileCount: 199 } } })).toBe(false);
  });

  it("accepts changed history with zero changed files and server-specific unknown reasons", () => {
    expect(isDashboardFreshnessReport({ graphs: { knowledge: { ...staleReport.graphs.knowledge,
      changedFileCount: 0, changedFiles: [], relation: 'diverged', commitsAhead: 0, commitsBehind: 0,
    } } })).toBe(true);
    for (const reason of ['graph-missing', 'meta-missing']) {
      expect(isDashboardFreshnessReport({ graphs: { knowledge: { status: 'unknown', reason,
        changedFileCount: 0, changedFiles: [], commitsAhead: 0, commitsBehind: 0,
      } } })).toBe(true);
    }
  });

  it("requests the `staleness` resource through the bridge with the signal", async () => {
    const signal = new AbortController().signal;
    const bridge = stubBridge(bridgeResponse({ body: freshReport }));

    await expect(requestFreshnessReport(bridge, signal)).resolves.toEqual(freshReport);
    expect(bridge.fetch).toHaveBeenCalledTimes(1);
    expect(bridge.fetch).toHaveBeenCalledWith("staleness", undefined, { signal });
  });

  it.each([
    bridgeResponse({ ok: false, status: 404, body: freshReport }),
    bridgeResponse({ ok: false, status: 0, body: undefined }),
    bridgeResponse({ body: { graphs: { knowledge: { status: "fresh" } } } }),
    bridgeResponse({ body: null }),
  ])("rejects an unusable bridge response %#", async (response) => {
    await expect(
      requestFreshnessReport(stubBridge(response), new AbortController().signal),
    ).rejects.toThrow();
  });

  it("propagates a bridge rejection (timeout/abort) unchanged", async () => {
    const failure = new Error("Bridge request timed out after 60000ms (staleness)");
    const bridge: FreshnessBridge = { fetch: vi.fn(async () => { throw failure; }) };

    await expect(
      requestFreshnessReport(bridge, new AbortController().signal),
    ).rejects.toBe(failure);
  });
});

describe("startFreshnessRefresh", () => {
  it("loads initially and only reloads when the target receives focus", async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const load = vi.fn(async () => freshReport);
    const onResult = vi.fn();

    const stop = startFreshnessRefresh({ target, load, onResult });
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(freshReport);

    stop();
    vi.useRealTimers();
  });

  it("aborts an in-flight request before replacing it on focus", async () => {
    const target = new EventTarget();
    const pending: Array<{
      signal: AbortSignal;
      resolve: (report: DashboardFreshnessReport) => void;
    }> = [];
    const load = vi.fn(
      (signal: AbortSignal) =>
        new Promise<DashboardFreshnessReport>((resolve) => {
          pending.push({ signal, resolve });
        }),
    );
    const onResult = vi.fn();

    const stop = startFreshnessRefresh({ target, load, onResult });
    expect(pending).toHaveLength(1);
    target.dispatchEvent(new Event("focus"));
    expect(pending).toHaveLength(2);
    expect(pending[0].signal.aborted).toBe(true);

    pending[0].resolve(staleReport);
    pending[1].resolve(freshReport);
    await flushPromises();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(freshReport);

    stop();
  });

  it("replaces stale and fresh states after successive focus events", async () => {
    const target = new EventTarget();
    const load = vi
      .fn<(signal: AbortSignal) => Promise<DashboardFreshnessReport>>()
      .mockResolvedValueOnce(staleReport)
      .mockResolvedValueOnce(freshReport)
      .mockResolvedValueOnce(staleReport);
    const onResult = vi.fn();

    const stop = startFreshnessRefresh({ target, load, onResult });
    await flushPromises();
    expect(onResult).toHaveBeenLastCalledWith(staleReport);

    target.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(onResult).toHaveBeenLastCalledWith(freshReport);

    target.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(onResult).toHaveBeenLastCalledWith(staleReport);
    expect(onResult).toHaveBeenCalledTimes(3);

    stop();
  });

  it("publishes an explicit unknown result when loading fails", async () => {
    const onResult = vi.fn();

    const stop = startFreshnessRefresh({
      target: new EventTarget(),
      load: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
      onResult,
    });
    await flushPromises();

    expect(onResult).toHaveBeenCalledWith({
      graphs: {
        knowledge: {
          status: "unknown",
          reason: "freshness-request-failed",
        },
      },
    });
    stop();
  });

  it("removes the focus listener and aborts on cleanup", async () => {
    const target = new EventTarget();
    let initialSignal: AbortSignal | undefined;
    const load = vi.fn(
      (signal: AbortSignal) =>
        new Promise<DashboardFreshnessReport>(() => {
          initialSignal = signal;
        }),
    );

    const stop = startFreshnessRefresh({
      target,
      load,
      onResult: vi.fn(),
    });
    stop();

    expect(initialSignal?.aborted).toBe(true);
    target.dispatchEvent(new Event("focus"));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
