import { describe, expect, it } from 'vitest';

import {
  EXPEDITION_VERSION,
  abandonExpedition,
  createExpeditionState,
  normalizeExpeditionState,
  previewExpeditionPlan,
  replanExpedition,
  resolveExpeditionEvent,
  startExpedition,
  summarizeExpedition,
} from '../src/services/expedition.js';
import { mapEdges, mapNodes } from '../src/data/zombie.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function knownContext(overrides = {}) {
  return {
    nodes: [
      { id: 'A', risk: 0 },
      { id: 'B', risk: 0 },
      { id: 'C', risk: 0 },
      { id: 'D', risk: 0 },
      { id: 'E', risk: 0 },
      { id: 'X', risk: 0 },
    ],
    edges: [
      { from: 'A', to: 'B', footMinutes: 50, workingMinutes: 20, damagedMinutes: 30, risk: 50 },
      { from: 'B', to: 'D', footMinutes: 50, workingMinutes: 20, damagedMinutes: 30, risk: 50 },
      { from: 'A', to: 'C', footMinutes: 75, workingMinutes: 30, damagedMinutes: 45, risk: 20 },
      { from: 'C', to: 'D', footMinutes: 75, workingMinutes: 30, damagedMinutes: 45, risk: 20 },
      { from: 'A', to: 'E', footMinutes: 110, workingMinutes: 40, damagedMinutes: 60, risk: 5 },
      { from: 'E', to: 'D', footMinutes: 110, workingMinutes: 40, damagedMinutes: 60, risk: 5 },
      { from: 'A', to: 'X', footMinutes: 300, workingMinutes: 100, damagedMinutes: 150, risk: 100 },
      { from: 'X', to: 'C', footMinutes: 30, workingMinutes: 10, damagedMinutes: 15, risk: 100 },
    ],
    currentNodeId: 'A',
    totalMinutes: 480,
    planningAllowed: true,
    vehicle: { status: 'none', fuel: 0 },
    inventory: [
      { id: 'water_bottle', count: 2, space: 1, tags: ['water'] },
      { id: 'canned_beans', count: 2, space: 1, category: 'food' },
      { id: 'bandage', count: 1, space: 1, category: 'medical', tags: ['bandage'] },
    ],
    capacity: 12,
    searchables: [
      { searchKey: 'D:crate', nodeId: 'D', searchMinutes: 60, exhausted: false },
      { searchKey: 'D:empty', nodeId: 'D', searchMinutes: 45, exhausted: true },
      { searchKey: 'C:crate', nodeId: 'C', searchMinutes: 45, exhausted: false },
    ],
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    commandId: 'start:1',
    expectedRevision: 0,
    mode: 'one_way',
    strategy: 'fastest',
    targetNodeId: 'D',
    ...overrides,
  };
}

function startOneWay(context = knownContext(), overrides = {}) {
  const result = startExpedition(createExpeditionState(), command(overrides), context);
  expect(result.ok).toBe(true);
  return result.nextState;
}

function startRoundTrip(context = knownContext(), overrides = {}) {
  const result = startExpedition(createExpeditionState(), command({
    mode: 'round_trip',
    targetSearchKey: 'D:crate',
    ...overrides,
  }), context);
  expect(result.ok).toBe(true);
  return result.nextState;
}

function progressRoundTripToObjective(state, context = knownContext()) {
  const first = resolveExpeditionEvent(state, {
    type: 'leg_completed',
    commandId: 'leg:A:B',
    expectedRevision: state.revision,
    fromNodeId: 'A',
    toNodeId: 'B',
    secured: true,
  }, context);
  expect(first.ok).toBe(true);
  const second = resolveExpeditionEvent(first.nextState, {
    type: 'leg_completed',
    commandId: 'leg:B:D',
    expectedRevision: first.nextState.revision,
    fromNodeId: 'B',
    toNodeId: 'D',
    secured: true,
  }, context);
  expect(second.ok).toBe(true);
  expect(second.nextState.active.phase).toBe('objective');
  return second.nextState;
}

