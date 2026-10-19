import { describe, expect, it } from "vitest"
import { classifyCrankRevert } from "../src/chain/reverts.js"

describe("classifyCrankRevert", () => {
  it.each([
    ["FeeAboveCeiling()", "1% ceiling", true, false],
    [
      "execution reverted: Burn amount exceeds per tx limit",
      "burn limit",
      true,
      false,
    ],
    ["execution reverted: Pausable: paused", "paused", true, true],
    [
      "execution reverted: Blacklistable: account is blacklisted",
      "blacklisted",
      true,
      true,
    ],
    [
      "execution reverted: Mint recipient must be nonzero",
      "mint recipient is zero",
      true,
      true,
    ],
    [
      "execution reverted: No remote TokenMessenger for domain",
      "no route to Sui",
      true,
      true,
    ],
    [
      "insufficient funds for gas * price + value",
      "could not pay",
      false,
      true,
    ],
    ["nonce too low", "nonce contention", false, false],
  ])("classifies %s", (message, fragment, wait, alert) => {
    const result = classifyCrankRevert(message)
    expect(result.reason).toContain(fragment)
    expect(result.wait).toBe(wait)
    expect(result.alert).toBe(alert)
  })

  it("recognises the forwarder's custom error by selector", () => {
    expect(classifyCrankRevert("reverted with 0x8f4eb604").wait).toBe(true)
  })

  it("waits on an unknown revert rather than retrying in a loop", () => {
    const result = classifyCrankRevert("execution reverted: something new")
    expect(result.wait).toBe(true)
    expect(result.alert).toBe(true)
    expect(result.reason).toContain("unclassified")
  })

  it("truncates a huge revert payload", () => {
    const result = classifyCrankRevert("x".repeat(5_000))
    expect(result.reason.length).toBeLessThan(260)
  })

  describe("the safety reading", () => {
    it("never treats a Circle condition as a failure to give up on", () => {
      for (const message of [
        "Pausable: paused",
        "Burn amount exceeds per tx limit",
        "FeeAboveCeiling()",
        "account is blacklisted",
      ])
        expect(classifyCrankRevert(message).wait).toBe(true)
    })

    it("treats our own gas problems as a retry, not a wait", () => {
      expect(classifyCrankRevert("insufficient funds for gas").wait).toBe(false)
    })
  })
})
