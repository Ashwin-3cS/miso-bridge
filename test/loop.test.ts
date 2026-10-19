import { describe, expect, it, vi } from "vitest"
import { runLoop } from "../src/workers/loop.js"

/** The delays are asserted, not waited for: sleep is injected. */
function harness(options: {
  ticks: Array<void | Error>
  intervalMs?: number
  maxBackoffMs?: number
}) {
  const controller = new AbortController()
  const delays: number[] = []
  const errors: Array<{ message: string; consecutive: number }> = []
  let index = 0

  const tick = vi.fn(async () => {
    const outcome = options.ticks[index]
    index += 1
    if (index >= options.ticks.length) controller.abort()
    if (outcome instanceof Error) throw outcome
  })

  return {
    tick,
    delays,
    errors,
    run: () =>
      runLoop({
        name: "test",
        intervalMs: options.intervalMs ?? 1_000,
        maxBackoffMs: options.maxBackoffMs,
        tick,
        signal: controller.signal,
        onError: (error, consecutive) =>
          errors.push({ message: (error as Error).message, consecutive }),
        sleep: async (ms) => {
          delays.push(ms)
        },
      }),
  }
}

describe("runLoop", () => {
  it("ticks until it is aborted", async () => {
    const h = harness({ ticks: [undefined, undefined, undefined] })
    await h.run()
    expect(h.tick).toHaveBeenCalledTimes(3)
  })

  it("sleeps the interval between healthy ticks", async () => {
    const h = harness({
      ticks: [undefined, undefined, undefined],
      intervalMs: 500,
    })
    await h.run()
    expect(h.delays).toEqual([500, 500])
  })

  it("survives a throwing tick and backs off exponentially", async () => {
    const boom = new Error("rpc down")
    const h = harness({
      ticks: [boom, boom, boom, undefined],
      intervalMs: 1_000,
    })
    await h.run()
    expect(h.delays).toEqual([1_000, 2_000, 4_000])
    expect(h.errors.map((e) => e.consecutive)).toEqual([1, 2, 3])
  })

  it("caps the backoff", async () => {
    const boom = new Error("still down")
    const h = harness({
      ticks: [boom, boom, boom, boom, undefined],
      intervalMs: 1_000,
      maxBackoffMs: 2_500,
    })
    await h.run()
    expect(h.delays).toEqual([1_000, 2_000, 2_500, 2_500])
  })

  it("resets the backoff after a success", async () => {
    const boom = new Error("blip")
    const h = harness({
      ticks: [boom, boom, undefined, boom, undefined],
      intervalMs: 1_000,
    })
    await h.run()
    expect(h.delays).toEqual([1_000, 2_000, 1_000, 1_000])
  })

  it("does not sleep after the tick that aborts it", async () => {
    const h = harness({ ticks: [undefined] })
    await h.run()
    expect(h.delays).toEqual([])
  })

  it("returns immediately when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const tick = vi.fn()
    await runLoop({
      name: "test",
      intervalMs: 1,
      tick,
      signal: controller.signal,
      sleep: async () => {},
    })
    expect(tick).not.toHaveBeenCalled()
  })
})
