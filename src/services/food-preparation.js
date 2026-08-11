import {
  FOOD_FRESHNESS_STATES,
  createItemConditionState,
  normalizeItemConditionState,
} from './item-condition.js';

export const FOOD_PREPARATION_VERSION = 1;

const CONTAINER_IDS = Object.freeze(['carry', 'base']);
const CONTAINER_ID_SET = new Set(CONTAINER_IDS);
const KNIFE_IDS = Object.freeze(['kitchen_knife', 'hunting_knife', 'machete']);
const MAX_COMMAND_LEDGER = 64;
const MAX_REVISION = 1_000_000_000;
const MAX_MINUTES = 1_000_000_000;
const MAX_ITEM_COUNT = 999_999;

function recipe(definition) {
  return Object.freeze({
    ...definition,
    // Stable aliases keep data/UI callers declarative while the resolver uses
    // the skill-adjusted duration calculated from baseMinutes.
    minutes: definition.baseMinutes,
    requiresHeat: Boolean(definition.heatRequired),
    ingredients: Object.freeze(definition.ingredients.map((entry) => Object.freeze({ ...entry }))),
    tools: Object.freeze([...(definition.tools ?? [])]),
    anyTools: Object.freeze([...(definition.anyTools ?? [])]),
  });
}

export const FOOD_PREPARATION_RECIPES = Object.freeze([
  recipe({
    id: 'cook_meat',
    name: '烤熟鲜肉',
    description: '把鲜肉彻底加热，去掉生食惩罚，但成品仍会继续腐败。',
    resultId: 'cooked_meat',
    resultCount: 1,
    ingredients: [{ itemId: 'fresh_meat', count: 1 }],
    tools: ['cooking_pot'],
    minCookingSkill: 0,
    baseMinutes: 45,
    heatRequired: true,
    waterUnits: 0,
    noiseDelta: 4,
    skillXp: 12,
  }),
  recipe({
    id: 'vegetable_soup',
    name: '蔬菜汤',
    description: '用卷心菜和一份干净水煮出两份热汤。',
    resultId: 'vegetable_soup',
    resultCount: 2,
    ingredients: [{ itemId: 'cabbage', count: 1 }],
    tools: ['cooking_pot'],
    minCookingSkill: 0,
    baseMinutes: 60,
    heatRequired: true,
    waterUnits: 1,
    noiseDelta: 5,
    skillXp: 16,
  }),
  recipe({
    id: 'meat_stew',
    name: '肉菜炖锅',
    description: '把肉、蔬菜和水做成三份耐饥的炖锅。',
    resultId: 'meat_stew',
    resultCount: 3,
    ingredients: [{ itemId: 'fresh_meat', count: 1 }, { itemId: 'cabbage', count: 1 }],
    tools: ['cooking_pot'],
    minCookingSkill: 2,
    baseMinutes: 90,
    heatRequired: true,
    waterUnits: 1,
    noiseDelta: 7,
    skillXp: 26,
  }),
  recipe({
    id: 'fruit_salad',
    name: '水果拼盘',
    description: '用任一刀具处理水果，不需要电力，但成品保质期更短。',
    resultId: 'fruit_salad',
    resultCount: 2,
    ingredients: [{ itemId: 'apple', count: 1 }, { itemId: 'wild_berries', count: 1 }],
    anyTools: KNIFE_IDS,
    minCookingSkill: 0,
    baseMinutes: 20,
    heatRequired: false,
    waterUnits: 0,
    noiseDelta: 1,
    skillXp: 9,
  }),
  recipe({
    id: 'heat_canned_soup',
    name: '加热罐装汤',
    description: '把罐装汤加热成一份更能安抚情绪的热食。',
    resultId: 'heated_canned_soup',
    resultCount: 1,
    ingredients: [{ itemId: 'canned_soup', count: 1 }],
    tools: ['cooking_pot'],
    minCookingSkill: 0,
    baseMinutes: 25,
    heatRequired: true,
    waterUnits: 0,
    noiseDelta: 3,
    skillXp: 7,
  }),
]);

/**
 * Builds UI-ready recipe options without mutating or owning simulation state.
 * Suggested selections are exact stack references and prefer the oldest safe
 * ingredient lots so food near spoilage is used before fresh stock.
 */