function claimObjective(state, overrides = {}, context = knownContext({ currentNodeId: 'D' })) {
  return resolveExpeditionEvent(state, {
    type: 'loot_claimed',
    commandId: 'claim:D:crate',
    expectedRevision: state.revision,
    nodeId: 'D',
    searchKey: 'D:crate',
    claimedStacks: [{ stackId: 'loot-stack:1', id: 'plank', count: 1 }],
    ...overrides,
  }, context);
}

describe('expedition pure JSON state', () => {
  it('creates the complete v1 empty state', () => {
    expect(createExpeditionState()).toEqual({
      version: EXPEDITION_VERSION,
      revision: 0,
      nextSequence: 1,
      appliedCommandIds: [],
      active: null,
      history: [],
    });
  });

  it('normalizes malformed counters, command ids, and history bounds', () => {
    const raw = {
      version: 99,
      revision: -4,
      nextSequence: 0,
      appliedCommandIds: ['', 'a', 'a', 4, ...Array.from({ length: 80 }, (_, index) => `cmd:${index}`)],
      active: null,
      history: Array.from({ length: 40 }, (_, index) => ({
        id: `expedition:${index + 1}`,
        outcome: index % 2 ? 'completed' : 'aborted',
        mode: 'one_way',
        strategy: 'fastest',
        originNodeId: 'A',
        targetNodeId: 'D',
        objectiveState: 'reached',
        startedAtMinutes: index,
        endedAtMinutes: index + 1,
      })),
    };

    const normalized = normalizeExpeditionState(raw, knownContext());

    expect(normalized.version).toBe(1);
    expect(normalized.revision).toBe(0);
    expect(normalized.nextSequence).toBe(41);
    expect(normalized.appliedCommandIds).toHaveLength(64);
    expect(new Set(normalized.appliedCommandIds).size).toBe(64);
    expect(normalized.history).toHaveLength(24);
  });

  it('round-trips normalized state through JSON without changing it', () => {
    const state = startOneWay();
    const roundTripped = JSON.parse(JSON.stringify(state));
    expect(normalizeExpeditionState(roundTripped, knownContext())).toEqual(state);
  });

  it('drops an active expedition that references an unknown graph node', () => {
    const state = startOneWay();
    state.active.targetNodeId = 'SECRET';
    state.active.outboundPath = ['A', 'SECRET'];

    expect(normalizeExpeditionState(state, knownContext()).active).toBeNull();
  });

  it('drops an active expedition whose saved path contains a non-edge jump', () => {
    const state = startOneWay();
    state.active.outboundPath = ['A', 'D'];

    expect(normalizeExpeditionState(state, knownContext()).active).toBeNull();
  });
});

