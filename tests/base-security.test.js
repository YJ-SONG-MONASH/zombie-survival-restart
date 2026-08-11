import { describe, expect, it } from 'vitest';
import {
  BASE_SECURITY_VERSION,
  advanceBaseSecurity,
  createBaseSecurity,
  normalizeBaseSecurity,
  previewBaseWork,
  resolveBaseWork,
  summarizeBaseSecurity,
} from '../src/services/base-security.js';

const catalog = [
  { id: 'hammer', category: 'tool', space: 2 },
  { id: 'plank', category: 'base', space: 2 },
  { id: 'nails', category: 'base', space: 1 },
];

function stack(id, count = 1, suffix = id) {
  return { ...catalog.find((item) => item.id === id), count, stackId: `stack:${suffix}` };
}

function workContext(overrides = {}) {
  return {
    containers: {
      carry: [stack('hammer'), stack('plank', 2), stack('nails', 2)],
      base: [],
    },
    catalog,
    capacities: { carry: 100, base: 100 },
    carpentrySkill: 3,
    totalMinutes: 480,
    accessAllowed: true,
    shelter: { id: 'starter_house', defense: 4 },
    ...overrides,
  };
}

function workCommand(state, overrides = {}) {
  return {
    commandId: `work-${state.revision + 1}`,
    expectedRevision: state.revision,
    openingId: 'front_window',
    kind: 'fortify',
    tool: { containerId: 'carry', stackId: 'stack:hammer' },
    materials: [
      { containerId: 'carry', stackId: 'stack:plank', count: 1 },
      { containerId: 'carry', stackId: 'stack:nails', count: 1 },
    ],
    ...overrides,
  };
}

function attackInput(overrides = {}) {
  return {
    fromTotalMinutes: 0,
    toTotalMinutes: 360,
    worldSeed: 90210,
    day: 7,
    threat: 100,
    noise: 100,
    generatorOn: true,
    exteriorPopulation: 80,
    shelterDefense: 0,
    ...overrides,
  };
}

describe('base security state', () => {
  it('creates a JSON-safe three-opening state at the current hour', () => {
    const state = createBaseSecurity({ shelter: { defense: 4 }, totalMinutes: 485 });
    expect(BASE_SECURITY_VERSION).toBe(1);
    expect(state).toEqual(JSON.parse(JSON.stringify(state)));
    expect(state).toMatchObject({ version: 1, revision: 0, lastProcessedHour: 8, appliedCommandIds: [], lastIncident: null });
    expect(state.openings.map((entry) => entry.id)).toEqual(['front_door', 'front_window', 'rear_window']);
    expect(state.openings.every((entry) => entry.integrity === entry.maxIntegrity && entry.barricade === 0)).toBe(true);
    expect(createBaseSecurity(null)).toEqual(createBaseSecurity());
  });

  it('migrates all twenty legacy barricades in a stable order without losing their value', () => {
    const first = createBaseSecurity({ legacyBarricades: 20 });
    const second = createBaseSecurity({ legacyBarricades: 20 });
    expect(first).toEqual(second);
    expect(first.openings.map((entry) => entry.barricade)).toEqual([200, 150, 150]);
    expect(first.openings.reduce((sum, entry) => sum + entry.barricade, 0)).toBe(20 * 25);
  });

  it('preserves every legacy fortification level in the projected base defense', () => {
    const state = createBaseSecurity({ legacyBarricades: 5 });
    const summary = summarizeBaseSecurity(state, { shelterDefense: 4 });
    expect(summary.legacyBaseProjection).toEqual({ barricades: 5, defense: 9 });
  });

  it('normalizes malformed and partial saves without mutating input', () => {
    const raw = {
      version: 99,
      revision: -2,
      lastProcessedHour: 'bad',
      appliedCommandIds: ['', 'same', 'same', 4],
      openings: [{ id: 'front_door', integrity: -4, maxIntegrity: 9999, barricade: 9999, maxBarricade: 30 }, { id: 'unknown' }],
      lastIncident: { hour: 'bad' },
    };
    const before = structuredClone(raw);
    const state = normalizeBaseSecurity(raw, { totalMinutes: 720 });
    expect(raw).toEqual(before);
    expect(state.revision).toBe(0);
    expect(state.lastProcessedHour).toBe(12);
    expect(state.appliedCommandIds).toEqual(['same']);
    expect(state.openings).toHaveLength(3);
    expect(state.openings[0]).toMatchObject({ integrity: 0, maxIntegrity: 1000, barricade: 30, maxBarricade: 30 });
    expect(state.lastIncident).toBeNull();
  });

  it('summarizes totals, status, weakest opening, safety, pressure, and legacy projection', () => {
    const state = createBaseSecurity({ legacyBarricades: 2 });
    state.openings[1].integrity -= 20;
    const summary = summarizeBaseSecurity(state, {
      threat: 60, noise: 20, day: 3, generatorOn: true, exteriorPopulation: 10, shelterDefense: 5, shelter: { defense: 5 },
    });
    expect(summary).toMatchObject({
      status: 'damaged',
      interiorSafe: true,
      breachedCount: 0,
      weakestOpeningId: 'front_window',
      exteriorPopulation: 10,
      legacyBarricades: 2,
    });
    expect(summary.currentPressure).toBeGreaterThan(0);
    expect(summary.totalBarricade).toBe(50);
    expect(summary.securityPercent).toBeGreaterThan(0);
  });
});