export function listFoodPreparationOptions(context = {}) {
  const state = normalizeContext(context);
  return FOOD_PREPARATION_RECIPES.map((definition) => {
    const suggestion = suggestIngredientSelections(state, definition);
    const minutes = durationForRecipe(definition, state.cookingSkill);
    if (!suggestion.ok) {
      return optionSummary(definition, {
        enabled: false,
        disabledReason: suggestion.reason,
        minutes,
        suggestedIngredientSelections: suggestion.selections,
      });
    }
    const evaluation = evaluatePreparation(state, {
      recipeId: definition.id,
      ingredientSelections: suggestion.selections,
      destinationId: 'base',
      expectedRevision: state.revision,
      commandId: `food-option:${definition.id}:${state.revision}`,
    }, { validateCommand: false, commit: false });
    return optionSummary(definition, {
      enabled: evaluation.ok,
      disabledReason: evaluation.ok ? '' : evaluation.reason,
      minutes,
      suggestedIngredientSelections: suggestion.selections,
      waterSource: evaluation.waterSource ?? waterSourceFor(state, definition).source,
      resultCount: definition.resultCount,
    });
  });
}

/**
 * Returns the exact projected transaction while leaving revision and command
 * ledger unchanged. The same request passed to resolveFoodPreparation yields
 * the same item identity and material projection.
 */
export function previewFoodPreparation(context = {}, request = {}) {
  return evaluatePreparation(normalizeContext(context), request, {
    validateCommand: true,
    commit: false,
  });
}

/**
 * Resolves one optimistic-concurrency command. All failures return a complete
 * zero-change nextState; successes atomically commit both containers, water,
 * item sequence, revision, and a bounded replay ledger.
 */
export function resolveFoodPreparation(context = {}, command = {}) {
  return evaluatePreparation(normalizeContext(context), command, {
    validateCommand: true,
    commit: true,
  });
}

function evaluatePreparation(state, rawCommand, { validateCommand, commit }) {
  const command = isRecord(rawCommand) ? rawCommand : {};
  const baseState = transactionState(state);
  let commandId = '';
  if (validateCommand) {
    const validation = validateMutationCommand(state, command);
    if (!validation.ok) return failure(validation.reason, baseState, validation.replayed);
    commandId = validation.commandId;
  }

  const definition = FOOD_PREPARATION_RECIPES.find((entry) => entry.id === normalizeId(command.recipeId));
  if (!definition) return failure('unknown_recipe', baseState);
  const destinationId = normalizeId(command.destinationId);
  if (!CONTAINER_ID_SET.has(destinationId)) return failure('invalid_destination', baseState);
  const resultCatalogItem = state.catalogById.get(definition.resultId);
  if (!resultCatalogItem || resultCatalogItem.category !== 'food') return failure('output_missing', baseState);

  const minutes = durationForRecipe(definition, state.cookingSkill);
  if (state.cookingSkill < definition.minCookingSkill) {
    return failure('skill_too_low', baseState, false, { minutes });
  }
  if (!hasRequiredTools(state, definition)) {
    return failure('tool_missing', baseState, false, { minutes });
  }
  if (definition.heatRequired && state.powerAvailableMinutes < minutes) {
    return failure('power_unavailable', baseState, false, { minutes });
  }
  const water = waterSourceFor(state, definition);
  if (!water.ok) return failure('water_unavailable', baseState, false, { minutes });

  const selection = resolveIngredientSelections(state, definition, command.ingredientSelections);
  if (!selection.ok) return failure(selection.reason, baseState, false, { minutes });

  const projectedContainers = cloneJson(state.containers);
  for (const selected of selection.selections) {
    const entries = projectedContainers[selected.containerId];
    const entry = entries.find((item) => item.stackId === selected.stackId);
    if (!entry || positiveInteger(entry.count) < selected.count) {
      return failure('stack_missing', baseState, false, { minutes });
    }
    entry.count -= selected.count;
  }
  CONTAINER_IDS.forEach((containerId) => {
    projectedContainers[containerId] = projectedContainers[containerId].filter((entry) => positiveInteger(entry.count) > 0);
  });

  const preparedStack = createPreparedStack({
    state,
    definition,
    resultCatalogItem,
    selectedIngredients: selection.selectedIngredients,
    projectedContainers,
  });
  projectedContainers[destinationId].push(preparedStack);
  if (usedSpace(projectedContainers[destinationId]) > state.capacities[destinationId]) {
    return failure('capacity_exceeded', baseState, false, { minutes });
  }

  const nextState = {
    containers: projectedContainers,
    baseWaterReserve: Math.max(0, state.baseWaterReserve - water.reserveCost),
    revision: commit ? Math.min(MAX_REVISION, state.revision + 1) : state.revision,
    appliedCommandIds: commit ? appendCommandId(state.appliedCommandIds, commandId) : [...state.appliedCommandIds],
    nextItemSequence: Math.min(MAX_REVISION, state.nextItemSequence + definition.resultCount),
  };
  return {
    ok: true,
    reason: null,
    replayed: false,
    recipeId: definition.id,
    resultId: definition.resultId,
    resultCount: definition.resultCount,
    destinationId,
    minutes,
    noiseDelta: definition.noiseDelta,
    skillXp: definition.skillXp,
    heatRequired: definition.heatRequired,
    waterSource: water.source,
    waterUnits: definition.waterUnits,
    consumedIngredients: selection.selections.map((entry) => ({ ...entry })),
    preparedStack: cloneJson(preparedStack),
    nextState,
  };
}

