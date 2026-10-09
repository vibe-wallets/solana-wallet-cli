import { formatSol, formatUnits } from "../solana/amounts.js";
import { assertRpcCluster, rpcRequest } from "../solana/rpc.js";
import { aggregateTokenAccounts, getTokenAccounts } from "../solana/tokens.js";
import { knownTokenForMint } from "../solana/known-tokens.js";
import {
  keyValueRows,
  networkLabel,
  sectionTitle,
  shortenAddress,
  table,
} from "../output/human.js";
import { color } from "../output/terminal.js";
import { lendYieldRows } from "../output/lending.js";
import {
  calculateLendYield,
  type JupiterLendYield,
} from "../integrations/jupiter-lend/yield.js";
import {
  asAppError,
  KeystoreError,
  WalletStoreError,
} from "../errors/errors.js";
import { readLendPosition } from "./lending.js";
import { readStakeAccounts } from "./staking.js";
import { JUPITER_LEND_USDC_DECIMALS } from "../integrations/jupiter-lend/adapter.js";
import { confirm, readSecret } from "../shell/prompt.js";
import { walletKeystorePath } from "../config/config.js";
import {
  encryptSecretKey,
  parseKeystoreFile,
  unlockFileAndValidate,
} from "../wallet/keystore.js";
import {
  deleteRegisteredWallet,
  listOrphanIds,
  mutateRegistry,
  readRawKeystore,
  readRegistry,
  replaceWalletKeystore,
  resolveWallet,
  validateAlias,
  walletFileStatus,
  type WalletEntry,
} from "../wallet/store.js";
import type { CommandContext } from "./context.js";

/**
 * Commands for local wallet metadata and session selection.
 *
 * These operations do not unlock keys. A selection stores a stable UUID in
 * process state; the saved default is a separate registry field for new runs.
 */
export async function walletList(context: CommandContext): Promise<void> {
  const registry = await readRegistry(context.config.configDir);
  context.completion.walletAliases = registry.wallets.map(
    (wallet) => wallet.alias,
  );
  const wallets = await Promise.all(
    [...registry.wallets]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map(async (wallet) => ({
        ...identity(wallet),
        createdAt: wallet.createdAt,
        current: context.session.currentWalletId === wallet.id,
        default: registry.defaultWalletId === wallet.id,
        health: await walletFileStatus(context.config.configDir, wallet),
      })),
  );
  const orphanIds = await listOrphanIds(context.config.configDir, registry);
  context.output.print(
    {
      ok: true,
      currentWalletId: context.session.currentWalletId,
      defaultWalletId: registry.defaultWalletId,
      wallets,
      orphanIds,
    },
    wallets.length
      ? `${formatWalletTable(wallets)}${orphanIds.length ? `\n\nUnregistered UUID-named wallet paths (review before recovery):\n${orphanIds.join("\n")}` : ""}`
      : orphanIds.length
        ? `No wallets registered. Run \`wallet recover <uuid> <alias>\` for an unregistered key.\nUnregistered UUID-named wallet paths (review before recovery):\n${orphanIds.join("\n")}`
        : "No wallets registered. Run `wallet import <alias>`.",
  );
}

function formatWalletTable(
  wallets: Array<{
    current: boolean;
    default: boolean;
    alias: string;
    address: string;
    health: string;
  }>,
): string {
  return `${table(
    wallets.map((wallet) => [
      wallet.current ? "*" : "",
      wallet.default ? "*" : "",
      wallet.alias,
      wallet.address,
      wallet.health,
    ]),
    ["CURRENT", "DEFAULT", "ALIAS", "ADDRESS", "HEALTH"],
  )}\n* marks the current or saved-default wallet.`;
}

