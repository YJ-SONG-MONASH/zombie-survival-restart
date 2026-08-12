export const LOCAL_PRESSURE_VERSION = 1;

const PRESSURE_SCALE = 100;
const MAX_PRESSURE_UNITS = 10_000;
const MAX_MINUTE = 1_000_000_000;
const MAX_REVISION = 1_000_000_000;
const MAX_ZOMBIES = 1_000_000;
const BOUNDARY_MINUTES = 6 * 60;
const MAX_EMISSION_LEDGER = 256;
const MAX_RECENT_MIGRATIONS = 32;
const NOISE_DECAY_UNITS_PER_MINUTE = 5;
const ACTIVITY_DECAY_UNITS_PER_MINUTE = 2;
const FIRST_HOP_PROPAGATION = 0.34;
const SECOND_HOP_PROPAGATION = 0.13;

export function createLocalPressureState(rawOptions = {}) {
  const options = record(rawOptions) ? rawOptions : {};
  const graph = normalizeGraph(options);
  const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, zeroSignal()]));
  seedInitialSignal(nodes, graph.nodeIds, options);
  return {
    version: LOCAL_PRESSURE_VERSION,
    revision: 0,
    lastProcessedMinute: boundedInteger(options.totalMinutes, 0, MAX_MINUTE, 0),
    appliedEmissionIds: [],
    nodes,
    recentMigrations: [],
  };
}

export function normalizeLocalPressureState(rawState, rawContext = {}) {
  const context = record(rawContext) ? rawContext : {};
  const graph = normalizeGraph(context);
  const fallback = createLocalPressureState({ ...context, nodes: graph.nodes, edges: graph.edges });
  if (!record(rawState)) return fallback;

  const rawNodes = record(rawState.nodes) ? rawState.nodes : null;
  const hasValidNodeMap = Boolean(rawNodes && graph.nodes.some((node) => record(rawNodes[node.id])));
  const nodes = Object.fromEntries(graph.nodes.map((node) => {
    const source = record(rawNodes?.[node.id]) ? rawNodes[node.id] : {};
    return [node.id, {
      noiseUnits: boundedInteger(source.noiseUnits, 0, MAX_PRESSURE_UNITS, 0),
      activityUnits: boundedInteger(source.activityUnits, 0, MAX_PRESSURE_UNITS, 0),
    }];
  }));
  if (!hasValidNodeMap) seedInitialSignal(nodes, graph.nodeIds, context);

  return {
    version: LOCAL_PRESSURE_VERSION,
    revision: boundedInteger(rawState.revision, 0, MAX_REVISION, 0),
    lastProcessedMinute: Number.isFinite(Number(rawState.lastProcessedMinute))
      && Number(rawState.lastProcessedMinute) >= 0
      && Number(rawState.lastProcessedMinute) <= MAX_MINUTE
      ? Math.round(Number(rawState.lastProcessedMinute))
      : boundedInteger(context.totalMinutes, 0, MAX_MINUTE, 0),
    appliedEmissionIds: normalizeIdLedger(rawState.appliedEmissionIds),
    nodes,
    recentMigrations: normalizeMigrationEvents(rawState.recentMigrations, graph.nodeIds),
  };
}

