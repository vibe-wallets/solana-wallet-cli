# Command cookbook

The examples below use shell syntax for commands typed into the interactive
prompt unless a command starts with `sol-wallet`. Replace angle-bracket values
with real addresses. Do not paste a private key into shell history, a script,
or a command-line argument. For a tour of human output and its meaning, see
[Understanding CLI output](command-output.md).

## Common options

Startup options apply to one invocation:

```bash
sol-wallet --cluster devnet
sol-wallet --rpc-url https://example.invalid/rpc
sol-wallet --commitment finalized
sol-wallet -c "balance" --json
sol-wallet --verbose -c "balance"
```

Command options are parsed by the same command engine in the REPL and one-shot
mode:

```text
send <destination> 0.001 --dry-run
send <destination> 0.001 --yes
```

- `--dry-run` builds and simulates a write without broadcasting it.
- `--yes` skips the confirmation question only. Validation and simulation still
  happen.
- `--json` writes machine-readable output. Use it for scripts, not human
  reading.

## Wallet and public identity

```text
wallet import daily
wallet import savings --keypair-file /secure/path/id.json
wallet list
wallet info savings
wallet use savings
wallet default daily
wallet rename daily checking
wallet change-passphrase savings
status
address
```

Each import writes a separate UUID-named encrypted keystore. The alias in the
registry is a local label; always verify the full address shown in status and
transaction previews. `wallet use` changes only this process, while
`wallet default` changes the choice for future processes. A one-shot command can
choose explicitly with `sol-wallet --wallet savings -c "balance" --json`.
See [the multiple-wallet guide](multiple-wallets.md) for recovery and migration.

`wallet change-passphrase` privately asks for the current and replacement
passphrases; it changes only local encryption. `wallet delete` confirms the
alias and address before removing the active local keystore. Neither command
changes chain state. See the wallet guide before deleting a key: assets remain
at their Solana address, while separate backups are intentionally preserved.
To remove a non-default wallet interactively, run `wallet delete savings`; if
it is current, the shell becomes unselected afterward. Deleting the default
while another wallet remains requires setting a different default first.

`status` checks the selected network's RPC and shows the selected wallet's SOL
and non-zero token balances, plus separate native-stake and mainnet Jupiter
Lend position summaries. These positions are not added to liquid balances.
`show config` is the local configuration-only view. A failed RPC read is shown
as unavailable, not as a zero balance.

To experiment with a fully separate store, set another configuration directory:

```bash
SOL_WALLET_CONFIG_DIR=/tmp/sol-wallet-demo sol-wallet
```

`address` and `wallet info` are public-only. They do not ask for the
passphrase.

## Configuration

```text
show config
set cluster devnet
set commitment finalized
set rpc-url https://api.devnet.solana.com
```

Configuration precedence is:

```text
CLI flag > environment/.env > config.json > built-in default
```

`set` changes the current process only. Use `config.json`, environment
variables, or startup flags for repeatable configuration. Never put a private
key or passphrase in any of those locations.

## SOL

```text
balance
send <destination> 0.001 --dry-run
```

`balance` displays the human SOL amount. Exact lamports remain in JSON output
and are included in human output when the process is started with `--verbose`.
`send` requires enough SOL for the amount plus a network fee. Its preview and
success receipt show the selected wallet, destination, network, confirmation,
signature, and explorer link. Start with a small devnet dry-run.

For JSON automation:

```bash
sol-wallet -c "balance" --cluster devnet --json > balance.json
```

## SPL and Token-2022 tokens

Show token balances grouped by mint:

```text
token list
```

Use `token list --accounts` when you need each token account address. The
default view includes the full mint, token program, total balance, and account
count. Recognized symbols such as USDC are shown in a separate column; the full
mint address remains the identifier.

List the built-in symbols and the exact mint each one resolves to on the
current network:

```text
token symbols
```

Read one mint's balance. You can pass a mint address or a recognized symbol:

```text
token balance <mint-address>
token balance usdc
```

Send a token using its mint address or a recognized symbol and a
human-readable amount:

