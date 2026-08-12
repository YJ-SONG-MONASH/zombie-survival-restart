import { describe, expect, it } from 'vitest';

import {
  LOCAL_PRESSURE_VERSION,
  advanceLocalPressure,
  createLocalPressureState,
  normalizeLocalPressureState,
  summarizeLocalPressure,
} from '../src/services/local-pressure.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const graph = {
  nodes: [
    { id: 'home', danger: 2 },
    { id: 'road', danger: 3 },
    { id: 'town', danger: 5 },
    { id: 'farm', danger: 1 },
  ],
  edges: [['home', 'road'], ['road', 'town'], ['road', 'farm']],
};

function zombieStates(overrides = {}) {
  return Object.fromEntries(graph.nodes.map((node) => [node.id, {
    version: 1,
    nodeId: node.id,
    count: 0,
    capacity: 100,
    clearedDay: 1,
    lastRefreshDay: 1,
    evasionUntilMinutes: 0,
    lastCombatMinutes: null,
    ...(overrides[node.id] ?? {}),
  }]));
}

function advance(state, overrides = {}) {
  return advanceLocalPressure(state, {
    ...graph,
    fromTotalMinutes: state.lastProcessedMinute,
    toTotalMinutes: 360,
    worldSeed: 7321,
    worldThreat: 35,
    nodeZombieStates: zombieStates({
      home: { count: 18, clearedDay: null },
      road: { count: 4, clearedDay: null },
      town: { count: 0 },
      farm: { count: 1, clearedDay: null },
    }),
    ...overrides,
  });
}

