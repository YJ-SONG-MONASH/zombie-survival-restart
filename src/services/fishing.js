import { createItemConditionState } from './item-condition.js';

export const FISHING_VERSION = 1;
export const MAX_FISHING_ATTEMPTS_PER_DAY = 3;

const MINUTES_PER_DAY = 24 * 60;
const MAX_COMMAND_LEDGER = 64;
const MAX_REVISION = 1_000_000_000;
const MAX_TOTAL_MINUTES = 1_000_000_000;
const MAX_ITEM_COUNT = 999_999;
const FISH_ITEM_ID = 'fresh_fish';
const ROD_ITEM_ID = 'fishing_rod';
const TACKLE_ITEM_ID = 'fishing_tackle';

/**
 * Creates the canonical persisted fishing domain. Spot definitions are the
 * sole authority for legal water nodes; descriptive map text is never parsed.
 */
export function createFishingState(context = {}) {
  const spotDefs = normalizeSpotDefinitions(context.spotDefs);
  const totalMinutes = totalMinutesForContext(context);
  const currentDay = dayForMinute(totalMinutes);
  return {
    version: FISHING_VERSION,
    revision: 0,
    lastProcessedMinute: totalMinutes,
    appliedCommandIds: [],
    spots: Object.fromEntries(spotDefs.map((definition) => [definition.nodeId, {
      stock: definition.stockCap,
      attemptsDay: currentDay,
      attemptsToday: 0,
    }])),
  };
}

/**
 * Normalizes save data without advancing time. Unknown spots are discarded and
 * newly defined spots start full; callers decide whether that is migration or
 * repair before invoking this function.
 */
export function normalizeFishingState(rawState, context = {}) {
  const spotDefs = normalizeSpotDefinitions(context.spotDefs);
  const fallbackMinute = totalMinutesForContext(context);
  if (!isRecord(rawState)) return createFishingState({ spotDefs, totalMinutes: fallbackMinute });

  const lastProcessedMinute = boundedInteger(
    rawState.lastProcessedMinute,
    0,
    MAX_TOTAL_MINUTES,
    fallbackMinute,
  );
  const currentDay = dayForMinute(lastProcessedMinute);
  const rawSpots = isRecord(rawState.spots) ? rawState.spots : {};
  const spots = Object.fromEntries(spotDefs.map((definition) => {
    const saved = isRecord(rawSpots[definition.nodeId]) ? rawSpots[definition.nodeId] : null;
    if (!saved) {
      return [definition.nodeId, {
        stock: definition.stockCap,
        attemptsDay: currentDay,
        attemptsToday: 0,
      }];
    }
    const savedAttemptDay = boundedInteger(saved.attemptsDay, 1, 1_000_000, currentDay);
    const attemptsAreCurrent = savedAttemptDay === currentDay;
    return [definition.nodeId, {
      stock: boundedInteger(saved.stock, 0, definition.stockCap, definition.stockCap),
      attemptsDay: currentDay,
      attemptsToday: attemptsAreCurrent
        ? boundedInteger(saved.attemptsToday, 0, MAX_FISHING_ATTEMPTS_PER_DAY, 0)
        : 0,
    }];
  }));

  return {
    version: FISHING_VERSION,
    revision: boundedInteger(rawState.revision, 0, MAX_REVISION, 0),
    lastProcessedMinute,
    appliedCommandIds: normalizeCommandLedger(rawState.appliedCommandIds),
    spots,
  };
}

/**
 * Advances renewable stock only at absolute midnight boundaries. Revision is
 * incremented once per boundary, which keeps a one-shot advance byte-identical
 * to any segmentation of the same interval.
 */
