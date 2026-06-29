# Security Policy

Compute is an on-chain prediction-market protocol that custodies user collateral.
We take security seriously and welcome coordinated disclosure of vulnerabilities.

> **Status:** This is an unaudited MVP. It has **not** undergone an external
> security audit and should not be used with real funds on mainnet. See
> [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the trust model and known
> limitations.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **security@&lt;your-domain&gt;** with:

- A description of the vulnerability and its impact.
- Step-by-step reproduction (a failing test, transaction, or PoC is ideal).
- The affected component and, where possible, file/line references.
- Any suggested remediation.

If you need to send sensitive material, request our PGP key in your first
message and we will provide one for encrypted follow-up.

You will receive an acknowledgement that we have received your report; please
allow us a reasonable window to investigate and remediate before any public
disclosure. We will coordinate a disclosure timeline with you and credit you in
the release notes unless you prefer to remain anonymous.

### Response expectations

| Stage | Target |
|---|---|
| Acknowledge receipt | within **3 business days** |
| Triage + initial severity assessment | within **7 business days** |
| Status updates | at least every **7 days** until resolved |
| Fix / mitigation for valid Critical/High findings | as fast as practicable; coordinated disclosure thereafter |

## Scope

**In scope**

- The on-chain Anchor program: `programs/compute-markets/` (instruction logic,
  account validation, the FPMM math in `math.rs`, settlement state machine,
  privilege checks, conservation/solvency).
- The TypeScript SDK that constructs transactions: `sdk/`.
- The web app insofar as it can cause loss of user funds or sign harmful
  transactions: `app/`.
- The vendored IDLs under `sdk/idl/` and `app/lib/idl/` (drift from the
  authoritative `target/idl/` is a correctness concern).

**Out of scope**

- The trusted-resolver model itself. The single `resolver` key is a **known,
  documented** trust assumption of the MVP (see `docs/THREAT_MODEL.md`), defended
  in depth by a dispute window, a guardian veto, and a liveness escape hatch — not
  a vulnerability. A flaw in those *defenses* (e.g. a way to finalize before the
  dispute window elapses, or to drain the vault despite a void) **is** in scope.
- Loss of funds caused by a private key compromise on the user's side (wallet,
  admin, guardian, resolver, or upgrade-authority keys).
- Denial of service that requires control of the Solana validator set, or
  generic network-level / RPC-provider issues.
- Third-party dependencies, except where a specific reachable exploit path
  through this codebase is demonstrated.
- Economic/market-design observations that do not constitute a protocol-level
  loss-of-funds or invariant violation (e.g. ordinary AMM slippage or LVR).

## Severity guidance

We prioritize, in order: (1) anything that breaks the **conservation invariant**
`vault == market.collateral + market.fee_accrued`, lets funds be withdrawn that
are not owed, or permanently strands collateral; (2) bypasses of the settlement
defenses (timelock, guardian veto, void path); (3) privilege-escalation or
authorization bypass; (4) griefing / liveness; (5) informational.

## Safe harbor

We will not pursue or support legal action against, and we consider authorized,
good-faith security research that:

- Makes a good-faith effort to avoid privacy violations, data destruction, and
  interruption or degradation of the service.
- Only interacts with accounts you own or have explicit permission to test, and
  uses **test/devnet** environments and **test funds** wherever possible.
- Does not exploit a finding beyond the minimum necessary to demonstrate it, and
  does not exfiltrate, retain, or destroy user funds or data.
- Reports the issue promptly and privately via the channel above, and gives us a
  reasonable opportunity to remediate before public disclosure.

If in doubt about whether an action is authorized, contact us first at the email
above and we will work with you. This safe harbor applies to your conduct toward
us; it does not waive third parties' rights.
