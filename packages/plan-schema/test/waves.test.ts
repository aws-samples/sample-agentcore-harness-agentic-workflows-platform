import { describe, expect, it } from 'vitest';
import {
  PlanCycleError,
  UnknownDependencyError,
  computeSkippedTasks,
  computeWaves,
} from '../src/waves';

describe('computeWaves', () => {
  it('puts a single task in a single wave', () => {
    expect(computeWaves([{ id: 'a' }])).toEqual([['a']]);
  });

  it('puts independent tasks in one parallel wave', () => {
    expect(computeWaves([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('produces one wave per link of a dependency chain', () => {
    const waves = computeWaves([
      { id: 'c', dependsOn: ['b'] },
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ]);
    expect(waves).toEqual([['a'], ['b'], ['c']]);
  });

  it('handles diamond dependencies', () => {
    const waves = computeWaves([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(waves).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('throws PlanCycleError on a cycle', () => {
    expect(() =>
      computeWaves([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow(PlanCycleError);
  });

  it('treats a self-dependency as a cycle', () => {
    expect(() => computeWaves([{ id: 'a', dependsOn: ['a'] }])).toThrow(
      PlanCycleError,
    );
  });

  it('throws UnknownDependencyError for a missing dependency id', () => {
    expect(() => computeWaves([{ id: 'a', dependsOn: ['ghost'] }])).toThrow(
      UnknownDependencyError,
    );
  });

  it('returns an empty wave list for zero tasks', () => {
    expect(computeWaves([])).toEqual([]);
  });
});

describe('computeSkippedTasks', () => {
  const diamond = [
    { id: 'a' },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ];

  it('skips all downstream tasks when the root fails', () => {
    expect(computeSkippedTasks(new Set(['a']), diamond)).toEqual(
      new Set(['b', 'c', 'd']),
    );
  });

  it('propagates transitively through one branch only', () => {
    expect(computeSkippedTasks(new Set(['b']), diamond)).toEqual(
      new Set(['d']),
    );
  });

  it('skips nothing when independent tasks fail', () => {
    expect(
      computeSkippedTasks(new Set(['x']), [{ id: 'x' }, { id: 'y' }]),
    ).toEqual(new Set());
  });
});
