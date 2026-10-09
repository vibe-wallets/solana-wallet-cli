# Jupiter Lend Earn integration

This document describes the v0.2 Jupiter Lend scope and the operational boundary around it. It is intentionally narrower than a general lending client.

The CLI command prefix is `jupiter-lend` because it names this provider's
integration explicitly. A future multi-protocol lending router can use the
generic `lend` name without making it unclear which protocol handles a command.

## Supported surface

The wallet supports only these commands:

```text
jupiter-lend status
jupiter-lend deposit <amount>
jupiter-lend withdraw <amount>
jupiter-lend withdraw --all
```

The asset is hard-coded to canonical mainnet Solana USDC:

```text
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

All reads and transactions use the selected wallet. Switch with `wallet use
<alias>` in the shell or choose one for a one-shot command with
`sol-wallet --wallet <alias> -c "jupiter-lend status" --json`. Previews show
the alias and full signing address. See [the multiple-wallet guide](multiple-wallets.md)
for current/default behavior and backups.

Before every operation the adapter requires `mainnet`, verifies the mint is owned by the legacy SPL Token Program, and verifies six decimals. A display symbol or user-selected mint is never used as the asset identity. The canonical USDC mint constant is defined once in the shared token registry (`src/solana/known-tokens.ts`) and re-exported by the adapter; the protocol-specific checks remain in the adapter. Borrowing, collateral, leverage, liquidation, arbitrary assets, and arbitrary Jupiter transaction signing are not implemented.

## SDK boundary

The checked-in versions are `@jup-ag/lend@0.0.108` and `@jup-ag/lend-read@0.0.14`. The write package's current npm `latest` tag is a beta line, so v0.2 pins the latest non-prerelease SDK line rather than introducing a beta dependency. The write SDK supplies Earn `getDepositIx` and `getWithdrawIx`; the read SDK supplies the current position, receipt shares, protocol-reported rates, and the protocol's current withdrawable amount.

The SDK line uses legacy `@solana/web3.js` and `bn.js` types. Those imports are confined to `src/integrations/jupiter-lend/adapter.ts`. The adapter converts SDK `TransactionInstruction` objects into the wallet's `@solana/kit` instruction shape. The encrypted signer remains in the normal wallet command layer and is attached only at the signing boundary.

The adapter uses the official SDK's position/account derivation. The command layer may add an idempotent associated-token-account instruction for the Jupiter receipt token on deposit or the USDC destination on withdrawal. It does not hand-author Jupiter protocol instructions.

Before building a write, the command checks whether that destination token
account already exists. This lookup explicitly requests base64: an SPL token
account contains 165 bytes, while the Solana Kit legacy default is base58 and
cannot return account data larger than 129 bytes. This matters on repeat
deposits, because the receipt-token account was created by the first deposit.

The pinned non-prerelease SDK exposes the basic Earn deposit/withdraw/redeem builders used here, but does not export the newer slippage-bounded instruction helpers. v0.2 therefore records the limitation explicitly and relies on the common simulation, explicit confirmation, and blockhash-aware confirmation pipeline; a future SDK refresh should adopt protected variants when their stable API is available.

## Read behavior

`jupiter-lend status` does not unlock the keystore. It reports:

- wallet and canonical asset
- wallet USDC balance
- supplied position in underlying USDC
- protocol-reported currently withdrawable USDC
- receipt-token mint/account and shares
- when rate data is valid, base APR, rewards APR, total APR, estimated APY, and the timestamp for the rate snapshot

The adapter reports both the protocol's current liquidity limit and the user's supplied assets. `currentlyWithdrawable` is the smaller of those values and is authoritative for `jupiter-lend withdraw <amount>` validation and for `jupiter-lend withdraw --all`. The command never guesses a maximum from a receipt-token balance.

## APR, APY, and deposit estimate

APR is a yearly rate before compounding. The base APR is the current supply
rate, and the rewards APR is the current rewards rate; total APR is their sum.
APY expresses an estimated yearly return after compounding. For a beginner's
rule of thumb, APR is the stated rate before reinvesting returns, while APY
shows what repeated reinvestment could produce under its stated assumptions.

The estimate uses 365 daily compounding periods and assumes the current total
APR stays unchanged for the full year. Treat the APR as a fraction in the
formula (for example, 5.20% is 0.052):

```text
estimated APY = (1 + total APR / 365)^365 - 1
estimated annual yield = proposed deposit × estimated APY
```

For example, if base APR is 4.20% and rewards APR is 1.00%, total APR is 5.20%
and estimated APY is about 5.34%. On a proposed 1,000 USDC deposit, the
estimated annual yield is about 53.37 USDC. This is an illustrative example,
not a live quote. When rate data is valid, a deposit preview shows the same
base, rewards, and total APR; estimated APY; and `Rates updated` timestamp as
`jupiter-lend status`, plus the estimated annual yield for the proposed USDC
amount. The estimate excludes fees and is not a calculation of interest or
rewards already earned.

Rates can change after they are read, so the APY and deposit yield are estimates
based on the timestamped current rate snapshot, not a promise of future return.
`Rates updated` is when this CLI read the rates for that snapshot; it is not a
history of when the position earned interest or rewards.
The calculation uses the existing on-chain read data and adds no REST request,
API key, or dependency.

The pinned `@jup-ag/lend-read@0.0.14` code treats the two input scales
differently: `supplyRate` is in basis points (`420` means `4.20%`), while
`rewardsRate` is a percent scaled by `10^12` (`10^12` means `1.00%`). The wallet
normalizes each field separately with `bigint`, then derives APY with integer
fixed-point arithmetic. The online [Jupiter Read Earn Data guide](https://developers.jup.ag/docs/lend/earn/read-data)
and the [pinned SDK README](https://unpkg.com/@jup-ag/lend-read@0.0.14/README.md)
describe rate precision only generally; use the `@jup-ag/lend-read@0.0.14`
package implementation pinned by this repository as the authority for these
exact field scales.

If either rate is missing, malformed, or outside its supported range, rates,
APY, and the deposit yield are reported as unavailable. The CLI does not
substitute zero or calculate a partial total APR, and successfully read wallet
balances and positions remain available.

For scripts, `jupiter-lend status --json` adds a `yield` object; wallet
`status --json` puts the same object at `positions.jupiterLend.yield`.
The deposit preview and result use `preflight.yield` and
`preflight.estimatedAnnualYield`. The fields `baseAprPercent`,
`rewardsAprPercent`, `totalAprPercent`, and `estimatedApyPercent` are decimal
strings expressed as percentages: `"5.2"` means 5.2%, not a fraction of 5.2.
Exact APR values retain twelve fractional decimal places of precision; derived
APY is rounded to that precision. Human percentages are rounded to four
fractional places, with tiny positive values shown as `<0.0001%` rather than
zero. The USDC projection uses the unrounded calculation and floors to six
decimals; values below one USDC base unit say `<0.000001 USDC` in human output.

An available snapshot includes `status: "available"`, `compounding: "daily"`,
`daysPerYear: 365`, and `updatedAt`. An unavailable snapshot includes
`status: "unavailable"`, a reason, and its refresh timestamp, without invented
percentage fields. A genuine zero-rate snapshot remains available with zero
percentages. Wallet status becomes `degraded` if its Jupiter rates are invalid,
even when balances loaded successfully. The annual yield projection applies
only to the proposed deposit and does not deduct transaction fees.

## Write behavior

Deposit and withdrawal use the same wallet transaction safety sequence as SOL, token, and stake writes:

```text
canonical asset validation
  -> amount / position / balance validation
  -> official Jupiter instruction construction
  -> optional idempotent ATA creation
  -> blockhash and fee lookup
  -> human or JSON preflight
  -> simulation
  -> confirmation unless --yes/session yes
  -> encrypted signer unlock
  -> broadcast
  -> blockhash-aware confirmation
  -> best-effort position refresh
