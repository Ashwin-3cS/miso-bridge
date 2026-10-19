import { describe, expect, it, vi } from "vitest"
import type { Journal } from "../src/journal.js"
import {
  createAlertSink,
  createLogger,
  safeJson,
} from "../src/observability.js"

describe("safeJson", () => {
  it("survives the bigints every amount in this service is", () => {
    expect(safeJson({ amount: 7_000_000n, block: 97_000_000n })).toBe(
      '{"amount":"7000000","block":"97000000"}'
    )
    expect(() => JSON.stringify({ amount: 1n })).toThrow()
  })
})

describe("createLogger", () => {
  const capture = (level: Parameters<typeof createLogger>[0]["level"]) => {
    const lines: string[] = []
    return {
      lines,
      logger: createLogger({
        level,
        network: "mainnet",
        write: (l) => lines.push(l),
      }),
    }
  }

  it("writes one JSON object per line, stamped with the network", () => {
    const { lines, logger } = capture("info")
    logger.info("crank", { depositId: "1", gasUsed: 173_344n })
    const entry = JSON.parse(lines[0] as string)
    expect(entry).toMatchObject({
      level: "info",
      network: "mainnet",
      at: "crank",
      depositId: "1",
      gasUsed: "173344",
    })
    expect(typeof entry.t).toBe("string")
  })

  it("drops anything below the threshold", () => {
    const { lines, logger } = capture("warn")
    logger.debug("a")
    logger.info("b")
    logger.warn("c")
    logger.error("d")
    expect(lines.map((l) => JSON.parse(l).at)).toEqual(["c", "d"])
  })
})

describe("createAlertSink", () => {
  function harness(
    options: { alreadyOpen?: boolean; webhookFails?: boolean } = {}
  ) {
    const open = new Set<string>()
    const journal = {
      network: "mainnet" as const,
      openAlert: vi.fn(
        async ({ kind, subject }: { kind: string; subject: string }) => {
          const key = `${kind}:${subject}`
          if (open.has(key) || options.alreadyOpen === true) return false
          open.add(key)
          return true
        }
      ),
      closeAlert: vi.fn(async (kind: string, subject: string) => {
        open.delete(`${kind}:${subject}`)
      }),
      openAlerts: vi.fn(async () =>
        [...open].map((k) => ({ kind: k, subject: k }))
      ),
    } as unknown as Journal

    const posts: unknown[] = []
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      if (options.webhookFails === true) throw new Error("webhook down")
      posts.push(JSON.parse(String(init?.body)))
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    const lines: string[] = []
    const logger = createLogger({
      level: "debug",
      network: "mainnet",
      write: (l) => lines.push(l),
    })
    return {
      posts,
      lines,
      journal,
      sink: createAlertSink({
        journal,
        logger,
        webhookUrl: "https://alerts.test/hook",
        fetchFn,
      }),
    }
  }

  const alert = {
    kind: "burn-not-attested",
    subject: "burn:1",
    severity: "page" as const,
    payload: { txHash: "0xabc" },
  }

  it("pages once, however often the condition is seen", async () => {
    const h = harness()
    await h.sink.raise(alert)
    await h.sink.raise(alert)
    await h.sink.raise(alert)
    expect(h.posts.length).toBe(1)
    expect(h.lines.filter((l) => JSON.parse(l).at === "alert").length).toBe(1)
  })

  it("pages again after the condition clears and returns", async () => {
    const h = harness()
    await h.sink.raise(alert)
    await h.sink.resolve(alert.kind, alert.subject)
    await h.sink.raise(alert)
    expect(h.posts.length).toBe(2)
  })

  it("logs a page as an error and a notice as a warning", async () => {
    const h = harness()
    await h.sink.raise(alert)
    await h.sink.raise({ ...alert, subject: "burn:2", severity: "notice" })
    const levels = h.lines
      .filter((l) => JSON.parse(l).at === "alert")
      .map((l) => JSON.parse(l).level)
    expect(levels).toEqual(["error", "warn"])
  })

  it("survives a webhook that is down, because the alert is already durable", async () => {
    const h = harness({ webhookFails: true })
    await expect(h.sink.raise(alert)).resolves.toBeUndefined()
    expect(h.journal.openAlert).toHaveBeenCalled()
    expect(
      h.lines.some((l) => JSON.parse(l).at === "alert-delivery-failed")
    ).toBe(true)
  })

  it("sends no payload bigger than the condition", async () => {
    const h = harness()
    await h.sink.raise(alert)
    expect(h.posts[0]).toEqual({
      kind: "burn-not-attested",
      subject: "burn:1",
      severity: "page",
      network: "mainnet",
      payload: { txHash: "0xabc" },
    })
  })
})
