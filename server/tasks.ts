// A tiny in-process queue for background work (reading job pages, tailoring).
type Task = () => Promise<void>;

export function makeQueue(concurrency: () => number) {
  const waiting: Task[] = [];
  let active = 0;
  const pump = () => {
    while (active < Math.max(1, concurrency()) && waiting.length) {
      const t = waiting.shift()!;
      active++;
      t()
        .catch((e) => console.error("[task]", e))
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return {
    push(t: Task) {
      waiting.push(t);
      pump();
    },
    get size() {
      return waiting.length + active;
    },
  };
}
