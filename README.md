# Solana Wallet CLI

`sol-wallet` is a small, Solana-only command-line wallet for personal use. It keeps multiple imported Solana private keys encrypted locally under named aliases, supports read-only SOL and SPL/Token-2022 queries, SOL/token transfers, native staking, transaction inspection, Jupiter Lend Earn USDC operations, and an interactive shell.

The published v0.2 release artifact is a `linux/amd64` Docker image. This checkout adds the next phase's multiple-wallet support; it has not been published as a new image yet. Jupiter Lend remains limited to canonical mainnet USDC Earn deposits, withdrawals, and withdrawal of the maximum currently available for the selected wallet. Borrowing, seed phrases, swaps, hardware wallets, dApps, and arbitrary transaction signing remain out of scope.

## Release image

```bash
docker pull ghcr.io/vibe-wallets/sol-wallet:latest
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$HOME/.config/sol-wallet:/home/solwallet/.config/sol-wallet" \
  ghcr.io/vibe-wallets/sol-wallet:latest
```

The image defaults to the non-root `solwallet` user (UID/GID `10001`). The direct example maps the caller's UID/GID so a host directory with mode `0700` remains writable; the wrapper does this automatically. The only persistent mount is the host directory above. It contains public configuration and metadata plus one encrypted UUID-named keystore per wallet; the disposable container does not own the wallet state.

The optional wrapper provides normal CLI-like usage:

```bash
scripts/sol-wallet
scripts/sol-wallet -c "balance" --json
```

Run `sol-wallet --help` for startup options. At interactive startup the CLI
shows the selected wallet and network without contacting the RPC; use `status`
for an on-demand network check, SOL/token balances, and separate staking/lending
position summaries. The wallet is not unlocked at startup—signing commands
request its passphrase when needed.

The wrapper defaults to `ghcr.io/vibe-wallets/sol-wallet:master`, which follows
the latest image published from the `master` branch. Set `SOL_WALLET_IMAGE` to
use a fork, a version tag, or a specific seven-character commit tag. Set
`SOL_WALLET_CONFIG_DIR` to override the wallet state directory.
Each wrapper run pulls its selected image tag before starting Docker. If the
pull fails, the wrapper stops instead of running an older cached image.

The workflow also publishes `latest`, the branch name (`master` or `main`),
and the bare seven-character commit hash (for example `36f2cc6`) for branch
pushes. Version pushes additionally publish their version tags.

## Local development

```bash
npm ci --legacy-peer-deps
npm test
npm run build
npm run format:check
npm run dev
```

The repository includes a `.npmrc` policy for npm dependency resolution and
updates. `npm ci` installs the exact versions in the lockfile, so the seven-day
policy does not independently establish the age of those pinned releases. See
[docs/supply-chain.md](docs/supply-chain.md) for the exact scope and update
procedure.

The code was tested with these exact dependency versions in the current lockfile: `@jup-ag/lend 0.0.108`, `@jup-ag/lend-read 0.0.14`, `@solana/kit 8.3.0`, `@solana/sysvars 8.3.0`, `@solana-program/system 0.14.1`, `@solana-program/stake 0.9.1`, `@solana-program/token 0.16.1`, `@solana-program/token-2022 0.17.0`, Node `>=24`, TypeScript `7.0.2`, Vitest `5.0.0`, Vite `8.3.0`, and Prettier `3.6.2`.

## First use

Start the shell and import a base58 key through a hidden prompt:

```text
wallet import daily
wallet list
wallet use daily
wallet default daily
status
address
balance
```

A Solana CLI JSON keypair can be imported as an input file:

```text
wallet import savings --keypair-file /path/to/id.json
```

The keypair file is never modified or deleted. Private keys and keystore passwords are deliberately not accepted as CLI arguments or environment variables.

## Commands

```text
help
wallet info daily
address
balance
token list
token list --accounts
token symbols
token balance <mint|symbol>
token send <mint|symbol> <destination> <amount>
send <destination> <amount>
validators --limit 20
stake create <amount> --validator <vote-account>
stake list
stake deactivate <stake-account>
stake withdraw <stake-account> [--amount <amount>]
tx inspect <signature>
jupiter-lend status
jupiter-lend deposit <amount>
jupiter-lend withdraw <amount>
jupiter-lend withdraw --all
```

Every write command supports `--dry-run`, and confirmation can be skipped with `--yes` after validation and simulation still succeed. Automation uses the same parser and handlers as the shell:

