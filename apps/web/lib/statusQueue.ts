import type { ClipStatus } from "@digestor/core";

export interface StatusQueueOptions {
  /** Persists one status; rejects with an Error whose message is shown to the user. */
  send(id: string, status: ClipStatus): Promise<void>;
  /** The status the UI should show for the clip now. */
  onDisplay(id: string, status: ClipStatus): void;
  /** Inline error for the clip; `null` clears it. */
  onError(id: string, message: string | null): void;
}

interface Entry {
  confirmed: ClipStatus; // last value the server accepted
  desired: ClipStatus; // newest value the user asked for
  inFlight: boolean;
}

/**
 * Per-clip, latest-wins status updates: at most one request in flight per clip; changes made meanwhile
 * collapse into the newest desired value, sent once the in-flight one settles. Responses for older values
 * never repaint the UI. On failure the UI rolls back to the last server-confirmed status.
 */
export class StatusQueue {
  private entries = new Map<string, Entry>();
  private waiters: { failed: boolean; resolve(r: { failed: boolean }): void }[] = [];

  constructor(private readonly opts: StatusQueueOptions) {}

  /** Asks for `status`; `current` is the status the UI shows now (the server-confirmed one if nothing is pending). */
  set(id: string, status: ClipStatus, current: ClipStatus): void {
    const entry = this.entries.get(id) ?? { confirmed: current, desired: current, inFlight: false };
    if (entry.desired === status) return;
    entry.desired = status;
    this.entries.set(id, entry);
    this.opts.onDisplay(id, status);
    if (!entry.inFlight) void this.pump(id, entry);
  }

  /** The status still waiting to be confirmed for this clip, if any. */
  pending(id: string): ClipStatus | undefined {
    return this.entries.get(id)?.desired;
  }

  /**
   * Resolves once no status write is pending or in flight; `failed` says whether any write failed since the call.
   * Used before actions that depend on the saved statuses (starting a render).
   */
  idle(): Promise<{ failed: boolean }> {
    if (this.entries.size === 0) return Promise.resolve({ failed: false });
    return new Promise((resolve) => this.waiters.push({ failed: false, resolve }));
  }

  private settle(): void {
    if (this.entries.size > 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve({ failed: w.failed });
  }

  private async pump(id: string, entry: Entry): Promise<void> {
    while (entry.desired !== entry.confirmed) {
      const sending = entry.desired;
      entry.inFlight = true;
      try {
        await this.opts.send(id, sending);
        entry.confirmed = sending;
      } catch (err) {
        entry.inFlight = false;
        this.entries.delete(id);
        this.opts.onDisplay(id, entry.confirmed);
        this.opts.onError(id, err instanceof Error ? err.message : "Couldn't save. Try again.");
        for (const w of this.waiters) w.failed = true;
        this.settle();
        return;
      }
      entry.inFlight = false;
    }
    this.entries.delete(id);
    this.opts.onError(id, null);
    this.settle();
  }
}
