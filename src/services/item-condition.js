export const ITEM_CONDITION_VERSION = 1;

export const FOOD_FRESHNESS_STATES = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  ROTTEN: 'rotten',
});

export const POWERED_REFRIGERATION_RATE = 0.2;

const MAX_CONDITION = 100;
const MAX_TOTAL_MINUTES = 1_000_000_000;
const MAX_USAGE_COUNT = 1_000_000;

const DEFAULT_WEAPON_WEAR = Object.freeze({ attack: 0.75, kill: 1.25 });

const WEAPON_WEAR_BY_ID = Object.freeze({
  baseball_bat: { attack: 0.75, kill: 1.25 },
  spiked_baseball_bat: { attack: 1.1, kill: 1.8 },
  crowbar: { attack: 0.25, kill: 0.5 },
  fire_axe: { attack: 0.65, kill: 1.1 },
  hand_axe: { attack: 0.85, kill: 1.35 },
  kitchen_knife: { attack: 1.2, kill: 2.1 },
  hunting_knife: { attack: 0.75, kill: 1.2 },
  machete: { attack: 0.65, kill: 1.05 },
  crafted_spear: { attack: 1.8, kill: 3.2 },
  hammer: { attack: 0.6, kill: 1 },
  wrench: { attack: 0.5, kill: 0.85 },
  pipe_wrench: { attack: 0.4, kill: 0.75 },
  shotgun: { attack: 0.2, kill: 0.08 },
  m9_pistol: { attack: 0.15, kill: 0.05 },
  m36_revolver: { attack: 0.12, kill: 0.04 },
});

const DEFAULT_PERISHABLE_PROFILE = Object.freeze({
  freshForMinutes: 2 * 24 * 60,
  rottenAfterMinutes: 5 * 24 * 60,
});

const FOOD_SHELF_LIFE_BY_ID = Object.freeze({
  wild_berries: {
    freshForMinutes: 2 * 24 * 60,
    rottenAfterMinutes: 4 * 24 * 60,
  },
  foraged_mushrooms: {
    freshForMinutes: 36 * 60,
    rottenAfterMinutes: 3 * 24 * 60,
  },
});

export function createItemInstanceId(itemId, {
  acquiredMinutes = 0,
  sequence = 0,
  sourceId = '',
} = {}) {
  const normalizedItemId = normalizeItemId(itemId) || 'item';
  const normalizedMinutes = boundedInteger(acquiredMinutes, 0, MAX_TOTAL_MINUTES, 0);
  const normalizedSequence = boundedInteger(sequence, 0, MAX_USAGE_COUNT, 0);
  const normalizedSource = normalizeRuntimeId(sourceId);
  const fingerprint = hash32(`${normalizedItemId}|${normalizedMinutes}|${normalizedSequence}|${normalizedSource}`)
    .toString(36)
    .padStart(7, '0');
  return `${normalizedItemId}:${fingerprint}`;
}

/**
 * Creates the saveable, per-instance simulation state for a catalog item.
 * Catalog data stays immutable; callers may attach this object to an inventory
 * entry under their own key.
 */
export function createItemConditionState(catalogItem = {}, overrides = {}) {
  const catalog = isRecord(catalogItem) ? catalogItem : {};
  const itemId = normalizeItemId(catalog.id);
  const source = isRecord(overrides) ? overrides : {};
  const acquiredMinutes = boundedInteger(source.acquiredMinutes, 0, MAX_TOTAL_MINUTES, 0);
  const acquisitionSequence = boundedInteger(source.acquisitionSequence ?? source.sequence, 0, MAX_USAGE_COUNT, 0);
  const instanceId = normalizeRuntimeId(source.instanceId) || createItemInstanceId(itemId, {
    acquiredMinutes,
    sequence: acquisitionSequence,
    sourceId: source.sourceId,
  });
  const wear = wearProfileFor(itemId);
  const shelfLife = resolveShelfLife(catalog, itemId);
  const isWeapon = hasTag(catalog, 'weapon');
  const isFood = catalog.category === 'food';
  const perishable = isFood && hasTag(catalog, 'perishable');
  const defaults = {
    version: ITEM_CONDITION_VERSION,
    itemId,
    instanceId,
    stackId: normalizeRuntimeId(source.stackId) || instanceId,
    acquiredMinutes,
    acquisitionSequence,
    condition: isWeapon ? {
      current: MAX_CONDITION,
      maximum: MAX_CONDITION,
      wearPerAttack: wear.attack,
      wearPerKill: wear.kill,
      broken: false,
    } : null,
    freshness: isFood ? {
      perishable,
      ageMinutes: 0,
      spoilageMinutes: 0,
      freshForMinutes: perishable ? shelfLife.freshForMinutes : null,
      rottenAfterMinutes: perishable ? shelfLife.rottenAfterMinutes : null,
      state: FOOD_FRESHNESS_STATES.FRESH,
    } : null,
  };

  return normalizeAgainstDefaults(overrides, catalog, defaults);
}

