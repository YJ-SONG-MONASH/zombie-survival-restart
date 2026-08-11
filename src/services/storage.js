import { normalizeItemConditionState } from './item-condition.js';

export const STORAGE_CONTAINERS = Object.freeze({
  CARRY: 'carry',
  BASE: 'base',
  TRUNK: 'trunk',
});

export const STORAGE_CONTAINER_IDS = Object.freeze(Object.values(STORAGE_CONTAINERS));
export const CARRY_BASE_CAPACITY = 14;

const MAX_SKILL_LEVEL = 10;
const MAX_ITEM_COUNT = 999;
const MAX_CAPACITY = 100_000;

/**
 * Canonicalizes save inventory entries without collapsing condition or
 * freshness lots. The result is deterministic for the same ordered input.
 * Weapons and wearable bags are always represented as individual count-1 instances.
 */
export function normalizeStorageInventory(rawInventory, catalog, {
  containerId = STORAGE_CONTAINERS.CARRY,
} = {}) {
  if (!Array.isArray(rawInventory)) return [];
  const catalogIndex = createCatalogIndex(catalog);
  const normalizedContainerId = isContainerId(containerId) ? containerId : STORAGE_CONTAINERS.CARRY;
  const result = [];
  const usedStackIds = new Set();

  rawInventory.forEach((rawEntry, entryIndex) => {
    if (!isRecord(rawEntry)) return;
    const catalogItem = findCatalogItem(catalogIndex, rawEntry);
    if (!catalogItem) return;
    const count = positiveInteger(rawEntry.count);
    if (!count) return;

    const rawConditionState = conditionStateFromEntry(rawEntry);
    const conditionState = normalizeItemConditionState(rawConditionState ?? rawEntry, catalogItem);
    const explicitStackId = normalizeRuntimeId(rawEntry.stackId)
      || normalizeRuntimeId(rawConditionState?.stackId);
    const batchFingerprint = hash32(stableStringify({
      itemId: catalogItem.id,
      condition: conditionState.condition,
      freshness: conditionState.freshness,
    })).toString(36);
    const generatedStackId = `${normalizedContainerId}:${catalogItem.id}:${batchFingerprint}`;
    const isWeapon = itemIsWeapon(catalogItem, conditionState);
    const isIndividualEquipment = isWeapon || itemIsBag(catalogItem);
    const record = catalogRecord(catalogItem);

    if (isIndividualEquipment) {
      const repairCount = boundedInteger(rawEntry.repairCount, 0, 50, 0);
      for (let unitIndex = 0; unitIndex < count; unitIndex += 1) {
        const baseStackId = explicitStackId || generatedStackId;
        const candidate = count === 1 && unitIndex === 0
          ? baseStackId
          : `${baseStackId}~${entryIndex + 1}-${unitIndex + 1}`;
        const stackId = uniqueStackId(candidate, usedStackIds);
        result.push({
          ...record,
          count: 1,
          ...(isWeapon ? { repairCount } : {}),
          stackId,
          conditionState: withRuntimeIdentity(conditionState, stackId),
        });
      }
      return;
    }

    const mergeTarget = result.find((entry) => (
      entry.id === catalogItem.id
      && !itemIsWeapon(entry, entry.conditionState)
      && !itemIsBag(entry)
      && sameConditionBatch(entry.conditionState, conditionState)
    ));
    if (mergeTarget) {
      mergeTarget.count = safeCountSum(mergeTarget.count, count);
      return;
    }

    const stackId = uniqueStackId(explicitStackId || generatedStackId, usedStackIds);
    result.push({
      ...record,
      count,
      stackId,
      conditionState: withRuntimeIdentity(conditionState, stackId),
    });
  });

  return result;
}

export function storageUsedSpace(inventory) {
  if (!Array.isArray(inventory)) return 0;
  const total = inventory.reduce((sum, entry) => {
    if (!isRecord(entry)) return sum;
    const count = positiveInteger(entry.count);
    const space = boundedNumber(entry.space, 0, MAX_CAPACITY, 0);
    return sum + count * space;
  }, 0);
  return roundSpace(total);
}

/**
 * Carrying capacity is deliberately independent from safehouse storage.
 * Strength below 5 costs one point per level; levels above 5 add two.
 * Traits affect the survivor's body capacity, then one equipped bag is added.
 */
