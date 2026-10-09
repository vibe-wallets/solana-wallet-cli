import { color } from "../output/terminal.js";

const HELP: Record<string, string> = {
  "": `COMMANDS

WALLETS
  wallet list                 List wallets and mark current/default
  wallet info [alias]         Show a wallet's public address and health
  wallet use <alias>          Select a wallet for this process
  wallet default <alias>      Choose the default for future processes
  wallet import <alias>       Import a keypair into encrypted local storage
  wallet rename <old> <new>   Rename a local wallet alias
  wallet delete <alias> [--yes] (delete local keystore; asks first)
  wallet change-passphrase <alias>
  wallet migrate <alias>      Migrate an existing keystore.json
  wallet recover <uuid> <alias>

BALANCES AND TRANSFERS
  status                      Refresh wallet, token, and position overview
  address | balance           Show the selected address or SOL balance
  token list [--accounts]     List tokens; optionally show token accounts
  token symbols               List built-in token symbols for this network
  token balance <mint|symbol> Show a token balance by mint or symbol
  send <destination> <amount> Send SOL
  token send <mint|symbol> <to> <amount> [--dry-run] [--yes]

STAKING AND LENDING
  validators                  Browse current validators
  stake                       Create, list, deactivate, or withdraw stake
  jupiter-lend                View or manage Jupiter Lend USDC

SETTINGS AND UTILITIES
  set cluster <mainnet|devnet>
  set rpc-url <url> | set commitment <level>
  show config | tx inspect <signature> | history | clear
  help [topic] | exit

Use help wallet, help status, help token, help stake, or help jupiter-lend
for syntax and options. Startup: sol-wallet [--wallet <alias>] [--cluster <network>] [-c <command>].
See sol-wallet --help for startup flags.`,
  wallet: `WALLET COMMANDS
wallet import <alias> [--keypair-file <path>]
wallet list
wallet info [<alias>]
wallet use <alias>                 (current process only)
wallet default <alias>             (future processes)
wallet rename <old> <new>
wallet delete <alias> [--yes]      (local keystore only; --yes skips confirmation)
wallet change-passphrase <alias>  (hidden prompts; old and new passphrases)
wallet migrate <alias>             (existing keystore.json)
wallet recover <uuid> <alias>      (orphan UUID keystore)

Use --wallet <alias> at startup to select a wallet for one process.
Aliases are local names; transactions always show and use the full address.
Deleting a wallet never removes chain assets. Separate backups and stake recovery hints remain.`,
  show: "show config",
  address:
    "address\nShows the selected wallet address without unlocking the keystore.",
  balance:
    "balance\nShows the selected wallet's SOL balance. Use --verbose to include lamports.",
  send: "send <destination> <amount> [--dry-run] [--yes] [--json]",
  token:
    "token list [--accounts]\n  Aggregates balances by mint; --accounts shows each token account.\ntoken symbols\n  Lists built-in symbols and their canonical mint addresses for this network.\ntoken balance <mint|symbol>\ntoken send <mint|symbol> <destination> <amount> [--dry-run] [--yes]\n\nSymbols such as usdc are local aliases for a fixed mint address, not on-chain metadata. The full mint is always shown and verified against chain data before a transfer.",
  validators:
    "validators [--limit <n>] [--include-delinquent] [--max-commission <percent>]\nDelinquent validators are excluded by default; use --include-delinquent to include them.",
  stake:
    "stake create <amount> --validator <vote-account> [--dry-run] [--yes]\nstake list\nstake deactivate <stake-account> [--dry-run] [--yes]\nstake withdraw <stake-account> [--amount <amount>] [--dry-run] [--yes]",
  "jupiter-lend":
    "jupiter-lend status\njupiter-lend deposit <amount> [--dry-run] [--yes]\njupiter-lend withdraw <amount> [--dry-run] [--yes]\njupiter-lend withdraw --all [--dry-run] [--yes]",
  tx: "tx inspect <signature>\nShows a human summary; add --json to see the complete RPC response.",
  set: "set cluster <mainnet|devnet>\nset rpc-url <url>\nset commitment <processed|confirmed|finalized>",
  status:
    "status\nChecks the configured RPC/network and shows liquid SOL and non-zero token balances, followed by positions such as Jupiter Lend and native stake. Failed reads are marked unavailable, never zero. Use show config for local configuration details.",
};

/** Human-oriented command index and focused syntax help for the REPL. */
export function helpText(topic?: string): string {
  if (!topic) return HELP[""]!;
  return (
    HELP[topic] ?? `No detailed help is available for \`${topic}\`. Try help.`
  );
}

/** Add visual hierarchy to help output while leaving its content unchanged. */
export function styleHelpText(value: string): string {
  const headings = new Set([
    "COMMANDS",
    "WALLETS",
    "BALANCES AND TRANSFERS",
    "STAKING AND LENDING",
    "SETTINGS AND UTILITIES",
    "WALLET COMMANDS",
  ]);
  return value
    .split("\n")
    .map((line, index) =>
      headings.has(line) || (index === 0 && !line.startsWith(" "))
        ? color(line, "heading")
        : line,
    )
    .join("\n");
}
