import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { mapNodeDetails, mapNodes, marketItems, shelters } from '../src/data/zombie.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function lootSlot(id, itemId) {
  const item = marketItems.find((entry) => entry.id === itemId);
  return {
    id,
    itemId,
    status: 'hidden',
    space: item.space,
    tier: item.tier,
    source: 'v10-start-gate',
  };
}

function secureNode(game, nodeId) {
  const state = game.ensureNodeZombieState(nodeId);
  state.count = 0;
  state.clearedDay = game.day;
  state.lastRefreshDay = game.day;
  state.evasionUntilMinutes = 0;
  return state;
}

function prepareSafeRun(game) {
  game.shelter = clone(shelters[0]);
  expect(game.initializeMapState()).toBe(true);
  secureNode(game, game.currentNodeId);
}

function searchableAt(nodeId, searchableId = null) {
  const searchables = gameForCanonicalLookup?.canonicalSceneSearchablesFor?.(nodeId)
    ?? mapNodeDetails[nodeId]?.searchables
    ?? [];
  return searchables.find((entry) => entry.id === searchableId) ?? searchables[0];
}

let gameForCanonicalLookup = null;

function expeditionCommand(game, kind, overrides = {}) {
  return {
    ...game.expeditionCommandToken(kind),
    ...overrides,
  };
}

function startPlan(game, overrides = {}) {
  const command = expeditionCommand(game, overrides.commandKind ?? 'start', {
    mode: 'one_way',
    strategy: 'fastest',
    targetNodeId: 'dixie_highway_north',
    ...overrides,
  });
  delete command.commandKind;
  const result = game.startExpedition(command);
  expect(result).toEqual(expect.objectContaining({ ok: true, reason: null }));
  return { command, result };
}

function openAndRevealAll(game, nodeId, searchable) {
  const key = searchable.searchKey ?? `${nodeId}:${searchable.id}`;
  const opened = game.openSceneLoot(searchable, key);
  expect(opened).toEqual(expect.objectContaining({ ok: true, searchKey: key }));
  const revealed = game.revealSceneLoot(searchable, {
    commandId: `reveal:${key}`,
    expectedRevision: opened.container.revision,
    slotIds: opened.container.slots.map((slot) => slot.slotId),
  }, key);
  expect(revealed).toEqual(expect.objectContaining({ ok: true, searchKey: key }));
  return { key, opened, revealed };
}

