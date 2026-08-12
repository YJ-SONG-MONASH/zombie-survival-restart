import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { mapNodes, marketItems, shelters } from '../src/data/zombie.js';
import { createBaseSecurity } from '../src/services/base-security.js';
import { createItemConditionState } from '../src/services/item-condition.js';
import { normalizeStorageInventory } from '../src/services/storage.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const SAVE_KEY = 'moshi-survival-state';
const clone = (value) => JSON.parse(JSON.stringify(value));
const item = (id) => marketItems.find((entry) => entry.id === id);

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function rawStack(id, count = 1, sequence = 1) {
  const catalogItem = item(id);
  const conditionState = createItemConditionState(catalogItem, {
    acquiredMinutes: 480,
    acquisitionSequence: sequence,
    sourceId: 'v09-base-store-test',
  });
  return {
    ...clone(catalogItem),
    count,
    stackId: conditionState.stackId,
    conditionState,
  };
}

function normalizedInventory(entries, containerId) {
  return normalizeStorageInventory(entries, marketItems, { containerId });
}

function setExteriorPopulation(game, count) {
  const state = game.ensureNodeZombieState(game.spawnLocation.id);
  game.nodeZombieStates[game.spawnLocation.id] = {
    ...state,
    count,
    clearedDay: count > 0 ? null : game.day,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
}

function syncPressureClock(game) {
  game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
  game.fishing.lastProcessedMinute = game.totalWorldMinutes;
}

function prepareRun(game, shelterId = 'gated_villa') {
  game.shelter = clone(shelters.find((entry) => entry.id === shelterId) ?? shelters[0]);
  game.initializeMapState();
  setExteriorPopulation(game, 0);
  game.baseSecurity = createBaseSecurity({ shelter: game.shelter, totalMinutes: game.totalWorldMinutes });
  game.inventory = [];
  game.baseInventory = [];
  game.skills.carpentry = 3;
  game.world.powerOn = true;
  game.world.waterOn = true;
}

function installWorkMaterials(game) {
  game.inventory = normalizedInventory([
    rawStack('plank', 1, 10),
    rawStack('nails', 1, 11),
  ], 'carry');
  game.baseInventory = normalizedInventory([
    rawStack('hammer', 1, 12),
    rawStack('plank', 1, 13),
    rawStack('nails', 2, 14),
  ], 'base');
  return {
    tool: game.baseInventory.find((entry) => entry.id === 'hammer'),
    selectedPlank: game.inventory.find((entry) => entry.id === 'plank'),
    untouchedPlank: game.baseInventory.find((entry) => entry.id === 'plank'),
    selectedNails: game.baseInventory.find((entry) => entry.id === 'nails'),
    untouchedNails: game.inventory.find((entry) => entry.id === 'nails'),
  };
}

function workCommand(game, materials, overrides = {}) {
  return {
    kind: 'fortify',
    openingId: 'front_window',
    expectedRevision: game.baseSecurity.revision,
    commandId: `store-work:${game.baseSecurity.revision}:${Math.random().toString(36).slice(2)}`,
    tool: { containerId: 'base', stackId: materials.tool.stackId },
    materials: [
      { containerId: 'carry', stackId: materials.selectedPlank.stackId, count: 1 },
      { containerId: 'base', stackId: materials.selectedNails.stackId, count: 1 },
    ],
    ...overrides,
  };
}

function expectRejectedWithoutMutation(game, invoke, reason) {
  const before = clone(game.$state);
  const result = invoke();
  expect(result).toEqual(expect.objectContaining({ ok: false, committed: false, reason }));
  expect(game.$state).toEqual(before);
  return result;
}

describe('v0.9 base security Store integration', () => {
  let game;
  let localStorage;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    game = useGameStore();
    prepareRun(game);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('initializes a selected shelter with a fresh authoritative perimeter', () => {
    game.resetGame();
    const shelter = clone(shelters.find((entry) => entry.id === 'gated_villa'));
    game.shelterChoices = [shelter];

    expect(game.selectShelter(shelter.id)).toBe(true);

    expect(game.baseSecurity).toMatchObject({ version: 1, revision: 0, lastProcessedHour: 8, lastIncident: null });
    expect(game.baseSecurity.openings).toHaveLength(3);
    expect(game.baseSecuritySummary).toMatchObject({ status: 'intact', interiorSafe: true, exteriorPopulation: 0 });
    expect(game.base).toMatchObject({ barricades: 0, defense: shelter.defense });
  });

  it('previews exact work without changing the Store', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'preview-only' });
    const before = clone(game.$state);

    const preview = game.previewBaseWork(command);

    expect(preview).toMatchObject({ ok: true, committed: false, kind: 'fortify', minutes: 90, barricadeDelta: 41 });
    expect(preview.nextState.baseSecurity.revision).toBe(game.baseSecurity.revision);
    expect(game.$state).toEqual(before);
  });

  it('consumes exact carry/base material lots, keeps the hammer, and advances time once', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'exact-cross-container' });
    const beforeMinutes = game.totalWorldMinutes;
    const beforeXp = game.skillXp.carpentry;

    const result = game.performBaseWork(command);

    expect(result).toMatchObject({ ok: true, committed: true, minutes: 90, skillXp: 18 });
    expect(game.totalWorldMinutes - beforeMinutes).toBe(90);
    expect(game.inventory.some((entry) => entry.stackId === materials.selectedPlank.stackId)).toBe(false);
    expect(game.baseInventory.some((entry) => entry.stackId === materials.untouchedPlank.stackId)).toBe(true);
    expect(game.baseInventory.find((entry) => entry.stackId === materials.selectedNails.stackId)?.count).toBe(1);
    expect(game.inventory.some((entry) => entry.stackId === materials.untouchedNails.stackId)).toBe(true);
    expect(game.baseInventory.some((entry) => entry.stackId === materials.tool.stackId)).toBe(true);
    expect(game.skillXp.carpentry).toBeGreaterThan(beforeXp);
    expect(game.history.at(-1)).toMatchObject({ log: '据点防线维护' });
    expect(game.mapLog.some((entry) => entry.mode === 'base_security')).toBe(true);
  });

  it('rejects stale commands with complete zero mutation', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'stale', expectedRevision: game.baseSecurity.revision + 1 });
    expectRejectedWithoutMutation(game, () => game.performBaseWork(command), 'stale_revision');
  });

  it('rejects duplicate replays before stale revisions with complete zero mutation', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'once-only' });
    expect(game.performBaseWork(command)).toEqual(expect.objectContaining({ ok: true, committed: true }));

    expectRejectedWithoutMutation(game, () => game.performBaseWork({ ...command, expectedRevision: 0 }), 'duplicate_command');
  });

  it('rolls back the complete Store when time advancement fails after projection', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'rollback-on-simulation-failure' });
    const before = clone(game.$state);
    vi.spyOn(game, 'advanceSimulation').mockImplementation(() => {
      throw new Error('injected simulation failure');
    });

    const result = game.performBaseWork(command);

    expect(result).toEqual(expect.objectContaining({ ok: false, committed: false, reason: 'commit_failed' }));
    expect(game.$state).toEqual(before);
  });

  it('rejects remote work without consuming materials or time', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'remote' });
    const neighbor = mapNodes.find((node) => game.currentNeighborNodes.some((entry) => entry.id === node.id));
    game.currentNodeId = neighbor.id;
    const local = game.ensureNodeZombieState(neighbor.id);
    game.nodeZombieStates[neighbor.id] = { ...local, count: 0, clearedDay: game.day };

    expectRejectedWithoutMutation(game, () => game.performBaseWork(command), 'not_at_home');
  });

  it('rejects work during an active tactical encounter with complete zero mutation', () => {
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'active-tactical' });
    game.activeTacticalEncounter = { status: 'active' };

    expectRejectedWithoutMutation(game, () => game.performBaseWork(command), 'active_tactical_encounter');
  });

  it('keeps intact interiors functional while preserving an exterior zombie population', () => {
    setExteriorPopulation(game, 9);
    game.inventory = normalizedInventory([rawStack('water_bottle', 1, 30)], 'carry');
    const water = game.inventory[0];

    expect(game.baseInteriorSafe).toBe(true);
    expect(game.isCurrentNodeSecured).toBe(true);
    expect(game.currentEncounter).toBeNull();
    expect(game.currentNodeActions.find((entry) => entry.id === 'sleep')).toMatchObject({ disabled: false });
    expect(game.canPerformWorldAction('food_preparation', 180)).toBe(true);
    expect(game.storageContainers.find((entry) => entry.id === 'base').accessible).toBe(true);
    expect(game.transferItem({ fromId: 'carry', toId: 'base', stackId: water.stackId, quantity: 1 }))
      .toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(game.nodeZombieStates[game.spawnLocation.id].count).toBe(9);
  });

  it('locks the breached interior only while exterior zombies remain and opens tactical combat', () => {
    game.baseSecurity.openings[0].integrity = 0;
    setExteriorPopulation(game, 6);
    game.nodeZombieStates[game.spawnLocation.id].evasionUntilMinutes = game.totalWorldMinutes + 12 * 60;
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { kind: 'repair', openingId: 'front_door', commandId: 'blocked-repair' });

    expect(game.baseInteriorSafe).toBe(false);
    expect(game.isCurrentNodeSecured).toBe(false);
    expect(game.currentEncounter).toMatchObject({ population: 6 });
    expect(game.storageContainers.find((entry) => entry.id === 'base').accessible).toBe(false);
    expect(game.currentNodeActions.find((entry) => entry.id === 'sleep')).toMatchObject({ disabled: true });
    expectRejectedWithoutMutation(game, () => game.performBaseWork(command), 'exterior_not_cleared');
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    expect(game.activeTacticalEncounter).toMatchObject({ status: 'active', nodeId: game.spawnLocation.id });
    expect(game.nodeZombieStates[game.spawnLocation.id].count).toBe(6);
  });

  it('allows an exact repair after the exterior group is cleared', () => {
    game.baseSecurity.openings[0].integrity = 0;
    setExteriorPopulation(game, 0);
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { kind: 'repair', openingId: 'front_door', commandId: 'clear-then-repair' });
    const beforeMinutes = game.totalWorldMinutes;

    const result = game.performBaseWork(command);

    expect(result).toMatchObject({ ok: true, committed: true, kind: 'repair', integrityDelta: 36, minutes: 60 });
    expect(game.baseSecurity.openings.find((entry) => entry.id === 'front_door').integrity).toBe(36);
    expect(game.baseInteriorSafe).toBe(true);
    expect(game.totalWorldMinutes - beforeMinutes).toBe(60);
  });

  it('requires repairing a breach before fortifying and consumes nothing on rejection', () => {
    game.baseSecurity.openings[1].integrity = 0;
    setExteriorPopulation(game, 0);
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'repair-first' });

    expectRejectedWithoutMutation(game, () => game.performBaseWork(command), 'repair_required');
  });

  it('hides and rejects the legacy fortify node action without mutation', () => {
    const before = clone(game.$state);

    expect(game.currentNodeActions.some((entry) => entry.id === 'fortify')).toBe(false);
    expect(game.resolveNodeAction('fortify')).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('crosses midnight by the exact work duration and commits the command once', () => {
    game.day = 1;
    game.clockMinutes = 23 * 60 + 30;
    syncPressureClock(game);
    game.baseSecurity = createBaseSecurity({ shelter: game.shelter, totalMinutes: game.totalWorldMinutes });
    const materials = installWorkMaterials(game);
    const command = workCommand(game, materials, { commandId: 'midnight-once' });
    const result = game.performBaseWork(command);

    expect(result).toMatchObject({ ok: true, committed: true, minutes: 90 });
    expect(game.day).toBe(2);
    expect(game.clockMinutes).toBe(60);
    expect(game.baseSecurity.appliedCommandIds.filter((id) => id === command.commandId)).toHaveLength(1);
  });

  it('advances perimeter observations and logs one incident exactly once', () => {
    game.shelter = clone(shelters.find((entry) => entry.id === 'basement'));
    game.day = 1;
    game.clockMinutes = 0;
    syncPressureClock(game);
    game.baseSecurity = createBaseSecurity({ shelter: game.shelter, totalMinutes: 0 });
    game.baseSecurity.openings.forEach((opening) => {
      opening.integrity = 5;
      opening.barricade = 0;
    });
    game.world.seed = 90210;
    game.world.threat = 100;
    game.world.noise = 100;
    game.base.generatorOn = true;
    game.base.generatorFuel = 5;
    setExteriorPopulation(game, 80);

    const result = game.advanceSimulation({ minutes: 6 * 60, mode: 'active' });

    expect(result.baseSecurity.incidents).toHaveLength(1);
    expect(result.notices).toContainEqual(expect.stringContaining('尸群冲击'));
    expect(game.baseSecuritySummary.breachedCount).toBe(1);
    expect(game.nodeZombieStates[game.spawnLocation.id].count).toBe(80);
    const incidentLogs = game.mapLog.filter((entry) => entry.text === result.notices.find((notice) => notice.includes('尸群冲击')));
    expect(incidentLogs).toHaveLength(1);
    expect(incidentLogs[0].mode).toBe('base_security');
  });

  it('is perimeter-equivalent for one twelve-hour advance and six two-hour advances', () => {
    game.day = 1;
    game.clockMinutes = 0;
    syncPressureClock(game);
    setExteriorPopulation(game, 0);
    game.baseSecurity = createBaseSecurity({ shelter: game.shelter, totalMinutes: 0, legacyBarricades: 3 });
    const initial = clone(game.$state);

    game.advanceSimulation({ minutes: 12 * 60, mode: 'rest' });
    const oneShot = clone(game.baseSecurity);

    setActivePinia(createPinia());
    const segmented = useGameStore();
    segmented.$patch(initial);
    for (let step = 0; step < 6; step += 1) segmented.advanceSimulation({ minutes: 2 * 60, mode: 'rest' });

    expect(segmented.baseSecurity).toEqual(oneShot);
  });

  it('does not let midnight migrants attack an earlier observation in a long sleep', () => {
    game.day = 1;
    game.clockMinutes = 17 * 60;
    syncPressureClock(game);
    game.world.seed = 4;
    game.world.threat = 0;
    game.world.noise = 0;
    game.base.generatorOn = false;
    setExteriorPopulation(game, 0);
    game.baseSecurity = createBaseSecurity({ shelter: game.shelter, totalMinutes: game.totalWorldMinutes });
    const initial = clone(game.$state);

    const oneResult = game.advanceSimulation({ minutes: 8 * 60, mode: 'sleep' });
    const oneShotSecurity = clone(game.baseSecurity);

    expect(oneResult.baseSecurity.processedObservationHours).toEqual([18, 24]);
    expect(oneResult.baseSecurity.events.every((event) => event.sources.exteriorPopulation === 0)).toBe(true);
    expect(oneResult.baseSecurity.incidents).toEqual([]);

    setActivePinia(createPinia());
    const hourly = useGameStore();
    hourly.$patch(initial);
    for (let hour = 0; hour < 8; hour += 1) hourly.advanceSimulation({ minutes: 60, mode: 'sleep' });

    expect(hourly.baseSecurity).toEqual(oneShotSecurity);
    expect(hourly.baseSecurity.lastIncident).toBeNull();
  });

  it('round-trips the exact perimeter state through a v9 save', () => {
    const materials = installWorkMaterials(game);
    expect(game.performBaseWork(workCommand(game, materials, { commandId: 'save-exact' }))).toEqual(expect.objectContaining({ ok: true }));
    const expected = clone(game.baseSecurity);
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: clone(game.$state) }));

    setActivePinia(createPinia());
    const restored = useGameStore();
    restored.loadPersistedState();

    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.baseSecurity).toEqual(expected);
  });
});

describe('v0.9 base security migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('upgrades v8 barricades at the current hour without retroactive attacks or defense loss', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set(SAVE_KEY, JSON.stringify({
      game: {
        saveVersion: 8,
        day: 4,
        clockMinutes: 600,
        spawnLocation: { id: 'muldraugh' },
        shelter: { id: 'gated_villa' },
        currentNodeId: 'muldraugh',
        base: { defense: 9, barricades: 5, generatorFuel: 0, generatorOn: false, waterReserve: 2 },
        inventory: [],
        baseInventory: [],
      },
    }));
    const restored = useGameStore();

    restored.loadPersistedState();

    expect(SAVE_VERSION).toBe(12);
    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.baseSecurity).toMatchObject({ revision: 0, lastProcessedHour: 82, lastIncident: null });
    expect(restored.baseSecuritySummary).toMatchObject({ totalBarricade: 125, legacyBarricades: 5 });
    expect(restored.base).toMatchObject({ defense: 9, barricades: 5, waterReserve: 2 });
    const result = restored.advanceSimulation({ minutes: 60, mode: 'rest' });
    expect(result.baseSecurity.incidents).toEqual([]);
    expect(restored.baseSecurity.lastProcessedHour).toBe(83);
  });
});