export function carryStorageCapacity({
  skills = {},
  selectedTraits = [],
  traits = selectedTraits,
  inventory = [],
  equippedBagStackId = null,
  baseCapacity = CARRY_BASE_CAPACITY,
} = {}) {
  const strength = boundedInteger(skills?.strength, 0, MAX_SKILL_LEVEL, 5);
  const strengthAdjustment = strength > 5 ? (strength - 5) * 2 : strength - 5;
  const rawBodyCapacity = Math.max(6, boundedInteger(baseCapacity, 1, MAX_CAPACITY, CARRY_BASE_CAPACITY)
    + strengthAdjustment);
  const traitIds = new Set((Array.isArray(traits) ? traits : [])
    .map((trait) => typeof trait === 'string' ? trait : trait?.id)
    .filter((id) => typeof id === 'string'));
  const traitMultiplier = traitIds.has('organized')
    ? 1.3
    : traitIds.has('disorganized') ? 0.7 : 1;
  const bodyCapacity = Math.max(6, Math.floor(rawBodyCapacity * traitMultiplier));
  const equippedBag = Array.isArray(inventory)
    ? inventory.find((entry) => entry?.stackId === equippedBagStackId && positiveInteger(entry?.count) > 0)
    : null;
  const bagBonus = equippedBag && itemIsBag(equippedBag)
    ? boundedInteger(equippedBag.effects?.capacity, 0, MAX_CAPACITY, 0)
    : 0;
  return Math.min(MAX_CAPACITY, bodyCapacity + bagBonus);
}

export function baseStorageCapacity(shelter) {
  return boundedInteger(shelter?.space, 0, MAX_CAPACITY, 0);
}

/**
 * Trunk space is the full-condition rating. Damage scales it down, but a
 * present vehicle never loses more than half of that rating to condition.
 */
export function trunkStorageCapacity(vehicle) {
  if (!isRecord(vehicle) || vehicle.status === 'none') return 0;
  const trunkSpace = boundedInteger(vehicle.trunkSpace, 0, MAX_CAPACITY, 0);
  if (!trunkSpace) return 0;
  const condition = boundedNumber(vehicle.condition, 0, 100, 100);
  return Math.floor(trunkSpace * Math.max(0.5, condition / 100));
}

export function storageCapacities(context = {}, containers = context.containers) {
  const safeContainers = containerArrays(containers);
  return {
    carry: carryStorageCapacity({
      skills: context.skills,
      selectedTraits: context.selectedTraits,
      traits: context.traits,
      inventory: safeContainers.carry,
      equippedBagStackId: context.equippedBagStackId,
      baseCapacity: context.carryBaseCapacity,
    }),
    base: baseStorageCapacity(context.shelter),
    trunk: trunkStorageCapacity(context.vehicle),
  };
}

/**
 * Validates a transfer and reports its projected capacity/space result. It
 * never returns mutable projected container data, so it is safe for UI hints.
 */
export function previewStorageTransfer(context, request) {
  const result = evaluateTransfer(context, request);
  if (!result.ok) return result;
  const { containers: _containers, ...preview } = result;
  return preview;
}

/**
 * Projects an atomic transfer. On failure, no container projection is
 * returned; callers can only commit the arrays present on an `ok` result.
 */
export function projectStorageTransfer(context, request) {
  return evaluateTransfer(context, request);
}

