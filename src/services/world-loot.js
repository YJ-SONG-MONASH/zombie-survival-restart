import {
  canMergeItemConditionStates,
  createItemConditionState,
  normalizeItemConditionState,
} from './item-condition.js';
import { storageUsedSpace } from './storage.js';

export const WORLD_LOOT_VERSION = 1;

export const WORLD_LOOT_SLOT_STATUS = Object.freeze({
  HIDDEN: 'hidden',
  REVEALED: 'revealed',
  CLAIMED: 'claimed',
});

const SLOT_STATUSES = new Set(Object.values(WORLD_LOOT_SLOT_STATUS));
const QUALITY_RANK = Object.freeze({ white: 1, green: 2, blue: 3, purple: 4, gold: 5, red: 6 });
const SLOT_COUNT_BY_QUALITY = Object.freeze({ white: 2, green: 2, blue: 3, purple: 3, gold: 4, red: 4 });
const MAX_REVISION = 1_000_000_000;
const MAX_ITEM_COUNT = 999;
const MAX_CAPACITY = 100_000;
const MAX_WORLD_MINUTES = 1_000_000_000;
const MAX_COMMAND_LEDGER = 64;
const MAX_RUNTIME_ID_LENGTH = 180;

const SEMANTIC_PROFILES = Object.freeze([
  { tokens: ['medical', 'clinic', 'hospital', 'pharmacy', 'medcab', 'medcrate', '急救', '医疗', '药'], categories: ['medical'], tags: ['medical', 'suture'] },
  { tokens: ['gun', 'police', 'checkpoint', 'ammo', '警局', '枪', '弹药'], categories: ['ammo', 'weapon', 'medical'], tags: ['ammo', 'firearm'] },
  { tokens: ['garage', 'locker', 'hardware', 'warehouse', 'tool', 'industrial', '车库', '五金', '仓库', '工具'], categories: ['tool', 'base', 'vehicle'], tags: ['tool', 'repair', 'carpentry', 'mechanics'] },
  { tokens: ['kitchen', 'restaurant', 'store', 'commercial', 'vending', '厨房', '餐馆', '商店', '货架'], categories: ['food', 'drink', 'medical'], tags: ['food', 'water', 'canned'] },
  { tokens: ['farm', 'river', 'camp', 'wild', 'seed', '农', '河', '营地', '种子'], categories: ['survival', 'food', 'tool'], tags: ['farming', 'fishing', 'food'] },
  { tokens: ['gas', 'wreck', 'trunk', 'road', 'vehicle', '加油', '残骸', '后备箱', '公路'], categories: ['vehicle', 'tool', 'food'], tags: ['vehicle', 'fuel', 'mechanics'] },
]);

/**
 * Creates one persistent location container. The caller owns the world-level
 * `searchKey -> container` map; this module owns only serializable rules.
 */
export function createWorldLootContainer(context = {}) {
  const generation = normalizeGenerationContext(context);
  const quality = normalizeQuality(generation.searchable.quality);
  const requestedSlots = SLOT_COUNT_BY_QUALITY[quality];
  const slotCount = Math.min(requestedSlots, generation.catalog.length);
  const selectedIds = new Set();
  const slots = [];

  for (let index = 0; index < slotCount; index += 1) {
    const remaining = generation.catalog.filter((item) => !selectedIds.has(item.id));
    const candidates = remaining.length ? remaining : generation.catalog;
    const item = deterministicCatalogPick(candidates, generation, quality, index);
    if (!item) break;
    selectedIds.add(item.id);
    slots.push(createGeneratedSlot(item, generation, index, WORLD_LOOT_SLOT_STATUS.HIDDEN));
  }

  return {
    version: WORLD_LOOT_VERSION,
    searchKey: generation.searchKey,
    generationId: generation.generationId,
    source: {
      nodeId: normalizeRuntimeId(generation.node.id),
      searchableId: normalizeRuntimeId(generation.searchable.id),
    },
    revision: 0,
    appliedCommandIds: [],
    searchCost: searchCostFor(generation.searchable, generation.node, generation.searchMinutes),
    searchCostPaid: false,
    searchCompletedAtMinutes: null,
    slots,
  };
}