function normalizeContext(rawContext) {
  const context = isRecord(rawContext) ? rawContext : {};
  const catalog = Array.isArray(context.catalog)
    ? context.catalog.filter((entry) => isRecord(entry) && normalizeId(entry.id)).map(cloneJson)
    : [];
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const rawContainers = isRecord(context.containers) ? context.containers : {};
  const containers = Object.fromEntries(CONTAINER_IDS.map((containerId) => [
    containerId,
    Array.isArray(rawContainers[containerId])
      ? rawContainers[containerId].filter(isRecord).map(cloneJson)
      : [],
  ]));
  const rawCapacities = isRecord(context.capacities) ? context.capacities : {};
  return {
    catalog,
    catalogById,
    containers,
    capacities: Object.fromEntries(CONTAINER_IDS.map((containerId) => [
      containerId,
      boundedNumber(rawCapacities[containerId], 0, 100_000, 0),
    ])),
    cookingSkill: boundedInteger(context.cookingSkill, 0, 10, 0),
    nowMinutes: boundedInteger(context.nowMinutes, 0, MAX_MINUTES, 0),
    powerAvailableMinutes: boundedInteger(context.powerAvailableMinutes, 0, MAX_MINUTES, 0),
    municipalWaterOn: Boolean(context.municipalWaterOn),
    baseWaterReserve: boundedInteger(context.baseWaterReserve, 0, 1_000_000, 0),
    revision: boundedInteger(context.revision, 0, MAX_REVISION, 0),
    appliedCommandIds: normalizeCommandLedger(context.appliedCommandIds),
    nextItemSequence: boundedInteger(context.nextItemSequence, 1, MAX_REVISION, 1),
  };
}

function validateMutationCommand(state, command) {
  if (!isRecord(command)) return { ok: false, reason: 'invalid_command', replayed: false };
  const commandId = normalizeRuntimeId(command.commandId);
  if (!commandId || !Number.isInteger(command.expectedRevision)) {
    return { ok: false, reason: 'invalid_command', replayed: false };
  }
  if (state.appliedCommandIds.includes(commandId)) {
    return { ok: false, reason: 'duplicate_command', replayed: true, commandId };
  }
  if (command.expectedRevision !== state.revision) {
    return { ok: false, reason: 'stale_revision', replayed: false, commandId };
  }
  return { ok: true, reason: null, replayed: false, commandId };
}

