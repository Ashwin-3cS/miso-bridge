import type { Evidence, Journal } from "./journal.js"

/**
 * Structured logs and alerts.
 *
 * Logs are one JSON object per line, because the only consumer that matters is
 * whoever is reading them during an incident. Nothing logs a config object or
 * a row directly: amounts are bigints, which JSON.stringify throws on, and
 * secrets live behind a redacting wrapper.
 *
 * An alert opens once and resolves once. The journal holds that state -- a
 * unique index on (kind, subject, network) among open rows -- so a worker
 * restarting does not re-page, and a condition that clears and returns pages
 * again.
 */

export const levels = ["debug", "info", "warn", "error"] as const
export type Level = (typeof levels)[number]

export type Logger = {
  debug(at: string, fields?: Record<string, unknown>): void
  info(at: string, fields?: Record<string, unknown>): void
  warn(at: string, fields?: Record<string, unknown>): void
  error(at: string, fields?: Record<string, unknown>): void
}

/** JSON that survives a bigint, which every amount and block number is. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  )
}

export function createLogger(options: {
  level: Level
  /** Stamped on every line, so two networks' logs never read as one. */
  network: string
  write?: (line: string) => void
}): Logger {
  const write = options.write ?? ((line: string) => console.log(line))
  const threshold = levels.indexOf(options.level)
  const emit =
    (level: Level) =>
    (at: string, fields: Record<string, unknown> = {}) => {
      if (levels.indexOf(level) < threshold) return
      write(
        safeJson({
          t: new Date().toISOString(),
          level,
          network: options.network,
          at,
          ...fields,
        })
      )
    }
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  }
}

/**
 * `page` is for a condition a human should look at now. `notice` is for one
 * that is expected to clear on its own -- Circle paused, a fee above the
 * ceiling -- and is recorded so that it can be seen to have cleared.
 */
export type Severity = "page" | "notice"

export type AlertSink = {
  raise(alert: {
    kind: string
    subject: string
    severity: Severity
    payload?: Evidence
  }): Promise<void>
  resolve(kind: string, subject: string): Promise<void>
  openCount(): Promise<number>
}

export function createAlertSink(options: {
  journal: Journal
  logger: Logger
  webhookUrl?: string
  fetchFn?: typeof fetch
}): AlertSink {
  const { journal, logger } = options
  const fetchFn = options.fetchFn ?? fetch

  return {
    async raise({ kind, subject, severity, payload }) {
      const isNew = await journal.openAlert({ kind, subject, payload })
      if (!isNew) return
      logger[severity === "page" ? "error" : "warn"]("alert", {
        kind,
        subject,
        severity,
        ...payload,
      })
      if (options.webhookUrl === undefined) return
      try {
        await fetchFn(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: safeJson({
            kind,
            subject,
            severity,
            network: journal.network,
            payload,
          }),
        })
      } catch (error) {
        // A webhook that is down must not take the worker with it; the alert
        // is already durable in the journal.
        logger.error("alert-delivery-failed", {
          kind,
          subject,
          message: (error as Error).message,
        })
      }
    },

    async resolve(kind, subject) {
      await journal.closeAlert(kind, subject)
    },

    async openCount() {
      return (await journal.openAlerts()).length
    },
  }
}
