import { describe, expect, it, vi } from 'vitest';

import {
  WORLD_LOOT_SLOT_STATUS,
  WORLD_LOOT_VERSION,
  claimWorldLoot,
  createWorldLootContainer,
  normalizeWorldLootContainer,
  previewWorldLootClaim,
  revealWorldLootSlot,
  revealWorldLootSlots,
  summarizeWorldLootContainer,
} from '../src/services/world-loot.js';

const catalog = Object.freeze([
  Object.freeze({ id: 'water_bottle', name: 'Water', category: 'drink', tier: 'white', space: 1, tags: Object.freeze(['water']) }),
  Object.freeze({ id: 'canned_soup', name: 'Soup', category: 'food', tier: 'white', space: 1, tags: Object.freeze(['food', 'canned']) }),
  Object.freeze({ id: 'bandage', name: 'Bandage', category: 'medical', tier: 'green', space: 1, tags: Object.freeze(['medical']) }),
  Object.freeze({ id: 'hammer', name: 'Hammer', category: 'tool', tier: 'green', space: 2, tags: Object.freeze(['tool', 'carpentry', 'weapon']) }),
  Object.freeze({ id: 'nails', name: 'Nails', category: 'base', tier: 'white', space: 1, tags: Object.freeze(['material', 'carpentry']) }),
  Object.freeze({ id: 'baseball_bat', name: 'Bat', category: 'weapon', tier: 'blue', space: 3, tags: Object.freeze(['weapon', 'melee']) }),
  Object.freeze({ id: 'hiking_bag', name: 'Bag', category: 'bag', tier: 'purple', space: 2, effects: Object.freeze({ capacity: 12 }), tags: Object.freeze(['bag', 'capacity']) }),
  Object.freeze({ id: '9mm_rounds', name: '9mm', category: 'ammo', tier: 'red', space: 1, tags: Object.freeze(['ammo', '9mm']) }),
]);

