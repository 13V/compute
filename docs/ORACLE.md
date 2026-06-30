# Compute — Oracle-Feed Resolver

This document describes the **oracle-feed resolver adapter**: how a market can be
resolved permissionlessly from an on-chain numeric `PriceFeed` instead of a
trusted human key. It covers the two resolver kinds, the `PriceFeed` account, the
comparison/strike semantics, the permissionless `propose_from_oracle` flow and its
staleness guard, how it composes with the existing dispute window + guardian veto,
and how to wire a Switchboard On-Demand Function or a committee multisig as the
feed authority.

For the strategy behind oracle selection — why a *licensed-index bridge* is the
recommended primary settlement engine, and which off-chain indices exist — see
[`RESEARCH.md`](RESEARCH.md) §6 (the highest-risk area). For the exhaustive
surface map see [`REFERENCE.md`](REFERENCE.md); for the trust analysis see
[`THREAT_MODEL.md`](THREAT_MODEL.md).

> **What is wired today.** Only this **feed-bridge adapter** is implemented: the
> program reads a first-party `PriceFeed` account that something else (a
> Switchboard On-Demand Function or a committee) posts to. Native
> Switchboard-account parsing, Pyth `PriceUpdateV2`, and a Solana-native
> optimistic oracle remain **future** (designed-for, not built). The
> documented integration boundary is the `PriceFeed` account: the program does
> **not** parse Switchboard's native account format in-program.

## 1. Two resolver kinds

Every market records a `resolver_kind: u8` at `create_market`:

| Constant | Value | Resolution path |
|---|---|---|
| `RESOLVER_TRUSTED_KEY` | `0` | The market's `resolver` key calls `propose_outcome`. The default. |
| `RESOLVER_ORACLE_FEED` | `1` | Anyone calls `propose_from_oracle`; the outcome is derived from the bound `PriceFeed` by comparing its value to the market's strike. |

The two paths are mutually exclusive and enforced:

- `propose_outcome` requires `resolver_kind == RESOLVER_TRUSTED_KEY`; on an oracle
  market it reverts with `WrongResolverKind`.
- `propose_from_oracle` requires `resolver_kind == RESOLVER_ORACLE_FEED`; on a
  trusted-key market it reverts with `WrongResolverKind`.

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
parsing in-program is a future enhancement.

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
| Native Switchboard On-Demand account parsing in-program | Future. |
| Pyth `PriceUpdateV2` pull oracle (crypto-priced legs) | Future. |
| Solana-native optimistic oracle (subjective/AI-milestone markets) | Future. |

The 64 reserved bytes on `Market` plus the `resolver_kind` discriminator leave room
to add the remaining engines without a layout-breaking migration. See
[`RESEARCH.md`](RESEARCH.md) §6 for the full settlement-router design and
manipulation-resistance measures (time-averaged settlement, median-of-sources,
void-on-missing-data).
