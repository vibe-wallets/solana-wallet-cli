# Implementation and operations guide

This document records the original v0.1/v0.2 implementation and dependency bootstrap. The current v0.3 multi-wallet design and recovery contract are described in [multiple-wallets.md](multiple-wallets.md) and the specifications under `specs/`. For a first introduction, use the [documentation map](README.md) and [getting-started guide](getting-started.md) first.

## Status

The published v0.2 baseline was implemented as a strict ESM TypeScript CLI. It included:

- a single encrypted local keystore with address-only public reads
- hidden import/passphrase prompts and Solana CLI JSON keypair input
- Argon2id key derivation with 64 MiB memory, three iterations, one lane
- AES-256-GCM with random salt and nonce, authenticated public metadata, atomic `0600` writes
- shared command parser for REPL and `-c` mode, quotes, `--flag=value`, flags, aliases, help, history, and contextual completion
- cluster/RPC/commitment configuration precedence and session changes
- current Solana `mainnet` naming and default RPC
- SOL and SPL/Token-2022 read commands
- SOL and basic token transfer builders with exact amounts, simulation, confirmation, broadcast, and confirmation polling
- native Stake Program create/delegate, list, deactivate, and withdraw command paths
- explicit positional Stake Program sysvar accounts, epoch-aware stake state, and atomic stake-registry updates
- isolated Jupiter Lend Earn USDC status, deposit, withdraw, and withdraw-all commands
- canonical mainnet USDC verification, official SDK instruction adaptation, protocol-reported withdrawability, and common transaction safety
- typed application errors and documented exit-code categories

The current checkout extends that baseline with multiple UUID-named encrypted
keystores, an alias/default registry, session selection, wallet-aware signing
and transaction output, migration/recovery, and wallet/network-scoped stake
metadata. This v0.3 work is not part of the published v0.2 image.

Jupiter Borrow, collateral positions, arbitrary lending assets, leverage, liquidations, and arbitrary Jupiter transaction signing remain out of scope.

## Dependency bootstrap record

The initial `npm install` exposed two environment details:

1. The registry available to this workspace applied an effective package-time cutoff around 2026-09-12 20:57 UTC. The registry could show newer versions through `npm view`, but installation rejected packages published after the cutoff with `ETARGET`, including `@solana-program/token-2022@0.18.0`, `@types/node@26.6.2`, `dotenv@18.0.1`, and `vitest@5.0.1`.
2. Two first-attempt `npm install` processes became orphaned and consumed CPU without creating `node_modules`. They were stopped by PID after verifying they were both this repository's install commands.

The retry used exact stable versions published before the cutoff and `--legacy-peer-deps`; it completed successfully. Vitest then reported that its Vite peer was absent, so the exact stable `vite@8.3.0` package was added explicitly. The committed lockfile is the source of truth; normal builds use `npm ci` and do not need the troubleshooting command again. The repository commits `.npmrc` with a seven-day npm release-age setting. The workflow and Docker build check the configured value, while `npm ci` reproduces the locked package versions; neither check audits each locked release's age. See [supply-chain.md](supply-chain.md) for the corrected scope. This incident does not affect wallet runtime behavior.

The installed core stack is `@solana/kit@8.3.0`, `@solana/sysvars@8.3.0`, `@solana-program/system@0.14.1`, `@solana-program/stake@0.9.1`, `@solana-program/token@0.16.1`, and `@solana-program/token-2022@0.17.0`. The v0.2 adapter uses `@jup-ag/lend@0.0.108`, `@jup-ag/lend-read@0.0.14`, and `bn.js`; Jupiter-specific legacy types remain under `src/integrations/jupiter-lend/`. Stake activation is calculated client-side by Anza's exactly pinned `@anza-xyz/solana-rpc-get-stake-activation@1.0.1` package using standard epoch, stake-account, and StakeHistory account RPC reads. It does not call the removed `getStakeActivation` RPC method. The core wallet and transaction pipeline remain on Kit.

