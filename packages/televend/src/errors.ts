/**
 * Every way a Televend call can stop, as a distinct class — the sync job reacts differently
 * to each (an allow-list refusal is a bug, an auth failure must never be retried, a circuit
 * that is open just means "wait"), so they must not collapse into one `Error`.
 *
 * Messages carry the method, host and path — never a query value, a header, a token or a
 * password. Tests assert that no credential ever appears in a message.
 */

export class TelevendRefusedError extends Error {
  override readonly name = "TelevendRefusedError";
  constructor(
    readonly method: string,
    readonly target: string,
    readonly reason: string,
  ) {
    super(`Televend request refused before sending (${reason}): ${method} ${target}`);
  }
}

/**
 * Sign-in failed. Raised for a refused password, a dead refresh token that cannot be
 * renewed, or an API that answers 401/403 after a fresh token. The connector LATCHES after
 * this: it will not send the password again until the process restarts with new settings,
 * so a wrong or changed password can never lock the Televend account (Keycloak counts
 * failures).
 */
export class TelevendAuthError extends Error {
  override readonly name = "TelevendAuthError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class TelevendHttpError extends Error {
  override readonly name = "TelevendHttpError";
  constructor(
    readonly method: string,
    readonly target: string,
    readonly status: number,
    readonly attempts: number,
  ) {
    super(`Televend ${method} ${target} failed with HTTP ${status} after ${attempts} attempt(s)`);
  }
}

/** Too many consecutive failures: the client stops calling Televend until the cool-down ends. */
export class TelevendCircuitOpenError extends Error {
  override readonly name = "TelevendCircuitOpenError";
  constructor(readonly reopensAt: Date) {
    super(`Televend calls paused after repeated failures; next attempt allowed at ${reopensAt.toISOString()}`);
  }
}

/** The response did not have the shape we rely on — Televend changed something. */
export class TelevendSchemaError extends Error {
  override readonly name = "TelevendSchemaError";
  constructor(readonly target: string, readonly issues: string) {
    super(`Televend response from ${target} did not match the expected shape: ${issues}`);
  }
}
