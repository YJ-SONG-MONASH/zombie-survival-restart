import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { mapNodes, marketItems, shelters } from '../src/data/zombie.js';
import { normalizeStorageInventory } from '../src/services/storage.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const SAVE_KEY = 'moshi-survival-state';
const clone = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function prepareRun(game) {
  game.shelter = clone(shelters[0]);
  expect(game.initializeMapState()).toBe(true);
  setZombieCount(game, game.currentNodeId, 0);
  return game;
}

function setZombieCount(game, nodeId, count, capacity = Math.max(100, count)) {
  const current = game.ensureNodeZombieState(nodeId);
  game.nodeZombieStates[nodeId] = {
    ...current,
    count,
    capacity,
    clearedDay: count > 0 ? null : game.day,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
  return game.nodeZombieStates[nodeId];
}

function zeroAllZombies(game) {
  mapNodes.forEach((node) => setZombieCount(game, node.id, 0));
}

function totalZombies(game) {
  return Object.values(game.nodeZombieStates)
    .reduce((sum, state) => sum + Math.max(0, Number(state?.count) || 0), 0);
}

function setPressure(game, nodeId, { noise = 0, activity = 0 } = {}) {
  expect(game.localPressure?.nodes?.[nodeId]).toBeTruthy();
  game.localPressure.nodes[nodeId] = {
    noiseUnits: Math.round(noise * 100),
    activityUnits: Math.round(activity * 100),
  };
}

function pressureAt(game, nodeId) {
  return game.nodePressureSummaryFor(nodeId);
}

function expeditionRequest(game, targetNodeId, kind = 'v11-pressure-preview') {
  return {
    ...game.expeditionCommandToken(kind),
    mode: 'one_way',
    strategy: 'fastest',
    targetNodeId,
  };
}

describe('v0.11 Store-owned local pressure', () => {
  let game;
  let localStorage;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    game = useGameStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ships save version 11 with a complete pressure graph and projects the current node', () => {
    expect(SAVE_VERSION).toBe(11);
    expect(game.saveVersion).toBe(SAVE_VERSION);
    expect(game.localPressure).toMatchObject({
      version: 1,
      revision: 0,
      lastProcessedMinute: 8 * 60,
      appliedEmissionIds: [],
      recentMigrations: [],
    });
    expect(Object.keys(game.localPressure.nodes).sort()).toEqual(mapNodes.map((node) => node.id).sort());

    prepareRun(game);
    expect(game.localPressureSummary.nodes).toHaveLength(mapNodes.length);
    expect(game.currentNodePressureSummary).toEqual(expect.objectContaining({
      nodeId: game.currentNodeId,
      noise: expect.any(Number),
      activity: expect.any(Number),
      noiseBand: expect.any(String),
      activityBand: expect.any(String),
    }));
    expect(game.world.noise).toBeCloseTo(game.currentNodePressureSummary.noise, 5);
    expect(game.world.threat).toBeCloseTo(game.currentNodePressureSummary.activity, 5);
  });

  it('migrates a v10 save by seeding only its physical node from legacy world noise and threat', () => {
    prepareRun(game);
    game.currentNodeId = 'dixie_highway_north';
    game.inspectedNodeId = game.currentNodeId;
    game.world.noise = 37;
    game.world.threat = 64;
    const legacy = clone(game.$state);
    legacy.saveVersion = 10;
    delete legacy.localPressure;
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: legacy }));

    const restored = useGameStore(createPinia());
    restored.loadPersistedState();

    expect(restored.saveVersion).toBe(11);
    expect(restored.localPressure.lastProcessedMinute).toBe(restored.totalWorldMinutes);
    expect(restored.currentNodePressureSummary).toEqual(expect.objectContaining({
      nodeId: 'dixie_highway_north',
      noise: 37,
      activity: 64,
    }));
    expect(pressureAt(restored, 'louisville')).toEqual(expect.objectContaining({ noise: 0, activity: 0 }));
    expect(restored.world.noise).toBe(37);
    expect(restored.world.threat).toBe(64);
  });

  it('keeps loud remote work out of the home perimeter pressure calculation', () => {
    prepareRun(game);
    const homeId = game.spawnLocation.id;
    setZombieCount(game, homeId, 40);
    const before = clone(game.baseSecuritySummary);
    expect(before.currentPressureSources).toEqual(expect.objectContaining({ threat: 0, noise: 0 }));

    game.currentNodeId = 'louisville';
    game.inspectedNodeId = 'louisville';
    const result = game.advanceSimulation({
      minutes: 30,
      mode: 'active',
      noiseDelta: 90,
      threatDelta: 90,
    });

    expect(result.localPressure).toEqual(expect.objectContaining({ ok: true }));
    expect(pressureAt(game, 'louisville').noise).toBeGreaterThan(0);
    expect(pressureAt(game, 'louisville').activity).toBeGreaterThan(0);
    expect(pressureAt(game, homeId)).toEqual(expect.objectContaining({ noise: 0, activity: 0 }));
    expect(game.baseSecuritySummary.currentPressure).toBe(before.currentPressure);
    expect(game.baseSecuritySummary.currentPressureSources).toEqual(expect.objectContaining({
      threat: 0,
      noise: 0,
      exteriorPopulation: 40,
    }));
    expect(game.world.noise).toBeCloseTo(game.currentNodePressureSummary.noise, 5);
    expect(game.world.threat).toBeCloseTo(game.currentNodePressureSummary.activity, 5);
  });

  it('does not let non-adjacent remote activity amplify a home migration edge', () => {
    prepareRun(game);
    zeroAllZombies(game);
    const homeId = game.spawnLocation.id;
    const sourceId = 'dixie_highway_north';
    const remoteId = 'louisville';
    setZombieCount(game, sourceId, 30, 100);
    setZombieCount(game, homeId, 0, 100);
    setPressure(game, homeId, { noise: 100, activity: 0 });
    setPressure(game, sourceId, { noise: 0, activity: 0 });
    game.world.noise = 100;
    game.world.threat = 0;
    const initialState = clone(game.$state);

    const runScenario = (remoteActivity) => {
      const scenario = useGameStore(createPinia());
      scenario.$patch(clone(initialState));
      setPressure(scenario, remoteId, { noise: 0, activity: remoteActivity });
      const result = scenario.advanceSimulation({ minutes: 4 * 60, mode: 'active' });
      return {
        edgeEvents: result.localPressure.events.filter((event) => (
          [event.fromNodeId, event.toNodeId].includes(homeId)
          && [event.fromNodeId, event.toNodeId].includes(sourceId)
        )),
        homeCount: scenario.nodeZombieStates[homeId].count,
        sourceCount: scenario.nodeZombieStates[sourceId].count,
      };
    };

    const quietRemote = runScenario(0);
    const loudRemote = runScenario(100);
    expect(quietRemote.edgeEvents.length).toBeGreaterThan(0);
    expect(loudRemote).toEqual(quietRemote);
    expect(loudRemote.edgeEvents.every((event) => event.worldThreat === 0)).toBe(true);
  });

  it('records generator startup at home without turning distant regions noisy', () => {
    prepareRun(game);
    const homeId = game.spawnLocation.id;
    const generator = marketItems.find((item) => item.id === 'generator');
    game.baseInventory = normalizeStorageInventory([
      { ...clone(generator), count: 1 },
    ], marketItems, { containerId: 'base' });
    game.skills.electrical = 3;
    game.base.generatorFuel = 3;

    expect(game.toggleGenerator()).toBe(true);

    expect(game.base.generatorOn).toBe(true);
    expect(pressureAt(game, homeId).noise).toBeGreaterThan(0);
    expect(pressureAt(game, homeId).activity).toBeGreaterThan(0);
    expect(pressureAt(game, 'louisville')).toEqual(expect.objectContaining({ noise: 0, activity: 0 }));
    expect(game.world.noise).toBeCloseTo(pressureAt(game, homeId).noise, 5);
    expect(game.world.threat).toBeCloseTo(pressureAt(game, homeId).activity, 5);
  });

  it('moves zombies toward a loud adjacent node at the absolute six-hour boundary and conserves population', () => {
    prepareRun(game);
    zeroAllZombies(game);
    const destinationId = game.spawnLocation.id;
    const sourceId = 'dixie_highway_north';
    setZombieCount(game, sourceId, 30);
    setZombieCount(game, destinationId, 0, 100);
    const beforeTotal = totalZombies(game);

    const result = game.advanceSimulation({
      minutes: 4 * 60,
      mode: 'active',
      noiseDelta: 100,
      threatDelta: 35,
    });

    expect(result.localPressure).toEqual(expect.objectContaining({
      ok: true,
      processedBoundaryMinutes: [12 * 60],
      totals: { before: beforeTotal, after: beforeTotal },
    }));
    expect(result.localPressure.events).toContainEqual(expect.objectContaining({
      type: 'migration',
      boundaryMinute: 12 * 60,
      fromNodeId: sourceId,
      toNodeId: destinationId,
      count: expect.any(Number),
      reason: 'local_sound',
    }));
    expect(game.nodeZombieStates[sourceId].count).toBeLessThan(30);
    expect(game.nodeZombieStates[destinationId].count).toBeGreaterThan(0);
    expect(totalZombies(game)).toBe(beforeTotal);
  });

  it('does not migrate zombies into or out of the node owned by an active tactical encounter', () => {
    prepareRun(game);
    zeroAllZombies(game);
    const lockedId = 'dixie_highway_north';
    const neighborId = game.spawnLocation.id;
    setZombieCount(game, lockedId, 5, 100);
    setZombieCount(game, neighborId, 40, 100);
    game.currentNodeId = lockedId;
    game.inspectedNodeId = lockedId;
    expect(game.startTacticalEncounter()).toBe(true);
    const lockedBefore = game.nodeZombieStates[lockedId].count;
    const neighborBefore = game.nodeZombieStates[neighborId].count;

    const result = game.advanceSimulation({
      minutes: 4 * 60,
      mode: 'active',
      noiseDelta: 100,
      threatDelta: 35,
    });

    expect(result.localPressure.ok).toBe(true);
    expect(result.localPressure.processedBoundaryMinutes).toEqual([12 * 60]);
    expect(result.localPressure.events.some((event) => (
      event.fromNodeId === lockedId || event.toNodeId === lockedId
    ))).toBe(false);
    expect(game.nodeZombieStates[lockedId].count).toBe(lockedBefore);
    expect(game.nodeZombieStates[neighborId].count).toBe(neighborBefore);
    expect(totalZombies(game)).toBe(lockedBefore + neighborBefore);
  });

  it('raises expedition risk from known target pressure and population without consulting unknown nodes', () => {
    prepareRun(game);
    const originId = game.currentNodeId;
    const targetId = game.currentNeighborNodes.find((node) => node.id === 'dixie_highway_north')?.id
      ?? game.currentNeighborNodes[0].id;
    setZombieCount(game, originId, 0);
    setZombieCount(game, targetId, 0);
    setPressure(game, targetId, { noise: 0, activity: 0 });
    const request = expeditionRequest(game, targetId);
    const quiet = game.previewExpeditionPlan(request);
    expect(quiet.ok).toBe(true);

    setZombieCount(game, targetId, 60, 100);
    setPressure(game, targetId, { noise: 100, activity: 100 });
    const pressured = game.previewExpeditionPlan(request);
    expect(pressured.ok).toBe(true);
    expect(pressured.plan.riskScore).toBeGreaterThan(quiet.plan.riskScore);
    expect(pressured.plan.outboundSegments.at(-1).risk)
      .toBeGreaterThan(quiet.plan.outboundSegments.at(-1).risk);

    const unknownId = mapNodes.find((node) => !game.knownNodeIds.includes(node.id))?.id;
    expect(unknownId).toBeTruthy();
    setZombieCount(game, unknownId, 999, 999);
    setPressure(game, unknownId, { noise: 100, activity: 100 });
    expect(game.previewExpeditionPlan(request)).toEqual(pressured);
  });

  it('round-trips the exact local pressure ledger, migrations, and world projection', () => {
    prepareRun(game);
    zeroAllZombies(game);
    setZombieCount(game, 'dixie_highway_north', 30);
    game.advanceSimulation({
      minutes: 4 * 60,
      mode: 'active',
      noiseDelta: 100,
      threatDelta: 35,
    });
    const expectedPressure = clone(game.localPressure);
    const expectedZombies = clone(game.nodeZombieStates);
    const expectedWorld = clone(game.world);
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: clone(game.$state) }));

    const restored = useGameStore(createPinia());
    restored.loadPersistedState();

    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.localPressure).toEqual(expectedPressure);
    expect(Object.fromEntries(Object.entries(restored.nodeZombieStates).map(([nodeId, state]) => [nodeId, state.count])))
      .toEqual(Object.fromEntries(Object.entries(expectedZombies).map(([nodeId, state]) => [nodeId, state.count])));
    expect(restored.world).toEqual(expectedWorld);
    expect(restored.world.noise).toBeCloseTo(restored.currentNodePressureSummary.noise, 5);
    expect(restored.world.threat).toBeCloseTo(restored.currentNodePressureSummary.activity, 5);
  });

  it('throws before any write when the local timeline is invalid', () => {
    prepareRun(game);
    game.localPressure.lastProcessedMinute += 1;
    const before = clone(game.$state);

    expect(() => game.advanceSimulation({
      minutes: 30,
      mode: 'active',
      noiseDelta: 20,
      threatDelta: 10,
    })).toThrow(/local|pressure|timeline/i);
    expect(game.$state).toEqual(before);
  });

  it('rolls a complete movement transaction back when local pressure advancement fails', () => {
    prepareRun(game);
    const destinationId = game.currentNeighborNodes[0].id;
    setZombieCount(game, destinationId, 0);
    game.localPressure.lastProcessedMinute += 1;
    const before = clone(game.$state);

    expect(game.moveToNode(destinationId)).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('rolls a complete tactical turn back when local pressure advancement fails', () => {
    prepareRun(game);
    setZombieCount(game, game.currentNodeId, 5, 100);
    expect(game.startTacticalEncounter()).toBe(true);
    const before = clone(game.$state);
    vi.spyOn(game, 'advanceSimulation').mockImplementation(() => {
      throw new Error('injected-local-pressure-failure');
    });

    expect(game.performTacticalAction('brace', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
    })).toBe(false);
    expect(game.$state).toEqual(before);
  });
});
