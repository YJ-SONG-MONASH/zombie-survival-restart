export const BASE_SECURITY_VERSION = 1;

const MAX_COMMAND_LEDGER = 64;
const MAX_REVISION = 1_000_000_000;
const MAX_HOUR = 100_000_000;
const MAX_ITEM_COUNT = 999_999;
const CONTAINER_IDS = Object.freeze(['carry', 'base']);
const CONTAINER_ID_SET = new Set(CONTAINER_IDS);

const OPENING_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'front_door', label: '正门', kind: 'door', maxIntegrity: 120, maxBarricade: 200 }),
  Object.freeze({ id: 'front_window', label: '前窗', kind: 'window', maxIntegrity: 80, maxBarricade: 150 }),
  Object.freeze({ id: 'rear_window', label: '后窗', kind: 'window', maxIntegrity: 80, maxBarricade: 150 }),
]);
const OPENING_ID_SET = new Set(OPENING_DEFINITIONS.map((entry) => entry.id));

const WORK_DEFINITIONS = Object.freeze({
  fortify: Object.freeze({ minutes: 90, baseDelta: 35, noiseDelta: 12, skillXp: 18 }),
  repair: Object.freeze({ minutes: 60, baseDelta: 30, noiseDelta: 8, skillXp: 14 }),
});

/** Create a deterministic, JSON-only security model for one safehouse. */
export function createBaseSecurity(rawOptions = {}) {
  const options = isRecord(rawOptions) ? rawOptions : {};
  const totalMinutes = options.totalMinutes ?? 0;
  const legacyBarricades = options.legacyBarricades ?? 0;
  const openings = OPENING_DEFINITIONS.map((definition) => ({
    ...definition,
    integrity: definition.maxIntegrity,
    barricade: 0,
  }));
  distributeLegacyBarricades(openings, boundedInteger(legacyBarricades, 0, 20, 0));
  return {
    version: BASE_SECURITY_VERSION,
    revision: 0,
    lastProcessedHour: minuteHour(totalMinutes),
    appliedCommandIds: [],
    openings,
    lastIncident: null,
  };
}

/** Canonicalize saves while retaining every recognized opening and valid incident. */
export function normalizeBaseSecurity(rawState, context = {}) {
  const fallback = createBaseSecurity({
    shelter: context?.shelter,
    totalMinutes: context?.totalMinutes,
    legacyBarricades: context?.legacyBarricades,
  });
  if (!isRecord(rawState)) return fallback;

  const rawOpenings = Array.isArray(rawState.openings) ? rawState.openings : [];
  const openingsById = new Map(rawOpenings
    .filter(isRecord)
    .map((opening) => [normalizeId(opening.id), opening])
    .filter(([id]) => OPENING_ID_SET.has(id)));
  const openings = fallback.openings.map((fallbackOpening) => {
    const raw = openingsById.get(fallbackOpening.id);
    if (!raw) return { ...fallbackOpening };
    const maxIntegrity = boundedInteger(raw.maxIntegrity, 1, 1_000, fallbackOpening.maxIntegrity);
    const maxBarricade = boundedInteger(raw.maxBarricade, 0, 1_000, fallbackOpening.maxBarricade);
    return {
      id: fallbackOpening.id,
      label: fallbackOpening.label,
      kind: fallbackOpening.kind,
      integrity: boundedInteger(raw.integrity, 0, maxIntegrity, maxIntegrity),
      maxIntegrity,
      barricade: boundedInteger(raw.barricade, 0, maxBarricade, 0),
      maxBarricade,
    };
  });

  return {
    version: BASE_SECURITY_VERSION,
    revision: boundedInteger(rawState.revision, 0, MAX_REVISION, 0),
    lastProcessedHour: boundedInteger(rawState.lastProcessedHour, 0, MAX_HOUR, fallback.lastProcessedHour),
    appliedCommandIds: normalizeCommandLedger(rawState.appliedCommandIds),
    openings,
    lastIncident: normalizeIncident(rawState.lastIncident),
  };
}

