import { address, assertIsSignature, type Signature } from "@solana/kit";
import { setSessionCluster } from "../config/config.js";
import { AppError } from "../errors/errors.js";
import { formatSol } from "../solana/amounts.js";
import { assertRpcCluster, rpcRequest } from "../solana/rpc.js";
import { knownTokenSymbols } from "../solana/known-tokens.js";
import {
  flagValue,
  hasFlag,
  parseCommand,
  rejectExtraArgs,
  type ParsedCommand,
} from "../shell/parser.js";
import { helpText, styleHelpText } from "../shell/help.js";
import { Output } from "../output/output.js";
import { transactionExplorerUrl } from "../output/transaction.js";
import { importWallet } from "./wallet-import.js";
import { migrateWallet, recoverWallet } from "./wallet-import.js";
import {
  status as showStatus,
  walletChangePassphrase,
  walletDefault,
  walletDelete,
  walletInfo,
  walletList,
  walletRename,
  walletUse,
} from "./wallet-management.js";
import { resolveWallet } from "../wallet/store.js";
import type { CommandContext } from "./context.js";
import {
  showAddress,
  showBalance,
  showConfig,
  showHistory,
  showTokenBalance,
  showTokenList,
  showTokenSymbols,
  showValidators,
} from "./read-only.js";
import { sendSol } from "./send.js";
import { sendToken } from "./token-send.js";
import { lendDeposit, lendStatus, lendWithdraw } from "./lending.js";
import {
  stakeCreate,
  stakeDeactivate,
  stakeList,
  stakeWithdraw,
} from "./staking.js";

/**
 * Central command dispatcher used by both interactive and one-shot commands.
 *
 * Validation belongs before the feature handlers: a handler should receive a
 * well-shaped command and then focus on Solana/protocol behavior. Write
 * handlers still perform their own domain validation, because an argument can
 * be syntactically valid and financially unsafe.
 */
export interface ExecutionResult {
  exit: boolean;
}

/** Validate a transaction identifier before asking the configured RPC. */
export function parseTransactionSignature(value: string): Signature {
  try {
    assertIsSignature(value);
    return value;
  } catch {
    throw new AppError(
      "Invalid Solana transaction signature; expected a base58-encoded 64-byte signature.",
      "InvalidSignatureError",
      2,
    );
  }
}

const TOP_LEVEL = [
  "help",
  "address",
  "balance",
  "wallet",
  "send",
  "token",
  "validators",
  "stake",
  "jupiter-lend",
  "tx",
  "set",
  "show",
  "history",
  "status",
  "clear",
  "exit",
  "quit",
];

export async function executeLine(
  context: CommandContext,
  raw: string,
): Promise<ExecutionResult> {
  return executeParsed(context, parseCommand(raw));
}