export function advanceFishingState(rawState, context = {}) {
  const spotDefs = normalizeSpotDefinitions(context.spotDefs);
  const fallbackMinute = isRecord(rawState) && Number.isFinite(Number(rawState.lastProcessedMinute))
    ? boundedInteger(rawState.lastProcessedMinute, 0, MAX_TOTAL_MINUTES, 0)
    : totalMinutesForContext(context);
  const baseState = normalizeFishingState(rawState, { spotDefs, totalMinutes: fallbackMinute });
  const fromTotalMinutes = strictTimelineMinute(context.fromTotalMinutes);
  const toTotalMinutes = strictTimelineMinute(context.toTotalMinutes);

  if (fromTotalMinutes == null || toTotalMinutes == null || toTotalMinutes < fromTotalMinutes) {
    return advanceFailure('invalid_timeline', baseState);
  }
  if (baseState.lastProcessedMinute !== fromTotalMinutes) {
    return advanceFailure('timeline_mismatch', baseState);
  }

  const nextState = cloneJson(baseState);
  const processedBoundaryMinutes = [];
  let boundaryMinute = (Math.floor(fromTotalMinutes / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
  while (boundaryMinute <= toTotalMinutes) {
    const boundaryDay = dayForMinute(boundaryMinute);
    for (const definition of spotDefs) {
      const spot = nextState.spots[definition.nodeId];
      spot.stock = Math.min(definition.stockCap, spot.stock + definition.regenPerDay);
      spot.attemptsDay = boundaryDay;
      spot.attemptsToday = 0;
    }
    nextState.revision = Math.min(MAX_REVISION, nextState.revision + 1);
    processedBoundaryMinutes.push(boundaryMinute);
    boundaryMinute += MINUTES_PER_DAY;
  }
  nextState.lastProcessedMinute = toTotalMinutes;

  return {
    ok: true,
    reason: null,
    fromTotalMinutes,
    toTotalMinutes,
    processedBoundaryMinutes,
    nextState,
  };
}

/** Returns JSON-safe, presentation-ready stock and daily-attempt bands. */
export function summarizeFishing(rawState, context = {}) {
  const spotDefs = normalizeSpotDefinitions(context.spotDefs);
  const nowMinutes = totalMinutesForContext(context);
  const state = normalizeFishingState(rawState, { spotDefs, totalMinutes: nowMinutes });
  return {
    version: FISHING_VERSION,
    revision: state.revision,
    lastProcessedMinute: state.lastProcessedMinute,
    timelineCurrent: state.lastProcessedMinute === nowMinutes,
    maxAttemptsPerDay: MAX_FISHING_ATTEMPTS_PER_DAY,
    spots: spotDefs.map((definition) => {
      const spot = state.spots[definition.nodeId];
      return {
        nodeId: definition.nodeId,
        stock: spot.stock,
        stockCap: definition.stockCap,
        stockBand: stockBandFor(spot.stock, definition.stockCap),
        regenPerDay: definition.regenPerDay,
        baseCatchChance: definition.baseCatchChance,
        attemptsDay: spot.attemptsDay,
        attemptsToday: spot.attemptsToday,
        attemptsRemaining: Math.max(0, MAX_FISHING_ATTEMPTS_PER_DAY - spot.attemptsToday),
      };
    }),
  };
}

/**
 * Validates an exact attempt and reports public odds without exposing the
 * deterministic roll, catch result, output identity, or a mutated projection.
 */
export function previewFishing(rawState, request = {}, context = {}) {
  return evaluateFishing(rawState, request, context, false);
}

/**
 * Resolves one optimistic-concurrency attempt. A successful miss is still a
 * committed attempt: it spends time/tackle and advances the daily counter.
 */
export function resolveFishing(rawState, command = {}, context = {}) {
  return evaluateFishing(rawState, command, context, true);
}

function evaluateFishing(rawState, rawCommand, rawContext, commit) {
  const context = normalizeActionContext(rawContext);
  const state = normalizeFishingState(rawState, {
    spotDefs: context.spotDefs,
    totalMinutes: context.nowMinutes,
  });
  const baseState = transactionState(state, context);
  const command = isRecord(rawCommand) ? rawCommand : {};
  const mutation = validateMutationCommand(state, command);
  if (!mutation.ok) return actionFailure(mutation.reason, baseState, state, mutation);
  const commandId = mutation.commandId;

  if (state.lastProcessedMinute !== context.nowMinutes) {
    return actionFailure('timeline_mismatch', baseState, state, { commandId });
  }
  if (context.runPhase !== 'running') {
    return actionFailure('run_not_active', baseState, state, { commandId });
  }
  if (context.activeTactical) {
    return actionFailure('tactical_active', baseState, state, { commandId });
  }

  const nodeId = normalizeId(command.nodeId);
  const definition = context.spotByNodeId.get(nodeId);
  if (!definition) return actionFailure('not_fishing_spot', baseState, state, { commandId, nodeId });
  if (context.currentNodeId !== nodeId) {
    return actionFailure('wrong_node', baseState, state, { commandId, nodeId });
  }
  if (!context.nodeSecured) {
    return actionFailure('node_unsafe', baseState, state, { commandId, nodeId });
  }
  if (normalizeId(command.destinationId) !== 'carry') {
    return actionFailure('invalid_destination', baseState, state, { commandId, nodeId });
  }

  const spot = state.spots[nodeId];
  if (spot.stock <= 0) {
    return actionFailure('stock_depleted', baseState, state, { commandId, nodeId });
  }
  if (spot.attemptsToday >= MAX_FISHING_ATTEMPTS_PER_DAY) {
    return actionFailure('daily_limit', baseState, state, { commandId, nodeId });
  }
  if (state.revision >= MAX_REVISION) {
    return actionFailure('revision_exhausted', baseState, state, { commandId, nodeId });
  }

  const rodStackId = normalizeRuntimeId(command.rodStackId);
  const tackleStackId = normalizeRuntimeId(command.tackleStackId);
  const rod = exactStack(context.inventory, rodStackId);
  if (!rod || rod.id !== ROD_ITEM_ID || positiveInteger(rod.count) < 1) {
    return actionFailure('rod_missing', baseState, state, { commandId, nodeId });
  }
  const tackle = exactStack(context.inventory, tackleStackId);
  if (!tackle || tackle.id !== TACKLE_ITEM_ID || positiveInteger(tackle.count) < 1) {
    return actionFailure('tackle_missing', baseState, state, { commandId, nodeId });
  }

  const outputCatalogItem = context.catalogById.get(FISH_ITEM_ID);
  if (!outputCatalogItem || outputCatalogItem.category !== 'food') {
    return actionFailure('output_missing', baseState, state, { commandId, nodeId });
  }

  const inventoryAfterTackle = consumeExactStack(context.inventory, tackleStackId);
  if (!inventoryAfterTackle) {
    return actionFailure('tackle_missing', baseState, state, { commandId, nodeId });
  }
  const caughtStack = createCaughtStack({
    outputCatalogItem,
    inventory: inventoryAfterTackle,
    nowMinutes: context.nowMinutes,
    nextItemSequence: context.nextItemSequence,
    nodeId,
    revision: state.revision,
    attemptIndex: spot.attemptsToday,
  });
  if (usedSpace([...inventoryAfterTackle, caughtStack], context.catalogById) > context.capacity) {
    return actionFailure('capacity_exceeded', baseState, state, { commandId, nodeId });
  }

  const minutes = fishingDuration(context.skill);
  const chance = catchChance(definition, context.skill, context.clockMinutes);
  const publicResult = {
    ok: true,
    reason: null,
    replayed: false,
    committed: commit,
    commandId,
    revision: state.revision,
    nodeId,
    minutes,
    chancePercent: Math.round(chance * 100),
    stockBefore: spot.stock,
    stockBand: stockBandFor(spot.stock, definition.stockCap),
    attemptsToday: spot.attemptsToday,
    attemptsRemaining: Math.max(0, MAX_FISHING_ATTEMPTS_PER_DAY - spot.attemptsToday),
    noiseDelta: 4,
    activityDelta: 2,
  };
  if (!commit) return { ...publicResult, nextState: baseState };

  const roll = deterministicUnitInterval([
    context.worldSeed,
    nodeId,
    context.day,
    spot.attemptsToday,
    state.revision,
  ]);
  const caught = roll < chance;
  const nextFishing = cloneJson(state);
  nextFishing.revision += 1;
  nextFishing.appliedCommandIds = appendCommandId(nextFishing.appliedCommandIds, commandId);
  nextFishing.spots[nodeId] = {
    stock: spot.stock - (caught ? 1 : 0),
    attemptsDay: context.day,
    attemptsToday: spot.attemptsToday + 1,
  };
  const nextInventory = caught
    ? [...inventoryAfterTackle, caughtStack]
    : inventoryAfterTackle;
  const nextItemSequence = caught
    ? Math.min(MAX_REVISION, context.nextItemSequence + 1)
    : context.nextItemSequence;
  const stockAfter = nextFishing.spots[nodeId].stock;

  return {
    ...publicResult,
    revision: nextFishing.revision,
    caught,
    catchCount: caught ? 1 : 0,
    consumedTackle: {
      stackId: tackleStackId,
      itemId: TACKLE_ITEM_ID,
      count: 1,
    },
    caughtStack: caught ? cloneJson(caughtStack) : null,
    stockAfter,
    stockBand: stockBandFor(stockAfter, definition.stockCap),
    attemptsToday: nextFishing.spots[nodeId].attemptsToday,
    attemptsRemaining: Math.max(
      0,
      MAX_FISHING_ATTEMPTS_PER_DAY - nextFishing.spots[nodeId].attemptsToday,
    ),
    skillXp: caught ? 16 : 6,
    nextState: {
      fishing: nextFishing,
      inventory: nextInventory,
      nextItemSequence,
    },
  };
}

function normalizeActionContext(rawContext) {
  const context = isRecord(rawContext) ? rawContext : {};
  const spotDefs = normalizeSpotDefinitions(context.spotDefs);
  const catalog = Array.isArray(context.catalog)
    ? context.catalog.filter((entry) => isRecord(entry) && normalizeId(entry.id)).map(cloneJson)
    : [];
  const catalogById = new Map(catalog.map((entry) => [normalizeId(entry.id), entry]));
  const nowMinutes = totalMinutesForContext(context);
  return {
    spotDefs,
    spotByNodeId: new Map(spotDefs.map((definition) => [definition.nodeId, definition])),
    catalog,
    catalogById,
    inventory: Array.isArray(context.inventory)
      ? context.inventory.filter(isRecord).map(cloneJson)
      : [],
    capacity: boundedNumber(context.capacity, 0, 100_000, 0),
    worldSeed: normalizeSeed(context.worldSeed),
    skill: boundedInteger(context.skill, 0, 10, 0),
    nowMinutes,
    day: dayForMinute(nowMinutes),
    clockMinutes: nowMinutes % MINUTES_PER_DAY,
    nextItemSequence: boundedInteger(context.nextItemSequence, 1, MAX_REVISION, 1),
    currentNodeId: normalizeId(context.currentNodeId),
    nodeSecured: context.nodeSecured === true,
    activeTactical: Boolean(context.activeTactical),
    runPhase: normalizeId(context.runPhase) || 'running',
  };
}

function normalizeSpotDefinitions(rawDefinitions) {
  const definitionsByNode = new Map();
  if (Array.isArray(rawDefinitions)) {
    for (const raw of rawDefinitions) {
      if (!isRecord(raw)) continue;
      const nodeId = normalizeId(raw.nodeId);
      if (!nodeId || definitionsByNode.has(nodeId)) continue;
      const stockCap = boundedInteger(raw.stockCap, 1, 1_000, 1);
      definitionsByNode.set(nodeId, {
        nodeId,
        stockCap,
        regenPerDay: boundedInteger(raw.regenPerDay, 0, stockCap, 0),
        baseCatchChance: boundedNumber(raw.baseCatchChance, 0, 1, 0.35),
      });
    }
  }
  return [...definitionsByNode.values()].sort((left, right) => (
    left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
  ));
}

function transactionState(state, context) {
  return {
    fishing: cloneJson(state),
    inventory: cloneJson(context.inventory),
    nextItemSequence: context.nextItemSequence,
  };
}

function validateMutationCommand(state, command) {
  if (!isRecord(command)) return { ok: false, reason: 'invalid_command', replayed: false, commandId: '' };
  const commandId = normalizeRuntimeId(command.commandId);
  if (!commandId || !Number.isInteger(command.expectedRevision)) {
    return { ok: false, reason: 'invalid_command', replayed: false, commandId };
  }
  if (state.appliedCommandIds.includes(commandId)) {
    return { ok: false, reason: 'duplicate_command', replayed: true, commandId };
  }
  if (command.expectedRevision !== state.revision) {
    return { ok: false, reason: 'stale_revision', replayed: false, commandId };
  }
  return { ok: true, reason: null, replayed: false, commandId };
}

function actionFailure(reason, nextState, state, details = {}) {
  return {
    ok: false,
    reason,
    replayed: Boolean(details.replayed),
    committed: false,
    commandId: normalizeRuntimeId(details.commandId),
    revision: state.revision,
    ...(details.nodeId ? { nodeId: details.nodeId } : {}),
    nextState: cloneJson(nextState),
  };
}

function advanceFailure(reason, nextState) {
  return {
    ok: false,
    reason,
    processedBoundaryMinutes: [],
    nextState: cloneJson(nextState),
  };
}

function exactStack(inventory, stackId) {
  if (!stackId) return null;
  const matches = inventory.filter((entry) => normalizeRuntimeId(entry.stackId) === stackId);
  return matches.length === 1 ? matches[0] : null;
}

function consumeExactStack(inventory, stackId) {
  const matches = inventory.reduce((count, entry) => (
    count + (normalizeRuntimeId(entry.stackId) === stackId ? 1 : 0)
  ), 0);
  if (matches !== 1) return null;
  return inventory.flatMap((entry) => {
    if (normalizeRuntimeId(entry.stackId) !== stackId) return [cloneJson(entry)];
    const count = positiveInteger(entry.count);
    if (count <= 0) return [];
    if (count === 1) return [];
    return [{ ...cloneJson(entry), count: count - 1 }];
  });
}

function createCaughtStack({
  outputCatalogItem,
  inventory,
  nowMinutes,
  nextItemSequence,
  nodeId,
  revision,
  attemptIndex,
}) {
  const conditionState = createItemConditionState(outputCatalogItem, {
    acquiredMinutes: nowMinutes,
    acquisitionSequence: nextItemSequence,
    sourceId: `fishing:${nodeId}:${revision}:${attemptIndex}`,
  });
  const usedIds = new Set(inventory.map((entry) => normalizeRuntimeId(entry.stackId)).filter(Boolean));
  const stackId = uniqueRuntimeId(conditionState.stackId, usedIds);
  return {
    ...cloneJson(outputCatalogItem),
    count: 1,
    stackId,
    conditionState: {
      ...cloneJson(conditionState),
      instanceId: stackId,
      stackId,
    },
  };
}

function fishingDuration(skill) {
  return Math.max(75, 120 - boundedInteger(skill, 0, 10, 0) * 5);
}

function catchChance(definition, skill, clockMinutes) {
  const dawnOrDusk = (clockMinutes >= 5 * 60 && clockMinutes < 8 * 60)
    || (clockMinutes >= 17 * 60 && clockMinutes < 20 * 60);
  return clamp(
    definition.baseCatchChance + boundedInteger(skill, 0, 10, 0) * 0.04 + (dawnOrDusk ? 0.1 : 0),
    0.15,
    0.85,
  );
}

function stockBandFor(stock, stockCap) {
  if (stock <= 0) return 'depleted';
  if (stock === 1) return 'scarce';
  if (stock * 2 <= stockCap) return 'fair';
  return 'abundant';
}

function deterministicUnitInterval(parts) {
  return hash32(parts.join('|')) / 0x1_0000_0000;
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function usedSpace(inventory, catalogById) {
  return inventory.reduce((total, entry) => {
    const catalogItem = catalogById.get(normalizeId(entry.id));
    const space = boundedNumber(entry.space ?? catalogItem?.space, 0, 100_000, 0);
    return total + positiveInteger(entry.count) * space;
  }, 0);
}

function appendCommandId(ledger, commandId) {
  return [...ledger, commandId].slice(-MAX_COMMAND_LEDGER);
}

function normalizeCommandLedger(rawLedger) {
  if (!Array.isArray(rawLedger)) return [];
  const seen = new Set();
  const normalized = [];
  for (const rawId of rawLedger) {
    const id = normalizeRuntimeId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized.slice(-MAX_COMMAND_LEDGER);
}

function uniqueRuntimeId(rawId, usedIds) {
  const base = normalizeRuntimeId(rawId) || 'fresh-fish';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function totalMinutesForContext(rawContext) {
  const context = isRecord(rawContext) ? rawContext : {};
  if (Number.isFinite(Number(context.totalMinutes))) {
    return boundedInteger(context.totalMinutes, 0, MAX_TOTAL_MINUTES, 0);
  }
  const day = boundedInteger(context.day, 1, 1_000_000, 1);
  const clockMinutes = boundedInteger(context.clockMinutes, 0, MINUTES_PER_DAY - 1, 0);
  return Math.min(MAX_TOTAL_MINUTES, (day - 1) * MINUTES_PER_DAY + clockMinutes);
}

function dayForMinute(totalMinutes) {
  return Math.floor(totalMinutes / MINUTES_PER_DAY) + 1;
}

function strictTimelineMinute(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return null;
  if (numeric < 0 || numeric > MAX_TOTAL_MINUTES) return null;
  return numeric;
}

function normalizeSeed(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, 240);
  }
  return '0';
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeRuntimeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function positiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(MAX_ITEM_COUNT, Math.floor(numeric)));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function boundedNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