/**
 * Normalizes current state and old inventory-shaped records. Supported legacy
 * fields include numeric `condition`/`durability`, top-level `maxCondition`,
 * `broken`, `ageMinutes`, `spoilageMinutes`, and `freshnessMinutes`.
 */
export function normalizeItemConditionState(rawState, catalogItem = {}) {
  const outer = isRecord(rawState) ? rawState : {};
  const source = unwrapState(outer);
  const explicitCatalog = isRecord(catalogItem) ? catalogItem : {};
  const catalog = hasCatalogShape(explicitCatalog)
    ? explicitCatalog
    : hasCatalogShape(outer) ? outer : {};
  const itemId = normalizeItemId(catalog.id ?? source.itemId ?? source.id);
  const acquiredMinutes = boundedInteger(source.acquiredMinutes, 0, MAX_TOTAL_MINUTES, 0);
  const acquisitionSequence = boundedInteger(source.acquisitionSequence ?? source.sequence, 0, MAX_USAGE_COUNT, 0);
  const instanceId = normalizeRuntimeId(source.instanceId) || createItemInstanceId(itemId, {
    acquiredMinutes,
    sequence: acquisitionSequence,
    sourceId: source.sourceId,
  });
  const stackId = normalizeRuntimeId(source.stackId) || instanceId;
  const wear = wearProfileFor(itemId);
  const conditionSource = isRecord(source.condition) ? source.condition : {};
  const freshnessSource = isRecord(source.freshness) ? source.freshness : {};
  const conditionPresent = hasTag(catalog, 'weapon')
    || Object.prototype.hasOwnProperty.call(WEAPON_WEAR_BY_ID, itemId)
    || isRecord(source.condition)
    || isFinitePresentNumber(source.condition)
    || isFinitePresentNumber(source.durability);
  const foodPresent = catalog.category === 'food'
    || isRecord(source.freshness)
    || hasAnyOwn(source, ['ageMinutes', 'spoilageMinutes', 'freshnessMinutes']);
  const catalogDefinesFood = catalog.category === 'food';
  const catalogDefinesPerishable = catalogDefinesFood && hasTag(catalog, 'perishable');
  const savedPerishable = normalizeBoolean(freshnessSource.perishable ?? source.perishable, false);
  const perishable = foodPresent && (catalogDefinesFood ? catalogDefinesPerishable : savedPerishable);

  const maximum = conditionPresent
    ? positiveBoundedNumber(conditionSource.maximum ?? source.maxCondition, MAX_CONDITION, MAX_CONDITION)
    : null;
  const legacyCondition = isRecord(source.condition) ? undefined : source.condition;
  const savedBroken = normalizeBoolean(conditionSource.broken ?? source.broken, false);
  const current = conditionPresent
    ? (savedBroken ? 0 : boundedNumber(
      conditionSource.current ?? legacyCondition ?? source.durability,
      0,
      maximum,
      maximum,
    ))
    : null;
  const condition = conditionPresent ? {
    current: roundValue(current),
    maximum: roundValue(maximum),
    wearPerAttack: positiveBoundedNumber(conditionSource.wearPerAttack ?? source.wearPerAttack, MAX_CONDITION, wear.attack),
    wearPerKill: positiveBoundedNumber(conditionSource.wearPerKill ?? source.wearPerKill, MAX_CONDITION, wear.kill),
    broken: current <= 0,
  } : null;

  const ageMinutes = foodPresent
    ? boundedNumber(freshnessSource.ageMinutes ?? source.ageMinutes, 0, MAX_TOTAL_MINUTES, 0)
    : null;
  const hasExplicitSpoilage = hasAnyOwn(freshnessSource, ['spoilageMinutes'])
    || hasAnyOwn(source, ['spoilageMinutes', 'freshnessMinutes']);
  const spoilageMinutes = foodPresent
    ? boundedNumber(
      freshnessSource.spoilageMinutes ?? source.spoilageMinutes ?? source.freshnessMinutes,
      0,
      MAX_TOTAL_MINUTES,
      hasExplicitSpoilage ? 0 : ageMinutes,
    )
    : null;
  const shelfLife = resolveShelfLife(catalog, itemId, freshnessSource, source);
  const freshForMinutes = perishable ? shelfLife.freshForMinutes : null;
  const rottenAfterMinutes = perishable ? shelfLife.rottenAfterMinutes : null;
  const freshness = foodPresent ? {
    perishable,
    ageMinutes: roundMinutes(ageMinutes),
    spoilageMinutes: roundMinutes(spoilageMinutes),
    freshForMinutes: perishable ? roundMinutes(freshForMinutes) : null,
    rottenAfterMinutes: perishable ? roundMinutes(rottenAfterMinutes) : null,
    state: freshnessStateFor(spoilageMinutes, freshForMinutes, rottenAfterMinutes, perishable),
  } : null;

  return {
    version: ITEM_CONDITION_VERSION,
    itemId,
    instanceId,
    stackId,
    acquiredMinutes,
    acquisitionSequence,
    condition,
    freshness,
  };
}

