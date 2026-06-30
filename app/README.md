# Compute — Frontend

A Next.js (pages router) app for **Compute**, an on-chain FPMM prediction market
on Solana. Connect a Solana wallet, browse every market kind, buy/sell outcome
tokens, provide/withdraw liquidity, drive all four resolver paths, and redeem.

It surfaces **both market kinds** (Binary YES/NO and Scalar LONG/SHORT over a
`[lower, upper]` range) and **all three resolver kinds** (Trusted key, Oracle
feed, Optimistic bonded assert/dispute), plus voids and multi-LP liquidity.

Program id: `8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`

## Prerequisites

- Node 18+ (developed against Node 22).
- The Compute Anchor program **deployed on the cluster** your RPC points at, with
  the global config initialized and at least one market created and seeded with
  liquidity. The frontend only reads/trades; it does not deploy or initialize.
- A browser wallet (Phantom, Solflare, Backpack, …). These are auto-detected via
  the Solana wallet-standard, so no wallet needs to be hard-coded.

## Configuration

The only config is the RPC endpoint, read from `NEXT_PUBLIC_RPC_URL`
(default `http://localhost:8899`). Copy the example env file if you like:

```bash
cp .env.local.example .env.local
# edit NEXT_PUBLIC_RPC_URL
```

| Cluster   | NEXT_PUBLIC_RPC_URL                 |
| --------- | ----------------------------------- |
| localnet  | `http://localhost:8899` (default)   |
| devnet    | `https://api.devnet.solana.com`     |

## Run

```bash
npm install

# dev server (http://localhost:3000)
NEXT_PUBLIC_RPC_URL=http://localhost:8899 npm run dev

# production build + start
npm run build
npm run start
```

## Flows surfaced

- **`pages/index.tsx`** — market list. For each market it shows the **kind**
  badge (Binary, or Scalar with its `[lower, upper]` range), the **resolver-kind**
  badge (Trusted / Oracle feed / Optimistic), the state badge, prices
  (binary: YES/NO marginal price; scalar: LONG/SHORT price + the implied/settled
  value `lower + price·(upper−lower)`), reserves, collateral (TVL), and
  close/resolve times. Links to detail.
- **`pages/market/[id].tsx`** — market detail + state-driven panels, driven off
  `market.state` (Open/Resolving/Resolved/Void), `market.kind`,
  `market.resolverKind`, and the clock (`closeTime`, `resolutionTime`, dispute
  window):
  - **Header** shows kind/resolver/state badges and, for scalar markets, the
    `[lower, upper]` range and implied/settled value.
  - **Config panel** — `feeBps`, `lpFeeBps`, `bondAmount`, `disputePeriod`,
    `paused`, guardian, plus a cluster badge.
  - **Buy / Sell** (OPEN & `now < closeTime`): same `buyIxs`/`sellIx` for both
    kinds; for scalar the sides are relabeled **LONG/SHORT** and a note explains
    LONG pays `fraction·1`, SHORT pays `(1−fraction)·1` at settlement. Fee-aware
    `quoteBuy`/`quoteSell` previews, price impact, slippage (0–50%, warns >5%),
    **Max** buttons, insufficient-balance and `collateral`-cap guards.
  - **Liquidity** (multi-LP): **Add liquidity** (USDC → `addLiquidityIxs`,
    returns price-preserving outcome tokens) and **Remove liquidity** (shares →
    `removeLiquidityIxs`). Shows your `LiquidityPosition` shares
    (`fetchLiquidityPosition`, treated as 0 if absent) and the pool's
    `totalShares`.
  - **Resolution controls** branch on `resolverKind`:
    - **Trusted** — resolver proposes (binary: **Propose YES/NO** via
      `proposeOutcomeIx`; scalar: settlement-value input → `proposeScalarIx`).
      Then a dispute-window countdown (`resolvedAt + disputePeriod`), anyone
      **Finalize** (`finalizeOutcomeIx`), guardian **Dispute → Void**
      (`disputeVoidIx`).
    - **Oracle feed** — shows the `oracleFeed`, its current value
      (`fetchPriceFeed`), strike/comparison, and max staleness; anyone
      **Resolve from oracle** (`proposeFromOracleIx`) past resolution time, then
      the same finalize/dispute window.
    - **Optimistic** — anyone **Assert YES/NO** (`assertOutcomeIxs`, posts the
      `bondAmount` bond); in RESOLVING shows asserter / proposed outcome / bond /
      disputed, anyone (≠ asserter) **Dispute** (`disputeAssertionIx`),
      **Finalize assertion** (`finalizeAssertionIx`) if undisputed after the
      window, and the **guardian** **Resolve YES/NO** (`resolveDisputeIx`) if
      disputed — bonds route to the correct asserter.
  - **Redeem** (RESOLVED): binary → `redeemIx` (winning side 1:1); scalar →
    `redeemScalarIx` for LONG and/or SHORT (each pays at the settled fraction,
    with a payout preview); LP → `claimPoolIx`.
  - **Void**: 50/50 refund — holders **Redeem (refund)** for either held side
    (`redeemVoidIx`); LP can **Claim pool**.
  - A **trust/risk panel** explains the active resolver's settlement model, the
    dispute window, guardian veto, and 50/50 voids, with copyable resolver +
    guardian pubkeys and a cluster badge.
  - Shows your USDC, outcome-token, and LP-share balances.
- Tx failures are decoded via `client.parseError()`. On success, the signature is
  shown with a copy button and a cluster-aware explorer link; market data,
  balances, and LP position refresh automatically after every tx.

> Market **creation** and oracle-feed publishing are handled by an off-app seed
> script; this app drives the trader / LP / resolver experience for existing
> markets of every kind.

## `app/lib` is copied from `/sdk`

Next.js does not like importing TS from outside its project root, so the SDK is
**copied** into `app/lib/`:

- `lib/pdas.ts`, `lib/amm.ts`, `lib/client.ts` — copied from `/sdk` (each carries
  a header line; otherwise byte-identical to the canonical source, which a CI
  drift check enforces).
- `lib/idl/compute_markets.json` and `lib/idl/compute_markets.ts` — copied from
  `/sdk/idl` (byte-identical).

The three `.ts` lib files carry the header:

```
// Copied from /sdk — regenerate with anchor build and re-copy if the program changes.
```

`lib/client.ts` imports `./idl/compute_markets`, `./pdas`, and `./amm`, which all
resolve locally under `app/lib/`. If the program changes, run `anchor build` at
the repo root, regenerate `/sdk`, and re-copy these files into `app/lib/`.

`lib/format.ts` is the only frontend-original helper (formats/parses 6-decimal
base-unit amounts) and is not part of the SDK.

## Notes

- Wallet UI is loaded with `dynamic(..., { ssr: false })` because
  wallet-adapter touches browser globals; this keeps the production build clean.
- Amounts are in base units (6 decimals) on-chain and formatted to human units
  in the UI.