## Source layout

`src/cli.ts` parses startup flags (including `--help`) and chooses one-shot or REPL execution. `src/shell/` owns tokenization, command completion, history filtering, help, hidden prompts, and readline. `src/commands/` contains user-facing handlers. `src/config/` handles precedence and permissions. `src/wallet/` is the only layer that reads or decrypts key material. `src/solana/` contains Kit RPC access, exact amounts, token decoding, validators, and transaction helpers. `src/integrations/jupiter-lend/` isolates Jupiter's legacy SDK types. `src/integrations/stake-activation.ts` isolates Anza's client-side activation calculation. `src/output/` separates human output, JSON, and transaction receipts.

The command flow is:

```text
readline or -c text
  -> shell parser
  -> command handler
  -> validated Kit RPC/application data
  -> preflight summary
  -> simulation
  -> confirmation
  -> encrypted signer unlock
  -> broadcast and blockhash-aware status polling
```

Read-only address, balance, token, validator, and stake-list commands use the public keystore metadata and never invoke the signer. The `EncryptedKeystoreSigner` decrypts only from its `signTransactions` boundary; transaction handlers cannot call a `getPrivateKey()` method.

`jupiter-lend status` follows the same read-only rule. It uses `@jup-ag/lend-read` with the public wallet address and reports supplied and withdrawable amounts in human output. Receipt-share and raw rate fields remain available through `--verbose` or JSON. Jupiter Lend writes use `@jup-ag/lend` only to construct explicit Earn instructions, then convert them into the common Kit message and signer pipeline. Before network reads or writes, the configured RPC endpoint's genesis hash must match the selected mainnet or devnet cluster.

The `status` dashboard is an explicit refresh; shell startup does not contact
RPC. It checks the endpoint's genesis hash, then reads SOL, token, native-stake,
and (on mainnet) Jupiter Lend USDC data independently. Its JSON reports each
section as available or unavailable and marks partial reads as `degraded`; it
never substitutes zero for an RPC error. Liquid balances and positions remain
separate, and Jupiter is explicitly marked mainnet-only on devnet. Human TTY
sessions get a refresh notice; it is omitted from JSON. Human tables aggregate
tokens by mint while `token list --accounts` preserves account-level detail.
Write receipts include the confirmed slot, signature, and a cluster-appropriate
explorer link. TTY-only confirmation progress is written to stderr and is
disabled for JSON output.

## Keystore format and recovery behavior

Each `wallets/<uuid>.json` contains only version, kind, public address, Argon2id parameters/salt, AES-GCM nonce/tag, and ciphertext. The passphrase is never stored. AAD is a deterministic JSON representation of public metadata; changing the public address or KDF/cipher metadata makes GCM authentication fail. `wallets.json` contains UUIDs, aliases, public addresses, timestamps, and the saved default, but no encrypted or plaintext key material. The root `keystore.json` is consulted only by explicit `wallet migrate <alias>`.

