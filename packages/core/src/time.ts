export class InvalidTimestampError extends Error {
  constructor(input: string) {
    super(`Invalid timestamp "${input}". Use hh:mm:ss, hh:mm:ss.s or mm:ss.`);
    this.name = "InvalidTimestampError";
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatTimestamp(ms: number, opts: { tenths?: boolean } = {}): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Cannot format time ${ms}`);
  const totalMs = Math.floor(ms);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const base = `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return opts.tenths ? `${base}.${Math.floor((totalMs % 1000) / 100)}` : base;
}

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d))?$/;

export function parseTimestamp(s: string): number {
  const match = TIMESTAMP_RE.exec(s.trim());
  if (!match) throw new InvalidTimestampError(s);
  const h = match[1] === undefined ? 0 : Number(match[1]);
  const m = Number(match[2]);
  const sec = Number(match[3]);
  const tenth = match[4] === undefined ? 0 : Number(match[4]);
  if (m >= 60 || sec >= 60) throw new InvalidTimestampError(s);
  return h * 3_600_000 + m * 60_000 + sec * 1000 + tenth * 100;
}
