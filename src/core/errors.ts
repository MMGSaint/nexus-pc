/**
 * NEXUS error taxonomy.
 *
 * Codes are stable identifiers: they appear in audit records and cross the
 * Vesper boundary, so they are part of the public contract. Messages are for
 * humans and may change.
 */

export const ERROR_CODES = [
  /** The operation is not supported on this platform or hardware at all. */
  'E_UNSUPPORTED',
  /** Supported in principle, but the backing interface is not present right now. */
  'E_UNAVAILABLE',
  /** Caller supplied something structurally or semantically invalid. */
  'E_INVALID_INPUT',
  /** The deterministic safety kernel refused the request. */
  'E_SAFETY_REJECTED',
  /** The requested control cannot be reversed, so it cannot be auto-applied. */
  'E_NOT_REVERSIBLE',
  /** Applied, but the resulting state could not be confirmed. Fail closed. */
  'E_VERIFY_FAILED',
  /** Operation exceeded its deadline. */
  'E_TIMEOUT',
  /** Filesystem / process / OS interaction failure. */
  'E_IO',
  /** NEXUS is in a state where this operation is not legal. */
  'E_STATE',
  /** NEXUS is degraded and refuses consequential work. */
  'E_DEGRADED',
  /** Caller failed authentication. */
  'E_AUTH',
  /** Caller authenticated but lacks the scope for this method. */
  'E_SCOPE',
  /** Another instance or operation holds the resource. */
  'E_CONFLICT',
  /** A rate or budget limit was hit. */
  'E_LIMIT',
  /** A bug in NEXUS. */
  'E_INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface NexusErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export class NexusError extends Error implements NexusErrorShape {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NexusError';
    this.code = code;
    this.details = details;
  }

  toJSON(): NexusErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function nexusError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): NexusError {
  return new NexusError(code, message, details, cause);
}

/** Normalise an unknown thrown value into a NexusError. */
export function toNexusError(value: unknown, fallbackCode: ErrorCode = 'E_INTERNAL'): NexusError {
  if (value instanceof NexusError) return value;
  if (value instanceof Error) return new NexusError(fallbackCode, value.message, undefined, value);
  return new NexusError(fallbackCode, String(value));
}
