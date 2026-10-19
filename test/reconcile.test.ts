import { describe, expect, it, vi } from "vitest"
import type { Signer } from "../src/chain/signer.js"
import type { SuiMinter } from "../src/chain/sui.js"
import type { BurnRow, DepositRow, Journal } from "../src/journal.js"
import type { AlertSink } from "../src/observability.js"
import { reconcileOnce } from "../src/workers/reconcile.js"

/**
 * The reconciler only looks and alerts. These tests assert that it changes
 * nothing, and that the severity of each condition is right: a stuck transfer
 * pages, while Circle refusing a burn is a notice, because the funds are in
 * place and it clears on its own.
 */

const deposit = (over: Partial<DepositRow> = {}): DepositRow => ({
  id: "1",
  suiAddress: "0x" + "7".repeat(64),
  network: "mainnet",
  chain: "avalanche",
  forwarderAddress: "0x" + "a".repeat(40),
  status: "cranking",
  waitingReason: null,
  lastBalance: 7_000_000n,
  lastBalanceAt: new Date(),
  hotUntil: null,
  crankAttempts: 3,
  ...over,
})

const burn = (over: Partial<BurnRow> = {}): BurnRow => ({
  id: "1",
  depositId: "1",
  network: "mainnet",
  chain: "avalanche",
  txHash: "0x" + "b".repeat(64),
  burnIndex: 0,
  blockNumber: 1n,
  amount: 7_000_000n,
  status: "discovered",
  nonce: null,
  message: null,
  attestation: null,
  maxFee: null,
  feeExecuted: null,
  problem: null,
  delayReason: null,
  ...over,
})

const deadlines = {
  crankSeconds: 600,
  attestSeconds: 1_800,
  mintSeconds: 1_800,
  waitingSeconds: 3_600,
}

function harness(args: {
  cranking?: DepositRow[]
  waiting?: DepositRow[]
  unattested?: BurnRow[]
  unminted?: BurnRow[]
  quarantined?: BurnRow[]
}) {
  const raised: Array<{ kind: string; subject: string; severity: string }> = []
  const resolved: string[] = []

  const journal = {
    stalledDeposits: vi.fn(async ({ status }: { status: string }) =>
      status === "cranking" ? (args.cranking ?? []) : (args.waiting ?? [])
    ),
    stalledBurns: vi.fn(
      async ({ statuses }: { statuses: readonly string[] }) =>
        statuses.includes("discovered")
          ? (args.unattested ?? [])
          : (args.unminted ?? [])
    ),
    burnsByStatus: vi.fn(async () => args.quarantined ?? []),
    // Any write would be a bug: the reconciler looks and alerts.
    recordBalance: vi.fn(async () => {
      throw new Error("the reconciler must not change state")
    }),
    markWaiting: vi.fn(async () => {
      throw new Error("the reconciler must not change state")
    }),
  } as unknown as Journal

  const alerts = {
    raise: vi.fn(
      async (alert: { kind: string; subject: string; severity: string }) => {
        raised.push(alert)
      }
    ),
    resolve: vi.fn(async (kind: string, subject: string) => {
      resolved.push(`${kind}:${subject}`)
    }),
    openCount: vi.fn(async () => raised.length),
  } as unknown as AlertSink

  return { journal, alerts, raised, resolved }
}

const signerWith = (balance: bigint) =>
  ({
    address: "0x" + "9".repeat(40),
    chain: "avalanche" as const,
    gasBalance: vi.fn(async () => balance),
    simulate: vi.fn(),
    send: vi.fn(),
  }) as unknown as Signer

describe("reconcileOnce", () => {
  it("alerts on nothing when nothing is stuck", async () => {
    const h = harness({})
    const report = await reconcileOnce({
      journal: h.journal,
      alerts: h.alerts,
      deadlines,
    })
    expect(h.raised).toEqual([])
    expect(report).toMatchObject({
      stalledCranks: 0,
      unattested: 0,
      unminted: 0,
      quarantined: 0,
    })
  })

  it("pages for a crank that produced no finalized burn", async () => {
    const h = harness({ cranking: [deposit()] })
    await reconcileOnce({ journal: h.journal, alerts: h.alerts, deadlines })
    expect(h.raised).toMatchObject([
      {
        kind: "crank-produced-no-burn",
        subject: "deposit:1",
        severity: "page",
      },
    ])
  })

  it("treats Circle refusing a burn as a notice, not a page", async () => {
    const h = harness({
      waiting: [
        deposit({
          status: "waiting",
          waitingReason: "circle: transfers are paused",
        }),
      ],
    })
    await reconcileOnce({ journal: h.journal, alerts: h.alerts, deadlines })
    expect(h.raised[0]).toMatchObject({
      kind: "waiting-on-circle",
      severity: "notice",
    })
  })

  it("pages separately for each stuck leg", async () => {
    const h = harness({
      unattested: [burn({ id: "1" })],
      unminted: [
        burn({ id: "2", status: "validated", nonce: "0x" + "c".repeat(64) }),
      ],
    })
    await reconcileOnce({ journal: h.journal, alerts: h.alerts, deadlines })
    expect(h.raised.map((a) => a.kind)).toEqual([
      "burn-not-attested",
      "attested-but-not-minted",
    ])
  })

  it("pages for a quarantined burn with no deadline at all", async () => {
    const h = harness({
      quarantined: [burn({ status: "quarantined", problem: "byte 184" })],
    })
    await reconcileOnce({ journal: h.journal, alerts: h.alerts, deadlines })
    expect(h.raised).toMatchObject([
      { kind: "burn-quarantined", subject: "burn:1", severity: "page" },
    ])
    expect(h.raised[0]).toMatchObject({ payload: { problem: "byte 184" } })
  })

  describe("gas floors", () => {
    const gasFor = (evm: bigint, sui: bigint) => ({
      signers: [{ chain: "avalanche" as const, signer: signerWith(evm) }],
      sui: {
        address: "0x" + "9".repeat(64),
        gasBalance: vi.fn(async () => sui),
      } as unknown as SuiMinter,
      evmFloor: 10n ** 18n,
      suiFloor: 10n ** 9n,
    })

    it("pages when a signer cannot pay", async () => {
      const h = harness({})
      const report = await reconcileOnce({
        journal: h.journal,
        alerts: h.alerts,
        deadlines,
        gas: gasFor(1n, 1n),
      })
      expect(report.lowGas).toEqual(["gas:avalanche", "gas:sui"])
      expect(h.raised.map((a) => a.kind)).toEqual([
        "crank-gas-low",
        "mint-gas-low",
      ])
    })

    it("resolves the alert once a wallet is topped up", async () => {
      const h = harness({})
      await reconcileOnce({
        journal: h.journal,
        alerts: h.alerts,
        deadlines,
        gas: gasFor(10n ** 19n, 10n ** 10n),
      })
      expect(h.raised).toEqual([])
      expect(h.resolved).toEqual([
        "crank-gas-low:gas:avalanche",
        "mint-gas-low:gas:sui",
      ])
    })
  })
})
