import { createHash, timingSafeEqual } from "node:crypto"
import type { Secret } from "../config.js"

/**
 * Service-to-service bearer auth.
 *
 * Compares SHA-256 digests rather than the tokens themselves, so the compare
 * is constant-time and constant-length: timingSafeEqual throws on a length
 * mismatch, which would otherwise leak the token's length.
 */

const digest = (value: string) => createHash("sha256").update(value).digest()

export function authorize(
  request: Request,
  secret: Secret | undefined
): boolean {
  // No secret configured: open. loadConfig refuses this on mainnet.
  if (secret === undefined) return true
  const header = request.headers.get("authorization")
  if (header === null) return false
  const [scheme, token] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer" || token === undefined) return false
  return timingSafeEqual(digest(token), digest(secret.reveal()))
}
