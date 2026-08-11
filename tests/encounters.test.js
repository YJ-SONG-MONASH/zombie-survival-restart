import { describe, expect, it } from 'vitest';
import {
  MAX_NODE_ZOMBIES,
  applyZombieKills,
  createNodeZombieState,
  grantEvasionWindow,
  isNodeSecured,
  normalizeNodeZombieStates,
  refreshNodeZombieState,
} from '../src/services/encounters.js';

describe('node zombie state creation and normalization', () => {
  it('creates deterministic, bounded, JSON-serializable state', () => {
    const input = { nodeId: 'west_point', danger: 4, seed: 913, day: 3 };
    const first = createNodeZombieState(input);
    const second = createNodeZombieState(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      nodeId: 'west_point',
      clearedDay: null,
      lastRefreshDay: 3,
      evasionUntilMinutes: 0,
      lastCombatMinutes: null,
    });
    expect(Number.isInteger(first.count)).toBe(true);
    expect(first.count).toBeGreaterThanOrEqual(Math.max(1, Math.floor(first.capacity * 0.25)));
    expect(first.count).toBeLessThanOrEqual(Math.floor(first.capacity * 0.45));
    expect(first.capacity).toBeLessThanOrEqual(MAX_NODE_ZOMBIES);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('changes deterministically with node identity, seed, or day', () => {
    const states = [
      createNodeZombieState({ nodeId: 'muldraugh', danger: 3, seed: 11, day: 1 }),
      createNodeZombieState({ nodeId: 'rosewood', danger: 3, seed: 11, day: 1 }),
      createNodeZombieState({ nodeId: 'muldraugh', danger: 3, seed: 12, day: 1 }),
      createNodeZombieState({ nodeId: 'muldraugh', danger: 3, seed: 11, day: 2 }),
    ];

    expect(new Set(states.map((state) => state.count)).size).toBeGreaterThan(1);
  });

  it('normalizes persisted states, fills missing nodes, and drops unknown nodes', () => {
    const nodes = [
      { id: 'muldraugh', danger: 3 },
      { id: 'rosewood', danger: 2 },
    ];
    const raw = {
      muldraugh: {
        nodeId: 'wrong-id',
        count: 99999,
        capacity: 99999,
        clearedDay: -4,
        lastRefreshDay: 'bad',
        evasionUntilMinutes: -30,
        lastCombatMinutes: 'bad',
      },
      removed_node: { nodeId: 'removed_node', count: 9 },
    };
    const snapshot = structuredClone(raw);

    const normalized = normalizeNodeZombieStates(raw, { nodes, seed: 77, day: 5 });

    expect(Object.keys(normalized)).toEqual(['muldraugh', 'rosewood']);
    expect(normalized.muldraugh.nodeId).toBe('muldraugh');
    expect(normalized.muldraugh.count).toBe(normalized.muldraugh.capacity);
    expect(normalized.muldraugh.capacity).toBeLessThanOrEqual(MAX_NODE_ZOMBIES);
    expect(normalized.muldraugh.clearedDay).toBeNull();
    expect(normalized.muldraugh.lastRefreshDay).toBe(5);
    expect(normalized.muldraugh.evasionUntilMinutes).toBe(0);
    expect(normalized.muldraugh.lastCombatMinutes).toBeNull();
    expect(normalized.rosewood).toEqual(createNodeZombieState({
      nodeId: 'rosewood',
      danger: 2,
      seed: 77,
      day: 5,
    }));
    expect(raw).toEqual(snapshot);
  });

  it('accepts array-shaped legacy input and preserves a valid cleared day', () => {
    const normalized = normalizeNodeZombieStates([
      {
        nodeId: 'riverside',
        count: 0,
        capacity: 40,
        clearedDay: 4,
        lastRefreshDay: 4,
        evasionUntilMinutes: 500,
        lastCombatMinutes: 410,
      },
    ], {
      nodes: [{ id: 'riverside', danger: 2 }],
      seed: 1,
      day: 5,
    });

    expect(normalized.riverside).toMatchObject({
      count: 0,
      clearedDay: 4,
      lastRefreshDay: 4,
      evasionUntilMinutes: 500,
      lastCombatMinutes: 410,
    });
  });
});

describe('migration, kills, and temporary evasion', () => {
  it('does not migrate zombies twice on the same day', () => {
    const state = createNodeZombieState({ nodeId: 'muldraugh', danger: 3, seed: 21, day: 4 });
    const refreshed = refreshNodeZombieState(state, {
      danger: 3,
      seed: 21,
      day: 4,
      worldThreat: 100,
    });

    expect(refreshed).toEqual(state);
    expect(refreshed).not.toBe(state);
  });

  it('repopulates a cleared node only on later days and caps migration', () => {
    const initial = createNodeZombieState({ nodeId: 'west_point', danger: 5, seed: 88, day: 6 });
    const cleared = applyZombieKills(initial, MAX_NODE_ZOMBIES, { day: 6, totalMinutes: 9_000 });

    expect(cleared.count).toBe(0);
    expect(cleared.clearedDay).toBe(6);
    expect(refreshNodeZombieState(cleared, {
      danger: 5,
      seed: 88,
      day: 6,
      worldThreat: 100,
    }).count).toBe(0);

    const lowThreat = refreshNodeZombieState(cleared, {
      danger: 5,
      seed: 88,
      day: 7,
      worldThreat: 0,
    });
    const highThreat = refreshNodeZombieState(cleared, {
      danger: 5,
      seed: 88,
      day: 7,
      worldThreat: 100,
    });
    const muchLater = refreshNodeZombieState(cleared, {
      danger: 5,
      seed: 88,
      day: 500,
      worldThreat: 100,
    });

    expect(lowThreat.count).toBeGreaterThan(0);
    expect(highThreat.count).toBeGreaterThanOrEqual(lowThreat.count);
    expect(highThreat.count).toBeLessThan(initial.count);
    expect(muchLater.count).toBe(muchLater.capacity);
    expect(muchLater.count).toBeLessThanOrEqual(MAX_NODE_ZOMBIES);
    expect(highThreat.clearedDay).toBe(6);
  });

  it('is deterministic and call-frequency invariant when threat is unchanged', () => {
    const initial = applyZombieKills(
      createNodeZombieState({ nodeId: 'louisville', danger: 6, seed: 42, day: 2 }),
      MAX_NODE_ZOMBIES,
      { day: 2, totalMinutes: 3_000 },
    );
    const direct = refreshNodeZombieState(initial, {
      danger: 6,
      seed: 42,
      day: 5,
      worldThreat: 60,
    });
    const stepped = [3, 4, 5].reduce((state, day) => refreshNodeZombieState(state, {
      danger: 6,
      seed: 42,
      day,
      worldThreat: 60,
    }), initial);

    expect(stepped).toEqual(direct);
  });

  it('never applies more kills than the current population or accepts invalid kills', () => {
    const state = {
      ...createNodeZombieState({ nodeId: 'rosewood', danger: 2, seed: 9, day: 3 }),
      count: 5,
    };
    const snapshot = structuredClone(state);

    expect(applyZombieKills(state, -2, { day: 3, totalMinutes: 600 })).toEqual(state);
    expect(applyZombieKills(state, 1.5, { day: 3, totalMinutes: 600 })).toEqual(state);
    const cleared = applyZombieKills(state, 999, { day: 3, totalMinutes: 610 });

    expect(cleared.count).toBe(0);
    expect(cleared.clearedDay).toBe(3);
    expect(cleared.lastCombatMinutes).toBe(610);
    expect(state).toEqual(snapshot);
  });

  it('preserves the original clear day when an already empty node is hit again', () => {
    const empty = {
      ...createNodeZombieState({ nodeId: 'riverside', danger: 2, seed: 3, day: 2 }),
      count: 0,
      clearedDay: 2,
      lastCombatMinutes: 300,
    };

    const unchanged = applyZombieKills(empty, 8, { day: 5, totalMinutes: 7_500 });

    expect(unchanged.count).toBe(0);
    expect(unchanged.clearedDay).toBe(2);
    expect(unchanged.lastCombatMinutes).toBe(300);
  });

  it('grants safety only until the evasion deadline without changing population', () => {
    const state = {
      ...createNodeZombieState({ nodeId: 'march_ridge', danger: 4, seed: 4, day: 2 }),
      count: 18,
    };
    const evaded = grantEvasionWindow(state, { totalMinutes: 1_000, minutes: 90 });

    expect(evaded.count).toBe(18);
    expect(evaded.clearedDay).toBeNull();
    expect(evaded.evasionUntilMinutes).toBe(1_090);
    expect(isNodeSecured(evaded, 1_000)).toBe(true);
    expect(isNodeSecured(evaded, 1_089)).toBe(true);
    expect(isNodeSecured(evaded, 1_090)).toBe(false);
    expect(isNodeSecured(evaded, 99_999)).toBe(false);
    expect(state.evasionUntilMinutes).toBe(0);
  });

  it('does not shorten an existing evasion window and treats zero population as secured', () => {
    const state = {
      ...createNodeZombieState({ nodeId: 'raven_creek', danger: 6, seed: 4, day: 2 }),
      evasionUntilMinutes: 2_000,
    };
    const notShortened = grantEvasionWindow(state, { totalMinutes: 1_000, minutes: 10 });
    const empty = { ...notShortened, count: 0, evasionUntilMinutes: 0 };

    expect(notShortened.evasionUntilMinutes).toBe(2_000);
    expect(isNodeSecured(empty, 1_000_000)).toBe(true);
  });
});