/**
 * Canonicalizes current state plus the v5 setup-loot shapes (`lootSlots` or a
 * direct slot array). Interrupted v5 `searching` slots become hidden; they were
 * never transactionally awarded.
 */
export function normalizeWorldLootContainer(rawState, context = {}) {
  const fallback = createWorldLootContainer(context);
  const legacySlots = Array.isArray(rawState)
    ? rawState
    : isRecord(rawState) && Array.isArray(rawState.lootSlots) ? rawState.lootSlots : null;
  if (legacySlots) return normalizeLegacyContainer(rawState, legacySlots, fallback, context);
  if (!isRecord(rawState)) return fallback;

  const rawSlots = Array.isArray(rawState.slots) ? rawState.slots : [];
  const slots = normalizeSavedSlots(rawSlots, fallback, context);
  const hasProgress = slots.some((slot) => slot.status !== WORLD_LOOT_SLOT_STATUS.HIDDEN);
  const searchCostPaid = rawState.searchCostPaid === true || hasProgress;

  return {
    version: WORLD_LOOT_VERSION,
    searchKey: fallback.searchKey,
    generationId: fallback.generationId,
    source: {
      nodeId: normalizeRuntimeId(rawState.source?.nodeId) || fallback.source.nodeId,
      searchableId: normalizeRuntimeId(rawState.source?.searchableId) || fallback.source.searchableId,
    },
    revision: boundedInteger(rawState.revision, 0, MAX_REVISION, 0),
    appliedCommandIds: normalizeCommandLedger(rawState.appliedCommandIds),
    searchCost: normalizeSearchCost(rawState.searchCost, fallback.searchCost),
    searchCostPaid,
    searchCompletedAtMinutes: searchCostPaid
      ? nullableBoundedInteger(rawState.searchCompletedAtMinutes, 0, MAX_WORLD_MINUTES)
      : null,
    slots,
  };
}

/**
 * Reveals one slot. `revealWorldLootSlots` is the batch form and both share the
 * same command/revision transaction boundary.
 */
export function revealWorldLootSlot(rawState, command = {}, context = {}) {
  return revealWorldLootSlots(rawState, command, context);
}

/**
 * Atomically reveals one or more exact slot IDs. The first successful reveal
 * records the one-off search charge. Later reveals return a zero cost, so a
 * refresh or resumed save cannot charge twice.
 */
export function revealWorldLootSlots(rawState, command = {}, context = {}) {
  const state = normalizeWorldLootContainer(rawState, context);
  const validation = validateMutationCommand(state, command);
  if (!validation.ok) return mutationFailure(validation.reason, state, validation.replayed);

  const slotIds = normalizeRevealSelection(command);
  if (!slotIds) return mutationFailure('invalid_selection', state);
  const slots = slotIds.map((slotId) => state.slots.find((slot) => slot.slotId === slotId));
  if (slots.some((slot) => !slot)) return mutationFailure('slot_missing', state);
  if (slots.some((slot) => slot.status !== WORLD_LOOT_SLOT_STATUS.HIDDEN)) {
    return mutationFailure('slot_not_hidden', state);
  }

  const nextState = cloneJson(state);
  const selected = new Set(slotIds);
  nextState.slots.forEach((slot) => {
    if (selected.has(slot.slotId)) slot.status = WORLD_LOOT_SLOT_STATUS.REVEALED;
  });
  const firstSearch = !state.searchCostPaid;
  nextState.searchCostPaid = true;
  if (firstSearch) {
    nextState.searchCompletedAtMinutes = nullableBoundedInteger(command.completedAtMinutes, 0, MAX_WORLD_MINUTES);
  }
  commitCommand(nextState, validation.commandId);

  const revealedSlots = nextState.slots
    .filter((slot) => selected.has(slot.slotId))
    .map(cloneJson);
  return {
    ok: true,
    reason: null,
    replayed: false,
    cost: firstSearch ? cloneJson(state.searchCost) : zeroSearchCost(),
    revealedSlot: revealedSlots[0],
    revealedSlots,
    nextState,
  };
}

