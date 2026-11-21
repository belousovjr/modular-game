export interface Receipt { readonly accepted: boolean; readonly reason: string }
export interface DeliveryOptions {
  readonly latencyTicks?: number;
  readonly jitterTicks?: number;
  readonly dropEvery?: number;
  readonly seed?: number;
}

export function createLocalSession() {
  const snapshots = new Map<string, () => object>();
  return {
    // shortcut: only current views live in memory, add durable world checkpoints with a persistence schema.
    snapshot() {
      return Object.freeze(Object.fromEntries(Array.from(snapshots, ([id, read]) => [id, read()])));
    },
    connect<Command, State extends { readonly tick: number }>(
      id: string, read: () => State, receive: (command: unknown) => Receipt, options: DeliveryOptions,
    ) {
      if (snapshots.has(id)) throw new Error('Session channel already connected: ' + id);
      const { latencyTicks = 0, jitterTicks = 0, dropEvery = 0 } = options;
      let seed = options.seed ?? 2026;
      if (![latencyTicks, jitterTicks, dropEvery, seed].every(Number.isSafeInteger)
        || latencyTicks < 0 || latencyTicks > 120 || jitterTicks < 0 || jitterTicks > 120
        || dropEvery < 0 || seed < 0 || seed > 0xffffffff) throw new Error('Invalid delivery configuration');

      let latest = read();
      const snapshot = () => latest;
      snapshots.set(id, snapshot);
      const queue: { due: number; command: Command; resolve: (receipt: Receipt) => void }[] = [];
      let closed = false;
      let count = 0;
      function clear(reason: string) {
        for (const packet of queue.splice(0)) packet.resolve({ accepted: false, reason });
      }
      return {
        snapshot,
        publish() { latest = read(); },
        send(command: Command): Promise<Receipt> {
          if (closed) return Promise.resolve({ accepted: false, reason: 'closed' });
          if (queue.length >= 64) return Promise.resolve({ accepted: false, reason: 'queue' });
          if (dropEvery && ++count % dropEvery === 0) return Promise.resolve({ accepted: false, reason: 'dropped' });
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const delay = Math.max(0, latencyTicks + Math.floor(seed / 0x100000000 * (jitterTicks * 2 + 1)) - jitterTicks);
          let copy: Command;
          try { copy = structuredClone(command); }
          catch { return Promise.resolve({ accepted: false, reason: 'invalid' }); }
          return new Promise(resolve => queue.push({ due: latest.tick + delay + 1, command: copy, resolve }));
        },
        deliver(tick: number) {
          queue.sort((a, b) => a.due - b.due);
          while (queue.length && queue[0].due <= tick) {
            const packet = queue.shift();
            if (packet) packet.resolve(receive(packet.command));
          }
        },
        clear,
        close() {
          if (closed) return;
          closed = true;
          snapshots.delete(id);
          clear('closed');
        },
      };
    },
  };
}

export type LocalSession = ReturnType<typeof createLocalSession>;
