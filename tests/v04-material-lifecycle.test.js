import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { marketItems, shelters } from '../src/data/zombie.js';
import { advanceFoodSpoilage } from '../src/services/item-condition.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const item = (id) => marketItems.find((entry) => entry.id === id);
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

function makeSafeRun(game) {
  game.shelter = clone(shelters.find((entry) => entry.id === 'starter_house') ?? shelters[0]);
  game.initializeMapState();
  const zombies = game.ensureNodeZombieState(game.currentNodeId);
  zombies.count = 0;
  zombies.clearedDay = game.day;
  zombies.lastRefreshDay = game.day;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('v0.4 storage ownership and atomic transfer', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    makeSafeRun(game);
  });

  it('separates carried, base, and trunk inventory with independently derived capacities', () => {
    const originalCarryCapacity = game.maxSpace;
    const originalShelter = game.shelter;
    game.shelter = clone(shelters.find((entry) => entry.space > originalShelter.space) ?? shelters.at(-1));

    expect(game.maxSpace).toBe(originalCarryCapacity);
    expect(game.storageContainers.map((entry) => entry.id)).toEqual(['carry', 'base', 'trunk']);
    expect(game.storageContainers.find((entry) => entry.id === 'base').capacity).toBe(game.shelter.space);
    expect(game.storageContainers.find((entry) => entry.id === 'trunk').accessible).toBe(false);

    expect(game.addItem(item('hiking_bag'), 1, true)).toBe(true);
    const bag = game.inventory.find((entry) => entry.id === 'hiking_bag');
    expect(game.equipBag(bag.stackId)).toBe(true);
    expect(game.maxSpace).toBeGreaterThan(originalCarryCapacity);
  });

  it('previews and commits a partial transfer exactly once without changing total quantity', () => {
    expect(game.addItem(item('water_bottle'), 3, true)).toBe(true);
    const stack = game.inventory.find((entry) => entry.id === 'water_bottle');

    const quote = game.previewTransfer({ fromId: 'carry', toId: 'base', stackId: stack.stackId, quantity: 2 });
    expect(quote).toEqual(expect.objectContaining({ ok: true, maxQuantity: 3 }));

    const committed = game.transferItem({ fromId: 'carry', toId: 'base', stackId: stack.stackId, quantity: 2 });
    expect(committed).toEqual(expect.objectContaining({ ok: true, committed: true }));
    expect(game.inventory.find((entry) => entry.id === 'water_bottle')?.count).toBe(1);
    expect(game.baseInventory.find((entry) => entry.id === 'water_bottle')?.count).toBe(2);
    expect([...game.inventory, ...game.baseInventory, ...game.vehicleInventory]
      .filter((entry) => entry.id === 'water_bottle')
      .reduce((sum, entry) => sum + entry.count, 0)).toBe(3);

    const replay = game.transferItem({ fromId: 'carry', toId: 'base', stackId: stack.stackId, quantity: 2 });
    expect(replay).toEqual(expect.objectContaining({ ok: false, committed: false }));
    expect(game.baseInventory.find((entry) => entry.id === 'water_bottle')?.count).toBe(2);
  });

  it('rejects inaccessible and encounter-time transfers with a zero-mutation result', () => {
    expect(game.addItem(item('water_bottle'), 1, true)).toBe(true);
    const stack = game.inventory[0];
    game.ensureNodeZombieState(game.currentNodeId).count = 8;
    game.baseSecurity.openings[0].integrity = 0;
    const before = clone(game.$state);

    const result = game.transferItem({ fromId: 'carry', toId: 'base', stackId: stack.stackId, quantity: 1 });

    expect(result).toEqual(expect.objectContaining({ ok: false, committed: false, disabledReason: expect.any(String) }));
    expect(game.$state).toEqual(before);
  });

  it('explains why an equipped bag cannot be stored while its cargo depends on that capacity', () => {
    expect(game.addItem(item('hiking_bag'), 1, true)).toBe(true);
    const bag = game.inventory.find((entry) => entry.id === 'hiking_bag');
    expect(game.equipBag(bag.stackId)).toBe(true);
    expect(game.addItem(item('water_bottle'), 15, true)).toBe(true);

    const quote = game.previewTransfer({ fromId: 'carry', toId: 'base', stackId: bag.stackId, quantity: 1 });

    expect(quote.ok).toBe(false);
    expect(quote.maxQuantity).toBe(0);
    expect(quote.disabledReason).toContain('背包');
  });

  it('leaves an out-of-fuel vehicle and its trunk cargo at the departure node', () => {
    game.vehicle = {
      id: 'utility_truck',
      status: 'working',
      fuel: 0,
      name: '工具皮卡',
      condition: 64,
      nodeId: game.currentNodeId,
      trunkSpace: 50,
    };
    expect(game.addItem(item('water_bottle'), 1, true)).toBe(true);
    const cargo = game.inventory.find((entry) => entry.id === 'water_bottle');
    expect(game.transferItem({ fromId: 'carry', toId: 'trunk', stackId: cargo.stackId, quantity: 1 }).ok).toBe(true);
    const parkedAt = game.currentNodeId;
    const destination = game.currentNeighborNodes[0].id;

    expect(game.moveToNode(destination)).toBe(true);

    expect(game.vehicle.nodeId).toBe(parkedAt);
    expect(game.vehicleInventory.find((entry) => entry.id === 'water_bottle')?.count).toBe(1);
    expect(game.storageContainers.find((entry) => entry.id === 'trunk')).toEqual(expect.objectContaining({
      accessible: false,
      accessReason: expect.stringContaining('车辆停在'),
    }));
  });

  it('packs a new survivor loadout and leaves heavy overflow at the starting base', () => {
    game.resetGame();
    game.shelter = clone([...shelters].sort((left, right) => right.space - left.space)[0]);
    expect(game.addItem(item('hiking_bag'), 1, true)).toBe(true);
    expect(game.addItem(item('generator'), 1, true)).toBe(true);
    expect(game.addItem(item('plank'), 8, true)).toBe(true);
    expect(game.addItem(item('water_bottle'), 8, true)).toBe(true);
    expect(game.addItem(item('baseball_bat'), 1, true)).toBe(true);
    expect(game.addItem(item('bandage'), 1, true)).toBe(true);
    expect(game.addItem(item('canned_soup'), 1, true)).toBe(true);
    const beforeCount = game.inventory.reduce((sum, entry) => sum + entry.count, 0);

    game.initializeMapState();

    expect(game.usedSpace).toBeLessThanOrEqual(game.maxSpace);
    expect(game.usedSpace).toBeLessThan(game.maxSpace * 0.85);
    expect(game.equippedBagStackId).toBe(game.inventory.find((entry) => entry.id === 'hiking_bag')?.stackId);
    expect(game.inventory.some((entry) => entry.id === 'baseball_bat')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'bandage')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'canned_soup')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'water_bottle')).toBe(true);
    expect(game.baseInventory.some((entry) => ['generator', 'plank'].includes(entry.id))).toBe(true);
    expect([...game.inventory, ...game.baseInventory].reduce((sum, entry) => sum + entry.count, 0)).toBe(beforeCount);
  });

  it('still reserves loot space for a minimum-capacity survivor', () => {
    game.resetGame();
    game.shelter = clone([...shelters].sort((left, right) => right.space - left.space)[0]);
    game.skills.strength = 0;
    game.selectedTraits = [{ id: 'disorganized' }];
    expect(game.addItem(item('water_bottle'), 2, true)).toBe(true);
    expect(game.addItem(item('canned_soup'), 2, true)).toBe(true);
    expect(game.addItem(item('bandage'), 1, true)).toBe(true);
    expect(game.addItem(item('kitchen_knife'), 1, true)).toBe(true);

    game.initializeMapState();

    expect(game.maxSpace).toBe(6);
    expect(game.usedSpace).toBeLessThan(game.maxSpace * 0.85);
    expect(game.inventory.some((entry) => entry.id === 'water_bottle')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'bandage')).toBe(true);
    expect(game.inventory.some((entry) => entry.id === 'kitchen_knife')).toBe(true);
    expect(game.baseInventory.some((entry) => entry.id === 'canned_soup')).toBe(true);
  });
});

