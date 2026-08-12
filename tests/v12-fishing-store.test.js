import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  fishingSpots,
  marketItems,
  shelters,
  spawnLocations,
} from '../src/data/zombie.js';
import { createItemConditionState } from '../src/services/item-condition.js';
import { cumulativeXpForLevel } from '../src/services/progression.js';
import { normalizeStorageInventory } from '../src/services/storage.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const DAY = 24 * 60;
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

function rawStack(id, count = 1, sequence = 1, sourceId = 'v12-fishing-store') {
  const catalogItem = item(id);
  if (!catalogItem) throw new Error(`Missing catalog item ${id}`);
  const conditionState = createItemConditionState(catalogItem, {
    acquiredMinutes: 8 * 60,
    acquisitionSequence: sequence,
    sourceId,
  });
  return {
    ...clone(catalogItem),
    count,
    stackId: conditionState.stackId,
    conditionState,
  };
}

function carryStacks(entries) {
  return normalizeStorageInventory(entries, marketItems, { containerId: 'carry' });
}

function baseStacks(entries) {
  return normalizeStorageInventory(entries, marketItems, { containerId: 'base' });
}

function secureNode(game, nodeId = game.currentNodeId) {
  const current = game.ensureNodeZombieState(nodeId);
  game.nodeZombieStates[nodeId] = {
    ...current,
    count: 0,
    clearedDay: game.day,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
}

function prepareFishingRun(game, { tackleCount = 4, fillerCount = 0 } = {}) {
  game.spawnLocation = clone(spawnLocations.find((entry) => entry.id === 'riverside'));
  game.shelter = clone(shelters.find((entry) => entry.id === 'riverside_fishing_shed'));
  expect(game.initializeMapState()).toBe(true);
  secureNode(game, 'riverside');
  game.inventory = [
    ...carryStacks([rawStack('fishing_rod', 1, 10, 'rod-selected')]),
    ...carryStacks([rawStack('fishing_tackle', tackleCount, 11, 'tackle-selected')]),
    ...carryStacks([rawStack('fishing_tackle', 2, 12, 'tackle-untouched')]),
    ...(fillerCount > 0
      ? carryStacks([rawStack('canned_soup', fillerCount, 13, 'capacity-filler')])
      : []),
  ];
  game.baseInventory = [];
  game.nextItemSequence = 100;
  game.skills.fishing = 3;
  game.skillXp.fishing = cumulativeXpForLevel(3);
  game.world.powerOn = true;
  game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
  game.fishing.lastProcessedMinute = game.totalWorldMinutes;
  return game;
}

function fishingCommand(game, kind = 'attempt', overrides = {}) {
  const rod = game.inventory.find((entry) => entry.id === 'fishing_rod');
  const tackle = game.inventory.find((entry) => entry.id === 'fishing_tackle');
  return {
    ...game.fishingCommandToken(kind),
    nodeId: game.currentNodeId,
    rodStackId: rod?.stackId ?? '',
    tackleStackId: tackle?.stackId ?? '',
    destinationId: 'carry',
    ...overrides,
  };
}

function itemCount(inventory, id, stackId = null) {
  return inventory
    .filter((entry) => entry.id === id && (!stackId || entry.stackId === stackId))
    .reduce((total, entry) => total + entry.count, 0);
}

function expectRejectedWithoutMutation(game, invoke, reason) {
  const before = clone(game.$state);
  const result = invoke();
  expect(result).toEqual(expect.objectContaining({
    ok: false,
    committed: false,
    reason,
  }));
  expect(game.$state).toEqual(before);
  return result;
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seedForOutcome(wantedCaught) {
  // Day 1 at 08:00 with fishing 3 has a frozen 50% Riverside catch chance.
  for (let seed = 0; seed < 10_000; seed += 1) {
    const roll = hash32(`${seed}|riverside|1|0|0`) / 0x1_0000_0000;
    if ((roll < 0.5) === wantedCaught) return seed;
  }
  throw new Error(`No deterministic seed found for caught=${wantedCaught}`);
}

function fishAction(game) {
  return game.currentNodeActions.find((entry) => entry.id === 'fish');
}

describe('v0.12 Store-owned fishing save and action contract', () => {
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

  it('ships save version 12 with canonical full fishing defaults', () => {
    expect(SAVE_VERSION).toBe(12);
    expect(game.saveVersion).toBe(12);
    expect(game.fishing).toEqual({
      version: 1,
      revision: 0,
      lastProcessedMinute: 8 * 60,
      appliedCommandIds: [],
      spots: Object.fromEntries(fishingSpots.map((spot) => [spot.nodeId, {
        stock: spot.capacity,
        attemptsDay: 1,
        attemptsToday: 0,
      }])),
    });
    expect(game.fishingSummary).toMatchObject({
      version: 1,
      revision: 0,
      lastProcessedMinute: 8 * 60,
      timelineCurrent: true,
      maxAttemptsPerDay: 3,
    });
  });

  it('migrates a v11 save at its exact clock, then round-trips fishing state byte-for-byte', () => {
    prepareFishingRun(game);
    const legacy = clone(game.$state);
    legacy.saveVersion = 11;
    legacy.day = 3;
    legacy.clockMinutes = 9 * 60 + 17;
    delete legacy.fishing;
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: legacy }));

    const migrated = useGameStore(createPinia());
    migrated.loadPersistedState();

    expect(migrated.saveVersion).toBe(12);
    expect(migrated.fishing.lastProcessedMinute).toBe(2 * DAY + 9 * 60 + 17);
    expect(migrated.fishing.revision).toBe(0);
    expect(migrated.fishing.appliedCommandIds).toEqual([]);
    fishingSpots.forEach((spot) => {
      expect(migrated.fishing.spots[spot.nodeId]).toEqual({
        stock: spot.capacity,
        attemptsDay: 3,
        attemptsToday: 0,
      });
    });

    migrated.fishing.revision = 9;
    migrated.fishing.spots.riverside = { stock: 1, attemptsDay: 3, attemptsToday: 2 };
    migrated.fishing.appliedCommandIds = ['persisted-fish-command'];
    const expected = clone(migrated.fishing);
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: clone(migrated.$state) }));
    const restored = useGameStore(createPinia());
    restored.loadPersistedState();

    expect(restored.saveVersion).toBe(12);
    expect(restored.fishing).toEqual(expected);
  });

  it('projects the fishing spot, exact helper command, dynamic minutes, and disabled reasons', () => {
    prepareFishingRun(game);
    const before = clone(game.$state);
    const rod = game.inventory.find((entry) => entry.id === 'fishing_rod');
    const tackle = game.inventory.find((entry) => entry.id === 'fishing_tackle');

    expect(game.currentFishingSummary).toMatchObject({
      nodeId: 'riverside',
      stock: 4,
      stockCap: 4,
      stockBand: 'abundant',
      attemptsToday: 0,
      attemptsRemaining: 3,
    });
    expect(game.currentFishingCommand()).toMatchObject({
      expectedRevision: 0,
      nodeId: 'riverside',
      rodStackId: rod.stackId,
      tackleStackId: tackle.stackId,
      destinationId: 'carry',
    });
    expect(game.currentFishingCommand().commandId).toEqual(expect.any(String));
    expect(fishAction(game)).toMatchObject({
      id: 'fish',
      minutes: 105,
      disabled: false,
      disabledReason: '',
      chancePercent: 50,
      stockBand: 'abundant',
      attemptsRemaining: 3,
    });
    expect(game.$state).toEqual(before);

    game.inventory = game.inventory.filter((entry) => entry.id !== 'fishing_rod');
    const missingRodBefore = clone(game.$state);
    expect(fishAction(game)).toEqual(expect.objectContaining({
      disabled: true,
      disabledReason: expect.stringMatching(/钓竿|鱼竿/),
    }));
    expect(game.$state).toEqual(missingRodBefore);

    game.inventory = carryStacks([rawStack('fishing_rod', 1, 20, 'rod-only')]);
    const missingTackleBefore = clone(game.$state);
    expect(fishAction(game)).toEqual(expect.objectContaining({
      disabled: true,
      disabledReason: expect.stringMatching(/鱼钩|鱼线|钓具|鱼饵/),
    }));
    expect(game.$state).toEqual(missingTackleBefore);

    game.inventory = carryStacks([
      rawStack('fishing_rod', 1, 21, 'rod-restored'),
      rawStack('fishing_tackle', 2, 22, 'tackle-restored'),
    ]);
    game.fishing.spots.riverside.stock = 0;
    expect(fishAction(game)).toEqual(expect.objectContaining({
      disabled: true,
      disabledReason: expect.stringMatching(/耗尽|恢复|没有可捕/),
    }));

    game.fishing.spots.riverside.stock = 4;
    game.fishing.spots.riverside.attemptsToday = 3;
    expect(fishAction(game)).toEqual(expect.objectContaining({
      disabled: true,
      disabledReason: expect.stringMatching(/3|次数|明天/),
    }));
  });
});

