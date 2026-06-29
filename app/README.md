# Compute — Frontend

A Next.js (pages router) app for trading YES/NO on **Compute** prediction markets,
an on-chain FPMM prediction market on Solana. Connect a Solana wallet, browse
markets, and buy/sell outcome tokens, redeem winnings, and (if you are a market's
resolver) resolve a market.

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
- **`pages/market/[id].tsx`** — market detail + trade panels:
  - Live YES/NO prices and reserves.
  - **Buy**: pick YES/NO, enter USDC in, preview tokens-out via `quoteBuy`
    (net of fee), see price impact, set slippage (default 1%), submit via
    `buyIxs()` and `sendTransaction`.
  - **Sell**: pick side, enter gross USDC out, preview tokens-in via
    `quoteSell`, set slippage, submit via `sellIx()`.
  - Shows your USDC / YES / NO token balances (read from token accounts).
  - **Redeem** (when resolved): redeem winning tokens 1:1 for USDC via
    `redeemIx()`.
  - **Resolver controls** (only if the connected wallet equals the market's
    `resolver`): Resolve YES / Resolve NO via `resolveIx()`.
- Tx signatures are shown after each successful transaction, and market data +
  balances refresh automatically.

## `app/lib` is copied from `/sdk`

Next.js does not like importing TS from outside its project root, so the SDK is
**copied** into `app/lib/`:

- `lib/pdas.ts`, `lib/amm.ts`, `lib/client.ts` — copied from `/sdk`.
- `lib/idl/compute_markets.json` and `lib/idl/compute_markets.ts` — copied from
  `/target/idl` and `/target/types`.

Each copied file carries the header:

```
// Copied from /sdk — regenerate with anchor build and re-copy if the program changes.
```

The import paths in `lib/client.ts` were adjusted to resolve locally
(`./idl/compute_markets` instead of `../target/...`). If the program changes,
run `anchor build` at the repo root and re-copy these files.

`lib/format.ts` is the only frontend-original helper (formats/parses 6-decimal
base-unit amounts) and is not part of the SDK.

## Notes

- Wallet UI is loaded with `dynamic(..., { ssr: false })` because
  wallet-adapter touches browser globals; this keeps the production build clean.
- Amounts are in base units (6 decimals) on-chain and formatted to human units
  in the UI.