function evaluateTransfer(context, request) {
  if (!isRecord(context) || !isRecord(request)) return failure('invalid_request');
  const { from, to, stackId } = request;
  if (!isContainerId(from) || !isContainerId(to)) return failure('invalid_container');
  if (from === to) return failure('same_container');
  if (!Number.isInteger(request.count) || request.count <= 0) return failure('invalid_count');
  const access = {
    carry: true,
    base: context.access?.base === true,
    trunk: context.access?.trunk === true,
  };
  if (!access[from]) return failure('inaccessible_source', { from, to });
  if (!access[to]) return failure('inaccessible_destination', { from, to });
  const normalizedStackId = normalizeRuntimeId(stackId);
  if (!normalizedStackId) return failure('source_stack_missing', { from, to });

  const containers = cloneContainers(context.containers);
  const sourceIndex = containers[from].findIndex((entry) => entry?.stackId === normalizedStackId);
  if (sourceIndex < 0) return failure('source_stack_missing', { from, to, stackId: normalizedStackId });
  const sourceEntry = containers[from][sourceIndex];
  const sourceCount = positiveInteger(sourceEntry.count);
  if (request.count > sourceCount) {
    return failure('insufficient_quantity', {
      from,
      to,
      stackId: normalizedStackId,
      available: sourceCount,
      requested: request.count,
    });
  }

  const movingEntireStack = request.count === sourceCount;
  const movedEntry = cloneJson(sourceEntry);
  movedEntry.count = request.count;
  if (movingEntireStack) containers[from].splice(sourceIndex, 1);
  else containers[from][sourceIndex].count = sourceCount - request.count;

  const destinationMerge = !itemIsWeapon(movedEntry, movedEntry.conditionState) && !itemIsBag(movedEntry)
    ? containers[to].find((entry) => (
      entry?.id === movedEntry.id
      && !itemIsWeapon(entry, entry.conditionState)
      && !itemIsBag(entry)
      && sameConditionBatch(entry.conditionState, movedEntry.conditionState)
    ))
    : null;
  if (destinationMerge) {
    destinationMerge.count = safeCountSum(destinationMerge.count, request.count);
  } else {
    const destinationIds = new Set(containers[to].map((entry) => entry?.stackId).filter(Boolean));
    const nextStackId = movingEntireStack
      ? uniqueStackId(normalizedStackId, destinationIds)
      : uniqueStackId(`${normalizedStackId}>${to}`, destinationIds);
    movedEntry.stackId = nextStackId;
    movedEntry.conditionState = withRuntimeIdentity(movedEntry.conditionState, nextStackId);
    containers[to].push(movedEntry);
  }

  const movedEquippedBag = from === STORAGE_CONTAINERS.CARRY
    && normalizedStackId === context.equippedBagStackId
    && movingEntireStack;
  const nextEquippedBagStackId = movedEquippedBag ? null : context.equippedBagStackId ?? null;
  const projectedContext = {
    ...context,
    containers,
    equippedBagStackId: nextEquippedBagStackId,
  };
  const capacities = storageCapacities(projectedContext, containers);
  const usedSpace = Object.fromEntries(STORAGE_CONTAINER_IDS.map((id) => [id, storageUsedSpace(containers[id])]));

  if (movedEquippedBag && usedSpace.carry > capacities.carry) {
    return failure('equipped_bag_required', {
      from,
      to,
      stackId: normalizedStackId,
      usedSpace,
      capacities,
    });
  }
  if (usedSpace[to] > capacities[to]) {
    return failure('destination_over_capacity', {
      from,
      to,
      stackId: normalizedStackId,
      usedSpace,
      capacities,
    });
  }

  return {
    ok: true,
    reason: null,
    from,
    to,
    stackId: normalizedStackId,
    itemId: sourceEntry.id,
    count: request.count,
    nextEquippedBagStackId,
    usedSpace,
    capacities,
    containers,
  };
}

function failure(reason, details = {}) {
  return { ok: false, reason, ...details };
}

function createCatalogIndex(catalog) {
  const items = Array.isArray(catalog)
    ? catalog
    : isRecord(catalog) ? Object.values(catalog) : [];
  const byId = new Map();
  const byName = new Map();
  items.forEach((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return;
    byId.set(item.id, item);
    if (typeof item.name === 'string' && item.name) byName.set(item.name, item);
  });
  return { byId, byName };
}

function findCatalogItem(index, entry) {
  return index.byId.get(entry.id) ?? index.byName.get(entry.name) ?? null;
}

function catalogRecord(catalogItem) {
  return cloneJson(catalogItem);
}

function conditionStateFromEntry(entry) {
  if (isRecord(entry.conditionState)) return entry.conditionState;
  if (isRecord(entry.itemState)) return entry.itemState;
  return null;
}

function sameConditionBatch(left, right) {
  const first = isRecord(left) ? left : {};
  const second = isRecord(right) ? right : {};
  return first.itemId === second.itemId
    && stableStringify(first.condition ?? null) === stableStringify(second.condition ?? null)
    && stableStringify(first.freshness ?? null) === stableStringify(second.freshness ?? null);
}

function itemIsWeapon(item, conditionState) {
  return conditionState?.condition != null
    || item?.category === 'weapon'
    || (Array.isArray(item?.tags) && item.tags.includes('weapon'));
}

function itemIsBag(item) {
  return item?.category === 'bag'
    || (Array.isArray(item?.tags) && item.tags.includes('bag'));
}

function withRuntimeIdentity(conditionState, stackId) {
  const next = cloneJson(conditionState);
  next.instanceId = stackId;
  next.stackId = stackId;
  return next;
}

function cloneContainers(containers) {
  const safe = containerArrays(containers);
  return Object.fromEntries(STORAGE_CONTAINER_IDS.map((id) => [id, cloneJson(safe[id])]));
}

function containerArrays(containers) {
  const source = isRecord(containers) ? containers : {};
  return Object.fromEntries(STORAGE_CONTAINER_IDS.map((id) => [id, Array.isArray(source[id]) ? source[id] : []]));
}

function uniqueStackId(rawCandidate, usedIds) {
  const base = normalizeRuntimeId(rawCandidate) || 'stack';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeRuntimeId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9:_>.~-]/g, '-').slice(0, 160);
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return 0;
  return Math.min(MAX_ITEM_COUNT, number);
}

function safeCountSum(left, right) {
  return Math.min(MAX_ITEM_COUNT, positiveInteger(left) + positiveInteger(right));
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function roundSpace(value) {
  return Math.round(value * 1000) / 1000;
}

function isContainerId(value) {
  return STORAGE_CONTAINER_IDS.includes(value);
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash32(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