/**
 * Advances chronological age and temperature-adjusted spoilage. A powered
 * refrigerator ages perishables at one fifth ambient speed. A refrigerator
 * without power behaves like ambient storage immediately.
 */
export function advanceFoodSpoilage(state, {
  elapsedMinutes = 0,
  refrigerated = false,
  powerOn = true,
} = {}) {
  const next = normalizeItemConditionState(state);
  const elapsed = boundedNumber(elapsedMinutes, 0, MAX_TOTAL_MINUTES, 0);
  if (!next.freshness || elapsed <= 0) return next;

  const ageMinutes = Math.min(MAX_TOTAL_MINUTES, next.freshness.ageMinutes + elapsed);
  let spoilageMinutes = next.freshness.spoilageMinutes;
  if (next.freshness.perishable) {
    const isPoweredRefrigeration = normalizeBoolean(refrigerated, false)
      && normalizeBoolean(powerOn, true);
    const rate = isPoweredRefrigeration ? POWERED_REFRIGERATION_RATE : 1;
    spoilageMinutes = Math.min(MAX_TOTAL_MINUTES, spoilageMinutes + elapsed * rate);
  }

  const freshness = {
    ...next.freshness,
    ageMinutes: roundMinutes(ageMinutes),
    spoilageMinutes: roundMinutes(spoilageMinutes),
  };
  freshness.state = freshnessStateFor(
    freshness.spoilageMinutes,
    freshness.freshForMinutes,
    freshness.rottenAfterMinutes,
    freshness.perishable,
  );
  return { ...next, freshness };
}

export function getFoodConsumptionModifiers(state) {
  const normalized = normalizeItemConditionState(state);
  const freshnessState = normalized.freshness?.state ?? null;
  if (!normalized.freshness) {
    return {
      edible: false,
      freshnessState,
      effectMultiplier: 1,
      foodPoisoningRisk: false,
    };
  }

  const effectMultiplier = freshnessState === FOOD_FRESHNESS_STATES.ROTTEN
    ? 0.25
    : freshnessState === FOOD_FRESHNESS_STATES.STALE ? 0.65 : 1;
  return {
    edible: true,
    freshnessState,
    effectMultiplier,
    foodPoisoningRisk: freshnessState === FOOD_FRESHNESS_STATES.ROTTEN,
  };
}

