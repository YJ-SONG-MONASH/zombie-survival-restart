import { describe, expect, it } from 'vitest';
import {
  FISHING_VERSION,
  MAX_FISHING_ATTEMPTS_PER_DAY,
  advanceFishingState,
  createFishingState,
  normalizeFishingState,
  previewFishing,
  resolveFishing,
  summarizeFishing,
} from '../src/services/fishing.js';

const DAY = 24 * 60;

const spotDefs = [
  { nodeId: 'riverside', stockCap: 4, regenPerDay: 1, baseCatchChance: 0.38 },
  { nodeId: 'riverside_farms', stockCap: 3, regenPerDay: 1, baseCatchChance: 0.35 },
  { nodeId: 'west_point', stockCap: 6, regenPerDay: 2, baseCatchChance: 0.42 },
];

const catalog = [
  {
    id: 'fishing_rod',
    name: 'Fishing Rod',
    category: 'survival',
    space: 3,
    tags: ['fishing', 'tool'],
  },
  {
    id: 'fishing_tackle',
    name: 'Fishing Tackle',
    category: 'survival',
    space: 1,
    tags: ['fishing', 'material'],
  },
  {
    id: 'fresh_fish',
    name: 'Fresh Fish',
    category: 'food',
    space: 2,
    effects: { hunger: -24, health: -4 },
    spoilage: { freshForMinutes: DAY, rottenAfterMinutes: 3 * DAY },
    tags: ['food', 'fish', 'raw', 'perishable'],
  },
];

function stack(id, stackId, count = 1) {
  const item = catalog.find((entry) => entry.id === id);
  return { ...structuredClone(item), stackId, count };
}

function nowFor(day = 2, clockMinutes = 6 * 60) {
  return (day - 1) * DAY + clockMinutes;
}

function baseContext(overrides = {}) {
  const day = overrides.day ?? 2;
  const clockMinutes = overrides.clockMinutes ?? 6 * 60;
  return {
    catalog: structuredClone(catalog),
    inventory: [
      stack('fishing_rod', 'rod:selected'),
      stack('fishing_tackle', 'tackle:selected', 4),
      stack('fishing_tackle', 'tackle:untouched', 2),
    ],
    capacity: 30,
    worldSeed: 90210,
    skill: 3,
    day,
    clockMinutes,
    totalMinutes: nowFor(day, clockMinutes),
    spotDefs: structuredClone(spotDefs),
    nextItemSequence: 40,
    currentNodeId: 'riverside',
    nodeSecured: true,
    activeTactical: false,
    runPhase: 'running',
    ...overrides,
  };
}

function baseState(context = baseContext()) {
  return createFishingState({
    spotDefs: context.spotDefs,
    totalMinutes: context.totalMinutes,
  });
}

