# Compute — Operations

Day-to-day runbook for the people who operate a live Compute deployment: the
**resolver**, the **guardian**, the **admin**, and whoever **cranks** finalize.
Pair this with [`THREAT_MODEL.md`](THREAT_MODEL.md) (who can do what) and
[`REFERENCE.md`](REFERENCE.md) (exact instruction semantics).

> **The one rule that matters most:** there is **no undo once a market is
> finalized**. `finalize_outcome` is irreversible and pays out the proposed
> outcome. The **dispute window is your only safety net** — it exists so a wrong
> proposal can be caught *before* it finalizes. Treat the window as load-bearing.

## 1. Resolver decision checklist

Run through this **before** calling `propose_outcome`. Once you propose, the
timelock starts; once it finalizes, it cannot be reversed.

- [ ] **Timing.** Is `now >= resolution_time`? Proposing earlier reverts
      (`TooEarlyToResolve`).
- [ ] **State.** Is the market still `OPEN` (not already RESOLVING/VOID)?
- [ ] **Source.** Have you checked the market's `resolution_source` and the
      underlying real-world result it names? Resolve to what the source says, not
      to intuition.
- [ ] **Outcome value.** Is `outcome` exactly `0` (YES) or `1` (NO)? Anything
      else reverts (`InvalidOutcome`).
- [ ] **Ambiguity.** If the real-world outcome is genuinely ambiguous, undefined,
      or the source failed, **do not propose a guess** — let the guardian void it,
      or let it go stale into `void_stale` (50/50 refund). A wrong finalize is
      worse than a void.
- [ ] **Key hygiene.** Are you signing with the correct `resolver` key (ideally a
      multisig)? A wrong signer reverts (`Unauthorized`).

After proposing, **publish your reasoning** (the source print, timestamp, the
chosen side) so the guardian and traders can verify within the dispute window.

> Reminder: proposing does **not** move funds. Payout only happens at
> `finalize_outcome`, after `dispute_period`. There is still time to be vetoed.

## 2. Guardian playbook

The guardian has two levers: **pause** (global) and **dispute_void** (per
market, during the window). It cannot pick a winner — only veto into a 50/50
void.

### When to `dispute_void`

During a market's dispute window (`resolved_at <= now < resolved_at +
dispute_period`), void a proposal when:

- The proposed outcome **contradicts the named resolution source**.
- The resolver appears **compromised** or is proposing on markets it shouldn't.
- The real-world result is **ambiguous / undefined** and the resolver proposed a
  side anyway.
- Two credible reads of the source **disagree materially** (better to refund
  50/50 than to finalize a contested outcome).

Voiding sends the market to `STATE_VOID` (reason `DISPUTE`): holders use
`redeem_void` (half collateral per token) and the LP uses `claim_pool` (half of
each reserve). This is a fair refund, not a correction — you cannot set the right
outcome on-chain.

> Act **before the window closes**. After `resolved_at + dispute_period`,
> `dispute_void` reverts (`DisputeWindowClosed`) and anyone can finalize.

### When to `set_paused(true)`

Pause (admin or guardian) when you need to stop the bleeding while a fix or
investigation is in flight:

- A suspected bug in trading or settlement.
- A resolver/admin/guardian **key compromise**.
- An upstream incident (collateral mint, RPC, oracle pipeline once one exists).

Pausing halts `buy`/`sell`/`seed_liquidity` globally (`Paused`). It does **not**
stop `redeem`/`redeem_void`/`claim_pool`/finalize — users can still exit settled
markets. Unpause with `set_paused(false)` once resolved. Every toggle emits
`PausedSet`; alert on it.

## 3. Cranking finalize and void

Both are **permissionless** — anyone can call them, so run a small keeper:

- **`finalize_outcome`** — for each `RESOLVING` market, once
  `now >= resolved_at + dispute_period`, call it to move the market to `RESOLVED`
  and unlock payouts. Until someone cranks it, payouts stay locked. Calling early
  reverts (`DisputeWindowOpen`).
- **`void_stale`** — for each `OPEN` market past `resolution_time +
  VOID_GRACE_PERIOD` (7 days) with no proposal, call it to move the market to
  `VOID` so collateral is freed for `redeem_void` / `claim_pool`. Calling early
  reverts (`TooEarlyToVoid`).

Recommended keeper cadence: poll markets each minute; act as soon as the relevant
deadline passes. These are idempotent in effect (a second call on an
already-advanced market simply reverts on the state check).

## 4. Fee-sweep cadence (admin)

Protocol fees accrue per market in `fee_accrued`. `collect_fees` (admin) sweeps a
single market's bucket to the admin's collateral account and resets it to zero;
it reverts with `NothingToClaim` when the bucket is empty, and it can **never**
touch collateral backing positions.

- **Cadence:** there is no urgency (fees sit safely in the vault as a separate
  counter). Sweep on a regular schedule (e.g. weekly) or opportunistically per
  market after it sees volume.
- **Note:** `collect_fees` is per market — iterate over markets with
  `fee_accrued > 0`. It works in any state (including after settlement).

## 5. Monitoring signals (events to watch)

Index these events (see [`REFERENCE.md`](REFERENCE.md) for fields) and alert on
the highlighted ones:

| Event | Watch for | Why |
|---|---|---|
| `OutcomeProposed` | **every occurrence** | Starts a dispute window. The guardian must review the proposal **before** `proposed_at + dispute_period`. This is the most time-sensitive signal. |
| `MarketResolved` | every occurrence | A market finalized (irreversible). Reconcile that the finalized `outcome` matched the proposal you reviewed. |
| `MarketVoided` | **every occurrence** | `reason = 0` (DISPUTE) = guardian veto fired; `reason = 1` (STALE) = a resolver never proposed (resolver-liveness problem worth investigating). |
| `PausedSet` | **every occurrence** | Trading was paused/unpaused — confirm it was intentional. |
| `TradeExecuted` | anomalies | Volume/flow monitoring; sudden one-sided flow near `close_time`. |
| `Redeemed` / `PoolClaimed` / `FeesCollected` | reconciliation | Track payouts against the vault to confirm the conservation invariant `vault == collateral + fee_accrued` holds. |

Operational alarms to configure:

- **Proposal without guardian review** — page the guardian when an
  `OutcomeProposed` has no human sign-off and the window is closing.
- **Stale-void risk** — warn when an `OPEN` market passes `resolution_time` with
  no `OutcomeProposed` (a resolver may be down; `void_stale` becomes available at
  +7 days).
- **Finalize backlog** — alert when a `RESOLVING` market is past its window but
  not yet `RESOLVED` (your finalize crank may be stuck).
- **Conservation drift** — alarm if an off-chain reconstruction of
  `collateral + fee_accrued` ever diverges from the on-chain vault balance.

## 6. Quick incident response

1. **Contain:** `set_paused(true)` (admin or guardian) to stop new trading.
2. **Triage:** identify whether it's a key compromise, a bug, or an upstream
   issue. Check recent `OutcomeProposed` / `MarketVoided` / `PausedSet`.
3. **Protect settlements:** for any in-flight bad proposal, `dispute_void` before
   the window closes.
4. **Remediate:** rotate keys (`set_guardian`, two-step `set_admin` →
   `accept_admin`, change a market's resolver only by creating new markets — a
   live market's resolver is fixed) and, if code is at fault, prepare a
   multisig-approved program upgrade (see [`DEPLOYMENT.md`](DEPLOYMENT.md)).
5. **Disclose:** follow [`SECURITY.md`](../SECURITY.md).
6. **Resume:** `set_paused(false)` once safe.
