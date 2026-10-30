/**
 * Saves a value that changes in bursts (a slider): `push` waits `delayMs` after the last change, `flush` saves now.
 * A value equal to the last one sent (or to the saved value given by `known`) is never sent, so a release followed by
 * a blur, or arrow taps that end where they began, cost no request and no undo entry; `onSkip` hears about those.
 */
export function debouncedCommit<T>(send: (value: T) => void, delayMs: number, saved: T, onSkip?: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  let last: T = saved;
  let confirmed: T = saved;
  let sender = send;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    clear();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    if (Object.is(value, last)) return onSkip?.(value);
    last = value;
    sender(value);
  };

  return {
    push(value: T) {
      pending = { value };
      clear();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    /** The saved value changed (a server response, an undo). */
    known(value: T) {
      last = value;
      confirmed = value;
    },
    /** The last send failed: the saved value is unchanged, so sending that value again is allowed. */
    rejected() {
      last = confirmed;
    },
    /** Replaces the sender (a component passes its latest callback). */
    setSend(next: (value: T) => void) {
      sender = next;
    },
    cancel() {
      clear();
      pending = null;
    },
  };
}
