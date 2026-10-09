# Reading the terminal output

`sol-wallet` has two output audiences: people reading a terminal and programs
reading JSON. The human view is arranged for quick scanning; the JSON view stays
machine-readable and keeps its existing field names and types.

## Terminal colors and accessibility

When human output is sent to an interactive terminal, `sol-wallet` uses
restrained color to distinguish section titles, wallet identity, network,
success, warning, and error text. Color reinforces the wording; it is never the
only indication that a network is mainnet or that an operation succeeded.
Mainnet is labeled `MAINNET · REAL FUNDS` in plain text even when color is
unavailable.

Color is automatically disabled when output is redirected, when `TERM=dumb`, or
when the `NO_COLOR` environment variable is set. For example:

```sh
NO_COLOR=1 sol-wallet
NO_COLOR=1 sol-wallet -c "status"
```

The command text you type is not syntax-highlighted. This keeps readline's
editing and cursor behavior predictable; it does not affect tab completion.

## Status is a dashboard

`status` starts with the selected wallet and network, then shows liquid balances
before assets that are not immediately liquid. Token balances are kept separate
from native stake and Jupiter Lend. On mainnet, the Jupiter section gives the
three amounts that are easy to confuse:

```text
POSITIONS · NOT LIQUID
JUPITER LEND · USDC
In wallet        : 4.724827 USDC
Supplied         : 1200.238561 USDC
Withdrawable now : 1200.238561 USDC
```

- **In wallet** is USDC held directly by the wallet.
- **Supplied** is the value reported by Jupiter as supplied to its lending
  product. It is a position, not liquid wallet balance.
- **Withdrawable now** is the amount the protocol currently allows the wallet
  to withdraw. It can be lower than the supplied amount when liquidity is
  constrained.

Native stake is shown separately because stake activation and deactivation
follow Solana epoch rules. Do not add these positions to the liquid SOL or token
balance when deciding what can be sent immediately. If an RPC or protocol read
fails, the affected field says **unavailable**; the CLI never turns a failed
read into a zero balance.

## Tables and narrow terminals

Tables use aligned columns when their contents fit the terminal. On a narrow
terminal, a table changes to labeled rows instead of clipping long values.
This is especially useful for vote-account and stake-account addresses: the
complete value remains visible and copyable. The `status` token-mint column is
shortened by default to make the token easier to recognize; use `token list` or
JSON when you need exact mint/account identifiers. Token tables include a
`SYMBOL` column that labels mints found in the built-in registry; an unknown
mint shows `—` and is still identified by its full address. `token symbols`
prints the built-in aliases as a table with their canonical mints.
`--verbose` expands technical fields where supported.

Section headings, labels, and aligned columns are shared across wallet details,
balances, validator/stake tables, transaction previews, and transaction
receipts. A transaction preview keeps the amount, destination/account, expected
fees, and network together before the shell asks you to confirm. A confirmed
receipt keeps the full signature and Explorer URL available for copying.

## Prompt and commands

The prompt repeats the active cluster, wallet alias, and shortened address so
you can verify the selected identity before typing a command. `MAINNET` is
visually distinct, and `NO_COLOR=1` leaves the same identity readable without
ANSI escape sequences. Startup shows the same selected-wallet/network context;
it does not unlock the key or send an RPC request.

`help` is a compact command index grouped by task. Run `help wallet`, `help
status`, `help token`, `help stake`, or `help jupiter-lend` for the more detailed
syntax and command-specific notes. Use tab completion to discover command and
argument choices as you type.

## JSON and redirected output

Add `--json` to a one-shot command when another program needs the result. JSON
is not decorated with ANSI color and stdout contains one JSON document. For
commands that need confirmation, the preview is JSON on stderr, not stdout, so
scripts can parse the final stdout response reliably. Errors in JSON mode also
remain JSON on stderr. See [Understanding CLI output](command-output.md) for
field semantics and [the command cookbook](command-cookbook.md) for examples.
