import { sse } from 'elysia';
export interface SseEvent {
  event: string;
  data: unknown;
}

const KEEPALIVE_MS = 20_000;

export function createSseStream(
  signal: AbortSignal | undefined,
  setup: (push: (event: SseEvent) => void) => () => void,
): AsyncGenerator<ReturnType<typeof sse>, void, unknown> {
  const queue: SseEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (event: SseEvent) => {
    queue.push(event);
    const w = wake;
    wake = null;
    w?.();
  };

  return (async function* () {
    yield sse({ event: 'connected', data: 'ok' });
    const cleanup = setup(push);
    try {
      while (!signal?.aborted) {
        while (queue.length) yield sse(queue.shift()!);
        if (signal?.aborted) break;
        const reason = await new Promise<'wake' | 'ping' | 'abort'>((resolve) => {
          const timer = setTimeout(() => resolve('ping'), KEEPALIVE_MS);
          const onAbort = () => {
            clearTimeout(timer);
            resolve('abort');
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          wake = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve('wake');
          };
        });

        if (reason === 'abort') break;
        if (reason === 'ping' && !queue.length) {
          const now = new Date();
          const pad = (n: number) => n.toString().padStart(2, '0');
          const formattedDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
          
          yield sse({ event: 'ping', data: formattedDate });
      }}
    } finally {
      cleanup();
    }
  })();
}
