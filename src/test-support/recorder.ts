// A tiny hand-rolled call recorder so test-support modules stay free of any test-runner imports
// (they're imported by both vitest tests AND the ts-node replay CLI).
export type Recorder<Args extends unknown[], Return> = ((...args: Args) => Return) & { calls: Args[] };

export function createRecorder<Args extends unknown[], Return>(
  impl: (...args: Args) => Return,
): Recorder<Args, Return> {
  const calls: Args[] = [];
  const fn = (...args: Args): Return => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}