/**
 * Applies deterministic wear from recorded combat usage. Kills add extra wear
 * on top of attacks so a combat resolver may report either or both counters.
 */
export function applyWeaponWear(state, { attacks = 0, kills = 0 } = {}) {
  const next = normalizeItemConditionState(state);
  if (!next.condition || next.condition.broken) return next;

  const attackCount = boundedInteger(attacks, 0, MAX_USAGE_COUNT, 0);
  const killCount = boundedInteger(kills, 0, MAX_USAGE_COUNT, 0);
  if (attackCount === 0 && killCount === 0) return next;

  const wear = attackCount * next.condition.wearPerAttack
    + killCount * next.condition.wearPerKill;
  const current = roundValue(Math.max(0, next.condition.current - wear));
  return {
    ...next,
    condition: {
      ...next.condition,
      current,
      broken: current <= 0,
    },
  };
}

export function isWeaponBroken(state) {
  return normalizeItemConditionState(state).condition?.broken ?? false;
}

/**
 * Returns presentation-ready values so views never need to repeat durability
 * or spoilage threshold arithmetic.
 */
export function getItemConditionDisplay(state) {
  const normalized = normalizeItemConditionState(state);
  if (normalized.condition) {
    const percent = Math.round(normalized.condition.current / normalized.condition.maximum * 100);
    if (normalized.condition.broken) {
      return {
        label: '已损坏',
        tone: 'danger',
        percent: 0,
        disabledReason: '武器已经损坏，无法装备或用于战斗。',
      };
    }
    return {
      label: `耐久 ${percent}%`,
      tone: percent <= 20 ? 'danger' : percent <= 60 ? 'warn' : 'good',
      percent,
      disabledReason: null,
    };
  }

  if (normalized.freshness) {
    if (!normalized.freshness.perishable) {
      return {
        label: '耐储存',
        tone: 'neutral',
        percent: 100,
        disabledReason: null,
      };
    }
    const percent = Math.round(Math.max(0,
      (normalized.freshness.rottenAfterMinutes - normalized.freshness.spoilageMinutes)
        / normalized.freshness.rottenAfterMinutes * 100));
    const displayByState = {
      [FOOD_FRESHNESS_STATES.FRESH]: { label: '新鲜', tone: 'good' },
      [FOOD_FRESHNESS_STATES.STALE]: { label: '不新鲜', tone: 'warn' },
      [FOOD_FRESHNESS_STATES.ROTTEN]: { label: '腐烂', tone: 'danger' },
    };
    return {
      ...displayByState[normalized.freshness.state],
      percent,
      disabledReason: null,
    };
  }

  return {
    label: '',
    tone: 'neutral',
    percent: null,
    disabledReason: null,
  };
}

/**
 * Different acquisition lots may share a stack only while their gameplay
 * condition is equivalent. Identity fields are intentionally ignored.
 */
export function canMergeItemConditionStates(left, right, { freshnessToleranceMinutes = 0 } = {}) {
  const first = normalizeItemConditionState(left);
  const second = normalizeItemConditionState(right);
  if (!first.itemId || first.itemId !== second.itemId) return false;
  if (Boolean(first.condition) !== Boolean(second.condition)) return false;
  if (Boolean(first.freshness) !== Boolean(second.freshness)) return false;

  if (first.condition) {
    if (first.condition.current !== second.condition.current
      || first.condition.maximum !== second.condition.maximum
      || first.condition.wearPerAttack !== second.condition.wearPerAttack
      || first.condition.wearPerKill !== second.condition.wearPerKill
      || first.condition.broken !== second.condition.broken) return false;
  }

  if (first.freshness) {
    if (first.freshness.perishable !== second.freshness.perishable
      || first.freshness.freshForMinutes !== second.freshness.freshForMinutes
      || first.freshness.rottenAfterMinutes !== second.freshness.rottenAfterMinutes
      || first.freshness.state !== second.freshness.state) return false;
    const tolerance = boundedNumber(freshnessToleranceMinutes, 0, MAX_TOTAL_MINUTES, 0);
    if (Math.abs(first.freshness.ageMinutes - second.freshness.ageMinutes) > tolerance
      || Math.abs(first.freshness.spoilageMinutes - second.freshness.spoilageMinutes) > tolerance) return false;
  }

  return true;
}

