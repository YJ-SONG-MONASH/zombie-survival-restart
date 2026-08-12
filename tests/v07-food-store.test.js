import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { mapNodes, marketItems, shelters } from '../src/data/zombie.js';
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
    sourceId: 'v07-store-test',
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

function secureNode(game, nodeId = game.spawnLocation.id) {
  const state = game.ensureNodeZombieState(nodeId);
  game.nodeZombieStates[nodeId] = {
    ...state,
    count: 0,
    clearedDay: game.day,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
}

function prepareRun(game) {
  game.shelter = clone(shelters.find((entry) => entry.id === 'muldraugh_large_warehouse') ?? shelters[0]);
  game.initializeMapState();
  secureNode(game);
  game.skills.cooking = 3;
  game.inventory = [];
  game.baseInventory = normalizedInventory([
    rawStack('fresh_meat', 3, 1),
    rawStack('fresh_fish', 3, 8),
    rawStack('cabbage', 3, 2),
    rawStack('apple', 2, 3),
    rawStack('wild_berries', 2, 4),
    rawStack('canned_soup', 2, 5),
    rawStack('cooking_pot', 1, 6),
    rawStack('kitchen_knife', 1, 7),
  ], 'base');
  game.nextItemSequence = 100;
  game.world.powerOn = true;
  game.world.waterOn = true;
  game.base.waterReserve = 2;
}

function commandFor(game, recipeId, overrides = {}) {
  const option = game.foodPreparationOptions.find((entry) => entry.id === recipeId);
  if (!option) throw new Error(`Missing preparation option ${recipeId}`);
  return {
    recipeId,
    ingredientSelections: clone(option.suggestedIngredientSelections),
    destinationId: 'base',
    expectedRevision: game.foodPreparationRevision,
    commandId: `store:${recipeId}:${game.foodPreparationRevision}`,
    ...overrides,
  };
}

function countAcross(game, id) {
  return [...game.inventory, ...game.baseInventory]
    .filter((entry) => entry.id === id)
    .reduce((sum, entry) => sum + entry.count, 0);
}

function expectRejectedWithoutMutation(game, invoke, reason) {
  const before = clone(game.$state);
  const result = invoke();
  expect(result).toEqual(expect.objectContaining({ ok: false, committed: false, reason }));
  expect(game.$state).toEqual(before);
  return result;
}

describe('v0.7 food preparation Store integration', () => {
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

  it('keeps player-prepared meals out of randomized starting shelter loot', () => {
    let seed = 0x7f4a7c15;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    });
    game.resetGame();
    game.shelter = clone(shelters.find((entry) => entry.id === 'gated_villa') ?? shelters[0]);
    const generatedIds = [];

    for (let iteration = 0; iteration < 40; iteration += 1) {
      game.clearLootSearch();
      expect(game.ensureLootSlots()).toBe(true);
      generatedIds.push(...game.lootSlots.map((slot) => slot.itemId));
    }

    expect(generatedIds.length).toBeGreaterThan(0);
    const preparedIds = [
      'cooked_meat',
      'cooked_fish',
      'vegetable_soup',
      'meat_stew',
      'fruit_salad',
      'heated_canned_soup',
    ];
    expect(generatedIds.filter((id) => preparedIds.includes(id))).toEqual([]);
  });

  it.each([
    ['cook_meat', 'fresh_meat', 'cooked_meat'],
    ['cook_fish', 'fresh_fish', 'cooked_fish'],
    ['vegetable_soup', 'cabbage', 'vegetable_soup'],
    ['meat_stew', 'fresh_meat', 'meat_stew'],
    ['fruit_salad', 'apple', 'fruit_salad'],
    ['heat_canned_soup', 'canned_soup', 'heated_canned_soup'],
  ])('commits %s through the Store as one timed transaction', (recipeId, consumedId, resultId) => {
    const beforeInput = countAcross(game, consumedId);
    const beforeTime = game.totalWorldMinutes;
    const beforeXp = game.skillXp.cooking;
    const command = commandFor(game, recipeId);

    const preview = game.previewFoodPreparation(command);
    expect(preview).toEqual(expect.objectContaining({ ok: true, committed: false, minutes: expect.any(Number) }));
    const result = game.prepareFood(command);

    expect(result).toEqual(expect.objectContaining({ ok: true, committed: true, resultId }));
    expect(countAcross(game, consumedId)).toBeLessThan(beforeInput);
    expect(countAcross(game, resultId)).toBeGreaterThan(0);
    expect(game.totalWorldMinutes - beforeTime).toBe(result.minutes);
    expect(game.foodPreparationRevision).toBe(1);
    expect(game.foodPreparationCommandIds).toContain(command.commandId);
    expect(game.skillXp.cooking).toBeGreaterThan(beforeXp);
    expect(game.survivalStats).toMatchObject({ actions: 1, crafted: 1 });
    expect(game.history.at(-1)).toMatchObject({ log: '烹饪与食物准备' });
    expect(game.mapLog[0]).toMatchObject({ mode: 'cooking' });
  });

  it('blocks heated food after the outage, then accepts a fueled installed generator', () => {
    game.day = game.world.powerShutoffDay;
    game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.lastProcessedMinute = game.totalWorldMinutes;
    game.world.powerOn = false;
    const outageCommand = commandFor(game, 'cook_meat');
    expectRejectedWithoutMutation(game, () => game.prepareFood(outageCommand), 'power_unavailable');

    const generator = normalizedInventory([rawStack('generator', 1, 80)], 'base')[0];
    game.baseInventory.push(generator);
    game.base.generatorOn = true;
    game.base.generatorFuel = 2;
    game.base.installedGeneratorStackId = generator.stackId;
    const poweredCommand = commandFor(game, 'cook_meat', { commandId: 'store:generator-powered' });

    expect(game.prepareFood(poweredCommand)).toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(game.base.generatorFuel).toBe(2);
  });

  it('rejects away, tactical, and breached-perimeter commands with complete zero mutation', () => {
    const baseCommand = commandFor(game, 'cook_meat');
    const neighbor = mapNodes.find((node) => node.id !== game.currentNodeId && game.currentNeighborNodes.some((entry) => entry.id === node.id));
    game.currentNodeId = neighbor.id;
    secureNode(game, neighbor.id);
    expectRejectedWithoutMutation(game, () => game.prepareFood(baseCommand), 'not_at_home');

    game.currentNodeId = game.spawnLocation.id;
    secureNode(game);
    game.activeTacticalEncounter = { status: 'active' };
    expectRejectedWithoutMutation(game, () => game.prepareFood(baseCommand), 'active_tactical_encounter');

    game.activeTacticalEncounter = null;
    const local = game.ensureNodeZombieState(game.currentNodeId);
    local.count = 2;
    local.evasionUntilMinutes = game.totalWorldMinutes + 1;
    game.baseSecurity.openings[0].integrity = 0;
    expectRejectedWithoutMutation(game, () => game.prepareFood(baseCommand), 'node_not_secured');
  });

  it('consumes the exact selected carry lot and a base tool without touching an identical base lot', () => {
    const carryMeat = normalizedInventory([rawStack('fresh_meat', 1, 120)], 'carry')[0];
    const baseMeat = normalizedInventory([rawStack('fresh_meat', 1, 121)], 'base')[0];
    game.inventory = [carryMeat];
    game.baseInventory = [baseMeat, normalizedInventory([rawStack('cooking_pot', 1, 122)], 'base')[0]];
    const command = commandFor(game, 'cook_meat', {
      ingredientSelections: [{ containerId: 'carry', stackId: carryMeat.stackId, count: 1 }],
      commandId: 'store:exact-cross-container',
    });

    expect(game.prepareFood(command)).toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(game.inventory.some((entry) => entry.stackId === carryMeat.stackId)).toBe(false);
    expect(game.baseInventory.some((entry) => entry.stackId === baseMeat.stackId)).toBe(true);
    expect(game.baseInventory.some((entry) => entry.id === 'cooking_pot')).toBe(true);
  });

  it('rejects destination capacity, duplicate replay, and stale revision atomically', () => {
    game.inventory = normalizedInventory([rawStack('water_bottle', game.maxSpace, 150)], 'carry');
    const fullCommand = commandFor(game, 'cook_meat', { destinationId: 'carry', commandId: 'store:capacity' });
    expectRejectedWithoutMutation(game, () => game.prepareFood(fullCommand), 'capacity_exceeded');

    game.inventory = [];
    const command = commandFor(game, 'cook_meat', { commandId: 'store:once' });
    expect(game.prepareFood(command)).toEqual(expect.objectContaining({ ok: true, committed: true }));
    expectRejectedWithoutMutation(game, () => game.prepareFood(command), 'duplicate_command');
    const stale = commandFor(game, 'cook_meat', {
      expectedRevision: 0,
      commandId: 'store:stale',
    });
    expectRejectedWithoutMutation(game, () => game.prepareFood(stale), 'stale_revision');
  });

  it('crosses midnight by exact minutes and lets the prepared output age during cooking', () => {
    game.day = 1;
    game.clockMinutes = 23 * 60 + 50;
    game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.lastProcessedMinute = game.totalWorldMinutes;
    const command = commandFor(game, 'cook_meat', { commandId: 'store:midnight' });
    const result = game.prepareFood(command);

    expect(result).toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(game.day).toBe(2);
    expect(game.clockMinutes).toBe((23 * 60 + 50 + result.minutes) % (24 * 60));
    const output = game.baseInventory.find((entry) => entry.id === 'cooked_meat');
    expect(output.conditionState.freshness.ageMinutes).toBeGreaterThanOrEqual(result.minutes);
  });
});

