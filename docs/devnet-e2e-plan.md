# Devnet end-to-end testing plan

## Goal and implementation status

This document explains the implemented real-chain E2E harness for the CLI's
network-facing commands, its safety boundaries, and the longer epoch-spanning
stake lifecycle. Deterministic mock-RPC tests remain the pull-request gate;
the separate Devnet workflow runs on a schedule or by manual dispatch.

Devnet should be the primary live E2E cluster for this application. Solana
recommends Devnet for application testing and provides a faucet; Testnet is
primarily for validator and network stress testing. Devnet can still reset and
its public RPC is rate-limited, so keep deterministic mock-RPC tests as the
reliable pull-request baseline. [Solana cluster guidance](https://solana.com/docs/references/clusters)

The CLI supports `devnet`, its public RPC URL, and a Devnet genesis hash check.
Both the runner and CLI assert the expected genesis hash before writes; the
runner fails before requesting faucet funds if the endpoint is not Devnet. A
regression test pins the official hash
(`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`). This check previously had an
incorrect value duplicated in the mock fixture, which is why mock tests alone
did not expose it.

Testnet can be considered later as a supplementary compatibility/stress check.
Solana says it may run newer software and experience intermittent downtime;
the CLI would first need explicit Testnet configuration and genesis checking.
That is not a prerequisite for the Devnet suite.

## Product boundary

Jupiter Lend v0.2 is intentionally mainnet-only. It cannot be meaningfully
deposited to or withdrawn from on Devnet. The Devnet suite should assert:

- `status` reports Jupiter Lend as `not_supported` without querying the
  protocol;
- `jupiter-lend status`, `deposit`, `withdraw <amount>`, and `withdraw --all`
  reject Devnet before unlocking a wallet or broadcasting;
- amount parsing, adapter conversion, simulation, and Jupiter instruction paths
  remain covered by deterministic tests. Do not send real Mainnet funds just
  to turn these cases into E2E tests.

The existing mock suite remains essential for forced RPC errors, simulation
failures, confirmation rejection, and exact no-broadcast assertions.

## Test layers and cadence

1. **Every pull request — deterministic tests.** Keep `npm test`, formatting,
   lint/build, and Docker E2E against the method-controlled local RPC fixture
   required. These are fast, offline, repeatable, and can force conditions that
   are hard to produce on a live cluster, such as `Method not found`.
2. **Devnet smoke — implemented as scheduled/manual.** The `Devnet E2E`
   workflow builds the exact image, runs source checks, then uses a fresh
   wallet, one bounded shortfall faucet request, and runtime token fixtures. It
   verifies chain state after writes and distinguishes faucet/RPC setup
   failures from CLI assertions. It does not run for every PR or publish images.
3. **Native-stake lifecycle — implemented as resumable scheduled/manual.** Exercise
   activation, deactivation, cooldown, and withdrawal across epoch boundaries.
   This cannot fit into an ordinary PR job: warmup/cooldown is epoch-based and
   may span multiple days. `test/e2e/run_devnet_lifecycle.py` inspects chain
   state and advances at most one safe step per run. It needs a dedicated
   Devnet-only GitHub Actions secret. A GitHub Actions cache stores only the
   lifecycle wallet address, created stake-account address, and create
   signature, so later runs can identify the test-created account. No private
   key is cached. If an account exists without a matching saved identity, the
   runner stops without selecting or changing it.
4. **Release confidence.** Devnet smoke is additional evidence, not a
   replacement for deterministic CI. Track the latest run and lifecycle state
   separately because the latter takes multiple epoch windows.

The documented Devnet endpoint is `https://api.devnet.solana.com`. The public
service is rate-limited and Devnet may reset. A local run can set
`SOL_WALLET_DEVNET_RPC_URL` to a dedicated provider; credentials and query
strings must not be printed or uploaded. The GitHub workflow intentionally
uses the public endpoint by default; optionally configure the Actions secret
`SOL_WALLET_DEVNET_RPC_URL` to select a dedicated provider. The job runs only
from `main`/`master`, not arbitrary dispatch branches.
[Devnet endpoint and limits](https://solana.com/docs/references/clusters).

## Running the tests

The normal `Docker` workflow remains the deterministic mock-RPC gate. The
additional `Devnet E2E` workflow runs Wednesday and Saturday, or by manual
dispatch from the repository's default branch. A local smoke run uses the
same built image:

```bash
npm ci --legacy-peer-deps
npm run build
docker build -t sol-wallet:devnet-e2e .
python3 -m pip install pexpect
SOL_WALLET_E2E_IMAGE=sol-wallet:devnet-e2e python3 test/e2e/run_devnet_e2e.py
```

The runner first calls `getGenesisHash` directly and stops unless it is the
official Devnet value. It generates mode-0600 payer and recipient keypair files
inside a mode-0700 temporary directory, requests only the calculated shortfall
once (never more than 2 SOL), imports the payer into a temporary encrypted CLI
wallet, and submits only Devnet test transactions. Each JSON-RPC
`requestAirdrop` is sent exactly once;
HTTP/RPC errors are reported as setup failures without a hidden transport
retry. The local recording proxy forwards CLI RPC requests but retains only method names and
HTTP status codes; it never records request bodies or signed transactions.

The smoke suite compares CLI output with direct Devnet reads. It covers wallet
identity/configuration, SOL and token balances, aggregate/per-account token
listing, both supported token programs, validator filters and ordering,
status, stake discovery and a simulated stake create, SOL transfer simulation,
cancellation and confirmation, token simulations/insufficient-balance paths,
legacy SPL and Token-2022 transfers with new and existing destination ATAs,
transaction inspection, invalid stake account guards, and Jupiter Lend's
mainnet-only rejection. Every dry-run, cancellation, invalid stake path, and
Jupiter Lend rejection asserts that `sendTransaction` was not called; Jupiter's
Devnet guard additionally asserts that it made no RPC call at all.

The smoke suite burns its temporary test tokens and closes four associated
token accounts. Standard SPL mint accounts do not have a close authority, so
their small rent reserve remains on Devnet. The temporary keypairs, encrypted
wallet, config directory, and passphrase are removed when the runner exits. A
failed run can leave disposable token/mint accounts on Devnet; the ephemeral
authority key is still removed with its temporary directory.

The smoke suite does not create a real stake account with its one-run wallet:
that would strand funds during epoch warmup. The dedicated lifecycle runner
exists for that complete test. Locally, set `SOL_WALLET_E2E_IMAGE` to the built
image and optionally set `SOL_WALLET_DEVNET_RPC_URL` through a secure
environment mechanism. Never put an RPC credential in a command saved in
shell history.

### Resumable stake lifecycle setup

To enable the optional lifecycle step, create a dedicated Devnet wallet with
only test funds and configure the repository secret
`SOL_WALLET_DEVNET_LIFECYCLE_KEYPAIR_JSON` to the JSON byte-array content of
its Solana keypair file (64 integers). This must not be a Mainnet wallet or a
wallet used for anything valuable. The secret is only passed to scheduled or
manual lifecycle execution on `main`/`master`; it is never used on pull
requests, in artifacts, or in output. Without the secret, scheduled runs
report the lifecycle as unconfigured and still run the smoke suite. A manual
request to run the lifecycle without the secret fails with setup guidance.

Add both optional secrets in GitHub repository **Settings → Secrets and
variables → Actions**. Store the provider URL in `SOL_WALLET_DEVNET_RPC_URL`
only if a dedicated provider is available. Store the keypair byte-array text
in `SOL_WALLET_DEVNET_LIFECYCLE_KEYPAIR_JSON`; do not paste it into source,
issues, workflow files, or a shell command that may enter history. If a
provider's credentials are in its URL, the CLI-facing test configuration uses
the local proxy and the direct fixture helper redacts URL strings from errors.

Each invocation creates a mode-0600 keypair file and temporary encrypted
wallet, verifies Devnet, and discovers stake by both authorities. It stops if
there is more than one on-chain stake account, either authority is unexpected,
or the amount/state is inconsistent. It creates the live minimum once, then
verifies that `stake list` calculates the new account's real activating/active
state through stake-account and StakeHistory reads. Later runs advance at most
one transition: wait while activating, deactivate once active, wait while
deactivating, then withdraw and verify closure once inactive. Attempts to
deactivate too early or withdraw before inactive must reject without a
broadcast. The temporary local keystore and raw key file are deleted after
each run; the same repository secret reconstructs the authority next time.
Devnet reset or unexpected state causes a visible failure, not an automatic
transaction retry.

The workflow has read-only repository permissions and restricts the persistent
secret to lifecycle execution on the default branch. The optional RPC URL
secret is passed only to live test steps on that branch. Manual lifecycle runs
should only be started after reviewing the current chain state and accepting
that one Devnet transaction may be submitted.

## Safe harness design

### Network and wallet isolation

- Pin the run to the explicit `devnet` cluster and assert Devnet genesis before
  unlocking a wallet or constructing a transaction. A custom endpoint must
  still return the expected Devnet genesis hash.
- Use a unique config directory under the runner's temporary directory. Never
  mount a developer's home directory or use a personal wallet/config.
- Generate a fresh throwaway wallet for each smoke run. A complete
  cross-epoch stake lifecycle needs the same authority on later runs; if that
  is run in GitHub Actions, use a dedicated Devnet-only key as a protected
  Actions secret. Never reuse Mainnet/Devnet operational keys, commit the test
  key, put it in artifacts, or print it.
- Generate passphrases during the run and enter them only through hidden TTY
  prompts. Delete temporary keypair/keystore files during cleanup.
- Do not use hard-coded unit-test keys for funded live runs. Use an exclusive
  workflow concurrency group for any persistent lifecycle wallet.

### Funding and disposable accounts

The harness reads the initial balance and stake minimum, calculates the amount
needed for planned operations, and requests only that shortfall from the Devnet
faucet in one request capped at 2 SOL. It never retries a request whose result
is unknown. Confirm the returned signature before testing commands. A faucet
outage or rate limit is a setup/infrastructure failure, not a CLI failure.

Generate recipient keypairs and token mints at runtime. Create legacy SPL Token
and plain Token-2022 mints/accounts on Devnet, mint small known balances, and
close temporary accounts/mints where possible. Return the recipient SOL used
for transfer assertions. Withdraw/close the test stake account after the full
lifecycle completes. Cleanup is best-effort because Devnet can reset.

Do not assume a transaction timeout means it failed. Inspect its signature
before any retry, and never automatically rebroadcast a write whose result is
unknown.

### Prove that commands do not broadcast

For dry-run, user cancellation, wrong-cluster, unsupported-protocol, and
invalid-stake-state cases, place a small local HTTP JSON-RPC recording proxy in
front of Devnet. It forwards requests but records only method names and HTTP
response codes—not request bodies, signed transaction bytes, keys, or
credential-bearing URLs. Assert that `sendTransaction` was not called.

For successful writes, record the public signature/slot and verify resulting
account and balance state with fresh direct RPC reads. Keep writes serial and
respect `Retry-After` on HTTP 429 with bounded backoff; do not rely on the
shared public endpoint sustaining high concurrency.

## Command-by-command coverage matrix

| Command / flow                                                       | Devnet E2E case and proof                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup `--help`, `help [topic]`                                     | Run in the packaged image without a wallet or RPC; assert usage covers supported commands and the Devnet cluster. This is local behavior, not a chain test.                                                                                                                                                               |
| `address`                                                            | Import/select the run wallet; assert public address/alias and no RPC request or signer unlock.                                                                                                                                                                                                                            |
| `balance`                                                            | Compare CLI lamports/SOL with `getBalance`; repeat after a transfer and account for the confirmed fee.                                                                                                                                                                                                                    |
| `status`                                                             | Assert Devnet identity, SOL/token balances, native-stake counts/states, and Jupiter Lend `not_supported`; compare available values to direct RPC reads.                                                                                                                                                                   |
| `wallet import`                                                      | Import a runtime-generated throwaway key through the interactive prompt; check derived address and registry entry; ensure secret input never appears in output.                                                                                                                                                           |
| `wallet list`, `wallet info [alias]`                                 | Verify aliases, current/default markers, full address, and local metadata. Include a second empty wallet to prove selection isolation.                                                                                                                                                                                    |
| `wallet use`, `wallet default`, `wallet rename`                      | Exercise process-local selection separately from saved default; rename without changing UUID/address; start another CLI process and verify persisted behavior.                                                                                                                                                            |
| `wallet migrate`, `wallet recover`                                   | Use isolated temporary legacy/orphan keystore fixtures. These are local-storage workflows; keep their adversarial filesystem cases in the deterministic suite.                                                                                                                                                            |
| `set cluster devnet`, `set rpc-url`, `set commitment`, `show config` | Verify the next request uses the configured Devnet endpoint/commitment and session-only changes remain session-only. `show config` redacts endpoint credentials; `set rpc-url` deliberately echoes the supplied value and may retain the command in local history under the user's accepted behavior.                     |
| `validators [flags]`                                                 | Compare rows to `getVoteAccounts`; check sorting, limit, commission filter, status, and full vote-account addresses. Do not assume delinquent validators always exist.                                                                                                                                                    |
| `send <destination> <amount>`                                        | Send a small amount to a fresh recipient. Verify receipt and signature, recipient delta, and sender delta of amount plus fee. Run `--dry-run` and a TTY cancellation; assert neither broadcasts.                                                                                                                          |
| `token list [--accounts]`, `token balance <mint>`                    | Create legacy and plain Token-2022 mints/accounts, mint known amounts, and compare aggregates, per-account details, zero balance, decimals, program labels, and known-mint symbol labels with RPC.                                                                                                                        |
| `token symbols`, `token balance <symbol>`                            | Assert the Devnet USDC test mapping is listed with `testOnly` and that `token balance usdc` resolves to that exact mint. The symbol-to-mint mapping itself is local; the symbol-based write path shares the mint-based transfer pipeline and is covered by mock-RPC/unit tests plus the mint-based Devnet transfer below. |
| `token send <mint> <destination> <amount>`                           | Send to a recipient without an ATA and verify ATA creation; send again with ATA present. Assert exact raw units; include insufficient-balance and dry-run/no-broadcast cases.                                                                                                                                             |
| `tx inspect <signature>`                                             | Inspect a signature produced in the same run; briefly retry if RPC indexing lags; compare slot, result, fee, signers, instruction summary, and Devnet Explorer link. Keep malformed/unknown signatures in the mock suite.                                                                                                 |
| `stake create <amount> --validator <vote>`                           | Smoke: query live minimum/rent, choose a current low-commission validator, and simulate without broadcast. Lifecycle: create one minimum-sized stake and verify authorities, signature, and immediate `stake list` state.                                                                                                 |
| `stake list`                                                         | Smoke: query live Devnet. Lifecycle: read a real delegated account across epoch states, exercising account/epoch/StakeHistory calls instead of the removed `getStakeActivation` RPC method.                                                                                                                               |
| `stake deactivate <account>`                                         | Lifecycle: submit once only when active and verify state/signature. While activating/deactivating, assert rejection and zero broadcasts.                                                                                                                                                                                  |
| `stake withdraw <account> [--amount]`                                | Lifecycle: assert refusal before inactive and zero broadcasts; once inactive, withdraw all and verify account closure. Partial withdrawal/rent-reserve behavior remains in deterministic tests.                                                                                                                           |
| `jupiter-lend status/deposit/withdraw`                               | On Devnet, assert all commands hit the mainnet-only guard before protocol reads, wallet unlock, or broadcast. Use deterministic tests for actual Jupiter instructions; never substitute Mainnet writes.                                                                                                                   |
| `history`, `clear`/`cls`, `exit`/`quit`/`q`, aliases `bal`/`q`/`cls` | Exercise REPL, one-shot, and piped behavior in the Docker/PTTY suite. These are local shell operations; assert the RPC proxy records no chain requests.                                                                                                                                                                   |

During the resumable stake lifecycle, compare each displayed
`validatorVoteAccount` with `getAccountInfo(jsonParsed)`'s
`data.parsed.info.stake.delegation.voter` for the same stake account.

`wallet delete` and `wallet change-passphrase` are local-only operations. The
packaged Docker/PTTY suite covers delete confirmation and `--yes`, default and
current selection behavior, passphrase rotation/failure, recovery-artifact
retention, and the absence of RPC calls. They do not need Devnet writes.

For every command that supports both formats, check human and JSON output.
For every write, assert network/wallet/amount/destination/validator/fee in
preflight, simulation before signing, confirmation behavior, confirmed receipt,
and the actual resulting chain state. Use live RPC values rather than
hard-coded balances, slots, validators, or signatures.

## Resumable stake lifecycle

Use a dedicated Devnet-only authority wallet with no unrelated stake accounts.
Advance this state machine at most one safe step per scheduled/manual run:

```text
no managed stake
  -> create/delegate
  -> activating (poll on later runs)
  -> active
  -> deactivate
  -> deactivating (poll on later runs)
  -> inactive
  -> withdraw and verify closure
```

Resume only the stake-account address saved immediately after this runner
successfully creates it. Confirm it appears in the wallet's on-chain stake
listing and that both authorities match the dedicated lifecycle wallet before
signing. If the saved account is absent, verify getAccountInfo reports it
closed before starting a fresh cycle. If another stake account exists without a
saved test identity, or the saved account is ambiguous, locked, or has
unexpected authorities, stop without signing. If Devnet resets and the account
is gone, clear the old identity and start a new cycle. Do not sleep for days
inside one GitHub runner; let later scheduled runs resume. Cache restore/save
failure fails the job and prevents lifecycle writes.

## Reporting and acceptance criteria

- A genesis mismatch is a hard failure before signing.
- A command/result mismatch or unexpected broadcast is a product failure.
- RPC outage, HTTP 429, unavailable validator data, or faucet exhaustion is
  identified as Devnet infrastructure/setup failure. Airdrop requests are not
  retried automatically when the result is unknown.
- No skipped tests count as success. Jupiter's mainnet-only rejection is an
  explicit passing assertion, not a skipped test.
- The workflow currently uploads no artifacts. If that changes, artifacts may
  contain redacted output, method names/statuses, public addresses, signatures,
  and slots, but never keys, keystores, passphrases, signed transaction
  payloads, or RPC credentials.
- Coverage is split across the live smoke suite, optional resumable lifecycle,
  and deterministic tests for unavailable/unsafe cases (including Jupiter's
  positive Mainnet integration). Record the latest actual run and lifecycle
  state in `docs/` after an execution; never infer success from a skipped run.
- The lifecycle step can run after a Devnet smoke/faucet failure if image build,
  deterministic tests, Python tooling, and lifecycle-state restoration passed.
  The workflow still reports the smoke failure, so the overall run remains
  failed. An already-funded lifecycle wallet can therefore progress while the
  public faucet is unavailable without hiding smoke failures.

## Validation record

Recorded through 2026-09-27 UTC:

- 65 unit tests passed; TypeScript lint and build passed.
- Linux/amd64 Docker image build passed; all 16 Docker E2E tests passed.
- Prettier, Black, Python compilation, and Node syntax checks passed after the
  no-retry change. The new offline 429 regression test verified exactly one
  faucet request.
- The direct live RPC genesis check identified Devnet. The first faucet call
  returned JSON-RPC `Internal error`; a read-only balance check confirmed that
  address remained at zero. A second fresh-wallet attempt received HTTP 429,
  stating that the daily airdrop limit was reached or the faucet was dry. No
  CLI wallet import or SOL/token/stake CLI transaction ran in either attempt.
- That second attempt exposed automatic 429 retries inside the web3.js
  `requestAirdrop` helper. The fixture now issues each faucet request exactly
  once via direct JSON-RPC and does not retry an unknown result. The one-shot
  failure behavior passed its local 429 regression test, but it has not been
  exercised against a successful live airdrop because the shared faucet is
  currently rate-limited. No CLI live-chain command test ran because funding
  failed before wallet import.
- Docker GitHub Actions runs [36282996061](https://github.com/cainiaocome/solona-wallet-cli/actions/runs/36282996061),
  [36283186689](https://github.com/cainiaocome/solona-wallet-cli/actions/runs/36283186689),
  and [36283339265](https://github.com/cainiaocome/solona-wallet-cli/actions/runs/36283339265)
  all passed and published the exact tested image. The first run showed Node 20
  action-runtime warnings; the next upgraded to Node 24-compatible action
  majors, and the final run used Ubuntu 24.04. The scheduled/manual live Devnet
  workflow has not run; it still requires faucet availability (or a dedicated
  provider), and the optional stake lifecycle requires its protected key
  secret.

The Solana cluster documentation warns that public RPC rate limits can change
and the endpoint has no production SLA; treat an airdrop 429 or faucet error as
an infrastructure/setup failure, not a passing product E2E result.
[Solana public cluster endpoint guidance](https://solana.com/docs/references/clusters).

## Review remediation validation — 2026-09-27

After the review findings were saved, fixes passed 78 TypeScript unit tests,
lint, build, formatting, Black, Python compilation, Node syntax checks, and all
19 local Docker/Python E2E tests, including three offline lifecycle safety
tests. The container run verified the packaged runtime image and interactive
transaction flows against the local mock RPC.

No live Devnet lifecycle transaction was submitted during this remediation.
The public faucet and protected lifecycle key remain prerequisites for
observing a full lifecycle across real epochs. GitHub Actions cache v5 carries
the public lifecycle identity between runs and uses Node 24.
