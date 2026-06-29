# Compute — Threat Model

This document states, honestly and precisely, what you must trust to use Compute,
what each privileged role can and cannot do, the defenses that bound those
powers, the residual trust assumptions, the explicit non-goals, and the
invariants the program proves. It describes the **shipped, hardened binary FPMM
program**.

> **Bottom line.** The arithmetic core is sound and property-tested; the
> conservation invariant holds across every instruction. The remaining trust is
> concentrated in **settlement**: a single trusted `resolver` key proposes the
> outcome. That power is deliberately defended in depth — a two-step timelock, a
> guardian veto, and a liveness escape hatch — but it is a real, documented trust
> assumption, not an oracle. **Not audited; do not use with real funds.**

## 1. Trusted roles and their exact powers

There are four privileged roles. Each is a single key today (operators **should**
back the admin, guardian, and upgrade authority with a Squads multisig — see
[`DEPLOYMENT.md`](DEPLOYMENT.md)).

### Admin (`Config.admin`)

**CAN:**

- Set the taker fee `set_fee_bps` (re-checked `<= MAX_FEE_BPS = 1000`).
- Replace the guardian `set_guardian`.
- Pause / unpause all trading `set_paused`.
- Sweep accrued protocol fees `collect_fees` (the `fee_accrued` bucket only).
- Transfer the admin role via a two-step `set_admin` → `accept_admin`.

**CANNOT:**

- Touch collateral backing user positions. `collect_fees` moves only
  `fee_accrued`; it can never reach `market.collateral`.
- Resolve, propose, finalize, or void any market.
- Change a market's `resolver`, `question`, `close_time`, or `resolution_time`
  after creation.
- Mint, burn, or transfer outcome tokens or vault collateral arbitrarily.
- Raise the fee above 10%.

### Guardian (`Config.guardian`)

**CAN:**

- Pause / unpause all trading `set_paused`.
- Veto a proposed outcome during the dispute window `dispute_void`, sending the
  market to a 50/50 void refund.

**CANNOT:**

- Choose or change the winning outcome (only veto into a void).
- Act after the dispute window closes, or before an outcome is proposed.
- Collect fees, change fees, or transfer admin.
- Touch collateral directly.

### Resolver (`Market.resolver`, per market)

**CAN:**

- Propose the winning outcome `propose_outcome`, at/after `resolution_time`,
  which starts the dispute window.

**CANNOT:**

- Finalize the outcome (that is permissionless, and only after the timelock).
- Propose before `resolution_time`, or after the market has left OPEN.
- Move funds. Proposing only writes `proposed_outcome` + `resolved_at`; **no
  payout happens at proposal time.**
- Override a guardian veto.

### Upgrade authority (Solana BPF loader, off-program)

**CAN:**

- Deploy new program bytecode to the same program ID, changing **any** logic
  above. This is the ultimate trust root.

**CANNOT (as a property we recommend enforcing):**

