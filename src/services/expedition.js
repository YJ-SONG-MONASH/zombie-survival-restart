export const EXPEDITION_VERSION = 1;

const MAX_COMMAND_IDS = 64;
const MAX_HISTORY = 24;
const STRATEGIES = ['fastest', 'safest', 'balanced'];
const MODES = ['one_way', 'round_trip'];
const PHASES = ['outbound', 'objective', 'returning', 'off_route'];
const OBJECTIVE_STATES = ['pending', 'reached', 'claimed', 'exhausted'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value.trim().length > 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const numberAtLeast = (value, minimum, fallback) => (
  Number.isFinite(value) && value >= minimum ? value : fallback
);
const integerAtLeast = (value, minimum, fallback) => (
  Number.isInteger(value) && value >= minimum ? value : fallback
);

function uniqueStrings(values, limit = Infinity) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (!isId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result.slice(-limit);
}

function sanitizeContext(raw) {
  const source = isObject(raw) ? raw : {};
  const authoritativeGraph = Array.isArray(source.nodes);
  const nodes = [];
  const nodeIds = new Set();
  for (const candidate of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!isObject(candidate) || !isId(candidate.id) || nodeIds.has(candidate.id)) continue;
    nodeIds.add(candidate.id);
    nodes.push({ id: candidate.id, risk: numberAtLeast(candidate.risk, 0, 0) });
  }
  const nodeRisk = new Map(nodes.map((node) => [node.id, node.risk]));
  const edges = [];
  for (const candidate of Array.isArray(source.edges) ? source.edges : []) {
    if (!isObject(candidate) || !nodeIds.has(candidate.from) || !nodeIds.has(candidate.to)
      || candidate.from === candidate.to) continue;
    const footMinutes = numberAtLeast(candidate.footMinutes, 1, 180);
    edges.push({
      from: candidate.from,
      to: candidate.to,
      footMinutes,
      workingMinutes: numberAtLeast(candidate.workingMinutes, 1, Math.max(1, Math.round(footMinutes / 3))),
      damagedMinutes: numberAtLeast(candidate.damagedMinutes, 1, Math.max(1, Math.round(footMinutes / 2))),
      risk: numberAtLeast(candidate.risk, 0, 0),
    });
  }
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    adjacency.get(edge.from).push({ edge, to: edge.to });
    adjacency.get(edge.to).push({ edge, to: edge.from });
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => left.to < right.to ? -1 : left.to > right.to ? 1 : 0);
  }
  const searchables = [];
  const searchableKeys = new Set();
  for (const candidate of Array.isArray(source.searchables) ? source.searchables : []) {
    if (!isObject(candidate) || !isId(candidate.searchKey) || searchableKeys.has(candidate.searchKey)
      || !nodeIds.has(candidate.nodeId)) continue;
    searchableKeys.add(candidate.searchKey);
    searchables.push({
      searchKey: candidate.searchKey,
      nodeId: candidate.nodeId,
      searchMinutes: numberAtLeast(candidate.searchMinutes, 0, 0),
      exhausted: candidate.exhausted === true,
    });
  }
  const inventory = (Array.isArray(source.inventory) ? source.inventory : [])
    .filter(isObject)
    .map((item) => ({
      id: isId(item.id) ? item.id : '',
      count: numberAtLeast(item.count, 0, 0),
      space: numberAtLeast(item.space, 0, 0),
      category: isId(item.category) ? item.category : '',
      tags: uniqueStrings(item.tags),
    }));
  const vehicleStatus = ['working', 'damaged'].includes(source.vehicle?.status)
    ? source.vehicle.status
    : 'none';
  return {
    authoritativeGraph,
    nodes,
    nodeIds,
    nodeRisk,
    edges,
    adjacency,
    searchables,
    searchableByKey: new Map(searchables.map((item) => [item.searchKey, item])),
    currentNodeId: nodeIds.has(source.currentNodeId) ? source.currentNodeId : null,
    totalMinutes: numberAtLeast(source.totalMinutes, 0, 0),
    planningAllowed: source.planningAllowed === true,
    tacticalActive: source.tacticalActive === true,
    vehicle: {
      status: vehicleStatus,
      fuel: integerAtLeast(source.vehicle?.fuel, 0, 0),
    },
    inventory,
    capacity: numberAtLeast(source.capacity, 0, 0),
  };
}

