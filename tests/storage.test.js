import { describe, expect, it } from 'vitest';
import { marketItems } from '../src/data/zombie.js';
import {
  advanceFoodSpoilage,
  createItemConditionState,
} from '../src/services/item-condition.js';
import {
  CARRY_BASE_CAPACITY,
  STORAGE_CONTAINERS,
  baseStorageCapacity,
  carryStorageCapacity,
  normalizeStorageInventory,
  previewStorageTransfer,
  projectStorageTransfer,
  storageCapacities,
  storageUsedSpace,
  trunkStorageCapacity,
} from '../src/services/storage.js';

const catalogItem = (id) => marketItems.find((item) => item.id === id);

function normalized(entries, containerId = 'carry') {
  return normalizeStorageInventory(entries, marketItems, { containerId });
}

function contextWith(containers, overrides = {}) {
  return {
    containers: {
      carry: containers.carry ?? [],
      base: containers.base ?? [],
      trunk: containers.trunk ?? [],
    },
    skills: { strength: 5 },
    selectedTraits: [],
    equippedBagStackId: null,
    shelter: { space: 40 },
    vehicle: { status: 'working', trunkSpace: 40, condition: 100 },
    access: { base: true, trunk: true },
    ...overrides,
  };
}

describe('storage inventory normalization', () => {
  it('merges only identical condition/freshness lots and remains stable and immutable', () => {
    const berries = catalogItem('wild_berries');
    const fresh = createItemConditionState(berries, {
      acquiredMinutes: 120,
      sequence: 1,
      sourceId: 'forage',
    });
    const stale = advanceFoodSpoilage(fresh, { elapsedMinutes: 2 * 24 * 60 });
    const input = [
      { id: 'wild_berries', count: 2, conditionState: fresh },
      { id: 'wild_berries', count: 3, conditionState: structuredClone(fresh) },
      { id: 'wild_berries', count: 1, conditionState: stale },
      { id: 'plank', count: 2 },
      { id: 'plank', count: 4 },
      { id: 'missing_catalog_item', count: 50 },
      { id: 'nails', count: 0 },
    ];
    const snapshot = structuredClone(input);

    const first = normalized(input);
    const repeated = normalized(input);
    const berryLots = first.filter((entry) => entry.id === 'wild_berries');

    expect(first).toEqual(repeated);
    expect(input).toEqual(snapshot);
    expect(berryLots).toHaveLength(2);
    expect(berryLots.map((entry) => entry.count)).toEqual([5, 1]);
    expect(berryLots.map((entry) => entry.conditionState.freshness.state)).toEqual(['fresh', 'stale']);
    expect(first.find((entry) => entry.id === 'plank').count).toBe(6);
    expect(new Set(first.map((entry) => entry.stackId)).size).toBe(first.length);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('keeps different weapon condition batches as count-1 instances', () => {
    const crowbar = catalogItem('crowbar');
    const pristine = createItemConditionState(crowbar, { sourceId: 'garage' });
    const worn = {
      ...pristine,
      condition: { ...pristine.condition, current: 42 },
    };
    const inventory = normalized([
      { id: 'crowbar', count: 3, conditionState: pristine },
      { id: 'crowbar', count: 1, conditionState: worn },
      { id: 'hammer', count: 2 },
    ]);
    const weapons = inventory.filter((entry) => entry.tags.includes('weapon'));

    expect(weapons).toHaveLength(6);
    expect(weapons.every((entry) => entry.count === 1)).toBe(true);
    expect(new Set(weapons.map((entry) => entry.stackId)).size).toBe(6);
    expect(weapons.every((entry) => entry.conditionState.instanceId === entry.stackId)).toBe(true);
    expect(inventory.filter((entry) => entry.id === 'crowbar').map(
      (entry) => entry.conditionState.condition.current,
    )).toEqual([100, 100, 100, 42]);
  });

  it('bounds corrupt legacy counts before splitting weapon instances', () => {
    const normalizedWeapons = normalizeStorageInventory([
      { id: 'crowbar', count: Number.MAX_SAFE_INTEGER },
    ], marketItems, { containerId: 'carry' });

    expect(normalizedWeapons).toHaveLength(999);
    expect(normalizedWeapons.every((entry) => entry.count === 1)).toBe(true);
  });

  it('keeps wearable bags as separate equipment instances', () => {
    const bags = normalizeStorageInventory([
      { id: 'hiking_bag', count: 2 },
    ], marketItems, { containerId: 'carry' });

    expect(bags).toHaveLength(2);
    expect(bags.every((entry) => entry.count === 1)).toBe(true);
    expect(new Set(bags.map((entry) => entry.stackId)).size).toBe(2);
  });

  it('preserves and clamps top-level weapon repair counts on every split instance', () => {
    const inventory = normalized([
      { id: 'crowbar', count: 2, repairCount: 7 },
      { id: 'hammer', count: 1, repairCount: 99 },
      { id: 'kitchen_knife', count: 1, repairCount: -4 },
      { id: 'plank', count: 1, repairCount: 12 },
    ]);

    expect(inventory.filter((entry) => entry.id === 'crowbar').map((entry) => entry.repairCount)).toEqual([7, 7]);
    expect(inventory.find((entry) => entry.id === 'hammer').repairCount).toBe(50);
    expect(inventory.find((entry) => entry.id === 'kitchen_knife').repairCount).toBe(0);
    expect(inventory.find((entry) => entry.id === 'plank')).not.toHaveProperty('repairCount');
  });

  it('calculates occupied space from normalized stacks without mutating them', () => {
    const inventory = normalized([
      { id: 'plank', count: 3 },
      { id: 'generator', count: 1 },
      { id: 'water_bottle', count: 2 },
    ]);
    const snapshot = structuredClone(inventory);

    expect(storageUsedSpace(inventory)).toBe(16);
    expect(storageUsedSpace([{ count: 2, space: 0.75 }, { count: -4, space: 10 }])).toBe(1.5);
    expect(storageUsedSpace(null)).toBe(0);
    expect(inventory).toEqual(snapshot);
  });
});

describe('container capacities', () => {
  it('uses survivor strength and traits before adding exactly one equipped bag', () => {
    const bags = normalized([
      { id: 'duffel_bag', count: 1 },
      { id: 'big_hiking_bag', count: 1 },
    ]);
    const duffel = bags.find((entry) => entry.id === 'duffel_bag');
    const bigBag = bags.find((entry) => entry.id === 'big_hiking_bag');

    expect(CARRY_BASE_CAPACITY).toBe(14);
    expect(carryStorageCapacity({ skills: { strength: 5 } })).toBe(14);
    expect(carryStorageCapacity({ skills: { strength: 8 } })).toBe(20);
    expect(carryStorageCapacity({ skills: { strength: 2 } })).toBe(11);
    expect(carryStorageCapacity({
      skills: { strength: 0 },
      selectedTraits: [{ id: 'disorganized' }],
    })).toBe(6);
    expect(carryStorageCapacity({
      skills: { strength: 5 },
      selectedTraits: [{ id: 'organized' }],
      inventory: bags,
    })).toBe(18);
    expect(carryStorageCapacity({
      skills: { strength: 5 },
      selectedTraits: [{ id: 'organized' }],
      inventory: bags,
      equippedBagStackId: duffel.stackId,
    })).toBe(26);
    expect(carryStorageCapacity({
      skills: { strength: 5 },
      selectedTraits: [{ id: 'organized' }],
      inventory: bags,
      equippedBagStackId: bigBag.stackId,
    })).toBe(34);
  });

  it('derives base capacity from the shelter and condition-scaled trunk capacity', () => {
    expect(baseStorageCapacity({ space: 54 })).toBe(54);
    expect(baseStorageCapacity(null)).toBe(0);
    expect(trunkStorageCapacity({ status: 'working', trunkSpace: 40, condition: 100 })).toBe(40);
    expect(trunkStorageCapacity({ status: 'working', trunkSpace: 40, condition: 75 })).toBe(30);
    expect(trunkStorageCapacity({ status: 'damaged', trunkSpace: 40, condition: 20 })).toBe(20);
    expect(trunkStorageCapacity({ status: 'working', trunkSpace: 40 })).toBe(40);
    expect(trunkStorageCapacity({ status: 'none', trunkSpace: 40, condition: 100 })).toBe(0);
    expect(trunkStorageCapacity({ status: 'working', condition: 100 })).toBe(0);
  });

  it('reports all three capacities from a single projection context', () => {
    const carry = normalized([{ id: 'hiking_bag', count: 1 }]);
    const equippedBagStackId = carry[0].stackId;
    expect(storageCapacities(contextWith({ carry }, {
      skills: { strength: 7 },
      selectedTraits: [{ id: 'organized' }],
      equippedBagStackId,
      shelter: { space: 64 },
      vehicle: { status: 'working', trunkSpace: 50, condition: 80 },
    }))).toEqual({ carry: 35, base: 64, trunk: 40 });
  });
});

describe('atomic storage transfers', () => {
  it('previews and projects a partial transfer, merging an identical destination lot', () => {
    const carry = normalized([{ id: 'plank', count: 4 }], 'carry');
    const base = normalized([{ id: 'plank', count: 1 }], 'base');
    const context = contextWith({ carry, base });
    const snapshot = structuredClone(context);
    const request = { from: 'carry', to: 'base', stackId: carry[0].stackId, count: 2 };

    const preview = previewStorageTransfer(context, request);
    const projected = projectStorageTransfer(context, request);

    expect(preview).toMatchObject({
      ok: true,
      reason: null,
      itemId: 'plank',
      count: 2,
      usedSpace: { carry: 4, base: 6, trunk: 0 },
    });
    expect(preview).not.toHaveProperty('containers');
    expect(projected.containers.carry[0]).toMatchObject({ id: 'plank', count: 2 });
    expect(projected.containers.base).toHaveLength(1);
    expect(projected.containers.base[0]).toMatchObject({ id: 'plank', count: 3 });
    expect(projected.containers.base[0].stackId).toBe(base[0].stackId);
    expect(context).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
  });

  it('does not merge freshness batches that differ after transfer', () => {
    const berries = catalogItem('wild_berries');
    const freshState = createItemConditionState(berries);
    const staleState = advanceFoodSpoilage(freshState, { elapsedMinutes: 2 * 24 * 60 });
    const carry = normalized([{ id: 'wild_berries', count: 2, conditionState: freshState }], 'carry');
    const base = normalized([{ id: 'wild_berries', count: 1, conditionState: staleState }], 'base');
    const result = projectStorageTransfer(contextWith({ carry, base }), {
      from: 'carry',
      to: 'base',
      stackId: carry[0].stackId,
      count: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.containers.base).toHaveLength(2);
    expect(result.containers.base.map((entry) => entry.conditionState.freshness.state)).toEqual(['stale', 'fresh']);
    expect(result.containers.base.map((entry) => entry.count)).toEqual([1, 1]);
    expect(result.containers.base[1].stackId).not.toBe(result.containers.carry[0].stackId);
  });

  it.each([
    ['invalid_count', { from: 'carry', to: 'base', count: 0 }],
    ['invalid_count', { from: 'carry', to: 'base', count: 1.5 }],
    ['invalid_count', { from: 'carry', to: 'base', count: '1' }],
    ['invalid_container', { from: 'pocket', to: 'base', count: 1 }],
    ['same_container', { from: 'carry', to: 'carry', count: 1 }],
    ['source_stack_missing', { from: 'carry', to: 'base', count: 1, stackId: 'missing' }],
    ['insufficient_quantity', { from: 'carry', to: 'base', count: 3 }],
  ])('rejects %s without exposing a partial projection', (reason, requestFields) => {
    const carry = normalized([{ id: 'nails', count: 2 }]);
    const context = contextWith({ carry });
    const snapshot = structuredClone(context);
    const result = projectStorageTransfer(context, {
      stackId: carry[0].stackId,
      ...requestFields,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result).not.toHaveProperty('containers');
    expect(context).toEqual(snapshot);
  });

  it('validates both source and destination reachability', () => {
    const carry = normalized([{ id: 'nails', count: 1 }]);
    const base = normalized([{ id: 'plank', count: 1 }], 'base');
    const blockedBase = contextWith({ carry, base }, { access: { base: false, trunk: true } });
    const blockedTrunk = contextWith({ carry, base }, { access: { base: true, trunk: false } });

    expect(projectStorageTransfer(blockedBase, {
      from: 'carry', to: 'base', stackId: carry[0].stackId, count: 1,
    }).reason).toBe('inaccessible_destination');
    expect(projectStorageTransfer(blockedBase, {
      from: 'base', to: 'carry', stackId: base[0].stackId, count: 1,
    }).reason).toBe('inaccessible_source');
    expect(projectStorageTransfer(blockedTrunk, {
      from: 'carry', to: 'trunk', stackId: carry[0].stackId, count: 1,
    }).reason).toBe('inaccessible_destination');
  });

  it('rejects a destination overflow atomically', () => {
    const carry = normalized([{ id: 'plank', count: 1 }]);
    const context = contextWith({ carry }, { shelter: { space: 1 } });
    const snapshot = structuredClone(context);
    const result = projectStorageTransfer(context, {
      from: 'carry', to: 'base', stackId: carry[0].stackId, count: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'destination_over_capacity',
      usedSpace: { carry: 0, base: 2, trunk: 0 },
      capacities: { carry: 14, base: 1, trunk: 40 },
    });
    expect(result).not.toHaveProperty('containers');
    expect(context).toEqual(snapshot);
  });

  it('rejects removing the equipped bag while the projected carry load needs its bonus', () => {
    const carry = normalized([
      { id: 'duffel_bag', count: 1 },
      { id: 'plank', count: 10 },
    ]);
    const bag = carry.find((entry) => entry.id === 'duffel_bag');
    const planks = carry.find((entry) => entry.id === 'plank');
    const context = contextWith({ carry }, {
      equippedBagStackId: bag.stackId,
      shelter: { space: 100 },
    });
    const snapshot = structuredClone(context);

    expect(storageUsedSpace(carry)).toBe(22);
    expect(storageCapacities(context).carry).toBe(22);
    const blocked = projectStorageTransfer(context, {
      from: 'carry', to: 'base', stackId: bag.stackId, count: 1,
    });
    expect(blocked).toMatchObject({
      ok: false,
      reason: 'equipped_bag_required',
      usedSpace: { carry: 20 },
      capacities: { carry: 14 },
    });
    expect(blocked).not.toHaveProperty('containers');
    expect(context).toEqual(snapshot);

    const unload = projectStorageTransfer(context, {
      from: 'carry', to: 'base', stackId: planks.stackId, count: 3,
    });
    expect(unload.ok).toBe(true);
    const safeBagMove = projectStorageTransfer({ ...context, containers: unload.containers }, {
      from: 'carry', to: 'base', stackId: bag.stackId, count: 1,
    });
    expect(safeBagMove.ok).toBe(true);
    expect(safeBagMove.nextEquippedBagStackId).toBeNull();
    expect(safeBagMove.usedSpace.carry).toBe(14);
    expect(safeBagMove.capacities.carry).toBe(14);
  });
});