export async function executeParsed(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  validateFlags(command);
  const previousOutput = context.output;
  const previousWallet = context.commandWallet;
  context.output = new Output(
    {
      json: previousOutput.json || hasFlag(command, "json"),
      verbose: previousOutput.verbose,
    },
    () => context.commandWallet?.identity,
    () => context.config.cluster,
  );
  try {
    const name = command.name.toLowerCase();
    if (needsCurrentWallet(name, command.args[0])) {
      if (context.walletStoreError) throw context.walletStoreError;
      const id = context.session.currentWalletId;
      if (!id)
        throw new AppError(
          "No wallet is selected. Import one with `wallet import <alias>` or select one with `sol-wallet --wallet <alias>`.",
          "WalletNotSelected",
          2,
        );
      context.commandWallet = await resolveWallet(context.config.configDir, id);
    }
    if (name === "q") return { exit: true };
    if (name === "cls") {
      if (context.output.json)
        context.output.print({ ok: true, cleared: true });
      else process.stdout.write("\u001b[2J\u001b[H");
      return { exit: false };
    }
    if (name === "bal")
      return await executeParsed(context, { ...command, name: "balance" });
    // Keep the command wallet and output mode alive until the async handler
    // finishes; the finally block below restores both execution-scoped values.
    switch (name) {
      case "help": {
        const help = helpText(command.args.join(" ") || undefined);
        context.output.print({ ok: true, help }, styleHelpText(help));
        return { exit: false };
      }
      case "address":
        rejectExtraArgs(command, 0, "address");
        await showAddress(context);
        return { exit: false };
      case "balance":
        rejectExtraArgs(command, 0, "balance");
        await showBalance(context);
        return { exit: false };
      case "wallet":
        if (command.args.length === 0) {
          displayTopicHelp(context, "wallet");
          return { exit: false };
        }
        await executeWallet(context, command);
        return { exit: false };
      case "send":
        rejectExtraArgs(
          command,
          2,
          "send <destination> <amount> [--dry-run] [--yes]",
        );
        await sendSol(
          context,
          command.args[0]!,
          command.args[1]!,
          hasFlag(command, "dry-run") || context.session.dryRun,
          hasFlag(command, "yes") || context.session.yes,
        );
        return { exit: false };
      case "token":
        return await executeToken(context, command);
      case "validators":
        rejectExtraArgs(
          command,
          0,
          "validators [--limit <n>] [--include-delinquent] [--max-commission <percent>]",
        );
        await showValidators(context, {
          limit: parseOptionalInteger(flagValue(command, "limit"), "limit", 1),
          currentOnly:
            hasFlag(command, "current-only") ||
            !hasFlag(command, "include-delinquent"),
          maxCommission: parseOptionalNumber(
            flagValue(command, "max-commission"),
            "max-commission",
          ),
        });
        return { exit: false };
      case "set":
        return await executeSet(context, command);
      case "show":
        rejectExtraArgs(command, 1, "show config");
        if (command.args[0] !== "config")
          throw unknownCommand(`show ${command.args[0]}`);
        await showConfig(context);
        return { exit: false };
      case "history":
        rejectExtraArgs(command, 0, "history");
        await showHistory(context);
        return { exit: false };
      case "status":
        rejectExtraArgs(command, 0, "status");
        await showStatus(context);
        return { exit: false };
      case "clear":
        rejectExtraArgs(command, 0, "clear");
        if (context.output.json)
          context.output.print({ ok: true, cleared: true });
        else process.stdout.write("\u001b[2J\u001b[H");
        return { exit: false };
      case "exit":
      case "quit":
        rejectExtraArgs(command, 0, `${name}`);
        return { exit: true };
      case "tx":
        return await executeTx(context, command);
      case "stake":
        return await executeStake(context, command);
      case "jupiter-lend":
        return await executeJupiterLend(context, command);
      default:
        throw unknownCommand(command.name);
    }
  } finally {
    context.output = previousOutput;
    context.commandWallet = previousWallet;
  }
}

function needsCurrentWallet(name: string, subcommand?: string): boolean {
  if (["address", "balance", "send"].includes(name)) return true;
  if (name === "token")
    return ["list", "balance", "send"].includes(subcommand ?? "");
  if (name === "stake")
    return ["create", "list", "deactivate", "withdraw"].includes(
      subcommand ?? "",
    );
  if (name === "jupiter-lend")
    return ["status", "deposit", "withdraw"].includes(subcommand ?? "");
  return false;
}