```bash
sol-wallet -c "balance" --json
sol-wallet -c "stake list" --cluster devnet --json
sol-wallet -c "jupiter-lend status" --json
```

The default cluster is `mainnet`; use `--cluster devnet`, `SOL_WALLET_CLUSTER=devnet`, or `set cluster devnet` for a session change. The default production RPC is `https://api.mainnet.solana.com`. The current cluster is shown in prompts and write summaries, and network commands verify the RPC endpoint's genesis hash before using chain data or signing. See [the mainnet setup guide](docs/mainnet-migration.md) if you have existing configuration.

The provider-specific `jupiter-lend` command name keeps this Jupiter integration distinct and leaves the generic `lend` name available if additional protocols are added later. Jupiter Lend commands require `mainnet` and verify the canonical Solana USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) is owned by the legacy SPL Token Program with six decimals. The command boundary uses Jupiter's official Earn SDK adapter; its legacy web3 types are isolated under `src/integrations/jupiter-lend/`.

Token commands accept a small, code-owned set of symbols (`usdc`, `usdt`) in place of a mint address; run `token symbols` to list the mints they resolve to for the current network. A symbol is a local alias for one exact, cluster-scoped mint, never an on-chain display symbol. The full mint is shown in previews and receipts, and its owning program and decimals are verified on chain before a transfer.

## Configuration and files

Configuration precedence is CLI flag, environment/`.env`, `config.json`, then built-in defaults. Supported settings are `SOL_WALLET_CLUSTER`, `SOL_WALLET_RPC_URL`, `SOL_WALLET_COMMITMENT`, and `SOL_WALLET_CONFIG_DIR`. Never put key material or passwords in `.env`.

The CLI loads `.env` from its current working directory. The `scripts/sol-wallet`
wrapper runs the CLI inside the image and mounts only the wallet configuration
directory, so it does not read a host `.env` file. To configure the wrapper,
export the supported network settings in the host shell; the wrapper forwards
them to the container when set:

```bash
export SOL_WALLET_CLUSTER=devnet
export SOL_WALLET_RPC_URL=https://api.devnet.solana.com
export SOL_WALLET_COMMITMENT=confirmed
scripts/sol-wallet
```

`SOL_WALLET_CONFIG_DIR` selects the host directory mounted at the container's
wallet configuration path; it is not passed through as a container environment
setting.

The default directory is `~/.config/sol-wallet`:

```text
config.json                    0600  non-secret network preferences
wallets.json                   0600  aliases and saved default
wallets/<uuid>.json            0600  one Argon2id/AES-GCM encrypted key
stake-accounts/<uuid>/<net>.json 0600  wallet/network-scoped stake hints
history                        0600  filtered shell history
```

SOL and token amounts are parsed as strings into `bigint`; no monetary calculation uses floating point. JSON output represents integer monetary values as decimal strings.

## Security limits

This is personal wallet software. Keep an independent secure backup of the original private key. Losing the keystore passphrase can make the local encrypted key unusable. JavaScript cannot guarantee perfect in-memory zeroization; the implementation uses mutable buffers, minimizes key lifetime, and wipes buffers where practical. RPC providers can observe addresses and network requests. Native staking is not liquid staking, and deactivation is epoch-based rather than immediately withdrawable.

The wallet never sends private keys, passphrases, or decrypted keystore bytes to RPC. It does not use telemetry, arbitrary transaction signing, shell evaluation, or automatic validator selection.

## Tests

Unit tests are offline:

```bash
npm test
```

Opt-in Solana integration tests use `RUN_SOLANA_INTEGRATION=1` and must never use a real developer wallet. Docker E2E tests exercise the built image through a PTY and deterministic mock RPC; set `SOL_WALLET_E2E_IMAGE` to the image under test.

Beginner-friendly documentation is indexed in [docs/README.md](docs/README.md). Start with [docs/getting-started.md](docs/getting-started.md), then read [docs/web3-concepts.md](docs/web3-concepts.md), [docs/command-cookbook.md](docs/command-cookbook.md), [Understanding CLI output](docs/command-output.md), and the [multiple-wallet guide](docs/multiple-wallets.md). The deeper references are [docs/architecture.md](docs/architecture.md), [docs/security-and-testing.md](docs/security-and-testing.md), [docs/implementation.md](docs/implementation.md), and [docs/jupiter-lend.md](docs/jupiter-lend.md).
