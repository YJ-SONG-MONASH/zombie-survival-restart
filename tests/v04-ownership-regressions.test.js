import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mapNodes, marketItems, shelters } from '../src/data/zombie.js';
import { useGameStore } from '../src/stores/game.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const catalogItem = (id) => marketItems.find((entry) => entry.id === id);

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function lootSlot(id, itemId) {
  const item = catalogItem(itemId);
  return {
    id,
    itemId,
    status: 'hidden',
    space: item.space,
    tier: item.tier,
    source: 'ownership-regression',
  };
}

function makeSafeRun(game) {
  game.shelter = clone(shelters.find((entry) => entry.id === 'starter_house') ?? shelters[0]);
  game.initializeMapState();
  secureNode(game, game.currentNodeId);
}

function secureNode(game, nodeId) {
  const state = game.ensureNodeZombieState(nodeId);
  state.count = 0;
  state.clearedDay = game.day;
  state.lastRefreshDay = game.day;
  state.evasionUntilMinutes = 0;
  return state;
}

function mapOutcomeWithVehicle(vehicle, consume = [], vehicleOperation = null) {
  return {
    title: '车辆所有权回归',
    action: '检查车辆',
    result: '车辆状态已检查。',
    notes: '测试事务',
    score: 80,
    minutes: 30,
    mode: 'active',
    noiseDelta: 0,
    threatDelta: 0,
    vitals: {},
    consume,
    add: [],
    vehicle,
    vehicleOperation,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('v0.4 asynchronous loot-search ownership', () => {
  let game;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    game.shelter = clone(shelters[0]);
  });

  it('prevents a pre-reset slot search from committing loot or clearing a newer search id', async () => {
    game.lootSlots = [lootSlot('old-slot', 'water_bottle')];
    const oldSearch = game.searchLootSlot('old-slot');
    expect(game.searchingSlotId).toBe('old-slot');

    await vi.advanceTimersByTimeAsync(400);
    game.resetGame();
    game.shelter = clone(shelters[0]);
    game.lootSlots = [lootSlot('new-slot', 'canned_soup')];
    const newSearch = game.searchLootSlot('new-slot');
    expect(game.searchingSlotId).toBe('new-slot');
    const protectedState = clone(game.$state);

    await vi.advanceTimersByTimeAsync(400);

    expect(await oldSearch).toBe(false);
    expect(game.$state).toEqual(protectedState);
    expect(game.inventory.some((entry) => entry.id === 'water_bottle')).toBe(false);
    expect(game.searchingSlotId).toBe('new-slot');

    await vi.advanceTimersByTimeAsync(400);
    expect(await newSearch).toBe(true);
    expect(game.inventory.find((entry) => entry.id === 'canned_soup')?.count).toBe(1);
  });

  it('prevents a pre-profession-change bulk search from touching the new loadout or newer bulk search', async () => {
    game.lootSlots = [
      lootSlot('old-bulk-water', 'water_bottle'),
      lootSlot('old-bulk-beans', 'canned_beans'),
    ];
    const oldSearch = game.searchAllLootSlots();
    expect(game.searchingSlotId).toBe('bulk');

    await vi.advanceTimersByTimeAsync(400);
    expect(game.selectProfession('fire_officer')).toBe(true);
    game.shelter = clone(shelters[0]);
    game.lootSlots = [
      lootSlot('new-bulk-soup', 'canned_soup'),
      lootSlot('new-bulk-tuna', 'canned_tuna'),
    ];
    const newSearch = game.searchAllLootSlots();
    expect(game.searchingSlotId).toBe('bulk');
    const protectedState = clone(game.$state);

    await vi.advanceTimersByTimeAsync(400);

    expect(await oldSearch).toBe(false);
    expect(game.$state).toEqual(protectedState);
    expect(game.inventory.some((entry) => ['water_bottle', 'canned_beans'].includes(entry.id))).toBe(false);
    expect(game.searchingSlotId).toBe('bulk');

    await vi.advanceTimersByTimeAsync(400);
    expect(await newSearch).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'canned_soup')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'canned_tuna')).toBe(true);
  });
});

