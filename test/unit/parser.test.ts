import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { completeLine } from "../../src/shell/completion.js";
import {
  appendHistory,
  isSafeHistoryLine,
  readHistory,
} from "../../src/shell/history.js";
import { parseCommand, tokenize } from "../../src/shell/parser.js";
import { helpText } from "../../src/shell/help.js";
import { normalizeSecretKey } from "../../src/wallet/keystore.js";

describe("wallet shell parser and completion", () => {
  it("supports quotes, escaped whitespace, and flag=value", () => {
    expect(tokenize('send "destination value" 1.25')).toEqual([
      "send",
      "destination value",
      "1.25",
    ]);
    const command = parseCommand("validators --limit=10 --current-only");
    expect(command.args).toEqual([]);
    expect(command.flags.get("limit")).toBe("10");
    expect(command.flags.get("current-only")).toBe(true);
  });

  it("completes nested commands and cached public values", () => {
    const topLevel = completeLine("tok", {
      tokenMints: [],
      knownTokens: [],
      stakeAccounts: [],
      recentValidators: [],
      walletAliases: [],
    });
    expect(topLevel[0]).toContain("token");
    expect(topLevel[1]).toBe("tok");
    expect(
      completeLine("token ", {
        tokenMints: [],
        knownTokens: [],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toEqual(["list", "symbols", "balance", "send"]);
    expect(
      completeLine("token balance ", {
        tokenMints: ["Mint111"],
        knownTokens: [],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toEqual(["Mint111"]);
    expect(
      completeLine("token balance ", {
        tokenMints: ["Mint111"],
        knownTokens: ["usdc", "usdt"],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toEqual(["usdc", "usdt", "Mint111"]);
    expect(
      completeLine("stake ", {
        tokenMints: [],
        knownTokens: [],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toEqual(["create", "list", "deactivate", "withdraw"]);
    expect(
      completeLine("jupiter-lend ", {
        tokenMints: [],
        knownTokens: [],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toEqual(["status", "deposit", "withdraw"]);
    expect(
      completeLine("wallet ", {
        tokenMints: [],
        knownTokens: [],
        stakeAccounts: [],
        recentValidators: [],
        walletAliases: [],
      })[0],
    ).toContain("change-passphrase");
    const walletCache = {
      tokenMints: [],
      knownTokens: [],
      stakeAccounts: [],
      recentValidators: [],
      walletAliases: ["daily", "savings"],
    };
    expect(completeLine("wallet delete ", walletCache)[0]).toEqual(
      walletCache.walletAliases,
    );
    expect(completeLine("wallet delete --", walletCache)[0]).toContain("--yes");
    expect(completeLine("wallet change-passphrase ", walletCache)[0]).toEqual(
      walletCache.walletAliases,
    );
  });

  it("completes supported validators and token-list flags", () => {
    const cache = {
      tokenMints: [],
      knownTokens: [],
      stakeAccounts: [],
      recentValidators: [],
      walletAliases: [],
    };
    expect(completeLine("validators --inc", cache)[0]).toContain(
      "--include-delinquent",
    );
    expect(completeLine("token list --acc", cache)[0]).toEqual(["--accounts"]);
  });

  it("completes cached validators after --validator and retains flag completion", () => {
    const cache = {
      tokenMints: [],
      knownTokens: [],
      stakeAccounts: [],
      recentValidators: ["Vote111", "Vote222"],
      walletAliases: [],
    };
    expect(completeLine("stake create 1 --validator ", cache)[0]).toEqual(
      cache.recentValidators,
    );
    expect(completeLine("stake create 1 --validator Vote1", cache)[0]).toEqual([
      "Vote111",
    ]);
    expect(completeLine("stake create 1 --val", cache)[0]).toContain(
      "--validator",
    );
    expect(completeLine("stake create 1 --validator --", cache)[0]).toContain(
      "--dry-run",
    );
    expect(
      completeLine("stake create 1 --validator Vote111 ", cache)[0],
    ).toEqual(["--validator", "--dry-run", "--yes", "--json"]);
  });

  it("keeps general and topic help aligned with the wallet and status commands", () => {
    expect(helpText()).toContain("wallet recover <uuid> <alias>");
    expect(helpText()).toContain("wallet delete <alias> [--yes]");
    expect(helpText("wallet")).toContain("wallet migrate <alias>");
    expect(helpText("wallet")).toContain("wallet change-passphrase <alias>");
    expect(helpText("status")).toContain("non-zero token balances");
    expect(helpText("token")).toContain("--accounts");
  });

  it("filters secret-looking lines from history", () => {
    expect(isSafeHistoryLine("balance")).toBe(true);
    expect(isSafeHistoryLine("wallet import --password nope")).toBe(false);
    expect(isSafeHistoryLine("wallet change-passphrase savings")).toBe(false);
    expect(isSafeHistoryLine("wallet delete savings --yes")).toBe(true);
    expect(
      isSafeHistoryLine(
        "set rpc-url https://user:api-token@rpc.example/abc123",
      ),
    ).toBe(true);
    expect(isSafeHistoryLine("")).toBe(false);
  });

  it("recalls public addresses and signatures in known command arguments", () => {
    const address = bs58.encode(Buffer.alloc(32, 11));
    const signature = bs58.encode(Buffer.alloc(64, 17));
    expect(isSafeHistoryLine(`send ${address} 1`)).toBe(true);
    expect(isSafeHistoryLine(`token balance ${address}`)).toBe(true);
    expect(isSafeHistoryLine(`token send ${address} ${address} 1`)).toBe(true);
    expect(isSafeHistoryLine(`stake create 1 --validator ${address}`)).toBe(
      true,
    );
    expect(isSafeHistoryLine(`stake create 1 --validator=${address}`)).toBe(
      true,
    );
    expect(isSafeHistoryLine(`stake deactivate ${address}`)).toBe(true);
    expect(isSafeHistoryLine(`stake withdraw ${address}`)).toBe(true);
    expect(isSafeHistoryLine(`tx inspect ${signature} --json`)).toBe(true);
    expect(isSafeHistoryLine(address)).toBe(false);
    expect(isSafeHistoryLine(`unknown ${address}`)).toBe(false);
  });

  it("continues to exclude actual pasted keypairs from history", async () => {
    const privateKey = await normalizeSecretKey(new Uint8Array(32).fill(23));
    try {
      const encoded = bs58.encode(privateKey);
      expect(isSafeHistoryLine(encoded)).toBe(false);
      expect(isSafeHistoryLine(`tx inspect ${encoded}`)).toBe(false);
      expect(isSafeHistoryLine(`stake create 1 --validator=${encoded}`)).toBe(
        false,
      );
    } finally {
      privateKey.fill(0);
    }
  });

  it("caps persisted history at the newest 1,000 safe entries", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sol-wallet-history-"),
    );
    try {
      for (let index = 0; index < 1_005; index += 1)
        await appendHistory(directory, `command-${index}`);
      const entries = await readHistory(directory);
      expect(entries).toHaveLength(1_000);
      expect(entries[0]).toBe("command-5");
      expect(entries.at(-1)).toBe("command-1004");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
