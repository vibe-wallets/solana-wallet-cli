# Architecture walkthrough

This document explains how the project is assembled. It is aimed at someone
who wants to read the TypeScript source or make a small safe change.

## The large picture

```text
CLI arguments
  -> configuration
  -> wallet registry (resolve UUID and alias once per command)
  -> command context (captured selected-wallet identity)
  -> REPL or one-shot command
  -> parser and dispatcher
  -> command handler
  -> Solana client / protocol adapter
  -> validation and preflight output
  -> simulation
  -> confirmation
  -> encrypted signer
  -> broadcast and confirmation polling
  -> human or JSON output
```

The wallet registry stores aliases and the saved default. Each
`wallets/<uuid>.json` stores one independently encrypted key. A command resolves
the current UUID and address before entering feature code. The signer receives
that exact keystore path and expected address; it never looks up a mutable
default or an alias while signing. Stake hints are stored under the UUID and
network, while balances and protocol positions remain on Solana.

The direction matters. Core wallet code knows how to validate, build, and sign
transactions, but it does not know Jupiter's legacy SDK types. The Jupiter
adapter knows those types, but it cannot unlock the keystore by itself.

## Source map

| Directory/file                         | Responsibility                                       | Beginner question it answers                         |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `src/cli.ts`                           | Startup flags, config, top-level error handling      | How does the process start?                          |
| `src/config/`                          | Cluster, RPC, commitment, and file configuration     | Which network and RPC are used?                      |
| `src/shell/parser.ts`                  | Tokenization, flags, positional arguments            | How does text become a command?                      |
| `src/shell/repl.ts`                    | Interactive and piped input                          | How does the prompt loop work?                       |
| `src/commands/execute.ts`              | Dispatch and command-specific flag validation        | Which handler runs?                                  |
| `src/commands/context.ts`              | Shared config, output, session, and client factories | What does a handler receive?                         |
| `src/commands/read-only.ts`            | Public address and chain reads                       | Which commands avoid signing?                        |
| `src/commands/send.ts`                 | SOL transaction lifecycle                            | How is a normal transfer built and sent?             |
| `src/commands/token-send.ts`           | Mint metadata, ATA, and token transfer               | How are fungible tokens sent?                        |
| `src/commands/staking.ts`              | Native Stake Program operations                      | How are stake accounts managed?                      |
| `src/commands/lending.ts`              | Jupiter command safety and common transaction path   | How does a protocol write reach the wallet pipeline? |
| `src/solana/amounts.ts`                | Decimal strings and integer base units               | Why is money a `bigint`?                             |
| `src/solana/rpc.ts`                    | RPC client creation and error conversion             | How are node failures reported?                      |
| `src/solana/tokens.ts`                 | Parsed SPL and Token-2022 accounts                   | What does `token list` read?                         |
| `src/solana/known-tokens.ts`           | Code-owned token symbol to cluster-scoped mint map   | Why is `usdc` a safe shortcut?                       |
| `src/wallet/keystore.ts`               | Key parsing, encryption, atomic persistence          | Where is key material handled?                       |
| `src/wallet/store.ts`                  | UUID keystores, public registry, and writer lock     | How are aliases mapped safely to keys?               |
| `src/wallet/signer.ts`                 | Lazy keystore unlock and transaction signing         | When can the private key be used?                    |
| `src/integrations/jupiter-lend/`       | Legacy SDK isolation and instruction conversion      | Where is Jupiter-specific code?                      |
| `src/integrations/stake-activation.ts` | Client-side stake activation calculation             | How does the CLI know cooldown has finished?         |
| `src/output/`                          | Human output, JSON conversion, redaction             | How are results and errors printed?                  |
| `test/unit/`                           | Offline deterministic tests                          | What can be tested without a network?                |
| `test/e2e/`                            | Docker/PTTY/mock-RPC tests                           | Does the packaged image behave correctly?            |

## A read-only command

Take `balance` as the simplest path:

1. `src/cli.ts` parses startup options and loads `AppConfig`.
2. `createCommandContext` creates output, session flags, and a lazy Solana
   client factory.
3. The REPL or `-c` mode sends text to `executeLine`.
4. `executeParsed` recognizes `balance` and calls `showBalance`.
5. `showBalance` reads the public wallet address from keystore metadata and
   requests the account balance through the RPC wrapper.