describe('v0.12 Store fishing transactions', () => {
  let game;
  let localStorage;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    game = useGameStore();
    prepareFishingRun(game);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['unsafe node', 'node_unsafe', (current) => {
      const local = current.ensureNodeZombieState(current.currentNodeId);
      current.nodeZombieStates[current.currentNodeId] = {
        ...local,
        count: 2,
        clearedDay: null,
        evasionUntilMinutes: 0,
      };
      current.baseSecurity.openings[0].integrity = 0;
    }],
    ['active tactical encounter', 'tactical_active', (current) => {
      current.activeTacticalEncounter = { status: 'active' };
    }],
    ['stale revision', 'stale_revision', () => {}],
  ])('rejects %s with complete $state zero-write', (_label, reason, arrange) => {
    arrange(game);
    const command = fishingCommand(game, `reject-${reason}`, reason === 'stale_revision'
      ? { expectedRevision: game.fishing.revision + 1 }
      : {});

    expectRejectedWithoutMutation(game, () => game.fish(command), reason);
  });

  it('rejects output capacity before consuming the exact tackle stack', () => {
    const rod = game.inventory.find((entry) => entry.id === 'fishing_rod');
    const selectedTackle = game.inventory.find((entry) => entry.id === 'fishing_tackle');
    game.inventory = carryStacks([
      rod,
      { ...selectedTackle, count: 1 },
      rawStack('canned_soup', game.maxSpace - 4, 30, 'capacity-filler'),
    ]);
    expect(game.usedSpace).toBe(game.maxSpace);
    const command = fishingCommand(game, 'capacity');

    expectRejectedWithoutMutation(game, () => game.fish(command), 'capacity_exceeded');
  });

  it('previews without mutation or revealing the deterministic catch result', () => {
    const command = fishingCommand(game, 'preview');
    const before = clone(game.$state);
    const result = game.previewFishing(command);

    expect(result).toMatchObject({
      ok: true,
      committed: false,
      revision: 0,
      nodeId: 'riverside',
      minutes: 105,
      chancePercent: 50,
      stockBefore: 4,
      attemptsToday: 0,
      attemptsRemaining: 3,
      noiseDelta: 4,
      activityDelta: 2,
    });
    expect(result).not.toHaveProperty('caught');
    expect(result).not.toHaveProperty('caughtStack');
    expect(game.$state).toEqual(before);
  });

  it('rejects the legacy boolean node-action shortcut so every attempt carries one explicit command token', () => {
    const before = clone(game.$state);

    expect(game.resolveNodeAction('fish')).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('commits a deterministic catch with exact tackle, stock, time, XP, and pressure inputs', () => {
    game.world.seed = seedForOutcome(true);
    const command = fishingCommand(game, 'catch');
    const selectedTackleId = command.tackleStackId;
    const untouchedTackle = game.inventory.find((entry) => (
      entry.id === 'fishing_tackle' && entry.stackId !== selectedTackleId
    ));
    const beforeTime = game.totalWorldMinutes;
    const beforeXp = game.skillXp.fishing;
    const beforeSequence = game.nextItemSequence;
    const homeId = game.spawnLocation.id;
    const currentPressureBefore = clone(game.currentNodePressureSummary);
    const remotePressureBefore = clone(game.nodePressureSummaryFor('muldraugh'));
    const advanceSpy = vi.spyOn(game, 'advanceSimulation');

    const result = game.fish(command);

    expect(result).toMatchObject({
      ok: true,
      committed: true,
      caught: true,
      catchCount: 1,
      minutes: 105,
      skillXp: 16,
      noiseDelta: 4,
      activityDelta: 2,
      stockBefore: 4,
      stockAfter: 3,
      attemptsToday: 1,
      consumedTackle: { stackId: selectedTackleId, itemId: 'fishing_tackle', count: 1 },
      progression: expect.objectContaining({ appliedGains: { fishing: 16 } }),
      simulation: expect.objectContaining({ localPressure: expect.objectContaining({ ok: true }) }),
      newZombieCount: expect.any(Number),
    });
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(advanceSpy).toHaveBeenCalledWith(expect.objectContaining({
      minutes: 105,
      mode: 'active',
      noiseDelta: 4,
      threatDelta: 2,
      localEmissionTiming: 'end',
    }));
    expect(game.totalWorldMinutes).toBe(beforeTime + 105);
    expect(game.skillXp.fishing).toBe(beforeXp + 16);
    expect(game.nextItemSequence).toBe(beforeSequence + 1);
    expect(game.fishing).toMatchObject({
      revision: 1,
      lastProcessedMinute: beforeTime + 105,
      spots: { riverside: { stock: 3, attemptsDay: 1, attemptsToday: 1 } },
    });
    expect(game.fishing.appliedCommandIds).toContain(command.commandId);
    expect(itemCount(game.inventory, 'fishing_rod')).toBe(1);
    expect(itemCount(game.inventory, 'fishing_tackle', selectedTackleId)).toBe(3);
    expect(itemCount(game.inventory, 'fishing_tackle', untouchedTackle.stackId)).toBe(2);
    expect(itemCount(game.inventory, 'fresh_fish')).toBe(1);
    const fish = game.inventory.find((entry) => entry.id === 'fresh_fish');
    expect(fish.conditionState).toMatchObject({
      acquiredMinutes: beforeTime,
      freshness: { perishable: true, ageMinutes: 105, spoilageMinutes: 105, state: 'fresh' },
    });
    expect(game.currentNodePressureSummary).toEqual(
      result.simulation.localPressure.summary.nodes.find((entry) => entry.nodeId === 'riverside'),
    );
    expect(game.currentNodePressureSummary.noise).toBeGreaterThan(currentPressureBefore.noise);
    expect(game.currentNodePressureSummary.activity).toBeGreaterThan(currentPressureBefore.activity);
    expect(game.nodePressureSummaryFor('muldraugh')).toEqual(remotePressureBefore);
    expect(homeId).toBe('riverside');
    expect(game.survivalStats.actions).toBe(1);
    expect(game.history.at(-1)).toMatchObject({ log: '有限水域捕鱼' });
    expect(game.mapLog[0]).toMatchObject({ mode: 'fishing' });
  });

  it('commits a deterministic miss with exact tackle, unchanged stock, time, XP, and pressure inputs', () => {
    game.world.seed = seedForOutcome(false);
    const command = fishingCommand(game, 'miss');
    const selectedTackleId = command.tackleStackId;
    const beforeTime = game.totalWorldMinutes;
    const beforeXp = game.skillXp.fishing;
    const beforeSequence = game.nextItemSequence;
    const advanceSpy = vi.spyOn(game, 'advanceSimulation');

    const result = game.fish(command);

    expect(result).toMatchObject({
      ok: true,
      committed: true,
      caught: false,
      catchCount: 0,
      caughtStack: null,
      minutes: 105,
      skillXp: 6,
      noiseDelta: 4,
      activityDelta: 2,
      stockBefore: 4,
      stockAfter: 4,
      attemptsToday: 1,
      progression: expect.objectContaining({ appliedGains: { fishing: 6 } }),
      simulation: expect.objectContaining({ localPressure: expect.objectContaining({ ok: true }) }),
      newZombieCount: expect.any(Number),
    });
    expect(advanceSpy).toHaveBeenCalledWith(expect.objectContaining({
      minutes: 105,
      mode: 'active',
      noiseDelta: 4,
      threatDelta: 2,
      localEmissionTiming: 'end',
    }));
    expect(game.totalWorldMinutes).toBe(beforeTime + 105);
    expect(game.skillXp.fishing).toBe(beforeXp + 6);
    expect(game.nextItemSequence).toBe(beforeSequence);
    expect(game.fishing.spots.riverside).toEqual({ stock: 4, attemptsDay: 1, attemptsToday: 1 });
    expect(itemCount(game.inventory, 'fishing_tackle', selectedTackleId)).toBe(3);
    expect(itemCount(game.inventory, 'fresh_fish')).toBe(0);
  });

  it('rejects a duplicate command before stale revision with complete $state zero-write', () => {
    game.world.seed = seedForOutcome(false);
    const command = fishingCommand(game, 'once');
    expect(game.fish(command)).toEqual(expect.objectContaining({ ok: true, committed: true }));
    const replay = { ...command, expectedRevision: 0 };

    const rejected = expectRejectedWithoutMutation(game, () => game.fish(replay), 'duplicate_command');
    expect(rejected).toMatchObject({ replayed: true });
  });

  it('rolls the complete Store back when simulation advancement throws after projection', () => {
    game.world.seed = seedForOutcome(true);
    const command = fishingCommand(game, 'advance-failure');
    const before = clone(game.$state);
    vi.spyOn(game, 'advanceSimulation').mockImplementation(() => {
      throw new Error('injected fishing advance failure');
    });

    expect(game.fish(command)).toEqual(expect.objectContaining({
      ok: false,
      committed: false,
      reason: 'commit_failed',
    }));
    expect(game.$state).toEqual(before);
  });
});