export async function walletInfo(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  const registry = await readRegistry(context.config.configDir);
  const entry = alias
    ? registry.wallets.find((wallet) => wallet.alias === alias)
    : registry.wallets.find(
        (wallet) => wallet.id === context.session.currentWalletId,
      );
  if (!entry)
    throw new WalletStoreError(
      alias ? "WalletNotFound" : "WalletNotSelected",
      alias
        ? `No wallet has alias '${alias}'.`
        : "No wallet is selected; use `wallet info <alias>`.",
      2,
    );
  const selected = await resolveWallet(
    context.config.configDir,
    entry.id,
    registry,
  );
  context.output.print(
    {
      ok: true,
      wallet: identity(entry),
      cluster: context.config.cluster,
      createdAt: entry.createdAt,
      current: context.session.currentWalletId === entry.id,
      default: registry.defaultWalletId === entry.id,
      encrypted: true,
    },
    keyValueRows([
      ["Alias", entry.alias, "emphasis"],
      ["Address", selected.identity.address],
      ["Network", networkLabel(context.config.cluster)],
      ["Private key", "encrypted at rest"],
      [
        "Current",
        String(context.session.currentWalletId === entry.id),
        context.session.currentWalletId === entry.id ? "success" : "muted",
      ],
      [
        "Default",
        String(registry.defaultWalletId === entry.id),
        registry.defaultWalletId === entry.id ? "success" : "muted",
      ],
    ]),
  );
}

export async function walletUse(
  context: CommandContext,
  alias: string,
): Promise<void> {
  if (context.session.executionMode === "oneshot")
    throw new WalletStoreError(
      "ParseError",
      "Use startup `--wallet <alias>` with a one-shot command.",
      2,
    );
  validateAlias(alias);
  const registry = await readRegistry(context.config.configDir);
  const entry = registry.wallets.find((wallet) => wallet.alias === alias);
  if (!entry)
    throw new WalletStoreError(
      "WalletNotFound",
      `No wallet has alias '${alias}'.`,
      2,
    );
  const selected = await resolveWallet(
    context.config.configDir,
    entry.id,
    registry,
  );
  context.walletStoreError = undefined;
  const changed = context.session.currentWalletId !== entry.id;
  context.session.currentWalletId = entry.id;
  context.commandWallet = selected;
  clearWalletCaches(context);
  context.output.print(
    {
      ok: true,
      action: "use",
      wallet: identity(entry),
      currentWalletId: entry.id,
      defaultWalletId: registry.defaultWalletId,
      changed,
    },
    `Current wallet: ${alias} (${selected.identity.address})${registry.defaultWalletId === entry.id ? "\nThis is also the saved default." : ""}`,
  );
}

export async function walletDefault(
  context: CommandContext,
  alias: string,
): Promise<void> {
  validateAlias(alias);
  const before = await readRegistry(context.config.configDir);
  const target = before.wallets.find((wallet) => wallet.alias === alias);
  if (!target)
    throw new WalletStoreError(
      "WalletNotFound",
      `No wallet has alias '${alias}'.`,
      2,
    );
  const selected = await resolveWallet(
    context.config.configDir,
    target.id,
    before,
  );
  let changed = false;
  const registry = await mutateRegistry(context.config.configDir, (current) => {
    const entry = current.wallets.find((wallet) => wallet.alias === alias);
    if (!entry || entry.id !== target.id)
      throw new WalletStoreError(
        "WalletNotFound",
        `Wallet '${alias}' changed while updating the default; retry.`,
        2,
      );
    changed = current.defaultWalletId !== entry.id;
    return { ...current, defaultWalletId: entry.id };
  });
  const entry = registry.wallets.find((wallet) => wallet.alias === alias)!;
  context.walletStoreError = undefined;
  context.output.print(
    {
      ok: true,
      action: "default",
      wallet: identity(entry),
      currentWalletId: context.session.currentWalletId,
      defaultWalletId: entry.id,
      changed,
    },
    `Saved default wallet: ${alias} (${selected.identity.address})${context.session.currentWalletId === entry.id ? "\nIt is also the current wallet." : "\nThe current session wallet was not changed."}`,
  );
}

