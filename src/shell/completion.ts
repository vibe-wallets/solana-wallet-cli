import { tokenize } from "./parser.js";

export interface CompletionCache {
  tokenMints: string[];
  knownTokens: string[];
  stakeAccounts: string[];
  recentValidators: string[];
  walletAliases: string[];
}

const topLevel = [
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
const nested: Record<string, string[]> = {
  wallet: [
    "import",
    "list",
    "info",
    "use",
    "default",
    "rename",
    "delete",
    "change-passphrase",
    "migrate",
    "recover",
  ],
  token: ["list", "symbols", "balance", "send"],
  stake: ["create", "list", "deactivate", "withdraw"],
  "jupiter-lend": ["status", "deposit", "withdraw"],
  tx: ["inspect"],
  set: ["cluster", "rpc-url", "commitment"],
  show: ["config"],
};
const flags: Record<string, string[]> = {
  "wallet delete": ["--yes", "--json"],
  "wallet change-passphrase": ["--json"],
  validators: [
    "--limit",
    "--include-delinquent",
    "--max-commission",
    "--current-only",
    "--json",
  ],
  "token list": ["--accounts", "--json"],
  send: ["--dry-run", "--yes", "--json"],
  "token send": ["--dry-run", "--yes", "--json"],
  "stake create": ["--validator", "--dry-run", "--yes", "--json"],
  "stake deactivate": ["--dry-run", "--yes", "--json"],
  "stake withdraw": ["--amount", "--dry-run", "--yes", "--json"],
  "jupiter-lend deposit": ["--dry-run", "--yes", "--json"],
  "jupiter-lend withdraw": ["--all", "--dry-run", "--yes", "--json"],
};

export function completeLine(
  line: string,
  cache: CompletionCache,
): [string[], string] {
  const trailingSpace = /\s$/.test(line);
  const parts = tokenizeForCompletion(line);
  const partial = trailingSpace ? "" : (parts.pop() ?? "");
  const path = parts.join(" ");
  let candidates: string[] = [];
  if (!parts.length) candidates = topLevel;
  else if (parts.length === 1 && nested[parts[0]!] !== undefined)
    candidates = nested[parts[0]!]!;
  else {
    const command = parts.slice(0, 2).join(" ");
    if (partial.startsWith("--"))
      candidates = flags[command] ??
        flags[parts[0]!] ?? ["--json", "--dry-run", "--yes"];
    else if (command === "stake create" && parts.at(-1) === "--validator")
      candidates = cache.recentValidators;
    else if (path.includes("--"))
      candidates = flags[command] ??
        flags[parts[0]!] ?? ["--json", "--dry-run", "--yes"];
    else if (
      parts[0] === "wallet" &&
      ["use", "default", "info", "delete", "change-passphrase"].includes(
        parts[1] ?? "",
      )
    )
      candidates = cache.walletAliases;
    else if (command === "token balance" || command === "token send")
      candidates = [...cache.knownTokens, ...cache.tokenMints];
    else if (command === "stake deactivate" || command === "stake withdraw")
      candidates = cache.stakeAccounts;
  }
  const hits = candidates.filter((candidate) => candidate.startsWith(partial));
  return [hits, partial];
}

function tokenizeForCompletion(input: string): string[] {
  try {
    return tokenize(input);
  } catch {
    return input.trim().split(/\s+/).filter(Boolean);
  }
}