6. `Output.print` chooses human text or JSON. No signer is created, so no
   passphrase is requested.

This is a useful model: a read command should not accidentally cross into the
signer boundary.

## A normal SOL transfer

`send` illustrates the write boundary:

1. Parse the destination address and exact SOL amount.
2. Read the wallet's public balance and reject insufficient funds.
3. Create a transaction message with the wallet as fee payer and a fresh
   blockhash.
4. Print a preflight summary.
5. Compile the message and ask RPC to simulate it.
6. If `--dry-run`, stop here.
7. Otherwise ask for confirmation unless `--yes` was supplied.
8. The `EncryptedKeystoreSigner` unlocks and signs only now.
9. Broadcast the signed wire transaction.
10. Poll signature status until confirmation or a known expiry/timeout.

The same shape is reused for token, stake, and Jupiter writes. Reuse is a
safety feature: simulation, confirmation, and confirmation polling should not
drift between command types.

## The signer boundary

`src/wallet/signer.ts` deliberately exposes a transaction-signing interface,
not a `getPrivateKey()` method. The signer:

1. asks the prompt for the passphrase;
2. decrypts and validates the keystore;
3. creates a temporary Solana signer;
4. signs the transaction message;
5. wipes the mutable secret buffer in a `finally` block.

The private key should not appear in command arguments, output objects, RPC
requests, test logs, or history. If a new feature needs signing, route it
through this interface instead of adding a key-export helper.

## The Jupiter boundary

Jupiter's stable SDK line used by v0.2 depends on legacy `@solana/web3.js`
types. The rest of the wallet uses `@solana/kit`. The adapter is the deliberate
translation layer:

```text
command handler (Kit address + bigint)
  -> Jupiter adapter (PublicKey + BN)
  -> official Jupiter instruction
  -> Kit WalletInstruction
  -> common transaction pipeline
```

The adapter also enforces the protocol scope: mainnet only, canonical USDC,
legacy SPL Token Program, six decimals, and the minimum of user-supplied assets
and protocol-reported liquidity. Do not move those checks into a generic
command helper where another asset could bypass them.

The `stake-activation` integration calculates stake activation locally from
the account, current epoch, and StakeHistory sysvar, using Anza's client-side
implementation. It does not call Agave's removed `getStakeActivation` RPC or
infer that a stake is fully inactive merely because its deactivation epoch has
passed. Errors fetching or decoding the required inputs still block
safety-critical stake actions rather than falling back to an epoch guess.

## Configuration flow

`loadConfig` creates the config directory, reads optional `config.json`, reads
environment values, validates them, and applies this precedence:

```text
explicit CLI override
  > environment / .env
  > config.json
  > built-in default
```

Cluster switching has a guard: if the user explicitly pinned an RPC URL, the
CLI refuses to silently replace it when changing clusters. This avoids the
dangerous situation where the prompt says “devnet” while an unexpected custom
RPC is still in use.

## Output and errors

Handlers throw typed `AppError` subclasses. The top-level CLI converts unknown
exceptions into a safe generic error. `Output.error` writes JSON to stderr in
JSON mode and redacts fields whose names look secret-like in verbose details.

Exit codes are intentionally separate from output formatting:

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 1    | Local/runtime/keystore failure               |
| 2    | Invalid command, input, or user cancellation |
| 3    | RPC or network failure                       |
| 4    | Simulation failure                           |
| 5    | Confirmation failure or timeout              |

## How to change the project safely

For a new command:

1. Add parsing/help/completion entries.
2. Keep input conversion and validation near the handler.
3. Reuse the common transaction lifecycle for writes.
4. Keep private key access inside `EncryptedKeystoreSigner`.
5. Add offline unit tests for exact amounts, invalid inputs, and safety gates.
6. Add Docker E2E coverage when the behavior depends on the packaged runtime,
   TTY, filesystem permissions, or mock RPC.
7. Update the relevant guide in `docs/` and run formatting.

For protocol integrations, first define the protocol scope and identity checks,
then isolate SDK-specific types under `src/integrations/`. Do not let an SDK
dependency determine the architecture of the rest of the wallet.