export function advanceLocalPressure(rawState, rawInput = {}) {
  const input = record(rawInput) ? rawInput : {};
  const graphValidation = validateGraphInput(input);
  const context = graphValidation.ok ? graphValidation.graph : normalizeGraph(input);
  const state = normalizeLocalPressureState(rawState, { ...input, nodes: context.nodes, edges: context.edges });
  const rawZombies = cloneJson(record(input.nodeZombieStates) ? input.nodeZombieStates : {});
  const zombies = normalizeZombieStates(rawZombies, context.nodes);
  const fallback = failureResult(state, zombies, graphValidation.reason);
  if (!graphValidation.ok) return fallback;

  const from = strictInteger(input.fromTotalMinutes, 0, MAX_MINUTE);
  const to = strictInteger(input.toTotalMinutes, 0, MAX_MINUTE);
  if (from === null || to === null) return failureResult(state, zombies, 'invalid_timeline');
  if (from !== state.lastProcessedMinute) return failureResult(state, zombies, 'timeline_mismatch');
  if (to < from) return failureResult(state, zombies, 'timeline_reversed');
  if (!record(input.nodeZombieStates) || context.nodes.some((node) => !record(input.nodeZombieStates[node.id]))) {
    return failureResult(state, zombies, 'invalid_zombie_states');
  }
  const emissionValidation = validateEmissions(input.emissions, context.nodeIds, from);
  if (!emissionValidation.ok) return failureResult(state, zombies, emissionValidation.reason);

  const lockedNodeIds = new Set(normalizeNodeIdList(input.lockedNodeIds, context.nodeIds));
  const worldSeed = stableSeed(input.worldSeed);
  const worldThreat = boundedNumber(input.worldThreat, 0, 100, 0);
  const nextState = cloneJson(state);
  const nextZombies = cloneJson(zombies);
  const appliedLedger = new Set(nextState.appliedEmissionIds);
  const pendingEmissions = emissionValidation.emissions
    .filter((emission) => emission.atMinutes <= to && !appliedLedger.has(emission.id))
    .sort(compareEmissions);
  const eventTimes = [...new Set([
    ...pendingEmissions.map((emission) => emission.atMinutes),
    ...boundariesAfter(from, to),
    to,
  ])].filter((minute) => minute >= from && minute <= to).sort((left, right) => left - right);
  const processedBoundaryMinutes = [];
  const events = [];
  let cursor = from;

  for (const minute of eventTimes) {
    decaySignals(nextState.nodes, minute - cursor);
    cursor = minute;
    pendingEmissions.filter((emission) => emission.atMinutes === minute).forEach((emission) => {
      applyEmission(nextState.nodes, emission, context);
      appliedLedger.add(emission.id);
    });
    if (minute > from && minute % BOUNDARY_MINUTES === 0) {
      processedBoundaryMinutes.push(minute);
      events.push(...resolveMigrationBoundary({
        minute,
        graph: context,
        signalNodes: nextState.nodes,
        nodeZombieStates: nextZombies,
        lockedNodeIds,
        worldSeed,
        worldThreat,
      }));
    }
  }

  nextState.lastProcessedMinute = to;
  nextState.appliedEmissionIds = [...appliedLedger].slice(-MAX_EMISSION_LEDGER);
  nextState.recentMigrations = [...nextState.recentMigrations, ...events].slice(-MAX_RECENT_MIGRATIONS);
  // Revision is an absolute-world timeline revision rather than an API-call
  // counter. This keeps save state identical whether the same interval is
  // advanced in one call or in arbitrarily sized chunks.
  nextState.revision = Math.min(MAX_REVISION, Math.max(nextState.revision, to));
  const totals = { before: zombieTotal(zombies), after: zombieTotal(nextZombies) };
  if (totals.before !== totals.after) return failureResult(state, zombies, 'population_not_conserved');
  return {
    ok: true,
    reason: null,
    nextState,
    nextNodeZombieStates: nextZombies,
    events: cloneJson(events),
    processedBoundaryMinutes,
    totals,
  };
}

export function summarizeLocalPressure(rawState, rawContext = {}) {
  const context = record(rawContext) ? rawContext : {};
  const graph = normalizeGraph(context);
  const state = normalizeLocalPressureState(rawState, { ...context, nodes: graph.nodes, edges: graph.edges });
  const nodes = graph.nodes.map((node) => {
    const signal = state.nodes[node.id] ?? zeroSignal();
    const noise = displayPoints(signal.noiseUnits);
    const activity = displayPoints(signal.activityUnits);
    return {
      nodeId: node.id,
      noise,
      activity,
      noiseBand: pressureBand(noise),
      activityBand: pressureBand(activity),
    };
  });
  const loudest = [...nodes].sort((left, right) => right.noise - left.noise || left.nodeId.localeCompare(right.nodeId))[0];
  const hottest = [...nodes].sort((left, right) => right.activity - left.activity || left.nodeId.localeCompare(right.nodeId))[0];
  return {
    version: state.version,
    revision: state.revision,
    lastProcessedMinute: state.lastProcessedMinute,
    nodes,
    hottestNodeId: hottest?.nodeId ?? null,
    loudestNodeId: loudest?.nodeId ?? null,
    totalNoise: round2(nodes.reduce((sum, node) => sum + node.noise, 0)),
    totalActivity: round2(nodes.reduce((sum, node) => sum + node.activity, 0)),
    recentMigrations: cloneJson(state.recentMigrations),
  };
}

