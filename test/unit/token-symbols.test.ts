import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandContext } from "../../src/commands/context.js";
import { executeLine } from "../../src/commands/execute.js";
import { createRegistryEntry } from "../../src/wallet/store.js";
import { TOKEN_PROGRAM_ADDRESS } from "../../src/solana/tokens.js";

const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DESTINATION = "11111111111111111111111111111112";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

describe("token symbols and symbol resolution in commands", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists mainnet symbols without a wallet or RPC", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sol-symbols-"));
    const output: string[] = [];
    try {
      const context = createCommandContext(
        {
          configDir: directory,
          cluster: "mainnet",
          rpcUrl: "https://rpc.example.invalid",
          commitment: "confirmed",
        },
        { json: false, verbose: false },
      );
      context.getClient = () => {
        throw new Error("token symbols must not contact RPC");
      };
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await executeLine(context, "token symbols");
      const rendered = output.join("");
      expect(rendered).toContain("TOKEN SYMBOLS · MAINNET");
      expect(rendered).toContain("USDC");
      expect(rendered).toContain("USDT");
      expect(rendered).toContain(USDC_MAINNET);
      expect(rendered).not.toContain("(test)");

      output.length = 0;
      await executeLine(context, "token symbols --json");
      const payload = JSON.parse(output.join(""));
      expect(payload.symbols).toMatchObject([
        {
          symbol: "usdc",
          displaySymbol: "USDC",
          mint: USDC_MAINNET,
          decimals: 6,
        },
        { symbol: "usdt", displaySymbol: "USDT", decimals: 6 },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks the devnet USDC mapping as a test-only symbol", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sol-symbols-"));
    const output: string[] = [];
    try {
      const context = createCommandContext(
        {
          configDir: directory,
          cluster: "devnet",
          rpcUrl: "https://rpc.example.invalid",
          commitment: "confirmed",
        },
        { json: true, verbose: false },
      );
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await executeLine(context, "token symbols --json");
      const payload = JSON.parse(output.join(""));
      expect(payload.symbols).toMatchObject([
        { symbol: "usdc", mint: USDC_DEVNET, testOnly: true },
      ]);
      expect(payload.symbols).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves a symbol when reading a token balance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sol-balance-"));
    const output: string[] = [];
    try {
      const wallet = await registerFixture(directory);
      const context = createCommandContext(
        {
          configDir: directory,
          cluster: "devnet",
          rpcUrl: "https://rpc.example.invalid",
          commitment: "confirmed",
        },
        { json: true, verbose: false },
        { currentWalletId: wallet.id },
      );
      context.getClient = () =>
        ({
          rpc: {
            getGenesisHash: () => request(DEVNET_GENESIS),
            getTokenAccountsByOwner: (
              _owner: string,
              filter: { programId: string },
            ) =>
              request({
                value:
                  String(filter.programId) === String(TOKEN_PROGRAM_ADDRESS)
                    ? [
                        {
                          pubkey: "11111111111111111111111111111115",
                          account: {
                            data: {
                              parsed: {
                                info: {
                                  mint: USDC_DEVNET,
                                  owner: wallet.address,
                                  tokenAmount: {
                                    amount: "2500000",
                                    decimals: 6,
                                    uiAmountString: "2.5",
                                  },
                                },
                              },
                            },
                          },
                        },
                      ]
                    : [],
              }),
          },
        }) as never;
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await executeLine(context, "token balance usdc --json");
      const payload = JSON.parse(output.join(""));
      expect(payload).toMatchObject({
        ok: true,
        mint: USDC_DEVNET,
        symbol: "USDC",
        decimals: 6,
        rawAmount: "2500000",
        amount: "2.5",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves a symbol for a token transfer and verifies registry metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sol-send-"));
    const output: string[] = [];
    try {
      const wallet = await registerFixture(directory);
      const context = createCommandContext(
        {
          configDir: directory,
          cluster: "mainnet",
          rpcUrl: "https://rpc.example.invalid",
          commitment: "confirmed",
        },
        { json: true, verbose: false },
        { currentWalletId: wallet.id },
      );
      const unlock = vi.fn(async () => {
        throw new Error("dry-run must not unlock");
      });
      context.readPassphrase = unlock;
      context.getClient = () =>
        ({
          rpc: {
            getGenesisHash: () => request(MAINNET_GENESIS),
            getAccountInfo: (account: string) =>
              account === USDC_MAINNET
                ? request({
                    value: {
                      owner: String(TOKEN_PROGRAM_ADDRESS),
                      data: { parsed: { info: { decimals: 6 } } },
                    },
                  })
                : request({ value: null }),
            getTokenAccountsByOwner: (
              _owner: string,
              filter: { programId: string },
            ) =>
              request({
                value:
                  String(filter.programId) === String(TOKEN_PROGRAM_ADDRESS)
                    ? [
                        {
                          pubkey: "11111111111111111111111111111115",
                          account: {
                            data: {
                              parsed: {
                                info: {
                                  mint: USDC_MAINNET,
                                  owner: wallet.address,
                                  tokenAmount: {
                                    amount: "2000000",
                                    decimals: 6,
                                    uiAmountString: "2",
                                  },
                                },
                              },
                            },
                          },
                        },
                      ]
                    : [],
              }),
            getMinimumBalanceForRentExemption: () => request(2_039_280n),
            getLatestBlockhash: () =>
              request({
                value: {
                  blockhash: "11111111111111111111111111111111",
                  lastValidBlockHeight: 200n,
                },
              }),
            getFeeForMessage: () => request({ value: 5_000n }),
            getBalance: () => request({ value: 1_000_000_000n }),
            simulateTransaction: () =>
              request({ value: { err: null, logs: [] } }),
          },
        }) as never;
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await executeLine(
        context,
        `token send usdc ${DESTINATION} 1 --dry-run --json`,
      );
      const payload = JSON.parse(output.join(""));
      expect(payload.status).toBe("simulated");
      expect(payload.preflight).toMatchObject({
        symbol: "USDC",
        mint: USDC_MAINNET,
        program: "spl-token",
        decimals: 6,
        amount: "1",
      });
      expect(unlock).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to send when on-chain metadata contradicts the registry", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sol-send-"));
    try {
      const wallet = await registerFixture(directory);
      const context = createCommandContext(
        {
          configDir: directory,
          cluster: "mainnet",
          rpcUrl: "https://rpc.example.invalid",
          commitment: "confirmed",
        },
        { json: true, verbose: false },
        { currentWalletId: wallet.id },
      );
      context.getClient = () =>
        ({
          rpc: {
            getGenesisHash: () => request(MAINNET_GENESIS),
            getAccountInfo: (account: string) =>
              account === USDC_MAINNET
                ? request({
                    value: {
                      owner: String(TOKEN_PROGRAM_ADDRESS),
                      data: { parsed: { info: { decimals: 9 } } },
                    },
                  })
                : request({ value: null }),
          },
        }) as never;
      await expect(
        executeLine(context, `token send usdc ${DESTINATION} 1 --dry-run`),
      ).rejects.toThrow(/local token registry expects 6/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function registerFixture(configDir: string) {
  const source = path.join(configDir, "input.json");
  await writeFile(
    source,
    `${JSON.stringify({
      version: 1,
      kind: "solana-private-key",
      publicKey: "FAe4sisG95oZ42w7buUn5qEE4TAnfTTFPiguZUHmhiF",
      kdf: {
        name: "argon2id",
        memoryKiB: 65536,
        iterations: 3,
        parallelism: 1,
        salt: "AA==",
      },
      cipher: { name: "aes-256-gcm", iv: "AA==", tag: "AA==" },
      ciphertext: "AA==",
    })}\n`,
    { mode: 0o600 },
  );
  const registered = await createRegistryEntry(
    configDir,
    "daily",
    "FAe4sisG95oZ42w7buUn5qEE4TAnfTTFPiguZUHmhiF",
    source,
  );
  return registered.entry;
}

function request<T>(value: T) {
  return { send: async () => value };
}