describe('v0.10 Store transaction release blockers', () => {
  let game;
  let localStorage;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    game = useGameStore();
    gameForCanonicalLookup = game;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    gameForCanonicalLookup = null;
  });

  it('atomically rejects setup-to-running initialization while bulk shelter search is pending', async () => {
    vi.useFakeTimers();
    game.shelter = clone(shelters[0]);
    game.lootSlots = [
      lootSlot('pending-water', 'water_bottle'),
      lootSlot('pending-food', 'canned_beans'),
    ];
    const pendingSearch = game.searchAllLootSlots();
    expect(game.searchingSlotId).toBe('bulk');
    const pendingState = clone(game.$state);

    expect(game.initializeMapState()).toBe(false);
    expect(game.$state).toEqual(pendingState);
    expect(game.initializeMapState(true)).toBe(false);
    expect(game.$state).toEqual(pendingState);
    expect(game.currentNodeId).toBeNull();

    await vi.advanceTimersByTimeAsync(800);
    expect(await pendingSearch).toBe(true);
    expect(game.searchingSlotId).toBeNull();
    expect(game.initializeMapState(true)).toBe(true);
    expect(game.currentNodeId).toBe(game.spawnLocation.id);
  });

  it('atomically rejects expedition planning from an unsecured world node', () => {
    prepareSafeRun(game);
    const unsafeNodeId = 'dixie_highway_north';
    const unsafeState = game.ensureNodeZombieState(unsafeNodeId);
    unsafeState.count = 2;
    expect(game.moveToNode(unsafeNodeId)).toBe(true);
    expect(game.currentNodeId).toBe(unsafeNodeId);
    game.nodeZombieStates[unsafeNodeId].count = 2;
    game.nodeZombieStates[unsafeNodeId].clearedDay = null;
    game.nodeZombieStates[unsafeNodeId].evasionUntilMinutes = 0;
    expect(game.isCurrentNodeSecured).toBe(false);
    const before = clone(game.$state);
    const command = expeditionCommand(game, 'unsafe-start', {
      mode: 'one_way',
      strategy: 'fastest',
      targetNodeId: 'muldraugh',
    });

    expect(game.previewExpeditionPlan(command)).toEqual(expect.objectContaining({ ok: true }));
    expect(game.$state).toEqual(before);
    expect(game.startExpedition(command)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'planning_unavailable',
    }));
    expect(game.$state).toEqual(before);
  });

  it('starts an automatically discovered horde at range while explicit attacks still commit near', () => {
    prepareSafeRun(game);
    const destinationId = game.currentNeighborNodes[0]?.id;
    const destinationState = game.ensureNodeZombieState(destinationId);
    destinationState.count = 12;
    destinationState.clearedDay = null;
    destinationState.evasionUntilMinutes = 0;
    game.currentNodeId = destinationId;

    expect(game.startTacticalEncounter()).toBe(true);
    expect(game.activeTacticalEncounter.escapeProgress).toBe(40);
    expect(game.activeTacticalEncounter.enemies).toHaveLength(12);
    expect(game.activeTacticalEncounter.enemies.every((enemy) => enemy.distance === 3)).toBe(true);

    setActivePinia(createPinia());
    const aggressive = useGameStore();
    prepareSafeRun(aggressive);
    const aggressiveNodeId = aggressive.currentNeighborNodes[0]?.id;
    const aggressiveState = aggressive.ensureNodeZombieState(aggressiveNodeId);
    aggressiveState.count = 12;
    aggressiveState.clearedDay = null;
    aggressiveState.evasionUntilMinutes = 0;
    aggressive.currentNodeId = aggressiveNodeId;

    expect(aggressive.startTacticalEncounter('combat_melee')).toBe(true);
    expect(aggressive.activeTacticalEncounter.escapeProgress).toBe(0);
    expect(aggressive.activeTacticalEncounter.enemies.some((enemy) => enemy.distance === 0)).toBe(true);
  });

  it('restores the complete Store snapshot when movement throws after partial mutation', () => {
    prepareSafeRun(game);
    const destinationId = game.currentNeighborNodes[0]?.id;
    expect(mapNodes.some((node) => node.id === destinationId)).toBe(true);
    delete game.nodeZombieStates[destinationId];
    const before = clone(game.$state);
    game.advanceSimulation = () => {
      throw new Error('injected movement failure');
    };

    expect(game.moveToNode(destinationId)).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('turns legacy quick search into a disabled location-details prompt with zero mutation', () => {
    prepareSafeRun(game);
    const searchAction = game.currentNodeActions.find((action) => action.id === 'search');
    expect(searchAction).toEqual(expect.objectContaining({
      label: '去查看地点',
      disabled: true,
      disabledReason: expect.stringContaining('查看地点'),
    }));
    const before = clone(game.$state);

    expect(game.resolveNodeAction('search')).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('runs a real round trip through move, exact claim, vehicle fuel, and physical return', () => {
    prepareSafeRun(game);
    const targetNodeId = 'dixie_highway_north';
    secureNode(game, targetNodeId);
    game.vehicle = {
      id: 'v10-test-car',
      status: 'working',
      fuel: 2,
      name: 'test car',
      condition: 100,
      nodeId: game.currentNodeId,
      trunkSpace: 25,
    };
    const searchable = searchableAt(targetNodeId, 'dixie_north_pump');
    const targetSearchKey = searchable.searchKey;
    const start = expeditionCommand(game, 'roundtrip', {
      mode: 'round_trip',
      strategy: 'fastest',
      targetNodeId,
      targetSearchKey,
    });
    expect(game.previewExpeditionPlan(start).plan.fuel).toEqual(expect.objectContaining({
      starting: 2,
      used: 2,
      remaining: 0,
    }));
    expect(game.startExpedition(start).ok).toBe(true);
    const afterStart = clone(game.$state);
    expect(game.startExpedition(start)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'duplicate_command',
      replayed: true,
    }));
    expect(game.$state).toEqual(afterStart);

    expect(game.moveToNode(targetNodeId)).toBe(true);
    expect(game.vehicle).toEqual(expect.objectContaining({ fuel: 1, nodeId: targetNodeId }));
    expect(game.expeditionSummary).toEqual(expect.objectContaining({
      phase: 'objective',
      targetSecured: true,
    }));
    const { key, revealed } = openAndRevealAll(game, targetNodeId, searchable);
    const claimedStack = revealed.summary.slots.find((slot) => slot.status === 'revealed').item;
    const claimed = game.claimSceneLoot(searchable, {
      commandId: 'claim:roundtrip',
      expectedRevision: revealed.nextState.revision,
      stackIds: [claimedStack.stackId],
    }, key);
    expect(claimed).toEqual(expect.objectContaining({ ok: true, expedition: expect.objectContaining({ ok: true }) }));
    expect(game.expeditionSummary).toEqual(expect.objectContaining({
      phase: 'returning',
      expectedNextNodeId: 'muldraugh',
      claimedStackIds: [claimedStack.stackId],
    }));

    expect(game.moveToNode('muldraugh')).toBe(true);
    expect(game.vehicle).toEqual(expect.objectContaining({ fuel: 0, nodeId: 'muldraugh' }));
    expect(game.expeditionSummary.active).toBe(false);
    expect(game.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'completed',
      objectiveState: 'claimed',
      endedNodeId: 'muldraugh',
      claimedStackIds: [claimedStack.stackId],
    }));
  });

  it('keeps a route paused during a tactical encounter and completes one-way only after node-secured', () => {
    prepareSafeRun(game);
    const targetNodeId = 'dixie_highway_north';
    const targetState = game.ensureNodeZombieState(targetNodeId);
    targetState.count = 1;
    targetState.clearedDay = null;
    targetState.evasionUntilMinutes = 0;
    startPlan(game, { targetNodeId });
    expect(game.moveToNode(targetNodeId)).toBe(true);
    expect(game.expeditionSummary).toEqual(expect.objectContaining({
      phase: 'objective',
      targetSecured: false,
    }));
    const expeditionBeforeTactical = clone(game.expedition);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    expect(game.expedition).toEqual(expeditionBeforeTactical);
    expect(game.expeditionSummary).toEqual(expect.objectContaining({ paused: true, pausedBy: 'tactical' }));

    const encounterId = game.activeTacticalEncounter.id;
    game.nodeZombieStates[targetNodeId].count = 0;
    game.nodeZombieStates[targetNodeId].clearedDay = game.day;
    game.activeTacticalEncounter.status = 'cleared';
    const secured = game.reconcileSecuredExpeditionNode(encounterId);
    expect(secured).toEqual(expect.objectContaining({ ok: true, completed: true }));
    expect(game.expeditionSummary.active).toBe(false);
    expect(game.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'completed',
      objectiveState: 'reached',
    }));
  });

  it('marks a manual detour off-route and replans from the physical current node', () => {
    prepareSafeRun(game);
    secureNode(game, 'muldraugh_crossroads');
    startPlan(game, { targetNodeId: 'dixie_highway_north' });

    expect(game.moveToNode('muldraugh_crossroads')).toBe(true);
    expect(game.expeditionSummary).toEqual(expect.objectContaining({
      phase: 'off_route',
      currentNodeId: 'muldraugh_crossroads',
    }));
    const replanned = game.replanExpedition(expeditionCommand(game, 'replan', { strategy: 'fastest' }));
    expect(replanned.ok).toBe(true);
    expect(game.expeditionPlan).toEqual(expect.objectContaining({
      phase: 'outbound',
      legIndex: 0,
      outboundPath: expect.arrayContaining(['muldraugh_crossroads', 'dixie_highway_north']),
    }));
    expect(game.expeditionPlan.outboundPath[0]).toBe('muldraugh_crossroads');
    expect(game.expeditionPlan.outboundPath.at(-1)).toBe('dixie_highway_north');
  });

  it('uses one canonical scene registry and atomically rejects parent, child, and presentation forgeries', () => {
    prepareSafeRun(game);
    const nodeId = 'dixie_highway_north';
    const registry = game.canonicalSceneSearchablesFor(nodeId);
    expect(registry.length).toBeGreaterThan(0);
    expect(new Set(registry.map((entry) => entry.searchKey)).size).toBe(registry.length);
    const descriptor = registry.find((entry) => entry.id === 'dixie_north_pump');
    expect(descriptor).toEqual(expect.objectContaining({
      parentSection: expect.any(String),
      parentId: expect.any(String),
      searchKey: expect.any(String),
    }));
    const targetSearchKey = descriptor.searchKey;
    const valid = expeditionCommand(game, 'nested-preview', {
      mode: 'round_trip',
      strategy: 'fastest',
      targetNodeId: nodeId,
      targetSearchKey,
      targetSearchable: descriptor,
    });
    expect(game.previewExpeditionPlan(valid)).toEqual(expect.objectContaining({ ok: true }));
    expect(game.worldLootContainers[targetSearchKey]).toBeUndefined();
    expect(game.startExpedition(valid)).toEqual(expect.objectContaining({ ok: true }));
    expect(game.expeditionPlan).toEqual(expect.objectContaining({ targetSearchKey }));

    const otherParent = mapNodeDetails[nodeId].buildings.find((entry) => entry.id !== descriptor.parentId);
    for (const forged of [
      {
        ...valid,
        targetSearchKey: `${nodeId}:${descriptor.parentSection}:${descriptor.parentId}:${descriptor.parentId}_forged`,
        targetSearchable: { ...descriptor, id: `${descriptor.parentId}_forged` },
      },
      {
        ...valid,
        targetSearchKey: `${nodeId}:building:${otherParent.id}:${descriptor.id}`,
        targetSearchable: { ...descriptor, parentSection: 'building', parentId: otherParent.id },
      },
      { ...valid, targetSearchable: { ...descriptor, quality: 'red' } },
      { ...valid, targetSearchable: { ...descriptor, name: '伪造金库' } },
      { ...valid, targetSearchable: { ...descriptor, assetId: 'tile_medical' } },
    ]) {
      const before = clone(game.$state);
      const result = game.previewExpeditionPlan(forged);
      expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'unknown_target_searchable' }));
      expect(game.$state).toEqual(before);
    }

    const rootOnly = Object.values(mapNodeDetails)
      .flatMap((detail) => game.canonicalSceneSearchablesFor(detail.nodeId))
      .find((entry) => !entry.parentId);
    expect(rootOnly).toEqual(expect.objectContaining({ searchKey: expect.any(String) }));
  });

  it('does not leak an unknown node id, name, danger marker, or descriptor through preview results', () => {
    prepareSafeRun(game);
    const unknownNode = mapNodes.find((node) => !game.knownNodeIds.includes(node.id));
    expect(unknownNode).toBeTruthy();
    const result = game.previewExpeditionPlan(expeditionCommand(game, 'secret', {
      mode: 'round_trip',
      strategy: 'fastest',
      targetNodeId: unknownNode.id,
      targetSearchKey: `${unknownNode.id}:TOP_SECRET_OBJECT`,
      targetSearchable: {
        id: 'TOP_SECRET_OBJECT',
        name: 'TOP_SECRET_NAME',
        description: 'TOP_SECRET_DANGER_999',
      },
    }));
    const serialized = JSON.stringify(result);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'unknown_target' }));
    expect(serialized).not.toContain(unknownNode.id);
    expect(serialized).not.toContain(unknownNode.name);
    expect(serialized).not.toContain('TOP_SECRET');
  });

  it('sanitizes unknown visible nodes and refuses inspection without exposing detail fields', () => {
    prepareSafeRun(game);
    const unknown = mapNodes.find((node) => !game.knownNodeIds.includes(node.id));
    expect(unknown).toBeTruthy();
    const visible = game.visibleMapNodeList.find((node) => node.id === unknown.id);
    expect(visible).toEqual({
      id: unknown.id,
      x: unknown.x,
      y: unknown.y,
      visibility: 'unknown',
      isAdjacent: false,
      canMove: false,
      displayName: '???',
      displayScale: 'normal',
      typeMeta: null,
    });
    expect(JSON.stringify(visible)).not.toContain(unknown.name);
    expect(JSON.stringify(visible)).not.toContain(unknown.resourceHint);
    expect(game.canonicalSceneSearchablesFor(unknown.id)).toEqual([]);
    const before = clone(game.$state);
    expect(game.inspectMapNode(unknown.id)).toBe(false);
    expect(game.$state).toEqual(before);
    game.inspectedNodeId = unknown.id;
    expect(game.inspectedMapNode).toBeNull();
    expect(game.inspectedNodeDetail).toBeNull();
  });

  it('uses danger squared with zero edge risk and produces a real fastest/safest route split', () => {
    prepareSafeRun(game);
    game.currentNodeId = 'riverside';
    game.inspectedNodeId = 'riverside';
    game.visitedNodeIds = ['riverside'];
    game.knownNodeIds = mapNodes.map((node) => node.id);
    secureNode(game, 'riverside');
    const preview = game.previewExpeditionPlan(expeditionCommand(game, 'strategy-split', {
      mode: 'one_way',
      strategy: 'balanced',
      targetNodeId: 'prison_road',
    }));
    expect(preview.ok).toBe(true);
    const fastest = preview.profiles.find((profile) => profile.strategy === 'fastest');
    const safest = preview.profiles.find((profile) => profile.strategy === 'safest');
    expect(fastest.outboundPath).not.toEqual(safest.outboundPath);
    expect(fastest.travelMinutes).toBeLessThan(safest.travelMinutes);
    expect(fastest.riskScore).toBeGreaterThan(safest.riskScore);
    for (const profile of [fastest, safest]) {
      for (const segment of profile.outboundSegments) {
        const destination = mapNodes.find((node) => node.id === segment.toNodeId);
        expect(segment.risk).toBe(destination.danger ** 2);
      }
    }
  });

  it('rolls back inventory, container, log, and expedition when the exact claim hook fails', () => {
    prepareSafeRun(game);
    const targetNodeId = 'dixie_highway_north';
    secureNode(game, targetNodeId);
    const searchable = searchableAt(targetNodeId);
    const targetSearchKey = searchable.searchKey;
    startPlan(game, { mode: 'round_trip', targetNodeId, targetSearchKey });
    expect(game.moveToNode(targetNodeId)).toBe(true);
    const { key, revealed } = openAndRevealAll(game, targetNodeId, searchable);
    const stackId = revealed.summary.slots.find((slot) => slot.status === 'revealed').item.stackId;
    const before = clone(game.$state);
    game.reconcileExpeditionEvent = () => ({
      ok: false,
      reason: 'injected_claim_hook_failure',
      replayed: false,
      revision: game.expedition.revision,
      nextState: clone(game.expedition),
    });

    const result = game.claimSceneLoot(searchable, {
      commandId: 'claim:rollback',
      expectedRevision: revealed.nextState.revision,
      stackIds: [stackId],
    }, key);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'injected_claim_hook_failure' }));
    expect(game.$state).toEqual(before);
  });

  it('rolls back the complete move when expedition leg reconciliation throws', () => {
    prepareSafeRun(game);
    secureNode(game, 'dixie_highway_north');
    startPlan(game);
    const before = clone(game.$state);
    game.reconcileExpeditionEvent = () => {
      throw new Error('injected expedition leg hook failure');
    };

    expect(game.moveToNode('dixie_highway_north')).toBe(false);
    expect(game.$state).toEqual(before);
  });

  it('round-trips active v10 state and migrates a v9 save to a normalized empty expedition', () => {
    prepareSafeRun(game);
    startPlan(game);
    const activeSave = clone(game.$state);
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: activeSave }));
    const restored = useGameStore(createPinia());
    restored.loadPersistedState();
    expect(restored.saveVersion).toBe(SAVE_VERSION);
    expect(restored.expedition).toEqual(game.expedition);

    const legacy = clone(activeSave);
    legacy.saveVersion = 9;
    delete legacy.expedition;
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: legacy }));
    const migrated = useGameStore(createPinia());
    migrated.loadPersistedState();
    expect(migrated.saveVersion).toBe(10);
    expect(migrated.expedition).toEqual({
      version: 1,
      revision: 0,
      nextSequence: 1,
      appliedCommandIds: [],
      active: null,
      history: [],
    });
  });

  it('repairs a loaded physical/cursor mismatch to off-route and permits replanning', () => {
    prepareSafeRun(game);
    game.knownNodeIds = [...new Set([...game.knownNodeIds, 'muldraugh_crossroads', 'dixie_highway_north'])];
    secureNode(game, 'muldraugh_crossroads');
    startPlan(game, { targetNodeId: 'dixie_highway_north' });
    const save = clone(game.$state);
    save.currentNodeId = 'muldraugh_crossroads';
    save.inspectedNodeId = 'muldraugh_crossroads';
    save.visitedNodeIds.push('muldraugh_crossroads');
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: save }));

    const restored = useGameStore(createPinia());
    restored.loadPersistedState();
    expect(restored.expeditionPlan).toEqual(expect.objectContaining({
      phase: 'off_route',
      offRouteFromPhase: 'outbound',
    }));
    const replanned = restored.replanExpedition(expeditionCommand(restored, 'load-replan', { strategy: 'safest' }));
    expect(replanned.ok).toBe(true);
    expect(restored.expeditionPlan.outboundPath[0]).toBe('muldraugh_crossroads');
  });

  it('archives ended and invalid-pending loaded expeditions while preserving a valid returning leg', () => {
    prepareSafeRun(game);
    const target = searchableAt('dixie_highway_north', 'dixie_north_pump');
    startPlan(game, {
      mode: 'round_trip',
      targetNodeId: 'dixie_highway_north',
      targetSearchKey: target.searchKey,
      targetSearchable: target,
    });
    const active = clone(game.$state);

    const ended = clone(active);
    ended.ending = { title: '旧结局' };
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: ended }));
    const restoredEnded = useGameStore(createPinia());
    restoredEnded.loadPersistedState();
    expect(restoredEnded.expedition.active).toBeNull();
    expect(restoredEnded.expedition.history.at(-1)).toEqual(expect.objectContaining({ outcome: 'aborted' }));

    const invalidPending = clone(active);
    invalidPending.expedition.active.targetSearchKey = 'dixie_highway_north:building:forged:forged';
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: invalidPending }));
    const restoredInvalid = useGameStore(createPinia());
    restoredInvalid.loadPersistedState();
    expect(restoredInvalid.expedition.active).toBeNull();
    expect(restoredInvalid.expedition.history.at(-1)).toEqual(expect.objectContaining({ outcome: 'aborted' }));

    const returning = clone(active);
    returning.currentNodeId = 'dixie_highway_north';
    returning.inspectedNodeId = 'dixie_highway_north';
    returning.visitedNodeIds.push('dixie_highway_north');
    returning.expedition.active.phase = 'returning';
    returning.expedition.active.legIndex = 0;
    returning.expedition.active.objectiveState = 'claimed';
    returning.expedition.active.targetSecured = true;
    returning.expedition.active.targetSearchKey = 'legacy:key:no-longer-listed';
    localStorage.values.set('moshi-survival-state', JSON.stringify({ game: returning }));
    const restoredReturning = useGameStore(createPinia());
    restoredReturning.loadPersistedState();
    expect(restoredReturning.expeditionPlan).toEqual(expect.objectContaining({
      phase: 'returning',
      objectiveState: 'claimed',
      targetSearchKey: 'legacy:key:no-longer-listed',
    }));
  });

  it('turns an already-empty exact objective into a physical return instead of locking the run', () => {
    prepareSafeRun(game);
    const nodeId = 'dixie_highway_north';
    secureNode(game, nodeId);
    const target = searchableAt(nodeId, 'dixie_north_pump');
    startPlan(game, {
      mode: 'round_trip',
      targetNodeId: nodeId,
      targetSearchKey: target.searchKey,
      targetSearchable: target,
    });
    expect(game.moveToNode(nodeId)).toBe(true);
    const opened = game.openSceneLoot(target, target.searchKey);
    expect(opened.ok).toBe(true);
    game.worldLootContainers[target.searchKey].slots = [];
    const exhausted = game.openSceneLoot(target, target.searchKey);
    expect(exhausted).toEqual(expect.objectContaining({
      ok: true,
      summary: expect.objectContaining({ exhausted: true }),
      expedition: expect.objectContaining({ ok: true }),
    }));
    expect(game.expeditionSummary).toEqual(expect.objectContaining({
      phase: 'returning',
      objectiveState: 'exhausted',
      expectedNextNodeId: 'muldraugh',
    }));
  });

  it('reconciles a one-way evacuation arrival before creating the victory ending', () => {
    prepareSafeRun(game);
    game.day = game.maxDay;
    game.currentNodeId = 'west_point';
    game.inspectedNodeId = 'west_point';
    game.visitedNodeIds = ['west_point'];
    game.knownNodeIds = ['west_point', 'valley_checkpoint'];
    secureNode(game, 'west_point');
    secureNode(game, 'valley_checkpoint');
    startPlan(game, { targetNodeId: 'valley_checkpoint' });

    expect(game.moveToNode('valley_checkpoint')).toBe(true);
    expect(game.ending).toEqual(expect.objectContaining({ victory: true }));
    expect(game.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'completed',
      objectiveState: 'reached',
      endedNodeId: 'valley_checkpoint',
    }));
  });

  it('reconciles a tactical evacuation clear before victory but archives a tactical death first', () => {
    prepareSafeRun(game);
    game.day = game.maxDay;
    game.currentNodeId = 'west_point';
    game.inspectedNodeId = 'west_point';
    game.visitedNodeIds = ['west_point'];
    game.knownNodeIds = ['west_point', 'valley_checkpoint'];
    secureNode(game, 'west_point');
    const checkpoint = game.ensureNodeZombieState('valley_checkpoint');
    checkpoint.count = 1;
    checkpoint.clearedDay = null;
    checkpoint.evasionUntilMinutes = 0;
    startPlan(game, { targetNodeId: 'valley_checkpoint' });
    expect(game.moveToNode('valley_checkpoint')).toBe(true);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    game.skills.strength = 10;
    game.skills.fitness = 10;
    const enemy = game.activeTacticalEncounter.enemies[0];
    enemy.hp = 1;
    enemy.posture = 'downed';
    enemy.distance = 0;
    const cleared = game.performTacticalAction('stomp', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
      targetId: enemy.id,
    });
    expect(cleared).toEqual(expect.objectContaining({ ok: true }));
    expect(game.ending).toEqual(expect.objectContaining({ victory: true }));
    expect(game.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'completed',
      objectiveState: 'reached',
    }));

    const fatal = useGameStore(createPinia());
    fatal.shelter = clone(shelters[0]);
    expect(fatal.initializeMapState()).toBe(true);
    secureNode(fatal, fatal.currentNodeId);
    const fatalTarget = 'dixie_highway_north';
    const fatalZombie = fatal.ensureNodeZombieState(fatalTarget);
    fatalZombie.count = 1;
    fatalZombie.clearedDay = null;
    fatalZombie.evasionUntilMinutes = 0;
    startPlan(fatal, { targetNodeId: fatalTarget });
    expect(fatal.moveToNode(fatalTarget)).toBe(true);
    expect(fatal.startTacticalEncounter('combat_melee')).toBe(true);
    fatal.body.wounds = [{
      id: 'terminal-bite',
      bodyPart: 'right_hand',
      type: 'bite',
      severity: 5,
      bleeding: false,
      bandaged: true,
      disinfected: true,
      infected: false,
      knoxInfection: true,
      ageHours: 4,
      source: 'test',
    }];
    fatal.body.infectionLevel = 99.99;
    const fatalAction = fatal.performTacticalAction('brace', {
      encounterId: fatal.activeTacticalEncounter.id,
      expectedTurn: fatal.activeTacticalEncounter.turn,
    });
    expect(fatalAction).toEqual(expect.objectContaining({ ok: true }));
    expect(fatal.ending).toEqual(expect.objectContaining({ victory: false }));
    expect(fatal.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'aborted',
      objectiveState: 'pending',
    }));
  });

  it('archives an active expedition as aborted before creating a death ending', () => {
    prepareSafeRun(game);
    startPlan(game);
    game.vitals.health = 0;

    expect(game.finishIfGameOver()).toBe(true);
    expect(game.ending).toEqual(expect.objectContaining({ title: expect.any(String) }));
    expect(game.expedition.active).toBeNull();
    expect(game.expedition.history.at(-1)).toEqual(expect.objectContaining({
      outcome: 'aborted',
      endedNodeId: game.currentNodeId,
    }));
  });
});