export async function walletRename(
  context: CommandContext,
  oldAlias: string,
  newAlias: string,
): Promise<void> {
  validateAlias(oldAlias);
  validateAlias(newAlias);
  let changed = false;
  const registry = await mutateRegistry(context.config.configDir, (current) => {
    const entry = current.wallets.find((wallet) => wallet.alias === oldAlias);
    if (!entry)
      throw new WalletStoreError(
        "WalletNotFound",
        `No wallet has alias '${oldAlias}'.`,
        2,
      );
    if (oldAlias === newAlias) return current;
    if (current.wallets.some((wallet) => wallet.alias === newAlias))
      throw new WalletStoreError(
        "WalletAliasExists",
        `Alias '${newAlias}' is already in use.`,
        2,
      );
    changed = true;
    return {
      ...current,
      wallets: current.wallets.map((wallet) =>
        wallet.id === entry.id ? { ...wallet, alias: newAlias } : wallet,
      ),
    };
  });
  const entry = registry.wallets.find((wallet) => wallet.alias === newAlias)!;
  context.completion.walletAliases = registry.wallets.map(
    (wallet) => wallet.alias,
  );
  context.output.print(
    {
      ok: true,
      action: "rename",
      wallet: identity(entry),
      currentWalletId: context.session.currentWalletId,
      defaultWalletId: registry.defaultWalletId,
      changed,
    },
    changed
      ? `Wallet renamed: ${oldAlias} → ${newAlias} (${entry.address})`
      : `Wallet alias is already '${newAlias}'.`,
  );
}

/** Remove one wallet from this local store; this never changes chain state. */
export async function walletDelete(
  context: CommandContext,
  alias: string,
  skipConfirmation = false,
): Promise<void> {
  validateAlias(alias);
  const registry = await readRegistry(context.config.configDir);
  const target = registry.wallets.find((wallet) => wallet.alias === alias);
  if (!target)
    throw new WalletStoreError(
      "WalletNotFound",
      `No wallet has alias '${alias}'.`,
      2,
    );
  if (registry.defaultWalletId === target.id && registry.wallets.length > 1)
    throw new WalletStoreError(
      "WalletIsDefault",
      `Wallet '${alias}' is the saved default. Run \`wallet default <another-alias>\` before deleting it.`,
      2,
    );
  if (!skipConfirmation && !context.session.yes && !process.stdin.isTTY)
    throw new WalletStoreError(
      "PromptError",
      "Wallet deletion requires an interactive terminal. Use `wallet delete <alias> --yes` only if you intend to remove this local wallet.",
      2,
    );

  if (
    !skipConfirmation &&
    !context.session.yes &&
    !(await confirm(
      `Delete local wallet '${target.alias}' (${target.address})? This removes its registry entry and managed keystore only; it does not move or delete SOL, tokens, stake, or lending positions on Solana.`,
    ))
  ) {
    context.output.print(
      { ok: true, action: "delete", deleted: false, cancelled: true },
      "Wallet deletion cancelled.",
    );
    return;
  }

  let result: Awaited<ReturnType<typeof deleteRegisteredWallet>>;
  try {
    result = await deleteRegisteredWallet(context.config.configDir, target);
  } catch (error) {
    // Registry replacement can report uncertain durability after its rename.
    // Reconcile only the in-memory selection if a fresh read proves the delete
    // committed; never guess when the registry itself cannot be read.
    const latest = await readRegistry(context.config.configDir).catch(
      () => undefined,
    );
    if (latest && !latest.wallets.some((wallet) => wallet.id === target.id))
      refreshAfterWalletDeletion(context, target.id, latest);
    throw error;
  }
  const wasCurrent = refreshAfterWalletDeletion(
    context,
    target.id,
    result.registry,
  );
  const warning =
    result.keystore === "retained"
      ? "The wallet was removed from the registry, but its encrypted UUID keystore could not be deleted. Inspect `wallet list`; the orphan file can be recovered or removed after review."
      : result.keystore === "durability-uncertain"
        ? "The keystore file was removed, but the filesystem could not confirm durable deletion. Inspect `wallet list` before retrying."
        : undefined;
  const human = [
    `Wallet '${target.alias}' removed from this local wallet store.`,
    result.keystore === "already-missing"
      ? "Its registered keystore file was already missing."
      : result.keystore === "removed"
        ? "Its registered encrypted keystore file was removed."
        : undefined,
    wasCurrent ? "No wallet is selected in this session." : undefined,
    "No SOL, tokens, stake accounts, or lending positions were changed on Solana.",
    "Separate legacy backups and local stake-recovery hints are left untouched; file deletion is not guaranteed secure erasure.",
    warning,
  ]
    .filter(Boolean)
    .join("\n");
  context.output.print(
    {
      ok: true,
      action: "delete",
      deleted: true,
      partial:
        result.keystore === "retained" ||
        result.keystore === "durability-uncertain",
      wallet: identity(target),
      currentWalletId: context.session.currentWalletId,
      defaultWalletId: result.registry.defaultWalletId,
      keystore: result.keystore,
      ...(warning ? { warning } : {}),
    },
    human,
  );
}