async function executeWallet(
  context: CommandContext,
  command: ParsedCommand,
): Promise<void> {
  const [subcommand, ...args] = command.args;
  const usage =
    "wallet import <alias> [--keypair-file <path>] | wallet list | wallet info [<alias>] | wallet use <alias> | wallet default <alias> | wallet rename <old> <new> | wallet delete <alias> [--yes] | wallet change-passphrase <alias> | wallet migrate <alias> | wallet recover <uuid> <alias>";
  if (!subcommand) {
    displayTopicHelp(context, "wallet");
    return;
  }
  if (subcommand === "import") {
    if (args.length !== 1)
      throw new AppError(`Usage: ${usage}`, "ParseError", 2);
    await importWallet(context, args[0]!, flagValue(command, "keypair-file"));
    return;
  }
  if (flagValue(command, "keypair-file") !== undefined)
    throw new AppError(
      "--keypair-file is only valid for wallet import.",
      "ParseError",
      2,
    );
  const allowedWalletFlags = new Set(["json"]);
  if (subcommand === "delete") allowedWalletFlags.add("yes");
  for (const flag of command.flags.keys())
    if (!allowedWalletFlags.has(flag))
      throw new AppError(
        `Unknown wallet command flag: --${flag}`,
        "ParseError",
        2,
      );
  if (subcommand === "list") {
    if (args.length) throw new AppError("Usage: wallet list", "ParseError", 2);
    await walletList(context);
  } else if (subcommand === "info") {
    if (args.length > 1)
      throw new AppError("Usage: wallet info [<alias>]", "ParseError", 2);
    await walletInfo(context, args[0]);
  } else if (
    subcommand === "use" ||
    subcommand === "default" ||
    subcommand === "migrate"
  ) {
    if (args.length !== 1)
      throw new AppError(
        `Usage: wallet ${subcommand} <alias>`,
        "ParseError",
        2,
      );
    if (subcommand === "use") await walletUse(context, args[0]!);
    else if (subcommand === "default") await walletDefault(context, args[0]!);
    else {
      await migrateWallet(context, args[0]!);
      context.walletStoreError = undefined;
    }
  } else if (subcommand === "rename") {
    if (args.length !== 2)
      throw new AppError("Usage: wallet rename <old> <new>", "ParseError", 2);
    await walletRename(context, args[0]!, args[1]!);
  } else if (subcommand === "delete") {
    if (args.length !== 1)
      throw new AppError(
        "Usage: wallet delete <alias> [--yes]",
        "ParseError",
        2,
      );
    await walletDelete(
      context,
      args[0]!,
      hasFlag(command, "yes") || context.session.yes,
    );
  } else if (subcommand === "change-passphrase") {
    if (args.length !== 1)
      throw new AppError(
        "Usage: wallet change-passphrase <alias>",
        "ParseError",
        2,
      );
    await walletChangePassphrase(context, args[0]!);
  } else if (subcommand === "recover") {
    if (args.length !== 2)
      throw new AppError(
        "Usage: wallet recover <uuid> <alias>",
        "ParseError",
        2,
      );
    await recoverWallet(context, args[0]!, args[1]!);
    context.walletStoreError = undefined;
  } else {
    throw unknownCommand(`wallet ${subcommand}`);
  }
}

async function executeStake(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  const subcommand = command.args[0];
  if (!subcommand) {
    displayTopicHelp(context, "stake");
    return { exit: false };
  }
  const args = { ...command, args: command.args.slice(1) };
  if (subcommand === "create") await stakeCreate(context, args);
  else if (subcommand === "list") {
    rejectExtraArgs(args, 0, "stake list");
    await stakeList(context);
  } else if (subcommand === "deactivate") await stakeDeactivate(context, args);
  else if (subcommand === "withdraw") await stakeWithdraw(context, args);
  else throw unknownCommand(`stake ${subcommand ?? ""}`.trim());
  return { exit: false };
}

async function executeToken(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  const subcommand = command.args[0];
  if (!subcommand) {
    displayTopicHelp(context, "token");
    return { exit: false };
  }
  const args = { ...command, args: command.args.slice(1) };
  if (subcommand === "list") {
    rejectExtraArgs(args, 0, "token list");
    await showTokenList(context, hasFlag(command, "accounts"));
  } else if (subcommand === "symbols") {
    rejectExtraArgs(args, 0, "token symbols");
    await showTokenSymbols(context);
  } else if (subcommand === "balance") {
    rejectExtraArgs(args, 1, "token balance <mint|symbol>");
    await showTokenBalance(context, args.args[0]!);
  } else if (subcommand === "send") {
    rejectExtraArgs(
      args,
      3,
      "token send <mint|symbol> <destination> <amount> [--dry-run] [--yes]",
    );
    await sendToken(
      context,
      args.args[0]!,
      args.args[1]!,
      args.args[2]!,
      hasFlag(command, "dry-run") || context.session.dryRun,
      hasFlag(command, "yes") || context.session.yes,
    );
  } else throw unknownCommand(`token ${subcommand ?? ""}`.trim());
  return { exit: false };
}

async function executeJupiterLend(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  const subcommand = command.args[0];
  if (!subcommand) {
    displayTopicHelp(context, "jupiter-lend");
    return { exit: false };
  }
  const args = { ...command, args: command.args.slice(1) };
  if (subcommand === "status") {
    rejectExtraArgs(args, 0, "jupiter-lend status");
    await lendStatus(context);
  } else if (subcommand === "deposit") {
    rejectExtraArgs(
      args,
      1,
      "jupiter-lend deposit <amount> [--dry-run] [--yes]",
    );
    await lendDeposit(context, args);
  } else if (subcommand === "withdraw") {
    await lendWithdraw(context, args);
  } else throw unknownCommand(`jupiter-lend ${subcommand ?? ""}`.trim());
  return { exit: false };
}

