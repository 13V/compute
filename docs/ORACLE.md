# Compute — Oracle-Feed Resolver

This document describes the non-trusted-key resolvers: the **oracle-feed resolver
adapter** (how a market can be resolved permissionlessly from an on-chain numeric
`PriceFeed` instead of a trusted human key) and the **optimistic resolver** (a
UMA-style bonded assert/dispute game, §10). It covers the resolver kinds, the
`PriceFeed` account, the comparison/strike semantics, the permissionless
`propose_from_oracle` flow and its staleness guard, how they compose with the
existing dispute window + guardian veto, how to wire a Switchboard On-Demand
Function or a committee multisig as the feed authority, and the **deferral
decision** (with evidence) for native Switchboard-account parsing and Pyth (§11).

For the strategy behind oracle selection — why a *licensed-index bridge* is the
recommended primary settlement engine, and which off-chain indices exist — see
[`RESEARCH.md`](RESEARCH.md) §6 (the highest-risk area). For the exhaustive
surface map see [`REFERENCE.md`](REFERENCE.md); for the trust analysis see
[`THREAT_MODEL.md`](THREAT_MODEL.md).

> **What is wired today.** Two non-trusted-key resolvers ship: the **feed-bridge
> adapter** (`RESOLVER_ORACLE_FEED`, §§2–8) — the program reads a first-party
> `PriceFeed` account that something else (a Switchboard On-Demand Function or a
> committee) posts to — and the **optimistic resolver** (`RESOLVER_OPTIMISTIC`,
> §10) — a UMA-style bonded assert/dispute game settled by the guardian. What
> remains **deferred** (designed-for, not built): native Switchboard On-Demand
> *account parsing* in-program and a Pyth `PriceUpdateV2` pull oracle — see §11
> for the decision and its evidence. The documented integration boundary is the
> `PriceFeed` account: the program does **not** parse Switchboard's native account
> format in-program.

## 1. Two resolver kinds

Every market records a `resolver_kind: u8` at `create_market`:

| Constant | Value | Resolution path |
|---|---|---|
| `RESOLVER_TRUSTED_KEY` | `0` | The market's `resolver` key calls `propose_outcome`. The default. |
| `RESOLVER_ORACLE_FEED` | `1` | Anyone calls `propose_from_oracle`; the outcome is derived from the bound `PriceFeed` by comparing its value to the market's strike. |
| `RESOLVER_OPTIMISTIC` | `2` | UMA-style bonded **assert/dispute** game (binary markets only): anyone `assert_outcome`s by posting a bond; undisputed assertions finalize, disputed ones are settled by the guardian. See §10. |

The paths are mutually exclusive and enforced:

- `propose_outcome` requires `resolver_kind == RESOLVER_TRUSTED_KEY`; on an oracle
  or optimistic market it reverts with `WrongResolverKind`.
- `propose_from_oracle` requires `resolver_kind == RESOLVER_ORACLE_FEED`; on a
  trusted-key or optimistic market it reverts with `WrongResolverKind`.
- `assert_outcome` / `dispute_assertion` / `finalize_assertion` / `resolve_dispute`
  require `resolver_kind == RESOLVER_OPTIMISTIC` (else `WrongResolverKind`), and
  `dispute_void` is **disabled** on optimistic markets (they settle disputes via
  `resolve_dispute`, not the guardian 50/50 void).

`create_market` validates the config per kind:

- **Trusted key:** `resolver != default`.
- **Oracle feed:** `oracle_feed != default`, `oracle_max_staleness > 0`, and
  `oracle_comparison` must be a known comparison code (else `InvalidComparison`).

Any other `resolver_kind` reverts with `UnsupportedResolverKind`.

## 2. The `PriceFeed` account

`PriceFeed` is a generic on-chain numeric feed. It is **not** a PDA — it is a
fresh keypair-owned account created by `init_price_feed` (you pass a new keypair as
the `feed` signer). Its `authority` is whoever signs the create call.

