# Compute — Path to World-Class

## 1. Verdict

Compute is a **correct, well-tested AMM-only binary-market MVP** whose core is genuinely strong: the FPMM math is sound and property-tested, rounding consistently favors the pool, the vault/collateral/fee conservation invariant holds across every instruction, and account validation is largely declarative and substitution-safe. That foundation is closer to audit-grade than most MVPs at this stage. What separates it from world-class is **not arithmetic unsoundness — it is the settlement and operational surface**: a single fully-trusted resolver key can steal the entire vault, there is no dispute window, no void/refund path, no escape hatch if the resolver disappears, and no trading halt at resolution time. Those resolution-integrity gaps are the single most important theme, because the research itself declares settlement the area where "the product lives or dies." Secondarily, the venue cannot yet express its own research-designated flagship instrument (a scalar/range market), ships only the lowest-priority tier of the intended product, and has **zero CI, no LICENSE/SECURITY policy, and two known-vulnerable frontend dependencies**. The good news: the highest-leverage fixes are additive and parallelizable — harden the resolver into a propose→timelock→finalize flow with a void path, add scalar markets, stand up CI plus supply-chain scanning, and de-duplicate the SDK. None of the must-do items require rewriting the proven core. Do those, and Compute moves from "impressive MVP" to "auditable, operable protocol."

## 2. Critical & High-Severity Fixes