```text
token send <mint-address> <destination> 1.25 --dry-run
token send usdc <destination> 1.25 --dry-run
```

The amount uses the mint's on-chain decimals. The CLI refuses excess decimal
places and does not silently round. The sender supports basic checked
transfers. Token-2022 mints with extensions are intentionally refused until
their transfer semantics are modeled explicitly.

Symbols are local aliases for a fixed, cluster-scoped mint address. They are
never read from on-chain metadata, and `token symbols` shows the full address
they use. The preview and receipt always include that full mint, and its owning
program and decimals are verified on chain before a transfer. A symbol defined
only for another network fails closed instead of reusing the wrong mint.

## Validators and native staking

Inspect validator data before choosing one:

```text
validators --limit 20
validators --max-commission 8
validators --include-delinquent
```

Delinquent validators are hidden by default. Add `--include-delinquent` when
you want to include them in the results. The table shows full vote-account
addresses so they can be supplied to `stake create`.

Create and delegate a native stake account:

```text
stake create 1 --validator <vote-account> --dry-run
```

List stake accounts discovered for the wallet:

```text
stake list
```

The table includes activation state, account balance, delegated amount,
validator vote account, and stake-account address. An `unknown` state can refer
to a local recovery hint that the selected RPC did not return. Activation is
calculated from the stake account, current epoch, and StakeHistory data; it
does not rely on the removed `getStakeActivation` RPC method.

Request deactivation and later withdraw inactive stake:

```text
stake deactivate <stake-account> --dry-run
stake withdraw <stake-account> --dry-run
stake withdraw <stake-account> --amount 0.5 --dry-run
```

Deactivation is not instant. Wait for the relevant epoch transition and check
`stake list` before withdrawing. Native staking is different from liquid
staking: the wallet creates and controls a real Stake Program account.

## Jupiter Lend Earn

First check the canonical mainnet USDC position:

```text
jupiter-lend status
```

The command reports supplied assets, protocol liquidity, and the smaller
currently withdrawable amount. Human output emphasizes these user amounts;
receipt-share details and raw rate fields are available with `--verbose` or
`--json`. It requires `mainnet`; it is not a devnet demo.

Deposit after independently checking the amount and protocol:

```text
jupiter-lend deposit 1 --dry-run
```

Withdraw a specific amount:

```text
jupiter-lend withdraw 0.5 --dry-run
```

Withdraw the maximum currently available for the position:

```text
jupiter-lend withdraw --all --dry-run
```

When all supplied assets are available, `--all` redeems the exact receipt
shares. If protocol liquidity is constrained, it withdraws only the currently
available amount and leaves the rest supplied. No live mainnet lending write
has been performed by this repository's automated validation.

## Transaction inspection

```text
tx inspect <signature>
```

Use the signature printed after broadcast. Human output summarizes the result,
slot, fee, signers, instruction count, and explorer link. Add `--json` to see
the complete RPC transaction response. Run the inspection on the same cluster
where the transaction was submitted. If a confirmation timeout occurs, inspect
first and only retry after determining whether the transaction landed.

## Interactive shell conveniences

```text
help
help stake
token
stake
jupiter-lend
history
clear
exit
```

Typing a command group without a subcommand displays that group's available
commands and usage. This also works with the wallet, transaction, and show
groups. At startup, `sol-wallet --help` or `sol-wallet -h` lists process
options. The greeting does not fetch chain data; run `status` for a fresh
balance overview.

The shell stores up to 1,000 filtered commands. Lines containing common secret
words such as `private key`, `password`, or `passphrase` are not persisted.
Completion uses only cached public values and does not unlock the wallet or
make synchronous network requests.

## JSON scripting pattern

Use exit status and stderr, not only stdout, to decide whether a command
succeeded:

```bash
if result="$(sol-wallet -c "balance" --json 2>error.json)"; then
  printf '%s\n' "$result"
else
  cat error.json >&2
  exit 1
fi
```

Do not parse human output. JSON integers are strings, and a successful
transaction response includes the signature and confirmation status.
