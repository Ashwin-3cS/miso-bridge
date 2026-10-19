import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The pinned sibling repo ships its own test suite.
    exclude: [...configDefaults.exclude, "vendor/**"],
  },
  resolve: {
    alias: {
      "@misofm/cctp-forwarders": new URL(
        "./vendor/cctp-forwarders/dist",
        import.meta.url
      ).pathname,
    },
  },
})