function resolveIngredientSelections(state, definition, rawSelections) {
  if (!Array.isArray(rawSelections) || !rawSelections.length) {
    return { ok: false, reason: 'ingredient_mismatch', selections: [], selectedIngredients: [] };
  }
  const aggregated = new Map();
  for (const raw of rawSelections) {
    if (!isRecord(raw)) return { ok: false, reason: 'invalid_selection' };
    const containerId = normalizeId(raw.containerId);
    const stackId = normalizeRuntimeId(raw.stackId);
    const count = positiveInteger(raw.count);
    if (!CONTAINER_ID_SET.has(containerId) || !stackId || !count) {
      return { ok: false, reason: 'invalid_selection' };
    }
    const key = `${containerId}\u0000${stackId}`;
    const existing = aggregated.get(key);
    if (existing) existing.count = Math.min(MAX_ITEM_COUNT, existing.count + count);
    else aggregated.set(key, { containerId, stackId, count });
  }

  const selections = [...aggregated.values()];
  const selectedIngredients = [];
  const selectedCounts = new Map();
  for (const selected of selections) {
    const entry = state.containers[selected.containerId].find((item) => item.stackId === selected.stackId);
    if (!entry || positiveInteger(entry.count) < selected.count) return { ok: false, reason: 'stack_missing' };
    const catalogItem = state.catalogById.get(entry.id);
    if (!catalogItem) return { ok: false, reason: 'stack_missing' };
    selectedCounts.set(entry.id, (selectedCounts.get(entry.id) ?? 0) + selected.count);
    const conditionState = normalizeItemConditionState(entry.conditionState ?? entry, catalogItem);
    selectedIngredients.push({
      ...selected,
      itemId: entry.id,
      conditionState,
    });
  }

  const requiredCounts = new Map(definition.ingredients.map((entry) => [entry.itemId, entry.count]));
  if (selectedCounts.size !== requiredCounts.size) return { ok: false, reason: 'ingredient_mismatch' };
  for (const [itemId, count] of requiredCounts) {
    if (selectedCounts.get(itemId) !== count) return { ok: false, reason: 'ingredient_mismatch' };
  }
  if (selectedIngredients.some((entry) => entry.conditionState?.freshness?.state === FOOD_FRESHNESS_STATES.ROTTEN)) {
    return { ok: false, reason: 'ingredient_rotten' };
  }
  return { ok: true, reason: null, selections, selectedIngredients };
}

function suggestIngredientSelections(state, definition) {
  const selections = [];
  for (const requirement of definition.ingredients) {
    let remaining = requirement.count;
    const candidates = CONTAINER_IDS.flatMap((containerId) => state.containers[containerId]
      .map((entry, index) => ({ containerId, entry, index })))
      .filter(({ entry }) => entry.id === requirement.itemId && positiveInteger(entry.count) > 0)
      .map((candidate) => ({ ...candidate, freshness: freshnessProfile(state, candidate.entry) }))
      .sort(compareIngredientCandidates);
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const count = Math.min(remaining, positiveInteger(candidate.entry.count));
      selections.push({ containerId: candidate.containerId, stackId: candidate.entry.stackId, count });
      remaining -= count;
    }
    if (remaining > 0) return { ok: false, reason: 'ingredient_missing', selections };
  }
  return { ok: true, reason: null, selections };
}

function compareIngredientCandidates(left, right) {
  const leftRotten = left.freshness.state === FOOD_FRESHNESS_STATES.ROTTEN;
  const rightRotten = right.freshness.state === FOOD_FRESHNESS_STATES.ROTTEN;
  if (leftRotten !== rightRotten) return leftRotten ? 1 : -1;
  if (left.freshness.progress !== right.freshness.progress) return right.freshness.progress - left.freshness.progress;
  const containerDelta = CONTAINER_IDS.indexOf(left.containerId) - CONTAINER_IDS.indexOf(right.containerId);
  if (containerDelta) return containerDelta;
  return left.index - right.index;
}

function freshnessProfile(state, entry) {
  const catalogItem = state.catalogById.get(entry.id) ?? entry;
  const conditionState = normalizeItemConditionState(entry.conditionState ?? entry, catalogItem);
  const freshness = conditionState.freshness;
  if (!freshness?.perishable || !(freshness.rottenAfterMinutes > 0)) {
    return { state: FOOD_FRESHNESS_STATES.FRESH, progress: 0, ageMinutes: freshness?.ageMinutes ?? 0 };
  }
  return {
    state: freshness.state,
    progress: clamp(freshness.spoilageMinutes / freshness.rottenAfterMinutes, 0, 1),
    ageMinutes: Math.max(0, Number(freshness.ageMinutes) || 0),
  };
}

