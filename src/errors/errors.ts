export type ExitCode = 1 | 2 | 3 | 4 | 5;

export class AppError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details?: unknown;

  constructor(
    message: string,
    code = "GeneralError",
    exitCode: ExitCode = 1,
    details?: unknown,
  ) {
    super(message);
    this.name = code;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "ConfigError", 2, details);
  }
}

export class KeystoreError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "KeystoreError", 1, details);
  }
}

export class WalletStoreError extends AppError {
  constructor(
    code: string,
    message: string,
    exitCode: ExitCode = 1,
    details?: unknown,
  ) {
    super(message, code, exitCode, details);
  }
}

export class InvalidPrivateKeyError extends AppError {
  constructor(
    message = "The supplied private key is invalid.",
    details?: unknown,
  ) {
    super(message, "InvalidPrivateKeyError", 2, details);
  }
}

export class InvalidAddressError extends AppError {
  constructor(value: string) {
    super(`Invalid Solana address: ${value}`, "InvalidAddressError", 2);
  }
}

export class InvalidAmountError extends AppError {
  constructor(message: string) {
    super(message, "InvalidAmountError", 2);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(message: string) {
    super(message, "InsufficientBalanceError", 2);
  }
}

export class RpcError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "RpcError", 3, details);
  }
}

export class SimulationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "SimulationError", 4, details);
  }
}

export class ConfirmationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "ConfirmationError", 5, details);
  }
}

export class TransactionRejectedError extends AppError {
  constructor(message = "Transaction cancelled by user.", details?: unknown) {
    super(message, "TransactionRejectedError", 2, details);
  }
}

export class ValidatorError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "ValidatorError", 2, details);
  }
}

export class StakeAccountError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "StakeAccountError", 2, details);
  }
}

export class UnsupportedTokenExtensionError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "UnsupportedTokenExtensionError", 2, details);
  }
}

export class TokenMetadataMismatchError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "TokenMetadataMismatchError", 2, details);
  }
}

export class JupiterLendError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "JupiterLendError", 2, details);
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(error.message);
  return new AppError("Unexpected failure.");
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const secretNames =
    /private|secret|seed|mnemonic|password|passphrase|ciphertext|plaintext/i;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      secretNames.test(key) ? "[REDACTED]" : redact(child),
    ]),
  );
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
}
