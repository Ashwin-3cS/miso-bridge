/**
 * The run-forever wrapper every worker shares.
 *
 * A tick that throws is logged and retried with exponential backoff, never
 * fatal: an RPC blip, a database failover or a rate limit must not take a
 * worker out until someone notices. `sleep` is injected so the backoff is
 * testable without waiting for it.
 */

export type LoopOptions = {
  name: string
  intervalMs: number
  tick: () => Promise<void>
  signal?: AbortSignal
  onError?: (error: unknown, consecutive: number) => void
  /** Cap on the backoff delay; the interval is the floor. */
  maxBackoffMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })

export async function runLoop(options: LoopOptions): Promise<void> {
  const {
    intervalMs,
    tick,
    signal,
    onError,
    maxBackoffMs = 60_000,
    sleep = defaultSleep,
  } = options
  let consecutiveErrors = 0

  while (signal === undefined || !signal.aborted) {
    try {
      await tick()
      consecutiveErrors = 0
    } catch (error) {
      consecutiveErrors += 1
      onError?.(error, consecutiveErrors)
    }
    if (signal?.aborted === true) break
    const delay =
      consecutiveErrors === 0
        ? intervalMs
        : Math.min(intervalMs * 2 ** (consecutiveErrors - 1), maxBackoffMs)
    await sleep(delay, signal)
  }
}