async function executeSet(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  rejectExtraArgs(
    command,
    2,
    "set cluster <mainnet|devnet> | set rpc-url <url> | set commitment <level>",
  );
  const field = command.args[0];
  const value = command.args[1]!;
  if (field === "cluster" && (value === "mainnet" || value === "devnet")) {
    setSessionCluster(context.config, value);
    context.completion.tokenMints = [];
    context.completion.knownTokens = knownTokenSymbols(value);
    context.completion.stakeAccounts = [];
    context.completion.recentValidators = [];
    context.output.print(
      { ok: true, cluster: value, rpcUrl: context.config.rpcUrl },
      `CLUSTER CHANGED TO ${value.toUpperCase()} (session only)\nRPC URL: ${context.config.rpcUrl}`,
    );
  } else if (field === "rpc-url") {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("unsupported protocol");
    } catch {
      throw new AppError("RPC URL must use http or https.", "ConfigError", 2);
    }
    context.config.rpcUrl = value;
    // The user explicitly accepts displaying and retaining the supplied RPC
    // URL for this session; status and show-config use separate redaction.
    context.completion.tokenMints = [];
    context.completion.stakeAccounts = [];
    context.completion.recentValidators = [];
    context.output.print(
      { ok: true, rpcUrl: value },
      `RPC URL changed for this session: ${value}`,
    );
  } else if (
    field === "commitment" &&
    ["processed", "confirmed", "finalized"].includes(value)
  ) {
    context.config.commitment = value as typeof context.config.commitment;
    context.completion.tokenMints = [];
    context.completion.stakeAccounts = [];
    context.completion.recentValidators = [];
    context.output.print(
      { ok: true, commitment: value },
      `Commitment changed for this session: ${value}`,
    );
  } else throw new AppError("Invalid session setting.", "ConfigError", 2);
  return { exit: false };
}

async function executeTx(
  context: CommandContext,
  command: ParsedCommand,
): Promise<ExecutionResult> {
  if (command.args.length === 0) {
    displayTopicHelp(context, "tx");
    return { exit: false };
  }
  rejectExtraArgs(command, 2, "tx inspect <signature>");
  if (command.args[0] !== "inspect")
    throw unknownCommand(`tx ${command.args[0]}`);
  const signature = parseTransactionSignature(command.args[1]!);
  const rpc = context.getClient().rpc;
  await assertRpcCluster(rpc, context.config.cluster);
  const response = await rpcRequest(
    rpc.getTransaction(signature, {
      commitment: context.config.commitment,
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    }),
    "transaction lookup",
  );
  context.output.print(
    { ok: true, signature, transaction: response },
    formatTransactionSummary(signature, response, context.config.cluster),
  );
  return { exit: false };
}

function formatTransactionSummary(
  signature: string,
  response: unknown,
  cluster: string,
): string {
  if (!response)
    return `Transaction not found on ${cluster}. Check that the signature and network are correct, or inspect the complete response with --json.`;
  const transaction = response as {
    slot?: bigint | number | string;
    blockTime?: bigint | number | null;
    transaction?: {
      message?: {
        accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
        header?: { numRequiredSignatures?: number };
        instructions?: unknown[];
      };
    };
    meta?: { err?: unknown; fee?: bigint | number | string | null } | null;
  };
  const metadata = transaction.meta;
  const message = transaction.transaction?.message;
  const accountKeys = message?.accountKeys ?? [];
  const annotatedSigners = accountKeys
    .filter((key) => typeof key !== "string" && key.signer)
    .map((key) => (typeof key === "string" ? key : (key.pubkey ?? "unknown")));
  const signers = annotatedSigners.length
    ? annotatedSigners
    : accountKeys
        .slice(0, message?.header?.numRequiredSignatures ?? 0)
        .map((key) =>
          typeof key === "string" ? key : (key.pubkey ?? "unknown"),
        );
  const fee = metadata?.fee;
  const lines = [
    "Transaction found",
    `Network: ${cluster}`,
    `Result: ${metadata ? (metadata.err ? "failed on-chain" : "successful") : "execution details unavailable"}`,
    ...(transaction.slot !== undefined ? [`Slot: ${transaction.slot}`] : []),
    ...(transaction.blockTime !== undefined && transaction.blockTime !== null
      ? [
          `Block time: ${new Date(Number(transaction.blockTime) * 1000).toISOString()}`,
        ]
      : []),
    ...(fee !== undefined && fee !== null
      ? [`Network fee: ${formatSol(BigInt(fee))} SOL`]
      : []),
    `Signers: ${signers.length ? signers.join(", ") : "not provided by RPC"}`,
    `Instructions: ${transaction.transaction?.message?.instructions?.length ?? "unknown"}`,
    `Signature: ${signature}`,
    `Explorer: ${transactionExplorerUrl(signature, cluster)}`,
    "Use --json for the complete RPC transaction details.",
  ];
  if (metadata?.err)
    lines.splice(3, 0, `On-chain error: ${JSON.stringify(metadata.err)}`);
  return lines.join("\n");
}