/**
 * Pure, all-or-nothing preview for taking complete source stacks. Selection is
 * by stack ID only; item IDs are intentionally not accepted as aliases.
 */
export function previewWorldLootClaim(rawState, request = {}, context = {}) {
  const state = normalizeWorldLootContainer(rawState, context);
  if (!hasExpectedRevision(request) || request.expectedRevision !== state.revision) {
    return previewFailure(hasExpectedRevision(request) ? 'stale_revision' : 'invalid_request', state);
  }
  const stackIds = normalizeStackSelection(request.stackIds);
  if (!stackIds) return previewFailure('invalid_selection', state);

  const slots = stackIds.map((stackId) => state.slots.find((slot) => slot.item.stackId === stackId));
  if (slots.some((slot) => !slot)) return previewFailure('stack_missing', state);
  if (slots.some((slot) => slot.status !== WORLD_LOOT_SLOT_STATUS.REVEALED)) {
    return previewFailure('stack_not_revealed', state);
  }

  const capacity = normalizeCapacity(context.capacity);
  if (capacity === null) return previewFailure('invalid_capacity', state);
  const catalogIndex = createCatalogIndex(context.catalog);
  let projectedInventory = cloneJson(Array.isArray(context.inventory) ? context.inventory : []);
  const claimedStacks = [];

  for (const slot of slots) {
    const catalogItem = catalogIndex.get(slot.item.id);
    if (!catalogItem) return previewFailure('catalog_item_missing', state);
    const addition = projectExactStackAddition(projectedInventory, slot.item, catalogItem);
    if (!addition.ok) return previewFailure(addition.reason, state);
    projectedInventory = addition.inventory;
    claimedStacks.push(toInventoryRecord(slot.item, catalogItem));
  }

  const usedSpace = storageUsedSpace(projectedInventory);
  if (usedSpace > capacity) {
    return {
      ...previewFailure('capacity_exceeded', state),
      usedSpace,
      capacity,
      overflow: roundSpace(usedSpace - capacity),
    };
  }

  return {
    ok: true,
    reason: null,
    revision: state.revision,
    claimedStacks,
    projectedInventory,
    usedSpace,
    capacity,
    remainingSpace: roundSpace(capacity - usedSpace),
  };
}

/**
 * Commits a previewed take in one pure transaction. No API exists for putting
 * carried items back into a world container; the intended loop is take, leave,
 * and return later for whatever remains.
 */
export function claimWorldLoot(rawState, command = {}, context = {}) {
  const state = normalizeWorldLootContainer(rawState, context);
  const validation = validateMutationCommand(state, command);
  if (!validation.ok) {
    return claimFailure(validation.reason, state, context.inventory, validation.replayed);
  }

  const preview = previewWorldLootClaim(state, {
    expectedRevision: state.revision,
    stackIds: command.stackIds,
  }, context);
  if (!preview.ok) return claimFailure(preview.reason, state, context.inventory, false, preview);

  const selected = new Set(preview.claimedStacks.map((entry) => entry.stackId));
  const nextState = cloneJson(state);
  nextState.slots.forEach((slot) => {
    if (selected.has(slot.item.stackId)) slot.status = WORLD_LOOT_SLOT_STATUS.CLAIMED;
  });
  commitCommand(nextState, validation.commandId);

  return {
    ok: true,
    reason: null,
    replayed: false,
    claimedStacks: preview.claimedStacks,
    inventory: preview.projectedInventory,
    usedSpace: preview.usedSpace,
    capacity: preview.capacity,
    remainingSpace: preview.remainingSpace,
    nextState,
  };
}

/**
 * Produces a UI-safe view: hidden slots expose their stable slot ID but not the
 * generated item identity.
 */
