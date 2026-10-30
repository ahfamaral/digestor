/** Deterministic: a missing API key must fail the session, never degrade into a "successful" empty analysis. */
export class MissingApiKeyError extends Error {
  constructor(public readonly varName: string) {
    super(`${varName} is not set on the server.`);
    this.name = "MissingApiKeyError";
  }
}
