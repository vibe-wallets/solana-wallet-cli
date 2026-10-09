# Understanding CLI output

This guide explains what the terminal shows, which actions contact Solana, and
how to tell a missing balance from a failed request.

## There is no login session

Starting `sol-wallet` selects a wallet using the saved default or an explicit
`--wallet <alias>`. This does not decrypt or unlock the private key. The shell
shows the selected alias, a shortened address, and the network. Startup stays
quick and does not make an RPC request. If no wallet is selected, it suggests
how to import or choose one. Type `status` when you want to refresh on-chain
data.

The passphrase is requested only when a command needs to sign a transaction.
Read-only commands use the public wallet address and never need the passphrase.

## `status`: wallet and balance overview

`status` checks that the configured RPC responds and belongs to the selected
network, then reads the selected wallet's SOL balance and SPL/Token-2022 token
accounts. It shows non-zero token balances grouped by mint, with the token
program and number of token accounts. Use `token list` for full mint addresses
and `token list --accounts` for individual token-account addresses.

The human-readable view is a dashboard: wallet/network identity first, liquid
SOL and token balances next, then non-liquid positions. Jupiter Lend shows
**In wallet**, **Supplied**, and **Withdrawable now** on separate labeled rows,
with USDC repeated on every amount, plus **Total APR** when rate data is valid.
This makes clear that supplied USDC is a position and not the same thing as
liquid wallet balance.

The output includes the wallet, saved default, network, sanitized RPC endpoint,
commitment, and refresh time. `MAINNET` is explicitly marked as real funds.
The “Default wallet keystore” field reports whether the saved default's local
keystore is healthy. A missing or invalid unrelated default appears as a
separate diagnostic and does not prevent status from reading a different
healthy wallet selected for this process.
`show config` remains the local configuration view and does not check RPC
health or fetch balances. Human TTY sessions show a short refresh notice while
the chain sections load; JSON output remains free of progress text.

The shell uses color only for interactive terminals; redirected output is
plain. Set `NO_COLOR=1` to opt out. Tables switch to labeled rows on narrow
terminals instead of truncating long account addresses. See [Reading the
terminal output](terminal-output.md) for color behavior, responsive tables,
and examples.

RPC health, balance sections, positions, and Jupiter rate data are reported
separately. For example, status can still show the wallet and network if an RPC
read fails. Such a value is marked **unavailable**, never reported as zero. A
`degraded` health result means the RPC was verified but at least one data
section or rate value could not be read or validated; balances that were read
successfully remain visible. `unavailable` means the endpoint could not be
verified for the selected network. `Updated` is the time this refresh
completed, not a promise that the chain state has not changed since then.

Status also summarizes native stake and, on mainnet, the selected wallet's
Jupiter Lend USDC position. These appear in a separate **Positions** section and
are never added to liquid SOL/token balances. On devnet, Jupiter Lend is marked
mainnet-only instead of being queried. Use `stake list` and `jupiter-lend
status` for full details; do not interpret staked or supplied assets as
immediately liquid. When rate data is valid, `jupiter-lend status` reports Base
APR, Rewards APR, Total APR, Estimated APY, and the rate timestamp alongside
position details. A deposit preview includes those same rate details and an
estimated annual yield in USDC for the proposed deposit. Otherwise, the
rate-derived fields and yield estimate are marked unavailable.

APR is the yearly rate before compounding; APY estimates a year of daily
compounding at the current total APR. Both the APY and the preview's annual
yield assume that rate remains unchanged for 365 days. Rates can change, and
the yield estimate excludes fees; it is not a record of past earnings. When a
rate is missing or invalid, rate-derived values are unavailable rather than
zero, while available balances remain visible. **Rates updated** shows when
the CLI read the rates used for that estimate.

## Wallet identity and ordinary reads

- `wallet list` marks current and saved-default wallets; `wallet info` shows a
  wallet's full public address. These are local metadata reads.
- `wallet change-passphrase <alias>` asks for the old passphrase and then the
  new one twice in hidden prompts. It keeps the address, current wallet, and
  saved default unchanged; backups are not updated.
- `wallet delete <alias>` shows the full address and defaults to a no answer.
  `--yes` is explicit consent for scripts. It removes the active local
  keystore, but does not transfer or delete on-chain assets. Deleting the
  current wallet leaves the shell with no wallet selected; other accounts are
  never selected implicitly.
- `address` prints the selected wallet address and network.
- `balance` shows the human SOL amount. Exact lamports are available in JSON,
  or in human output when the process is started with `--verbose`.
- `token list` aggregates balances for each mint. `--accounts` expands the
  output to show each account. A `SYMBOL` column labels mints found in the
  built-in registry; unknown mints show `—` and remain identified by address.
  `token balance <mint|symbol>` shows the mint, total, account count, and (with
  `--verbose`) raw integer amount. `token symbols` lists the built-in symbols
  and the exact mint each resolves to on the current network.