| Title | Severity | File/Area | Fix |
|---|---|---|---|
| Single trusted resolver can steal entire vault | **Critical** | `lib.rs:426-442` `resolve` | Split into `propose_outcome` (writes `proposed_outcome` + `resolved_at`, emits event) and `finalize_outcome` (callable only after challenge delay). Require `market.resolver` to be a multisig (validate the signer's account owner is a known multisig program) rather than an arbitrary hot key. Emit the proposed outcome on-chain. |
| No dispute window / timelock between resolution and payout | **High** | `lib.rs:426-442` → `redeem`/`claim_pool` | Add `STATE_RESOLVING`; record `resolved_at` on resolve; gate `redeem`/`claim_pool` on `now >= resolved_at + config.dispute_period`. Add a guardian-gated dispute/void path during the window. Store `dispute_period` in Config. |
| No fallback if resolver never resolves — collateral permanently locked | **High** | `lib.rs:444-489` `redeem`, `492-544` `claim_pool` | Add `STATE_VOID` + a deadline escape hatch: when `now > resolution_time + GRACE_PERIOD` and still `STATE_OPEN`, allow (permissionless or admin) transition to `STATE_VOID`, then full-set redemption (burn equal YES+NO → 1 collateral) for both holders and the LP's pooled reserves. |
| Trading not halted at `resolution_time`; informed last-look | **High** | `lib.rs:201, 320` `buy`/`sell` | Add `require!(Clock::get()?.unix_timestamp < market.resolution_time, MarketClosed)` at the top of buy/sell. Ideally store a separate `close_time <= resolution_time`. Add a clock-advance test asserting buy/sell revert while resolve succeeds. |
| No pause / guardian / kill-switch | **High→Med** | whole program; Config | Add `paused: bool` + `guardian: Pubkey` to Config; gate buy/sell/seed behind `require!(!config.paused)`; add `set_paused(bool)` callable by admin or guardian. Requires Config realloc/migration since accounts are live. |
| No void/invalid resolution — losing side zeroed with no refund | **High→Med** | `lib.rs:426-442` | Implement void as **full-set redemption** (not 0.5/side + LP reserve, which double-counts). `resolve_void` sets `STATE_VOID`; `redeem_void` burns 1 YES + 1 NO → 1 collateral. Gate resolved-only paths to reject VOID and vice versa. |
| Config write-once: admin/fee immutable, lost key strands fees | **High→Med** | `lib.rs:53-62`, `547-571` | Add two-step `set_admin` (propose `pending_admin` → `accept_admin`) and `set_fee_bps` (re-check `<= 1000`). Add `pending_admin: Pubkey` to Config. Recommend Squads multisig admin from day one. |
| No CI/CD — nothing enforces build/test/lint/format | **High** | `.github/` (absent) | Add `ci.yml` with parallel rust / anchor / app jobs. See **Track: ci-cd** for the corrected pipeline (the IDL-drift check and `next lint` step both need fixes before they work). |
| Program keypair gitignored while `declare_id!` is hardcoded | **High→Med** | `.gitignore:2`, `lib.rs:27`, `Anchor.toml` | Commit a deterministic throwaway program keypair under `keys/`, point Anchor's build at it, and make `scripts/test-integration.sh` + `pdas.ts` derive the program ID from `anchor keys list` / `idl.address` instead of hardcoding `8xv1…`. Add a CI check asserting build ID == `declare_id!`. |
| No scalar/range markets — flagship cannot be expressed | **High→Med** | whole program (binary-only) | Add `market_kind {Binary, Scalar}`, `bound_low/high`, `settlement_value: Option<u64>`; `resolve_scalar(value)` clamps X to [A,B]; redeem pays LONG `C·(X−A)/(B−A)`, SHORT `C·(B−X)/(B−A)` in 1e6 fixed-point. Caveat: useless without the licensed index + settlement pipeline, so sequence behind the oracle work. |
| next@14.2.15 ships flagged-vulnerable | **High→Med** | `app/package.json:20` | Bump to latest patched 14.2.x (or 15.x after compat), regenerate lockfile, confirm `npm audit` clean. Note: CVE-2025-29927 (middleware bypass) is **not reachable** here (no middleware/API routes) — justify the bump on the npm deprecation notice. |
| Frontend SDK is hand-duplicated, guaranteeing drift | **High→Med** | `app/lib/{client,amm,pdas}.ts`, `app/lib/idl` | Make `sdk/` a real workspace package (`@compute/sdk`), import it from `app/`, delete the copies. Interim: CI `diff` check (ignoring header comment) that fails on divergence. |

*Note on severities: the adversarial pass downgraded several originally-"high"/"critical" findings to medium where impact was conditional, latent, or subsumed by the accepted trusted-resolver model. They remain in this table because they are the must-dos for a production/audit bar; the adjusted level is shown as `Orig→Adj`.*

## 3. Correctness & Robustness (confirmed mediums worth doing)

**Math correctness & test strength**
- **Proptest invariants are too weak** (`math.rs:285-317`): `tokens_out >= a` is a tautology (rounding-direction-insensitive). Replace with the load-bearing ones — `keep <= rb` / `need >= rs` (no-underflow), buy↔sell round-trip non-profitability across freshly-quoted reserves, and ceil-tightness (`keep == ceil_div(k, denom)` with the tight-bound pair). Widen ranges toward the u64 envelope (the proptests cap at 1e12; `large_values` exercises 1e15). Add a cross-module solvency-identity state machine.
- **`quote_buy` u64-truncation** (`math.rs:102-109`): not a bug (it's the fundamental SPL u64 supply ceiling and fails closed), but add a comment, a distinct `ReserveCapacityExceeded` error for SDK/UI surfacing, and a boundary proptest.

**Frontend correctness**
- **Sell-liquidity guard uses the wrong bound** (`app/lib/amm.ts:47`): UI checks only `a < reserveOther`, but the chain also enforces `collateral_out <= market.collateral`; these diverge under pool skew, so the UI previews feasible trades the chain rejects. Cap `collateral_out` at `market.collateral` (already on `MarketAccount`, no extra fetch) and surface a distinct message.
- **Insufficient-balance warnings don't disable submit** (`app/pages/market/[id].tsx:478, 615`): add `insufficient` to both `disabled` predicates.
- **Full-position sell impossible** (slippage-padded `maxIn` always exceeds held balance): add a "Max" button that clamps `maxTokensIn` to held balance exactly (safe — the program only requires the trader hold `quote.tokens_in`), and fix the misleading warning copy (the button isn't actually blocked).
- **Slippage input uncapped** (`app/pages/market/[id].tsx:411-433`): a `>=100%` entry silently zeros min-out protection. Clamp input to 0–50%, warn above ~5%, and defensively clamp `slippage >= 1` in `minOutWithSlippage`.
- **Malformed route id leaks `new BN()` error** (`[id].tsx:71`): validate `/^\d+$/` before constructing the BN; distinguish "invalid id" from "not found." Do **not** use `Number.isSafeInteger` (u64 ids exceed it).

**SDK robustness**
- **`createMarketIx` takes a `marketId` the program ignores** (`sdk/client.ts:80`): program derives the PDA from `config.market_count`. Fetch `market_count` internally (via existing `fetchConfig`) and drop the parameter; mirror the fix in `app/lib/client.ts`.

**Resolution observability**
- **Enrich `MarketResolved`** (`lib.rs:912`): add `resolver` and `resolved_at`; echo `resolution_source` so off-chain disputes can anchor to the named print.

## 4. Missing Features for World-Class (sequenced by leverage)

1. **Pluggable resolver / oracle interface** *(highest leverage; gates everything below)* — replace the bare-key comparison with `resolver_kind: u8 {TRUSTED_KEY, SWITCHBOARD_INDEX, OPTIMISTIC, PYTH}` + a fixed `resolver_config`. Reserve the discriminator + a padding region in `Market::SPACE` **now** so future oracle configs slot in without a layout-breaking migration. Keep `TRUSTED_KEY=0` as the clearly-labeled MVP fallback. Defer the full Switchboard/Pyth/optimistic adapters to the oracle phase.
2. **Void / invalid / refund resolution** — full-set redemption path (see §2). Prerequisite for the resolver-failure escape hatch and the guardian dispute path.
3. **Dispute window + timelock** — `STATE_RESOLVING` → `finalize` after `dispute_period`. Pairs with the guardian/void work.
4. **Scalar / range markets** — the research flagship's on-chain shape (see §2). Highest-leverage *single mechanism* addition once settlement is hardened. **Done:** `market_kind {Binary, Scalar}` with `lower_bound`/`upper_bound`/`settlement_fraction`, `propose_scalar` / `redeem_scalar`, floor-rounded `scalar_payout` (LONG `f`, SHORT `1 − f`); same trusted/oracle propose→timelock→finalize path.
5. **Multi-LP / LP-shares** — make `lp_shares` a real ledger: mint shares proportional to contributed liquidity *valued against current reserves* (the standard AMM pitfall — late LPs must not mint mispriced shares); add `add_liquidity`/`remove_liquidity` (pre-resolution); route a configurable fraction of taker fees to LPs pro-rata. Prerequisite for the §5 designated-MM program. **Done (except fee routing):** `total_shares` + a per-provider `LiquidityPosition` ledger, price-ratio-preserving `add_liquidity` / `remove_liquidity`, per-LP pro-rata `claim_pool`, all rounding favoring the pool. **Still future:** routing taker fees to LPs pro-rata.
6. **Asian-VWAP settlement accumulator** — store settlement as the output of an on-chain running-sum/count over the contract window, not a snapshot. Scope this with scalar markets/real index; documented as required-before-real-index work, not an MVP fix.
7. **Market close vs. resolve separation** — `close_time <= resolution_time` so trading halts before resolution becomes possible (folds into the trading-halt fix in §2).
8. **Index perpetual (Tier 1)** — explicitly deferred Phase-2+, *after* scalar + multi-LP + void/dispute + real oracle. Document the §5 funding formula in the roadmap; do not build before settlement integrity is solved.

## 5. Quality & Infra (concrete asks)

**CI/CD** — none exists. Stand up `.github/workflows/ci.yml` (see Track below). Add `cargo audit`/`cargo-deny` (advisories+bans+licenses via `deny.toml`; flag the borsh 0.10/1.x duplication) and `npm audit --audit-level=high` on both JS roots.

**Docs** — add `LICENSE` (Apache-2.0; also set `license` in both `package.json` + program `Cargo.toml`), `SECURITY.md` (disclosure contact/scope/safe-harbor), `docs/THREAT_MODEL.md` (enumerate resolver/admin/upgrade-authority powers, no-void/no-dispute/no-halt non-goals, contrasted with the proven conservation/rounding invariants), `docs/DEPLOYMENT.md` (end-to-end runbook: deploy → `initialize` [one-time, irreversible] → create → seed → resolve/redeem/claim/collect, plus key custody + upgrade-authority disposition), `docs/OPERATIONS.md` (resolver decision checklist, "no undo" warning, fee-sweep cadence, monitoring signals), `docs/REFERENCE.md` (PDA-seed table noting market-id-LE vs market-pubkey, account/instruction/error/event tables — 16 ErrorCode variants, not 15), and `CONTRIBUTING.md` (IDL re-vendoring procedure). Fix or label `RESEARCH.md §7`'s PDA model, which contradicts the shipped binary program. Document that `resolution_time` is only the *earliest* resolve time and trading does not halt there.

**Deps & reproducibility** — bump `next`; mitigate unpatched `bigint-buffer@1.1.5` (override or documented `npm audit` exception); pin toolchains (`rust-toolchain.toml` for host clippy/test consistency — note SBF bytecode is already pinned via platform-tools v1.53; `engines`/`.nvmrc`/`packageManager` for Node); build the program with `--locked`. Trim the wallet-adapter surface (`@solana/wallet-adapter-wallets` drags in 35 integrations / 1322 packages for a binary app).

**Tests** — add multi-actor auth negatives (non-creator seed, non-LP claim_pool, non-admin collect_fees, resolver≠creator); NO-outcome resolution + losing-side redeem→WrongMint; re-seed/double-resolve/double-init negatives; `user_outcome` substitution tests (WrongMint/WrongOwner); claim_pool/collect_fees `NothingToClaim` + double-claim; event-field assertions (gross vs net `collateral`); an on-chain randomized buy/sell/redeem fuzz loop asserting conservation **and k-non-decrease and quoted-vs-actual reserves** after each step; tighten negative-test regexes (drop the `custom program error` fallback and the stale `0x177c` literal — it actually decodes to `NotResolved`, not `SlippageExceeded`); per-scenario fresh markets to break order-dependence. Add a vitest suite for `sdk/amm.ts` slippage/quote helpers and wire into CI.

**Rust modularization** — split `lib.rs` (954 lines) into `state.rs`/`error.rs`/`events.rs`/`instructions/<name>.rs`; extract a `Market::signer_seeds` helper (copy-pasted into 6 instructions) and a `Side` enum to kill the hand-mirrored outcome ladders (a transposed branch would be a silent fund-routing bug); derive `InitSpace` instead of hand-summed `SPACE` (move the `+8` discriminator to the constraint); `MAX_FEE_BPS`/`PRICE_SCALE` named consts; remove the unused `init-if-needed` feature; add a workspace `[lints.clippy]` table. Make `ceil_div` overflow-proof (`a/b + (a%b != 0)`) and emit events from `redeem`/`claim_pool`/`collect_fees` (`Redeemed`/`PoolClaimed`/`FeesCollected`).

**Frontend UX/a11y** — show `resolutionTime` (absolute + countdown) on card + header and disable Resolve until the window opens (with a small clock-skew buffer); accessible radiogroup for the YES/NO toggle + `:focus-visible` ring; non-color cue on the active segment; toast system with explorer link + copy-to-clipboard; reframe resolved markets to outcome/payout (hide stale price pills); mobile breakpoints; trust/risk panel ("resolved by a single trusted key — no oracle/dispute/void") with copyable+linked resolver and a cluster badge; CSP/security headers (`frame-ancestors 'none'`, `nosniff`, `Referrer-Policy` now; nonce-based `script-src` as follow-up — a flat `script-src 'self'` breaks Next's inline runtime). Decode Anchor errors via `translateError`/`AnchorError.parse` before display.

## 6. Implementation Tracks (parallelizable)

> **Cross-track dependency:** any program change to instructions/accounts/events requires an **IDL regen** (`anchor build`) → re-vendor into `sdk/idl` and `app/lib/idl`. Tracks B, F, and the program parts of A/D all touch the IDL; coordinate a single regen point per merge and let the **ci-cd** drift check enforce sync. Also: several program changes alter `Config`/`Market` layout (paused/guardian, pending_admin, resolved_at, resolver_kind, void state) — batch them into **one migration/realloc** rather than several.

### Track A — core-program-hardening (Rust)
1. Add `STATE_RESOLVING`/`STATE_VOID`; record `resolved_at`; `Config.paused`+`guardian`+`pending_admin`+`dispute_period` (single layout migration).
2. Split `resolve` → `propose_outcome` + `finalize_outcome` (timelock); gate redeem/claim_pool on finalized state + `resolved_at + dispute_period`.
3. Add void path (full-set redemption) + resolver-failure escape hatch (`now > resolution_time + GRACE`).
4. Add trading-halt (`now < resolution_time`/`close_time`) in buy/sell.
5. Add `set_paused`, `set_admin`(two-step), `set_fee_bps`, guardian dispute/void.
6. Validate `resolution_time` bounds at create (`> now`, `<= now + MAX_HORIZON`).
7. Emit `Redeemed`/`PoolClaimed`/`FeesCollected`; enrich `MarketResolved`.
8. `ceil_div` overflow-proof; remove `init-if-needed`; `MAX_FEE_BPS`/`PRICE_SCALE` consts.

### Track B — oracle-interface (Rust, depends on A's state machine)
1. Add `resolver_kind: u8` + reserved padding in `Market::SPACE` (forward-compat, no behavior change).
2. Mark/rename `resolution_source` as display-only (or bind a structured spec hash).
3. Stub the router; keep `TRUSTED_KEY=0` as default. (Adapters deferred.)

### Track C — ci-cd
1. `.github/workflows/ci.yml`: rust job (`fmt --check`, `clippy -D warnings`, `cargo test -p compute-markets --lib`); anchor job (`anchor build`, **IDL-sync-then-diff** against `sdk/idl`+`app/lib/idl`, integration script); app job (`tsc --noEmit`, lint, `next build`).
2. Fix the two pipeline traps: the IDL diff must target the *vendored* copies (not gitignored `target/idl`); `next lint` needs an ESLint config added or it prompts/hangs in CI.
3. Add `cargo-deny` (`deny.toml`: advisories+bans+licenses) and `npm audit --audit-level=high` (both roots).
4. Pin toolchains: `rust-toolchain.toml`, `engines`/`.nvmrc`/`packageManager`; build program `--locked`.
5. Program-keypair reproducibility: commit deterministic key, derive IDs from `idl.address`/`anchor keys list`, assert against `declare_id!`.
6. `set -euo pipefail` in scripts; tag-triggered verifiable-build/provenance workflow.

### Track D — docs
1. `LICENSE` (Apache-2.0) + license fields. 2. `SECURITY.md`. 3. `docs/THREAT_MODEL.md`. 4. `docs/DEPLOYMENT.md`. 5. `docs/OPERATIONS.md`. 6. `docs/REFERENCE.md` + `ARCHITECTURE.md`. 7. `CONTRIBUTING.md`. 8. README: trading-not-halted, no-deadline, LP-economics (one-sided at-risk), `lp_shares` reserved-field note. 9. Fix/label `RESEARCH.md §7`.

### Track E — frontend-polish (independent of program until IDL regen)
1. Disable submit on `insufficient`; fix sell-liquidity bound vs `market.collateral`; "Max" sell; clamp slippage + zero-protection guard; validate route id.
2. a11y: radiogroup, `:focus-visible`, non-color YES/NO cue, mobile breakpoints.
3. Show `resolutionTime` + disable early Resolve; reframe resolved markets; trade-input clarity (token-denominated sell, price-impact tooltip, balance/Max helpers).
4. Toast surface + explorer link + copy; decode Anchor errors before display.
5. Trust/risk panel + cluster badge; CSP/security headers.

### Track F — sdk
1. Workspace-package `sdk/`; import from app; delete `app/lib/{client,amm,pdas}.ts` + `app/lib/idl`.
2. `createMarketIx` fetches `market_count` (drop `marketId` param).
3. Add `previewBuy`/`previewSell` (fee-aware, encode the buy-fee-before / sell-fee-after asymmetry), `getMarketView`/`getPrices`/`getUserPositions`, `parseProgramError` (IDL error map + custom-code regex), exported `Market`/`Config`/event types, `Outcome`/`State` types, `strict: true`, optional tx-build/send + ComputeBudget helpers.

### Track G — more-tests
1. Multi-actor auth negatives (distinct keypairs; resolver≠creator).
2. NO-outcome lifecycle + losing-side WrongMint; re-seed/double-resolve/double-init; `user_outcome` substitution; claim/collect NothingToClaim + double-claim; event-field assertions.
3. On-chain randomized conservation+k+quote fuzz loop; per-scenario fresh markets.
4. Strengthen math proptests (round-trip, no-underflow, ceil-tightness, wide ranges).
5. Tighten negative-test regexes (drop generic fallback + stale hex).
6. vitest for `sdk/amm.ts`; wire into CI (Track C).

## 7. Do-Now Shortlist (highest ROI first)

1. **Resolver propose→timelock→finalize + multisig requirement** (Track A 1-2) — closes the critical vault-theft path.
2. **Void path + resolver-failure escape hatch** (Track A 3) — eliminates the permanent-fund-lock liveness failure.
3. **Trading halt at `resolution_time`** (Track A 4) — kills the informed last-look on every market.
4. **Stand up CI** (Track C 1-2) — green-build signal; gates every other change.
5. **Pause/guardian + Config layout migration batch** (Track A 1, 5) — incident lever; do the realloc once.
6. **Add LICENSE + SECURITY.md + THREAT_MODEL.md** (Track D 1-3) — table-stakes before any external audit.
7. **De-duplicate the SDK into a workspace package** (Track F 1) — removes the guaranteed frontend/program drift class.
8. **Bump `next`, add `npm audit`/`cargo-deny`** (Track C 3, dep bump) — clears the two known-vulnerable deps.
9. **Fix program-keypair reproducibility** (Track C 5) — a fresh clone currently can't reproduce the canonical program ID.
10. **Disable-on-insufficient + sell-liquidity-bound fix + slippage clamp** (Track E 1) — stops avoidable failed signs and silent loss of protection.
11. **Emit redeem/claim/collect events** (Track A 7) — makes settlement reconcilable off-chain.
12. **Strengthen math proptests** (Track G 4) — locks the load-bearing rounding/anti-extraction guarantees the suite currently skips.

## 8. False-Positives & Non-Issues (checked, dismissed — don't re-spend effort)

- **Token-2022 collateral accepted by init** — false. Plain `Account<Mint>` enforces legacy-SPL ownership at deserialization; a Token-2022 mint is rejected at `initialize` with `AccountOwnedByWrongProgram`. The proposed `owner = token::ID` is redundant.
- **fee-bucket dust "permanently unwithdrawable" / collect_fees unsound** — false; the finding self-refutes. `fee_accrued` is a persistent independent counter, collectable anytime `> 0`; `collect_fees` only moves the fee bucket and can't touch collateral backing.
- **sell fee "double-charges" on dust** — false. Curve spread (paid in outcome tokens to LPs) and protocol fee (paid in collateral to protocol) are different currencies/beneficiaries; floored fee is *zero* on dust. Test already asserts net-of-fee receipt.
- **Tiny buy reverts with zero-token quote** — false/unreachable. With `fee_bps <= 1000`, `net >= 1` always, and FPMM guarantees `tokens_out >= a >= 1`; the ZeroAmount revert can't be reached from the UI.
- **`marginalPrice`/`feeAmount` toNumber overflow & precision loss** — false. `.muln(1e6).div(total)` is bounded by 1e6 before `.toNumber()`; `muln/divn` args are 26-bit-safe and TS-typed `number`. Only a display rounding/doc nit remains.
- **Reserves vs physical-pool-balance desync "could desync backing" / DoS the burns** — false. Burns never read `.amount`; donated tokens are inert (only the donor self-griefs). No assertion needed; just document + one inert-donation test.
- **`ceil_div` u128 overflow** — false at both (only) call sites; `k + denom - 1` provably maxes at `u128::MAX - 1`. Rewrite is hygiene, not a fix.
- **No trade deadline parameter** — near-zero delta on Solana: blockhash already bounds tx lifetime and slippage already guards adverse price. Optional API-parity nicety only.
- **autoConnect / blind-sign confirmation modal** — preview already shows fee/net/min-out before signing; a modal is redundant. autoConnect is a nit (wallets still prompt per-signature).
- **Vault/pool authority not constraint-checked** — structurally guaranteed (PDA authority is immutable; no SetAuthority CPI exists). The proposed `owner == market` constraint can never fire.
- **YES/NO color-only encoding "users can't tell which side"** — overstated; literal "YES"/"NO" text appears at every decision point (buttons, previews, pills). Real residual is only the active-segment non-color cue (low/polish), not a mis-trade hazard.