function displayTopicHelp(context: CommandContext, topic: string): void {
  const help = helpText(topic);
  context.output.print({ ok: true, help }, styleHelpText(help));
}

function parseOptionalInteger(
  value: string | undefined,
  label: string,
  minimum = 0,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new AppError(
      `${label} must be a non-negative integer.`,
      "ParseError",
      2,
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new AppError(`${label} is too large.`, "ParseError", 2);
  if (parsed < minimum)
    throw new AppError(
      `${label} must be at least ${minimum}.`,
      "ParseError",
      2,
    );
  return parsed;
}

function parseOptionalNumber(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)
    throw new AppError(`${label} must be between 0 and 100.`, "ParseError", 2);
  return parsed;
}

function unknownCommand(value: string): AppError {
  const suggestion = [...TOP_LEVEL].sort(
    (a, b) => levenshtein(value, a) - levenshtein(value, b),
  )[0];
  const suffix =
    suggestion && levenshtein(value, suggestion) <= 3
      ? `\nDid you mean: ${suggestion}?`
      : "";
  return new AppError(`Unknown command: ${value}${suffix}`, "ParseError", 2);
}

function validateFlags(command: ParsedCommand): void {
  const name = command.name.toLowerCase();
  const subcommand = command.args[0]?.toLowerCase();
  const allowed = new Set(["json"]);
  if (name === "send") {
    allowed.add("dry-run");
    allowed.add("yes");
  } else if (name === "validators") {
    allowed.add("limit");
    allowed.add("current-only");
    allowed.add("include-delinquent");
    allowed.add("max-commission");
  } else if (name === "wallet" && subcommand === "import") {
    allowed.add("keypair-file");
  } else if (name === "wallet" && subcommand === "delete") {
    allowed.add("yes");
  } else if (name === "token" && subcommand === "list") {
    allowed.add("accounts");
  } else if (name === "token" && subcommand === "send") {
    allowed.add("dry-run");
    allowed.add("yes");
  } else if (name === "jupiter-lend") {
    if (subcommand === "deposit" || subcommand === "withdraw") {
      allowed.add("dry-run");
      allowed.add("yes");
    }
    if (subcommand === "withdraw") allowed.add("all");
  } else if (name === "stake") {
    if (subcommand === "create") allowed.add("validator");
    if (subcommand === "withdraw") allowed.add("amount");
    if (["create", "deactivate", "withdraw"].includes(subcommand ?? "")) {
      allowed.add("dry-run");
      allowed.add("yes");
    }
  }
  for (const flag of command.flags.keys())
    if (!allowed.has(flag))
      throw new AppError(`Unknown flag: --${flag}`, "ParseError", 2);

  const booleanFlags = new Set([
    "json",
    "dry-run",
    "yes",
    "current-only",
    "include-delinquent",
    "accounts",
    "all",
  ]);
  const valueFlags = new Set([
    "limit",
    "max-commission",
    "keypair-file",
    "validator",
    "amount",
  ]);
  for (const [flag, value] of command.flags) {
    if (booleanFlags.has(flag) && value !== true)
      throw new AppError(`--${flag} does not accept a value.`, "ParseError", 2);
    if (valueFlags.has(flag) && value === true)
      throw new AppError(`--${flag} requires a value.`, "ParseError", 2);
  }
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[right.length]!;
}
