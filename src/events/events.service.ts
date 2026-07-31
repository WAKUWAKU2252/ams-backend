import { EventEmitter } from "node:events";
import { createSseStream } from "../common/sse";

export const eventBus = new EventEmitter();

export function broadcast(data: unknown) {
  eventBus.emit("message", data);
}
export function eventStream(signal: AbortSignal | undefined) {
  return createSseStream(signal, (push) => {
    const onMessage = (data: unknown) => push({ event: "message", data });
    eventBus.on("message", onMessage);
    return () => eventBus.off("message", onMessage);
  });
}