describe('v0.4 freshness, durability, and repair loop', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    makeSafeRun(game);
  });

  it('ages powered base refrigeration more slowly than carried food', () => {
    expect(game.addItem(item('wild_berries'), 1, true)).toBe(true);
    const chilled = game.inventory.find((entry) => entry.id === 'wild_berries');
    expect(game.transferItem({ fromId: 'carry', toId: 'base', stackId: chilled.stackId, quantity: 1 }).ok).toBe(true);
    expect(game.addItem(item('wild_berries'), 1, true)).toBe(true);

    game.advanceSimulation({ minutes: 2 * 24 * 60, mode: 'rest' });

    expect(game.inventory.find((entry) => entry.id === 'wild_berries').conditionState.freshness.state).toBe('stale');
    expect(game.baseInventory.find((entry) => entry.id === 'wild_berries').conditionState.freshness.state).toBe('fresh');
    expect(game.baseInventory.find((entry) => entry.id === 'wild_berries').conditionState.freshness.spoilageMinutes)
      .toBeLessThan(game.inventory.find((entry) => entry.id === 'wild_berries').conditionState.freshness.spoilageMinutes);
  });

  it('stops refrigeration immediately during a power outage', () => {
    expect(game.addItem(item('wild_berries'), 1, true)).toBe(true);
    const chilled = game.inventory.find((entry) => entry.id === 'wild_berries');
    expect(game.transferItem({ fromId: 'carry', toId: 'base', stackId: chilled.stackId, quantity: 1 }).ok).toBe(true);
    const before = game.baseInventory[0].conditionState.freshness.spoilageMinutes;
    game.world.powerOn = false;
    game.world.powerShutoffDay = 1;

    game.advanceSimulation({ minutes: 60, mode: 'rest' });

    expect(game.baseInventory[0].conditionState.freshness.spoilageMinutes - before).toBe(60);
    expect(game.storageContainers.find((entry) => entry.id === 'base').preservationLabel).toContain('断电');
  });

  it('reduces stale food benefit and makes rotten food harmful', () => {
    expect(game.addItem(item('wild_berries'), 1, true)).toBe(true);
    const stack = game.inventory.find((entry) => entry.id === 'wild_berries');
    stack.conditionState = advanceFoodSpoilage(stack.conditionState, { elapsedMinutes: 4 * 24 * 60 });
    game.vitals.health = 80;
    game.vitals.hunger = 80;
    const beforeHealth = game.vitals.health;

    expect(game.useItem(stack.stackId)).toBe(true);

    expect(game.vitals.health).toBeLessThan(beforeHealth);
    expect(game.hiddenTags).toContain('食物中毒');
  });

  it('wears the exact equipped weapon, breaks it, then repairs it with diminishing materials', () => {
    expect(game.addItem(item('crafted_spear'), 1, true)).toBe(true);
    const spear = game.inventory.find((entry) => entry.id === 'crafted_spear');
    spear.conditionState.condition.current = 0.1;
    expect(game.equipWeapon(spear.stackId)).toBe(true);
    const encounter = game.ensureNodeZombieState(game.currentNodeId);
    encounter.count = 1;
    encounter.evasionUntilMinutes = 0;

    expect(game.resolveNodeAction('combat_melee')).toBe(true);
    game.activeTacticalEncounter.enemies[0].posture = 'standing';
    game.activeTacticalEncounter.enemies[0].distance = 1;
    game.activeTacticalEncounter.zombies = { distant: 0, approaching: 1, engaged: 0, downed: 0 };
    game.activeTacticalEncounter.rangeBand = 'near';
    expect(game.performTacticalAction('melee', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
      weaponStackId: spear.stackId,
      targetId: game.activeTacticalEncounter.enemies[0].id,
    })).toEqual(expect.objectContaining({ ok: true }));
    const broken = game.inventory.find((entry) => entry.stackId === spear.stackId);
    expect(broken.conditionState.condition.broken).toBe(true);
    expect(game.equippedWeaponStackId).toBeNull();

    game.activeTacticalEncounter = null;
    game.ensureNodeZombieState(game.currentNodeId).count = 0;
    expect(game.addItem(item('duct_tape'), 1, true)).toBe(true);
    expect(game.repairWeapon(broken.stackId, 'duct_tape')).toEqual(expect.objectContaining({ ok: true }));
    const repaired = game.inventory.find((entry) => entry.stackId === broken.stackId);
    expect(repaired.conditionState.condition.current).toBeGreaterThan(0);
    expect(repaired.conditionState.condition.broken).toBe(false);
    expect(game.inventory.some((entry) => entry.id === 'duct_tape')).toBe(false);
  });
});