describe('v0.12 fishing time and food vertical loop', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    prepareFishingRun(game);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('regenerates bounded stock and resets attempts at absolute midnight', () => {
    game.day = 1;
    game.clockMinutes = 23 * 60 + 30;
    game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.spots.riverside = { stock: 0, attemptsDay: 1, attemptsToday: 3 };
    game.fishing.spots.west_point.stock = 6;

    const result = game.advanceSimulation({ minutes: 60, mode: 'rest' });

    expect(game.day).toBe(2);
    expect(game.clockMinutes).toBe(30);
    expect(result.fishing).toEqual(expect.objectContaining({
      ok: true,
      processedBoundaryMinutes: [DAY],
    }));
    expect(game.fishing.lastProcessedMinute).toBe(DAY + 30);
    expect(game.fishing.spots.riverside).toEqual({ stock: 1, attemptsDay: 2, attemptsToday: 0 });
    expect(game.fishing.spots.west_point).toEqual(expect.objectContaining({
      stock: 6,
      attemptsDay: 2,
      attemptsToday: 0,
    }));
  });

  it('returns the committed post-midnight stock, attempts, and aged catch instead of the pre-advance projection', () => {
    game.day = 1;
    game.clockMinutes = 23 * 60 + 30;
    game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.spots.riverside = { stock: 4, attemptsDay: 1, attemptsToday: 0 };
    game.world.seed = seedForOutcome(true);

    const result = game.fish(fishingCommand(game, 'cross-midnight-catch'));

    expect(result).toMatchObject({
      ok: true,
      committed: true,
      caught: true,
      stockAfter: 4,
      stockBand: 'abundant',
      attemptsToday: 0,
      attemptsRemaining: 3,
      revision: 2,
      fishingSummary: {
        stock: 4,
        attemptsDay: 2,
        attemptsToday: 0,
        attemptsRemaining: 3,
      },
    });
    expect(game.day).toBe(2);
    expect(game.clockMinutes).toBe(75);
    expect(result.nextState.fishing).toEqual(game.fishing);
    expect(result.caughtStack).toEqual(game.inventory.find((entry) => entry.id === 'fresh_fish'));
    expect(result.caughtStack.conditionState.freshness.spoilageMinutes).toBe(105);
  });

  it('throws before any Store write when fishing time is mismatched', () => {
    game.fishing.lastProcessedMinute += 1;
    const before = clone(game.$state);

    expect(() => game.advanceSimulation({ minutes: 30, mode: 'active' }))
      .toThrow(/fishing.*timeline|timeline.*fishing/i);
    expect(game.$state).toEqual(before);
  });

  it('closes catch -> carry fish -> cook_fish without losing the retained pot', () => {
    game.world.seed = seedForOutcome(true);
    game.baseInventory = baseStacks([rawStack('cooking_pot', 1, 60, 'retained-pot')]);
    const catchResult = game.fish(fishingCommand(game, 'catch-for-cooking'));
    expect(catchResult).toEqual(expect.objectContaining({ ok: true, caught: true }));
    const caughtFish = game.inventory.find((entry) => entry.id === 'fresh_fish');
    const pot = game.baseInventory.find((entry) => entry.id === 'cooking_pot');
    const beforeCookingMinutes = game.totalWorldMinutes;
    const option = game.foodPreparationOptions.find((entry) => entry.id === 'cook_fish');
    expect(option).toBeTruthy();
    const command = {
      recipeId: 'cook_fish',
      ingredientSelections: [{ containerId: 'carry', stackId: caughtFish.stackId, count: 1 }],
      destinationId: 'base',
      expectedRevision: game.foodPreparationRevision,
      commandId: 'v12:store:cook-caught-fish',
    };

    const cooked = game.prepareFood(command);

    expect(cooked).toMatchObject({
      ok: true,
      committed: true,
      resultId: 'cooked_fish',
      minutes: 45,
    });
    expect(game.totalWorldMinutes).toBe(beforeCookingMinutes + 45);
    expect(game.inventory.some((entry) => entry.stackId === caughtFish.stackId)).toBe(false);
    expect(game.baseInventory.some((entry) => entry.stackId === pot.stackId)).toBe(true);
    const cookedFish = game.baseInventory.find((entry) => entry.id === 'cooked_fish');
    expect(cookedFish).toBeTruthy();
    expect(cookedFish.conditionState.freshness).toMatchObject({
      perishable: true,
      state: 'fresh',
    });
    expect(cookedFish.conditionState.freshness.spoilageMinutes).toBeGreaterThanOrEqual(45);
  });
});