describe('deterministic route planning', () => {
  it('chooses the minimum-time route for fastest', () => {
    const preview = previewExpeditionPlan(createExpeditionState(), command(), knownContext());

    expect(preview.ok).toBe(true);
    expect(preview.plan.outboundPath).toEqual(['A', 'B', 'D']);
    expect(preview.plan.travelMinutes).toBe(100);
  });

  it('chooses the minimum-risk route for safest', () => {
    const preview = previewExpeditionPlan(createExpeditionState(), command({ strategy: 'safest' }), knownContext());

    expect(preview.ok).toBe(true);
    expect(preview.plan.outboundPath).toEqual(['A', 'E', 'D']);
    expect(preview.plan.riskScore).toBe(10);
  });

  it('chooses the middle trade-off route for balanced', () => {
    const preview = previewExpeditionPlan(createExpeditionState(), command({ strategy: 'balanced' }), knownContext());

    expect(preview.ok).toBe(true);
    expect(preview.plan.outboundPath).toEqual(['A', 'C', 'D']);
    expect(preview.plan.travelMinutes).toBe(150);
    expect(preview.plan.riskScore).toBe(40);
  });

  it('keeps the balanced route stable when callers rescale every risk value', () => {
    const base = previewExpeditionPlan(createExpeditionState(), command({ strategy: 'balanced' }), knownContext());
    const scaledContext = knownContext({
      edges: knownContext().edges.map((edge) => ({ ...edge, risk: edge.risk * 100 })),
    });
    const scaled = previewExpeditionPlan(createExpeditionState(), command({ strategy: 'balanced' }), scaledContext);

    expect(base.plan.outboundPath).toEqual(['A', 'C', 'D']);
    expect(scaled.plan.outboundPath).toEqual(base.plan.outboundPath);
  });

  it('offers three genuinely different live-map choices for a long risky expedition', () => {
    const context = {
      nodes: mapNodes.map((node) => ({ id: node.id, risk: node.danger ** 2 })),
      edges: mapEdges.map(([from, to]) => ({
        from,
        to,
        footMinutes: 180,
        workingMinutes: 60,
        damagedMinutes: 90,
        risk: 0,
      })),
      currentNodeId: 'west_point',
      totalMinutes: 480,
      planningAllowed: true,
      vehicle: { status: 'none', fuel: 0 },
      inventory: [],
      capacity: 30,
      searchables: [],
    };
    const preview = previewExpeditionPlan(createExpeditionState(), command({
      targetNodeId: 'prison_road',
      strategy: 'balanced',
    }), context);

    expect(preview.ok).toBe(true);
    expect(preview.uniqueRoutes).toHaveLength(3);
    const [fastest, safest, balanced] = preview.profiles;
    expect(fastest.travelMinutes).toBeLessThan(balanced.travelMinutes);
    expect(balanced.travelMinutes).toBeLessThan(safest.travelMinutes);
    expect(fastest.riskScore).toBeGreaterThan(balanced.riskScore);
    expect(balanced.riskScore).toBeGreaterThanOrEqual(safest.riskScore);
    expect(new Set(preview.profiles.map((profile) => profile.outboundPath.join('>'))).size).toBe(3);
  });

  it('deduplicates identical profile paths and reports routeSame honestly', () => {
    const context = knownContext({
      nodes: [{ id: 'A', risk: 0 }, { id: 'D', risk: 0 }],
      edges: [{ from: 'A', to: 'D', footMinutes: 90, risk: 5 }],
      searchables: [{ searchKey: 'D:crate', nodeId: 'D', searchMinutes: 60, exhausted: false }],
    });
    const preview = previewExpeditionPlan(createExpeditionState(), command(), context);

    expect(preview.ok).toBe(true);
    expect(preview.routeSame).toBe(true);
    expect(preview.uniqueRoutes).toHaveLength(1);
    expect(preview.uniqueRoutes[0].strategies).toEqual(['fastest', 'safest', 'balanced']);
    expect(preview.profiles.map((profile) => profile.duplicateOf)).toEqual([null, 'fastest', 'fastest']);
  });

  it('keeps three genuinely different profile routes separate', () => {
    const preview = previewExpeditionPlan(createExpeditionState(), command(), knownContext());

    expect(preview.routeSame).toBe(false);
    expect(preview.uniqueRoutes).toHaveLength(3);
    expect(preview.profiles.map((profile) => profile.outboundPath)).toEqual([
      ['A', 'B', 'D'],
      ['A', 'E', 'D'],
      ['A', 'C', 'D'],
    ]);
  });

  it('uses lexical path order as the final deterministic tie-break', () => {
    const context = knownContext({
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      edges: [
        { from: 'C', to: 'D', footMinutes: 50, risk: 10 },
        { from: 'A', to: 'C', footMinutes: 50, risk: 10 },
        { from: 'B', to: 'D', footMinutes: 50, risk: 10 },
        { from: 'A', to: 'B', footMinutes: 50, risk: 10 },
      ],
      searchables: [{ searchKey: 'D:crate', nodeId: 'D', searchMinutes: 60, exhausted: false }],
    });

    expect(previewExpeditionPlan(createExpeditionState(), command(), context).plan.outboundPath)
      .toEqual(['A', 'B', 'D']);
  });

  it('rejects a target omitted from the caller-sanitized graph without leaking it', () => {
    const state = createExpeditionState();
    const result = previewExpeditionPlan(state, command({ targetNodeId: 'SECRET' }), knownContext());

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'unknown_target', nextState: state }));
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('rejects a known but unreachable target atomically', () => {
    const context = knownContext({
      nodes: [{ id: 'A' }, { id: 'D' }],
      edges: [],
      searchables: [],
    });
    const state = createExpeditionState();

    expect(previewExpeditionPlan(state, command(), context)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'unreachable_target',
      nextState: state,
    }));
  });

  it('rejects planning a trip to the current origin', () => {
    const state = createExpeditionState();
    expect(previewExpeditionPlan(state, command({ targetNodeId: 'A' }), knownContext()))
      .toEqual(expect.objectContaining({ ok: false, reason: 'target_is_origin', nextState: state }));
  });

  it('requires an exact target search key for round trips', () => {
    const state = createExpeditionState();
    expect(previewExpeditionPlan(state, command({ mode: 'round_trip' }), knownContext()))
      .toEqual(expect.objectContaining({ ok: false, reason: 'target_search_required', nextState: state }));
  });

  it.each([
    ['D:missing', 'unknown_target_searchable'],
    ['C:crate', 'searchable_node_mismatch'],
    ['D:empty', 'target_search_exhausted'],
  ])('rejects invalid round-trip searchable %s', (targetSearchKey, reason) => {
    const state = createExpeditionState();
    expect(previewExpeditionPlan(state, command({ mode: 'round_trip', targetSearchKey }), knownContext()))
      .toEqual(expect.objectContaining({ ok: false, reason, nextState: state }));
  });

  it('includes outbound, return, and exact known search cost in the minimum ETA', () => {
    const preview = previewExpeditionPlan(createExpeditionState(), command({
      mode: 'round_trip',
      targetSearchKey: 'D:crate',
    }), knownContext());

    expect(preview.ok).toBe(true);
    expect(preview.plan.outboundPath).toEqual(['A', 'B', 'D']);
    expect(preview.plan.returnPath).toEqual(['D', 'B', 'A']);
    expect(preview.plan.travelMinutes).toBe(200);
    expect(preview.plan.objectiveMinutes).toBe(60);
    expect(preview.plan.minimumMinutes).toBe(260);
    expect(preview.plan.etaTotalMinutes).toBe(740);
    expect(preview.plan.minimumOnly).toBe(true);
  });

  it('projects vehicle fuel per leg and falls back to foot travel after depletion', () => {
    const context = knownContext({
      nodes: [{ id: 'P' }, { id: 'Q' }, { id: 'R' }, { id: 'S' }],
      edges: [
        { from: 'P', to: 'Q', footMinutes: 180, workingMinutes: 60, damagedMinutes: 90, risk: 1 },
        { from: 'Q', to: 'R', footMinutes: 180, workingMinutes: 60, damagedMinutes: 90, risk: 1 },
        { from: 'R', to: 'S', footMinutes: 180, workingMinutes: 60, damagedMinutes: 90, risk: 1 },
      ],
      currentNodeId: 'P',
      vehicle: { status: 'working', fuel: 2 },
      searchables: [],
    });
    const preview = previewExpeditionPlan(createExpeditionState(), command({ targetNodeId: 'S' }), context);

    expect(preview.ok).toBe(true);
    expect(preview.plan.travelMinutes).toBe(300);
    expect(preview.plan.fuel).toEqual(expect.objectContaining({
      starting: 2,
      used: 2,
      remaining: 0,
      vehicleLegs: 2,
      footLegs: 1,
      depletedAtNodeId: 'R',
      strandedAtNodeId: 'R',
    }));
  });

  it('keeps provisions and carrying capacity advisory instead of blocking a plan', () => {
    const context = knownContext({ inventory: [], capacity: 1 });
    const preview = previewExpeditionPlan(createExpeditionState(), command({
      mode: 'round_trip',
      targetSearchKey: 'D:crate',
    }), context);

    expect(preview.ok).toBe(true);
    expect(preview.plan.advisory.advisoryOnly).toBe(true);
    expect(preview.plan.advisory.deficits.water).toBeGreaterThan(0);
    expect(preview.plan.advisory.freeCapacity).toBe(1);
    expect(preview.plan.advisory.warnings.length).toBeGreaterThan(0);
    expect(startExpedition(createExpeditionState(), command({
      mode: 'round_trip',
      targetSearchKey: 'D:crate',
    }), context).ok).toBe(true);
  });
});