function normalizeAgainstDefaults(rawOverrides, catalog, defaults) {
  const overrides = isRecord(rawOverrides) ? rawOverrides : {};
  const condition = defaults.condition
    ? {
      ...defaults.condition,
      ...(isRecord(overrides.condition) ? overrides.condition : {}),
    }
    : null;
  const freshness = defaults.freshness
    ? {
      ...defaults.freshness,
      ...(isRecord(overrides.freshness) ? overrides.freshness : {}),
    }
    : null;
  return normalizeItemConditionState({
    ...defaults,
    ...overrides,
    condition,
    freshness,
  }, catalog);
}

function shelfLifeFor(itemId) {
  return FOOD_SHELF_LIFE_BY_ID[itemId] ?? DEFAULT_PERISHABLE_PROFILE;
}

function resolveShelfLife(catalog, itemId, savedFreshness = {}, savedState = {}) {
  const fallback = shelfLifeFor(itemId);
  const catalogSpoilage = isRecord(catalog?.spoilage) ? catalog.spoilage : {};
  const savedFreshFor = positiveBoundedNumber(
    savedFreshness.freshForMinutes ?? savedState.freshForMinutes,
    MAX_TOTAL_MINUTES - 1,
    fallback.freshForMinutes,
  );
  const freshForMinutes = positiveBoundedNumber(
    catalogSpoilage.freshForMinutes,
    MAX_TOTAL_MINUTES - 1,
    savedFreshFor,
  );
  const savedRottenAfter = boundedAfter(
    savedFreshness.rottenAfterMinutes ?? savedState.rottenAfterMinutes,
    savedFreshFor + 1,
    MAX_TOTAL_MINUTES,
    Math.max(savedFreshFor + 1, fallback.rottenAfterMinutes),
  );
  const rottenAfterMinutes = boundedAfter(
    catalogSpoilage.rottenAfterMinutes,
    freshForMinutes + 1,
    MAX_TOTAL_MINUTES,
    Math.max(freshForMinutes + 1, savedRottenAfter),
  );
  return { freshForMinutes, rottenAfterMinutes };
}

function wearProfileFor(itemId) {
  return WEAPON_WEAR_BY_ID[itemId] ?? DEFAULT_WEAPON_WEAR;
}

function freshnessStateFor(spoilageMinutes, freshForMinutes, rottenAfterMinutes, perishable) {
  if (!perishable) return FOOD_FRESHNESS_STATES.FRESH;
  if (spoilageMinutes >= rottenAfterMinutes) return FOOD_FRESHNESS_STATES.ROTTEN;
  if (spoilageMinutes >= freshForMinutes) return FOOD_FRESHNESS_STATES.STALE;
  return FOOD_FRESHNESS_STATES.FRESH;
}

function unwrapState(raw) {
  if (isRecord(raw.itemCondition)) return raw.itemCondition;
  if (isRecord(raw.conditionState)) return raw.conditionState;
  return raw;
}

function hasCatalogShape(value) {
  return typeof value?.id === 'string'
    || typeof value?.category === 'string'
    || Array.isArray(value?.tags);
}

function hasTag(item, tag) {
  return Array.isArray(item?.tags) && item.tags.includes(tag);
}

function hasAnyOwn(value, keys) {
  return isRecord(value) && keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeItemId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function normalizeRuntimeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 180) : '';
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === 1 || value === 'true') return true;
  if (value === false || value === 0 || value === 'false') return false;
  return fallback;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
}

function boundedNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function positiveBoundedNumber(value, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(maximum, numeric);
}

function boundedAfter(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.max(minimum, Math.min(maximum, fallback));
  }
  return Math.max(minimum, Math.min(maximum, numeric));
}

function isFinitePresentNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function roundMinutes(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundValue(value) {
  return Math.round(value * 100) / 100;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
