# Compute: Prediction Markets for Trading on Compute — Research & Build Plan

> Research synthesis (as of 2026-06-29). Produced by a fan-out research fleet (6 domains,
> each adversarially fact-checked) plus a dedicated oracle deep-dive. Every load-bearing
> claim is sourced in §11. The **token is intentionally out of scope** — this document is
> about the product: a Solana venue for trading on compute.

## 1. Executive summary

We are building **Compute**, a Solana-native venue where users trade on the price and
availability of AI compute — primarily **GPU rental rates ($/GPU-hour)** for H100, H200, and
B200, plus inference cost and AI-milestone markets. The single recommended approach is a
**two-track hybrid**: ship fast by composing on Hxro's open-source parimutuel protocol for
recurring short-window "up/down" price markets, while in parallel building our own lean Anchor
program implementing the Polymarket-style conditional-token model (split/merge/redeem USDC into
outcome tokens) for **scalar/range price markets** and binary milestone markets. The flagship
products are cash-settled monthly index markets on **H100 neocloud, B200, and H200 $/hr**,
settled against an established third-party GPU index (Ornn's OCPI or Silicon Data's
SiliconIndex), with cheap-to-launch AI-milestone markets as the top-of-funnel liquidity
bootstrap.

The thesis is validated, not speculative: as of mid-2026 two transaction-based GPU indices are
live on Bloomberg, CME and ICE have announced regulated GPU futures, Kalshi already lists a
monthly H100 contract, and Polymarket closed a real six-figure institutional H100 hedge against
the Ornn index. Our defensible wedge is **breadth, speed, and permissionlessness** — covering
the whole compute stack ($/GPU-hr, $/M-token, capacity, AI milestones) on a fast, low-fee,
composable on-chain venue — **not** the institutional H100 spot hedge, which CME/ICE/Kalshi will
own.

The highest-risk dependency, by a wide margin, is the **settlement oracle**, and the binding
constraint there is **commercial, not technical**: the credible GPU indices are proprietary,
off-chain, business-day feeds we do not control, and they are simultaneously being wired into
regulated exchanges. Licensing one for permissionless on-chain settlement is the genuine
critical path. Mechanism and matching are comparatively solved problems; **settlement integrity
and a manipulation-resistant index are where this product lives or dies.**

## 2. The product: what users trade