/** Produce presentation data without giving the UI ownership of any rule. */
export function summarizeBaseSecurity(rawState, context = {}) {
  const state = normalizeBaseSecurity(rawState, context);
  const totalIntegrity = sumBy(state.openings, 'integrity');
  const maxIntegrity = sumBy(state.openings, 'maxIntegrity');
  const totalBarricade = sumBy(state.openings, 'barricade');
  const maxBarricade = sumBy(state.openings, 'maxBarricade');
  const breachedCount = state.openings.filter((entry) => entry.integrity <= 0).length;
  const damagedCount = state.openings.filter((entry) => entry.integrity > 0 && entry.integrity < entry.maxIntegrity).length;
  const weakestOpening = [...state.openings].sort((left, right) => {
    const integrityDelta = left.integrity / Math.max(1, left.maxIntegrity)
      - right.integrity / Math.max(1, right.maxIntegrity);
    const barricadeDelta = left.barricade / Math.max(1, left.maxBarricade)
      - right.barricade / Math.max(1, right.maxBarricade);
    return integrityDelta || barricadeDelta || OPENING_DEFINITIONS.findIndex((entry) => entry.id === left.id)
      - OPENING_DEFINITIONS.findIndex((entry) => entry.id === right.id);
  })[0];
  const exteriorPopulation = boundedInteger(context?.exteriorPopulation, 0, 100_000, 0);
  const pressureProfile = securityPressure({ ...context, exteriorPopulation });
  const legacyBarricades = Math.min(20, Math.floor(totalBarricade / 25));
  const shelterDefense = boundedInteger(context?.shelterDefense ?? context?.shelter?.defense, 0, 20, 0);
  return {
    version: state.version,
    revision: state.revision,
    lastProcessedHour: state.lastProcessedHour,
    openings: cloneJson(state.openings),
    lastIncident: cloneJson(state.lastIncident),
    totalIntegrity,
    maxIntegrity,
    totalBarricade,
    maxBarricade,
    breachedCount,
    damagedCount,
    secureOpeningCount: state.openings.length - breachedCount,
    status: breachedCount > 0 ? 'breached' : damagedCount > 0 ? 'damaged' : 'intact',
    interiorSafe: breachedCount === 0,
    securityPercent: Math.round(((totalIntegrity + totalBarricade) / Math.max(1, maxIntegrity + maxBarricade)) * 100),
    weakestOpeningId: weakestOpening?.id ?? null,
    exteriorPopulation,
    currentPressure: pressureProfile.pressure,
    currentPressureSources: pressureProfile.sources,
    legacyBarricades,
    legacyBaseProjection: {
      barricades: legacyBarricades,
      defense: Math.min(20, shelterDefense + legacyBarricades),
    },
  };
}

/** Project exact work effects and inventory consumption without committing concurrency metadata. */
export function previewBaseWork(rawState, command, context = {}) {
  return evaluateBaseWork(rawState, command, context, false);
}

/** Atomically resolve one fortify/repair command. */
export function resolveBaseWork(rawState, command, context = {}) {
  return evaluateBaseWork(rawState, command, context, true);
}

/**
 * Advance only across six-hour observation boundaries. Random-looking choices
 * are derived exclusively from immutable inputs so chunked time is equivalent.
 */
export function advanceBaseSecurity(rawState, rawInput = {}) {
  const input = isRecord(rawInput) ? rawInput : {};
  const fromTotalMinutes = boundedInteger(input.fromTotalMinutes, 0, MAX_HOUR * 60, 0);
  const toTotalMinutes = boundedInteger(input.toTotalMinutes, 0, MAX_HOUR * 60, fromTotalMinutes);
  const state = normalizeBaseSecurity(rawState, { totalMinutes: fromTotalMinutes });
  const baseState = cloneJson(state);
  if (toTotalMinutes <= fromTotalMinutes) {
    return { nextState: baseState, events: [], incidents: [], processedObservationHours: [] };
  }

  const fromHour = Math.max(state.lastProcessedHour, minuteHour(fromTotalMinutes));
  const toHour = minuteHour(toTotalMinutes);
  if (toHour <= fromHour) {
    return { nextState: baseState, events: [], incidents: [], processedObservationHours: [] };
  }

  const nextState = cloneJson(state);
  const events = [];
  const incidents = [];
  const processedObservationHours = [];
  const baseDayOffset = boundedInteger(input.day, 1, 10_000, 1) - Math.floor(fromHour / 24);
  for (let hour = fromHour + 1; hour <= toHour; hour += 1) {
    if (hour % 6 !== 0) continue;
    processedObservationHours.push(hour);
    const observationDay = Math.max(1, baseDayOffset + Math.floor(hour / 24));
    const pressureProfile = securityPressure({ ...input, day: observationDay });
    const roll = deterministicPercent(input.worldSeed, hour, 'attack-roll');
    const attackChance = pressureProfile.pressure >= 100
      ? 100
      : Math.min(95, Math.max(0, Math.round(pressureProfile.pressure * 0.9)));
    const candidates = nextState.openings.filter((opening) => opening.integrity > 0);
    const attacked = pressureProfile.sources.exteriorPopulation > 0
      && candidates.length > 0
      && roll < attackChance;

    if (!attacked) {
      events.push({
        hour,
        attacked: false,
        openingId: null,
        pressure: pressureProfile.pressure,
        damage: 0,
        barricadeDamage: 0,
        integrityDamage: 0,
        breached: false,
        sources: { ...pressureProfile.sources, roll, attackChance },
      });
      continue;
    }

    const opening = candidates[deterministicPercent(input.worldSeed, hour, 'opening') % candidates.length];
    const damage = Math.min(100, 8 + Math.floor(pressureProfile.pressure / 10)
      + (deterministicPercent(input.worldSeed, hour, 'damage') % 9));
    const barricadeDamage = Math.min(opening.barricade, damage);
    opening.barricade -= barricadeDamage;
    const integrityDamage = Math.min(opening.integrity, damage - barricadeDamage);
    const previouslyIntact = opening.integrity > 0;
    opening.integrity -= integrityDamage;
    const breached = previouslyIntact && opening.integrity === 0;
    const incident = {
      hour,
      openingId: opening.id,
      pressure: pressureProfile.pressure,
      damage,
      barricadeDamage,
      integrityDamage,
      breached,
      sources: { ...pressureProfile.sources, roll, attackChance },
    };
    nextState.lastIncident = cloneJson(incident);
    incidents.push(cloneJson(incident));
    events.push({ attacked: true, ...cloneJson(incident) });
  }

  nextState.lastProcessedHour = toHour;
  nextState.revision = Math.min(MAX_REVISION, state.revision + processedObservationHours.length);
  return { nextState, events, incidents, processedObservationHours };
}

