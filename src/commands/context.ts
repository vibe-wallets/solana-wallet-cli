import type { AppConfig } from "../config/config.js";
import { createClient, type SolanaClient } from "../solana/client.js";
import { Output, type OutputOptions } from "../output/output.js";
import type { CompletionCache } from "../shell/completion.js";
import { readSecret } from "../shell/prompt.js";
import { knownTokenSymbols } from "../solana/known-tokens.js";
import type { SelectedWallet } from "../wallet/store.js";
import type { AppError } from "../errors/errors.js";

/**
 * Dependencies and session state shared by every command handler.
 *
 * A handler receives this object instead of reaching into process globals. In
 * addition to making tests easier, this keeps configuration, output mode, and
 * the passphrase prompt consistent between the REPL and `-c` mode.
 */
export interface CommandContext {
  config: AppConfig;
  output: Output;
  completion: CompletionCache;
  session: {
    dryRun: boolean;
    yes: boolean;
    verbose: boolean;
    currentWalletId: string | null;
    executionMode: "interactive" | "piped" | "oneshot";
  };
  commandWallet?: SelectedWallet;
  walletStoreError?: AppError;
  getClient(): SolanaClient;
  readPassphrase(): Promise<string>;
}

export function createCommandContext(
  config: AppConfig,
  outputOptions: OutputOptions,
  session: Partial<CommandContext["session"]> = {},
): CommandContext {
  let context!: CommandContext;
  context = {
    config,
    output: new Output(
      outputOptions,
      () => context.commandWallet?.identity,
      () => config.cluster,
    ),
    completion: {
      tokenMints: [],
      knownTokens: knownTokenSymbols(config.cluster),
      stakeAccounts: [],
      recentValidators: [],
      walletAliases: [],
    },
    session: {
      dryRun: session.dryRun ?? false,
      yes: session.yes ?? false,
      verbose: session.verbose ?? outputOptions.verbose,
      currentWalletId: session.currentWalletId ?? null,
      executionMode: session.executionMode ?? "interactive",
    },
    getClient: () => createClient(config),
    readPassphrase: () => {
      const selected = context.commandWallet?.identity;
      const label = selected
        ? `${selected.alias} (${String(selected.address).slice(0, 4)}…${String(selected.address).slice(-4)})`
        : "wallet";
      return readSecret(`Passphrase for ${label}: `);
    },
  };
  return context;
}