const baseContext = (overrides = {}) => ({
  worldSeed: 'knox-1993',
  searchKey: 'riverside:riverside_garage_shelf',
  searchable: {
    id: 'riverside_garage_shelf',
    name: 'Garage shelf',
    assetId: 'tile_locker',
    quality: 'blue',
    description: 'Tools, tape, and a gas can are likely.',
  },
  node: {
    id: 'riverside',
    type: 'spawn_town',
    danger: 2,
    resourceHint: 'homes, school, hardware',
  },
  catalog,
  ...overrides,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function legacyContainer(statuses = ['hidden', 'revealed', 'taken']) {
  return {
    lootSlots: [
      { id: 'old-water', itemId: 'water_bottle', count: 2, status: statuses[0] },
      { id: 'old-bat', itemId: 'baseball_bat', count: 1, status: statuses[1] },
      { id: 'old-bandage', itemId: 'bandage', count: 1, status: statuses[2] },
    ],
  };
}

describe('persistent deterministic world loot', () => {
  it('generates JSON-safe slots and instances deterministically without clock or random access', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used');
    });
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now must not be used');
    });

    try {
      const first = createWorldLootContainer(baseContext());
      const repeated = createWorldLootContainer(baseContext({ catalog: [...catalog].reverse() }));

      expect(first).toEqual(repeated);
      expect(first.version).toBe(WORLD_LOOT_VERSION);
      expect(first.revision).toBe(0);
      expect(first.searchCostPaid).toBe(false);
      expect(first.searchCompletedAtMinutes).toBeNull();
      expect(first.searchCost.minutes).toBe(60);
      expect(first.slots).toHaveLength(3);
      expect(first.slots.every((slot) => slot.status === WORLD_LOOT_SLOT_STATUS.HIDDEN)).toBe(true);
      expect(new Set(first.slots.map((slot) => slot.slotId)).size).toBe(first.slots.length);
      expect(new Set(first.slots.map((slot) => slot.item.stackId)).size).toBe(first.slots.length);
      expect(first.slots.every((slot) => slot.item.conditionState.stackId === slot.item.stackId)).toBe(true);
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    } finally {
      randomSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it('uses both world seed and search key to produce a different generation identity', () => {
    const original = createWorldLootContainer(baseContext());
    const otherSeed = createWorldLootContainer(baseContext({ worldSeed: 'knox-alt' }));
    const otherKey = createWorldLootContainer(baseContext({ searchKey: 'riverside:riverside_kitchen' }));

    expect(otherSeed.generationId).not.toBe(original.generationId);
    expect(otherKey.generationId).not.toBe(original.generationId);
    expect(otherSeed.slots.map((slot) => slot.item.stackId)).not.toEqual(original.slots.map((slot) => slot.item.stackId));
    expect(otherKey.slots.map((slot) => slot.item.stackId)).not.toEqual(original.slots.map((slot) => slot.item.stackId));
  });

  it('allows the caller to tune the one-time search duration without changing generated loot', () => {
    const standard = createWorldLootContainer(baseContext());
    const tuned = createWorldLootContainer(baseContext({ searchMinutes: 25 }));

    expect(tuned.searchCost.minutes).toBe(25);
    expect(tuned.slots).toEqual(standard.slots);
    expect(tuned.generationId).toBe(standard.generationId);
  });

  it('normalizes v5 arrays and interrupted searches without inventing claimed loot', () => {
    const directArray = normalizeWorldLootContainer(legacyContainer().lootSlots, baseContext());
    const wrapped = normalizeWorldLootContainer(legacyContainer(['searching', 'revealed', 'taken']), baseContext());

    expect(directArray.slots.map((slot) => slot.status)).toEqual(['hidden', 'revealed', 'claimed']);
    expect(wrapped.slots.map((slot) => slot.status)).toEqual(['hidden', 'revealed', 'claimed']);
    expect(wrapped.slots.map((slot) => slot.item.id)).toEqual(['water_bottle', 'baseball_bat', 'bandage']);
    expect(wrapped.slots[0].item.count).toBe(2);
    expect(wrapped.slots[1].item.conditionState.condition).not.toBeNull();
    expect(wrapped.appliedCommandIds).toEqual([]);
    expect(wrapped.searchCostPaid).toBe(true);
    expect(wrapped.searchCompletedAtMinutes).toBeNull();
    expect(JSON.parse(JSON.stringify(wrapped))).toEqual(wrapped);
  });

  it('repairs malformed v1 state against catalog while keeping valid persistence fields', () => {
    const generated = createWorldLootContainer(baseContext());
    const raw = {
      ...generated,
      revision: 7.4,
      appliedCommandIds: ['', 'open-1', 'open-1', 42, 'open-2'],
      slots: [
        { ...generated.slots[0], status: 'revealed' },
        { ...generated.slots[1], status: 'taken' },
        { slotId: 'bad', status: 'revealed', item: { id: 'not-in-catalog', count: 99 } },
      ],
    };

    const normalized = normalizeWorldLootContainer(raw, baseContext());

    expect(normalized.revision).toBe(7);
    expect(normalized.appliedCommandIds).toEqual(['open-1', 'open-2']);
    expect(normalized.slots).toHaveLength(2);
    expect(normalized.slots.map((slot) => slot.status)).toEqual(['revealed', 'claimed']);
    expect(normalized.slots.every((slot) => catalog.some((item) => item.id === slot.item.id))).toBe(true);
  });

  it('drops an invalid persisted haul instead of regenerating replacement loot', () => {
    const generated = createWorldLootContainer(baseContext());
    const normalized = normalizeWorldLootContainer({
      ...generated,
      searchCostPaid: true,
      slots: [{
        slotId: 'removed-slot',
        status: 'revealed',
        item: { id: 'removed-from-catalog', count: 99, stackId: 'removed-stack' },
      }],
    }, baseContext());

    expect(normalized.slots).toEqual([]);
    expect(normalized.searchCostPaid).toBe(true);
    expect(summarizeWorldLootContainer(normalized, baseContext())).toEqual(expect.objectContaining({
      total: 0,
      remaining: 0,
      exhausted: true,
    }));
  });
});

