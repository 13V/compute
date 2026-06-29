# Compute — Frontend

A Next.js (pages router) app for trading YES/NO on **Compute** prediction markets,
an on-chain FPMM prediction market on Solana. Connect a Solana wallet, browse
markets, buy/sell outcome tokens, redeem winnings, and drive the multi-step
settlement flow (propose → dispute window → finalize, or guardian veto → void).

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

## What's here

- **`pages/index.tsx`** — market list. Fetches `listMarkets()`, shows each
  market's question, resolution source, Open/Resolved state, current YES/NO
  marginal prices, reserves, and collateral (TVL). Links to detail.
- **`pages/market/[id].tsx`** — market detail + state-driven panels. Controls are
  driven off `market.state` (Open/Resolving/Resolved/Void) and the clock
  (`closeTime`, `resolutionTime`, dispute window):
  - **Buy / Sell** (only while OPEN and `now < closeTime`): pick YES/NO via an
    accessible radiogroup, preview tokens via `quoteBuy`/`quoteSell` (fee-aware),
    see price impact, set slippage (clamped 0–50%, warns above ~5%), and a **Max**
    button. Buy is disabled on insufficient USDC; Sell respects both held balance
    and `market.collateral` (the chain rejects `collateral_out > collateral`).
    Past `closeTime`, trading is disabled with a "closed" notice.
  - **Resolver** (wallet == `market.resolver`, OPEN & `now >= resolutionTime`):
    **Propose YES / Propose NO** via `proposeOutcomeIx()`.
  - **Resolving**: shows the proposed outcome + a dispute-window countdown
    (`resolvedAt + config.disputePeriod`). After it elapses, anyone can
    **Finalize** (`finalizeOutcomeIx()`). While open, the **guardian**
    (wallet == `config.guardian`) sees **Dispute / Void** (`disputeVoidIx()`).
  - **Resolved**: winners **Redeem** the winning side 1:1 (`redeemIx()`); the LP
    (wallet == `market.lp`) can **Claim pool** (`claimPoolIx()`).
  - **Void**: 50/50 refund — holders **Redeem (refund)** for whichever side they
    hold (`redeemVoidIx()`); LP can **Claim pool**.
  - A **trust/risk panel** explains settlement (single trusted resolver, no
    external oracle), the dispute window, guardian veto, and 50/50 voids, and
    shows the (copyable) resolver + guardian pubkeys and a cluster badge.
  - Shows your USDC / YES / NO balances. State badge + absolute/relative
    close/resolution times appear on both the list and detail header.
- Tx failures are decoded via `client.parseError()`. On success, the signature is
  shown with a copy button and a cluster-aware explorer link; market data +
  balances refresh automatically.

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