describe('v0.4 vehicle and generator ownership', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    makeSafeRun(game);
  });

  it('atomically rejects replacing a remote vehicle while its old trunk still owns cargo', () => {
    const parkedNodeId = game.currentNodeId;
    game.vehicle = {
      id: 'utility_truck',
      status: 'working',
      fuel: 2,
      name: '旧工具皮卡',
      condition: 64,
      nodeId: parkedNodeId,
      trunkSpace: 50,
    };
    expect(game.addItem(catalogItem('water_bottle'), 2, true)).toBe(true);
    const cargo = game.inventory.find((entry) => entry.id === 'water_bottle');
    expect(game.transferItem({
      fromId: 'carry', toId: 'trunk', stackId: cargo.stackId, quantity: 2,
    })).toEqual(expect.objectContaining({ ok: true, committed: true }));

    const destination = mapNodes.find((node) => node.id !== parkedNodeId && node.actions?.includes('vehicle'));
    game.currentNodeId = destination.id;
    game.inspectedNodeId = destination.id;
    secureNode(game, destination.id);
    const before = clone(game.$state);
    const replacement = {
      id: 'police_cruiser',
      status: 'working',
      fuel: 3,
      name: '替代巡逻车',
      condition: 58,
      nodeId: destination.id,
      trunkSpace: 35,
    };

    expect(game.applyMapOutcome(mapOutcomeWithVehicle(replacement, [], 'replace'), 'action')).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('allows refuelling the same vehicle without changing its trunk ownership', () => {
    game.vehicle = {
      id: 'utility_truck',
      status: 'working',
      fuel: 1,
      name: '工具皮卡',
      condition: 64,
      nodeId: game.currentNodeId,
      trunkSpace: 50,
    };
    expect(game.addItem(catalogItem('water_bottle'), 1, true)).toBe(true);
    const cargo = game.inventory.find((entry) => entry.id === 'water_bottle');
    expect(game.transferItem({
      fromId: 'carry', toId: 'trunk', stackId: cargo.stackId, quantity: 1,
    }).ok).toBe(true);
    expect(game.addItem(catalogItem('gas_can'), 1, true)).toBe(true);
    const cargoOwnershipBefore = game.vehicleInventory.map((entry) => ({
      id: entry.id,
      count: entry.count,
      stackId: entry.stackId,
      conditionStackId: entry.conditionState?.stackId,
    }));

    const refuelledVehicle = { ...clone(game.vehicle), fuel: 3 };
    expect(game.applyMapOutcome(mapOutcomeWithVehicle(refuelledVehicle, ['gas_can'], 'refuel'), 'action')).toBe(true);

    expect(game.vehicle).toEqual(expect.objectContaining({ id: 'utility_truck', fuel: 3, nodeId: game.currentNodeId }));
    expect(game.vehicleInventory.map((entry) => ({
      id: entry.id,
      count: entry.count,
      stackId: entry.stackId,
      conditionStackId: entry.conditionState?.stackId,
    }))).toEqual(cargoOwnershipBefore);
    expect(game.inventory.some((entry) => entry.id === 'gas_can')).toBe(false);
  });

  it('rejects starting a carried generator with a complete zero-mutation snapshot', () => {
    expect(game.addItem(catalogItem('generator'), 1, true)).toBe(true);
    game.skills.electrical = 3;
    game.base.generatorFuel = 2;
    game.base.generatorOn = false;
    const before = clone(game.$state);

    expect(game.toggleGenerator()).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('locks a running base generator against transfer out of base storage', () => {
    expect(game.addItem(catalogItem('generator'), 1, true)).toBe(true);
    game.skills.electrical = 3;
    game.base.generatorFuel = 2;
    const carried = game.inventory.find((entry) => entry.id === 'generator');
    expect(game.transferItem({
      fromId: 'carry', toId: 'base', stackId: carried.stackId, quantity: 1,
    }).ok).toBe(true);
    expect(game.toggleGenerator()).toBe(true);
    const installed = game.baseInventory.find((entry) => entry.id === 'generator');
    const before = clone(game.$state);

    const result = game.transferItem({
      fromId: 'base', toId: 'carry', stackId: installed.stackId, quantity: 1,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, committed: false }));
    expect(result.disabledReason).toEqual(expect.any(String));
    expect(game.$state).toEqual(before);
  });

  it('turns off normalized generator power when base storage owns no generator', () => {
    game.normalizeCatalogReferences();
    game.inventory = game.inventory.filter((entry) => entry.id !== 'generator');
    game.baseInventory = game.baseInventory.filter((entry) => entry.id !== 'generator');
    game.vehicleInventory = game.vehicleInventory.filter((entry) => entry.id !== 'generator');
    game.world.powerShutoffDay = 1;
    game.world.powerOn = true;
    game.base.generatorFuel = 3;
    game.base.generatorOn = true;
    const expected = clone(game.$state);
    expected.base.generatorOn = false;
    expected.world.powerOn = false;

    game.normalizeCatalogReferences();

    expect(game.base.generatorOn).toBe(false);
    expect(game.world.powerOn).toBe(false);
    expect(game.$state).toEqual(expected);
  });
});