function createPreparedStack({ state, definition, resultCatalogItem, selectedIngredients, projectedContainers }) {
  const sourceProfiles = selectedIngredients.map((entry) => {
    const freshness = entry.conditionState?.freshness;
    if (!freshness?.perishable || !(freshness.rottenAfterMinutes > 0)) {
      return { progress: 0, ageMinutes: freshness?.ageMinutes ?? 0, stale: false };
    }
    return {
      progress: clamp(freshness.spoilageMinutes / freshness.rottenAfterMinutes, 0, 1),
      ageMinutes: Math.max(0, Number(freshness.ageMinutes) || 0),
      stale: freshness.state === FOOD_FRESHNESS_STATES.STALE,
    };
  });
  const worstProgress = sourceProfiles.reduce((maximum, entry) => Math.max(maximum, entry.progress), 0);
  const oldestAge = sourceProfiles.reduce((maximum, entry) => Math.max(maximum, entry.ageMinutes), 0);
  const anyStale = sourceProfiles.some((entry) => entry.stale);
  const initial = createItemConditionState(resultCatalogItem, {
    acquiredMinutes: state.nowMinutes,
    acquisitionSequence: state.nextItemSequence,
    sourceId: `food-preparation:${definition.id}`,
  });
  let conditionState = initial;
  if (initial.freshness?.perishable) {
    const rottenAfter = initial.freshness.rottenAfterMinutes;
    const inheritedSpoilage = Math.ceil(worstProgress * rottenAfter);
    const spoilageMinutes = Math.max(
      inheritedSpoilage,
      anyStale ? initial.freshness.freshForMinutes : 0,
    );
    conditionState = createItemConditionState(resultCatalogItem, {
      ...initial,
      freshness: {
        ...initial.freshness,
        ageMinutes: oldestAge,
        spoilageMinutes,
      },
    });
  }
  const usedIds = new Set(CONTAINER_IDS.flatMap((containerId) => projectedContainers[containerId]
    .map((entry) => normalizeRuntimeId(entry.stackId)).filter(Boolean)));
  const stackId = uniqueRuntimeId(conditionState.stackId, usedIds);
  return {
    ...cloneJson(resultCatalogItem),
    count: definition.resultCount,
    stackId,
    conditionState: {
      ...cloneJson(conditionState),
      instanceId: stackId,
      stackId,
    },
  };
}

function hasRequiredTools(state, definition) {
  const available = new Set(CONTAINER_IDS.flatMap((containerId) => state.containers[containerId]
    .filter((entry) => positiveInteger(entry.count) > 0)
    .map((entry) => entry.id)));
  if (definition.tools.some((id) => !available.has(id))) return false;
  if (definition.anyTools.length && !definition.anyTools.some((id) => available.has(id))) return false;
  return true;
}

function waterSourceFor(state, definition) {
  if (definition.waterUnits <= 0) return { ok: true, source: 'none', reserveCost: 0 };
  if (state.municipalWaterOn) return { ok: true, source: 'municipal', reserveCost: 0 };
  if (state.baseWaterReserve >= definition.waterUnits) {
    return { ok: true, source: 'reserve', reserveCost: definition.waterUnits };
  }
  return { ok: false, source: 'none', reserveCost: 0 };
}

function durationForRecipe(definition, cookingSkill) {
  const reduction = Math.min(0.25, boundedInteger(cookingSkill, 0, 10, 0) * 0.025);
  return Math.max(10, Math.round(definition.baseMinutes * (1 - reduction)));
}

function optionSummary(definition, values) {
  return {
    ...cloneJson(definition),
    enabled: Boolean(values.enabled),
    disabledReason: values.disabledReason || '',
    minutes: values.minutes,
    noiseDelta: definition.noiseDelta,
    skillXp: definition.skillXp,
    waterSource: values.waterSource ?? 'none',
    resultCount: values.resultCount ?? definition.resultCount,
    suggestedIngredientSelections: cloneJson(values.suggestedIngredientSelections ?? []),
  };
}

function transactionState(state) {
  return {
    containers: cloneJson(state.containers),
    baseWaterReserve: state.baseWaterReserve,
    revision: state.revision,
    appliedCommandIds: [...state.appliedCommandIds],
    nextItemSequence: state.nextItemSequence,
  };
}

function failure(reason, nextState, replayed = false, details = {}) {
  return {
    ok: false,
    reason,
    replayed,
    ...details,
    nextState: cloneJson(nextState),
  };
}

function appendCommandId(ledger, commandId) {
  return [...ledger, commandId].slice(-MAX_COMMAND_LEDGER);
}

function normalizeCommandLedger(rawLedger) {
  if (!Array.isArray(rawLedger)) return [];
  const seen = new Set();
  const normalized = [];
  rawLedger.forEach((rawId) => {
    const id = normalizeRuntimeId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalized.push(id);
  });
  return normalized.slice(-MAX_COMMAND_LEDGER);
}

function usedSpace(inventory) {
  return (Array.isArray(inventory) ? inventory : []).reduce((sum, entry) => (
    sum + positiveInteger(entry.count) * boundedNumber(entry.space, 0, 100_000, 0)
  ), 0);
}

function uniqueRuntimeId(rawId, usedIds) {
  const base = normalizeRuntimeId(rawId) || 'prepared-food';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeRuntimeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(MAX_ITEM_COUNT, Math.floor(number)));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
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