Imports create a unique file with create-only permissions and publish it under a UUID using a hard link, so import can never overwrite a preexisting key. Passphrase rotation is a distinct, explicit replacement path: it verifies the old passphrase and the re-encrypted key, stages a private replacement file, then checks under the wallet-store lock that the registry identity and exact original bytes have not changed before atomically renaming the replacement into place. Prompts and Argon2 work happen outside the lock. If directory syncing fails after rename, the command reports that the new passphrase may already be active and tells the user to inspect before retrying. Registry updates use a store lock and atomic replacement. Import verifies a decrypt-and-derive round trip before publication. If publication leaves a UUID keystore without registry metadata, recover it with `wallet recover <uuid> <alias>`; never delete it automatically. The full storage and selection contract is documented in [the implementation specification](../specs/spec.md#part-iii-multiple-wallet-implementation-contract).

`wallet delete` is also serialized by the store lock. It commits registry removal before unlinking the UUID keystore, so an interrupted deletion leaves a visible orphan rather than a registered wallet with a missing key. The saved default must be changed first if other wallets remain; deleting the current wallet clears that process's selection. Deletion does not make an RPC call, alter on-chain balances or positions, or remove separate migration backups and stake-recovery hints.

The accepted key inputs are base58 32-byte seeds or 64-byte Solana expanded keypairs, plus JSON byte arrays from a Solana CLI keypair file. Mutable decoded key buffers are filled after use. JavaScript GC/CryptoKey lifetime limitations remain documented in the README.

Argon2id settings are checked before key derivation: memory is 8–256 MiB,
iterations are 1–10, and parallelism is 1–4. New files use 64 MiB, three
iterations, and one lane. These limits bound work requested by damaged keystore
metadata before AES-GCM can authenticate it.

## RPC and amount rules

All RPC clients are created from the session config and use the configured commitment. RPC data is treated as untrusted and application-specific token/stake shapes are checked before use. Monetary values stay in `bigint`: SOL uses nine decimals and token amounts use the mint's on-chain decimals. Scientific notation, negative values, leading-zero forms, excess precision, and silent rounding are rejected.

Before signing, transaction commands check block height again after passphrase
entry. If the prepared blockhash expired while the user reviewed the preview or
entered the passphrase, the CLI aborts without signing or submitting. After
signing, it derives the transaction signature locally and verifies the RPC's
response. If that response is lost or differs, the CLI reports the local
signature and warns that the transaction may have been accepted; inspect it
before retrying. During confirmation, blockhash expiry is reported only after a
second status lookup finds no inclusion. An included transaction remains
pending until the requested confirmation level or a signature-bearing timeout.

Token reads query both the legacy Token Program and Token-2022. Basic Token-2022 transfers use the checked instruction, but mints with extensions are refused because the transfer semantics need explicit support. No third-party token-list metadata is used. Token commands also accept a small code-owned symbol registry (`src/solana/known-tokens.ts`): `usdc` and `usdt` map to exact, cluster-scoped mints, with the devnet USDC mapping marked test-only. A symbol is resolved locally and then treated as a mint address; the owning program and decimals are still verified against chain data, and a mismatch aborts the transfer. The registry is the single source of the canonical mainnet USDC identity shared with the Jupiter adapter.

Native staking uses the official generated System and Stake clients. The stake create path is `CreateAccountWithSeed`, `Initialize`, and `DelegateStake`, with the wallet as both authorities and a blockhash-derived seed bounded to System Program seed length. Required Rent, Clock, StakeHistory, and StakeConfig accounts are inserted explicitly because the pinned generated Stake package does not model all builtin positional sysvars. Rent and minimum delegation are queried dynamically. Stake discovery makes two server-side `getProgramAccounts` queries, one for staker and one for withdrawer, rather than downloading and filtering all stake accounts locally. Activation state is calculated by Anza's client-side extension from standard epoch, stake-account, and StakeHistory reads; this replaces the removed `getStakeActivation` RPC. The CLI does not equate a passed deactivation epoch with complete cooldown. A future lockup is checked against chain time and epoch, with the custodian authority honored.

The Stake Program's `jsonParsed` delegation uses the field `voter` for the
validator vote-account address. `stake list` and deactivation previews read
that exact RPC field; tests use the real parsed response shape.

If a locally registered stake address is absent from program-account discovery,
the CLI checks it directly. It removes that local recovery hint only after a
successful account lookup confirms the account is closed. RPC failures retain
the hint for later recovery.

## History and completion safety

History is capped at 1,000 persisted entries, stored mode `0600`, and rejects lines containing private-key, secret-key, seed-phrase, mnemonic, password, or passphrase terms. Completion is memory-only public metadata: cached mints, known stake accounts, and recently inspected validator vote accounts. It never performs a network request synchronously, unlocks the keystore, signs, or broadcasts. Unknown command flags are rejected instead of being silently ignored.

## Validation record

Run from the repository root:

```bash
npm test
npm run build
npm run format:check
```

The current offline suite covers exact decimal parsing, large bigint amounts, parser quoting and flags, command completion, history filtering, keystore round trips, wrong passwords, authenticated metadata tampering, atomic replacement refusal, file mode, absence of plaintext key fields, Stake Program sysvar account order, cluster/RPC session safety, exact USDC conversion, mainnet-only lending gating, and Jupiter instruction conversion. Docker E2E is kept separate because it requires Docker and a PTY; it must be run against `SOL_WALLET_E2E_IMAGE`, never against `tsx` or the source tree. The workflow fails before publication if the image reference, Docker, pexpect, or any E2E test is missing, and uploads a method log plus image metadata on E2E failure.

The Solana `mainnet` naming update passed Prettier, Black, all 24 offline unit tests (including strict cluster-name validation), TypeScript lint/build, and `git diff --check`. At that time, Docker E2E was not run locally; GitHub Actions was the configured Docker test environment.

Before committing, TypeScript/JSON/Markdown/YAML changes are formatted with Prettier `3.6.2`, and the Python E2E harness is formatted with Black `25.1.0`; the repository rule for this is recorded in `AGENTS.md`.

An earlier local Docker setup exposed bind-mounted host directories as root-owned inside the container, causing the secure non-root runtime to receive `EPERM` while enforcing the `0700` config directory. The host now has a working Docker daemon, and the full image E2E suite passed against the exact image built locally on 2026-09-26. The earlier runtime limitation is retained here as historical context, not as a current blocker.

Do not claim a devnet/mainnet write was tested unless an opt-in integration or manual smoke run is recorded separately. Automated tests must use the disposable public fixture under `test/fixtures/`, generate ephemeral test keys inside temporary directories, or use a local/mock environment. Never use a developer or production wallet in tests.

## Docker release contract

`Dockerfile` is multi-stage. The build stage runs `npm ci`, tests, and `npm run build`, then prunes development dependencies. The runtime stage contains `package.json`, production `node_modules`, and `dist` only, runs as `solwallet` (UID/GID `10001` by default), and starts directly at `dist/cli.js`. The documented mount is `/home/solwallet/.config/sol-wallet`; direct callers should pass their host UID/GID, while `scripts/sol-wallet` does that automatically.

The intended CI order is formatting, source tests, `linux/amd64` image build, PTY/mock-RPC E2E against that exact tag, then GHCR authentication and push. Pushes to the repository's `main` or `master` branch and version tags trigger the workflow; pull requests never push. Branch pushes publish `latest`, the branch name, and the bare seven-character commit hash (for example `master` and `36f2cc6`). Version tags also publish the version, version without `v`, and minor-series tag (for example `v0.2.0` publishes `v0.2.0`, `0.2.0`, and `0.2`). CI must not upload mounted wallet directories, passwords, private keys, or arbitrary logs.

The post-review GitHub Actions run `35480368693` passed formatting, 18 unit tests, the TypeScript build, the exact-image Docker build, all 8 Docker E2E tests, GHCR authentication, and the exact tested-image push. The local container runtime cannot reproduce the runner's bind-mount ownership behavior, so this GitHub result is the authoritative Docker validation for this workspace.

The post-review v0.2 GitHub Actions run `35482612396` passed dependency installation, formatting, 23 unit tests, the TypeScript build, the exact-image Docker build, all 9 Docker E2E tests, GHCR authentication, and the exact tested-image push. No live mainnet lending write was performed; the v0.2 unit and CI tests intentionally stop at deterministic instruction conversion, safety gates, and the existing mock-RPC transaction coverage.

### v0.3 multiple-wallet implementation

Local validation on 2026-09-26 passed Prettier formatting and checks, Black
formatting and checks for the Python E2E tests, TypeScript lint/build, all 31
unit tests, documentation link checks, and `git diff --check`. A direct local
PTY smoke test imported the disposable fixture with a hidden passphrase, listed
the wallet, emitted status JSON, and exited cleanly; its temporary configuration
was removed afterward. The unit suite verifies current/default separation,
rename stability, writer contention, UUID symlink rejection, refusal of piped
passphrases, and an Ed25519 signature produced by the selected wallet's key.

The `linux/amd64` Docker image built successfully, including its 31 unit tests
and production TypeScript build. The exact-image Docker E2E suite then passed all
13 tests locally. Coverage includes two-wallet import and selection, alias
changes, a signed mock-RPC transaction, legacy migration, startup overrides,
invalid wallet selection, piped-passphrase rejection, and shell completion.
GitHub Actions run [36254644864](https://github.com/cainiaocome/solona-wallet-cli/actions/runs/36254644864)
on commit `22c97c8` passed dependency installation and the npm release-age
policy, formatting, all 31 unit tests, the TypeScript build, the `linux/amd64`
image build, all 13 exact-image E2E tests, GHCR authentication, and publication
of that same tested image. GitHub emitted non-failing notices that the pinned
workflow actions currently use a deprecated Node.js 20 runtime and that the
`ubuntu-latest` runner image is scheduled to migrate to Ubuntu 26; neither
notice affected this run.

### Multi-wallet review fixes (2026-09-26)

The follow-up review found that async command handlers could outlive the
wallet/output context captured by the dispatcher. The dispatcher now awaits
those handlers, including the `bal` alias, before restoring the context. JSON
results and errors use one compact line per object, and command-level `--json`
errors keep that format in one-shot, piped, and interactive execution. Human
`wallet list` output now shows orphan UUID paths, while an unrelated invalid
UUID path no longer hides healthy registered wallets. Registry writes accept a
symlinked, user-selected config root while continuing to reject symlinked
managed wallet directories and files. Stake registry temporary files are
synced before atomic rename.

Validation passed `npm test` (45 tests), TypeScript lint and build, Prettier and
Black checks, and `git diff --check`. The rebuilt `linux/amd64` image passed all
14 Docker E2E tests. The harness cryptographically verifies wallet B as fee
payer and signer for SOL, token, and stake transactions; deterministic Jupiter
deposit and withdrawal tests verify B's signature at the signing boundary. No
live-chain write was performed. Commit `f82c1e8` was pushed to `master`.
[GitHub Actions run 36269328619](https://github.com/cainiaocome/solona-wallet-cli/actions/runs/36269328619)
passed dependency installation and the npm release-age policy, formatting, 45
unit tests, TypeScript build, `linux/amd64` image build, Docker E2E, GHCR
authentication, and publication of the exact tested image. The run completed
with non-failing notices about actions pinned to Node.js 20 being forced onto
Node.js 24, and the planned `ubuntu-latest` migration to Ubuntu 26.

## Known operational limits

- The mainnet and devnet public RPC defaults are configurable and are not guaranteed available.
- Read-only commands still need a network when they query chain state; `address` and `wallet info` do not.
- A submitted transaction whose confirmation times out is not retried automatically; the signature is shown so it can be inspected.
- The current token sender supports basic checked transfers and refuses Token-2022 extension mints.
- Jupiter Lend requires mainnet and canonical USDC; no live mainnet lending write has been executed by automated validation.
- `npm audit --omit=dev` currently reports upstream transitive advisories through the legacy Jupiter SDK dependency graph; see [jupiter-lend.md](jupiter-lend.md) before any release dependency refresh.
- The runtime image strips the unused Jupiter read-SDK build/test toolchain after production pruning; the source install still retains those upstream dependency declarations for reproducible SDK use.
- Stake account JSON parsing follows the current generated/RPC shapes and deliberately reports `unknown` for locally registered accounts that cannot be discovered or decoded.
- There is no mnemonic import, key replacement, cloud backup, hardware wallet, dApp integration, or arbitrary serialized transaction signing.