describe('v0.7 food preparation save migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('upgrades a v6 save while preserving exact food stacks and freshness', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    const meat = rawStack('fresh_meat', 1, 200);
    meat.conditionState.freshness.ageMinutes = 720;
    meat.conditionState.freshness.spoilageMinutes = 720;
    const cabbage = rawStack('cabbage', 2, 201);
    localStorage.values.set(SAVE_KEY, JSON.stringify({
      game: {
        saveVersion: 6,
        day: 4,
        clockMinutes: 600,
        spawnLocation: { id: 'muldraugh' },
        shelter: { id: 'muldraugh_large_warehouse' },
        currentNodeId: 'muldraugh',
        inventory: [meat],
        baseInventory: [cabbage],
      },
    }));
    const restored = useGameStore();

    restored.loadPersistedState();

    expect(SAVE_VERSION).toBe(12);
    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.foodPreparationRevision).toBe(0);
    expect(restored.foodPreparationCommandIds).toEqual([]);
    const restoredMeat = restored.inventory.find((entry) => entry.id === 'fresh_meat');
    expect(restoredMeat.stackId).toBe(meat.stackId);
    expect(restoredMeat.conditionState.freshness).toMatchObject({ ageMinutes: 720, spoilageMinutes: 720 });
    expect(restored.baseInventory.find((entry) => entry.id === 'cabbage')).toMatchObject({ count: 2 });
  });
});