function pathIsValid(path, graph, allowEmpty = false) {
  if (!Array.isArray(path) || (!allowEmpty && path.length === 0)) return false;
  if (allowEmpty && path.length === 0) return true;
  if (!path.every(isId)) return false;
  if (graph.authoritativeGraph && path.some((nodeId) => !graph.nodeIds.has(nodeId))) return false;
  if (!graph.authoritativeGraph) return true;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!(graph.adjacency.get(path[index]) || []).some(({ to }) => to === path[index + 1])) return false;
  }
  return true;
}

function normalizeHistoryRecord(raw, graph) {
  if (!isObject(raw) || !isId(raw.id) || !['completed', 'aborted'].includes(raw.outcome)
    || !MODES.includes(raw.mode) || !STRATEGIES.includes(raw.strategy)
    || !isId(raw.originNodeId) || !isId(raw.targetNodeId)) return null;
  if (graph.authoritativeGraph && (!graph.nodeIds.has(raw.originNodeId)
    || !graph.nodeIds.has(raw.targetNodeId)
    || (isId(raw.endedNodeId) && !graph.nodeIds.has(raw.endedNodeId)))) return null;
  return {
    id: raw.id,
    outcome: raw.outcome,
    mode: raw.mode,
    strategy: raw.strategy,
    originNodeId: raw.originNodeId,
    targetNodeId: raw.targetNodeId,
    targetSearchKey: raw.mode === 'round_trip' && isId(raw.targetSearchKey) ? raw.targetSearchKey : null,
    objectiveState: OBJECTIVE_STATES.includes(raw.objectiveState) ? raw.objectiveState : 'pending',
    claimedStackIds: uniqueStrings(raw.claimedStackIds),
    startedAtMinutes: numberAtLeast(raw.startedAtMinutes, 0, 0),
    endedAtMinutes: numberAtLeast(raw.endedAtMinutes, 0, 0),
    endedNodeId: isId(raw.endedNodeId) ? raw.endedNodeId : raw.originNodeId,
  };
}

function normalizeActive(raw, graph) {
  if (!isObject(raw) || !isId(raw.id) || !MODES.includes(raw.mode)
    || !STRATEGIES.includes(raw.strategy) || !isId(raw.originNodeId)
    || !isId(raw.targetNodeId) || raw.originNodeId === raw.targetNodeId
    || !PHASES.includes(raw.phase) || !OBJECTIVE_STATES.includes(raw.objectiveState)) return null;
  if (graph.authoritativeGraph && (!graph.nodeIds.has(raw.originNodeId) || !graph.nodeIds.has(raw.targetNodeId))) return null;
  const outboundPath = Array.isArray(raw.outboundPath) ? [...raw.outboundPath] : [];
  const returnPath = Array.isArray(raw.returnPath) ? [...raw.returnPath] : [];
  if (!pathIsValid(outboundPath, graph) || outboundPath.at(-1) !== raw.targetNodeId) return null;
  if (raw.mode === 'one_way' && returnPath.length !== 0) return null;
  if (raw.mode === 'round_trip' && (!pathIsValid(returnPath, graph) || returnPath.at(-1) !== raw.originNodeId)) return null;
  const route = raw.phase === 'returning' ? returnPath : outboundPath;
  const legIndex = integerAtLeast(raw.legIndex, 0, 0);
  if (['outbound', 'returning'].includes(raw.phase) && legIndex >= route.length) return null;
  const offRouteFromPhase = ['outbound', 'returning'].includes(raw.offRouteFromPhase)
    ? raw.offRouteFromPhase
    : null;
  if (raw.phase === 'off_route' && !offRouteFromPhase) return null;
  if (raw.mode === 'round_trip' && !isId(raw.targetSearchKey)) return null;
  return {
    id: raw.id,
    mode: raw.mode,
    strategy: raw.strategy,
    originNodeId: raw.originNodeId,
    targetNodeId: raw.targetNodeId,
    targetSearchKey: raw.mode === 'round_trip' ? raw.targetSearchKey : null,
    outboundPath,
    returnPath,
    phase: raw.phase,
    offRouteFromPhase,
    legIndex,
    objectiveState: raw.objectiveState,
    claimedStackIds: uniqueStrings(raw.claimedStackIds),
    targetSecured: raw.targetSecured === true,
    startedAtMinutes: numberAtLeast(raw.startedAtMinutes, 0, 0),
    lastProgressAtMinutes: numberAtLeast(raw.lastProgressAtMinutes, 0, 0),
  };
}

