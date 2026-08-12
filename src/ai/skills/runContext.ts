// Read-before-write bookkeeping for one run (one chat request, or one
// background review run). The spec forbids patching or deleting a skill the
// agent has not actually read IN THIS RUN — a model that patches from memory
// rewrites a body it never saw, which is exactly how a good skill gets
// clobbered by a half-remembered one. Deliberately in-memory and per-run: a
// process-wide set would let a read from an unrelated session authorize a
// write here.
export interface SkillRunContext {
  markRead(name: string): void;
  hasRead(name: string): boolean;
  readNames(): string[];
}

export function createSkillRunContext(): SkillRunContext {
  const read = new Set<string>();
  return {
    markRead(name) {
      read.add(name);
    },
    hasRead(name) {
      return read.has(name);
    },
    readNames() {
      return [...read];
    },
  };
}
