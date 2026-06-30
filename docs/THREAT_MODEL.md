# Compute — Threat Model

This document states, honestly and precisely, what you must trust to use Compute,
what each privileged role can and cannot do, the defenses that bound those
powers, the residual trust assumptions, the explicit non-goals, and the
invariants the program proves. It describes the **shipped, hardened binary FPMM
program**.

> **Bottom line.** The arithmetic core is sound and property-tested; the
> conservation invariant holds across every instruction. The remaining trust is
> concentrated in **settlement**: the proposed outcome comes from either a single
> trusted `resolver` key (default) or, for oracle-feed markets, the `authority` of
> a bound on-chain `PriceFeed` (a feed-bridge adapter — see [`ORACLE.md`](ORACLE.md)).
> Either way that power is deliberately defended in depth — a two-step timelock, a
> guardian veto, and a liveness escape hatch — and even an oracle proposal is
> *vetoable*, not final. It is a real, documented trust assumption; the feed-bridge
> adapter narrows but does not eliminate it. **Not audited; do not use with real funds.**

## 1. Trusted roles and their exact powers

There are four global/per-market privileged roles below, plus a per-feed **feed
authority** that resolves oracle-feed markets. Each is a single key today
(operators **should** back the admin, guardian, and upgrade authority with a Squads
multisig — see [`DEPLOYMENT.md`](DEPLOYMENT.md)).

### Admin (`Config.admin`)

**CAN:**

- Set the taker fee `set_fee_bps` (re-checked `<= MAX_FEE_BPS = 1000`).
- Set the LP fee share `set_lp_fee_bps` (re-checked `<= 10_000` bps) — the fraction
  of each taker fee reinvested to LPs (the rest accrues to the protocol).
- Set the optimistic-resolver bond `set_bond_amount` (`0` disables `assert_outcome`).
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
  market to a 50/50 void refund (trusted-key / oracle-feed markets).
- On `RESOLVER_OPTIMISTIC` markets only, **settle a disputed assertion** via
  `resolve_dispute(correct_outcome)` — here it *picks the correct outcome* and
  awards the `2 · bond` escrow to the matching side (see the optimistic-resolver
  role below). `dispute_void` is disabled on those markets.

**CANNOT:**

- Choose or change the winning outcome on trusted-key / oracle-feed markets (only
  veto into a void). The outcome-picking power exists **only** on optimistic markets
  and only for a *disputed* assertion.
- Act after the dispute window closes, or before an outcome is proposed/asserted.
- Collect fees, change fees, or transfer admin.
- Touch collateral directly (bond payouts move only the separate bond vault).

### Resolver (`Market.resolver`, per market — trusted-key markets)

**CAN:**

- Propose the winning outcome `propose_outcome` (binary) or a settlement value
  `propose_scalar(value)` (scalar), at/after `resolution_time`, which starts the
  dispute window. Only on `RESOLVER_TRUSTED_KEY` markets.

**CANNOT:**

- Finalize the outcome (that is permissionless, and only after the timelock). For
  scalar markets, finalize is what maps `proposed_value` to the settlement
  fraction; the resolver only supplies the raw value.
- Propose before `resolution_time`, or after the market has left OPEN.
- Propose on a `RESOLVER_ORACLE_FEED` market (reverts `WrongResolverKind`), or use
  the wrong proposal instruction for the `market_kind` (`propose_outcome` on a
  scalar market / `propose_scalar` on a binary market reverts `WrongMarketKind`).
- Move funds. Proposing only writes `proposed_outcome`/`proposed_value` +
  `resolved_at`; **no payout happens at proposal time.**
- Override a guardian veto.

### Feed authority (`PriceFeed.authority`, per feed — oracle-feed markets)

On `RESOLVER_ORACLE_FEED` markets the trusted resolver key is replaced by the
**authority of the bound `PriceFeed`** (a Switchboard On-Demand Function enclave or
a committee multisig — see [`ORACLE.md`](ORACLE.md)). It is the new locus of
settlement trust for those markets.

**CAN:**