| Field | Type | Meaning |
|---|---|---|
| `authority` | `pubkey` | The only key allowed to `publish_price`. In production: a Switchboard On-Demand Function enclave key or a committee multisig. |
| `value` | `i64` | Latest posted value, in the feed's native fixed-point integer scale. |
| `decimals` | `u8` | **Informational** scale hint (e.g. `2` ⇒ value is in hundredths). Not used in any on-chain comparison. |
| `published_at` | `i64` | Unix time of the last `publish_price`. `0` means never published. |
| `description` | `String` | Human label, ≤ 64 bytes (e.g. `"OCPI ORNNH100 $/hr"`). |

It is designed to be **posted to** by:

- a **Switchboard On-Demand Function** (TEE-attested) that fetches a licensed
  off-chain index (e.g. Ornn OCPI `ORNNH100`, Silicon Data `SDH100RT`) inside a
  Confidential Runtime and writes the value on-chain, or
- a **committee multisig** that bridges the same licensed value manually.

This is the research's recommended bridge target (the *licensed-index bridge*,
[`RESEARCH.md`](RESEARCH.md) §6).

### Feed instructions

| Instruction | Args | Caller | Effect |
|---|---|---|---|
| `init_price_feed` | `description: String`, `decimals: u8` | anyone (becomes `authority`) | Create a fresh feed account (pass a new keypair as `feed`). Initializes `value = 0`, `published_at = 0`. Emits `PriceFeedInitialized`. Requires `description` ≤ 64 bytes. |
| `publish_price` | `value: i64` | feed `authority` only | Set `value` and stamp `published_at = now`. Emits `PricePublished`. |

## 3. Comparison semantics and strike scaling

A market binds a strike and a comparison at creation:

| `Market` field | Type | Meaning |
|---|---|---|
| `oracle_feed` | `pubkey` | The `PriceFeed` this market resolves against. Enforced (`address = market.oracle_feed`) when proposing. |
| `oracle_strike` | `i64` | The threshold the feed value is compared against, in the feed's native integer scale. |
| `oracle_comparison` | `u8` | `0 = CMP_GTE` (YES iff `value >= strike`), `1 = CMP_LTE` (YES iff `value <= strike`). |
| `oracle_max_staleness` | `i64` | Maximum allowed `now - published_at` (seconds) for the feed to be usable at proposal time. |

The decision is **exact integer math** — there is no float and no decimal
conversion on-chain:

```text
CMP_GTE (0):  is_yes = value >= strike
CMP_LTE (1):  is_yes = value <= strike
outcome    =  YES (0) if is_yes else NO (1)
```

Both `value` and `strike` are interpreted in the **same** native fixed-point
integer scale, so the comparison is exact and the boundary is **inclusive** on
both sides (`value == strike` ⇒ YES under either comparison). `decimals` is
**purely informational**: it documents the scale for humans/indexers but is never
read by the comparison. It is the operator's responsibility to ensure the strike
is scaled to match the published value's scale (e.g. both at 2 decimals).

> **Scaling is a manual contract.** If a feed publishes `$2.50` as `250`
> (`decimals = 2`) but the market's strike is stored as `2` (decimals = 0), the
> comparison is meaningless. The program cannot detect this mismatch — it only
> compares integers. The market creator and the feed authority must agree on the
> scale out of band.

## 4. The permissionless `propose_from_oracle` flow

`propose_from_oracle` is **permissionless** (any `cranker` may call it). For a
`RESOLVER_ORACLE_FEED` market it:

1. Requires `resolver_kind == RESOLVER_ORACLE_FEED` (else `WrongResolverKind`).
2. Requires `state == OPEN` (else `MarketNotOpen`).
3. Requires `now >= resolution_time` (else `TooEarlyToResolve`).
4. Requires the feed has been published: `feed.published_at > 0` (else
   `FeedHasNoValue`).