function command(state, overrides = {}) {
  return {
    commandId: `fish:riverside:${state.revision}`,
    expectedRevision: state.revision,
    nodeId: 'riverside',
    rodStackId: 'rod:selected',
    tackleStackId: 'tackle:selected',
    destinationId: 'carry',
    ...overrides,
  };
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function itemCount(inventory, id, stackId = null) {
  return inventory
    .filter((entry) => entry.id === id && (!stackId || entry.stackId === stackId))
    .reduce((total, entry) => total + entry.count, 0);
}

function findOutcome(wanted, state = null, contextOverrides = {}) {
  for (let worldSeed = 0; worldSeed < 5_000; worldSeed += 1) {
    const context = baseContext({ ...contextOverrides, worldSeed });
    const current = state ?? baseState(context);
    const result = resolveFishing(current, command(current), context);
    if (result.ok && result.caught === wanted) return { context, state: current, result };
  }
  throw new Error(`Could not find deterministic fishing outcome: ${wanted}`);
}

describe('fishing save-state contract', () => {
  it('creates a canonical, JSON-safe state with full explicit spots', () => {
    const context = baseContext();
    const state = createFishingState({
      spotDefs: [...context.spotDefs].reverse(),
      totalMinutes: context.totalMinutes,
    });

    expect(FISHING_VERSION).toBe(1);
    expect(MAX_FISHING_ATTEMPTS_PER_DAY).toBe(3);
    expect(state).toEqual({
      version: 1,
      revision: 0,
      lastProcessedMinute: context.totalMinutes,
      appliedCommandIds: [],
      spots: {
        riverside: { stock: 4, attemptsDay: 2, attemptsToday: 0 },
        riverside_farms: { stock: 3, attemptsDay: 2, attemptsToday: 0 },
        west_point: { stock: 6, attemptsDay: 2, attemptsToday: 0 },
      },
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('normalizes hostile saves, drops unknown spots, clamps fields, and bounds the ledger', () => {
    const context = baseContext();
    const raw = deepFreeze({
      version: 999,
      revision: Number.POSITIVE_INFINITY,
      lastProcessedMinute: context.totalMinutes,
      appliedCommandIds: [
        ...Array.from({ length: 70 }, (_, index) => `old-${index}`),
        'old-69',
        '',
      ],
      spots: {
        riverside: { stock: 999, attemptsDay: 2, attemptsToday: 999 },
        west_point: { stock: -10, attemptsDay: 99, attemptsToday: 2 },
        modded_lake: { stock: 999 },
      },
    });
    const before = structuredClone(raw);
    const normalized = normalizeFishingState(raw, {
      spotDefs: context.spotDefs,
      totalMinutes: context.totalMinutes,
    });

    expect(normalized.version).toBe(1);
    expect(normalized.revision).toBe(0);
    expect(normalized.appliedCommandIds).toHaveLength(64);
    expect(normalized.appliedCommandIds[0]).toBe('old-6');
    expect(normalized.appliedCommandIds.at(-1)).toBe('old-69');
    expect(normalized.spots).toEqual({
      riverside: { stock: 4, attemptsDay: 2, attemptsToday: 3 },
      riverside_farms: { stock: 3, attemptsDay: 2, attemptsToday: 0 },
      west_point: { stock: 0, attemptsDay: 2, attemptsToday: 0 },
    });
    expect(raw).toEqual(before);
  });

  it('summarizes stock bands and remaining daily attempts without mutation', () => {
    const context = baseContext();
    const state = baseState(context);
    state.spots.riverside.stock = 1;
    state.spots.riverside.attemptsToday = 2;
    const before = snapshot(state);

    const summary = summarizeFishing(state, context);

    expect(summary).toMatchObject({
      version: 1,
      revision: 0,
      lastProcessedMinute: context.totalMinutes,
      timelineCurrent: true,
      maxAttemptsPerDay: 3,
    });
    expect(summary.spots.find((entry) => entry.nodeId === 'riverside')).toMatchObject({
      stock: 1,
      stockCap: 4,
      stockBand: 'scarce',
      attemptsToday: 2,
      attemptsRemaining: 1,
    });
    expect(state).toEqual(before);
  });
});

describe('segmented fishing time and renewable stock', () => {
  it('regenerates at absolute midnight, resets attempts, and is segment-equivalent', () => {
    const start = 8 * 60;
    const end = 2 * DAY + 8 * 60;
    const initial = createFishingState({ spotDefs, totalMinutes: start });
    initial.spots.riverside.stock = 0;
    initial.spots.riverside.attemptsToday = 3;
    const before = snapshot(initial);

    const oneShot = advanceFishingState(initial, {
      spotDefs,
      fromTotalMinutes: start,
      toTotalMinutes: end,
    });
    const first = advanceFishingState(initial, {
      spotDefs,
      fromTotalMinutes: start,
      toTotalMinutes: DAY,
    });
    const second = advanceFishingState(first.nextState, {
      spotDefs,
      fromTotalMinutes: DAY,
      toTotalMinutes: 2 * DAY,
    });
    const third = advanceFishingState(second.nextState, {
      spotDefs,
      fromTotalMinutes: 2 * DAY,
      toTotalMinutes: end,
    });

    expect(oneShot).toMatchObject({
      ok: true,
      reason: null,
      processedBoundaryMinutes: [DAY, 2 * DAY],
    });
    expect(oneShot.nextState).toEqual(third.nextState);
    expect(oneShot.nextState).toMatchObject({
      revision: 2,
      lastProcessedMinute: end,
      spots: { riverside: { stock: 2, attemptsDay: 3, attemptsToday: 0 } },
    });
    expect(initial).toEqual(before);
  });

  it('rejects mismatched or reversed timelines with a complete no-op projection', () => {
    const context = baseContext();
    const state = baseState(context);
    const before = snapshot(state);

    const stale = advanceFishingState(state, {
      spotDefs,
      fromTotalMinutes: context.totalMinutes + 1,
      toTotalMinutes: context.totalMinutes + 60,
    });
    const reversed = advanceFishingState(state, {
      spotDefs,
      fromTotalMinutes: context.totalMinutes,
      toTotalMinutes: context.totalMinutes - 1,
    });

    expect(stale).toMatchObject({ ok: false, reason: 'timeline_mismatch', nextState: before });
    expect(reversed).toMatchObject({ ok: false, reason: 'invalid_timeline', nextState: before });
    expect(state).toEqual(before);
  });
});

describe('fishing preview and exact transaction projection', () => {
  it('previews requirements and odds without revealing or committing the deterministic roll', () => {
    const context = baseContext();
    const state = baseState(context);
    const beforeState = snapshot(state);
    const beforeContext = snapshot(context);

    const preview = previewFishing(state, command(state), context);

    expect(preview).toMatchObject({
      ok: true,
      reason: null,
      replayed: false,
      committed: false,
      commandId: 'fish:riverside:0',
      revision: 0,
      nodeId: 'riverside',
      minutes: 105,
      chancePercent: 60,
      stockBefore: 4,
      stockBand: 'abundant',
      attemptsToday: 0,
      attemptsRemaining: 3,
      noiseDelta: 4,
      activityDelta: 2,
    });
    expect(preview).not.toHaveProperty('caught');
    expect(preview).not.toHaveProperty('catchCount');
    expect(preview).not.toHaveProperty('caughtStack');
    expect(preview.nextState).toEqual({
      fishing: beforeState,
      inventory: beforeContext.inventory,
      nextItemSequence: beforeContext.nextItemSequence,
    });
    expect(state).toEqual(beforeState);
    expect(context).toEqual(beforeContext);
  });

  it('consumes only the exact tackle stack, preserves the rod, and conserves fish stock', () => {
    const { context, state, result } = findOutcome(true);
    const beforeState = snapshot(state);
    const beforeContext = snapshot(context);

    expect(result).toMatchObject({
      ok: true,
      reason: null,
      committed: true,
      caught: true,
      catchCount: 1,
      consumedTackle: { stackId: 'tackle:selected', itemId: 'fishing_tackle', count: 1 },
      stockBefore: 4,
      stockAfter: 3,
      skillXp: 16,
      revision: 1,
    });
    expect(itemCount(result.nextState.inventory, 'fishing_rod', 'rod:selected')).toBe(1);
    expect(itemCount(result.nextState.inventory, 'fishing_tackle', 'tackle:selected')).toBe(3);
    expect(itemCount(result.nextState.inventory, 'fishing_tackle', 'tackle:untouched')).toBe(2);
    expect(itemCount(result.nextState.inventory, 'fresh_fish')).toBe(1);
    expect(result.nextState.fishing.spots.riverside.stock)
      .toBe(beforeState.spots.riverside.stock - result.catchCount);
    expect(result.nextState.nextItemSequence).toBe(context.nextItemSequence + 1);
    expect(result.nextState.fishing.appliedCommandIds.at(-1)).toBe(command(state).commandId);
    expect(context).toEqual(beforeContext);
    expect(state).toEqual(beforeState);
  });

  it('creates a deterministic, fresh JSON-safe fish stack with the acquisition clock', () => {
    const first = findOutcome(true);
    const repeated = resolveFishing(first.state, command(first.state), first.context);
    const reversedCatalog = resolveFishing(first.state, command(first.state), {
      ...first.context,
      catalog: [...first.context.catalog].reverse(),
    });
    const fish = first.result.caughtStack;

    expect(repeated).toEqual(first.result);
    expect(reversedCatalog).toEqual(first.result);
    expect(fish).toMatchObject({
      id: 'fresh_fish',
      count: 1,
      stackId: expect.any(String),
      conditionState: {
        itemId: 'fresh_fish',
        acquiredMinutes: first.context.totalMinutes,
        acquisitionSequence: first.context.nextItemSequence,
        freshness: {
          perishable: true,
          ageMinutes: 0,
          spoilageMinutes: 0,
          freshForMinutes: DAY,
          rottenAfterMinutes: 3 * DAY,
          state: 'fresh',
        },
      },
    });
    expect(fish.conditionState.stackId).toBe(fish.stackId);
    expect(fish.conditionState.instanceId).toBe(fish.stackId);
    expect(JSON.parse(JSON.stringify(first.result))).toEqual(first.result);
  });

  it('charges tackle and time on a miss without reducing stock or advancing item identity', () => {
    const { context, state, result } = findOutcome(false);

    expect(result).toMatchObject({
      ok: true,
      committed: true,
      caught: false,
      catchCount: 0,
      caughtStack: null,
      stockBefore: 4,
      stockAfter: 4,
      skillXp: 6,
    });
    expect(itemCount(result.nextState.inventory, 'fishing_tackle', 'tackle:selected')).toBe(3);
    expect(itemCount(result.nextState.inventory, 'fresh_fish')).toBe(0);
    expect(result.nextState.nextItemSequence).toBe(context.nextItemSequence);
    expect(result.nextState.fishing.spots.riverside.attemptsToday).toBe(1);
  });

  it('does not let command IDs reroll a deterministic attempt', () => {
    const context = baseContext();
    const state = baseState(context);
    const first = resolveFishing(state, command(state, { commandId: 'fish:first' }), context);
    const renamed = resolveFishing(state, command(state, { commandId: 'fish:renamed' }), context);

    expect(renamed.caught).toBe(first.caught);
    expect(renamed.catchCount).toBe(first.catchCount);
    expect(renamed.stockAfter).toBe(first.stockAfter);
  });
});

describe('fishing gates, concurrency, and immutability', () => {
  it.each([
    ['wrong node', { context: { currentNodeId: 'west_point' } }, 'wrong_node'],
    ['unknown spot', { command: { nodeId: 'muldraugh' }, context: { currentNodeId: 'muldraugh' } }, 'not_fishing_spot'],
    ['uncleared node', { context: { nodeSecured: false } }, 'node_unsafe'],
    ['active tactical encounter', { context: { activeTactical: true } }, 'tactical_active'],
    ['stopped run', { context: { runPhase: 'game_over' } }, 'run_not_active'],
    ['item id used as rod stack id', { command: { rodStackId: 'fishing_rod' } }, 'rod_missing'],
    ['item id used as tackle stack id', { command: { tackleStackId: 'fishing_tackle' } }, 'tackle_missing'],
  ])('rejects %s with no state or inventory change', (_label, mutation, reason) => {
    const context = baseContext(mutation.context);
    const state = baseState(context);
    const beforeState = snapshot(state);
    const beforeInventory = snapshot(context.inventory);
    const result = resolveFishing(state, command(state, mutation.command), context);

    expect(result).toMatchObject({ ok: false, committed: false, reason });
    expect(result.nextState).toEqual({
      fishing: beforeState,
      inventory: beforeInventory,
      nextItemSequence: context.nextItemSequence,
    });
    expect(state).toEqual(beforeState);
    expect(context.inventory).toEqual(beforeInventory);
  });

  it('rejects stock depletion, daily exhaustion, stale timelines, and output capacity before consumption', () => {
    const miss = findOutcome(false);

    const depleted = snapshot(miss.state);
    depleted.spots.riverside.stock = 0;
    expect(resolveFishing(depleted, command(depleted), miss.context))
      .toMatchObject({ ok: false, reason: 'stock_depleted' });

    const exhausted = snapshot(miss.state);
    exhausted.spots.riverside.attemptsToday = 3;
    expect(resolveFishing(exhausted, command(exhausted), miss.context))
      .toMatchObject({ ok: false, reason: 'daily_limit' });

    const staleTimeline = snapshot(miss.state);
    staleTimeline.lastProcessedMinute -= 1;
    expect(resolveFishing(staleTimeline, command(staleTimeline), miss.context))
      .toMatchObject({ ok: false, reason: 'timeline_mismatch' });

    const usedAfterTackle = 3 + 3 + 2;
    const tightContext = { ...miss.context, capacity: usedAfterTackle };
    expect(previewFishing(miss.state, command(miss.state), tightContext))
      .toMatchObject({ ok: false, reason: 'capacity_exceeded' });
    expect(resolveFishing(miss.state, command(miss.state), tightContext))
      .toMatchObject({ ok: false, reason: 'capacity_exceeded' });
  });

  it('rejects malformed output data, stale revisions, and duplicate commands atomically', () => {
    const context = baseContext();
    const state = baseState(context);
    state.appliedCommandIds = ['already-used'];

    expect(resolveFishing(state, command(state, { expectedRevision: 1 }), context))
      .toMatchObject({ ok: false, reason: 'stale_revision', replayed: false });
    expect(resolveFishing(state, command(state, { commandId: 'already-used' }), context))
      .toMatchObject({ ok: false, reason: 'duplicate_command', replayed: true });
    expect(resolveFishing(state, command(state), {
      ...context,
      catalog: context.catalog.filter((entry) => entry.id !== 'fresh_fish'),
    })).toMatchObject({ ok: false, reason: 'output_missing' });
  });

  it('enforces three attempts per day and keeps only the newest 64 command IDs', () => {
    let context = baseContext({
      inventory: [
        stack('fishing_rod', 'rod:selected'),
        stack('fishing_tackle', 'tackle:selected', 10),
      ],
    });
    let state = baseState(context);
    state.appliedCommandIds = Array.from({ length: 64 }, (_, index) => `old-${index}`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = resolveFishing(state, command(state, { commandId: `new-${attempt}` }), context);
      expect(result.ok).toBe(true);
      state = result.nextState.fishing;
      context = {
        ...context,
        inventory: result.nextState.inventory,
        nextItemSequence: result.nextState.nextItemSequence,
      };
    }
    const fourth = resolveFishing(state, command(state, { commandId: 'new-3' }), context);

    expect(state.spots.riverside.attemptsToday).toBe(3);
    expect(state.appliedCommandIds).toHaveLength(64);
    expect(state.appliedCommandIds[0]).toBe('old-3');
    expect(state.appliedCommandIds.at(-1)).toBe('new-2');
    expect(fourth).toMatchObject({ ok: false, reason: 'daily_limit' });
  });

  it('accepts deeply frozen inputs and returns JSON-safe output without Date or random state', () => {
    const context = deepFreeze(baseContext());
    const state = deepFreeze(baseState(context));
    const request = deepFreeze(command(state));
    const beforeContext = snapshot(context);
    const beforeState = snapshot(state);

    const result = resolveFishing(state, request, context);

    expect(result.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(context).toEqual(beforeContext);
    expect(state).toEqual(beforeState);
  });
});
