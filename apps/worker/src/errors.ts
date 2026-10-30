/** Deterministic: a missing API key must fail the session, never degrade into a "successful" empty analysis. */
export class MissingApiKeyError extends Error {
  constructor(public readonly varName: string) {
    super(`${varName} is not set on the server.`);
    this.name = "MissingApiKeyError";
  }
}

/** Deterministic: the original video was removed by retention, so there is nothing to cut. */
export class VideoRemovedError extends Error {
  constructor() {
    super("The original video has been removed, so this clip can no longer be rendered.");
    this.name = "VideoRemovedError";
  }
}