5. **Staleness guard:** requires `now - feed.published_at <= oracle_max_staleness`
   (else `StaleFeed`).
6. Computes `is_yes` from `oracle_is_yes(feed.value, oracle_strike,
   oracle_comparison)` (else `InvalidComparison`) and sets `proposed_outcome`
   accordingly.
7. Transitions `OPEN → RESOLVING`, records `resolved_at = now`, and emits
   `OutcomeProposed` with `resolver` set to the **feed pubkey** (the feed is the
   nominal proposer).

The bound feed is validated by `address = market.oracle_feed`, so a caller cannot
substitute a different feed.

Note the staleness check is at **proposal** time, comparing against the feed's
*last publish*, not against `resolution_time`. The feed authority is expected to
publish a fresh value at/after the resolution time; if it does not, the market
cannot be proposed via the oracle and can eventually fall through to the liveness
escape hatch (`void_stale` after `resolution_time + VOID_GRACE_PERIOD`).

## 5. Composition with the dispute window and guardian veto

Crucially, **the oracle path flows through the exact same two-step settlement as
the trusted-key path** — `propose → dispute_period → finalize`:

```text
OPEN ──propose_from_oracle──▶ RESOLVING ──finalize_outcome (after dispute_period)──▶ RESOLVED
                                  │
                                  └──dispute_void (guardian, during window)──▶ VOID (50/50 refund)
```

This is **defense in depth**: a manipulated or buggy feed does not pay out
immediately. The guardian can `dispute_void` a market whose oracle-derived
proposal looks wrong, sending it to a 50/50 refund — exactly as it can veto a bad
human proposal. `finalize_outcome` and `void_stale` are unchanged and fully reused.

So the oracle adapter does **not** remove the guardian from the loop; it shifts the
*source of the proposed value* from a single resolver key to a `PriceFeed`
authority, while keeping the timelock + veto + liveness hatch intact.

## 6. Where the trust now rests

With a trusted-key market, the trust is "the `resolver` key reports honestly." With
an oracle-feed market, that trust moves to the **feed's `authority`**:

- If the authority is a **Switchboard On-Demand Function enclave**, the value is
  TEE-attested — no single operator can forge it and a licensed API key never
  leaves the enclave.
- If the authority is a **committee multisig**, the trust is "≥ threshold of the
  committee bridged the licensed value honestly."

Either way the guardian veto + dispute window are the on-chain backstop, so a bad
feed value is *vetoable*, not *final*. The residual trust is the feed authority
plus the guardian, plus (as always) the upgrade authority and clock honesty.

## 7. Wiring a feed authority (conceptual)

The program treats the `PriceFeed.authority` as opaque — it only checks the signer
on `publish_price`. Two recommended authorities, per [`RESEARCH.md`](RESEARCH.md)
§6:

### A. Switchboard On-Demand Function (primary)

Conceptually:

1. Author a Switchboard On-Demand job: an `HttpTask` against the licensed index API
   (the API key injected as a TEE secret) → `JsonParseTask` extracting the value.
2. Switchboard oracles execute the fetch inside TEEs ("Confidential Runtimes") and
   produce a signed value.
3. A small bridge program/crank takes that attested value and calls
   `publish_price(value)` with the feed's `authority` set to the function's enclave
   key (or to the bridge that gates on the attestation).

The program does **not** parse Switchboard's native account — the integration
boundary is the first-party `PriceFeed`. Native `PriceUpdateV2`/Switchboard-account
parsing in-program is **deferred** (with evidence) — see §11.

### B. Committee multisig (fallback)

A **3-of-5 multisig** (e.g. Compute team + 2 independent data partners + 1 neutral)
holds the feed `authority`. Each settlement window, the committee co-signs a
`publish_price(value)` carrying the same licensed value. Same data, simpler trust
story, slower/manual. The on-chain veto + dispute window still apply.

## 8. Worked example — H100 neocloud monthly market on OCPI `ORNNH100`