describe('local pressure state and migration', () => {
  it('creates JSON-only pressure at one legal migration node using display-point inputs', () => {
    const state = createLocalPressureState({
      ...graph,
      totalMinutes: 125,
      initialNodeId: 'home',
      initialNoise: 18.25,
      initialActivity: 8,
    });

    expect(state).toEqual({
      version: LOCAL_PRESSURE_VERSION,
      revision: 0,
      lastProcessedMinute: 125,
      appliedEmissionIds: [],
      nodes: {
        home: { noiseUnits: 1825, activityUnits: 800 },
        road: { noiseUnits: 0, activityUnits: 0 },
        town: { noiseUnits: 0, activityUnits: 0 },
        farm: { noiseUnits: 0, activityUnits: 0 },
      },
      recentMigrations: [],
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('normalizes hostile saves, drops unknown nodes, and only seeds a wholly missing node map', () => {
    const raw = {
      version: 999,
      revision: Number.POSITIVE_INFINITY,
      lastProcessedMinute: -12,
      appliedEmissionIds: ['ok', 'ok', '', 7],
      nodes: {
        home: { noiseUnits: 1250.4, activityUnits: -20 },
        road: { noiseUnits: Number.NaN, activityUnits: 400 },
        forged: { noiseUnits: 999999, activityUnits: 999999 },
      },
      recentMigrations: [{ type: 'migration', fromNodeId: 'forged', toNodeId: 'home' }],
    };
    const before = clone({ ...raw, revision: null, nodes: { ...raw.nodes, road: { noiseUnits: null, activityUnits: 400 } } });
    const normalized = normalizeLocalPressureState(raw, {
      ...graph,
      totalMinutes: 600,
      initialNodeId: 'town',
      initialNoise: 90,
      initialActivity: 90,
    });

    expect(normalized).toMatchObject({
      version: 1,
      revision: 0,
      lastProcessedMinute: 600,
      appliedEmissionIds: ['ok'],
    });
    expect(Object.keys(normalized.nodes)).toEqual(['home', 'road', 'town', 'farm']);
    expect(normalized.nodes.home).toEqual({ noiseUnits: 1250, activityUnits: 0 });
    expect(normalized.nodes.road).toEqual({ noiseUnits: 0, activityUnits: 400 });
    expect(normalized.nodes.town).toEqual({ noiseUnits: 0, activityUnits: 0 });
    expect(normalized.recentMigrations).toEqual([]);
    // JSON cloning cannot retain NaN/Infinity, so assert the meaningful source fields directly.
    expect(raw.nodes.forged.noiseUnits).toBe(999999);
    expect(raw.nodes.home.noiseUnits).toBe(1250.4);
    expect(before.nodes.road.activityUnits).toBe(400);

    const migrated = normalizeLocalPressureState(null, {
      ...graph,
      totalMinutes: 600,
      initialNodeId: 'town',
      initialNoise: 90,
      initialActivity: 45,
    });
    expect(migrated.nodes.town).toEqual({ noiseUnits: 9000, activityUnits: 4500 });
  });

  it('decays local signals by elapsed minutes and propagates noise by graph distance', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const result = advanceLocalPressure(initial, {
      ...graph,
      fromTotalMinutes: 0,
      toTotalMinutes: 60,
      worldSeed: 9,
      worldThreat: 0,
      nodeZombieStates: zombieStates(),
      emissions: [{ id: 'shot', nodeId: 'home', atMinutes: 0, noiseDelta: 60, activityDelta: 30 }],
    });

    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.processedBoundaryMinutes).toEqual([]);
    expect(result.nextState.nodes.home.noiseUnits).toBeGreaterThan(result.nextState.nodes.road.noiseUnits);
    expect(result.nextState.nodes.road.noiseUnits).toBeGreaterThan(result.nextState.nodes.town.noiseUnits);
    expect(result.nextState.nodes.town.noiseUnits).toBeGreaterThan(0);
    expect(result.nextState.nodes.farm.noiseUnits).toBe(result.nextState.nodes.town.noiseUnits);
    expect(result.nextState.nodes.home.activityUnits).toBeGreaterThan(0);
    expect(result.nextState.nodes.road.activityUnits).toBe(0);
    expect(result.nextState.nodes.home.noiseUnits).toBeLessThan(6000);
    expect(result.nextState.nodes.home.activityUnits).toBeLessThan(3000);
  });

  it('is deterministic, migrates toward a loud node, preserves global population, and reports exact events', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const input = {
      ...graph,
      fromTotalMinutes: 0,
      toTotalMinutes: 360,
      worldSeed: 7722,
      worldThreat: 50,
      nodeZombieStates: zombieStates({
        home: { count: 20, clearedDay: null },
        road: { count: 3, clearedDay: null },
        town: { count: 0 },
        farm: { count: 2, clearedDay: null },
      }),
      emissions: [{ id: 'siren', nodeId: 'town', atMinutes: 330, noiseDelta: 100, activityDelta: 80 }],
    };
    const first = advanceLocalPressure(initial, input);
    const second = advanceLocalPressure(initial, clone(input));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.processedBoundaryMinutes).toEqual([360]);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.every((event) => event.type === 'migration' && event.reason === 'local_sound')).toBe(true);
    expect(first.events.some((event) => event.toNodeId === 'town')).toBe(true);
    expect(first.totals.before).toBe(25);
    expect(first.totals.after).toBe(25);
    expect(first.nextNodeZombieStates.town.count).toBeGreaterThan(0);
    expect(first.nextNodeZombieStates.town.clearedDay).toBeNull();
    expect(first.nextState.recentMigrations).toEqual(first.events.slice(-32));
  });

  it('uses a higher threshold to pull zombies back into a location cleared that day', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const base = {
      ...graph,
      fromTotalMinutes: 0,
      toTotalMinutes: 360,
      worldSeed: 42,
      worldThreat: 40,
      nodeZombieStates: zombieStates({
        home: { count: 12, clearedDay: null },
        road: { count: 0, clearedDay: 1 },
      }),
    };
    const low = advanceLocalPressure(initial, {
      ...base,
      emissions: [{ id: 'low', nodeId: 'road', atMinutes: 350, noiseDelta: 18, activityDelta: 5 }],
    });
    const high = advanceLocalPressure(initial, {
      ...base,
      emissions: [{ id: 'high', nodeId: 'road', atMinutes: 350, noiseDelta: 100, activityDelta: 80 }],
    });

    expect(low.ok).toBe(true);
    expect(low.nextNodeZombieStates.road.count).toBe(0);
    expect(high.nextNodeZombieStates.road.count).toBeGreaterThan(0);
    expect(high.nextNodeZombieStates.road.clearedDay).toBeNull();
  });

  it('does not create migration in a silent graph', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const result = advance(initial, { emissions: [] });

    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.nextNodeZombieStates).toEqual(zombieStates({
      home: { count: 18, clearedDay: null },
      road: { count: 4, clearedDay: null },
      town: { count: 0 },
      farm: { count: 1, clearedDay: null },
    }));
    expect(result.totals).toEqual({ before: 23, after: 23 });
  });

  it('is one-shot versus segmented equivalent, including duplicate emission delivery', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const zombies = zombieStates({
      home: { count: 30, clearedDay: null },
      road: { count: 7, clearedDay: null },
      town: { count: 0 },
      farm: { count: 3, clearedDay: null },
    });
    const emissions = [
      { id: 'alarm-a', nodeId: 'town', atMinutes: 110, noiseDelta: 75, activityDelta: 45 },
      { id: 'alarm-b', nodeId: 'farm', atMinutes: 520, noiseDelta: 95, activityDelta: 55 },
    ];
    const common = { ...graph, worldSeed: 1818, worldThreat: 55, emissions };
    const oneShot = advanceLocalPressure(initial, {
      ...common,
      fromTotalMinutes: 0,
      toTotalMinutes: 720,
      nodeZombieStates: zombies,
    });
    const first = advanceLocalPressure(initial, {
      ...common,
      fromTotalMinutes: 0,
      toTotalMinutes: 215,
      nodeZombieStates: zombies,
    });
    const second = advanceLocalPressure(first.nextState, {
      ...common,
      fromTotalMinutes: 215,
      toTotalMinutes: 720,
      nodeZombieStates: first.nextNodeZombieStates,
    });

    expect(oneShot.ok).toBe(true);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.nextState).toEqual(oneShot.nextState);
    expect(second.nextNodeZombieStates).toEqual(oneShot.nextNodeZombieStates);
    expect([...first.events, ...second.events]).toEqual(oneShot.events);
  });

  it('prevents migration through locked tactical nodes while allowing other edges', () => {
    const initial = createLocalPressureState({ ...graph, totalMinutes: 0 });
    const input = {
      ...graph,
      fromTotalMinutes: 0,
      toTotalMinutes: 360,
      worldSeed: 313,
      worldThreat: 70,
      nodeZombieStates: zombieStates({
        home: { count: 25, clearedDay: null },
        road: { count: 15, clearedDay: null },
        town: { count: 0 },
        farm: { count: 0 },
      }),
      emissions: [
        { id: 'town-lure', nodeId: 'town', atMinutes: 350, noiseDelta: 100, activityDelta: 90 },
        { id: 'farm-lure', nodeId: 'farm', atMinutes: 350, noiseDelta: 100, activityDelta: 90 },
      ],
      lockedNodeIds: ['town', 'town', 'forged'],
    };
    const beforeLocks = clone(input.lockedNodeIds);
    const result = advanceLocalPressure(initial, input);

    expect(result.ok).toBe(true);
    expect(result.nextNodeZombieStates.town.count).toBe(0);
    expect(result.events.every((event) => event.fromNodeId !== 'town' && event.toNodeId !== 'town')).toBe(true);
    expect(result.nextNodeZombieStates.farm.count).toBeGreaterThan(0);
    expect(result.totals.before).toBe(result.totals.after);
    expect(input.lockedNodeIds).toEqual(beforeLocks);
  });

  it('rejects invalid advance input without mutating state, zombies, emissions, or locks', () => {
    const state = createLocalPressureState({ ...graph, totalMinutes: 100 });
    const zombies = zombieStates({ home: { count: 4, clearedDay: null } });
    const emissions = [{ id: 'bad', nodeId: 'home', atMinutes: 120, noiseDelta: 5 }];
    const locks = ['home'];
    const before = clone({ state, zombies, emissions, locks });
    const result = advanceLocalPressure(state, {
      ...graph,
      fromTotalMinutes: 99,
      toTotalMinutes: 200,
      worldSeed: 1,
      worldThreat: 2,
      nodeZombieStates: zombies,
      emissions,
      lockedNodeIds: locks,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeline_mismatch');
    expect(result.events).toEqual([]);
    expect({ state, zombies, emissions, locks }).toEqual(before);
  });

  it('summarizes display points and stable bands without exposing mutable state', () => {
    const state = createLocalPressureState({
      ...graph,
      totalMinutes: 10,
      initialNodeId: 'home',
      initialNoise: 82.345,
      initialActivity: 46.789,
    });
    const summary = summarizeLocalPressure(state, graph);

    expect(summary).toMatchObject({
      version: 1,
      revision: 0,
      lastProcessedMinute: 10,
      hottestNodeId: 'home',
      loudestNodeId: 'home',
      totalNoise: 82.35,
      totalActivity: 46.79,
    });
    expect(summary.nodes.find((node) => node.nodeId === 'home')).toEqual({
      nodeId: 'home',
      noise: 82.35,
      activity: 46.79,
      noiseBand: 'extreme',
      activityBand: 'medium',
    });
    summary.nodes[0].noise = 0;
    expect(state.nodes.home.noiseUnits).toBe(8235);
  });
});