export function createExpeditionState() {
  return {
    version: EXPEDITION_VERSION,
    revision: 0,
    nextSequence: 1,
    appliedCommandIds: [],
    active: null,
    history: [],
  };
}

export function normalizeExpeditionState(rawState, context) {
  const raw = isObject(rawState) ? rawState : {};
  const graph = sanitizeContext(context);
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .map((record) => normalizeHistoryRecord(record, graph))
    .filter(Boolean)
    .slice(-MAX_HISTORY);
  const active = normalizeActive(raw.active, graph);
  const sequenceIds = [...history.map(({ id }) => id), active?.id]
    .filter(isId)
    .map((id) => /^expedition:(\d+)$/.exec(id))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const requiredSequence = sequenceIds.length > 0 ? Math.max(...sequenceIds) + 1 : 1;
  return {
    version: EXPEDITION_VERSION,
    revision: integerAtLeast(raw.revision, 0, 0),
    nextSequence: Math.max(integerAtLeast(raw.nextSequence, 1, 1), requiredSequence),
    appliedCommandIds: uniqueStrings(raw.appliedCommandIds, MAX_COMMAND_IDS),
    active,
    history,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const BALANCED_TIME_WEIGHT = 0.52;

function routeTuple(route, strategy, balance = null) {
  if (strategy === 'safest') {
    return [route.riskScore, route.travelMinutes, route.legs, route.pathKey];
  }
  if (strategy === 'balanced' && balance) {
    const timeScore = route.travelMinutes / balance.timeSpan;
    const riskScore = route.riskScore / balance.riskSpan;
    return [
      timeScore * BALANCED_TIME_WEIGHT + riskScore * (1 - BALANCED_TIME_WEIGHT),
      route.travelMinutes,
      route.riskScore,
      route.legs,
      route.pathKey,
    ];
  }
  return [route.travelMinutes, route.riskScore, route.legs, route.pathKey];
}

function compareRoutes(left, right, strategy, balance = null) {
  const leftTuple = routeTuple(left, strategy, balance);
  const rightTuple = routeTuple(right, strategy, balance);
  for (let index = 0; index < leftTuple.length; index += 1) {
    const comparison = typeof leftTuple[index] === 'string'
      ? compareText(leftTuple[index], rightTuple[index])
      : leftTuple[index] - rightTuple[index];
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function findRouteWithStrategy(graph, fromNodeId, toNodeId, strategy, vehicle, balance = null) {
  if (!graph.nodeIds.has(fromNodeId) || !graph.nodeIds.has(toNodeId)) return null;
  if (fromNodeId === toNodeId) {
    return {
      path: [fromNodeId],
      segments: [],
      travelMinutes: 0,
      riskScore: 0,
      legs: 0,
      fuelRemaining: vehicle.fuel,
      pathKey: fromNodeId,
    };
  }
  const initial = {
    nodeId: fromNodeId,
    fuelRemaining: vehicle.fuel,
    path: [fromNodeId],
    segments: [],
    travelMinutes: 0,
    riskScore: 0,
    legs: 0,
    pathKey: fromNodeId,
  };
  const queue = [initial];
  const best = new Map([[`${fromNodeId}\u0000${vehicle.fuel}`, initial]]);
  while (queue.length > 0) {
    queue.sort((left, right) => compareRoutes(left, right, strategy, balance));
    const current = queue.shift();
    const stateKey = `${current.nodeId}\u0000${current.fuelRemaining}`;
    if (best.get(stateKey) !== current) continue;
    if (current.nodeId === toNodeId) return current;
    for (const { edge, to } of graph.adjacency.get(current.nodeId) || []) {
      const usesVehicle = current.fuelRemaining > 0 && ['working', 'damaged'].includes(vehicle.status);
      const travelMode = usesVehicle ? vehicle.status : 'foot';
      const minutes = travelMode === 'working'
        ? edge.workingMinutes
        : travelMode === 'damaged' ? edge.damagedMinutes : edge.footMinutes;
      const fuelAfter = usesVehicle ? current.fuelRemaining - 1 : current.fuelRemaining;
      const candidate = {
        nodeId: to,
        fuelRemaining: fuelAfter,
        path: [...current.path, to],
        segments: [...current.segments, {
          fromNodeId: current.nodeId,
          toNodeId: to,
          travelMode,
          minutes,
          risk: edge.risk + (graph.nodeRisk.get(to) || 0),
          fuelBefore: current.fuelRemaining,
          fuelAfter,
        }],
        travelMinutes: current.travelMinutes + minutes,
        riskScore: current.riskScore + edge.risk + (graph.nodeRisk.get(to) || 0),
        legs: current.legs + 1,
        pathKey: `${current.pathKey}\u001f${to}`,
      };
      const candidateKey = `${to}\u0000${fuelAfter}`;
      const previous = best.get(candidateKey);
      if (!previous || compareRoutes(candidate, previous, strategy, balance) < 0) {
        best.set(candidateKey, candidate);
        queue.push(candidate);
      }
    }
  }
  return null;
}

function findRoute(graph, fromNodeId, toNodeId, strategy, vehicle = graph.vehicle) {
  if (strategy !== 'balanced') {
    return findRouteWithStrategy(graph, fromNodeId, toNodeId, strategy, vehicle);
  }
  const fastest = findRouteWithStrategy(graph, fromNodeId, toNodeId, 'fastest', vehicle);
  const safest = findRouteWithStrategy(graph, fromNodeId, toNodeId, 'safest', vehicle);
  if (!fastest || !safest) return null;
  if (fastest.pathKey === safest.pathKey) return fastest;
  return findRouteWithStrategy(graph, fromNodeId, toNodeId, 'balanced', vehicle, {
    // Time and danger use unrelated units. Normalizing against the two real
    // extremes keeps "balanced" meaningful for both tiny test graphs and the
    // live map instead of silently behaving like "fastest" as scales change.
    timeSpan: Math.max(1, Math.abs(safest.travelMinutes - fastest.travelMinutes)),
    riskSpan: Math.max(1, Math.abs(fastest.riskScore - safest.riskScore)),
  });
}

function fuelProjection(segments, vehicle) {
  const starting = vehicle.fuel;
  const vehicleSegments = segments.filter(({ travelMode }) => travelMode !== 'foot');
  const footSegments = segments.filter(({ travelMode }) => travelMode === 'foot');
  const depletion = segments.find(({ fuelBefore, fuelAfter }) => fuelBefore > 0 && fuelAfter === 0);
  return {
    starting,
    used: vehicleSegments.length,
    remaining: Math.max(0, starting - vehicleSegments.length),
    vehicleLegs: vehicleSegments.length,
    footLegs: footSegments.length,
    depletedAtNodeId: depletion?.toNodeId || null,
    strandedAtNodeId: depletion?.toNodeId || null,
  };
}

function inventoryAmount(graph, type) {
  return graph.inventory.reduce((total, item) => {
    const labels = [item.id, item.category, ...item.tags].map((value) => value.toLowerCase());
    const matches = type === 'medical'
      ? labels.some((label) => label.includes('medical') || label.includes('bandage') || label.includes('medkit'))
      : labels.some((label) => label.includes(type));
    return total + (matches ? item.count : 0);
  }, 0);
}

function buildAdvisory(graph, minimumMinutes, fuel) {
  const recommended = {
    water: Math.max(1, Math.ceil(minimumMinutes / 480)),
    food: Math.max(1, Math.ceil(minimumMinutes / 720)),
    medical: 1,
  };
  const available = {
    water: inventoryAmount(graph, 'water'),
    food: inventoryAmount(graph, 'food'),
    medical: inventoryAmount(graph, 'medical'),
  };
  const deficits = Object.fromEntries(Object.keys(recommended)
    .map((key) => [key, Math.max(0, recommended[key] - available[key])]));
  const load = graph.inventory.reduce((total, item) => total + item.count * item.space, 0);
  const freeCapacity = graph.capacity - load;
  const warnings = [];
  for (const [key, amount] of Object.entries(deficits)) {
    if (amount > 0) warnings.push(`insufficient_${key}`);
  }
  if (freeCapacity < 0) warnings.push('over_capacity');
  if (fuel.footLegs > 0 && fuel.starting > 0) warnings.push('vehicle_fuel_depletes');
  return {
    advisoryOnly: true,
    recommended,
    available,
    deficits,
    load,
    capacity: graph.capacity,
    freeCapacity,
    warnings,
  };
}

function failure(state, reason, replayed = false) {
  return {
    ok: false,
    reason,
    replayed,
    revision: state.revision,
    nextState: clone(state),
  };
}

function success(state, extras = {}) {
  return {
    ok: true,
    reason: null,
    replayed: false,
    revision: state.revision,
    nextState: clone(state),
    ...extras,
  };
}

function validatePlanRequest(state, request, graph) {
  const mode = MODES.includes(request?.mode) ? request.mode : null;
  const strategy = STRATEGIES.includes(request?.strategy) ? request.strategy : null;
  if (!mode) return failure(state, 'invalid_mode');
  if (!strategy) return failure(state, 'invalid_strategy');
  if (!graph.currentNodeId) return failure(state, 'unknown_origin');
  if (!isId(request?.targetNodeId) || !graph.nodeIds.has(request.targetNodeId)) {
    return failure(state, 'unknown_target');
  }
  if (request.targetNodeId === graph.currentNodeId) return failure(state, 'target_is_origin');
  let searchable = null;
  if (mode === 'round_trip') {
    if (!isId(request.targetSearchKey)) return failure(state, 'target_search_required');
    searchable = graph.searchableByKey.get(request.targetSearchKey);
    if (!searchable) return failure(state, 'unknown_target_searchable');
    if (searchable.nodeId !== request.targetNodeId) return failure(state, 'searchable_node_mismatch');
    if (searchable.exhausted) return failure(state, 'target_search_exhausted');
  }
  return { mode, strategy, searchable };
}

function buildProfile(graph, request, strategy, searchable) {
  const outbound = findRoute(graph, graph.currentNodeId, request.targetNodeId, strategy);
  if (!outbound) return null;
  let returning = null;
  if (request.mode === 'round_trip') {
    returning = findRoute(graph, request.targetNodeId, graph.currentNodeId, strategy, {
      status: graph.vehicle.status,
      fuel: outbound.fuelRemaining,
    });
    if (!returning) return null;
  }
  const returnPath = returning?.path || [];
  const outboundSegments = outbound.segments;
  const returnSegments = returning?.segments || [];
  const segments = [...outboundSegments, ...returnSegments];
  const travelMinutes = outbound.travelMinutes + (returning?.travelMinutes || 0);
  const objectiveMinutes = searchable?.searchMinutes || 0;
  const minimumMinutes = travelMinutes + objectiveMinutes;
  const fuel = fuelProjection(segments, graph.vehicle);
  return {
    strategy,
    mode: request.mode,
    originNodeId: graph.currentNodeId,
    targetNodeId: request.targetNodeId,
    targetSearchKey: request.mode === 'round_trip' ? request.targetSearchKey : null,
    outboundPath: outbound.path,
    returnPath,
    outboundSegments,
    returnSegments,
    travelMinutes,
    riskScore: outbound.riskScore + (returning?.riskScore || 0),
    objectiveMinutes,
    minimumMinutes,
    etaTotalMinutes: graph.totalMinutes + minimumMinutes,
    minimumOnly: true,
    fuel,
    advisory: buildAdvisory(graph, minimumMinutes, fuel),
    duplicateOf: null,
  };
}

export function previewExpeditionPlan(rawState, request, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  const validation = validatePlanRequest(state, request, graph);
  if (validation.ok === false) return validation;
  const profiles = STRATEGIES.map((strategy) => buildProfile(graph, {
    mode: validation.mode,
    targetNodeId: request.targetNodeId,
    targetSearchKey: request.targetSearchKey,
  }, strategy, validation.searchable));
  if (profiles.some((profile) => !profile)) return failure(state, 'unreachable_target');
  const uniqueRoutes = [];
  const routeIndexes = new Map();
  for (const profile of profiles) {
    const routeKey = JSON.stringify([profile.outboundPath, profile.returnPath]);
    if (routeIndexes.has(routeKey)) {
      const unique = uniqueRoutes[routeIndexes.get(routeKey)];
      profile.duplicateOf = unique.strategy;
      unique.strategies.push(profile.strategy);
    } else {
      routeIndexes.set(routeKey, uniqueRoutes.length);
      uniqueRoutes.push({ ...clone(profile), strategies: [profile.strategy] });
    }
  }
  const plan = profiles.find(({ strategy }) => strategy === validation.strategy);
  return success(state, {
    plan: clone(plan),
    profiles: clone(profiles),
    uniqueRoutes: clone(uniqueRoutes),
    routeSame: uniqueRoutes.length === 1,
  });
}

function commandFailure(state, payload) {
  if (!isId(payload?.commandId)) return failure(state, 'command_id_required');
  if (state.appliedCommandIds.includes(payload.commandId)) return failure(state, 'duplicate_command', true);
  if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision !== state.revision) {
    return failure(state, 'stale_revision');
  }
  return null;
}

function applyCommand(state, commandId) {
  state.revision += 1;
  state.appliedCommandIds = uniqueStrings([...state.appliedCommandIds, commandId], MAX_COMMAND_IDS);
  return state;
}

function activeHistoryRecord(active, outcome, graph, endedNodeId, objectiveState = active.objectiveState) {
  return {
    id: active.id,
    outcome,
    mode: active.mode,
    strategy: active.strategy,
    originNodeId: active.originNodeId,
    targetNodeId: active.targetNodeId,
    targetSearchKey: active.targetSearchKey,
    objectiveState,
    claimedStackIds: [...active.claimedStackIds],
    startedAtMinutes: active.startedAtMinutes,
    endedAtMinutes: graph.totalMinutes,
    endedNodeId,
  };
}

function finishExpedition(state, commandId, graph, endedNodeId, objectiveState) {
  const active = state.active;
  state.history = [...state.history, activeHistoryRecord(active, 'completed', graph, endedNodeId, objectiveState)]
    .slice(-MAX_HISTORY);
  state.active = null;
  applyCommand(state, commandId);
  return success(state, { completed: true });
}

export function startExpedition(rawState, command, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  const commandError = commandFailure(state, command);
  if (commandError) return commandError;
  if (state.active) return failure(state, 'active_expedition');
  if (!graph.planningAllowed) return failure(state, 'planning_unavailable');
  const preview = previewExpeditionPlan(state, command, context);
  if (!preview.ok) return failure(state, preview.reason);
  const plan = preview.plan;
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  state.active = {
    id: `expedition:${sequence}`,
    mode: plan.mode,
    strategy: plan.strategy,
    originNodeId: plan.originNodeId,
    targetNodeId: plan.targetNodeId,
    targetSearchKey: plan.targetSearchKey,
    outboundPath: [...plan.outboundPath],
    returnPath: [...plan.returnPath],
    phase: 'outbound',
    offRouteFromPhase: null,
    legIndex: 0,
    objectiveState: 'pending',
    claimedStackIds: [],
    targetSecured: false,
    startedAtMinutes: graph.totalMinutes,
    lastProgressAtMinutes: graph.totalMinutes,
  };
  applyCommand(state, command.commandId);
  return success(state, { plan });
}

function edgeExists(graph, fromNodeId, toNodeId) {
  return graph.nodeIds.has(fromNodeId) && graph.nodeIds.has(toNodeId)
    && (graph.adjacency.get(fromNodeId) || []).some(({ to }) => to === toNodeId);
}

function objectiveEventMatches(active, event, graph) {
  return event.nodeId === active.targetNodeId
    && event.searchKey === active.targetSearchKey
    && graph.currentNodeId === active.targetNodeId;
}

function resolveLeg(state, event, graph) {
  const active = state.active;
  if (active.phase === 'off_route') return failure(state, 'replan_required');
  if (!['outbound', 'returning'].includes(active.phase)) return failure(state, 'invalid_phase');
  const route = active.phase === 'outbound' ? active.outboundPath : active.returnPath;
  const expectedFrom = route[active.legIndex];
  const expectedTo = route[active.legIndex + 1];
  if (event.fromNodeId !== expectedFrom || !edgeExists(graph, event.fromNodeId, event.toNodeId)) {
    return failure(state, 'invalid_leg');
  }
  if (event.toNodeId !== expectedTo) {
    active.offRouteFromPhase = active.phase;
    active.phase = 'off_route';
    active.legIndex = 0;
    active.lastProgressAtMinutes = graph.totalMinutes;
    applyCommand(state, event.commandId);
    return success(state);
  }
  active.legIndex += 1;
  active.lastProgressAtMinutes = graph.totalMinutes;
  const arrived = active.legIndex === route.length - 1;
  if (!arrived) {
    applyCommand(state, event.commandId);
    return success(state);
  }
  if (active.phase === 'returning') {
    return finishExpedition(state, event.commandId, graph, active.originNodeId, active.objectiveState);
  }
  active.phase = 'objective';
  active.targetSecured = event.secured === true;
  if (active.mode === 'one_way' && active.targetSecured) {
    active.objectiveState = 'reached';
    return finishExpedition(state, event.commandId, graph, active.targetNodeId, 'reached');
  }
  applyCommand(state, event.commandId);
  return success(state);
}

function resolveNodeSecured(state, event, graph) {
  const active = state.active;
  if (active.phase !== 'objective' || event.nodeId !== active.targetNodeId
    || graph.currentNodeId !== active.targetNodeId || !isId(event.encounterId)) {
    return failure(state, 'objective_node_mismatch');
  }
  active.targetSecured = true;
  active.lastProgressAtMinutes = graph.totalMinutes;
  if (active.mode === 'one_way') {
    active.objectiveState = 'reached';
    return finishExpedition(state, event.commandId, graph, active.targetNodeId, 'reached');
  }
  applyCommand(state, event.commandId);
  return success(state);
}

function resolveLootClaim(state, event, graph) {
  const active = state.active;
  if (active.mode !== 'round_trip' || active.phase !== 'objective' || !active.targetSecured) {
    return failure(state, 'objective_not_ready');
  }
  if (!objectiveEventMatches(active, event, graph)) return failure(state, 'objective_search_mismatch');
  if (!Array.isArray(event.claimedStacks) || event.claimedStacks.length === 0
    || event.claimedStacks.some((stack) => !isObject(stack) || !isId(stack.stackId))) {
    return failure(state, 'claimed_stack_required');
  }
  active.claimedStackIds = uniqueStrings(event.claimedStacks.map(({ stackId }) => stackId));
  active.objectiveState = 'claimed';
  active.phase = 'returning';
  active.offRouteFromPhase = null;
  active.legIndex = 0;
  active.lastProgressAtMinutes = graph.totalMinutes;
  applyCommand(state, event.commandId);
  return success(state);
}

function resolveContainerExhausted(state, event, graph) {
  const active = state.active;
  if (active.mode !== 'round_trip' || active.phase !== 'objective' || !active.targetSecured) {
    return failure(state, 'objective_not_ready');
  }
  if (!objectiveEventMatches(active, event, graph)) return failure(state, 'objective_search_mismatch');
  active.claimedStackIds = [];
  active.objectiveState = 'exhausted';
  active.phase = 'returning';
  active.offRouteFromPhase = null;
  active.legIndex = 0;
  active.lastProgressAtMinutes = graph.totalMinutes;
  applyCommand(state, event.commandId);
  return success(state);
}

export function resolveExpeditionEvent(rawState, event, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  const commandError = commandFailure(state, event);
  if (commandError) return commandError;
  if (!state.active) return failure(state, 'no_active_expedition');
  if (event.type === 'leg_completed') return resolveLeg(state, event, graph);
  if (event.type === 'node_secured') return resolveNodeSecured(state, event, graph);
  if (event.type === 'loot_claimed') return resolveLootClaim(state, event, graph);
  if (event.type === 'container_exhausted') return resolveContainerExhausted(state, event, graph);
  return failure(state, 'unsupported_event');
}

export function replanExpedition(rawState, command, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  const commandError = commandFailure(state, command);
  if (commandError) return commandError;
  if (!state.active) return failure(state, 'no_active_expedition');
  if (!graph.planningAllowed) return failure(state, 'planning_unavailable');
  if (state.active.phase !== 'off_route') return failure(state, 'replan_not_required');
  if (!graph.currentNodeId) return failure(state, 'unknown_origin');
  const strategy = STRATEGIES.includes(command.strategy) ? command.strategy : state.active.strategy;
  const returning = state.active.offRouteFromPhase === 'returning';
  const destination = returning ? state.active.originNodeId : state.active.targetNodeId;
  if (graph.currentNodeId === destination) {
    if (returning) return finishExpedition(state, command.commandId, graph, destination, state.active.objectiveState);
    state.active.phase = 'objective';
    state.active.offRouteFromPhase = null;
    state.active.legIndex = 0;
    state.active.targetSecured = false;
    state.active.lastProgressAtMinutes = graph.totalMinutes;
    applyCommand(state, command.commandId);
    return success(state);
  }
  const route = findRoute(graph, graph.currentNodeId, destination, strategy);
  if (!route) return failure(state, 'unreachable_target');
  state.active.strategy = strategy;
  state.active.phase = returning ? 'returning' : 'outbound';
  state.active.offRouteFromPhase = null;
  state.active.legIndex = 0;
  state.active.lastProgressAtMinutes = graph.totalMinutes;
  if (returning) state.active.returnPath = [...route.path];
  else state.active.outboundPath = [...route.path];
  applyCommand(state, command.commandId);
  return success(state);
}

function logicalCurrentNode(active) {
  if (active.phase === 'objective') return active.targetNodeId;
  if (active.phase === 'outbound') return active.outboundPath[active.legIndex] || null;
  if (active.phase === 'returning') return active.returnPath[active.legIndex] || null;
  return null;
}

export function abandonExpedition(rawState, command, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  const commandError = commandFailure(state, command);
  if (commandError) return commandError;
  if (!state.active) return failure(state, 'no_active_expedition');
  const endedNodeId = graph.currentNodeId || logicalCurrentNode(state.active) || state.active.originNodeId;
  state.history = [...state.history,
    activeHistoryRecord(state.active, 'aborted', graph, endedNodeId)].slice(-MAX_HISTORY);
  state.active = null;
  applyCommand(state, command.commandId);
  return success(state, { completed: false });
}

export function summarizeExpedition(rawState, context) {
  const graph = sanitizeContext(context);
  const state = normalizeExpeditionState(rawState, context);
  if (!state.active) {
    return {
      active: false,
      paused: false,
      pausedBy: null,
      historyCount: state.history.length,
      lastHistory: state.history.length > 0 ? clone(state.history.at(-1)) : null,
    };
  }
  const active = state.active;
  const route = active.phase === 'outbound'
    ? active.outboundPath
    : active.phase === 'returning' ? active.returnPath : [];
  const currentNodeId = active.phase === 'off_route'
    ? graph.currentNodeId
    : logicalCurrentNode(active);
  return {
    active: true,
    id: active.id,
    mode: active.mode,
    strategy: active.strategy,
    phase: active.phase,
    objectiveState: active.objectiveState,
    paused: graph.tacticalActive,
    pausedBy: graph.tacticalActive ? 'tactical' : null,
    currentNodeId,
    expectedNextNodeId: ['outbound', 'returning'].includes(active.phase)
      ? route[active.legIndex + 1] || null
      : null,
    targetNodeId: active.targetNodeId,
    targetSearchKey: active.targetSearchKey,
    targetSecured: active.targetSecured,
    claimedStackIds: [...active.claimedStackIds],
    historyCount: state.history.length,
  };
}
