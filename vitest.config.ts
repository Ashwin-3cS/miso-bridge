import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The pinned sibling repo ships its own test suite.
    exclude: [...configDefaults.exclude, "vendor/**"],
  },
  resolve: {
    alias: {
      // fileURLToPath, not URL.pathname: a space in the checkout path would
      // be percent-encoded and the alias would silently never match.
      "@misofm/cctp-forwarders": fileURLToPath(
        new URL("./vendor/cctp-forwarders/dist", import.meta.url)
      ),
    },
  },
})