function evaluateBaseWork(rawState, rawCommand, rawContext, commit) {
  const context = normalizeWorkContext(rawContext);
  const state = normalizeBaseSecurity(rawState, {
    totalMinutes: context.totalMinutes,
    shelter: context.shelter,
    legacyBarricades: rawContext?.legacyBarricades,
  });
  const unchanged = transactionState(state, context.containers);
  const command = isRecord(rawCommand) ? rawCommand : {};
  const commandValidation = validateCommand(state, command);
  if (!commandValidation.ok) return workFailure(commandValidation.reason, unchanged, commandValidation.replayed);
  if (!context.accessAllowed) return workFailure('access_denied', unchanged);
  const openingId = normalizeId(command.openingId);
  const openingIndex = state.openings.findIndex((entry) => entry.id === openingId);
  if (openingIndex < 0) return workFailure('unknown_opening', unchanged);
  const kind = normalizeId(command.kind);
  const definition = WORK_DEFINITIONS[kind];
  if (!definition) return workFailure('invalid_work_kind', unchanged);
  const opening = state.openings[openingIndex];
  if (kind === 'fortify' && opening.integrity <= 0) {
    return workFailure('repair_required', unchanged);
  }
  if (!context.capacitiesValid) return workFailure('invalid_capacity', unchanged);
  if (CONTAINER_IDS.some((id) => usedSpace(context.containers[id], context.catalogById) > context.capacities[id])) {
    return workFailure('capacity_exceeded', unchanged);
  }

  const toolSelection = normalizeSelection(command.tool, false);
  if (!toolSelection) return workFailure('hammer_required', unchanged);
  const tool = findStack(context.containers, toolSelection);
  if (!tool || positiveInteger(tool.count) < 1 || tool.id !== 'hammer') return workFailure('hammer_required', unchanged);
  if (tool.conditionState?.condition?.broken === true || tool.broken === true) return workFailure('tool_broken', unchanged);

  const materialResolution = resolveMaterials(command.materials, context.containers);
  if (!materialResolution.ok) return workFailure(materialResolution.reason, unchanged);
  if (kind === 'fortify' && opening.barricade >= opening.maxBarricade) {
    return workFailure('already_fortified', unchanged);
  }
  if (kind === 'repair' && opening.integrity >= opening.maxIntegrity) {
    return workFailure('repair_not_needed', unchanged);
  }

  const projectedContainers = cloneJson(context.containers);
  materialResolution.selections.forEach((selection) => {
    const entries = projectedContainers[selection.containerId];
    const stack = entries.find((entry) => entry.stackId === selection.stackId);
    stack.count -= selection.count;
  });
  CONTAINER_IDS.forEach((containerId) => {
    projectedContainers[containerId] = projectedContainers[containerId]
      .filter((entry) => positiveInteger(entry.count) > 0);
  });

  const projectedSecurity = cloneJson(state);
  const projectedOpening = projectedSecurity.openings[openingIndex];
  const requestedDelta = definition.baseDelta + context.carpentrySkill * 2;
  let integrityDelta = 0;
  let barricadeDelta = 0;
  if (kind === 'fortify') {
    barricadeDelta = Math.min(requestedDelta, projectedOpening.maxBarricade - projectedOpening.barricade);
    projectedOpening.barricade += barricadeDelta;
  } else {
    integrityDelta = Math.min(requestedDelta, projectedOpening.maxIntegrity - projectedOpening.integrity);
    projectedOpening.integrity += integrityDelta;
  }
  if (commit) {
    projectedSecurity.revision = Math.min(MAX_REVISION, projectedSecurity.revision + 1);
    projectedSecurity.appliedCommandIds = appendCommandId(projectedSecurity.appliedCommandIds, commandValidation.commandId);
  }

  return {
    ok: true,
    reason: null,
    replayed: false,
    kind,
    openingId,
    minutes: definition.minutes,
    noiseDelta: definition.noiseDelta,
    skillXp: definition.skillXp,
    integrityDelta,
    barricadeDelta,
    consumedMaterials: materialResolution.selections.map((entry) => ({ ...entry })),
    nextState: transactionState(projectedSecurity, projectedContainers),
  };
}