```

`--dry-run` simulates without broadcasting. `--yes` skips only the confirmation prompt; it does not skip validation or simulation. If protocol liquidity makes a requested withdrawal unavailable, the requested and currently withdrawable amounts are reported and no transaction is built.

`--all` means the maximum amount currently withdrawable for this wallet: the lower of the user's supplied assets and the protocol's available liquidity. When the full position is available, the adapter uses the official SDK's exact receipt-share redemption path so the position is not left with exchange-rate dust. If liquidity is temporarily constrained, it uses an asset withdrawal for the currently available amount and leaves the remaining position intact.

JSON mode writes one success document to stdout. Integer amounts are decimal strings, while errors go to stderr. A confirmed transaction remains a success even if the post-confirmation position refresh is temporarily unavailable; the output explicitly says when that refresh could not be completed.

## Dependency and security note

The legacy Jupiter SDK dependency tree introduces `@solana/web3.js`, Anchor, and other packages that are not used by the v0.1 wallet core. `npm audit --omit=dev` currently reports transitive advisories through this upstream SDK line, including advisories associated with `toml`, `uuid`, and the web3/Anchor graph. No safe automated upgrade was applied because the SDK pins and API compatibility must be reviewed together. The Docker build removes the upstream SDK's unused `unbuild`, `vitest`, Vite, Rollup, esbuild, and tsx toolchain from the runtime image. This is recorded as a release blocker for a future dependency refresh, not hidden by weakening audit output.

Keep positive-path yield tests deterministic and test the Devnet rejection
guard for this mainnet-only integration. Automated tests must never perform
Mainnet test writes. Any manual write smoke test must use a separately funded
disposable wallet and a deliberately tiny amount after independent code review.