**The core underlying is GPU rental price, $/GPU-hour.** This is the only compute metric that is
simultaneously (a) genuinely volatile, (b) backed by settlement-grade transaction-based indices,
and (c) already being hedged with real institutional money. Volatility is strongly
hardware-dependent (March 2026 figures, verified against Silicon Data's own blog):

| Underlying | Level | Volatility (CV) | Tradeability |
|---|---|---|---|
| H100 Hyperscaler | ~$7.43–7.52/hr | ~0.5% (near-flat) | **Too flat to trade — avoid** |
| H100 Neocloud | ~$2.43–2.63/hr | ~2.6% (moderate) | Best balanced hedge + speculation |
| H200 | (live index availability unconfirmed) | high | Strong speculation underlying |
| B200 Neocloud | ~$4.40→$6.00+ intra-month March | ~11.4% CV, 18.9% single-day swing, +24%/qtr | **Best speculation engine** |

> **Number hygiene.** The often-quoted "~$2.99/hr H100 median" is a Thunder Compute
> *marketplace-cohort* figure, **not** the `SDH100RT` index print (which has run ~$1.70–$2.35 on
> the 1-yr contract series and ~$7.48 on the hyperscaler series). Do not conflate these in market
> specs. H100 has also been volatile and recently **down** — an early-May 2026 surge then a slide,
> with one OCPI H100 reference near $1.70/hr — so **all bucket/strike designs must be re-baselined
> to current prints at launch**, never to a stale number.

**The 3–4 strongest first markets to launch:**

1. **H100 Neocloud $/hr monthly index market (flagship).** Cash-settled monthly on the H100 SXM
   neocloud rate. Settlement source: Ornn OCPI (Bloomberg `ORNNH100`) Asian-style volume-weighted
   average over the final settlement window, **or** Silicon Data `SDH100RT`. This is the exact
   instrument institutions already hedge.
2. **B200 (and H200) $/hr monthly index market (speculation engine).** Same structure, settling
   on Ornn `OCPI-B200` / `OCPI-H200`. ~4× the volatility of H100 neocloud — the volume driver.
   Pair with H100 so hedging and speculation cross-subsidize liquidity. *(H200 live index
   availability is unconfirmed — treat as a fast-follow pending oracle confirmation.)*
3. **AI model-release / benchmark milestone markets (liquidity bootstrap).** Templated binaries
   with unambiguous public resolution: model ship dates, LMArena leaderboard rank
   (`lmarena.ai`, Style Control off, raw Elo), benchmark thresholds (SWE-bench). Cheap to
   template, trivial to resolve, taps existing AI-trader demand (Polymarket AI markets ran
   $20–36M/mo in late 2025, declining to ~$10M by March 2026).
4. **(Second wave) Inference-cost milestone markets — NOT a price hedge.** Frame as
   one-directional milestones ("frontier output price drops below $X/M tokens by date Y") because
   per-token prices fall secularly (~50× / yr). A naive token-price market has no two-sided
   demand. Aggregate AI-spend or data-center-power markets may interest enterprises more than unit
   price.

## 3. Is there real demand?

**The hedging case (proven as proof-of-concept, not yet proof-of-depth).** On **June 2, 2026**,
Polymarket closed its first institutional six-figure block on a GPU instrument — FalconX (prime
broker, committed market maker) and AneraLabs (an "AI risk clearinghouse") — structured as a
prediction-market hedge inside a forward capacity contract, settled against the Ornn index,
recorded on Polygon. This is the closest analog to what Compute would build. CME+Silicon Data and
ICE+Ornn announcing futures, plus Kalshi's live `KXH100MON` contract, confirm institutions
believe the asset class is real. **Caveat:** this is a *single* documented block trade, and
neither the CME nor ICE future is live yet (both CFTC-pending, no volume data). Institutional
demand is real; sustained/retail liquidity is unverified.

**The speculation case (the more reliable near-term volume).** GPU rental prices are volatile and
narrative-rich (the AI-infrastructure supercycle), and crypto-native traders want compute
exposure without buying GPU stocks. AI-milestone markets already pull eight figures monthly on
Polymarket. Speculation, not hedging, is realistically our day-one volume.

**Target users, in priority order:** (1) crypto-native AI/compute speculators and DeAI
communities (day-one volume — they already trade Render/io.net/Akash); (2) GPU lessors, brokers,
neoclouds, data-center operators (natural *shorts* locking forward revenue — the supply side of
two-sided liquidity); (3) AI builders spending $1M+/yr hedging spot-spike tail risk (slow, needs
trust); (4) quant/prop MMs (FalconX/DRW/Jump archetypes) for depth; (5) retail drawn by
AI-milestone markets.

**Honest skeptical take.** This wedge is being captured *right now* by far better-capitalized,
regulated incumbents — simultaneously. The natural shorts (GPU lessors) are not yet crypto-native,
so two-sided liquidity is hard. Hedgers are few and lumpy; speculators need volatility and
narrative. If compute prices structurally stabilize or decline (H100 already fell 64–78% from its
late-2024 peak; inference cost is collapsing ~1000×), both hedging demand and speculative interest
could compress. The realistic read: **don't bet the company on the institutional H100 hedge — win
the speculative + milestone surface incumbents legally can't touch, and treat hedging as a
credibility narrative.**

## 4. Build vs fork vs compose

The Solana landscape gives three paths; the right answer is a **hybrid that composes for speed and
builds the core IP.**

| Candidate | Status (verified 2026-06-29) | Verdict |
|---|---|---|
| **Hxro Parimutuel** | Open-source (Apache-2.0), `Hxro-Network/solana` pushed **2026-06-26**, permissionless market creation, oracle-agnostic, TS+Python SDKs, audited + $500k bounty | **COMPOSE ON** for short-window price markets |
| **Polymarket CTF pattern** (Gnosis CTF + CLOB + UMA) | EVM, battle-tested, the proven design | **REIMPLEMENT** natively in Anchor for the core IP |
| **Drift / velocity-exchange BET** | Prediction = a contract-type of the full perp engine; **~$285–295M exploit April 1, 2026**, org renamed to `velocity-exchange`, relaunching "perps-native," de-scoping non-perp products | **DO NOT FORK** — design reference only |
| **Monaco Protocol (BetDEX)** | GitHub org now shows **0 public repos**; `protocol`+`sdk` 404 | **DO NOT DEPEND** — abandonment risk |
| **Zeta Markets** | Ceased operating May 2025 | Reference-only |
| **OpenBook v2 / Phoenix** | Production CLOBs; OpenBook GPL-gated (CPI use fine), Phoenix now BUSL-1.1 | **OPTIONAL** matching layer (CPI / arm's-length) |

**Recommendation — two-track hybrid:**

- **Track A (ship fast):** Compose on **Hxro Parimutuel** for recurring short-window "compute
  up/down in N hours/days" markets — permissionless market creation, pro-rata pool payoff, shared
  liquidity, minimal on-chain code from us. *(Confirm at code level that new-underlying +
  custom-oracle onboarding is truly permissionless, and verify Hxro's live TVL/pool depth before
  composing — both are genuine open items.)*
- **Track B (own the IP):** Build a **lean Anchor conditional-token + pluggable-resolver program**
  for scalar price markets and binary milestone markets. Keep matching out of the core program
  (off-chain CLOB or AMM seed). This is the load-bearing security surface — keep it minimal,
  Apache/MIT-licensed, and audited.

**Do not fork Drift** (mid-relaunch after a nine-figure hack, tightly coupled to a perp/margin
engine) and **do not depend on Monaco** (code withdrawn). Keep OpenBook v2 / Phoenix at arm's
length (CPI only) to avoid license entanglement.

## 5. Market mechanism

Compute prices are **continuous**, so pure binary yes/no is the wrong primitive for the core
product — it discards signal and forces users into many strike-bucket markets. Use a **three-tier
hybrid:**

- **Tier 1 — Index perpetual (flagship, always-on).** A funding-anchored perp on headline H100
  $/GPU-hr. `funding_rate = (perp − index)/index × coeff`; if perp > index, longs pay shorts,
  pulling the mark to the oracle index. Gives a continuous, leverageable, never-expiring mark with
  live entry/exit. *Flag: Drift's BET perps settle 0/1 only today; a numeric-settling perp is our
  extrapolation and requires a custom Anchor program — it is not an off-the-shelf Drift feature.*
- **Tier 2 — Scalar/range expiry markets (everything else).** Gnosis-CTF 2-slot
  linear-interpolation payoff. Collateral `C` splits into LONG(HIGH)+SHORT(LOW) over range
  `[A,B]`; at settlement value `X` (clamped), **LONG pays `C·(X−A)/(B−A)`, SHORT pays
  `C·(B−X)/(B−A)`**. Set `[A,B]` generously (±50% around live index) so settlements rarely pin a
  bound. On Solana use `u64` fixed-point (scale by 1e6) — no EVM fraction hack needed.
- **Tier 3 — Binary / parimutuel discrete events (retail / milestones).** "Will median H100 print
  below $X on date Y?" — route to Hxro parimutuel (zero counterparty risk, trivial to bootstrap a
  single event).

**Mechanism trade-offs:** CLOB gives best price discovery but dies in thin markets without active
MMs; AMMs give always-on liquidity but bleed to LVR (pm-AMM expects to lose ~half of zero-fee seed
capital to arbitrage by expiry, and is **binary-only**); parimutuel needs no counterparty but
gives no continuous mark/exit; optimistic oracle is a *resolution* layer, not a trading layer.

**Liquidity-bootstrapping plan:**

1. **Seed each new scalar/binary market with LMSR as maker-of-last-resort.** LMSR's worst-case
   loss is **bounded and pre-fundable**: deposit `F = b·ln(n)` to cap the cold-start subsidy
   exactly. Tune `b` per market by target depth/budget. (For binary markets you can later graduate
   to a pm-AMM invariant for uniform LVR; keep LMSR/CLOB for scalar.)
2. **Run matching as off-chain CLOB + on-chain settlement** (Polymarket / DFlow CLP pattern) for
   capital efficiency, always backed by the AMM seed so the book is never empty. Solana's low fees
   also permit a fully on-chain CLOB (Phoenix-style) if latency allows.
3. **Copy Polymarket's liquidity-rewards program:** quadratic spread score
   `S(v,s) = ((v−s)/v)²·b` (a 2×-tighter quote earns ~4×), two-sided depth enforced via
   `Q_min = max(min(Q_one,Q_two), max(Q_one/c, Q_two/c))` with `c=3`, minute-level sampling, daily
   epoch payout, plus a maker-rebate share of taker fees.
4. **Recruit 1–2 designated market makers per flagship** (replicate FalconX's role) with
   rebates/exclusive incentives.
5. **Launch narrow** — 3–5 flagship markets, not a long tail.

## 6. Oracle & resolution (HIGHEST-RISK AREA)

**This is the single hardest problem and the genuine critical path — and the binding constraint is
commercial, not technical.** There is **no decentralized, on-chain GPU/compute-price oracle today**
— neither Pyth (1,300+ feeds: crypto, equities, FX, commodities, rates) nor Switchboard nor
Chainlink carries a native GPU-rental feed (verified across searches; results return compute
*marketplaces* like Render/Nosana/io.net, not price oracles).

The credible, financial-grade indices that *do* exist are off-chain and institutionally
controlled, **and are being absorbed into regulated exchanges as we build:**

- **Ornn Compute Price Index (OCPI)** — transaction/cleared-price based ("actual cleared prices
  from live GPU markets, not surveys/rate cards"), regional weighting, per-GPU indices
  (H100/H200/B200/B300), Asian-VWAP settlement, on Bloomberg as `ORNNH100`, **now being licensed
  to ICE** for cleared, USD cash-settled GPU futures. → funneling toward exchange exclusivity.
- **Silicon Data SiliconIndex** — `SDH100RT`/`SDB200RT`/`SDA100RT`, ~3.5M data points normalized
  **every business day**, covers 80%+ of the global H100 rental market, distributed on Bloomberg +
  Reuters + a **direct REST API** (Plus/Professional tiers), backed by DRW and Jump, **being
  licensed to CME**, and explicitly sells "licensing options … for financial product creation."
- **SemiAnalysis GPU pricing index** — survey-based (100+ participants, 25th–75th percentile),
  monthly, editorial/research. Best as a **cross-check, not a settlement source.**

**Recommended architecture — three settlement engines behind one resolution router, chosen per
market type:**

1. **Licensed-index bridge (primary — liquid price markets).** License a daily settlement feed
   from **Silicon Data** (`SDH100RT` neocloud) and/or **Ornn OCPI**. *Silicon Data is the better
   launch target* — it explicitly sells financial-product licenses, exposes a direct REST API (not
   just Bloomberg), and recalculates every business day; Ornn appears to be funneling toward ICE
   exclusivity, so treat OCPI as a secondary/confirming feed. **Bridge via Switchboard On-Demand:**
   a TypeScript feed `HttpTask`(licensed API, key injected as a TEE secret) → `JsonParseTask`(JSON
   path to value); Switchboard oracles execute the fetch inside TEEs ("Confidential Runtimes") and
   post a signed value to a Solana feed account read via `feedAccount.fetchUpdateIx({numSignatures})`.
   TEE attestation means no single operator can forge the value and the API key never leaves the
   enclave. **Committee fallback:** a **3-of-5 multisig** (Compute team + 2 independent data
   partners + 1 neutral) signing the same licensed value each window — same data, simpler trust
   story, slower/manual.
2. **Solana-native optimistic oracle (subjective markets — AI milestones, benchmark claims).**
   **UMA is EVM-only — there is no native Solana deployment**, and its token-vote DVM is under
   visible strain in 2026 (Polymarket logged 1,150+ disputed markets, an $60–85M dispute put
   token-voting "on trial," UMIP-189 clamped proposals to a ~37-address whitelist). So **do not
   bridge to UMA-EVM at launch.** Implement a Solana-native UMA-style optimistic oracle (bonded
   `assertTruth` → 24–72h challenge window → undisputed settles; disputed escalates to a dispute
   council with slashing). WAGR already ships this primitive on Solana mainnet (Anchor 0.31);
   Hedgehog is building one — evaluate integrating/forking rather than building from zero,
   contingent on a security review.
3. **Pyth pull oracle (only crypto-priced legs).** `pyth-solana-receiver-sdk`,
   `Account<'info, PriceUpdateV2>` (auto ownership check),
   `get_price_no_older_than(&Clock, max_age, &feed_id)`, pinned to **Anchor 0.31.1**. Pyth's own
   docs warn `PriceUpdateV2` alone only guarantees "*a* verified price for *some* feed at *some*
   time" — independently check `feed_id`, staleness, **and gate on `conf` (confidence), not
   staleness alone.**

**Cross-cutting manipulation resistance (all engines):** settle on a **time-averaged value over
the contract period** (Asian-VWAP, matching OCPI/SiliconIndex), never a snapshot; take a **median
of {Silicon Data, Ornn, marketplace basket}** when ≥2 are available; enforce a **dispute window +
timelock** between "value posted" and "funds released"; and **void-on-missing-data** (refund rather
than settle on a degraded value). The free marketplace basket (Vast.ai `bundles`, RunPod
`gpuTypes`) is **spot-biased and directionally low** vs neocloud contract pricing — use it only as
a sanity bound / void-trigger, never as the primary settlement value.

**How the first market settles end-to-end (H100 neocloud $/hr monthly).** Settlement value = the
**June business-day VWAP** of `SDH100RT` (neocloud), with Ornn `ORNNH100` and a marketplace basket
as cross-checks:

1. **License + feed setup (one-time).** Sign a redistribution/financial-product license with
   Silicon Data; provision the API key as a Switchboard secret; author + simulate + deploy the
   On-Demand feed (Ornn optionally added as a second job, basket as a third).
2. **Daily capture (through June).** A crank calls `fetchUpdateIx({numSignatures:3})`; ≥3 oracles
   independently fetch the value inside TEEs, agree, and post the day's print; the program appends
   it to an on-chain accumulator (running sum + count). Each daily value is sanity-checked against
   Ornn + the basket median; divergent prints are flagged.
3. **Window close (first business day of July).** Program computes the June VWAP = candidate
   settlement value.
4. **Cross-source validation.** Compare to the independently-accumulated Ornn average; agree within
   tolerance → proceed; diverge → fall back to median; only one live source + basket disagrees
   materially → **void + refund.**
5. **Optimistic confirmation + timelock.** Post the candidate as a bonded assertion with a ~48h
   challenge window; disputes escalate to the Solana-native council, adjudicated against the
   public Bloomberg/Reuters prints (cheap to verify honestly).
6. **Resolution + payout.** Unchallenged (or post-dispute) → binary/scalar resolves; short timelock;
   USDC pays out on-chain.

**Net trust model:** the *only* off-chain trust is "Silicon Data's published `SDH100RT` is honest"
— a value independently visible on Bloomberg/Reuters that now underpins CME/ICE-bound regulated
products, so it is externally auditable. Everything from fetch to payout is TEE-attested +
median-validated + dispute-gated on Solana.

> **The licensing dependency is a launch blocker, not a fast-follow — secure it before anything
> else.** And because the Solana-native optimistic layer is the highest-engineering-risk piece,
> **consider launching index-price markets first and deferring subjective/AI-milestone markets**
> until that layer is hardened.

## 7. Technical architecture

**Tech stack:** Anchor **0.31.1** + Solana/Agave **2.1.x**; **legacy SPL Token** for outcome tokens
(maximize DeFi composability, matching Kalshi/DFlow — keep Token-2022 transfer-hooks as a
documented upgrade path if compliance later requires KYC allowlists/pause); TypeScript Anchor SDK
generated from IDL; Next.js + `@solana/wallet-adapter` frontend; **Helius** RPC + LaserStream/Geyser
+ webhooks for indexing; keeper/crank services. Test with **LiteSVM + Mollusk** (note:
`solana-bankrun` is deprecated) plus `anchor test` e2e with mocked oracle accounts.

**Module-by-module Anchor breakdown** (single workspace, modular programs — keep matching OUT of
the core):

- **`core` / conditional-token module** — collateral vault + outcome SPL mints + `split_position`
  (USDC in → mint YES+NO full set), `merge_position` (burn full set → USDC out, oracle-independent
  exit), `redeem` (burn winning tokens → USDC). Fully on-chain, no oracle dependency for exits.
  **This is the load-bearing security surface.**
- **`resolution` / oracle-adapter module** — the ONLY thing that can set a winning outcome. Reads
  Pyth `PriceUpdateV2` OR a Switchboard/committee index account; enforces freshness + confidence +
  status; only callable after `settle_timestamp`; includes a dispute/timelock window.
- **`market` / config module** — `initialize_config`, `create_market` (pins oracle type,
  `resolution_source` e.g. `"OCPI ORNNH100"`, settle timestamp, `[A,B]` bounds, state enum), fees,
  `admin_pause`/`void`.

**PDA / account model:** `Config` PDA `[b"config"]` (admin/guardian, fee bps, allowed collateral,
paused flag); `Market` PDA `[b"market", market_id]` (metadata hash, collateral mint, oracle config,
settle_timestamp, bounds, state {Open,Resolving,Resolved,Voided}, winning_outcome,
total_collateral); outcome SPL mints `[b"outcome", market, index]` with mint authority = Market PDA;
`Vault` PDA-owned USDC ATA (authority = Market PDA, signs payouts via seeds); optional `UserPosition`
`[b"position", market, user]` for parimutuel pools.

**Off-chain services:** TS SDK from IDL; Helius webhooks (up to 100k accounts) / LaserStream gRPC to
index Market/Position/fill events; resilient keeper services (TS/Rust + retry + alerting) for:
resolution (post oracle value + call resolve), market expiry, void-on-missing-data, funding updates
(if perp), and `consume_events` if OpenBook is used (Phoenix needs no crank). **Treat the
resolution keeper as security-critical.**

**Security checklist (pre-mainnet):** `is_signer` on privileged ops; owner + discriminator checks on
every deserialized account; canonical-bump PDAs; checked arithmetic in all payout math;
target-program-ID checks on CPIs (prevent arbitrary-CPI vault drain); **`.reload()` after token
CPIs** (Anchor does not auto-refresh post-CPI state — critical in split/merge/settle); oracle
freshness + confidence + status; dispute/timelock window before payout; guardian multisig (Squads)
to pause/void on a bad print; upgrade authority via multisig, moving toward immutable/governance
post-audit.

## 8. Competition & positioning

| Venue | Chain / Reg | Compute product | Lane |
|---|---|---|---|
| **Kalshi** | CFTC-regulated (~$17.9B May 2026) | Live `KXH100MON` on Ornn index | Institutional, KYC, USD |
| **CME + Silicon Data** | CFTC-pending | GPU futures vs `SDH100RT` (announced May 12, not live) | Institutional clearing |
| **ICE/NYSE + Ornn** | Pending | Cash-settled Asian-style futures (H100/H200/B200, announced May 19) | Institutional clearing |
| **Polymarket** | Polygon / Polymarket US (CFTC) | First institutional H100 block (FalconX/AneraLabs, Jun 2) | On-chain bespoke blocks |
| **Drift / velocity-exchange** | Solana | BET (post-hack, perps-native relaunch) | General prediction |
| **Limitless / Myriad / SX Bet** | Base / Abstract / Polygon | General prediction (no compute vertical) | Onchain general |
| **Compute (us)** | **Solana** | **Full compute stack vertical** | **On-chain, retail, permissionless, 24/7** |

**Differentiation — breadth + speed + permissionlessness, not the H100 spot hedge.** CME/ICE/Kalshi
will own the institutional H100/H200 hedge with clearing and licensed indices; do not fight there.
Win the parts they can't/won't express: (1) **speculative + long-dated AI/compute milestone markets**
(which lab ships the biggest cluster, capacity buildouts, cost-collapse milestones) that don't fit a
cash-settled future; (2) **inference $/M-token and training-cost markets**; (3) **decentralized-compute
(Akash/io.net/Render) spot-capacity markets** composable with DeAI tokens; (4) sub-second, near-zero-fee,
fully on-chain settlement. Lead GTM with the hedging narrative for *credibility*, but monetize first
on *speculation* volume from the crypto-native base. **Publish our own compute index/dashboard as a
trust + content asset** — both Ornn and Silicon Data lead with their index brand; owning a credible
reference price is a moat.

**Regulatory note.** US posture has tilted toward CFTC jurisdiction over event contracts — the Third
Circuit (April 2026, *KalshiEX v. Flaherty*, 2-1, preliminary-injunction stage only) held sports
event contracts are CEA swaps preempting state gaming law — but that protects *regulated* venues, not
unlicensed offshore protocols. Cash-settled compute-price contracts likely read as swaps/futures
(CFTC jurisdiction). Launch permissionless and **geofence US persons** from settlement-asset trading
(Polymarket International model: restrict ~33 jurisdictions, block VPN evasion, monitor sanctions),
keep a credible decentralization story (non-custodial, oracle-resolved), and design the protocol so a
compliant US front-end (Polymarket-US / QCEX path) can be added without re-architecting. Assume
eventual US operation needs a DCM/regulated wrapper. *(Not legal advice — engage counsel before
launch.)*

## 9. Phased roadmap

**Recommended single MVP market: the H100 Neocloud $/hr monthly scalar market**, settled against
Ornn `ORNNH100` / Silicon Data `SDH100RT` — the deepest, most-recognized underlying, the exact
instrument institutions already hedge, and it forces us to prove the settlement pipeline end-to-end
against a real public index before scaling.

- **Phase 0 — Index licensing (BLOCKER, start immediately).** Open commercial conversations with
  Silicon Data (more API-friendly) and Ornn for on-chain redistribution/settlement rights. Without
  this, nothing settles. In parallel, scaffold the independent fallback basket (Vast.ai/RunPod).
- **Phase 1 — Devnet prototype.** (a) Integrate the Hxro parimutuel SDK on devnet with a
  Pyth/custom compute feed to validate the "trade on compute" UX fast. (b) Build the `core` CTF
  Anchor program (split/merge/redeem) + a parimutuel pool + **manual multisig resolution**.
  LiteSVM/Mollusk coverage of invariants: full-set value = collateral, payout solvency,
  oracle-staleness rejection, payout math.
- **Phase 2 — Devnet oracle + matching.** Wire the Switchboard On-Demand / committee oracle posting
  the licensed index; add off-chain matching (DFlow CLP pattern) or Phoenix; turn on LMSR seeding +
  Polymarket-style MM rewards. Launch AI-milestone markets here as the liquidity funnel *(only once
  the optimistic layer is hardened)*.
- **Phase 3 — Audit + safety rails.** External audit (OtterSec / Zealynx / Neodyme); add
  dispute/timelock window, guardian pause/void, Squads upgrade-authority multisig.
- **Phase 4 — Mainnet.** Launch narrow: **H100 monthly (MVP)** + B200 + H200 + 1–2 milestone
  markets, each LMSR-seeded with a bounded subsidy, with 1–2 designated MMs. Move toward
  immutable/governance-controlled programs post-stability.

## 10. Key risks & open decisions for the founders

Genuine forks-in-the-road for the humans (surfaced, not answered):

- **Index licensing (existential).** Can we license Ornn or Silicon Data for *permissionless
  on-chain* settlement, at what cost/exclusivity, and with legal redistribution rights? With
  ICE/CME wiring these indices into regulated futures, the owners may resist licensing a
  permissionless on-chain competitor — or price it prohibitively. If neither will, do we build our
  own index (manipulation/credibility risk) or pivot to milestone-only markets?
- **CME/Silicon Data pairing** is from a single secondary source — verify directly; it strengthens
  SiliconIndex's credibility but also its exclusivity leverage.
- **Settlement-window mechanics** — exact Asian-VWAP / daily-close conventions per index are not
  fully public; needed to write unambiguous resolution rules.
- **Switchboard secret handling** — confirm On-Demand can inject an authenticated API key into
  `HttpTask` such that it never leaves the enclave, and confirm oracle-queue economics/latency for
  a daily (not sub-second) feed.
- **Primary mechanism for hedgers** — scalar expiry vs index perp vs parimutuel: which best fits
  genuine hedging vs speculation? Evidence doesn't settle this.
- **Build our own index or not** — proprietary index as moat/content asset vs pure settlement venue
  referencing third parties.
- **Hxro dependency** — confirm live TVL/pool depth and that custom-underlying + custom-oracle
  onboarding is permissionless at the instruction level before composing.
- **Optimistic-oracle path** — adopt/fork WAGR (young, unaudited-by-us), build native, or defer
  subjective markets entirely at launch? Highest engineering risk.
- **Matching layer** — DFlow CLP off-chain-match (relayer trust) vs Phoenix on-chain (crankless) vs
  OpenBook (needs a crank).
- **Regulatory posture** — permissionless-offshore-only, or design for a compliant US wrapper from
  day one? How aggressive is geofencing?
- **Basis risk** — Ornn vs Silicon Data can print materially different H100 prices; a hedger's real
  exposure may not track the chosen index. Multi-index settlement to mitigate, or accept the basis?
- **Hardware obsolescence** — GPU generations churn fast (H100→H200→B200→B300); markets and the
  index need continuous re-specification.
- **Chain concentration** — Solana-only limits addressable liquidity vs Polygon/Base venues;
  multi-chain plan?
- **UX of scalar markets** — native scalar payoffs are less intuitive than YES/NO; abstract into
  "long/short the price" framing or decompose into buckets?

## 11. Sources

**GPU price indices & data**
- https://www.prnewswire.com/news-releases/ornn-compute-price-index-added-to-bloomberg-terminal-302732184.html
- https://www.ornn.com/
- https://theinnermostloop.substack.com/p/the-first-tradable-compute-price
- https://www.silicondata.com/products/silicon-index
- https://docs.silicondata.com/products/gpu-index-announcements
- https://www.silicondata.com/blog/b200-rental-price-march-2026-update
- https://www.silicondata.com/blog/h100-rental-price-over-time
- https://semianalysis.com/gpu-pricing-index/
- https://newsletter.semianalysis.com/p/the-great-gpu-shortage-rental-capacity
- https://www.clustermax.ai/
- https://spectrum.ieee.org/gpu-prices
- https://docs.vast.ai/documentation/instances/pricing
- https://graphql-spec.runpod.io/
- https://www.thundercompute.com/blog/nvidia-h100-pricing

**Regulated futures & institutional demand**
- https://www.cmegroup.com/media-room/press-releases/2026/5/12/cme_group_and_silicondatapartnertolaunchfirstcomputefutures.html
- https://www.businesswire.com/news/home/20260519470467/en/ICE-and-Ornn-to-Launch-GPU-Compute-Futures-Contracts
- https://ir.theice.com/press/news-details/2026/ICE-and-Ornn-to-Launch-GPU-Compute-Futures-Contracts/default.aspx
- https://blockspace.media/insight/ice-ornn-launch-gpu-compute-futures-2026-2/
- https://www.prnewswire.com/news-releases/polymarket-closes-first-institutional-block-trade-on-a-gpu-instrument-302787854.html
- https://www.cnbc.com/2026/06/02/polymarket-closes-first-block-trade-in-push-for-institutional-adoption.html
- https://kalshi.com/markets/kxh100mon/h100-monthly-price/kxh100mon-26mar31
- https://thenextweb.com/news/ice-nyse-compute-futures-market-gpu-ai

**Solana protocols (build / fork / compose)**
- https://docs.hxro.network/
- https://github.com/Hxro-Network
- https://github.com/velocity-exchange/protocol-v2
- https://www.dlnews.com/articles/defi/drift-to-issue-recovery-tokens-in-wake-of-295m-hack/
- https://github.com/MonacoProtocol/sdk
- https://github.com/openbook-dex/openbook-v2
- https://github.com/Ellipsis-Labs/phoenix-v1
- https://solana.com/news/dflow-prediction-markets-api
- https://news.kalshi.com/p/kalshi-solana-tokenized-predictions

**Mechanism design**
- https://conditional-tokens.readthedocs.io/en/latest/developer-guide.html
- https://github.com/Polymarket/uma-ctf-adapter
- https://docs.polymarket.com/market-makers/liquidity-rewards
- https://www.paradigm.xyz/2024/11/pm-amm
- https://blog.gensyn.ai/lmsr-logarithmic-market-scoring-rule/
- https://docs.drift.trade/prediction-markets/prediction-markets-intro
- https://arxiv.org/pdf/2509.11990

**Oracle & resolution**
- https://www.pyth.network/price-feeds
- https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana
- https://docs.pyth.network/price-feeds/core/pull-updates
- https://docs.switchboard.xyz/
- https://github.com/switchboard-xyz/on-demand
- https://docs.switchboard.xyz/product-documentation/data-feeds/solana-svm/part-1-designing-and-simulating-your-feed/option-2-designing-a-feed-in-typescript
- https://docs.switchboard.xyz/product-documentation/data-feeds/designing-feeds/rest-apis-with-httptask
- https://docs.uma.xyz/developers/optimistic-oracle-v3
- https://docs.uma.xyz/resources/network-addresses
- https://www.theblock.co/post/366507/polymarket-uma-oracle-update
- https://thedefiant.io/news/markets/usd85m-polymarket-dispute-over-strategy-s-may-bitcoin-sale-puts-uma-s-token-voting-oracle-on
- https://wagr.fi/
- https://solanacompass.com/learn/Unlayered/hedgehog-what-next-for-prediction-markets
- https://www.alchemy.com/dapps/list-of/decentralized-computing-tools-on-solana

**Tech stack & security**
- https://www.anchor-lang.com/docs/updates/release-notes/0-31-0
- https://www.anchor-lang.com/docs/testing/litesvm
- https://solana.com/solutions/token-extensions
- https://www.helius.dev/laserstream
- https://www.helius.dev/blog/a-hitchhikers-guide-to-solana-program-security

**Competition & regulatory**
- https://www.skadden.com/insights/publications/2026/04/third-circuit-affirms-kalshis-preliminary-injunction
- https://www.datawallet.com/crypto/polymarket-restricted-countries
- https://predictionauthority.com/prediction-markets-ai/
- https://epoch.ai/data-insights/llm-inference-price-trends
- https://davefriedman.substack.com/p/compute-derivatives-market-primer

---

*Methodology: produced by a 6-domain research fleet (product, Solana landscape, mechanism, oracle,
architecture, GTM), each domain adversarially fact-checked by an independent verifier, plus a
dedicated oracle deep-dive. Verification corrected several stale/conflated figures (H100 price
series, Drift's April 2026 hack, Monaco's withdrawn repos) and confirmed the time-sensitive claims
(live Bloomberg indices, CME/ICE futures announcements, Hxro repo activity). Treat all forward-looking
and regulatory statements as research, not advice.*