Settle a binary market: **"Will the H100 neocloud monthly index be at or above
$2.20/hr at resolution?"** against the Ornn `ORNNH100` index, with the value posted
at **2 decimals** (so `$2.20` is stored as `220`).

**1. Create the feed (one-time).**

```text
init_price_feed(
    description = "OCPI ORNNH100 $/hr",
    decimals    = 2,            # informational: value is in cents-per-hour
)
# feed.authority = the Switchboard On-Demand Function enclave key
#                  (or the 3-of-5 committee multisig)
```

**2. Create the market.**

```text
create_market(
    question          = "H100 neocloud monthly >= $2.20/hr?",
    resolution_source = "OCPI ORNNH100",
    close_time        = <end of month>,
    resolution_time   = <first business day of next month>,
    resolver          = <ignored for oracle markets; pass default or any>,
    resolver_kind     = 1,        # RESOLVER_ORACLE_FEED
    oracle_feed       = <the PriceFeed pubkey from step 1>,
    oracle_strike     = 220,      # $2.20 at decimals = 2
    oracle_comparison = 0,        # CMP_GTE  → YES iff value >= 220
    oracle_max_staleness = 86400, # 1 day; tune to the feed's cadence
)
```

**3. Publish the settlement value (feed authority, at/after `resolution_time`).**

```text
publish_price(value = 235)        # $2.35/hr that month
```

**4. Propose permissionlessly.**

```text
propose_from_oracle()
# value 235 >= strike 220 under CMP_GTE  → proposed_outcome = YES
# state: OPEN → RESOLVING; dispute window opens
```

**5. Dispute window, then finalize.**

- If the feed value looks manipulated, the guardian `dispute_void`s → 50/50 refund.
- Otherwise, after `dispute_period`, anyone `finalize_outcome`s → `RESOLVED`,
  `outcome = YES`. Winning-token holders `redeem` 1:1.

If the published value had been `210` (`$2.10`), `210 >= 220` is false ⇒
`proposed_outcome = NO`. If the authority never published (or published too long
before `resolution_time`), `propose_from_oracle` reverts (`FeedHasNoValue` /
`StaleFeed`) and the market can ultimately be voided via `void_stale`.

## 9. Status and roadmap

| Engine | Status |
|---|---|
| **Feed-bridge adapter** (this `PriceFeed` + `RESOLVER_ORACLE_FEED`) | **Wired.** |
| **Optimistic oracle** (`RESOLVER_OPTIMISTIC`, bonded assert/dispute — §10) | **Wired.** |
| Native Switchboard On-Demand account parsing in-program | **Deferred** — see §11. |
| Pyth `PriceUpdateV2` pull oracle (crypto-priced legs) | **Deferred** — see §11. |

The 64 reserved bytes on `Market` plus the `resolver_kind` discriminator leave room
to add the remaining engines without a layout-breaking migration. See
[`RESEARCH.md`](RESEARCH.md) §6 for the full settlement-router design and
manipulation-resistance measures (time-averaged settlement, median-of-sources,
void-on-missing-data).

## 10. The optimistic resolver (`RESOLVER_OPTIMISTIC = 2`)

A market created with `resolver_kind = 2` (**binary only**) is resolved by a
UMA-style **bonded assert/dispute** game instead of a trusted key or a feed. It
reuses the existing `RESOLVING → RESOLVED` state machine and dispute window, but the
proposed outcome comes from a *bonded assertion* and disputes are settled by the
guardian as the dispute arbiter (the DVM / council stand-in).

### Bonds live in a separate vault

All bonds escrow into a **dedicated bond vault** PDA token account
`["bond", market]` whose authority is the Market PDA — **distinct from the
collateral `vault`**. The collateral vault and its conservation invariant
(`vault == collateral + fee_accrued`) are therefore **never touched** by the
optimistic flow, and the bond vault **nets to zero on every settlement path**.

### Flow

