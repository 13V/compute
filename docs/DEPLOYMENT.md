# Compute — Deployment Runbook

End-to-end procedure to build, deploy, and bring up the `compute_markets`
program on a Solana cluster, plus key-custody guidance. Read
[`THREAT_MODEL.md`](THREAT_MODEL.md) first — several steps here (especially
`initialize` and upgrade-authority custody) are **irreversible or
security-critical**.

> Conventions: commands run from the repo root. The canonical program ID is
> `8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2`. To deploy under your own
> program key, follow §2 to regenerate it.

## 0. Prerequisites

```bash
bash scripts/setup.sh      # Solana (Agave) CLI, BPF platform-tools v1.53, Anchor 0.31.1, node deps
solana --version
anchor --version           # expect 0.31.1
```

Have a funded deployer keypair (`~/.config/solana/id.json` by default) and set
the target cluster:

```bash
solana config set --url devnet     # or mainnet-beta
solana balance                     # ensure enough SOL for rent + deploy
```

## 1. Build

```bash
anchor build      # compiles the program AND regenerates target/idl + target/types
# or, without the Anchor CLI:
cargo build-sbf   # builds target/deploy/compute_markets.so (no IDL regen)
```

If you changed the program, **re-vendor the IDL** into `sdk/idl/` and
`app/lib/idl/` per [`CONTRIBUTING.md`](../CONTRIBUTING.md) before deploying
clients.

## 2. Program keypair and `declare_id!`

The program ID is pinned in three places that must agree: `declare_id!` in
`programs/compute-markets/src/lib.rs`, `Anchor.toml`
(`[programs.localnet]`/`[programs.devnet]`), and the deployer's program keypair
at `target/deploy/compute_markets-keypair.json`.

**To deploy under a fresh program ID of your own:**

```bash
solana-keygen new -o target/deploy/compute_markets-keypair.json   # your program key
anchor keys sync                                                   # rewrite declare_id! + Anchor.toml to match
anchor build                                                       # rebuild so the bytecode embeds the new ID
```

`anchor keys sync` reads the keypair and updates `declare_id!` and `Anchor.toml`
so all three sources of truth agree. **Always rebuild after `keys sync`** — the
program ID is compiled into the bytecode, and a stale build will be rejected at
deploy. (For audit reproducibility, add a CI check that the built program ID
equals `declare_id!`.)

> **Custody the program keypair carefully.** Whoever holds it controls the
> initial deploy and, via the upgrade authority, future upgrades. The repo's
> committed key, if any, is a throwaway localnet key — never reuse it for
> devnet/mainnet.

## 3. Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet (use a hardware/multisig-controlled deployer; double-check the cluster)
anchor deploy --provider.cluster mainnet
```

`anchor deploy` sets the deployer as the **upgrade authority** by default. See §7
to move it to a multisig immediately after.

Verify:

```bash
solana program show 8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2
```

Confirm the program ID, the deployed data length, and the **upgrade authority**.

## 4. Initialize (one-time, irreversible)

`initialize` creates the singleton `Config` PDA (`["config"]`). **It can only be
called once per deployment** and bakes in the admin (the signer), the collateral
mint, the fee, the dispute period, and the guardian. Choose these deliberately.

Parameters:

- `fee_bps` — taker fee in basis points, `<= 1000` (10%). E.g. `100` = 1%.
- `dispute_period` — seconds between an outcome proposal and finalization, in
  `[0, 2_592_000]` (≤ 30 days). This is the timelock that gives the guardian time
  to veto; do not set it to `0` in production.
- `guardian` — the key allowed to pause and `dispute_void`. **Use a multisig.**
- `collateral_mint` — the SPL mint for all markets (USDC in production). A
  Token-2022 mint is rejected here.
- `admin` (signer) — becomes `Config.admin`. **Use a multisig.**

Invoke via the SDK / a script. Conceptually:

```ts
await program.methods
  .initialize(feeBps, new BN(disputePeriodSecs), guardianPubkey)
  .accounts({ config, collateralMint, admin })
  .rpc();
```

Because this is irreversible, on mainnet do a **devnet dry run** of the full
sequence (initialize → create → seed → trade → resolve → redeem) first.

## 5. Create and seed a market

`create_market` is **permissionless**. Provide:

- `question` (≤ 200 bytes), `resolution_source` (≤ 80 bytes) — display strings.
- `close_time <= resolution_time`, with `now < resolution_time <= now + ~2y`.
  Trading halts at `close_time`; the outcome may be proposed at/after
  `resolution_time`.
- `resolver` — the key that will propose the outcome (non-default). **Use a
  multisig** for any market that custodies meaningful value.
- `resolver_kind` — must be `0` (`TRUSTED_KEY`); any other value reverts.

Then the **creator** seeds liquidity once:

```ts
// 1) create
await program.methods
  .createMarket(question, source, new BN(close), new BN(resolutionT), resolver, 0)
  .accounts({ /* config, market, yes_mint, no_mint, vault, collateral_mint, creator */ })
  .rpc();

// 2) seed (creator only, once) — mints `amount` YES + `amount` NO at 50/50
await program.methods
  .seedLiquidity(new BN(amount))
  .accounts({ /* config, market, yes_mint, no_mint, vault, pool_yes, pool_no, lp_collateral, lp */ })
  .rpc();
```

Market is now OPEN for `buy`/`sell` until `close_time`.

## 6. Operate

Trading, resolution cranking, fee sweeps, and incident response are covered in
[`OPERATIONS.md`](OPERATIONS.md). In short: resolver `propose_outcome` →
(dispute window) → anyone `finalize_outcome`; users `redeem`; LP `claim_pool`;
admin `collect_fees`.

## 7. Upgrade-authority custody (do this immediately)

After deploy, the deployer key is the upgrade authority and can replace the
entire program (the ultimate trust root — see `THREAT_MODEL.md`). Harden it:

1. **Move the upgrade authority to a Squads multisig** (recommended) right after
   the first successful deploy:

   ```bash
   solana program set-upgrade-authority \
     8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2 \
     --new-upgrade-authority <SQUADS_MULTISIG_PUBKEY>
   ```

   Thereafter, upgrades are proposed and executed through the multisig.

2. **Use multisigs for the on-chain roles too** — set `Config.admin` and
   `Config.guardian` (and each market's `resolver`) to multisig-controlled keys.
   Rotate admin via the two-step `set_admin` → `accept_admin`.

3. **Plan for immutability.** After an external audit and a period of stability,
   consider making the program immutable (remove the upgrade authority) or moving
   it under on-chain governance. Until then, keep the upgrade key in cold/multisig
   custody and document who can sign.

## 8. Pre-mainnet checklist

- [ ] Devnet dry run of the full lifecycle passed.
- [ ] `solana program show` confirms the expected program ID and upgrade
      authority.
- [ ] Upgrade authority moved to a multisig.
- [ ] `Config.admin` and `Config.guardian` are multisig-controlled.
- [ ] `dispute_period` set to a meaningful value (not `0`); `fee_bps` ≤ 1000.
- [ ] Collateral mint is the intended legacy-SPL mint (e.g. USDC).
- [ ] IDL re-vendored and in sync (`sdk/idl/`, `app/lib/idl/`).
- [ ] Monitoring/indexer wired to the events in [`REFERENCE.md`](REFERENCE.md).
- [ ] Reminder: **not audited** — see `SECURITY.md` / `THREAT_MODEL.md`.
