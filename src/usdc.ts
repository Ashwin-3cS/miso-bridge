/** USDC has six decimals. Base units in, a decimal string out. */
export function formatUsdc(baseUnits: bigint): string {
  const negative = baseUnits < 0n
  const value = negative ? -baseUnits : baseUnits
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, "0")
  return `${negative ? "-" : ""}${whole}.${fraction}`
}