| Step | Instruction | Caller | Effect |
|---|---|---|---|
| 1. Assert | `assert_outcome(outcome)` | **anyone** (permissionless) | At/after `resolution_time`, post `config.bond_amount` into the bond vault and assert a binary `outcome`. `OPEN → RESOLVING`; records `asserter`, `proposed_outcome`, `bond`; opens the dispute window. Requires `bond_amount > 0` (else `NoBondConfigured`). Emits `OutcomeAsserted`. |
| 2a. Finalize (undisputed) | `finalize_assertion()` | the `asserter` | After the window, if not disputed: refund the asserter's bond (PDA-signed) and resolve to the asserted outcome. `RESOLVING → RESOLVED`. Emits `MarketResolved`. |
| 2b. Dispute | `dispute_assertion()` | **anyone except the asserter** | Within the window, post an **equal** bond and flag `disputed`. Blocks self-dispute (`SelfDispute`), double-dispute (`AlreadyDisputed`), and a closed window (`DisputeWindowClosed`). Emits `AssertionDisputed`. A disputed assertion can no longer self-finalize (`finalize_assertion` reverts `DisputeUnresolved`). |
| 2c. Resolve dispute | `resolve_dispute(correct_outcome)` | `guardian` only | Settle a disputed assertion: award the **whole `2 · bond`** escrow (PDA-signed) to whoever asserted the side the guardian rules correct — the asserter if `proposed_outcome == correct_outcome`, else the disputer (the `winner_collateral` owner/mint are checked against the ruling, so the destination is constrained to the stored asserter/disputer) — and resolve to `correct_outcome`. `RESOLVING → RESOLVED`. Emits `DisputeResolved`. |

`config.bond_amount` is set at `initialize` and updated by `set_bond_amount`
(admin); `0` disables `assert_outcome`. Because the proposed outcome is bonded and
the loser forfeits their bond to the winner, an honest asserter is paid back while a
griefer loses `bond`; the guardian is the final arbiter only on the contested path.

### Where the trust rests (optimistic)

The optimistic resolver shifts settlement trust to **economic incentives plus the
guardian as dispute arbiter**: anyone can assert, anyone can challenge a wrong
assertion (the bond makes a false assertion costly), and only a *disputed* outcome
needs the guardian — who, unlike the feed/trusted paths, here **picks the correct
outcome** rather than merely vetoing into a void. See
[`THREAT_MODEL.md`](THREAT_MODEL.md) for the full trust model.

## 11. Deferred resolver kinds (native Switchboard account parsing, Pyth)

Native **Switchboard On-Demand account parsing** and a **Pyth** (`PriceUpdateV2`)
resolver kind were probed and are **deliberately deferred — not silently dropped**.
The reasons, precisely:

1. **Toolchain conflict (probed).** Adding `switchboard-on-demand` /
   `pyth-solana-receiver-sdk` resolves a **second, conflicting `solana-program`
   version (2.3.x)** alongside this program's Agave-4.0 / Anchor-0.31
   `solana-program` (4.0.x). Anchor's `AccountInfo` (4.0) and the oracle crates'
   types (2.3) are then incompatible, so any in-program parse fails to typecheck;
   forcing version alignment is a deep dependency-hell risk to the whole build.
2. **Switchboard is redundant with the bridge.** The shipped `PriceFeed`
   feed-bridge **is** Switchboard On-Demand's integration model — an On-Demand
   Function posts the value to an on-chain account, which `RESOLVER_ORACLE_FEED`
   reads (§§2, 7). Native in-program account parsing adds little over the bridge.
3. **Pyth is inapplicable to compute.** Pyth carries **no GPU/compute price feeds**
   (per [`RESEARCH.md`](RESEARCH.md) §6), so it is only useful for
   crypto-denominated markets — out of scope for compute underlyings — and is
   untestable on localnet without fabricated accounts.

The `resolver_kind` enum plus the **64 reserved `Market` bytes** still leave room to
add either later if the toolchain or the available feeds change; nothing about the
current layout precludes them.