/** Re-encrypt one key with a new passphrase without changing wallet identity. */
export async function walletChangePassphrase(
  context: CommandContext,
  alias: string,
): Promise<void> {
  validateAlias(alias);
  const registry = await readRegistry(context.config.configDir);
  const entry = registry.wallets.find((wallet) => wallet.alias === alias);
  if (!entry)
    throw new WalletStoreError(
      "WalletNotFound",
      `No wallet has alias '${alias}'.`,
      2,
    );

  const selected = await resolveWallet(
    context.config.configDir,
    entry.id,
    registry,
  );
  const keystorePath = walletKeystorePath(context.config.configDir, entry.id);
  const originalBytes = await readRawKeystore(keystorePath);
  const originalFile = parseKeystoreFile(originalBytes);
  if (originalFile.publicKey !== entry.address)
    throw new WalletStoreError(
      "WalletStoreInvalid",
      `Keystore address does not match wallet '${entry.alias}'.`,
    );

  const previousWallet = context.commandWallet;
  context.commandWallet = selected;
  let oldPassphrase = "";
  let newPassphrase = "";
  let confirmation = "";
  let secret: Buffer | undefined;
  let verified: Buffer | undefined;
  try {
    oldPassphrase = await context.readPassphrase();
    secret = await unlockFileAndValidate(originalFile, oldPassphrase);
    newPassphrase = await readSecret(`New passphrase for ${entry.alias}: `);
    confirmation = await readSecret("Confirm new passphrase: ");
    if (!newPassphrase || newPassphrase !== confirmation)
      throw new KeystoreError("New passphrases do not match or are empty.");
    if (newPassphrase === oldPassphrase)
      throw new KeystoreError(
        "Choose a different passphrase; the current passphrase is unchanged.",
      );

    const encrypted = await encryptSecretKey(
      secret,
      entry.address,
      newPassphrase,
    );
    verified = await unlockFileAndValidate(encrypted, newPassphrase);
    verified.fill(0);
    verified = undefined;
    await replaceWalletKeystore(
      context.config.configDir,
      entry,
      originalBytes,
      encrypted,
    );
    context.output.print(
      {
        ok: true,
        action: "change-passphrase",
        changed: true,
        wallet: identity(entry),
        currentWalletId: context.session.currentWalletId,
      },
      `Passphrase changed for wallet '${entry.alias}'. Its address and wallet selection are unchanged.\nExisting backups were not re-encrypted and still require the previous passphrase.`,
    );
  } finally {
    secret?.fill(0);
    verified?.fill(0);
    // JavaScript strings cannot be reliably zeroized; drop references promptly.
    oldPassphrase = "";
    newPassphrase = "";
    confirmation = "";
    context.commandWallet = previousWallet;
  }
}

/**
 * Refresh public chain balances without unlocking the key. RPC health and each
 * balance section are independent so a failed read is never rendered as zero.
 */
