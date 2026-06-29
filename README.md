# Compute

**Prediction markets for trading on compute** — a Solana-native venue where users trade on the
price and availability of AI compute (GPU rental rates, inference cost, capacity, and AI
milestones).

This repository currently holds the foundational research and build plan. No application code yet.

## Where to start

- [`docs/RESEARCH.md`](docs/RESEARCH.md) — the full research & build plan: what to build, the
  market mechanism, the oracle/settlement architecture (the critical path), the on-chain
  architecture, competitive positioning, and a phased roadmap.

## TL;DR

- **Product:** trade on GPU $/hr (H100 neocloud as the flagship, B200/H200 for volatility), plus
  AI-milestone markets. The category is validated — live Bloomberg GPU indices, CME/ICE futures,
  and a real institutional Polymarket hedge already exist.
- **Wedge:** breadth, speed, and permissionlessness across the whole compute stack — *not* the
  institutional H100 spot hedge that regulated incumbents (CME/ICE/Kalshi) will own.
- **Hardest problem:** the settlement oracle. No on-chain GPU index exists; we must license one
  (Silicon Data / Ornn) and bridge it on-chain via Switchboard On-Demand. **Index licensing is the
  existential, blocking dependency.**
- **Build approach:** compose on Hxro's open-source parimutuel for fast short-window markets; build
  a lean Anchor conditional-token program for scalar price markets. Do **not** fork Drift (post-hack)
  or depend on Monaco (repos withdrawn).