export function summarizeWorldLootContainer(rawState, context = {}) {
  const state = normalizeWorldLootContainer(rawState, context);
  const hidden = state.slots.filter((slot) => slot.status === WORLD_LOOT_SLOT_STATUS.HIDDEN).length;
  const revealed = state.slots.filter((slot) => slot.status === WORLD_LOOT_SLOT_STATUS.REVEALED).length;
  const claimed = state.slots.filter((slot) => slot.status === WORLD_LOOT_SLOT_STATUS.CLAIMED).length;
  const remaining = hidden + revealed;
  const exhausted = remaining === 0;

  return {
    searchKey: state.searchKey,
    revision: state.revision,
    total: state.slots.length,
    hidden,
    revealed,
    claimed,
    remaining,
    exhausted,
    complete: exhausted,
    searchCost: cloneJson(state.searchCost),
    searchCostPaid: state.searchCostPaid,
    searchCompletedAtMinutes: state.searchCompletedAtMinutes,
    slots: state.slots.map((slot) => ({
      slotId: slot.slotId,
      status: slot.status,
      item: slot.status === WORLD_LOOT_SLOT_STATUS.HIDDEN ? null : {
        id: slot.item.id,
        count: slot.item.count,
        stackId: slot.item.stackId,
        conditionState: cloneJson(slot.item.conditionState),
      },
    })),
  };
}

function normalizeGenerationContext(context) {
  const source = isRecord(context) ? context : {};
  const searchable = isRecord(source.searchable) ? source.searchable : {};
  const node = isRecord(source.node) ? source.node : {};
  const fallbackKey = [normalizeRuntimeId(node.id), normalizeRuntimeId(searchable.id)].filter(Boolean).join(':');
  const searchKey = normalizeRuntimeId(source.searchKey) || fallbackKey || 'world:unknown';
  const seed = normalizeSeed(source.worldSeed);
  const generationToken = hash32(`${seed}|${searchKey}`).toString(36).padStart(7, '0');
  return {
    seed,
    searchKey,
    generationId: `world-loot:${generationToken}`,
    searchable,
    node,
    searchMinutes: source.searchMinutes,
    // Prepared meals are player-made outcomes. Letting generic world loot
    // spawn them would undercut the food-preparation loop and can make a
    // freshly cooked dish appear in an untouched cupboard days later.
    catalog: catalogItems(source.catalog).filter((item) => !item.tags?.includes('prepared')),
  };
}

function normalizeLegacyContainer(rawState, rawSlots, fallback, context) {
  const wrapper = isRecord(rawState) && !Array.isArray(rawState) ? rawState : {};
  const generation = normalizeGenerationContext(context);
  const index = createCatalogIndex(context.catalog);
  const slots = [];

  rawSlots.forEach((rawSlot, slotIndex) => {
    if (!isRecord(rawSlot)) return;
    const rawItem = isRecord(rawSlot.item) ? rawSlot.item : rawSlot;
    const item = index.get(resolveRawItemId(rawSlot, rawItem))
      ?? findCatalogByName(context.catalog, rawItem.name);
    if (!item) return;
    slots.push(createGeneratedSlot(item, generation, slotIndex, normalizeSlotStatus(rawSlot.status), {
      count: rawItem.count ?? rawSlot.count,
      conditionState: rawItem.conditionState ?? rawItem.itemState,
    }));
  });

  // A persisted container must never regenerate replacement loot when every
  // saved item was removed from the catalog or corrupted. Dropping invalid
  // entries is safer than creating a second haul for an already-searched spot.
  const normalizedSlots = slots;
  const hasProgress = normalizedSlots.some((slot) => slot.status !== WORLD_LOOT_SLOT_STATUS.HIDDEN);
  return {
    ...fallback,
    revision: boundedInteger(wrapper.revision, 0, MAX_REVISION, 0),
    appliedCommandIds: normalizeCommandLedger(wrapper.appliedCommandIds),
    searchCost: normalizeSearchCost(wrapper.searchCost, fallback.searchCost),
    searchCostPaid: wrapper.searchCostPaid === true || hasProgress,
    searchCompletedAtMinutes: wrapper.searchCostPaid === true || hasProgress
      ? nullableBoundedInteger(wrapper.searchCompletedAtMinutes, 0, MAX_WORLD_MINUTES)
      : null,
    slots: normalizedSlots,
  };
}

