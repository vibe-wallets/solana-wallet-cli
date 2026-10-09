import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction as getSplTransferCheckedInstruction,
} from "@solana-program/token";
import { getTransferCheckedInstruction as getToken2022TransferCheckedInstruction } from "@solana-program/token-2022";
import { confirm } from "../shell/prompt.js";
import {
  InsufficientBalanceError,
  SimulationError,
  UnsupportedTokenExtensionError,
  TokenMetadataMismatchError,
  ConfirmationError,
  TransactionRejectedError,
  RpcError,
  safeJson,
} from "../errors/errors.js";
import {
  formatSol,
  formatUnits,
  parseDecimalUnits,
} from "../solana/amounts.js";
import { assertRpcCluster, rpcRequest } from "../solana/rpc.js";
import {
  getTokenAccounts,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../solana/tokens.js";
import { resolveTokenIdentifier } from "../solana/known-tokens.js";
import { parseAddress } from "../wallet/address.js";
import { EncryptedKeystoreSigner } from "../wallet/signer.js";
import { requireSelectedWallet, requireWallet } from "./read-only.js";
import type { CommandContext } from "./context.js";
import {
  assertBlockhashFresh,
  broadcastSignedTransaction,
  confirmSignature,
} from "./send.js";
import { formatTransactionReceipt } from "../output/transaction.js";
import {
  actionPreview,
  networkLabel,
  shortenAddress,
} from "../output/human.js";

/**
 * SPL/Token-2022 transfer handler.
 *
 * A token amount is meaningful only together with its mint's decimals and
 * token program. This module reads that metadata first, derives the relevant
 * associated token accounts, and then uses a checked transfer instruction.
 */
export async function sendToken(
  context: CommandContext,
  mintValue: string,
  destinationValue: string,
  amountValue: string,
  dryRun: boolean,
  yes: boolean,
): Promise<void> {
  const owner = await requireWallet(context);
  const selectedWallet = await requireSelectedWallet(context);
  const resolved = resolveTokenIdentifier(mintValue, context.config.cluster);
  const mint = resolved.mint;
  const mintLabel = resolved.token
    ? `${resolved.token.displaySymbol} (${mint})`
    : String(mint);
  const destinationOwner = parseAddress(destinationValue);
  const rpc = context.getClient().rpc;
  await assertRpcCluster(rpc, context.config.cluster);
  const mintInfo = await readMint(rpc, mint, context.config.commitment);
  if (resolved.deployment) {
    if (mintInfo.program !== resolved.deployment.program)
      throw new TokenMetadataMismatchError(
        `${resolved.token!.displaySymbol} (${mint}) is owned by ${mintInfo.program}, but the local token registry expects ${resolved.deployment.program}. Refusing to send.`,
        {
          mint,
          expected: resolved.deployment.program,
          actual: mintInfo.program,
        },
      );
    if (mintInfo.decimals !== resolved.deployment.decimals)
      throw new TokenMetadataMismatchError(
        `${resolved.token!.displaySymbol} (${mint}) reports ${mintInfo.decimals} decimals, but the local token registry expects ${resolved.deployment.decimals}. Refusing to send.`,
        {
          mint,
          expected: resolved.deployment.decimals,
          actual: mintInfo.decimals,
        },
      );
  }
  if (mintInfo.program !== "spl-token" && mintInfo.program !== "token-2022")
    throw new RpcError(
      `Mint ${mint} is not owned by a supported token program.`,
    );
  if (mintInfo.extensions)
    throw new UnsupportedTokenExtensionError(
      "This Token-2022 mint has extensions; refusing to guess its transfer semantics.",
    );
  const rawAmount = parseDecimalUnits(
    amountValue,
    mintInfo.decimals,
    "token amount",
  );
  if (rawAmount <= 0n)
    throw new InsufficientBalanceError(
      "Token amount must be greater than zero.",
    );
  const accounts = await getTokenAccounts(
    rpc,
    owner,
    context.config.commitment,
  );
  const sourceAccounts: {
    account: (typeof accounts)[number];
    amount: bigint;
  }[] = [];
  let remaining = rawAmount;
  for (const account of accounts) {
    if (
      account.mint !== mint ||
      account.program !== mintInfo.program ||
      account.rawAmount <= 0n
    )
      continue;
    const amount =
      account.rawAmount < remaining ? account.rawAmount : remaining;
    sourceAccounts.push({ account, amount });
    remaining -= amount;
    if (remaining === 0n) break;
  }
  if (remaining > 0n)
    throw new InsufficientBalanceError(
      `Insufficient token balance for mint ${mint}.`,
    );
  const [destinationAta] = await findAssociatedTokenPda({
    owner: destinationOwner,
    tokenProgram:
      mintInfo.program === "token-2022"
        ? TOKEN_2022_PROGRAM_ADDRESS
        : TOKEN_PROGRAM_ADDRESS,
    mint,
  });
  const signer = new EncryptedKeystoreSigner(
    selectedWallet,
    context.readPassphrase,
  );
  const instructions = [] as any[];
  const destinationAccount = await rpcRequest(
    rpc.getAccountInfo(destinationAta, {
      commitment: context.config.commitment,
      encoding: "base64",
    }),
    "destination token account lookup",
  );
  let ataCreationCost = 0n;
  if (!destinationAccount.value) {
    const rent = await rpcRequest(
      rpc.getMinimumBalanceForRentExemption(165n, {
        commitment: context.config.commitment,
      }),
      "token account rent lookup",
    );
    ataCreationCost = BigInt(rent as bigint);
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: signer,
        ata: destinationAta,
        owner: destinationOwner,
        mint,
        tokenProgram:
          mintInfo.program === "token-2022"
            ? TOKEN_2022_PROGRAM_ADDRESS
            : TOKEN_PROGRAM_ADDRESS,
      }),
    );
  }
  for (const { account, amount } of sourceAccounts) {
    const transfer =
      mintInfo.program === "token-2022"
        ? getToken2022TransferCheckedInstruction({
            source: address(account.address),
            mint,
            destination: destinationAta,
            authority: signer,
            amount,
            decimals: mintInfo.decimals,
          })
        : getSplTransferCheckedInstruction({
            source: address(account.address),
            mint,
            destination: destinationAta,
            authority: signer,
            amount,
            decimals: mintInfo.decimals,
          });
    instructions.push(transfer);
  }
  const latest = await rpcRequest(
    rpc.getLatestBlockhash({ commitment: context.config.commitment }),
    "recent blockhash lookup",
  );
  let message: any = createTransactionMessage({ version: 0 });
  message = setTransactionMessageFeePayer(owner, message);
  message = setTransactionMessageLifetimeUsingBlockhash(latest.value, message);
  for (const instruction of instructions)
    message = appendTransactionMessageInstruction(instruction, message);
  const unsigned = compileTransaction(message);
  const feeResponse = await rpcRequest(
    rpc.getFeeForMessage(
      Buffer.from(unsigned.messageBytes).toString("base64") as any,
    ),
    "fee estimation",
  );
  const fee = BigInt(feeResponse.value ?? 0n);
  const balanceResponse = await rpcRequest(
    rpc.getBalance(owner, { commitment: context.config.commitment }),
    "balance lookup",
  );
  const nativeBalance = BigInt(balanceResponse.value as bigint);
  if (nativeBalance < ataCreationCost + fee)
    throw new InsufficientBalanceError(
      `Insufficient SOL to pay the token account rent and fee. Need ${formatSol(ataCreationCost + fee)} SOL; have ${formatSol(nativeBalance)} SOL.`,
    );
  const summary = {
    action: "Send token",
    owner,
    mint,
    ...(resolved.token ? { symbol: resolved.token.displaySymbol } : {}),
    program: mintInfo.program,
    sourceTokenAccounts: sourceAccounts.map(({ account }) => account.address),
    destinationOwner,
    destinationAta,
    rawAmount,
    amount: formatUnits(rawAmount, mintInfo.decimals),
    decimals: mintInfo.decimals,
    ataCreationCostLamports: ataCreationCost,
    estimatedFeeLamports: fee,
    cluster: context.config.cluster,
    dryRun,
  };
  context.output.preflight(
    { ok: true, preflight: summary },
    actionPreview("TOKEN TRANSFER · TRANSACTION PREVIEW", [
      ["Wallet", `${selectedWallet.identity.alias} (${owner})`],
      ["Token mint", mintLabel],
      ["Token program", mintInfo.program],
      ["Amount", formatUnits(rawAmount, mintInfo.decimals), "emphasis"],
      ["Destination", String(destinationOwner)],
      ["Destination token account", String(destinationAta)],
      ["Account rent", `${formatSol(ataCreationCost)} SOL`],
      ["Estimated fee", `~${formatSol(fee)} SOL`],
      ["Network", networkLabel(context.config.cluster)],
    ]),
  );
  const simulation = await rpcRequest(
    rpc.simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
      encoding: "base64",
      sigVerify: false,
      commitment: context.config.commitment,
    }),
    "transaction simulation",
  );
  if (simulation.value.err)
    throw new SimulationError(
      `Transaction simulation failed: ${safeJson(simulation.value.err)}`,
      { logs: simulation.value.logs },
    );
  if (dryRun) {
    context.output.print(
      { ok: true, status: "simulated", dryRun: true, preflight: summary },
      "Dry-run complete. The transaction was simulated and not broadcast.",
    );
    return;
  }
  if (
    !yes &&
    !(await confirm(
      context.config.cluster === "mainnet"
        ? `Send ${formatUnits(rawAmount, mintInfo.decimals)} ${resolved.token?.displaySymbol ?? "tokens"} (${shortenAddress(mint)}) from ${selectedWallet.identity.alias} (${shortenAddress(owner)}) to ${shortenAddress(destinationOwner)} on MAINNET?`
        : `Send ${formatUnits(rawAmount, mintInfo.decimals)} ${resolved.token?.displaySymbol ?? "tokens"} (${shortenAddress(mint)}) from ${selectedWallet.identity.alias} (${shortenAddress(owner)}) to ${shortenAddress(destinationOwner)} on devnet?`,
    ))
  )
    throw new TransactionRejectedError();
  signer.setBeforeSign(() =>
    assertBlockhashFresh(
      rpc,
      latest.value.lastValidBlockHeight,
      context.config.commitment,
    ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = await broadcastSignedTransaction(
    rpc,
    signed,
    context.config.commitment,
  );
  const status = await confirmSignature(
    rpc,
    String(signature),
    context.config.commitment,
    latest.value.lastValidBlockHeight,
    !context.output.json && Boolean(process.stderr.isTTY),
  );
  context.output.print(
    {
      ok: true,
      signature: String(signature),
      slot: status.slot,
      status: status.confirmationStatus,
    },
    formatTransactionReceipt({
      action: "Token transfer",
      wallet: selectedWallet.identity,
      cluster: context.config.cluster,
      confirmation: status.confirmationStatus,
      slot: status.slot,
      signature: String(signature),
      details: [
        ["Mint", mintLabel],
        ["Amount", `${formatUnits(rawAmount, mintInfo.decimals)} tokens`],
        ["Destination", String(destinationOwner)],
        ["Estimated network fee", `~${formatSol(fee)} SOL`],
      ],
    }),
  );
}

async function readMint(
  rpc: ReturnType<CommandContext["getClient"]>["rpc"],
  mint: ReturnType<typeof parseAddress>,
  commitment: "processed" | "confirmed" | "finalized",
): Promise<{
  program: "spl-token" | "token-2022";
  decimals: number;
  extensions: boolean;
}> {
  const response = await rpcRequest(
    rpc.getAccountInfo(mint, { commitment, encoding: "jsonParsed" }),
    "mint lookup",
  );
  if (!response.value || typeof response.value !== "object")
    throw new RpcError(`Mint ${mint} was not found.`);
  const value = response.value as any;
  const owner = String(value.owner);
  const program =
    owner === String(TOKEN_2022_PROGRAM_ADDRESS)
      ? "token-2022"
      : owner === String(TOKEN_PROGRAM_ADDRESS)
        ? "spl-token"
        : undefined;
  const info = value.data?.parsed?.info;
  if (!program || !info || typeof info.decimals !== "number")
    throw new RpcError(`Mint ${mint} returned an unsupported account shape.`);
  return {
    program,
    decimals: info.decimals,
    extensions:
      program === "token-2022" &&
      Array.isArray(info.extensions) &&
      info.extensions.length > 0,
  };
}