describe('world loot commands', () => {
  it('reveals one exact slot and rejects replayed or stale commands with zero mutation', () => {
    const initial = createWorldLootContainer(baseContext());
    const inputSnapshot = clone(initial);
    const slotId = initial.slots[0].slotId;
    const revealed = revealWorldLootSlot(initial, {
      commandId: 'reveal-1',
      expectedRevision: 0,
      slotId,
      completedAtMinutes: 1_440,
    }, baseContext());

    expect(revealed).toMatchObject({ ok: true, reason: null, replayed: false });
    expect(revealed.nextState.revision).toBe(1);
    expect(revealed.nextState.slots[0].status).toBe('revealed');
    expect(revealed.nextState.slots.slice(1).every((slot) => slot.status === 'hidden')).toBe(true);
    expect(revealed.nextState.appliedCommandIds).toEqual(['reveal-1']);
    expect(revealed.nextState.searchCostPaid).toBe(true);
    expect(revealed.nextState.searchCompletedAtMinutes).toBe(1_440);
    expect(revealed.cost.minutes).toBeGreaterThan(0);
    expect(revealed.cost.noise).toBeGreaterThanOrEqual(0);
    expect(initial).toEqual(inputSnapshot);

    const stateSnapshot = clone(revealed.nextState);
    const replay = revealWorldLootSlot(revealed.nextState, {
      commandId: 'reveal-1',
      expectedRevision: 1,
      slotId: initial.slots[1].slotId,
    }, baseContext());
    const stale = revealWorldLootSlot(revealed.nextState, {
      commandId: 'reveal-stale',
      expectedRevision: 0,
      slotId: initial.slots[1].slotId,
    }, baseContext());

    expect(replay).toMatchObject({ ok: false, reason: 'duplicate_command', replayed: true });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_revision', replayed: false });
    expect(replay.nextState).toEqual(stateSnapshot);
    expect(stale.nextState).toEqual(stateSnapshot);
    expect(revealed.nextState).toEqual(stateSnapshot);
  });

  it('reveals several hidden slots in one transaction and never charges the search cost twice', () => {
    const initial = createWorldLootContainer(baseContext());
    const firstIds = initial.slots.slice(0, 2).map((slot) => slot.slotId);
    const first = revealWorldLootSlots(initial, {
      commandId: 'bulk-reveal',
      expectedRevision: 0,
      slotIds: firstIds,
      completedAtMinutes: 300,
    }, baseContext());
    const second = revealWorldLootSlots(first.nextState, {
      commandId: 'last-reveal',
      expectedRevision: 1,
      slotIds: [initial.slots[2].slotId],
      completedAtMinutes: 999,
    }, baseContext());

    expect(first.ok).toBe(true);
    expect(first.revealedSlots).toHaveLength(2);
    expect(first.cost).toEqual(initial.searchCost);
    expect(first.nextState.searchCompletedAtMinutes).toBe(300);
    expect(second.ok).toBe(true);
    expect(second.cost).toEqual({ minutes: 0, noise: 0 });
    expect(second.nextState.searchCompletedAtMinutes).toBe(300);
    expect(second.nextState.slots.every((slot) => slot.status === 'revealed')).toBe(true);
  });

  it('requires command identity, current revision, and a still-hidden exact slot', () => {
    const initial = createWorldLootContainer(baseContext());
    const slotId = initial.slots[0].slotId;
    const missingCommand = revealWorldLootSlot(initial, { expectedRevision: 0, slotId }, baseContext());
    const missingRevision = revealWorldLootSlot(initial, { commandId: 'x', slotId }, baseContext());
    const missingSlot = revealWorldLootSlot(initial, { commandId: 'x', expectedRevision: 0, slotId: 'missing' }, baseContext());
    const revealed = revealWorldLootSlot(initial, { commandId: 'x', expectedRevision: 0, slotId }, baseContext());
    const again = revealWorldLootSlot(revealed.nextState, { commandId: 'y', expectedRevision: 1, slotId }, baseContext());

    expect(missingCommand.reason).toBe('invalid_command');
    expect(missingRevision.reason).toBe('invalid_command');
    expect(missingSlot.reason).toBe('slot_missing');
    expect(again.reason).toBe('slot_not_hidden');
    expect(initial.revision).toBe(0);
  });

  it('previews exact revealed stacks without mutating container or inventory', () => {
    const state = normalizeWorldLootContainer(legacyContainer(['revealed', 'revealed', 'hidden']), baseContext());
    const stackIds = state.slots.slice(0, 2).map((slot) => slot.item.stackId);
    const inventory = [{
      ...catalog.find((item) => item.id === 'bandage'),
      count: 1,
      stackId: 'carry:bandage:old',
      conditionState: state.slots[2].item.conditionState,
    }];
    const stateSnapshot = clone(state);
    const inventorySnapshot = clone(inventory);

    const preview = previewWorldLootClaim(state, {
      expectedRevision: 0,
      stackIds,
    }, { ...baseContext(), inventory, capacity: 20 });

    expect(preview).toMatchObject({ ok: true, reason: null, usedSpace: 6, capacity: 20 });
    expect(preview.claimedStacks.map((entry) => entry.stackId)).toEqual(stackIds);
    expect(preview.projectedInventory.some((entry) => entry.stackId === stackIds[1] && entry.id === 'baseball_bat')).toBe(true);
    expect(preview.projectedInventory.find((entry) => entry.id === 'water_bottle')?.count).toBe(2);
    expect(state).toEqual(stateSnapshot);
    expect(inventory).toEqual(inventorySnapshot);
  });

  it('rejects hidden, claimed, duplicate, item-id, and stale selections', () => {
    const state = normalizeWorldLootContainer(legacyContainer(['revealed', 'hidden', 'taken']), baseContext());
    const revealed = state.slots[0].item.stackId;
    const hidden = state.slots[1].item.stackId;
    const claimed = state.slots[2].item.stackId;
    const context = { ...baseContext(), inventory: [], capacity: 20 };

    expect(previewWorldLootClaim(state, { expectedRevision: 0, stackIds: [hidden] }, context).reason).toBe('stack_not_revealed');
    expect(previewWorldLootClaim(state, { expectedRevision: 0, stackIds: [claimed] }, context).reason).toBe('stack_not_revealed');
    expect(previewWorldLootClaim(state, { expectedRevision: 0, stackIds: [revealed, revealed] }, context).reason).toBe('invalid_selection');
    expect(previewWorldLootClaim(state, { expectedRevision: 0, stackIds: ['water_bottle'] }, context).reason).toBe('stack_missing');
    expect(previewWorldLootClaim(state, { expectedRevision: 4, stackIds: [revealed] }, context).reason).toBe('stale_revision');
  });

  it('makes an over-capacity preview and claim atomic zero-change failures', () => {
    const state = normalizeWorldLootContainer(legacyContainer(['revealed', 'revealed', 'hidden']), baseContext());
    const inventory = [{ ...catalog[0], count: 3, stackId: 'carry:water', conditionState: state.slots[0].item.conditionState }];
    const selectedBat = state.slots[1].item.stackId;
    const beforeState = clone(state);
    const beforeInventory = clone(inventory);
    const context = { ...baseContext(), inventory, capacity: 5 };

    const preview = previewWorldLootClaim(state, { expectedRevision: 0, stackIds: [selectedBat] }, context);
    const committed = claimWorldLoot(state, {
      commandId: 'claim-heavy',
      expectedRevision: 0,
      stackIds: [selectedBat],
    }, context);

    expect(preview).toMatchObject({ ok: false, reason: 'capacity_exceeded', usedSpace: 6, capacity: 5 });
    expect(preview).not.toHaveProperty('projectedInventory');
    expect(committed).toMatchObject({ ok: false, reason: 'capacity_exceeded', replayed: false });
    expect(committed.nextState).toEqual(beforeState);
    expect(committed.inventory).toEqual(beforeInventory);
    expect(state).toEqual(beforeState);
    expect(inventory).toEqual(beforeInventory);
  });

  it('claims selected exact stacks atomically while every unselected slot persists', () => {
    const initial = normalizeWorldLootContainer(legacyContainer(['revealed', 'revealed', 'hidden']), baseContext());
    const waterStack = initial.slots[0].item.stackId;
    const untouchedBat = clone(initial.slots[1]);
    const untouchedBandage = clone(initial.slots[2]);
    const result = claimWorldLoot(initial, {
      commandId: 'claim-water',
      expectedRevision: 0,
      stackIds: [waterStack],
    }, { ...baseContext(), inventory: [], capacity: 20 });

    expect(result).toMatchObject({ ok: true, reason: null, replayed: false });
    expect(result.nextState.revision).toBe(1);
    expect(result.nextState.appliedCommandIds).toEqual(['claim-water']);
    expect(result.nextState.slots[0].status).toBe('claimed');
    expect(result.nextState.slots[1]).toEqual(untouchedBat);
    expect(result.nextState.slots[2]).toEqual(untouchedBandage);
    expect(result.inventory).toEqual([
      expect.objectContaining({ id: 'water_bottle', count: 2, stackId: waterStack }),
    ]);

    const replaySnapshot = clone(result.nextState);
    const replay = claimWorldLoot(result.nextState, {
      commandId: 'claim-water',
      expectedRevision: 1,
      stackIds: [untouchedBat.item.stackId],
    }, { ...baseContext(), inventory: result.inventory, capacity: 20 });
    const stale = claimWorldLoot(result.nextState, {
      commandId: 'claim-bat-stale',
      expectedRevision: 0,
      stackIds: [untouchedBat.item.stackId],
    }, { ...baseContext(), inventory: result.inventory, capacity: 20 });

    expect(replay).toMatchObject({ ok: false, reason: 'duplicate_command', replayed: true });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_revision', replayed: false });
    expect(replay.nextState).toEqual(replaySnapshot);
    expect(stale.nextState).toEqual(replaySnapshot);
  });

  it('summarizes visibility without leaking hidden item identity', () => {
    const state = normalizeWorldLootContainer(legacyContainer(['hidden', 'revealed', 'taken']), baseContext());
    const summary = summarizeWorldLootContainer(state, baseContext());

    expect(summary).toMatchObject({ total: 3, hidden: 1, revealed: 1, claimed: 1, remaining: 2, exhausted: false, complete: false });
    expect(summary.slots[0]).toEqual(expect.objectContaining({ status: 'hidden', item: null }));
    expect(summary.slots[1].item).toEqual(expect.objectContaining({
      id: 'baseball_bat',
      count: 1,
      conditionState: expect.objectContaining({ stackId: expect.any(String) }),
    }));
    expect(summary.slots[2].item).toEqual(expect.objectContaining({ id: 'bandage', count: 1 }));

    const empty = summarizeWorldLootContainer(createWorldLootContainer(baseContext({ catalog: [] })), baseContext({ catalog: [] }));
    expect(empty).toMatchObject({ total: 0, remaining: 0, exhausted: true, complete: true });
  });
});