function normalizeSavedSlots(rawSlots, fallback, context) {
  const generation = normalizeGenerationContext(context);
  const index = createCatalogIndex(context.catalog);
  const usedSlotIds = new Set();
  const usedStackIds = new Set();
  const result = [];

  rawSlots.forEach((rawSlot, slotIndex) => {
    if (!isRecord(rawSlot)) return;
    const rawItem = isRecord(rawSlot.item) ? rawSlot.item : rawSlot;
    const item = index.get(resolveRawItemId(rawSlot, rawItem))
      ?? findCatalogByName(context.catalog, rawItem.name);
    if (!item) return;
    const generated = createGeneratedSlot(item, generation, slotIndex, normalizeSlotStatus(rawSlot.status), {
      count: rawItem.count,
      conditionState: rawItem.conditionState ?? rawItem.itemState,
    });
    const slotId = uniqueRuntimeId(normalizeRuntimeId(rawSlot.slotId ?? rawSlot.id) || generated.slotId, usedSlotIds);
    const stackId = uniqueRuntimeId(normalizeRuntimeId(rawItem.stackId) || generated.item.stackId, usedStackIds);
    const conditionState = normalizeItemConditionState(rawItem.conditionState ?? rawItem.itemState ?? generated.item.conditionState, item);
    result.push({
      slotId,
      status: normalizeSlotStatus(rawSlot.status),
      item: {
        id: item.id,
        count: boundedInteger(rawItem.count, 1, MAX_ITEM_COUNT, generated.item.count),
        stackId,
        conditionState: { ...conditionState, instanceId: stackId, stackId },
      },
    });
  });

  return result;
}

function createGeneratedSlot(catalogItem, generation, slotIndex, status, overrides = {}) {
  const identityToken = hash32(`${generation.seed}|${generation.searchKey}|${slotIndex}|${catalogItem.id}`)
    .toString(36)
    .padStart(7, '0');
  const slotId = `loot-slot:${generation.generationId.slice('world-loot:'.length)}:${slotIndex + 1}:${identityToken}`;
  const stackId = `loot-stack:${generation.generationId.slice('world-loot:'.length)}:${slotIndex + 1}:${identityToken}`;
  const count = boundedInteger(
    overrides.count,
    1,
    MAX_ITEM_COUNT,
    deterministicItemCount(catalogItem, `${generation.seed}|${generation.searchKey}|${slotIndex}`),
  );
  const condition = overrides.conditionState
    ? normalizeItemConditionState(overrides.conditionState, catalogItem)
    : createItemConditionState(catalogItem, {
      acquiredMinutes: 0,
      acquisitionSequence: slotIndex + 1,
      sourceId: `${generation.generationId}:${slotIndex + 1}`,
    });

  return {
    slotId,
    status: normalizeSlotStatus(status),
    item: {
      id: catalogItem.id,
      count: isIndividualEquipment(catalogItem) ? 1 : count,
      stackId,
      conditionState: { ...condition, instanceId: stackId, stackId },
    },
  };
}