describe('v0.4 save migration', () => {
  it('upgrades v3 inventory into stable stacks without dropping legacy over-cap cargo', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 3,
        day: 4,
        currentNodeId: 'muldraugh',
        spawnLocation: { id: 'muldraugh' },
        shelter: { id: 'warehouse_loft' },
        inventory: [
          { id: 'water_bottle', count: 30 },
          { id: 'hiking_bag', count: 1 },
          { id: 'baseball_bat', count: 2 },
        ],
        equippedWeaponId: 'baseball_bat',
        vehicle: { status: 'working', fuel: 2, name: '工具皮卡', condition: 64 },
      },
    }));
    const game = useGameStore();

    game.loadPersistedState();

    expect(SAVE_VERSION).toBe(9);
    expect(game.saveVersion).toBe(9);
    expect(game.baseInventory).toEqual([]);
    expect(game.vehicleInventory).toEqual([]);
    expect(game.inventory.every((entry) => entry.stackId && entry.conditionState)).toBe(true);
    expect(game.inventory.filter((entry) => entry.id === 'baseball_bat')).toHaveLength(2);
    expect(game.inventory.reduce((sum, entry) => sum + entry.space * entry.count, 0)).toBeGreaterThan(game.maxSpace);
    expect(game.equippedBagStackId).toBe(game.inventory.find((entry) => entry.id === 'hiking_bag').stackId);
    expect(game.equippedWeaponStackId).toBe(game.inventory.find((entry) => entry.id === 'baseball_bat').stackId);
    expect(game.vehicle.nodeId).toBe('muldraugh');
    expect(game.vehicle.trunkSpace).toBeGreaterThan(0);
  });
});
