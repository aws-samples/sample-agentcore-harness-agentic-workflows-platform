/**
 * Wave computation.
 *
 * Partitions a plan's tasks into sequential "waves": every task in a wave has
 * all of its dependencies satisfied by earlier waves. Tasks within a wave are
 * independent and can run in parallel (the interpreter's inner Map state).
 */

export interface WaveTask {
  id: string;
  dependsOn?: string[] | undefined;
}

export class PlanCycleError extends Error {
  constructor(public readonly remaining: string[]) {
    super(
      `Plan contains a dependency cycle involving: ${[...remaining].sort().join(', ')}`,
    );
    this.name = 'PlanCycleError';
  }
}

export class UnknownDependencyError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly dependencyId: string,
  ) {
    super(`Task "${taskId}" depends on unknown task "${dependencyId}"`);
    this.name = 'UnknownDependencyError';
  }
}

/**
 * Kahn-style layered topological sort.
 *
 * @throws UnknownDependencyError when a task references a missing id
 * @throws PlanCycleError when the dependency graph contains a cycle
 *   (a self-dependency is a cycle of length one)
 */
export function computeWaves(tasks: readonly WaveTask[]): string[][] {
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new UnknownDependencyError(task.id, dep);
      }
    }
  }

  const pending = new Map<string, Set<string>>();
  for (const task of tasks) {
    pending.set(task.id, new Set(task.dependsOn ?? []));
  }

  const waves: string[][] = [];
  const done = new Set<string>();
  while (pending.size > 0) {
    const wave: string[] = [];
    for (const [id, deps] of pending) {
      let satisfied = true;
      for (const dep of deps) {
        if (!done.has(dep)) {
          satisfied = false;
          break;
        }
      }
      if (satisfied) {
        wave.push(id);
      }
    }
    if (wave.length === 0) {
      throw new PlanCycleError([...pending.keys()]);
    }
    for (const id of wave) {
      pending.delete(id);
      done.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * Transitive skip propagation.
 *
 * Given the set of tasks whose output is unavailable (failed or already
 * skipped), returns every downstream task that can no longer run because a
 * direct or transitive dependency did not succeed.
 */
export function computeSkippedTasks(
  unavailable: ReadonlySet<string>,
  tasks: readonly WaveTask[],
): Set<string> {
  const skipped = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const wave of computeWaves(tasks)) {
    for (const id of wave) {
      const deps = byId.get(id)?.dependsOn ?? [];
      if (deps.some((dep) => unavailable.has(dep) || skipped.has(dep))) {
        skipped.add(id);
      }
    }
  }
  return skipped;
}
