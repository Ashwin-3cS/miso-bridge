import { loadConfig, describeConfig } from "../config.js"
import { openDb } from "../db.js"
import { openJournal } from "../journal.js"
import { createRouter } from "./routes.js"

/** Binds the router to a port. Everything testable lives in routes.ts. */
if (import.meta.main) {
  const config = loadConfig()
  const db = openDb(config)
  const journal = openJournal(db, config.NETWORK)
  const handle = createRouter({ config, db, journal })

  console.log(JSON.stringify({ at: "boot", config: describeConfig(config) }))

  const server = Bun.serve({
    port: config.API_PORT,
    fetch: async (request) => {
      const started = Date.now()
      try {
        const response = await handle(request)
        console.log(
          JSON.stringify({
            at: "request",
            method: request.method,
            path: new URL(request.url).pathname,
            status: response.status,
            ms: Date.now() - started,
          })
        )
        return response
      } catch (error) {
        // Never echo an error body: it may quote a request we did not validate.
        console.error(
          JSON.stringify({
            at: "error",
            path: new URL(request.url).pathname,
            message: (error as Error).message,
          })
        )
        return new Response(JSON.stringify({ error: "internal error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
    },
  })
  console.log(JSON.stringify({ at: "listening", port: server.port }))
}