- Set the feed's `value` and stamp `published_at` via `publish_price`. The posted
  value (compared to the market's `oracle_strike` under `oracle_comparison`) is
  what `propose_from_oracle` turns into a proposed outcome.

**CANNOT:**

- Propose, finalize, or void any market directly; it only writes the feed. The
  proposal is a separate, **permissionless** `propose_from_oracle` call that runs
  the comparison and enters the **same dispute window**.
- Bypass the staleness guard: a value older than `oracle_max_staleness` at proposal
  time is rejected (`StaleFeed`), and an unpublished feed is rejected
  (`FeedHasNoValue`).
- Pick the strike/comparison (fixed at `create_market`) or move funds.
- Override a guardian veto — a manipulated feed value yields a *vetoable* proposal,
  not a final one.

### Optimistic resolver participants (asserter / disputer — `RESOLVER_OPTIMISTIC` markets)

On `RESOLVER_OPTIMISTIC` markets (binary only) there is **no privileged resolver
key**: the proposed outcome comes from a **bonded assertion** that anyone may make,
and the guardian acts as the **dispute arbiter** (not just a veto). The trust here
is **economic**, backed by `config.bond_amount`.

**An asserter / disputer (anyone) CAN:**

- `assert_outcome(outcome)` by posting `config.bond_amount` into the bond vault,
  starting the dispute window (permissionless, at/after `resolution_time`).
- `dispute_assertion()` an open assertion by posting an **equal** bond (anyone
  except the asserter; self-dispute is blocked with `SelfDispute`).
- `finalize_assertion()` an **undisputed** assertion after the window — reclaiming
  their own bond and resolving the market to the asserted outcome.

**They CANNOT:**

- Touch the collateral `vault`. Bonds escrow **only** in the separate bond vault
  PDA (`["bond", market]`); the collateral conservation invariant is never involved.
- Self-finalize a **disputed** assertion (`DisputeUnresolved`) — only the guardian
  settles a contested one.
- Steal a counterparty's bond outside the rules: on the disputed path the whole
  `2 · bond` goes to whoever asserted the side the **guardian** rules correct, and
  the payout destination is constrained to the stored asserter/disputer
  (`winner_collateral` owner/mint are checked).

**Bond economics.** A false assertion is costly: if challenged and ruled wrong, the
asserter forfeits their `bond` to the disputer (and vice-versa). An honest asserter
of an uncontested outcome simply reclaims their bond. This makes the *expected* cost
of asserting a wrong outcome positive, so honest assertion is the equilibrium —
the guardian is only invoked on the contested path.

**Guardian as dispute arbiter (extra power on optimistic markets).** On these
markets the guardian's `resolve_dispute(correct_outcome)` **picks the correct
outcome** (and routes `2 · bond` to the matching asserter), rather than only vetoing
into a 50/50 void as on trusted/oracle markets. `dispute_void` is disabled here. So
a compromised guardian on an optimistic market could mis-award a *disputed* bond and
pick the wrong winning outcome — a strictly larger power than on the other kinds,
and the locus of residual trust for optimistic settlement. Bonds remain isolated
from collateral throughout.

### Upgrade authority (Solana BPF loader, off-program)

**CAN:**

- Deploy new program bytecode to the same program ID, changing **any** logic
  above. This is the ultimate trust root.

**CANNOT (as a property we recommend enforcing):**

- Nothing within the program constrains it. Custody must be controlled
  operationally — hold the upgrade authority in a multisig and move toward
  immutability/governance after audit. See [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Unprivileged actors (anyone)

Anyone may `create_market`, `seed_liquidity` (if they are the creator),
`add_liquidity`, `remove_liquidity` / `claim_pool` (against their own
signer-bound `LiquidityPosition`), `buy`, `sell`, `redeem` / `redeem_scalar`,
`redeem_void`, `finalize_outcome` (crank), and `void_stale` (crank). Permissionless
cranking of finalize/void is a feature: it removes liveness dependence on any
single actor. Anyone can become an LP via `add_liquidity`; the share ledger
(`LiquidityPosition` + `market.total_shares`) and floor/ceil rounding (§5) ensure
no LP is over- or under-credited.

## 2. Settlement defenses (defense in depth)

The settlement surface — historically the place a prediction market "lives or
dies" — is bounded by four independent mechanisms:

| Defense | Mechanism | Bounds which power |
|---|---|---|
| **Two-step resolution + timelock** | `propose_outcome` / `propose_from_oracle` / `assert_outcome` → wait `dispute_period` → `finalize_outcome` / `finalize_assertion`. Payouts stay locked during the window. | A wrong/malicious resolver proposal, a manipulated oracle feed, **or a bonded optimistic assertion** is not immediately actionable. |
| **Guardian veto / dispute settlement** | `dispute_void` during the window → `STATE_VOID` (50/50 refund) on trusted-key / oracle markets; `resolve_dispute(correct_outcome)` on a **disputed** optimistic market. | A bad proposal, a compromised resolver, a manipulated `PriceFeed` value (all enter the same window), or a contested optimistic assertion (settled bond-weighted to the correct side). |
| **Bonded assert/dispute** | `RESOLVER_OPTIMISTIC`: anyone may `assert_outcome` (bond) and anyone may `dispute_assertion` (equal bond); the loser forfeits their bond to the winner. | A wrong optimistic assertion is *economically* costly and *challengeable* by anyone — not just vetoable. Bonds escrow in a **separate** vault, isolated from collateral. |
| **Liveness escape hatch** | `void_stale` after `resolution_time + VOID_GRACE_PERIOD` (7 days) if still OPEN → `STATE_VOID`. Permissionless. | A resolver who never proposes; prevents permanently stranded collateral. |
| **Pause switch** | `set_paused` by admin **or** guardian halts `buy`/`sell`/`seed_liquidity`. | Incident response while a fix is deployed. |

Additional structural guards:

- **Trading halts at `close_time`** (`now < close_time` enforced in buy/sell),
  with `close_time <= resolution_time`, so there is no informed last-look trading
  after the market should be settled.
- **Oracle-feed staleness guard.** On a `RESOLVER_ORACLE_FEED` market,
  `propose_from_oracle` rejects an unpublished feed (`FeedHasNoValue`) and any value
  older than `oracle_max_staleness` (`StaleFeed`), so settlement cannot run on a
  silently-frozen feed; a feed that never refreshes leaves the market to the
  liveness hatch (`void_stale`) instead.
- **Optimistic bonds isolated from collateral.** Optimistic-resolver bonds escrow
  in a dedicated bond vault PDA (`["bond", market]`), **separate** from the
  collateral `vault`. Every settlement path nets the bond vault to zero (refund on
  undisputed; `2 · bond` to the winner on disputed), so the
  `vault == collateral + fee_accrued` invariant is never involved. The winner's
  destination is constrained (owner/mint of `winner_collateral` checked against the
  guardian's ruling).
- **`resolver_kind` + 64 reserved bytes** make room for pluggable resolvers
  **without a layout-breaking migration**. Three kinds are wired today —
  `RESOLVER_TRUSTED_KEY = 0` (default), `RESOLVER_ORACLE_FEED = 1` (the feed-bridge
  adapter), and `RESOLVER_OPTIMISTIC = 2` (bonded assert/dispute, binary only);
  native Switchboard-account parsing and Pyth are **deferred** (see
  [`ORACLE.md`](ORACLE.md) §11 for the toolchain-conflict evidence). Any unknown
  kind reverts with `UnsupportedResolverKind`.
- **Two-step admin transfer** (`set_admin` → `accept_admin`) prevents handing
  admin to a wrong/dead key in one step.

## 3. Residual trust assumptions

Even with the defenses above, you must trust:

1. **The proposed value is honest (the core assumption).** For a `TRUSTED_KEY`
   market the outcome is whatever the `resolver` key proposes. For a
   `RESOLVER_ORACLE_FEED` market it is derived from the bound `PriceFeed`, whose
   `authority` (a Switchboard On-Demand Function enclave or a committee multisig —
   see [`ORACLE.md`](ORACLE.md)) you must trust to post the licensed off-chain index
   honestly. The feed-bridge adapter **narrows** this trust — a TEE-attested or
   multisig feed is harder to forge than a single resolver key, and the program
   does not parse Switchboard's native account (the `PriceFeed` is the integration
   boundary) — but it does not remove it. In both cases the only thing standing
   between a dishonest/manipulated value and a wrong payout is the **guardian** (who
   can only veto into a void, not correct the outcome) acting **within the dispute
   window**. If the value is wrong *and* the guardian fails to veto in time, the
   wrong side is paid.
   For a `RESOLVER_OPTIMISTIC` market there is no proposer key at all: the outcome
   is whatever survives the bonded assert/dispute game, and the **guardian settles a
   dispute by picking the correct outcome** (residual trust #2). The bond makes a
   wrong assertion costly and challengeable by anyone, but if a wrong assertion goes
   *unchallenged* through the whole window, it finalizes — so honest, attentive
   disputers are part of the assumption.
2. **The guardian is available and honest during dispute windows.** On trusted-key
   / oracle markets it is the sole corrective for a bad proposal; a compromised
   guardian could grief by voiding good resolutions (→ 50/50 refunds) or by pausing,
   but cannot steal collateral or pick a winner. **On `RESOLVER_OPTIMISTIC` markets
   the guardian is strictly more powerful**: `resolve_dispute` lets it pick the
   winning outcome of a *disputed* assertion and award the `2 · bond` escrow, so a
   compromised guardian there could mis-settle a contested market. It still cannot
   touch the collateral vault (bonds move only the separate bond vault).
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

**Partially addressed:**

- **Oracle resolution — a feed-bridge adapter now exists.** `RESOLVER_ORACLE_FEED`
  markets resolve permissionlessly from an on-chain `PriceFeed` that a Switchboard
  On-Demand Function or a committee multisig posts to, gated by the same dispute
  window + guardian veto + a staleness guard (see [`ORACLE.md`](ORACLE.md)). The
  program reads a first-party `PriceFeed` (the documented integration boundary); it
  does not parse Switchboard's native account.

**Also now addressed:**

- **Scalar / range markets exist.** Markets may set `market_kind = SCALAR` over a
  range `[lower_bound, upper_bound]`, reusing the binary FPMM with YES=LONG /
  NO=SHORT. Settlement runs the **same** trusted/oracle propose→timelock→finalize
  path (`propose_scalar` or the scalar branch of `propose_from_oracle`); finalize
  maps the proposed value to a fraction `f`, and `redeem_scalar` pays LONG `f` /
  SHORT `1 − f` (floored, so conservation holds). The research-designated flagship
  (a scalar GPU-price market) is now expressible — though, like binary settlement,
  it inherits the same residual trust in the proposed value.
- **Multi-LP liquidity exists.** Any number of providers can `add_liquidity` /
  `remove_liquidity` against a real per-(market, owner) `LiquidityPosition` share
  ledger (`market.total_shares`); `claim_pool` pays each LP their pro-rata slice.
  Adds preserve the price ratio and all share/slice rounding favors the pool /
  existing LPs (see §5).
- **Fee-to-LP routing exists.** A configurable fraction of every taker fee
  (`config.lp_fee_bps`, settable by `set_lp_fee_bps`) is **reinvested as pool
  liquidity** — an equal `lp_cut` full set minted into the reserves
  (`math::lp_fee_cut`, floored), lifting every LP's pro-rata claim with no per-LP
  fee-debt accounting and no join-dilution. The protocol keeps `fee − lp_cut` in
  `fee_accrued`. This adds **no new trust**: the conservation invariant
  `vault == collateral + fee_accrued` is unchanged (the equal-set mint only moves
  `lp_cut` from the would-be fee bucket into `collateral`); the only side effect is
  a tiny, documented nudge of the marginal price toward 0.5.
- **Optimistic oracle exists.** `RESOLVER_OPTIMISTIC` (binary only) resolves a
  market via a UMA-style bonded assert/dispute game settled by the guardian, with
  bonds escrowed in a **separate** bond vault isolated from collateral (see
  [`ORACLE.md`](ORACLE.md) §10 and §1 above). It adds the guardian's
  *dispute-arbiter* (outcome-picking) power on those markets.

**Explicitly deferred (decision recorded, not dropped):**

- **Native Switchboard On-Demand account parsing and a Pyth resolver kind are
  deferred.** Probing them resolves a **second, conflicting `solana-program` 2.3.x**
  alongside this program's Agave-4.0 / Anchor-0.31 `solana-program` 4.0.x — the
  oracle crates' `AccountInfo`/types no longer typecheck against Anchor's, and
  forcing alignment is a dependency-hell risk to the whole build. Switchboard is
  also **redundant** with the shipped `PriceFeed` feed-bridge (which *is* the
  On-Demand integration model), and **Pyth carries no GPU/compute feeds**
  ([`RESEARCH.md`](RESEARCH.md) §6), so it is inapplicable to compute underlyings
  and untestable on localnet. The `resolver_kind` enum + 64 reserved `Market` bytes
  keep the door open to add them later. Full evidence in [`ORACLE.md`](ORACLE.md) §11.

**Hard non-goals:**

- **Guardian can only void, not correct (trusted-key / oracle markets).** A wrong
  outcome can be neutralized (50/50 refund) but not fixed to the true outcome
  on-chain. (On `RESOLVER_OPTIMISTIC` markets the guardian *can* pick the correct
  outcome of a disputed assertion — a deliberate, larger power on that kind only.)
- **No Asian-VWAP / time-averaged settlement accumulator.** Resolution is a
  single proposed value, appropriate only because the resolver is trusted.
- **Not audited.** No external security audit has been performed. Do not use with
  real funds on mainnet.

## 5. Proven / enforced invariants

The program's safety rests on these, asserted by unit/property tests
(`math.rs`) and the integration suite:

- **Conservation.** `vault balance == market.collateral + market.fee_accrued` at
  all times. Outcome tokens are minted/burned only as full sets (including the
  full set minted/sent-back on `add_liquidity` **and the `lp_cut` fee-reinvestment
  set** — which adds `lp_cut` to both reserves and to `collateral`, moving it out of
  the would-be fee bucket and leaving the invariant unchanged), so
  `yes_supply == no_supply == market.collateral` while trading. Optimistic-resolver
  bonds escrow in a **separate** bond vault and never enter this identity. Settlement
  conserves: binary RESOLVED pays winners 1:1 against `collateral`; scalar RESOLVED
  pays LONG `f` + SHORT `1 − f` (floored, so `long + short <= amount`); VOID pays
  half per token (`amount / 2`, rounded down) — none over-pays the vault.
- **Constant product never decreases (`k` non-decrease).** Every trade satisfies
  `r_yes' · r_no' >= r_yes · r_no`. Value cannot be extracted from the pool by
  repeated trading (round-trip non-profitability is property-tested).
- **Rounding favors the pool.** The retained reserve is rounded **up** (`ceil`);
  traders receive slightly fewer tokens on a buy and pay slightly more on a sell.
  This is the mechanism behind `k` non-decrease and is asserted directly,
  including ceil-tightness and no-underflow of `keep`/`need`.
- **LP-share rounding extracts no value.** Multi-LP add/remove shares and every
  pro-rata reserve slice round the same way — **floors** for shares minted and for
  each provider's slice (the entrant/remover is never over-credited), **ceil** for
  the reserve the pool keeps on an add (the send-back is the smaller value). So an
  LP cannot profit by adding then immediately removing, and a remover/claimer never
  pulls more than their fair fraction — leftover dust stays with the remaining LPs.
  This is property-tested (`lp_add_rounding_favors_pool`,
  `lp_add_then_remove_no_profit`, `lp_slices_never_over_pool`) and exercised by the
  add-then-remove integration test. Scalar settlement uses the same floor-rounded
  `scalar_payout` (LONG `f`, SHORT `1 − f`), so `long + short <= amount` and the
  vault is never overpaid.
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
| Compromised feed authority posts a manipulated value | `propose_from_oracle` enters the **same** dispute window; the guardian can `dispute_void` the resulting proposal → 50/50 refund. The bad value is *vetoable*, not final (residual trust #1). |
| Oracle feed is frozen / never updated near resolution | `propose_from_oracle` reverts (`StaleFeed` / `FeedHasNoValue`); the market falls through to `void_stale` after `resolution_time + 7d`. No settlement on a stale value. |
| Resolver disappears (never proposes) | After `resolution_time + 7d`, anyone `void_stale`s → 50/50 refund. Collateral is never permanently stranded. |
| Optimistic asserter posts a wrong outcome | Anyone `dispute_assertion`s with an equal bond within the window → the guardian `resolve_dispute`s to the correct outcome, awarding the `2·bond` escrow to the disputer. The wrong asserter forfeits their bond. |
| Wrong optimistic assertion goes unchallenged | If no one disputes before the window closes, `finalize_assertion` resolves to the (wrong) asserted outcome — the residual trust is honest, attentive disputers (residual trust #1). |
| Asserter tries to dispute their own assertion to stall | Rejected: `dispute_assertion` reverts `SelfDispute`; a disputed assertion also reverts `AlreadyDisputed` on a second dispute. |
| Attacker tries to redirect a bond payout to themselves | Rejected: `resolve_dispute` checks `winner_collateral` owner == the stored asserter/disputer and mint == collateral (`WrongOwner` / `WrongMint`); bonds also live only in the separate bond vault. |
| Compromised admin | Can pause, set fee ≤ 10%, sweep `fee_accrued`. Cannot touch collateral, resolve, or void. |
| Compromised guardian | Can pause and void good resolutions (grief). Cannot pick a winner or steal funds. |
| Trader tries to extract value by round-tripping trades | Impossible: `k` is non-decreasing and rounding favors the pool; a buy-then-sell costs ≥ the tokens received. |
| Trader substitutes a wrong token account | Rejected by mint/owner constraints (`WrongMint` / `WrongOwner`) and PDA address checks. |
| Late "last-look" trade after the event is known | Rejected: trading halts at `close_time <= resolution_time`. |
| Donated tokens to a pool to desync reserves | Inert: burns/quotes use recorded reserves, not `.amount`; the donor only self-griefs. |
| Compromised upgrade authority | Can replace all program logic — the ultimate trust root; mitigate with a multisig and post-audit immutability. |
