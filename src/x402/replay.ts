/**
 * Replay guard. Holds each payment authorization from verification until it settles or expires, so
 * the same signed payment cannot buy two answers in parallel inside one runtime instance.
 *
 * The hard guarantee is on-chain: EIP-3009 rejects a reused nonce at settlement, and by default the gate
 * releases an answer only after settlement succeeds. This guard removes the wasted work of a parallel
 * replay. Across instances, a replay costs one extra computation and is then refused at settlement.
 * Releasing on settlement_pending (acceptPending) needs a guard shared by every instance.
 */
export interface ReplayGuard {
  /** Claims `key` until `expiresAt` (epoch milliseconds). Returns false when it is already held. */
  claim(key: string, expiresAt: number): boolean | Promise<boolean>;
  /** Releases a claim so the same authorization can be presented again. */
  release(key: string): void | Promise<void>;
}

export interface MemoryReplayGuardOptions {
  /** Upper bound on held keys. Default 100,000 (about 15 MB). */
  maxEntries?: number;
  now?: () => number;
}

export function memoryReplayGuard(options: MemoryReplayGuardOptions = {}): ReplayGuard {
  const maxEntries = options.maxEntries ?? 100_000;
  const now = options.now ?? Date.now;
  const held = new Map<string, number>();

  function sweep(at: number): void {
    for (const [key, expiresAt] of held) {
      if (expiresAt <= at) held.delete(key);
    }
    // Still full: drop the oldest claims. Safe, because settlement rejects a reused nonce regardless.
    while (held.size >= maxEntries) {
      const oldest = held.keys().next();
      if (oldest.done) break;
      held.delete(oldest.value);
    }
  }

  return {
    claim(key, expiresAt) {
      const at = now();
      const existing = held.get(key);
      if (existing !== undefined && existing > at) return false;
      if (held.size >= maxEntries) sweep(at);
      held.set(key, expiresAt);
      return true;
    },
    release(key) {
      held.delete(key);
    },
  };
}
