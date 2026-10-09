import { describe, expect, it } from "vitest";
import {
  KNOWN_TOKENS,
  USDC_MAINNET_MINT,
  knownTokenDeployments,
  knownTokenForMint,
  knownTokenSymbols,
  resolveTokenIdentifier,
} from "../../src/solana/known-tokens.js";
import {
  JUPITER_LEND_USDC_DECIMALS,
  JUPITER_LEND_USDC_MINT,
} from "../../src/integrations/jupiter-lend/adapter.js";

describe("code-owned token symbol registry", () => {
  it("shares the canonical mainnet USDC identity with the Jupiter adapter", () => {
    expect(String(USDC_MAINNET_MINT)).toBe(String(JUPITER_LEND_USDC_MINT));
    expect(JUPITER_LEND_USDC_DECIMALS).toBe(6);
  });

  it("resolves registered symbols case-insensitively per cluster", () => {
    expect(String(resolveTokenIdentifier("usdc", "mainnet").mint)).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(String(resolveTokenIdentifier("USDC", "devnet").mint)).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
    expect(String(resolveTokenIdentifier("usdt", "mainnet").mint)).toBe(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
    expect(resolveTokenIdentifier("usdc", "mainnet").token?.displaySymbol).toBe(
      "USDC",
    );
  });

  it("never reuses another cluster's mint and fails closed for missing symbols", () => {
    expect(() => resolveTokenIdentifier("usdt", "devnet")).toThrow(
      /not available on devnet/,
    );
    expect(() => resolveTokenIdentifier("usdt", "devnet")).toThrow(
      /token symbols/,
    );
  });

  it("leaves raw mint addresses untouched", () => {
    const mint = "11111111111111111111111111111114";
    const resolved = resolveTokenIdentifier(mint, "mainnet");
    expect(String(resolved.mint)).toBe(mint);
    expect(resolved.token).toBeUndefined();
  });

  it("reports unknown symbol-shaped input instead of a generic address error", () => {
    expect(() => resolveTokenIdentifier("usdcx", "mainnet")).toThrow(
      /Unknown token symbol: usdcx/,
    );
    expect(() => resolveTokenIdentifier("usdcx", "mainnet")).toThrow(
      /Did you mean: usdc\?/,
    );
  });

  it("filters symbols and labels mints for the active cluster", () => {
    expect(knownTokenSymbols("mainnet")).toEqual(["usdc", "usdt"]);
    expect(knownTokenSymbols("devnet")).toEqual(["usdc"]);
    const devnet = knownTokenDeployments("devnet");
    expect(devnet).toHaveLength(1);
    expect(devnet[0]!.deployment.testOnly).toBe(true);
    expect(
      knownTokenForMint(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "mainnet",
      )?.displaySymbol,
    ).toBe("USDC");
    expect(
      knownTokenForMint(
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        "mainnet",
      ),
    ).toBeUndefined();
  });

  it("keeps symbol keys unique and lowercase", () => {
    const keys = KNOWN_TOKENS.map((token) => token.symbol);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toBe(key.toLowerCase());
  });
});