- `validators` is a table sorted by activated stake. It shows status,
  commission, stake, and the full vote-account address required by
  `stake create`.
- `stake list` shows state, total account balance, delegated amount, validator
  vote account, and stake-account address. An `unknown` state can identify a
  local recovery hint for an account the current RPC did not return.
- `jupiter-lend status` emphasizes wallet USDC, supplied assets, protocol
  liquidity, and the currently withdrawable amount. Raw receipt-token and rate
  fields are technical details available with `--verbose` or `--json`.
- `tx inspect <signature>` shows a human summary: result, slot, time, fee,
  signers, instruction count, and an explorer link. Add `--json` for the full
  RPC transaction response.

Token symbols are not guessed from arbitrary on-chain metadata. The only
symbols are the small, code-owned registry exposed by `token symbols`; each is
an alias for one exact, cluster-scoped mint address. An unrecognized symbol
errors instead of falling back to a guess, and a mint with no registry entry
keeps its full address as its identifier. The full mint is retained in previews,
receipts, `token list`, and JSON output.

## Transaction previews and receipts

Every write command validates and simulates before signing. The preview shows
the selected wallet, action, destination or target account, amount, estimated
network fee, and network. The confirmation question repeats the essential
action and network. On `mainnet`, read the full preview carefully before
answering `y`; an alias is only a local nickname.

After broadcast, the terminal briefly indicates that it is waiting for
confirmation (only in an interactive human terminal). A successful receipt
shows the wallet, network, confirmation level, slot, action details, full
signature, and a Solana Explorer link. If confirmation times out, the
transaction may still have landed: inspect the signature before retrying.
For `finalized`, the CLI allows up to about 60 seconds for the commitment to
arrive; `processed` and `confirmed` use a shorter window. This is a polling
limit, not a promise that an RPC will respond promptly. A timeout remains an
unknown outcome, so check the signature before submitting a replacement.

If `stake create` has an uncertain broadcast or confirmation result, the error
also prints the locally derived stake-account address. The CLI stores that
public recovery hint before broadcast when local storage is available, allowing
a later `stake list` to reconcile it with the chain.

`--dry-run` prints that the transaction was simulated and not broadcast.
`--yes` skips only the confirmation question; it does not skip validation,
simulation, or the passphrase prompt required to sign.
For `wallet delete`, `--yes` skips the local deletion confirmation only; it
does not authorize or perform any on-chain action.

## Help and scripting

Run `sol-wallet --help` (or `-h`) for startup flags. In the shell, `help` shows
commands and `help <topic>` shows a command group. Tab completion uses the
commands, flags, wallet aliases, token mints, validators, and stake accounts
already known to the current shell; it does not make background RPC calls. To
complete the value after `stake create ... --validator`, first run `validators`
so the current shell can cache vote-account addresses.

For scripts, use `-c "<command>" --json`. JSON is one compact document on
stdout; errors are JSON on stderr and return a non-zero exit status. In JSON
mode, the preflight needed for a human confirmation is written to stderr, so it
does not corrupt the final JSON document on stdout. Integer amounts are strings
to preserve exact values. `status` adds a `health` field (`healthy`,
`degraded`, or `unavailable`), an `rpc` result, per-section `balances` and
separate `positions`, and an `updatedAt` timestamp; a missing wallet has
`balances: null` and `positions: null`. On mainnet, the Jupiter section
includes current Total APR; `jupiter-lend status` and deposit preflight include
the detailed rate and estimate information described above. On devnet, the
Jupiter position is reported as not supported rather than queried.

`wallet import --json` remains interactive because importing requires address
verification, passphrase entry, and confirmation. The derived public address
is written to stderr before the prompt; only the final machine-readable result
is written to stdout. `tx inspect` accepts only a base58-encoded 64-byte
transaction signature and rejects malformed values before making an RPC call.

Interactive history is stored locally with restrictive file permissions.
Up recalls the most recent saved command first; additional presses move backward
through commands, and Down moves toward newer commands. This ordering also applies
after restarting the shell. Secret-looking input remains excluded.
Recognized commands retain public address, mint, and transaction-signature
arguments so they can be recalled; likely private-key encodings and commands
containing secret-bearing words are excluded. A 32-byte base58 string is
ambiguous by format alone, so never paste a raw seed/private key into a command
argument; enter wallet key material only at the hidden import prompt or through
the documented keypair-file flow. The history filter also excludes the
`wallet change-passphrase` command line because it contains a secret-related
word, even though that command never accepts a secret as an argument. As
previously accepted, an RPC URL supplied
to `set rpc-url` is echoed and the typed command may be retained in history;
avoid credentials in the URL when using interactive history, or clear history
with `clear`/`cls`.

Use `--verbose` as a startup option when you need technical raw amounts in
human output, for example `sol-wallet --verbose -c "balance"`.
