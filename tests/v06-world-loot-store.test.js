import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  mapNodes,
  marketItems,
} from '../src/data/zombie.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const SAVE_KEY = 'moshi-survival-state';

const clone = (value) => JSON.parse(JSON.stringify(value));
const catalogItem = (id) => marketItems.find((entry) => entry.id === id);
const searchableAt = (game, nodeId, searchableId) => (
  game.canonicalSceneSearchablesFor(nodeId).find((entry) => entry.id === searchableId)
);

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function createGame(localStorage = memoryStorage()) {
  setActivePinia(createPinia());
  vi.stubGlobal('localStorage', localStorage);
  return { game: useGameStore(), localStorage };
}

function prepareSafeNode(game, nodeId = 'muldraugh') {
  const node = mapNodes.find((entry) => entry.id === nodeId);
  if (!node) throw new Error(`Unknown test node: ${nodeId}`);
  game.currentNodeId = node.id;
  game.inspectedNodeId = node.id;
  game.visitedNodeIds = [...new Set([...game.visitedNodeIds, node.id])];
  game.knownNodeIds = [...new Set([...game.knownNodeIds, node.id])];
  const zombieState = game.ensureNodeZombieState(node.id);
  game.nodeZombieStates[node.id] = {
    ...zombieState,
    count: 0,
    clearedDay: game.day,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
  return node;
}

function openContainer(game, searchable, searchKey = '') {
  const result = game.openSceneLoot(searchable, searchKey);
  expect(result).toEqual(expect.objectContaining({
    ok: true,
    reason: null,
    container: expect.any(Object),
    summary: expect.any(Object),
  }));
  return result;
}

function openFirstPerishableContainer(game, nodeId) {
  for (const searchable of game.canonicalSceneSearchablesFor(nodeId)) {
    const opened = openContainer(game, searchable, searchable.searchKey);
    if (opened.container.slots.some((slot) => slot.item.conditionState?.freshness?.perishable)) {
      return { searchable, key: opened.searchKey, opened };
    }
  }
  throw new Error(`Expected at least one perishable scene-loot container at ${nodeId}`);
}

function reveal(game, searchable, command) {
  const result = game.revealSceneLoot(searchable, command);
  expect(result).toEqual(expect.objectContaining({
    ok: true,
    reason: null,
    nextState: expect.any(Object),
  }));
  return result;
}

function expectRejectedWithoutMutation(game, action, expectedReason = null) {
  const before = clone(game.$state);
  const result = action();
  expect(result).toEqual(expect.objectContaining({
    ok: false,
    reason: expectedReason ?? expect.any(String),
  }));
  expect(game.$state).toEqual(before);
  return result;
}

describe('v0.6 persistent scene loot store boundary', () => {
  let game;
  let localStorage;

  beforeEach(() => {
    ({ game, localStorage } = createGame());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the current save version and opens one deterministic, idempotent world container without spending time', () => {
    expect(SAVE_VERSION).toBe(10);
    expect(game.saveVersion).toBe(SAVE_VERSION);
    expect(game.worldLootContainers).toEqual({});
    prepareSafeNode(game, 'muldraugh');
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_medcab');
    const key = searchable.searchKey;
    const beforeMinutes = game.totalWorldMinutes;
    const beforeState = clone(game.$state);

    const opened = openContainer(game, searchable);

    expect(game.totalWorldMinutes).toBe(beforeMinutes);
    expect(Object.keys(game.worldLootContainers)).toEqual([key]);
    expect(opened.container).toEqual(game.worldLootContainers[key]);
    expect(opened.container).toEqual(expect.objectContaining({
      searchKey: key,
      revision: 0,
      searchCostPaid: false,
      slots: expect.arrayContaining([
        expect.objectContaining({ status: 'hidden' }),
      ]),
    }));
    expect(game.$state).toEqual({
      ...beforeState,
      worldLootContainers: { [key]: opened.container },
    });

    const firstContainer = clone(opened.container);
    const stateAfterFirstOpen = clone(game.$state);
    const reopened = openContainer(game, searchable);
    expect(reopened.container).toEqual(firstContainer);
    expect(game.$state).toEqual(stateAfterFirstOpen);

    const { game: independent } = createGame(memoryStorage());
    prepareSafeNode(independent, 'muldraugh');
    expect(openContainer(independent, searchable).container).toEqual(firstContainer);
  });

  it('uses parent scene identity and rejects invented searchables without generating loot', () => {
    prepareSafeNode(game, 'muldraugh');
    const storageCrate = searchableAt(game, 'muldraugh', 'muldraugh_storage_crate');
    const gasShelf = searchableAt(game, 'muldraugh', 'muldraugh_gas_shelf');

    const first = openContainer(game, storageCrate);
    const second = openContainer(game, gasShelf);

    expect(first.searchKey).toBe('muldraugh:building:muldraugh_storage:muldraugh_storage_crate');
    expect(second.searchKey).toBe('muldraugh:building:muldraugh_gas:muldraugh_gas_shelf');
    expect(first.container.generationId).not.toBe(second.container.generationId);
    expectRejectedWithoutMutation(game, () => game.openSceneLoot({
      id: 'invented_infinite_crate',
      name: '凭空生成的箱子',
      quality: 'red',
    }), 'unknown_searchable');
  });

  it.each([
    ['green', 'muldraugh', 'muldraugh_motel_drawer', 45],
    ['blue/purple', 'muldraugh', 'muldraugh_pallet', 60],
    ['gold/red', 'louisville', 'louisville_pharmacy', 90],
  ])('charges the %s search tier once and reveals every requested slot atomically', (_tier, nodeId, searchableId, expectedMinutes) => {
    prepareSafeNode(game, nodeId);
    const searchable = searchableAt(game, nodeId, searchableId);
    const key = searchable.searchKey;
    const opened = openContainer(game, searchable);
    const slotIds = opened.container.slots.map((slot) => slot.slotId);
    const firstBatch = slotIds.slice(0, Math.max(1, slotIds.length - 1));
    const laterBatch = slotIds.filter((slotId) => !firstBatch.includes(slotId));
    const beforeMinutes = game.totalWorldMinutes;

    const first = reveal(game, searchable, {
      commandId: `${searchable.id}:reveal:first`,
      expectedRevision: 0,
      slotIds: firstBatch,
    });

    expect(first.cost).toEqual(expect.objectContaining({ minutes: expectedMinutes }));
    expect(game.totalWorldMinutes - beforeMinutes).toBe(expectedMinutes);
    expect(game.worldLootContainers[key].revision).toBe(1);
    expect(game.worldLootContainers[key].searchCostPaid).toBe(true);
    expect(game.worldLootContainers[key].slots
      .filter((slot) => firstBatch.includes(slot.slotId))
      .every((slot) => slot.status === 'revealed')).toBe(true);

    if (laterBatch.length) {
      const beforeResume = game.totalWorldMinutes;
      const resumed = reveal(game, searchable, {
        commandId: `${searchable.id}:reveal:resume`,
        expectedRevision: 1,
        slotIds: laterBatch,
      });
      expect(resumed.cost).toEqual({ minutes: 0, noise: 0 });
      expect(game.totalWorldMinutes).toBe(beforeResume);
      expect(game.worldLootContainers[key].revision).toBe(2);
    }

    expect(game.worldLootContainers[key].slots.every((slot) => slot.status === 'revealed')).toBe(true);
  });

  it('claims exact source stacks in zero minutes, preserves leftovers across travel, and reports exhaustion only after taking all', () => {
    prepareSafeNode(game, 'muldraugh');
    game.skills.strength = 10;
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_motel_drawer');
    const key = searchable.searchKey;
    const opened = openContainer(game, searchable);
    reveal(game, searchable, {
      commandId: 'claim-flow:reveal',
      expectedRevision: 0,
      slotIds: opened.container.slots.map((slot) => slot.slotId),
    });
    const container = game.worldLootContainers[key];
    const [selected, ...leftovers] = container.slots.map((slot) => clone(slot.item));
    const beforeClaimMinutes = game.totalWorldMinutes;

    const claimed = game.claimSceneLoot(searchable, {
      commandId: 'claim-flow:first',
      expectedRevision: container.revision,
      stackIds: [selected.stackId],
    });

    expect(claimed).toEqual(expect.objectContaining({ ok: true, reason: null }));
    expect(game.totalWorldMinutes).toBe(beforeClaimMinutes);
    expect(game.inventory.find((item) => item.stackId === selected.stackId)).toEqual(expect.objectContaining({
      id: selected.id,
      count: selected.count,
      stackId: selected.stackId,
    }));
    expect(game.worldLootContainers[key].slots.find((slot) => slot.item.stackId === selected.stackId)?.status).toBe('claimed');
    leftovers.forEach((item) => {
      expect(game.worldLootContainers[key].slots.find((slot) => slot.item.stackId === item.stackId)?.status).toBe('revealed');
    });
    expect(game.sceneLootSummary(searchable)).toEqual(expect.objectContaining({
      claimed: 1,
      remaining: leftovers.length,
      exhausted: false,
    }));

    prepareSafeNode(game, 'dixie_highway_north');
    expect(game.worldLootContainers[key]).toEqual(expect.objectContaining({
      slots: expect.arrayContaining([
        expect.objectContaining({ status: 'revealed' }),
      ]),
    }));
    prepareSafeNode(game, 'muldraugh');
    const stateBeforeReturnOpen = clone(game.$state);
    const reopened = openContainer(game, searchable);
    expect(reopened.container).toEqual(stateBeforeReturnOpen.worldLootContainers[key]);
    expect(game.$state).toEqual(stateBeforeReturnOpen);

    const beforeFinalClaim = game.totalWorldMinutes;
    const final = game.claimSceneLoot(searchable, {
      commandId: 'claim-flow:rest',
      expectedRevision: reopened.container.revision,
      stackIds: leftovers.map((item) => item.stackId),
    });
    expect(final).toEqual(expect.objectContaining({ ok: true, reason: null }));
    expect(game.totalWorldMinutes).toBe(beforeFinalClaim);
    expect(game.sceneLootSummary(searchable)).toEqual(expect.objectContaining({
      hidden: 0,
      revealed: 0,
      claimed: opened.container.slots.length,
      remaining: 0,
      exhausted: true,
      complete: true,
    }));
  });

  it('keeps capacity preview and commit failures completely atomic', () => {
    prepareSafeNode(game, 'muldraugh');
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_motel_drawer');
    const opened = openContainer(game, searchable);
    reveal(game, searchable, {
      commandId: 'capacity:reveal',
      expectedRevision: 0,
      slotIds: opened.container.slots.map((slot) => slot.slotId),
    });
    const summary = game.sceneLootSummary(searchable);
    const selectedStackId = summary.slots.find((slot) => slot.status === 'revealed').item.stackId;
    const water = catalogItem('water_bottle');
    const capacity = game.maxSpace;
    game.inventory = [{
      ...clone(water),
      count: capacity,
      stackId: 'capacity:filler',
    }];
    const beforePreview = clone(game.$state);

    const preview = game.previewSceneLootClaim(searchable, {
      expectedRevision: summary.revision,
      stackIds: [selectedStackId],
    });
    expect(preview).toEqual(expect.objectContaining({
      ok: false,
      reason: 'capacity_exceeded',
      capacity,
    }));
    expect(game.$state).toEqual(beforePreview);

    expectRejectedWithoutMutation(game, () => game.claimSceneLoot(searchable, {
      commandId: 'capacity:claim',
      expectedRevision: summary.revision,
      stackIds: [selectedStackId],
    }), 'capacity_exceeded');
  });

  it('rejects stale and duplicate mutation commands without touching any Store state', () => {
    prepareSafeNode(game, 'muldraugh');
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_motel_drawer');
    const opened = openContainer(game, searchable);
    const [firstSlot, secondSlot] = opened.container.slots;
    reveal(game, searchable, {
      commandId: 'command-ledger:first',
      expectedRevision: 0,
      slotIds: [firstSlot.slotId],
    });

    expectRejectedWithoutMutation(game, () => game.revealSceneLoot(searchable, {
      commandId: 'command-ledger:first',
      expectedRevision: 1,
      slotIds: [secondSlot.slotId],
    }), 'duplicate_command');

    expectRejectedWithoutMutation(game, () => game.revealSceneLoot(searchable, {
      commandId: 'command-ledger:stale',
      expectedRevision: 0,
      slotIds: [secondSlot.slotId],
    }), 'stale_revision');
  });

  it('rejects remote access and active-encounter access with complete zero-write failures', () => {
    prepareSafeNode(game, 'muldraugh');
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_medcab');
    const opened = openContainer(game, searchable);
    const firstSlotId = opened.container.slots[0].slotId;

    game.inspectedNodeId = 'dixie_highway_north';
    expectRejectedWithoutMutation(game, () => game.revealSceneLoot(searchable, {
      commandId: 'remote:reveal',
      expectedRevision: 0,
      slotIds: [firstSlotId],
    }));

    game.inspectedNodeId = 'muldraugh';
    game.nodeZombieStates.muldraugh = {
      ...game.nodeZombieStates.muldraugh,
      count: 3,
      clearedDay: null,
      evasionUntilMinutes: 0,
    };
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    expect(game.tacticalEncounterActive).toBe(true);
    expectRejectedWithoutMutation(game, () => game.revealSceneLoot(searchable, {
      commandId: 'encounter:reveal',
      expectedRevision: 0,
      slotIds: [firstSlotId],
    }));
  });

  it('round-trips partially claimed containers through the real v6 save loader', () => {
    prepareSafeNode(game, 'muldraugh');
    game.skills.strength = 10;
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_motel_drawer');
    const key = searchable.searchKey;
    const opened = openContainer(game, searchable);
    reveal(game, searchable, {
      commandId: 'save:reveal',
      expectedRevision: 0,
      slotIds: opened.container.slots.map((slot) => slot.slotId),
    });
    const firstStackId = game.worldLootContainers[key].slots[0].item.stackId;
    expect(game.claimSceneLoot(searchable, {
      commandId: 'save:claim',
      expectedRevision: game.worldLootContainers[key].revision,
      stackIds: [firstStackId],
    })).toEqual(expect.objectContaining({ ok: true }));
    const savedContainer = clone(game.worldLootContainers[key]);
    const savedSummary = clone(game.sceneLootSummary(searchable));
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: clone(game.$state) }));

    const { game: restored } = createGame(localStorage);
    restored.loadPersistedState();

    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.worldLootContainers[key]).toEqual(savedContainer);
    expect(restored.sceneLootSummary(searchable)).toEqual(savedSummary);
    expect(restored.inventory.some((item) => item.stackId === firstStackId)).toBe(true);
    expect(restored.sceneLootSummary(searchable).remaining).toBeGreaterThan(0);
  });

  it('migrates a v5 searched-scene tombstone without regenerating its loot', () => {
    prepareSafeNode(game, 'muldraugh');
    const searchable = searchableAt(game, 'muldraugh', 'muldraugh_medcab');
    const key = `muldraugh:${searchable.id}`;
    const legacyState = clone(game.$state);
    legacyState.saveVersion = 5;
    legacyState.searchedSceneObjectIds = [key];
    delete legacyState.worldLootContainers;
    localStorage.values.set(SAVE_KEY, JSON.stringify({ game: legacyState }));

    const { game: migrated } = createGame(localStorage);
    migrated.loadPersistedState();

    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.worldLootContainers).toEqual(expect.any(Object));
    expect(migrated.sceneLootSummary(searchable)).toEqual(expect.objectContaining({
      total: 0,
      hidden: 0,
      revealed: 0,
      remaining: 0,
      exhausted: true,
      complete: true,
    }));
    const beforeOpen = clone(migrated.$state);
    const result = migrated.openSceneLoot(searchable);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: expect.any(String) }));
    expect(migrated.$state).toEqual(beforeOpen);
    expect(migrated.sceneLootSummary(searchable).remaining).toBe(0);
  });

  it('ages revealed but unclaimed perishable world stacks during normal simulation time', () => {
    prepareSafeNode(game, 'riverside');
    const { searchable, key, opened } = openFirstPerishableContainer(game, 'riverside');
    reveal(game, searchable, {
      commandId: 'spoilage:reveal',
      expectedRevision: 0,
      slotIds: opened.container.slots.map((slot) => slot.slotId),
    });
    const perishable = game.worldLootContainers[key].slots.find((slot) => (
      slot.status === 'revealed' && slot.item.conditionState?.freshness?.perishable
    ));
    expect(perishable).toEqual(expect.objectContaining({
      status: 'revealed',
      item: expect.objectContaining({ stackId: expect.any(String) }),
    }));
    const stackId = perishable.item.stackId;
    const beforeFreshness = clone(perishable.item.conditionState.freshness);

    game.advanceSimulation({ minutes: 180, mode: 'active' });

    const aged = game.worldLootContainers[key].slots.find((slot) => slot.item.stackId === stackId);
    expect(aged.status).toBe('revealed');
    expect(aged.item.conditionState.freshness.ageMinutes).toBe(beforeFreshness.ageMinutes + 180);
    expect(aged.item.conditionState.freshness.spoilageMinutes).toBe(beforeFreshness.spoilageMinutes + 180);
  });

  it('does not create magically fresh food when a container is first opened late', () => {
    prepareSafeNode(game, 'riverside');
    game.day = 3;
    game.clockMinutes = 8 * 60;
    const { opened } = openFirstPerishableContainer(game, 'riverside');
    const perishable = opened.container.slots.find((slot) => slot.item.conditionState?.freshness?.perishable);

    expect(perishable).toBeTruthy();
    expect(perishable.item.conditionState.freshness.ageMinutes).toBe(2 * 24 * 60);
    expect(perishable.item.conditionState.freshness.spoilageMinutes).toBe(2 * 24 * 60);
  });
});