function normalizeWorkContext(rawContext) {
  const context = isRecord(rawContext) ? rawContext : {};
  const rawContainers = isRecord(context.containers) ? context.containers : {};
  const containers = Object.fromEntries(CONTAINER_IDS.map((containerId) => [
    containerId,
    Array.isArray(rawContainers[containerId]) ? rawContainers[containerId].filter(isRecord).map(cloneJson) : [],
  ]));
  const catalog = Array.isArray(context.catalog) ? context.catalog.filter(isRecord).map(cloneJson) : [];
  const catalogById = new Map(catalog.map((entry) => [normalizeId(entry.id), entry]));
  const capacitiesValid = isRecord(context.capacities) && CONTAINER_IDS.every((id) => (
    typeof context.capacities[id] === 'number' && Number.isFinite(context.capacities[id]) && context.capacities[id] >= 0
  ));
  return {
    containers,
    catalogById,
    capacitiesValid,
    capacities: Object.fromEntries(CONTAINER_IDS.map((id) => [id, capacitiesValid ? context.capacities[id] : 0])),
    carpentrySkill: boundedInteger(context.carpentrySkill, 0, 10, 0),
    totalMinutes: boundedInteger(context.totalMinutes, 0, MAX_HOUR * 60, 0),
    accessAllowed: context.accessAllowed === true,
    shelter: isRecord(context.shelter) ? cloneJson(context.shelter) : null,
  };
}