describe('base work transactions', () => {
  it('fortifies with exact materials, leaves the hammer, and commits one revision', () => {
    const state = createBaseSecurity({ totalMinutes: 480 });
    const result = resolveBaseWork(state, workCommand(state), workContext());
    expect(result).toMatchObject({
      ok: true,
      reason: null,
      replayed: false,
      kind: 'fortify',
      openingId: 'front_window',
      minutes: 90,
      noiseDelta: 12,
      skillXp: 18,
      barricadeDelta: 41,
      integrityDelta: 0,
    });
    expect(result.nextState.baseSecurity).toMatchObject({ revision: 1, appliedCommandIds: ['work-1'] });
    expect(result.nextState.baseSecurity.openings[1].barricade).toBe(41);
    expect(result.nextState.containers.carry.find((entry) => entry.id === 'hammer')?.count).toBe(1);
    expect(result.nextState.containers.carry.find((entry) => entry.id === 'plank')?.count).toBe(1);
    expect(result.nextState.containers.carry.find((entry) => entry.id === 'nails')?.count).toBe(1);
  });

  it('repairs integrity with the shorter repair cost profile', () => {
    const state = createBaseSecurity();
    state.openings[0].integrity = 20;
    const result = resolveBaseWork(state, workCommand(state, { openingId: 'front_door', kind: 'repair' }), workContext());
    expect(result).toMatchObject({ ok: true, minutes: 60, noiseDelta: 8, skillXp: 14, integrityDelta: 36, barricadeDelta: 0 });
    expect(result.nextState.baseSecurity.openings[0].integrity).toBe(56);
  });

  it('requires structural repair before fortifying a breached opening without consuming anything', () => {
    const state = createBaseSecurity();
    state.openings[1].integrity = 0;
    const context = workContext();
    const command = workCommand(state);
    const expected = {
      baseSecurity: structuredClone(state),
      containers: structuredClone(context.containers),
    };

    const preview = previewBaseWork(state, command, context);
    const resolved = resolveBaseWork(state, command, context);
    expect(preview).toMatchObject({ ok: false, reason: 'repair_required', replayed: false });
    expect(resolved).toMatchObject({ ok: false, reason: 'repair_required', replayed: false });
    expect(preview.nextState).toEqual(expected);
    expect(resolved.nextState).toEqual(expected);
  });

  it('previews the exact projection without consuming revision or command id', () => {
    const state = createBaseSecurity();
    const context = workContext();
    const command = workCommand(state);
    const beforeState = structuredClone(state);
    const beforeContext = structuredClone(context);
    const preview = previewBaseWork(state, command, context);
    const resolved = resolveBaseWork(state, command, context);
    expect(preview.ok).toBe(true);
    expect(preview.nextState.baseSecurity.revision).toBe(0);
    expect(preview.nextState.baseSecurity.appliedCommandIds).toEqual([]);
    expect(preview.nextState.baseSecurity.openings).toEqual(resolved.nextState.baseSecurity.openings);
    expect(preview.nextState.containers).toEqual(resolved.nextState.containers);
    expect(state).toEqual(beforeState);
    expect(context).toEqual(beforeContext);
  });

  it('rejects duplicate commands before stale revisions with a complete zero-change state', () => {
    const state = createBaseSecurity();
    state.revision = 2;
    state.appliedCommandIds = ['repeat'];
    const context = workContext();
    const result = resolveBaseWork(state, workCommand(state, { commandId: 'repeat', expectedRevision: 0 }), context);
    expect(result).toMatchObject({ ok: false, reason: 'duplicate_command', replayed: true });
    expect(result.nextState).toEqual({ baseSecurity: normalizeBaseSecurity(state, context), containers: context.containers });
  });

  it('rejects stale revisions atomically', () => {
    const state = createBaseSecurity();
    const result = resolveBaseWork(state, workCommand(state, { expectedRevision: 9 }), workContext());
    expect(result).toMatchObject({ ok: false, reason: 'stale_revision', replayed: false });
    expect(result.nextState.baseSecurity).toEqual(state);
  });

  it('requires safehouse access', () => {
    const state = createBaseSecurity();
    expect(resolveBaseWork(state, workCommand(state), workContext({ accessAllowed: false })).reason).toBe('access_denied');
  });

  it('requires the exact selected, usable hammer without consuming it', () => {
    const state = createBaseSecurity();
    const wrong = workCommand(state, { tool: { containerId: 'carry', stackId: 'stack:plank' } });
    expect(resolveBaseWork(state, wrong, workContext()).reason).toBe('hammer_required');
    const brokenContext = workContext();
    brokenContext.containers.carry[0].conditionState = { condition: { broken: true } };
    expect(resolveBaseWork(state, workCommand(state), brokenContext).reason).toBe('tool_broken');
  });

  it('requires exactly one plank and one nail selection', () => {
    const state = createBaseSecurity();
    const onlyPlank = workCommand(state, { materials: [{ containerId: 'carry', stackId: 'stack:plank', count: 1 }] });
    const tooManyNails = workCommand(state, { materials: [
      { containerId: 'carry', stackId: 'stack:plank', count: 1 },
      { containerId: 'carry', stackId: 'stack:nails', count: 2 },
    ] });
    expect(resolveBaseWork(state, onlyPlank, workContext()).reason).toBe('materials_mismatch');
    expect(resolveBaseWork(state, tooManyNails, workContext()).reason).toBe('materials_mismatch');
  });

  it('rejects missing and insufficient selected stacks without partial consumption', () => {
    const state = createBaseSecurity();
    const context = workContext();
    context.containers.carry.find((entry) => entry.id === 'nails').count = 0;
    const result = resolveBaseWork(state, workCommand(state), context);
    expect(result.reason).toBe('stack_missing');
    expect(result.nextState.containers).toEqual(context.containers);
    expect(result.nextState.baseSecurity).toEqual(state);
  });

  it('rejects malformed capacity context and pre-existing over-capacity inventories', () => {
    const state = createBaseSecurity();
    expect(resolveBaseWork(state, workCommand(state), workContext({ capacities: { carry: -1, base: 10 } })).reason).toBe('invalid_capacity');
    expect(resolveBaseWork(state, workCommand(state), workContext({ capacities: { carry: 2, base: 10 } })).reason).toBe('capacity_exceeded');
  });

  it('does not consume materials when the selected work is already complete', () => {
    const state = createBaseSecurity();
    state.openings[1].barricade = state.openings[1].maxBarricade;
    const context = workContext();
    const result = resolveBaseWork(state, workCommand(state), context);
    expect(result.reason).toBe('already_fortified');
    expect(result.nextState.containers).toEqual(context.containers);
  });

  it('bounds the replay ledger to the newest 64 command ids', () => {
    const state = createBaseSecurity();
    state.appliedCommandIds = Array.from({ length: 64 }, (_, index) => `old-${index}`);
    const result = resolveBaseWork(state, workCommand(state, { commandId: 'new' }), workContext());
    expect(result.nextState.baseSecurity.appliedCommandIds).toHaveLength(64);
    expect(result.nextState.baseSecurity.appliedCommandIds[0]).toBe('old-1');
    expect(result.nextState.baseSecurity.appliedCommandIds.at(-1)).toBe('new');
  });
});

