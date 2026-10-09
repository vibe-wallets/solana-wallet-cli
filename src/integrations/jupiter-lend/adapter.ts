import { Client as JupiterLendReadClient } from "@jup-ag/lend-read";
import {
  getDepositContext,
  getDepositIx,
  getRedeemIx,
  getWithdrawContext,
  getWithdrawIx,
} from "@jup-ag/lend/earn";
import BN from "bn.js";
import { AccountRole, address, type Address } from "@solana/kit";
import {
  Connection,
  PublicKey,
  type ParsedAccountData,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { AppConfig } from "../../config/config.js";
import { JupiterLendError } from "../../errors/errors.js";
import { formatUnits } from "../../solana/amounts.js";
import { USDC_DECIMALS, USDC_MAINNET_MINT } from "../../solana/known-tokens.js";
import { optionalRate } from "./yield.js";

/**
 * Compatibility boundary for the pinned Jupiter Earn SDK.
 *
 * The wallet core uses `@solana/kit`, while this SDK line uses legacy
 * `@solana/web3.js`, `PublicKey`, and `BN` values. Keep those types here and
 * convert the official SDK instructions into the small Kit-shaped structure
 * consumed by the common transaction pipeline. This prevents protocol SDK
 * details from spreading through the wallet.
 *
 * The adapter also owns v0.2's identity checks: mainnet only, canonical USDC,
 * legacy SPL Token Program, six decimals, and withdrawal bounded by both the
 * user's position and protocol-reported liquidity.
 */
/**
 * Canonical mainnet USDC identity is defined once in the shared token
 * registry; the adapter re-exports it for its own API surface.
 */
export const JUPITER_LEND_USDC_MINT = USDC_MAINNET_MINT;
export const JUPITER_LEND_USDC_DECIMALS = USDC_DECIMALS;
export const LEGACY_SPL_TOKEN_ACCOUNT_SPACE = 165n;
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export interface WalletInstruction {
  programAddress: Address;
  accounts: ReadonlyArray<{
    address: Address;
    role: AccountRole;
    signer?: unknown;
  }>;
  data: Uint8Array;
}

export interface JupiterLendInstructionPlan {
  instructions: ReadonlyArray<WalletInstruction>;
  sourceTokenAccount: Address;
  destinationTokenAccount: Address;
  receiptMint: Address;
  tokenProgram: Address;
  walletBalance: bigint;
}

export interface JupiterLendPosition {
  walletBalance: bigint;
  supplied: bigint;
  protocolWithdrawable: bigint;
  withdrawable: bigint;
  receiptShares: bigint;
  receiptMint: Address;
  receiptTokenAccount: Address;
  supplyRateRaw: bigint | null;
  rewardsRateRaw: bigint | null;
  ratesUpdatedAt?: string;
}

export interface JupiterLendAdapterDependencies {
  connection?: Connection;
  readClient?: JupiterLendReadClient;
}

export function toWalletInstruction(
  instruction: TransactionInstruction,
  signer?: { address: Address },
): WalletInstruction {
  const signerAddress = signer?.address;
  return {
    programAddress: address(instruction.programId.toBase58()),
    accounts: instruction.keys.map((meta) => {
      const accountAddress = address(meta.pubkey.toBase58());
      const isSigner = meta.isSigner;
      const role = isSigner
        ? meta.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : meta.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;
      return {
        address: accountAddress,
        role,
        ...(isSigner && signerAddress === accountAddress ? { signer } : {}),
      };
    }),
    data: Uint8Array.from(instruction.data),
  };
}

export class JupiterLendAdapter {
  private readonly connection: Connection;
  private readonly readClient: JupiterLendReadClient;
  private verifiedUsdc = false;

  constructor(
    private readonly config: AppConfig,
    dependencies: JupiterLendAdapterDependencies = {},
  ) {
    if (config.cluster !== "mainnet")
      throw new JupiterLendError(
        "Jupiter Lend v0.2 is available only on mainnet.",
      );
    this.connection =
      dependencies.connection ??
      new Connection(config.rpcUrl, config.commitment);
    this.readClient =
      dependencies.readClient ??
      new JupiterLendReadClient(
        this.connection,
        { commitment: config.commitment },
        "main",
      );
  }

  async getPosition(owner: Address): Promise<JupiterLendPosition> {
    await this.verifyCanonicalUsdc();
    const ownerKey = new PublicKey(owner);
    const mint = new PublicKey(JUPITER_LEND_USDC_MINT);
    const [details, position] = await Promise.all([
      this.readClient.lending.getJlTokenDetails(mint),
      this.readClient.lending.getUserPosition(mint, ownerKey),
    ]);
    const protocolWithdrawable = toBigInt(details.userSupplyData.withdrawable);
    const supplied = toBigInt(position.underlyingAssets);
    const receiptMint = new PublicKey(details.tokenAddress);
    const receiptMintInfo = await this.connection.getAccountInfo(receiptMint);
    if (!receiptMintInfo)
      throw new JupiterLendError(
        `Jupiter Lend receipt mint ${receiptMint.toBase58()} was not found.`,
      );
    const receiptTokenAccount = getAssociatedTokenAddressSync(
      receiptMint,
      ownerKey,
      false,
      receiptMintInfo.owner,
    );
    return {
      walletBalance: toBigInt(position.underlyingBalance),
      supplied,
      protocolWithdrawable,
      withdrawable:
        supplied < protocolWithdrawable ? supplied : protocolWithdrawable,
      receiptShares: toBigInt(position.jlTokenShares),
      receiptMint: address(receiptMint.toBase58()),
      receiptTokenAccount: address(receiptTokenAccount.toBase58()),
      supplyRateRaw: optionalRate(details.supplyRate),
      rewardsRateRaw: optionalRate(details.rewardsRate),
      ratesUpdatedAt: new Date().toISOString(),
    };
  }

  async buildDeposit(
    owner: Address,
    amount: bigint,
    signer?: { address: Address },
  ): Promise<JupiterLendInstructionPlan> {
    await this.verifyCanonicalUsdc();
    const ownerKey = new PublicKey(owner);
    const asset = new PublicKey(JUPITER_LEND_USDC_MINT);
    const context = await getDepositContext({
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    const walletBalance = await this.getTokenAccountBalance(
      context.depositorTokenAccount,
    );
    if (walletBalance < amount)
      throw new JupiterLendError(
        `Insufficient USDC balance. Need ${formatUnits(amount, JUPITER_LEND_USDC_DECIMALS)} USDC; have ${formatUnits(walletBalance, JUPITER_LEND_USDC_DECIMALS)} USDC.`,
      );
    const instruction = await getDepositIx({
      amount: new BN(amount.toString()),
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    return {
      instructions: [toWalletInstruction(instruction, signer)],
      sourceTokenAccount: address(context.depositorTokenAccount.toBase58()),
      destinationTokenAccount: address(
        context.recipientTokenAccount.toBase58(),
      ),
      receiptMint: address(context.fTokenMint.toBase58()),
      tokenProgram: address(context.tokenProgram.toBase58()),
      walletBalance,
    };
  }

  async buildWithdraw(
    owner: Address,
    amount: bigint,
    signer?: { address: Address },
  ): Promise<JupiterLendInstructionPlan> {
    await this.verifyCanonicalUsdc();
    const ownerKey = new PublicKey(owner);
    const asset = new PublicKey(JUPITER_LEND_USDC_MINT);
    const context = await getWithdrawContext({
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    const instruction = await getWithdrawIx({
      amount: new BN(amount.toString()),
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    return {
      instructions: [toWalletInstruction(instruction, signer)],
      sourceTokenAccount: address(context.ownerTokenAccount.toBase58()),
      destinationTokenAccount: address(
        context.recipientTokenAccount.toBase58(),
      ),
      receiptMint: address(context.fTokenMint.toBase58()),
      tokenProgram: address(context.tokenProgram.toBase58()),
      walletBalance: 0n,
    };
  }

  async buildRedeem(
    owner: Address,
    shares: bigint,
    signer?: { address: Address },
  ): Promise<JupiterLendInstructionPlan> {
    await this.verifyCanonicalUsdc();
    const ownerKey = new PublicKey(owner);
    const asset = new PublicKey(JUPITER_LEND_USDC_MINT);
    const context = await getWithdrawContext({
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    const instruction = await getRedeemIx({
      shares: new BN(shares.toString()),
      asset,
      signer: ownerKey,
      connection: this.connection,
    });
    return {
      instructions: [toWalletInstruction(instruction, signer)],
      sourceTokenAccount: address(context.ownerTokenAccount.toBase58()),
      destinationTokenAccount: address(
        context.recipientTokenAccount.toBase58(),
      ),
      receiptMint: address(context.fTokenMint.toBase58()),
      tokenProgram: address(context.tokenProgram.toBase58()),
      walletBalance: 0n,
    };
  }

  private async verifyCanonicalUsdc(): Promise<void> {
    if (this.verifiedUsdc) return;
    const genesisHash = await this.connection.getGenesisHash();
    if (genesisHash !== MAINNET_GENESIS_HASH)
      throw new JupiterLendError(
        "RPC endpoint is not Solana mainnet; refusing Jupiter Lend access.",
      );
    const mint = new PublicKey(JUPITER_LEND_USDC_MINT);
    const response = await this.connection.getParsedAccountInfo(mint);
    const account = response.value;
    if (!account || !account.owner.equals(TOKEN_PROGRAM_ID))
      throw new JupiterLendError(
        "Canonical USDC is not owned by the legacy SPL Token Program.",
      );
    const data = account.data as ParsedAccountData;
    const decimals = data.parsed?.info?.decimals;
    if (data.parsed?.type !== "mint" || decimals !== JUPITER_LEND_USDC_DECIMALS)
      throw new JupiterLendError(
        "Canonical USDC returned unexpected mint metadata.",
      );
    this.verifiedUsdc = true;
  }

  private async getTokenAccountBalance(account: PublicKey): Promise<bigint> {
    const accountInfo = await this.connection.getAccountInfo(account);
    if (!accountInfo) return 0n;
    try {
      const response = await this.connection.getTokenAccountBalance(account);
      return BigInt(response.value.amount);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown RPC failure";
      throw new JupiterLendError(
        `Unable to read the USDC token account balance: ${message}`,
      );
    }
  }
}

function toBigInt(value: BN): bigint {
  return BigInt(value.toString());
}