export async function status(context: CommandContext): Promise<void> {
  if (context.walletStoreError) throw context.walletStoreError;
  const registry = await readRegistry(context.config.configDir);
  const currentEntry = registry.wallets.find(
    (wallet) => wallet.id === context.session.currentWalletId,
  );
  if (context.session.currentWalletId && !currentEntry)
    throw new WalletStoreError(
      "WalletStoreInvalid",
      "The current wallet is no longer registered. Select a registered wallet with `wallet use <alias>`.",
    );
  const defaultEntry = registry.wallets.find(
    (wallet) => wallet.id === registry.defaultWalletId,
  );
  const defaultFileStatus = defaultEntry
    ? await walletFileStatus(context.config.configDir, defaultEntry)
    : null;
  const defaultWalletHealth =
    defaultFileStatus === "ok" ? "healthy" : defaultFileStatus;
  const selected = currentEntry
    ? await resolveWallet(context.config.configDir, currentEntry.id, registry)
    : null;
  if (selected) context.commandWallet = selected;
  const current = selected ? identity(selected.identity) : null;
  const defaultWallet = defaultEntry ? identity(defaultEntry) : null;
  const rpcUrl = displayRpcUrl(context.config.rpcUrl);
  let rpcState:
    | { status: "reachable" }
    | { status: "unavailable"; error: string };
  let solBalance:
    | { status: "available"; lamports: bigint; amount: string }
    | { status: "unavailable"; error: string }
    | null = null;
  let tokenBalances:
    | {
        status: "available";
        assets: (ReturnType<typeof aggregateTokenAccounts>[number] & {
          symbol?: string;
        })[];
      }
    | { status: "unavailable"; error: string }
    | null = null;
  let stakePosition:
    | {
        status: "available";
        accountCount: number;
        delegatedLamports: bigint;
        stateCounts: Record<string, number>;
        localHints: number;
      }
    | { status: "unavailable"; error: string }
    | null = null;
  let jupiterPosition:
    | {
        status: "available";
        walletBalance: bigint;
        walletBalanceUsdc: string;
        supplied: bigint;
        suppliedUsdc: string;
        currentlyWithdrawable: bigint;
        currentlyWithdrawableUsdc: string;
        yield: JupiterLendYield;
      }
    | { status: "unavailable"; error: string }
    | { status: "not_supported"; reason: "mainnet-only" }
    | null = null;
  const showProgress = !context.output.json && Boolean(process.stderr.isTTY);

  if (showProgress)
    process.stderr.write(
      color("Refreshing wallet status…", "muted", { stream: "stderr" }),
    );
  try {
    const rpc = context.getClient().rpc;
    await assertRpcCluster(rpc, context.config.cluster);
    rpcState = { status: "reachable" };
    if (selected) {
      const [solResult, tokenResult, stakeResult, jupiterResult] =
        await Promise.allSettled([
          rpcRequest(
            rpc.getBalance(selected.identity.address, {
              commitment: context.config.commitment,
            }),
            "SOL balance lookup",
          ),
          getTokenAccounts(
            rpc,
            selected.identity.address,
            context.config.commitment,
          ),
          readStakeAccounts(context, selected.identity.address, true),
          ...(context.config.cluster === "mainnet"
            ? [readLendPosition(context, selected.identity.address)]
            : []),
        ]);
      if (solResult.status === "fulfilled") {
        const lamports = BigInt(solResult.value.value as bigint);
        solBalance = {
          status: "available",
          lamports,
          amount: formatSol(lamports),
        };
      } else {
        solBalance = {
          status: "unavailable",
          error: asAppError(solResult.reason).code,
        };
      }
      if (tokenResult.status === "fulfilled") {
        try {
          context.completion.tokenMints = [
            ...new Set(tokenResult.value.map((account) => account.mint)),
          ];
          tokenBalances = {
            status: "available",
            assets: aggregateTokenAccounts(tokenResult.value)
              .filter((asset) => asset.rawAmount > 0n)
              .map((asset) => {
                const symbol = knownTokenForMint(
                  asset.mint,
                  context.config.cluster,
                )?.displaySymbol;
                return symbol ? { ...asset, symbol } : asset;
              }),
          };
        } catch (error) {
          tokenBalances = {
            status: "unavailable",
            error: asAppError(error).code,
          };
        }
      } else {
        tokenBalances = {
          status: "unavailable",
          error: asAppError(tokenResult.reason).code,
        };
      }
      if (stakeResult.status === "fulfilled") {
        const chainAccounts = stakeResult.value.filter((account) =>
          Object.hasOwn(account, "lamports"),
        );
        const stateCounts: Record<string, number> = {};
        let delegatedLamports = 0n;
        for (const account of chainAccounts) {
          const state = String(account.state ?? "unknown");
          stateCounts[state] = (stateCounts[state] ?? 0) + 1;
          if (typeof account.delegatedStakeLamports === "bigint")
            delegatedLamports += account.delegatedStakeLamports;
        }
        stakePosition = {
          status: "available",
          accountCount: chainAccounts.length,
          delegatedLamports,
          stateCounts,
          localHints: stakeResult.value.length - chainAccounts.length,
        };
      } else {
        stakePosition = {
          status: "unavailable",
          error: asAppError(stakeResult.reason).code,
        };
      }
      if (context.config.cluster === "mainnet") {
        if (jupiterResult?.status === "fulfilled") {
          const position = jupiterResult.value;
          jupiterPosition = {
            status: "available",
            walletBalance: position.walletBalance,
            walletBalanceUsdc: formatUnits(
              position.walletBalance,
              JUPITER_LEND_USDC_DECIMALS,
            ),
            supplied: position.supplied,
            suppliedUsdc: formatUnits(
              position.supplied,
              JUPITER_LEND_USDC_DECIMALS,
            ),
            currentlyWithdrawable: position.withdrawable,
            currentlyWithdrawableUsdc: formatUnits(
              position.withdrawable,
              JUPITER_LEND_USDC_DECIMALS,
            ),
            yield: calculateLendYield(
              position.supplyRateRaw,
              position.rewardsRateRaw,
              position.ratesUpdatedAt,
            ),
          };
        } else {
          jupiterPosition = {
            status: "unavailable",
            error:
              jupiterResult?.status === "rejected"
                ? asAppError(jupiterResult.reason).code
                : "JupiterLendError",
          };
        }
      } else {
        jupiterPosition = { status: "not_supported", reason: "mainnet-only" };
      }
    }
  } catch (error) {
    const code = asAppError(error).code;
    rpcState = { status: "unavailable", error: code };
    if (selected) {
      solBalance = { status: "unavailable", error: code };
      tokenBalances = { status: "unavailable", error: code };
      stakePosition = { status: "unavailable", error: code };
      jupiterPosition =
        context.config.cluster === "mainnet"
          ? { status: "unavailable", error: code }
          : { status: "not_supported", reason: "mainnet-only" };
    }
  } finally {
    if (showProgress) process.stderr.write("\n");
  }

  const requiredSections = [
    solBalance,
    tokenBalances,
    stakePosition,
    ...(context.config.cluster === "mainnet" ? [jupiterPosition] : []),
  ];
  const hasUnavailableSection =
    requiredSections.some((section) => section?.status === "unavailable") ||
    (jupiterPosition?.status === "available" &&
      jupiterPosition.yield.status === "unavailable");
  const health =
    rpcState.status === "unavailable"
      ? "unavailable"
      : selected && hasUnavailableSection
        ? "degraded"
        : "healthy";
  const updatedAt = new Date().toISOString();
  const balances = selected ? { sol: solBalance, tokens: tokenBalances } : null;
  const positions = selected
    ? { nativeStake: stakePosition, jupiterLend: jupiterPosition }
    : null;
  const tokenTable =
    tokenBalances?.status === "available" && tokenBalances.assets.length
      ? table(
          tokenBalances.assets.map((asset) => [
            asset.symbol ?? "—",
            context.output.verbose ? asset.mint : shortenAddress(asset.mint),
            asset.amount,
            asset.program,
            String(asset.accountCount),
          ]),
          ["SYMBOL", "TOKEN MINT", "BALANCE", "PROGRAM", "ACCOUNTS"],
        )
      : tokenBalances?.status === "unavailable"
        ? "Unavailable — check the RPC endpoint and retry status."
        : "No non-zero token balances.";
  const defaultLabel = defaultWallet
    ? current?.id === defaultWallet.id
      ? `${defaultWallet.alias} (same as current)`
      : `${defaultWallet.alias} (${defaultWallet.address})`
    : "none";
  const network = networkLabel(context.config.cluster);
  const rpcLabel =
    rpcState.status === "reachable"
      ? color("Verified", "success")
      : color("Unavailable / wrong network", "error");
  // Keep the interactive reading order deliberate: identity, liquid assets,
  // then protocol/stake positions that should not be mistaken for cash.
  const lines = [
    sectionTitle("WALLET & NETWORK"),
    keyValueRows([
      [
        "Wallet",
        current ? `${current.alias} (${current.address})` : "none selected",
      ],
      ["Network", network],
      ["RPC", `${rpcLabel} · ${rpcUrl}`],
      ["Commitment", context.config.commitment],
    ]),
    "",
    sectionTitle("LIQUID BALANCES"),
    selected
      ? keyValueRows([
          [
            "SOL",
            solBalance?.status === "available"
              ? `${solBalance.amount} SOL`
              : "Unavailable — check RPC and retry status.",
            solBalance?.status === "available" ? "emphasis" : "warning",
          ],
        ])
      : "Import or select a wallet to view balances.",
    "",
    sectionTitle("TOKENS"),
    selected ? tokenTable : "Not loaded — no wallet is selected.",
    "",
    sectionTitle("POSITIONS · NOT LIQUID"),
    ...(selected
      ? [
          sectionTitle("JUPITER LEND · USDC"),
          jupiterPosition?.status === "available"
            ? keyValueRows([
                [
                  "In wallet",
                  `${jupiterPosition.walletBalanceUsdc} USDC`,
                  "emphasis",
                ],
                [
                  "Supplied",
                  `${jupiterPosition.suppliedUsdc} USDC`,
                  "emphasis",
                ],
                [
                  "Withdrawable now",
                  `${jupiterPosition.currentlyWithdrawableUsdc} USDC`,
                  "success",
                ],
                ...lendYieldRows(jupiterPosition.yield, false),
              ])
            : jupiterPosition?.status === "not_supported"
              ? "Mainnet only; not queried on devnet."
              : "Unavailable — check RPC/protocol access and retry status.",
          "",
          sectionTitle("NATIVE STAKE"),
          stakePosition?.status === "available"
            ? stakePosition.accountCount
              ? keyValueRows([
                  [
                    "Delegated",
                    `${formatSol(stakePosition.delegatedLamports)} SOL`,
                    "emphasis",
                  ],
                  ["Accounts", String(stakePosition.accountCount)],
                  [
                    "States",
                    Object.entries(stakePosition.stateCounts)
                      .map(([state, count]) => `${state}: ${count}`)
                      .join(" · "),
                  ],
                  ...(stakePosition.localHints
                    ? [
                        [
                          "Local recovery hints",
                          String(stakePosition.localHints),
                        ] as const,
                      ]
                    : []),
                ])
              : "No on-chain stake accounts found."
            : "Unavailable — check RPC and retry status.",
        ]
      : ["Positions are not loaded until a wallet is selected."]),
    "",
    sectionTitle("WALLET DEFAULTS & REFRESH"),
    keyValueRows([
      ["Saved default", defaultLabel],
      ["Default keystore", defaultWalletHealth ?? "not configured"],
      [
        "Health",
        health.toUpperCase(),
        health === "healthy"
          ? "success"
          : health === "degraded"
            ? "warning"
            : "error",
      ],
      ["Updated", updatedAt],
    ]),
    ...(health === "degraded"
      ? [
          color(
            "Some data could not be loaded. Unavailable is not zero.",
            "warning",
          ),
        ]
      : health === "unavailable"
        ? [
            color(
              "RPC verification failed; chain balances were not loaded.",
              "error",
            ),
          ]
        : []),
  ];
  const human = lines
    .filter((line, index) => line !== "" || lines[index - 1] !== "")
    .join("\n");
  context.output.print(
    {
      ok: true,
      wallet: current,
      defaultWallet,
      defaultWalletHealth,
      cluster: context.config.cluster,
      rpcUrl,
      commitment: context.config.commitment,
      health,
      rpc: rpcState,
      balances,
      positions,
      updatedAt,
    },
    human,
  );
}

export function clearWalletCaches(context: CommandContext): void {
  context.completion.tokenMints = [];
  context.completion.stakeAccounts = [];
}

function refreshAfterWalletDeletion(
  context: CommandContext,
  walletId: string,
  registry: Awaited<ReturnType<typeof readRegistry>>,
): boolean {
  const wasCurrent = context.session.currentWalletId === walletId;
  if (wasCurrent) {
    context.session.currentWalletId = null;
    clearWalletCaches(context);
  }
  context.completion.walletAliases = registry.wallets.map(
    (wallet) => wallet.alias,
  );
  return wasCurrent;
}

export function displayRpcUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    if (parsed.pathname !== "/") parsed.pathname = "/[REDACTED]";
    return parsed
      .toString()
      .replace(/\/$/, parsed.pathname === "/" ? "" : "/[REDACTED]");
  } catch {
    return "[REDACTED]";
  }
}

function identity(entry: { id: string; alias: string; address: string }) {
  return { id: entry.id, alias: entry.alias, address: entry.address };
}