function validateCommand(state, command) {
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

function resolveMaterials(rawMaterials, containers) {
  if (!Array.isArray(rawMaterials) || rawMaterials.length !== 2) return { ok: false, reason: 'materials_mismatch' };
  const selections = rawMaterials.map((entry) => normalizeSelection(entry, true));
  if (selections.some((entry) => !entry)) return { ok: false, reason: 'materials_mismatch' };
  const uniqueRefs = new Set(selections.map((entry) => `${entry.containerId}\u0000${entry.stackId}`));
  if (uniqueRefs.size !== selections.length) return { ok: false, reason: 'materials_mismatch' };
  const resolved = [];
  for (const selection of selections) {
    const entry = findStack(containers, selection);
    if (!entry || positiveInteger(entry.count) < selection.count) return { ok: false, reason: 'stack_missing' };
    resolved.push({ ...selection, itemId: normalizeId(entry.id) });
  }
  const itemCounts = resolved.reduce((counts, entry) => ({
    ...counts,
    [entry.itemId]: (counts[entry.itemId] ?? 0) + entry.count,
  }), {});
  if (Object.keys(itemCounts).length !== 2 || itemCounts.plank !== 1 || itemCounts.nails !== 1) {
    return { ok: false, reason: 'materials_mismatch' };
  }
  return { ok: true, reason: null, selections: resolved };
}

function normalizeSelection(raw, requireCount) {
  if (!isRecord(raw)) return null;
  const containerId = normalizeId(raw.containerId);
  const stackId = normalizeRuntimeId(raw.stackId);
  if (!CONTAINER_ID_SET.has(containerId) || !stackId) return null;
  if (requireCount && raw.count !== 1) return null;
  return { containerId, stackId, ...(requireCount ? { count: 1 } : {}) };
}

function findStack(containers, selection) {
  return containers[selection.containerId]?.find((entry) => normalizeRuntimeId(entry.stackId) === selection.stackId) ?? null;
}

function transactionState(baseSecurity, containers) {
  return { baseSecurity: cloneJson(baseSecurity), containers: cloneJson(containers) };
}

function workFailure(reason, nextState, replayed = false) {
  return { ok: false, reason, replayed, nextState: cloneJson(nextState) };
}

function distributeLegacyBarricades(openings, legacyBarricades) {
  let remaining = legacyBarricades;
  let sequence = 0;
  while (remaining > 0) {
    const opening = openings[sequence % openings.length];
    if (opening.barricade < opening.maxBarricade) {
      opening.barricade = Math.min(opening.maxBarricade, opening.barricade + 25);
      remaining -= 1;
    }
    sequence += 1;
    if (sequence > 1_000) break;
  }
}

function securityPressure(raw = {}) {
  const exteriorPopulation = boundedInteger(raw.exteriorPopulation, 0, 100_000, 0);
  const threat = boundedNumber(raw.threat, 0, 100, 0);
  const noise = boundedNumber(raw.noise, 0, 100, 0);
  const day = boundedInteger(raw.day, 1, 10_000, 1);
  const shelterDefense = boundedNumber(raw.shelterDefense ?? raw.shelter?.defense, 0, 20, 0);
  const generator = raw.generatorOn === true ? 12 : 0;
  const populationPressure = Math.min(100, exteriorPopulation) * 0.28;
  const rawPressure = threat * 0.45 + noise * 0.22 + populationPressure + Math.min(30, day) * 0.8 + generator;
  const pressure = exteriorPopulation <= 0 ? 0 : Math.round(clamp(rawPressure - shelterDefense * 3, 0, 100));
  return {
    pressure,
    sources: {
      threat: roundNumber(threat),
      noise: roundNumber(noise),
      generator,
      exteriorPopulation,
      shelterDefense: roundNumber(shelterDefense),
    },
  };
}

function normalizeIncident(raw) {
  if (!isRecord(raw)) return null;
  const openingId = normalizeId(raw.openingId);
  if (!OPENING_ID_SET.has(openingId) || !Number.isInteger(raw.hour) || raw.hour < 0 || !isRecord(raw.sources)) return null;
  return {
    hour: boundedInteger(raw.hour, 0, MAX_HOUR, 0),
    openingId,
    pressure: boundedInteger(raw.pressure, 0, 100, 0),
    damage: boundedInteger(raw.damage, 0, 100, 0),
    barricadeDamage: boundedInteger(raw.barricadeDamage, 0, 100, 0),
    integrityDamage: boundedInteger(raw.integrityDamage, 0, 100, 0),
    breached: Boolean(raw.breached),
    sources: {
      threat: roundNumber(boundedNumber(raw.sources.threat, 0, 100, 0)),
      noise: roundNumber(boundedNumber(raw.sources.noise, 0, 100, 0)),
      generator: boundedInteger(raw.sources.generator, 0, 12, 0),
      exteriorPopulation: boundedInteger(raw.sources.exteriorPopulation, 0, 100_000, 0),
      shelterDefense: roundNumber(boundedNumber(raw.sources.shelterDefense, 0, 20, 0)),
      roll: boundedInteger(raw.sources.roll, 0, 99, 0),
      attackChance: boundedInteger(raw.sources.attackChance, 0, 100, 0),
    },
  };
}

function deterministicPercent(seed, hour, channel) {
  const text = `${stableSeed(seed)}|${hour}|${channel}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

function stableSeed(value) {
  if (typeof value === 'string') return value.slice(0, 160);
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

function normalizeCommandLedger(rawLedger) {
  if (!Array.isArray(rawLedger)) return [];
  const seen = new Set();
  const result = [];
  rawLedger.forEach((rawId) => {
    const id = normalizeRuntimeId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  });
  return result.slice(-MAX_COMMAND_LEDGER);
}

function appendCommandId(ledger, commandId) {
  return [...ledger, commandId].slice(-MAX_COMMAND_LEDGER);
}

function usedSpace(inventory, catalogById) {
  return (Array.isArray(inventory) ? inventory : []).reduce((sum, entry) => {
    const catalogItem = catalogById.get(normalizeId(entry.id));
    const space = boundedNumber(entry.space ?? catalogItem?.space, 0, 100_000, 0);
    return sum + positiveInteger(entry.count) * space;
  }, 0);
}

function sumBy(entries, key) {
  return entries.reduce((sum, entry) => sum + entry[key], 0);
}

function minuteHour(totalMinutes) {
  return Math.floor(boundedInteger(totalMinutes, 0, MAX_HOUR * 60, 0) / 60);
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeRuntimeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return 0;
  return Math.min(MAX_ITEM_COUNT, number);
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

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
