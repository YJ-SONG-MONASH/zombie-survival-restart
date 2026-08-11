export const MAX_NODE_ZOMBIES = 120;

const STATE_VERSION = 1;
const MAX_DANGER = 10;
const MAX_DAY = 999_999;
const MAX_TOTAL_MINUTES = 1_000_000_000;
const MAX_EVASION_MINUTES = 24 * 60;

export function createNodeZombieState({ nodeId, danger = 0, seed = 0, day = 1 } = {}) {
  const normalizedNodeId = normalizeNodeId(nodeId);
  const normalizedDanger = boundedInteger(danger, 0, MAX_DANGER, 0);
  const normalizedSeed = boundedInteger(seed, 0, 0xffff_ffff, 0);
  const normalizedDay = boundedInteger(day, 1, MAX_DAY, 1);
  const capacity = capacityForDanger(normalizedDanger);
  const minimum = Math.max(1, Math.floor(capacity * 0.25));
  const maximum = Math.max(minimum, Math.floor(capacity * 0.45));
  const count = minimum + hash32(`${normalizedNodeId}|${normalizedSeed}|${normalizedDay}|initial`) % (maximum - minimum + 1);

  return {
    version: STATE_VERSION,
    nodeId: normalizedNodeId,
    count,
    capacity,
    clearedDay: null,
    lastRefreshDay: normalizedDay,
    evasionUntilMinutes: 0,
    lastCombatMinutes: null,
  };
}

export function normalizeNodeZombieStates(raw, { nodes = [], seed = 0, day = 1 } = {}) {
  const normalizedDay = boundedInteger(day, 1, MAX_DAY, 1);
  const source = indexRawStates(raw);
  const result = {};

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const nodeId = normalizeNodeId(node?.id);
    if (!nodeId || Object.prototype.hasOwnProperty.call(result, nodeId)) continue;
    const danger = boundedInteger(node?.danger, 0, MAX_DANGER, 0);
    const fallback = createNodeZombieState({ nodeId, danger, seed, day: normalizedDay });
    result[nodeId] = normalizePersistedState(source[nodeId], fallback, normalizedDay);
  }

  return result;
}

export function refreshNodeZombieState(state, {
  danger = 0,
  seed = 0,
  day = 1,
  worldThreat = 0,
} = {}) {
  const next = sanitizeOperationalState(state);
  const normalizedDanger = boundedInteger(danger, 0, MAX_DANGER, 0);
  const normalizedSeed = boundedInteger(seed, 0, 0xffff_ffff, 0);
  const normalizedDay = boundedInteger(day, 1, MAX_DAY, 1);
  const normalizedThreat = boundedNumber(worldThreat, 0, 100, 0);
  const targetCapacity = capacityForDanger(normalizedDanger);
  next.capacity = targetCapacity;
  next.count = Math.min(next.count, targetCapacity);

  if (normalizedDay <= next.lastRefreshDay) return next;

  for (let crossedDay = next.lastRefreshDay + 1; crossedDay <= normalizedDay; crossedDay += 1) {
    if (next.clearedDay !== null && crossedDay <= next.clearedDay) continue;
    const baseMigration = 1 + Math.floor(normalizedDanger / 3);
    const threatMigration = Math.floor(normalizedThreat / 40);
    const dailyVariation = hash32(`${next.nodeId}|${normalizedSeed}|${crossedDay}|migration`) % 2;
    next.count = Math.min(targetCapacity, next.count + baseMigration + threatMigration + dailyVariation);
  }

  next.lastRefreshDay = normalizedDay;
  return next;
}

export function applyZombieKills(state, kills, { day = 1, totalMinutes = 0 } = {}) {
  const next = sanitizeOperationalState(state);
  const requestedKills = positiveInteger(kills);
  if (!requestedKills || next.count === 0) return next;

  const appliedKills = Math.min(requestedKills, next.count);
  next.count -= appliedKills;
  next.lastCombatMinutes = boundedInteger(totalMinutes, 0, MAX_TOTAL_MINUTES, 0);
  if (next.count === 0) next.clearedDay = boundedInteger(day, 1, MAX_DAY, 1);
  return next;
}

export function grantEvasionWindow(state, { totalMinutes = 0, minutes = 0 } = {}) {
  const next = sanitizeOperationalState(state);
  const start = boundedInteger(totalMinutes, 0, MAX_TOTAL_MINUTES, 0);
  const duration = boundedInteger(minutes, 0, MAX_EVASION_MINUTES, 0);
  if (!duration) return next;

  const deadline = Math.min(MAX_TOTAL_MINUTES, start + duration);
  next.evasionUntilMinutes = Math.max(next.evasionUntilMinutes, deadline);
  return next;
}

export function isNodeSecured(state, totalMinutes = 0) {
  const normalized = sanitizeOperationalState(state);
  if (normalized.count === 0) return true;
  const now = boundedInteger(totalMinutes, 0, MAX_TOTAL_MINUTES, 0);
  return now < normalized.evasionUntilMinutes;
}

function normalizePersistedState(value, fallback, currentDay) {
  if (!isRecord(value)) return fallback;
  const count = boundedInteger(value.count, 0, fallback.capacity, fallback.count);
  return {
    version: STATE_VERSION,
    nodeId: fallback.nodeId,
    count,
    capacity: fallback.capacity,
    clearedDay: nullableBoundedInteger(value.clearedDay, 1, currentDay),
    lastRefreshDay: boundedInteger(value.lastRefreshDay, 1, currentDay, currentDay),
    evasionUntilMinutes: boundedInteger(value.evasionUntilMinutes, 0, MAX_TOTAL_MINUTES, 0),
    lastCombatMinutes: nullableBoundedInteger(value.lastCombatMinutes, 0, MAX_TOTAL_MINUTES),
  };
}

function sanitizeOperationalState(value) {
  const source = isRecord(value) ? value : {};
  const capacity = boundedInteger(source.capacity, 1, MAX_NODE_ZOMBIES, 1);
  return {
    version: STATE_VERSION,
    nodeId: normalizeNodeId(source.nodeId),
    count: boundedInteger(source.count, 0, capacity, 0),
    capacity,
    clearedDay: nullableBoundedInteger(source.clearedDay, 1, MAX_DAY),
    lastRefreshDay: boundedInteger(source.lastRefreshDay, 1, MAX_DAY, 1),
    evasionUntilMinutes: boundedInteger(source.evasionUntilMinutes, 0, MAX_TOTAL_MINUTES, 0),
    lastCombatMinutes: nullableBoundedInteger(source.lastCombatMinutes, 0, MAX_TOTAL_MINUTES),
  };
}

function indexRawStates(raw) {
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw
        .filter(isRecord)
        .map((state) => [normalizeNodeId(state.nodeId), state])
        .filter(([nodeId]) => nodeId),
    );
  }
  return isRecord(raw) ? raw : {};
}

function capacityForDanger(danger) {
  return Math.min(MAX_NODE_ZOMBIES, 6 + boundedInteger(danger, 0, MAX_DANGER, 0) * 14);
}

function normalizeNodeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function nullableBoundedInteger(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return null;
  return Math.round(numeric);
}

function boundedInteger(value, min, max, fallback) {
  return Math.round(boundedNumber(value, min, max, fallback));
}

function boundedNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
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