function validateGraphInput(raw) {
  if (!record(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { ok: false, reason: 'invalid_graph', graph: normalizeGraph({}) };
  }
  const ids = raw.nodes.map((node) => normalizeId(node?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'invalid_graph', graph: normalizeGraph(raw) };
  }
  const idSet = new Set(ids);
  const invalidEdge = raw.edges.some((edge) => (
    !Array.isArray(edge) || edge.length !== 2 || !idSet.has(normalizeId(edge[0]))
    || !idSet.has(normalizeId(edge[1])) || normalizeId(edge[0]) === normalizeId(edge[1])
  ));
  if (invalidEdge) return { ok: false, reason: 'invalid_graph', graph: normalizeGraph(raw) };
  return { ok: true, reason: null, graph: normalizeGraph(raw) };
}

function normalizeGraph(raw = {}) {
  const nodes = [];
  const seenNodes = new Set();
  for (const candidate of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const id = normalizeId(candidate?.id);
    if (!id || seenNodes.has(id)) continue;
    seenNodes.add(id);
    nodes.push({ id, danger: boundedNumber(candidate?.danger, 0, 10, 0) });
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = [];
  const seenEdges = new Set();
  for (const candidate of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!Array.isArray(candidate) || candidate.length < 2) continue;
    const from = normalizeId(candidate[0]);
    const to = normalizeId(candidate[1]);
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) continue;
    const ordered = from.localeCompare(to) <= 0 ? [from, to] : [to, from];
    const key = `${ordered[0]}\u0000${ordered[1]}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(ordered);
  }
  edges.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
  const adjacency = Object.fromEntries(nodes.map((node) => [node.id, []]));
  edges.forEach(([from, to]) => {
    adjacency[from].push(to);
    adjacency[to].push(from);
  });
  Object.values(adjacency).forEach((neighbors) => neighbors.sort());
  return { nodes, edges, nodeIds, adjacency, dangerById: new Map(nodes.map((node) => [node.id, node.danger])) };
}

function validateEmissions(rawEmissions, nodeIds, fromMinute) {
  if (rawEmissions !== undefined && !Array.isArray(rawEmissions)) return { ok: false, reason: 'invalid_emissions', emissions: [] };
  const emissions = [];
  const seen = new Map();
  for (const raw of Array.isArray(rawEmissions) ? rawEmissions : []) {
    if (!record(raw)) return { ok: false, reason: 'invalid_emissions', emissions: [] };
    const id = normalizeRuntimeId(raw.id);
    const nodeId = normalizeId(raw.nodeId);
    const atMinutes = strictInteger(raw.atMinutes, 0, MAX_MINUTE);
    const noiseDelta = strictNumber(raw.noiseDelta, -100, 100, 0);
    const activityDelta = strictNumber(raw.activityDelta, -100, 100, 0);
    if (!id || !nodeIds.has(nodeId) || atMinutes === null || noiseDelta === null || activityDelta === null) {
      return { ok: false, reason: 'invalid_emissions', emissions: [] };
    }
    if (atMinutes < fromMinute) continue;
    const normalized = { id, nodeId, atMinutes, noiseDelta, activityDelta };
    const signature = JSON.stringify(normalized);
    if (seen.has(id) && seen.get(id) !== signature) return { ok: false, reason: 'conflicting_emission_id', emissions: [] };
    if (seen.has(id)) continue;
    seen.set(id, signature);
    emissions.push(normalized);
  }
  return { ok: true, reason: null, emissions };
}

function applyEmission(nodes, emission, graph) {
  applySignalDelta(nodes[emission.nodeId], emission.noiseDelta * PRESSURE_SCALE, emission.activityDelta * PRESSURE_SCALE);
  const firstHop = graph.adjacency[emission.nodeId] ?? [];
  firstHop.forEach((nodeId) => {
    applySignalDelta(nodes[nodeId], emission.noiseDelta * PRESSURE_SCALE * FIRST_HOP_PROPAGATION, 0);
  });
  const secondHop = new Set();
  firstHop.forEach((firstNodeId) => {
    (graph.adjacency[firstNodeId] ?? []).forEach((nodeId) => {
      if (nodeId !== emission.nodeId && !firstHop.includes(nodeId)) secondHop.add(nodeId);
    });
  });
  secondHop.forEach((nodeId) => {
    applySignalDelta(nodes[nodeId], emission.noiseDelta * PRESSURE_SCALE * SECOND_HOP_PROPAGATION, 0);
  });
}

function resolveMigrationBoundary({ minute, graph, signalNodes, nodeZombieStates, lockedNodeIds, worldSeed, worldThreat }) {
  const snapshot = cloneJson(nodeZombieStates);
  const proposals = [];
  for (const [leftId, rightId] of graph.edges) {
    if (lockedNodeIds.has(leftId) || lockedNodeIds.has(rightId)) continue;
    const leftSignal = signalNodes[leftId] ?? zeroSignal();
    const rightSignal = signalNodes[rightId] ?? zeroSignal();
    const leftEffective = effectiveAttraction(leftSignal, graph.dangerById.get(leftId), worldThreat);
    const rightEffective = effectiveAttraction(rightSignal, graph.dangerById.get(rightId), worldThreat);
    if (leftEffective === rightEffective) continue;
    const fromNodeId = leftEffective < rightEffective ? leftId : rightId;
    const toNodeId = fromNodeId === leftId ? rightId : leftId;
    const fromState = snapshot[fromNodeId];
    const toState = snapshot[toNodeId];
    if (!fromState || !toState || fromState.count <= 0 || toState.count >= toState.capacity) continue;
    const toSignal = signalNodes[toNodeId] ?? zeroSignal();
    const fromSignal = signalNodes[fromNodeId] ?? zeroSignal();
    const noiseGap = toSignal.noiseUnits - fromSignal.noiseUnits;
    if (noiseGap <= 0 || toSignal.noiseUnits <= 0) continue;
    const clearedToday = toState.clearedDay === dayForMinute(minute);
    const jitter = deterministicInteger(worldSeed, minute, leftId, rightId, 'threshold') % 351;
    const threshold = 900 + jitter + (clearedToday ? 1_800 : 0);
    const activityGap = toSignal.activityUnits - fromSignal.activityUnits;
    const dangerGap = (graph.dangerById.get(toNodeId) ?? 0) - (graph.dangerById.get(fromNodeId) ?? 0);
    const effectiveGap = Math.round(noiseGap + activityGap * 0.25 + dangerGap * 90 + worldThreat * 7);
    if (noiseGap < threshold || effectiveGap < threshold) continue;
    const available = Math.min(fromState.count, Math.max(0, toState.capacity - toState.count));
    const strength = Math.max(0, effectiveGap - threshold);
    const variation = deterministicInteger(worldSeed, minute, fromNodeId, toNodeId, 'count') % 3;
    const count = Math.min(available, Math.max(1, 1 + Math.floor(strength / 1_800) + Math.floor(worldThreat / 45) + variation));
    proposals.push({
      fromNodeId,
      toNodeId,
      count,
      noiseGap,
      effectiveGap,
      threshold,
      strength,
      edgeKey: `${leftId}|${rightId}`,
    });
  }

  proposals.sort((left, right) => right.strength - left.strength
    || left.edgeKey.localeCompare(right.edgeKey)
    || left.fromNodeId.localeCompare(right.fromNodeId));
  const sourceRemaining = new Map(graph.nodes.map((node) => [node.id, snapshot[node.id]?.count ?? 0]));
  const targetRemaining = new Map(graph.nodes.map((node) => [node.id,
    Math.max(0, (snapshot[node.id]?.capacity ?? 0) - (snapshot[node.id]?.count ?? 0))]));
  const allocations = [];
  for (const proposal of proposals) {
    const count = Math.min(
      proposal.count,
      sourceRemaining.get(proposal.fromNodeId) ?? 0,
      targetRemaining.get(proposal.toNodeId) ?? 0,
    );
    if (count <= 0) continue;
    sourceRemaining.set(proposal.fromNodeId, (sourceRemaining.get(proposal.fromNodeId) ?? 0) - count);
    targetRemaining.set(proposal.toNodeId, (targetRemaining.get(proposal.toNodeId) ?? 0) - count);
    allocations.push({ ...proposal, count });
  }

  return allocations.map((allocation) => {
    const source = nodeZombieStates[allocation.fromNodeId];
    const destination = nodeZombieStates[allocation.toNodeId];
    const sourceCountBefore = source.count;
    const destinationCountBefore = destination.count;
    source.count -= allocation.count;
    destination.count += allocation.count;
    if (destination.count > 0) {
      destination.clearedDay = null;
      destination.evasionUntilMinutes = Math.min(destination.evasionUntilMinutes ?? 0, minute);
    }
    if (source.count === 0) source.clearedDay = dayForMinute(minute);
    return {
      type: 'migration',
      boundaryMinute: minute,
      day: dayForMinute(minute),
      fromNodeId: allocation.fromNodeId,
      toNodeId: allocation.toNodeId,
      count: allocation.count,
      sourceCountBefore,
      sourceCountAfter: source.count,
      destinationCountBefore,
      destinationCountAfter: destination.count,
      noiseGap: round2(allocation.noiseGap / PRESSURE_SCALE),
      effectiveGap: round2(allocation.effectiveGap / PRESSURE_SCALE),
      threshold: round2(allocation.threshold / PRESSURE_SCALE),
      worldThreat: round2(worldThreat),
      reason: 'local_sound',
    };
  });
}

function effectiveAttraction(signal, danger, worldThreat) {
  return signal.noiseUnits + signal.activityUnits * 0.25 + boundedNumber(danger, 0, 10, 0) * 90 + worldThreat * 7;
}

function normalizeZombieStates(raw, nodes) {
  return Object.fromEntries(nodes.map((node) => {
    const source = record(raw?.[node.id]) ? cloneJson(raw[node.id]) : {};
    const rawCount = boundedInteger(source.count, 0, MAX_ZOMBIES, 0);
    const capacity = Math.max(
      rawCount,
      boundedInteger(source.capacity, 0, MAX_ZOMBIES, Math.max(1, rawCount)),
    );
    return [node.id, {
      ...source,
      nodeId: node.id,
      count: rawCount,
      capacity,
      clearedDay: nullableInteger(source.clearedDay, 1, 1_000_000),
      evasionUntilMinutes: boundedInteger(source.evasionUntilMinutes, 0, MAX_MINUTE, 0),
    }];
  }));
}

function normalizeMigrationEvents(rawEvents, nodeIds) {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents.map((raw) => normalizeMigrationEvent(raw, nodeIds)).filter(Boolean).slice(-MAX_RECENT_MIGRATIONS);
}

function normalizeMigrationEvent(raw, nodeIds) {
  if (!record(raw) || raw.type !== 'migration' || raw.reason !== 'local_sound') return null;
  const fromNodeId = normalizeId(raw.fromNodeId);
  const toNodeId = normalizeId(raw.toNodeId);
  if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId) || fromNodeId === toNodeId) return null;
  return {
    type: 'migration',
    boundaryMinute: boundedInteger(raw.boundaryMinute, 0, MAX_MINUTE, 0),
    day: boundedInteger(raw.day, 1, 1_000_000, 1),
    fromNodeId,
    toNodeId,
    count: boundedInteger(raw.count, 1, MAX_ZOMBIES, 1),
    sourceCountBefore: boundedInteger(raw.sourceCountBefore, 0, MAX_ZOMBIES, 0),
    sourceCountAfter: boundedInteger(raw.sourceCountAfter, 0, MAX_ZOMBIES, 0),
    destinationCountBefore: boundedInteger(raw.destinationCountBefore, 0, MAX_ZOMBIES, 0),
    destinationCountAfter: boundedInteger(raw.destinationCountAfter, 0, MAX_ZOMBIES, 0),
    noiseGap: round2(boundedNumber(raw.noiseGap, 0, 100, 0)),
    effectiveGap: round2(boundedNumber(raw.effectiveGap, 0, 200, 0)),
    threshold: round2(boundedNumber(raw.threshold, 0, 100, 0)),
    worldThreat: round2(boundedNumber(raw.worldThreat, 0, 100, 0)),
    reason: 'local_sound',
  };
}

function seedInitialSignal(nodes, nodeIds, options) {
  const nodeId = normalizeId(options.initialNodeId);
  if (!nodeIds.has(nodeId)) return;
  nodes[nodeId] = {
    noiseUnits: displayToUnits(options.initialNoise),
    activityUnits: displayToUnits(options.initialActivity),
  };
}

function normalizeIdLedger(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();
  raw.forEach((value) => {
    const id = normalizeRuntimeId(value);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  });
  return result.slice(-MAX_EMISSION_LEDGER);
}

function normalizeNodeIdList(raw, legalIds) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(normalizeId).filter((id) => legalIds.has(id)))];
}

function boundariesAfter(from, to) {
  const result = [];
  let boundary = Math.floor(from / BOUNDARY_MINUTES) * BOUNDARY_MINUTES + BOUNDARY_MINUTES;
  while (boundary <= to) {
    result.push(boundary);
    boundary += BOUNDARY_MINUTES;
  }
  return result;
}

function decaySignals(nodes, minutes) {
  const elapsed = boundedInteger(minutes, 0, MAX_MINUTE, 0);
  if (!elapsed) return;
  Object.values(nodes).forEach((signal) => {
    signal.noiseUnits = Math.max(0, signal.noiseUnits - elapsed * NOISE_DECAY_UNITS_PER_MINUTE);
    signal.activityUnits = Math.max(0, signal.activityUnits - elapsed * ACTIVITY_DECAY_UNITS_PER_MINUTE);
  });
}

function applySignalDelta(signal, noiseUnits, activityUnits) {
  signal.noiseUnits = boundedInteger(signal.noiseUnits + Math.round(noiseUnits), 0, MAX_PRESSURE_UNITS, signal.noiseUnits);
  signal.activityUnits = boundedInteger(signal.activityUnits + Math.round(activityUnits), 0, MAX_PRESSURE_UNITS, signal.activityUnits);
}

function compareEmissions(left, right) {
  return left.atMinutes - right.atMinutes || left.id.localeCompare(right.id) || left.nodeId.localeCompare(right.nodeId);
}

function failureResult(state, zombies, reason = 'invalid_input') {
  const totals = { before: zombieTotal(zombies), after: zombieTotal(zombies) };
  return {
    ok: false,
    reason: reason || 'invalid_input',
    nextState: cloneJson(state),
    nextNodeZombieStates: cloneJson(zombies),
    events: [],
    processedBoundaryMinutes: [],
    totals,
  };
}

function zombieTotal(states) {
  return Object.values(states).reduce((sum, state) => sum + boundedInteger(state?.count, 0, MAX_ZOMBIES, 0), 0);
}

function displayToUnits(value) {
  return Math.round(boundedNumber(value, 0, 100, 0) * PRESSURE_SCALE);
}

function displayPoints(units) {
  return round2(boundedInteger(units, 0, MAX_PRESSURE_UNITS, 0) / PRESSURE_SCALE);
}

function pressureBand(value) {
  if (value >= 75) return 'extreme';
  if (value >= 50) return 'high';
  if (value >= 25) return 'medium';
  if (value > 0) return 'low';
  return 'quiet';
}

function dayForMinute(minute) {
  return Math.floor(boundedInteger(minute, 0, MAX_MINUTE, 0) / (24 * 60)) + 1;
}

function deterministicInteger(...parts) {
  let hash = 0x811c9dc5;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function zeroSignal() {
  return { noiseUnits: 0, activityUnits: 0 };
}

function stableSeed(value) {
  if (typeof value === 'string') return value.slice(0, 160);
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeRuntimeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 240) : '';
}

function strictInteger(value, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) return null;
  return numeric;
}

function strictNumber(value, minimum, maximum, fallback = null) {
  if (value === undefined && fallback !== null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) return null;
  return numeric;
}

function nullableInteger(value, minimum, maximum) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) return null;
  return Math.round(numeric);
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

function round2(value) {
  return Math.round(value * 100) / 100;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
