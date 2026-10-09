import { address, type Address } from "@solana/kit";
import type { Cluster } from "../config/schema.js";
import { AppError } from "../errors/errors.js";
import { parseAddress } from "../wallet/address.js";

/**
 * Code-owned token symbol registry.
 *
 * A symbol is a convenience alias for one exact, cluster-scoped mint address.
 * This is deliberately not a token list and never reads an on-chain symbol,
 * name, or logo: display symbols are untrusted metadata. A resolved mint is
 * still validated against chain data (owning token program, decimals, and
 * extension rules) before any transfer is built.
 *
 * Entries are scoped per cluster because the same base58 string can exist on
 * both networks but identify a different asset. Missing entries fail closed
 * instead of silently reusing another cluster's mint.
 */
export type KnownTokenProgram = "spl-token" | "token-2022";

export interface KnownTokenDeployment {
  mint: Address;
  program: KnownTokenProgram;
  decimals: number;
  /** A development-only deployment, never a production asset. */
  testOnly?: boolean;
}

export interface KnownToken {
  /** Canonical lowercase lookup key. */
  symbol: string;
  /** Human-facing symbol for labels. */
  displaySymbol: string;
  name: string;
  deployments: Partial<Record<Cluster, KnownTokenDeployment>>;
}

/** Canonical mainnet USDC mint; shared with the Jupiter Lend adapter. */
export const USDC_MAINNET_MINT = address(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
export const USDC_DECIMALS = 6;

const USDT_MAINNET_MINT = address(
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
);
const USDC_DEVNET_MINT = address(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

export const KNOWN_TOKENS: readonly KnownToken[] = [
  {
    symbol: "usdc",
    displaySymbol: "USDC",
    name: "USD Coin",
    deployments: {
      mainnet: {
        mint: USDC_MAINNET_MINT,
        program: "spl-token",
        decimals: USDC_DECIMALS,
      },
      devnet: {
        mint: USDC_DEVNET_MINT,
        program: "spl-token",
        decimals: USDC_DECIMALS,
        testOnly: true,
      },
    },
  },
  {
    symbol: "usdt",
    displaySymbol: "USDT",
    name: "Tether USD",
    deployments: {
      mainnet: {
        mint: USDT_MAINNET_MINT,
        program: "spl-token",
        decimals: USDC_DECIMALS,
      },
    },
  },
];

export interface ResolvedTokenIdentifier {
  mint: Address;
  /** Present when the input was a registered symbol. */
  token?: KnownToken;
  deployment?: KnownTokenDeployment;
}

function findKnownToken(value: string): KnownToken | undefined {
  const key = value.toLowerCase();
  return KNOWN_TOKENS.find((token) => token.symbol === key);
}

export function knownTokenSymbols(cluster: Cluster): string[] {
  return KNOWN_TOKENS.filter((token) => token.deployments[cluster]).map(
    (token) => token.symbol,
  );
}

export function knownTokenDeployments(
  cluster: Cluster,
): { token: KnownToken; deployment: KnownTokenDeployment }[] {
  return KNOWN_TOKENS.flatMap((token) => {
    const deployment = token.deployments[cluster];
    return deployment ? [{ token, deployment }] : [];
  });
}

/** Identify a mint address using the code-owned, cluster-scoped registry. */
export function knownTokenForMint(
  mint: string,
  cluster: Cluster,
): KnownToken | undefined {
  return KNOWN_TOKENS.find((token) => {
    const deployment = token.deployments[cluster];
    return deployment !== undefined && String(deployment.mint) === mint;
  });
}

/**
 * Resolve a user-supplied mint argument to a mint address.
 *
 * Registered symbols are matched case-insensitively. Anything else must be a
 * valid base58 mint address. Short, symbol-shaped input that is not recognized
 * gets a targeted error instead of a generic address parse failure.
 */
export function resolveTokenIdentifier(
  value: string,
  cluster: Cluster,
): ResolvedTokenIdentifier {
  const token = findKnownToken(value);
  if (token) {
    const deployment = token.deployments[cluster];
    if (!deployment)
      throw new AppError(
        `Token symbol ${token.displaySymbol} is not available on ${cluster}. Run \`token symbols\`, or pass a full mint address.`,
        "UnknownTokenError",
        2,
      );
    return { mint: deployment.mint, token, deployment };
  }
  try {
    return { mint: parseAddress(value) };
  } catch (error) {
    if (!looksLikeSymbol(value)) throw error;
    throw new AppError(
      `Unknown token symbol: ${value}. Run \`token symbols\` for supported symbols, or pass a full mint address.${suggestion(value)}`,
      "UnknownTokenError",
      2,
    );
  }
}

/** Base58 addresses are at least 32 characters, so short input is a symbol. */
function looksLikeSymbol(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(value);
}

function suggestion(value: string): string {
  const key = value.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const token of KNOWN_TOKENS) {
    const distance = levenshtein(key, token.symbol);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = token.symbol;
    }
  }
  return best && bestDistance <= 2 ? ` Did you mean: ${best}?` : "";
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