describe('six-hour security observations', () => {
  it('never attacks when the exterior population is zero', () => {
    const state = createBaseSecurity();
    const result = advanceBaseSecurity(state, attackInput({ toTotalMinutes: 1_440, exteriorPopulation: 0 }));
    expect(result.processedObservationHours).toEqual([6, 12, 18, 24]);
    expect(result.incidents).toEqual([]);
    expect(result.events.every((event) => event.attacked === false && event.damage === 0)).toBe(true);
    expect(result.nextState.lastIncident).toBeNull();
    expect(result.nextState.revision).toBe(4);
  });

  it('applies barricade damage before structural damage', () => {
    const state = createBaseSecurity();
    state.openings.forEach((opening) => { opening.barricade = 100; });
    const result = advanceBaseSecurity(state, attackInput());
    expect(result.incidents).toHaveLength(1);
    const incident = result.incidents[0];
    expect(incident.barricadeDamage).toBe(incident.damage);
    expect(incident.integrityDamage).toBe(0);
    expect(result.nextState.openings.find((entry) => entry.id === incident.openingId).integrity)
      .toBe(state.openings.find((entry) => entry.id === incident.openingId).integrity);
  });

  it('marks a new breach once and does not repeatedly deduct an already broken opening', () => {
    const state = createBaseSecurity();
    state.openings.forEach((opening) => { opening.integrity = 0; opening.barricade = 0; });
    state.openings[0].integrity = 5;
    const first = advanceBaseSecurity(state, attackInput());
    expect(first.incidents[0]).toMatchObject({ openingId: 'front_door', integrityDamage: 5, breached: true });
    const second = advanceBaseSecurity(first.nextState, attackInput({ fromTotalMinutes: 360, toTotalMinutes: 720 }));
    expect(second.incidents).toEqual([]);
    expect(second.events[0]).toMatchObject({ attacked: false, damage: 0, openingId: null });
    expect(second.nextState.lastIncident).toEqual(first.nextState.lastIncident);
  });

  it('is state-and-event equivalent for one eight-hour advance and eight one-hour advances', () => {
    const initial = createBaseSecurity();
    const oneShot = advanceBaseSecurity(initial, attackInput({ toTotalMinutes: 480, threat: 72, noise: 36 }));
    let segmentedState = initial;
    const events = [];
    const incidents = [];
    for (let hour = 0; hour < 8; hour += 1) {
      const step = advanceBaseSecurity(segmentedState, attackInput({
        fromTotalMinutes: hour * 60,
        toTotalMinutes: (hour + 1) * 60,
        threat: 72,
        noise: 36,
      }));
      segmentedState = step.nextState;
      events.push(...step.events);
      incidents.push(...step.incidents);
    }
    expect(segmentedState).toEqual(oneShot.nextState);
    expect(events).toEqual(oneShot.events);
    expect(incidents).toEqual(oneShot.incidents);
  });

  it('is deterministic, JSON-safe, and does not mutate its inputs', () => {
    const state = createBaseSecurity({ legacyBarricades: 3 });
    const input = attackInput({ toTotalMinutes: 1_080 });
    const beforeState = structuredClone(state);
    const beforeInput = structuredClone(input);
    const first = advanceBaseSecurity(state, input);
    const second = advanceBaseSecurity(state, input);
    expect(first).toEqual(second);
    expect(first).toEqual(JSON.parse(JSON.stringify(first)));
    expect(state).toEqual(beforeState);
    expect(input).toEqual(beforeInput);
  });

  it('gives a strong shelter lower pressure and no more damage than a weak shelter', () => {
    const state = createBaseSecurity();
    const weak = advanceBaseSecurity(state, attackInput({ shelterDefense: 0 }));
    const strong = advanceBaseSecurity(state, attackInput({ shelterDefense: 20 }));
    expect(strong.events[0].pressure).toBeLessThan(weak.events[0].pressure);
    expect(strong.events[0].damage).toBeLessThanOrEqual(weak.events[0].damage);
  });

  it('stores a UI-explainable incident with all required source fields', () => {
    const result = advanceBaseSecurity(createBaseSecurity(), attackInput());
    expect(result.nextState.lastIncident).toMatchObject({
      hour: 6,
      openingId: expect.any(String),
      pressure: expect.any(Number),
      damage: expect.any(Number),
      barricadeDamage: expect.any(Number),
      integrityDamage: expect.any(Number),
      breached: expect.any(Boolean),
      sources: {
        threat: 100,
        noise: 100,
        generator: 12,
        exteriorPopulation: 80,
        shelterDefense: 0,
        roll: expect.any(Number),
        attackChance: expect.any(Number),
      },
    });
  });
});