describe('expedition commands and lifecycle', () => {
  it('starts one active expedition and advances revision, sequence, and ledger', () => {
    const result = startExpedition(createExpeditionState(), command(), knownContext());

    expect(result.ok).toBe(true);
    expect(result.nextState).toEqual(expect.objectContaining({
      revision: 1,
      nextSequence: 2,
      appliedCommandIds: ['start:1'],
      history: [],
    }));
    expect(result.nextState.active).toEqual(expect.objectContaining({
      id: 'expedition:1',
      mode: 'one_way',
      strategy: 'fastest',
      originNodeId: 'A',
      targetNodeId: 'D',
      outboundPath: ['A', 'B', 'D'],
      returnPath: [],
      phase: 'outbound',
      legIndex: 0,
      objectiveState: 'pending',
      startedAtMinutes: 480,
    }));
  });

  it('rejects stale start commands with a deep-equal unchanged next state', () => {
    const state = createExpeditionState();
    const result = startExpedition(state, command({ expectedRevision: 1 }), knownContext());

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'stale_revision', nextState: state }));
    expect(result.nextState).toEqual(state);
  });

  it('rejects replayed commands before applying another mutation', () => {
    const state = startOneWay();
    const result = abandonExpedition(state, {
      commandId: 'start:1',
      expectedRevision: state.revision,
    }, knownContext());

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'duplicate_command',
      replayed: true,
      nextState: state,
    }));
  });

  it('rejects starting a second expedition without touching the active one', () => {
    const state = startOneWay();
    const result = startExpedition(state, command({ commandId: 'start:2', expectedRevision: 1 }), knownContext());

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'active_expedition', nextState: state }));
  });

  it('advances one exact planned leg', () => {
    const state = startOneWay();
    const result = resolveExpeditionEvent(state, {
      type: 'leg_completed',
      commandId: 'leg:A:B',
      expectedRevision: 1,
      fromNodeId: 'A',
      toNodeId: 'B',
      secured: true,
    }, knownContext());

    expect(result.ok).toBe(true);
    expect(result.nextState.revision).toBe(2);
    expect(result.nextState.active).toEqual(expect.objectContaining({ phase: 'outbound', legIndex: 1 }));
  });

  it('marks a valid unplanned neighbor move off route without teleporting', () => {
    const state = startOneWay();
    const result = resolveExpeditionEvent(state, {
      type: 'leg_completed',
      commandId: 'leg:A:X',
      expectedRevision: 1,
      fromNodeId: 'A',
      toNodeId: 'X',
      secured: true,
    }, knownContext());

    expect(result.ok).toBe(true);
    expect(result.nextState.active).toEqual(expect.objectContaining({
      phase: 'off_route',
      offRouteFromPhase: 'outbound',
      legIndex: 0,
    }));
  });

  it('replans an off-route outbound expedition from the caller current node', () => {
    const state = startOneWay();
    const offRoute = resolveExpeditionEvent(state, {
      type: 'leg_completed',
      commandId: 'leg:A:X',
      expectedRevision: 1,
      fromNodeId: 'A',
      toNodeId: 'X',
      secured: true,
    }, knownContext()).nextState;
    const result = replanExpedition(offRoute, {
      commandId: 'replan:X',
      expectedRevision: offRoute.revision,
      strategy: 'fastest',
    }, knownContext({ currentNodeId: 'X' }));

    expect(result.ok).toBe(true);
    expect(result.nextState.active).toEqual(expect.objectContaining({
      phase: 'outbound',
      legIndex: 0,
      outboundPath: ['X', 'C', 'D'],
    }));
  });

  it('waits at an unsecured one-way target until a node-secured event', () => {
    let state = startOneWay();
    state = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:A:B', expectedRevision: 1, fromNodeId: 'A', toNodeId: 'B', secured: true,
    }, knownContext()).nextState;
    const arrived = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:B:D', expectedRevision: 2, fromNodeId: 'B', toNodeId: 'D', secured: false,
    }, knownContext());

    expect(arrived.nextState.active).toEqual(expect.objectContaining({ phase: 'objective', targetSecured: false }));
    const secured = resolveExpeditionEvent(arrived.nextState, {
      type: 'node_secured', commandId: 'secure:D', expectedRevision: 3, nodeId: 'D', encounterId: 'encounter:1',
    }, knownContext({ currentNodeId: 'D' }));
    expect(secured.ok).toBe(true);
    expect(secured.nextState.active).toBeNull();
    expect(secured.nextState.history.at(-1)).toEqual(expect.objectContaining({ outcome: 'completed', objectiveState: 'reached' }));
  });

  it('completes a one-way plan immediately when arrival is already secured', () => {
    let state = startOneWay();
    state = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:A:B', expectedRevision: 1, fromNodeId: 'A', toNodeId: 'B', secured: true,
    }, knownContext()).nextState;
    const completed = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:B:D', expectedRevision: 2, fromNodeId: 'B', toNodeId: 'D', secured: true,
    }, knownContext());

    expect(completed.ok).toBe(true);
    expect(completed.completed).toBe(true);
    expect(completed.nextState.active).toBeNull();
  });

  it('rejects a round-trip claim from the wrong exact search key', () => {
    const state = progressRoundTripToObjective(startRoundTrip());
    const result = claimObjective(state, { searchKey: 'D:other', commandId: 'claim:wrong' });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'objective_search_mismatch', nextState: state }));
  });

  it('rejects a claim without a non-empty exact stack id', () => {
    const state = progressRoundTripToObjective(startRoundTrip());
    const result = claimObjective(state, {
      commandId: 'claim:empty',
      claimedStacks: [{ stackId: '', id: 'plank', count: 1 }],
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'claimed_stack_required', nextState: state }));
  });

  it('records exact claimed stack ids and begins the real return route', () => {
    const state = progressRoundTripToObjective(startRoundTrip());
    const result = claimObjective(state, {
      claimedStacks: [
        { stackId: 'loot-stack:1', id: 'plank', count: 1 },
        { stackId: 'loot-stack:2', id: 'nails', count: 2 },
        { stackId: 'loot-stack:1', id: 'plank', count: 1 },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.nextState.active).toEqual(expect.objectContaining({
      phase: 'returning',
      legIndex: 0,
      objectiveState: 'claimed',
      claimedStackIds: ['loot-stack:1', 'loot-stack:2'],
      returnPath: ['D', 'B', 'A'],
    }));
  });

  it('allows an exhausted exact target to return as a failed supply objective', () => {
    const state = progressRoundTripToObjective(startRoundTrip());
    const result = resolveExpeditionEvent(state, {
      type: 'container_exhausted',
      commandId: 'empty:D:crate',
      expectedRevision: state.revision,
      nodeId: 'D',
      searchKey: 'D:crate',
    }, knownContext({ currentNodeId: 'D' }));

    expect(result.ok).toBe(true);
    expect(result.nextState.active).toEqual(expect.objectContaining({
      phase: 'returning',
      objectiveState: 'exhausted',
      claimedStackIds: [],
    }));
  });

  it('completes a round trip only after both physical return legs reach the origin', () => {
    let state = progressRoundTripToObjective(startRoundTrip());
    state = claimObjective(state).nextState;
    const firstReturn = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'return:D:B', expectedRevision: state.revision, fromNodeId: 'D', toNodeId: 'B', secured: true,
    }, knownContext({ currentNodeId: 'D' }));
    expect(firstReturn.ok).toBe(true);
    expect(firstReturn.nextState.active).not.toBeNull();
    const completed = resolveExpeditionEvent(firstReturn.nextState, {
      type: 'leg_completed', commandId: 'return:B:A', expectedRevision: firstReturn.nextState.revision, fromNodeId: 'B', toNodeId: 'A', secured: true,
    }, knownContext({ currentNodeId: 'B' }));

    expect(completed.ok).toBe(true);
    expect(completed.completed).toBe(true);
    expect(completed.nextState.active).toBeNull();
    expect(completed.nextState.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'completed',
      mode: 'round_trip',
      objectiveState: 'claimed',
      claimedStackIds: ['loot-stack:1'],
      endedNodeId: 'A',
    }));
  });

  it('replans an off-route return toward the original node, not the target', () => {
    let state = progressRoundTripToObjective(startRoundTrip());
    state = claimObjective(state).nextState;
    const offRoute = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'return:D:E', expectedRevision: state.revision, fromNodeId: 'D', toNodeId: 'E', secured: true,
    }, knownContext({ currentNodeId: 'D' })).nextState;
    expect(offRoute.active.phase).toBe('off_route');
    const replanned = replanExpedition(offRoute, {
      commandId: 'replan:return:E', expectedRevision: offRoute.revision, strategy: 'fastest',
    }, knownContext({ currentNodeId: 'E' }));

    expect(replanned.ok).toBe(true);
    expect(replanned.nextState.active).toEqual(expect.objectContaining({
      phase: 'returning',
      returnPath: ['E', 'A'],
      legIndex: 0,
    }));
  });

  it('abandons without changing any external simulation state or refunding anything', () => {
    const state = startOneWay();
    const context = knownContext({ currentNodeId: 'B', totalMinutes: 900, vehicle: { status: 'working', fuel: 1 } });
    const contextBefore = clone(context);
    const result = abandonExpedition(state, {
      commandId: 'abandon:1', expectedRevision: state.revision,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.nextState.active).toBeNull();
    expect(result.nextState.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'aborted', endedAtMinutes: 900, endedNodeId: 'B',
    }));
    expect(context).toEqual(contextBefore);
  });

  it('rejects stale and duplicate lifecycle events with deep-equal next state', () => {
    const state = startOneWay();
    const first = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:A:B', expectedRevision: 1, fromNodeId: 'A', toNodeId: 'B', secured: true,
    }, knownContext());
    expect(first.ok).toBe(true);

    expect(resolveExpeditionEvent(first.nextState, {
      type: 'leg_completed', commandId: 'stale', expectedRevision: 1, fromNodeId: 'B', toNodeId: 'D', secured: true,
    }, knownContext())).toEqual(expect.objectContaining({
      ok: false, reason: 'stale_revision', nextState: first.nextState,
    }));
    expect(resolveExpeditionEvent(first.nextState, {
      type: 'leg_completed', commandId: 'leg:A:B', expectedRevision: 2, fromNodeId: 'B', toNodeId: 'D', secured: true,
    }, knownContext())).toEqual(expect.objectContaining({
      ok: false, reason: 'duplicate_command', replayed: true, nextState: first.nextState,
    }));
  });

  it('rejects a non-edge leg without changing expedition state', () => {
    const state = startOneWay();
    const result = resolveExpeditionEvent(state, {
      type: 'leg_completed', commandId: 'leg:A:D', expectedRevision: 1, fromNodeId: 'A', toNodeId: 'D', secured: true,
    }, knownContext());

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid_leg', nextState: state }));
  });

  it('summarizes next leg, objective, interruption, and history without owning simulation state', () => {
    const state = startRoundTrip();
    const summary = summarizeExpedition(state, knownContext({ tacticalActive: true }));

    expect(summary).toEqual(expect.objectContaining({
      active: true,
      id: 'expedition:1',
      phase: 'outbound',
      paused: true,
      pausedBy: 'tactical',
      currentNodeId: 'A',
      expectedNextNodeId: 'B',
      targetNodeId: 'D',
      targetSearchKey: 'D:crate',
      historyCount: 0,
    }));
  });

  it('never mutates raw state, command, event, or context inputs', () => {
    const state = createExpeditionState();
    const startCommand = command({ mode: 'round_trip', targetSearchKey: 'D:crate' });
    const context = knownContext();
    const before = clone({ state, startCommand, context });
    const started = startExpedition(state, startCommand, context);

    expect({ state, startCommand, context }).toEqual(before);
    const event = {
      type: 'leg_completed', commandId: 'leg:A:B', expectedRevision: 1, fromNodeId: 'A', toNodeId: 'B', secured: true,
    };
    const eventBefore = clone(event);
    const startedBefore = clone(started.nextState);
    resolveExpeditionEvent(started.nextState, event, context);
    expect(event).toEqual(eventBefore);
    expect(started.nextState).toEqual(startedBefore);
  });
});