- Nothing within the program constrains it. Custody must be controlled
  operationally — hold the upgrade authority in a multisig and move toward
  immutability/governance after audit. See [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Unprivileged actors (anyone)

Anyone may `create_market`, `seed_liquidity` (if they are the creator), `buy`,
`sell`, `redeem`, `redeem_void`, `claim_pool` (if they are the LP),
`finalize_outcome` (crank), and `void_stale` (crank). Permissionless cranking of
finalize/void is a feature: it removes liveness dependence on any single actor.

## 2. Settlement defenses (defense in depth)

The settlement surface — historically the place a prediction market "lives or
dies" — is bounded by four independent mechanisms:

| Defense | Mechanism | Bounds which power |
|---|---|---|
| **Two-step resolution + timelock** | `propose_outcome` → wait `dispute_period` → `finalize_outcome`. Payouts stay locked during the window. | A wrong/malicious resolver proposal is not immediately actionable. |
| **Guardian veto** | `dispute_void` during the window → `STATE_VOID` (50/50 refund). | A bad proposal or compromised resolver. |
| **Liveness escape hatch** | `void_stale` after `resolution_time + VOID_GRACE_PERIOD` (7 days) if still OPEN → `STATE_VOID`. Permissionless. | A resolver who never proposes; prevents permanently stranded collateral. |
| **Pause switch** | `set_paused` by admin **or** guardian halts `buy`/`sell`/`seed_liquidity`. | Incident response while a fix is deployed. |

Additional structural guards:

- **Trading halts at `close_time`** (`now < close_time` enforced in buy/sell),
  with `close_time <= resolution_time`, so there is no informed last-look trading
  after the market should be settled.
- **`resolver_kind` + 64 reserved bytes** make room for pluggable oracle
  resolvers (Switchboard / Pyth / optimistic) **without a layout-breaking
  migration**. Only `RESOLVER_TRUSTED_KEY = 0` is accepted today; any other kind
  reverts with `UnsupportedResolverKind`.
- **Two-step admin transfer** (`set_admin` → `accept_admin`) prevents handing
  admin to a wrong/dead key in one step.

## 3. Residual trust assumptions

Even with the defenses above, you must trust:

1. **The resolver reports honestly (the core assumption).** `resolver_kind` is
   `TRUSTED_KEY`: the outcome is whatever the `resolver` key proposes. There is
   **no oracle**. The only thing standing between a dishonest proposal and a
   wrong payout is the **guardian** (who can only veto into a void, not correct
   the outcome) acting **within the dispute window**. If the resolver is
   dishonest *and* the guardian fails to veto in time, the wrong side is paid.
2. **The guardian is available and honest during dispute windows.** It is the
   sole corrective for a bad proposal. A compromised guardian could grief by
   voiding good resolutions (→ 50/50 refunds) or by pausing trading; it cannot
   steal collateral or pick a winner.
3. **The admin and upgrade authority keys are secure.** A compromised upgrade
   authority can replace the program entirely. A compromised admin can pause,
   change fees within the cap, and sweep the fee bucket — but not the collateral.
4. **Clock honesty.** All timelocks key off `Clock::unix_timestamp`; the model
   assumes the Solana cluster clock is not materially manipulable.
5. **Collateral-mint behavior.** Collateral is a standard legacy SPL mint; the
   model assumes it is non-rebasing and non-fee-on-transfer (`Account<Mint>`
   already rejects Token-2022 at `initialize`).

## 4. Non-goals and known limitations (current MVP)

These are **intended scope cuts**, not bugs. Documented so no one mistakes the
MVP for a finished oracle-backed protocol.

- **No real oracle.** Settlement is a trusted key. Switchboard/Pyth/optimistic
  resolvers are designed-for (`resolver_kind` + reserved padding) but **not
  implemented**.
- **No scalar / range markets.** Binary YES/NO only. The research-designated
  flagship (a scalar GPU-price market) cannot yet be expressed.
- **Single-seed liquidity.** One LP per market (`lp` / `lp_shares` is the
  creator's single seed); no `add_liquidity` / `remove_liquidity`, no
  multi-LP share ledger, no fee share to LPs. The LP's seed is one-sided at-risk
  capital until settlement.
- **Guardian can only void, not correct.** A wrong outcome can be neutralized
  (50/50 refund) but not fixed to the true outcome on-chain.
- **No Asian-VWAP / time-averaged settlement accumulator.** Resolution is a
  single proposed value, appropriate only because the resolver is trusted.
- **Not audited.** No external security audit has been performed. Do not use with
  real funds on mainnet.

## 5. Proven / enforced invariants

The program's safety rests on these, asserted by unit/property tests
(`math.rs`) and the integration suite:

- **Conservation.** `vault balance == market.collateral + market.fee_accrued` at
  all times. Outcome tokens are minted/burned only as full sets, so
  `yes_supply == no_supply == market.collateral` while trading. Settlement
  conserves: RESOLVED pays winners 1:1 against `collateral`; VOID pays half per
  token (`amount / 2`, rounded down), which never over-pays the vault.
- **Constant product never decreases (`k` non-decrease).** Every trade satisfies
  `r_yes' · r_no' >= r_yes · r_no`. Value cannot be extracted from the pool by
  repeated trading (round-trip non-profitability is property-tested).
- **Rounding favors the pool.** The retained reserve is rounded **up** (`ceil`);
  traders receive slightly fewer tokens on a buy and pay slightly more on a sell.
  This is the mechanism behind `k` non-decrease and is asserted directly,
  including ceil-tightness and no-underflow of `keep`/`need`.
- **Checked arithmetic throughout.** All payout/accounting math uses checked
  ops; overflow fails closed with `MathOverflow`. The `u64` truncation in
  `quote_buy` is the fundamental SPL supply ceiling and fails closed, not a leak.
- **Authorization is explicit.** Every privileged instruction checks the signer
  against the stored role (`admin`/`guardian`/`resolver`/`lp`/`creator`), and
  token accounts are validated by mint/owner (`WrongMint`/`WrongOwner`) and by
  PDA seeds/address.

## 6. Attacker scenarios (worked)

| Scenario | Outcome |
|---|---|
| Resolver proposes the wrong outcome | Guardian `dispute_void`s within the window → 50/50 refund. If the guardian misses the window, the wrong side is paid (residual trust #1/#2). |
| Resolver disappears (never proposes) | After `resolution_time + 7d`, anyone `void_stale`s → 50/50 refund. Collateral is never permanently stranded. |
| Compromised admin | Can pause, set fee ≤ 10%, sweep `fee_accrued`. Cannot touch collateral, resolve, or void. |
| Compromised guardian | Can pause and void good resolutions (grief). Cannot pick a winner or steal funds. |
| Trader tries to extract value by round-tripping trades | Impossible: `k` is non-decreasing and rounding favors the pool; a buy-then-sell costs ≥ the tokens received. |
| Trader substitutes a wrong token account | Rejected by mint/owner constraints (`WrongMint` / `WrongOwner`) and PDA address checks. |
| Late "last-look" trade after the event is known | Rejected: trading halts at `close_time <= resolution_time`. |
| Donated tokens to a pool to desync reserves | Inert: burns/quotes use recorded reserves, not `.amount`; the donor only self-griefs. |
| Compromised upgrade authority | Can replace all program logic — the ultimate trust root; mitigate with a multisig and post-audit immutability. |
