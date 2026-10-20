import { AsyncLocalStorage } from "node:async_hooks";

type ProgressSink = (line: string) => void;
const sinks = new AsyncLocalStorage<ProgressSink>();

/** Route long-step progress for one command to its diagnostic stream; stdout stays the command result. */
export function withProgress<T>(sink: ProgressSink, run: () => Promise<T>): Promise<T> {
  return sinks.run(sink, run);
}

/** Report `done/total` for one step: the first item, then at most every 250 ms, and completion. */
export function progress(step: string, total: number, resumed = 0): (done: number) => void {
  const sink = sinks.getStore();
  if (!sink || !total) return () => {};
  let last = 0;
  return (done: number) => {
    const now = Date.now();
    if (done !== 1 && done !== total && now - last < 250) return;
    last = now;
    sink(`mdlm: ${step} ${done}/${total}${resumed ? ` (${resumed} resumed from checkpoint)` : ""}\n`);
  };
}