function deterministicCatalogPick(catalog, generation, quality, slotIndex) {
  if (!catalog.length) return null;
  const semantic = semanticProfileFor(generation.searchable, generation.node);
  const weighted = catalog.map((item) => ({ item, weight: itemWeight(item, quality, semantic) }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return catalog[hash32(`${generation.seed}|${generation.searchKey}|${slotIndex}`) % catalog.length];
  let cursor = hash32(`${generation.seed}|${generation.searchKey}|pick|${slotIndex}`) % totalWeight;
  for (const entry of weighted) {
    if (cursor < entry.weight) return entry.item;
    cursor -= entry.weight;
  }
  return weighted[weighted.length - 1].item;
}

function itemWeight(item, quality, semantic) {
  const qualityRank = QUALITY_RANK[quality];
  const itemRank = QUALITY_RANK[normalizeQuality(item.tier)];
  const delta = itemRank - qualityRank;
  let weight = delta <= 0 ? 16 - Math.abs(delta) * 2 : delta === 1 ? 4 : 1;
  if (semantic.categories.has(item.category)) weight += 18;
  const tags = new Set(Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : []);
  semantic.tags.forEach((tag) => {
    if (tags.has(tag)) weight += 8;
  });
  return Math.max(1, Math.round(weight));
}

function semanticProfileFor(searchable, node) {
  const text = [
    searchable.id,
    searchable.name,
    searchable.assetId,
    searchable.description,
    node.type,
    node.resourceHint,
    node.description,
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  const categories = new Set();
  const tags = new Set();
  SEMANTIC_PROFILES.forEach((profile) => {
    if (!profile.tokens.some((token) => text.includes(token))) return;
    profile.categories.forEach((category) => categories.add(category));
    profile.tags.forEach((tag) => tags.add(tag));
  });
  return { categories, tags };
}

function deterministicItemCount(item, seed) {
  if (isIndividualEquipment(item)) return 1;
  const roll = hash32(`${seed}|count|${item.id}`);
  if (item.category === 'ammo' || item.id === 'nails') return 2 + (roll % 5);
  if (['food', 'drink', 'medical'].includes(item.category)) return 1 + (roll % 2);
  if (Array.isArray(item.tags) && item.tags.some((tag) => ['material', 'battery'].includes(tag))) return 1 + (roll % 3);
  return 1;
}

function searchCostFor(searchable, node, explicitMinutes) {
  const danger = boundedInteger(node.danger, 0, 10, 0);
  const quality = QUALITY_RANK[normalizeQuality(searchable.quality)];
  const asset = String(searchable.assetId ?? '').toLowerCase();
  const noisyFixture = ['wreck', 'locker', 'warehouse', 'gas'].some((token) => asset.includes(token));
  const defaultMinutes = quality >= QUALITY_RANK.gold ? 90 : quality >= QUALITY_RANK.blue ? 60 : 45;
  return {
    minutes: boundedInteger(explicitMinutes, 1, 240, defaultMinutes),
    noise: boundedInteger((noisyFixture ? 2 : 0) + Math.max(0, danger - 1), 0, 20, 0),
  };
}

function normalizeSearchCost(rawCost, fallback) {
  const source = isRecord(rawCost) ? rawCost : {};
  return {
    minutes: boundedInteger(source.minutes, 1, 240, fallback.minutes),
    noise: boundedInteger(source.noise, 0, 20, fallback.noise),
  };
}

function zeroSearchCost() {
  return { minutes: 0, noise: 0 };
}

function projectExactStackAddition(inventory, rawStack, catalogItem) {
  const source = Array.isArray(inventory) ? cloneJson(inventory) : [];
  const incoming = toInventoryRecord(rawStack, catalogItem);
  if (source.some((entry) => entry?.stackId === incoming.stackId)) {
    return { ok: false, reason: 'stack_id_conflict' };
  }

  const mergeTarget = !isIndividualEquipment(catalogItem)
    ? source.find((entry) => (
      entry?.id === catalogItem.id
      && !isIndividualEquipment(entry)
      && canMergeItemConditionStates(entry.conditionState, incoming.conditionState)
    ))
    : null;
  if (mergeTarget) {
    const combined = positiveInteger(mergeTarget.count) + incoming.count;
    if (combined > MAX_ITEM_COUNT) return { ok: false, reason: 'stack_count_exceeded' };
    mergeTarget.count = combined;
  } else {
    source.push(incoming);
  }
  return { ok: true, reason: null, inventory: source };
}

function toInventoryRecord(rawStack, catalogItem) {
  const stackId = normalizeRuntimeId(rawStack.stackId);
  const conditionState = normalizeItemConditionState(rawStack.conditionState, catalogItem);
  return {
    ...cloneJson(catalogItem),
    count: boundedInteger(rawStack.count, 1, MAX_ITEM_COUNT, 1),
    stackId,
    conditionState: { ...conditionState, instanceId: stackId, stackId },
    ...(isWeapon(catalogItem) ? { repairCount: 0 } : {}),
  };
}

function validateMutationCommand(state, command) {
  if (!isRecord(command)) return { ok: false, reason: 'invalid_command', replayed: false };
  const commandId = normalizeRuntimeId(command.commandId);
  if (!commandId || !hasExpectedRevision(command)) {
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

function normalizeRevealSelection(command) {
  const raw = Array.isArray(command.slotIds) ? command.slotIds : [command.slotId];
  return normalizeExactIds(raw);
}

function normalizeStackSelection(rawIds) {
  return normalizeExactIds(rawIds);
}

function normalizeExactIds(rawIds) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return null;
  const ids = rawIds.map(normalizeRuntimeId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function commitCommand(state, commandId) {
  state.revision = Math.min(MAX_REVISION, state.revision + 1);
  state.appliedCommandIds = [...state.appliedCommandIds, commandId].slice(-MAX_COMMAND_LEDGER);
}

function mutationFailure(reason, state, replayed = false) {
  return {
    ok: false,
    reason,
    replayed,
    cost: zeroSearchCost(),
    nextState: cloneJson(state),
  };
}

function previewFailure(reason, state) {
  return { ok: false, reason, revision: state.revision };
}

function claimFailure(reason, state, inventory, replayed = false, details = {}) {
  const result = {
    ok: false,
    reason,
    replayed,
    inventory: cloneJson(Array.isArray(inventory) ? inventory : []),
    nextState: cloneJson(state),
  };
  ['usedSpace', 'capacity', 'overflow'].forEach((key) => {
    if (Number.isFinite(details[key])) result[key] = details[key];
  });
  return result;
}

function normalizeSlotStatus(rawStatus) {
  if (rawStatus === 'taken') return WORLD_LOOT_SLOT_STATUS.CLAIMED;
  if (rawStatus === 'searching') return WORLD_LOOT_SLOT_STATUS.HIDDEN;
  return SLOT_STATUSES.has(rawStatus) ? rawStatus : WORLD_LOOT_SLOT_STATUS.HIDDEN;
}

function normalizeCommandLedger(rawLedger) {
  if (!Array.isArray(rawLedger)) return [];
  const result = [];
  rawLedger.forEach((rawId) => {
    const id = normalizeRuntimeId(rawId);
    if (!id || result.includes(id)) return;
    result.push(id);
  });
  return result.slice(-MAX_COMMAND_LEDGER);
}

function createCatalogIndex(rawCatalog) {
  return new Map(catalogItems(rawCatalog).map((item) => [item.id, item]));
}

function findCatalogByName(rawCatalog, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return null;
  return catalogItems(rawCatalog).find((item) => item.name === name) ?? null;
}

function resolveRawItemId(rawSlot, rawItem) {
  if (rawItem !== rawSlot) return normalizeRuntimeId(rawItem.id ?? rawItem.itemId);
  return normalizeRuntimeId(rawSlot.itemId ?? rawSlot.id);
}

function catalogItems(rawCatalog) {
  const values = Array.isArray(rawCatalog)
    ? rawCatalog
    : isRecord(rawCatalog) ? Object.values(rawCatalog) : [];
  const byId = new Map();
  values.forEach((item) => {
    if (!isRecord(item)) return;
    const id = normalizeRuntimeId(item.id);
    if (!id || byId.has(id)) return;
    byId.set(id, { ...cloneJson(item), id });
  });
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function isIndividualEquipment(item) {
  return isWeapon(item)
    || item?.category === 'bag'
    || (Array.isArray(item?.tags) && item.tags.includes('bag'));
}

function isWeapon(item) {
  return item?.category === 'weapon'
    || (Array.isArray(item?.tags) && item.tags.includes('weapon'));
}

function normalizeQuality(value) {
  return Object.prototype.hasOwnProperty.call(QUALITY_RANK, value) ? value : 'white';
}

function normalizeSeed(value) {
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (isRecord(value) || Array.isArray(value)) return stableStringify(value).slice(0, 2_000);
  return '0';
}

function normalizeCapacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > MAX_CAPACITY) return null;
  return roundSpace(number);
}

function normalizeRuntimeId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_RUNTIME_ID_LENGTH);
}

function uniqueRuntimeId(rawId, usedIds) {
  const base = normalizeRuntimeId(rawId) || 'loot';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function hasExpectedRevision(value) {
  return isRecord(value)
    && Number.isInteger(value.expectedRevision)
    && value.expectedRevision >= 0
    && value.expectedRevision <= MAX_REVISION;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function nullableBoundedInteger(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function roundSpace(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function hash32(input) {
  const text = String(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
