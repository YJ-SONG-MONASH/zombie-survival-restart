import { describe, expect, it } from 'vitest';
import {
  createTacticalEncounter,
  isTacticalEncounterTerminal,
  listTacticalActions,
  normalizeTacticalEncounter,
  resolveTacticalAction,
  summarizeTacticalEncounter,
} from '../src/services/tactical-encounter.js';

const ACTION_IDS = [
  'push',
  'melee',
  'stomp',
  'step_back',
  'aim',
  'reload',
  'fire',
  'disengage',
  'brace',
];

const makeWeapon = ({
  id = 'baseball_bat',
  stackId = 'bat:one',
  tags = ['weapon', 'melee', 'long_blunt'],
  skill = 'long_blunt',
  current = 100,
} = {}) => ({
  id,
  stackId,
  count: 1,
  tags,
  effects: { skill },
  conditionState: {
    condition: {
      current,
      maximum: 100,
      wearPerAttack: 1,
      wearPerKill: 2,
      broken: current <= 0,
    },
  },
});

const makeAmmo = ({
  id = '9mm_rounds',
  stackId = 'ammo:9mm',
  tags = ['ammo', '9mm'],
  count = 12,
} = {}) => ({ id, stackId, tags, count });

const makeContext = (overrides = {}) => ({
  inventory: [
    makeWeapon(),
    makeWeapon({
      id: 'm9_pistol',
      stackId: 'pistol:one',
      tags: ['weapon', 'firearm', '9mm'],
      skill: 'aiming',
    }),
    makeAmmo(),
  ],
  equippedWeaponStackId: 'bat:one',
  skills: {
    strength: 6,
    fitness: 6,
    nimble: 5,
    long_blunt: 6,
    aiming: 6,
    reloading: 5,
    sneaking: 5,
  },
  vitals: {
    health: 100,
    endurance: 90,
    fatigue: 8,
    panic: 4,
    hunger: 0,
    thirst: 0,
  },
  body: { pain: 0, wounds: [] },
  usedSpace: 6,
  capacity: 20,
  world: { threat: 3, weatherId: 'clear', isNight: false },
  ...overrides,
});

const createEncounter = (overrides = {}) => createTacticalEncounter({
  nodeId: 'rosewood',
  zombieCount: 7,
  seed: 913,
  encounterSequence: 2,
  startedAtMinutes: 720,
  selectedWeaponStackId: 'bat:one',
  ...overrides,
});

const zombieTotal = (state) => Object.values(state.zombies)
  .reduce((total, value) => total + value, 0);

const expectZeroEffects = (effects) => {
  expect(effects).toMatchObject({
    durationMinutes: 0,
    zombieKills: 0,
    ammoConsumption: [],
    weaponUses: [],
    newWounds: [],
    noiseDelta: 0,
    threatDelta: 0,
    skillXp: {},
    evasionMinutes: 0,
    firearmLoads: {},
  });
  expect(Object.values(effects.vitalsDelta).every((value) => value === 0)).toBe(true);
};

describe('tactical encounter save state', () => {
  it('creates deterministic JSON-safe state with conserved zombie buckets', () => {
    const input = {
      nodeId: 'rosewood',
      zombieCount: 7,
      seed: 913,
      encounterSequence: 2,
      startedAtMinutes: 720,
      selectedWeaponStackId: 'bat:one',
    };
    const snapshot = structuredClone(input);

    const first = createTacticalEncounter(input);
    const repeated = createTacticalEncounter(input);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      version: 1,
      encounterId: first.id,
      nodeId: 'rosewood',
      status: 'active',
      turn: 0,
      startedAtMinutes: 720,
      elapsedMinutes: 0,
      rng: { seed: 913, cursor: 0 },
      rangeBand: 'near',
      escapeProgress: 0,
      player: {
        balance: 100,
        grabbedBy: 0,
        aimFocus: 0,
        loadedByWeapon: {},
      },
      selectedWeaponStackId: 'bat:one',
      log: [],
    });
    expect(first.id).toMatch(/^tactical:/);
    expect(zombieTotal(first)).toBe(7);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(input).toEqual(snapshot);
  });

  it('normalizes malformed and legacy save data without mutating it', () => {
    const raw = {
      id: 'legacy-fight',
      nodeId: 'rosewood',
      status: 'unknown',
      turn: -8,
      startedAtMinutes: -2,
      elapsedMinutes: Number.NaN,
      rng: { seed: -4, cursor: -10 },
      rangeBand: 'invalid',
      escapeProgress: 999,
      player: {
        balance: -5,
        grabbedBy: 99,
        aimFocus: 900,
        loadedByWeapon: {
          'pistol:one': { ammoId: '9mm_rounds', ammoStackId: 'ammo:9mm', loaded: 99, capacity: 15 },
        },
      },
      zombies: { distant: -3, approaching: 99, engaged: 99, downed: -2 },
      selectedWeaponStackId: 42,
      log: ['old'],
    };
    const snapshot = structuredClone(raw);

    const normalized = normalizeTacticalEncounter(raw, { zombieCount: 8, seed: 77 });

    expect(normalized).toMatchObject({
      id: 'legacy-fight',
      nodeId: 'rosewood',
      status: 'active',
      turn: 0,
      startedAtMinutes: 0,
      elapsedMinutes: 0,
      rng: { seed: 4, cursor: 0 },
      rangeBand: 'near',
      escapeProgress: 100,
      selectedWeaponStackId: null,
    });
    expect(normalized.player).toMatchObject({ balance: 0, aimFocus: 100 });
    expect(normalized.player.loadedByWeapon['pistol:one']).toEqual({
      ammoItemId: '9mm_rounds',
      ammoStackId: 'ammo:9mm',
      rounds: 15,
    });
    expect(zombieTotal(normalized)).toBe(8);
    expect(normalized.player.grabbedBy).toBeLessThanOrEqual(normalized.zombies.engaged);
    expect(raw).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(normalized);
  });

  it('normalizes an empty active encounter to a terminal cleared state', () => {
    const state = normalizeTacticalEncounter(createEncounter({ zombieCount: 0 }));

    expect(state.status).toBe('cleared');
    expect(isTacticalEncounterTerminal(state)).toBe(true);
  });
});

describe('tactical action availability and transaction safety', () => {
  it('always describes all nine actions and gives explicit disabled reasons', () => {
    const broken = makeWeapon({ stackId: 'bat:broken', current: 0 });
    const context = makeContext({ inventory: [broken] });
    const state = createEncounter({ selectedWeaponStackId: 'bat:broken' });

    const actions = listTacticalActions(state, context);

    expect(actions.map((action) => action.id)).toEqual(ACTION_IDS);
    expect(actions.every((action) => typeof action.enabled === 'boolean')).toBe(true);
    expect(actions.find((action) => action.id === 'melee')).toMatchObject({
      enabled: false,
      disabledReason: 'weapon_broken',
    });
    expect(actions.find((action) => action.id === 'fire')).toMatchObject({
      enabled: false,
      disabledReason: 'requires_firearm',
    });
  });

  it('does not silently substitute another weapon or ammo stack', () => {
    const brokenSelected = makeWeapon({ stackId: 'bat:broken', current: 0 });
    const healthyOther = makeWeapon({ stackId: 'bat:healthy' });
    const emptyPistol = makeWeapon({
      id: 'm9_pistol',
      stackId: 'pistol:empty',
      tags: ['weapon', 'firearm', '9mm'],
      skill: 'aiming',
    });
    const state = createEncounter({ selectedWeaponStackId: 'bat:broken' });
    const context = makeContext({ inventory: [brokenSelected, healthyOther, emptyPistol] });

    expect(listTacticalActions(state, context).find(({ id }) => id === 'melee'))
      .toMatchObject({ enabled: false, disabledReason: 'weapon_broken' });

    const pistolState = { ...state, selectedWeaponStackId: 'pistol:empty' };
    const pistolActions = listTacticalActions(pistolState, context);
    expect(pistolActions.find(({ id }) => id === 'reload'))
      .toMatchObject({ enabled: false, disabledReason: 'no_matching_ammo' });
    expect(pistolActions.find(({ id }) => id === 'fire'))
      .toMatchObject({ enabled: false, disabledReason: 'firearm_unloaded' });
  });

  it.each([
    ['invalid action', { actionId: 'dance', expectedTurn: 0 }],
    ['stale turn', { actionId: 'brace', expectedTurn: 99 }],
  ])('%s is a zero-change result that does not consume RNG', (_label, command) => {
    const state = createEncounter();
    const context = makeContext();
    const stateSnapshot = structuredClone(state);
    const contextSnapshot = structuredClone(context);

    const result = resolveTacticalAction(state, command, context);

    expect(result.ok).toBe(false);
    expect(result.nextState).toEqual(stateSnapshot);
    expect(result.nextState.rng.cursor).toBe(0);
    expectZeroEffects(result.effects);
    expect(result.events).toEqual([]);
    expect(state).toEqual(stateSnapshot);
    expect(context).toEqual(contextSnapshot);
  });

  it('rejects terminal encounters with an exact zero-change snapshot', () => {
    const state = createEncounter({ zombieCount: 0 });
    const snapshot = structuredClone(state);

    const result = resolveTacticalAction(state, {
      actionId: 'brace',
      expectedTurn: state.turn,
      encounterId: state.id,
    }, makeContext());

    expect(result).toMatchObject({ ok: false, reason: 'encounter_terminal', events: [] });
    expect(result.nextState).toEqual(snapshot);
    expectZeroEffects(result.effects);
  });
});

describe('close-quarters tactical actions', () => {
  it('resolves push plus zombie response while conserving every live/downed bucket', () => {
    const state = createEncounter({
      zombieCount: 5,
      initialZombies: { distant: 0, approaching: 1, engaged: 4, downed: 0 },
      initialRangeBand: 'contact',
    });
    const before = zombieTotal(state);

    const result = resolveTacticalAction(state, {
      actionId: 'push',
      expectedTurn: state.turn,
      encounterId: state.id,
    }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.nextState.turn).toBe(1);
    expect(result.nextState.rng.cursor).toBeGreaterThan(0);
    expect(zombieTotal(result.nextState)).toBe(before - result.effects.zombieKills);
    expect(result.effects.zombieKills).toBe(0);
    expect(result.events.some(({ type }) => type === 'zombie_response')).toBe(true);
  });

  it('uses the commanded exact melee stack for condition wear, hit skill, and XP', () => {
    const bat = makeWeapon({ stackId: 'bat:one', skill: 'long_blunt' });
    const axe = makeWeapon({
      id: 'fire_axe',
      stackId: 'axe:exact',
      tags: ['weapon', 'melee', 'axe'],
      skill: 'axe',
    });
    const context = makeContext({
      inventory: [bat, axe],
      skills: { ...makeContext().skills, axe: 10, long_blunt: 0 },
    });
    const contextSnapshot = structuredClone(context);
    const state = createEncounter({
      zombieCount: 3,
      initialZombies: { distant: 0, approaching: 0, engaged: 3, downed: 0 },
      initialRangeBand: 'contact',
    });

    const result = resolveTacticalAction(state, {
      actionId: 'melee',
      expectedTurn: state.turn,
      weaponStackId: 'axe:exact',
    }, context);

    expect(result.ok).toBe(true);
    expect(result.nextState.selectedWeaponStackId).toBe('axe:exact');
    expect(result.effects.weaponUses).toEqual([
      expect.objectContaining({ stackId: 'axe:exact', attacks: 1 }),
    ]);
    expect(Object.keys(result.effects.skillXp)).toContain('axe');
    expect(Object.keys(result.effects.skillXp)).not.toContain('long_blunt');
    expect(result.effects.zombieKills).toBeLessThanOrEqual(1);
    expect(zombieTotal(result.nextState)).toBe(3 - result.effects.zombieKills);
    expect(context).toEqual(contextSnapshot);
  });

  it('caps stomp kills by the downed bucket and never creates zombies', () => {
    const state = createEncounter({
      zombieCount: 2,
      initialZombies: { distant: 0, approaching: 0, engaged: 1, downed: 1 },
      initialRangeBand: 'contact',
    });

    const result = resolveTacticalAction(state, {
      actionId: 'stomp',
      expectedTurn: state.turn,
    }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.effects.zombieKills).toBeLessThanOrEqual(1);
    expect(zombieTotal(result.nextState)).toBe(2 - result.effects.zombieKills);
    expect(result.effects.weaponUses).toEqual([]);
  });

  it('resolves step-back as a full turn and still applies the horde response', () => {
    const state = createEncounter({
      zombieCount: 5,
      initialZombies: { distant: 1, approaching: 2, engaged: 2, downed: 0 },
      initialRangeBand: 'near',
    });

    const result = resolveTacticalAction(state, {
      actionId: 'step_back',
      expectedTurn: 0,
    }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.nextState.turn).toBe(1);
    expect(result.effects.durationMinutes).toBe(1);
    expect(zombieTotal(result.nextState)).toBe(5);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'player_action',
      turn: 1,
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'zombie_response',
      turn: 1,
    }));
  });

  it('lets a successful contact retreat create real space for a follow-up disengage', () => {
    let state = createEncounter({
      seed: 22,
      zombieCount: 6,
      initialZombies: { distant: 1, approaching: 2, engaged: 3, downed: 0 },
      initialRangeBand: 'contact',
    });
    const context = makeContext({
      skills: { ...makeContext().skills, nimble: 10, fitness: 10 },
      vitals: { ...makeContext().vitals, endurance: 100, fatigue: 0, panic: 0 },
    });

    const contactRetreat = resolveTacticalAction(state, {
      actionId: 'step_back',
      expectedTurn: state.turn,
    }, context);
    expect(contactRetreat.ok).toBe(true);
    expect(contactRetreat.events[0]).toMatchObject({ success: true });
    expect(contactRetreat.nextState.rangeBand).toBe('near');
    expect(contactRetreat.nextState.zombies.engaged).toBe(0);
    state = contactRetreat.nextState;

    const distanceRetreat = resolveTacticalAction(state, {
      actionId: 'step_back',
      expectedTurn: state.turn,
    }, context);
    expect(distanceRetreat.ok).toBe(true);
    expect(distanceRetreat.events[0]).toMatchObject({ success: true });
    expect(distanceRetreat.nextState.rangeBand).toBe('far');
    expect(listTacticalActions(distanceRetreat.nextState, context).find(({ id }) => id === 'disengage'))
      .toMatchObject({ enabled: true });
  });

  it('can keep retreating at far range until disengage becomes available', () => {
    let state = createEncounter({
      seed: 22,
      zombieCount: 5,
      initialZombies: { distant: 1, approaching: 2, engaged: 2, downed: 0 },
      initialRangeBand: 'near',
    });
    const context = makeContext({
      skills: { ...makeContext().skills, nimble: 10, fitness: 10 },
      vitals: { ...makeContext().vitals, endurance: 100, fatigue: 0, panic: 0 },
    });

    const first = resolveTacticalAction(state, {
      actionId: 'step_back',
      expectedTurn: state.turn,
    }, context);
    expect(first.ok).toBe(true);
    expect(first.nextState.rangeBand).toBe('far');
    expect(listTacticalActions(first.nextState, context).find(({ id }) => id === 'step_back').enabled)
      .toBe(true);
    state = first.nextState;

    const second = resolveTacticalAction(state, {
      actionId: 'step_back',
      expectedTurn: state.turn,
    }, context);
    expect(second.ok).toBe(true);
    expect(second.nextState.escapeProgress).toBeGreaterThanOrEqual(40);
    expect(listTacticalActions(second.nextState, context).find(({ id }) => id === 'disengage'))
      .toMatchObject({ enabled: true, disabledReason: '' });
  });

  it('treats far range as a brief opening instead of a permanent brace safe zone', () => {
    const state = createEncounter({
      zombieCount: 4,
      initialZombies: { distant: 4, approaching: 0, engaged: 0, downed: 0 },
      initialRangeBand: 'far',
    });
    const context = makeContext({
      vitals: { ...makeContext().vitals, endurance: 100, fatigue: 0 },
    });

    const result = resolveTacticalAction(state, {
      actionId: 'brace',
      expectedTurn: state.turn,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.nextState.rangeBand).toBe('near');
    expect(result.nextState.zombies.approaching).toBeGreaterThan(0);
    expect(result.effects.skillXp.fitness ?? 0).toBe(0);
    expect(result.effects.vitalsDelta.endurance).toBe(0);
  });

  it('lets brace recover depleted endurance but only awards fitness for real balance recovery under pressure', () => {
    const base = createEncounter({
      zombieCount: 3,
      initialZombies: { distant: 0, approaching: 2, engaged: 1, downed: 0 },
      initialRangeBand: 'contact',
    });
    const state = normalizeTacticalEncounter({
      ...base,
      player: { ...base.player, balance: 45 },
    });
    const context = makeContext({
      vitals: { ...makeContext().vitals, endurance: 0 },
    });

    const result = resolveTacticalAction(state, {
      actionId: 'brace',
      expectedTurn: state.turn,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.effects.vitalsDelta.endurance).toBe(3);
    expect(result.effects.skillXp.fitness).toBe(1);
    expect(result.nextState.player.balance).toBeGreaterThan(state.player.balance);
  });

  it('stops retreat XP once the escape is fully prepared', () => {
    const base = createEncounter({
      zombieCount: 3,
      initialZombies: { distant: 2, approaching: 1, engaged: 0, downed: 0 },
      initialRangeBand: 'far',
    });
    const state = normalizeTacticalEncounter({ ...base, escapeProgress: 100 });
    const actions = listTacticalActions(state, makeContext());

    expect(actions.find(({ id }) => id === 'step_back')).toMatchObject({
      enabled: false,
      disabledReason: 'escape_ready',
    });
    expect(actions.find(({ id }) => id === 'disengage')).toMatchObject({ enabled: true });
  });
});

describe('firearms, escape, and deterministic continuation', () => {
  it('aims, reloads exact ammo, and replays a saved fire action bit-for-bit', () => {
    const context = makeContext({ equippedWeaponStackId: 'pistol:one' });
    let state = createEncounter({
      selectedWeaponStackId: 'pistol:one',
      zombieCount: 4,
      initialZombies: { distant: 4, approaching: 0, engaged: 0, downed: 0 },
      initialRangeBand: 'far',
    });

    const projectedActions = listTacticalActions(state, context);
    expect(projectedActions.find(({ id }) => id === 'reload')).toMatchObject({
      durationMinutes: 4,
      minutes: 4,
    });
    expect(projectedActions.find(({ id }) => id === 'fire')).toMatchObject({ noiseDelta: 30 });

    const aimed = resolveTacticalAction(state, {
      actionId: 'aim',
      expectedTurn: state.turn,
      weaponStackId: 'pistol:one',
    }, context);
    expect(aimed.ok).toBe(true);
    expect(aimed.nextState.player.aimFocus).toBeGreaterThan(0);
    state = aimed.nextState;

    const reloaded = resolveTacticalAction(state, {
      actionId: 'reload',
      expectedTurn: state.turn,
      weaponStackId: 'pistol:one',
      ammoStackId: 'ammo:9mm',
      rounds: 3,
    }, context);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.effects.ammoConsumption).toEqual([
      { stackId: 'ammo:9mm', count: 3 },
    ]);
    expect(reloaded.effects.firearmLoads).toEqual({
      'pistol:one': {
        ammoItemId: '9mm_rounds',
        ammoStackId: 'ammo:9mm',
        rounds: 3,
      },
    });
    expect(reloaded.nextState.player.loadedByWeapon['pistol:one'].rounds).toBe(3);

    const saved = JSON.parse(JSON.stringify(reloaded.nextState));
    const command = {
      actionId: 'fire',
      expectedTurn: saved.turn,
      encounterId: saved.id,
      weaponStackId: 'pistol:one',
    };
    const direct = resolveTacticalAction(reloaded.nextState, command, context);
    const resumed = resolveTacticalAction(saved, command, JSON.parse(JSON.stringify(context)));

    expect(resumed).toEqual(direct);
    expect(direct.effects.firearmLoads).toEqual({
      'pistol:one': {
        ammoItemId: '9mm_rounds',
        ammoStackId: 'ammo:9mm',
        rounds: 2,
      },
    });
    expect(direct.effects.ammoConsumption).toEqual([]);
    expect(direct.effects.weaponUses[0]).toMatchObject({ stackId: 'pistol:one', attacks: 1 });
    expect(direct.effects.zombieKills).toBeLessThanOrEqual(1);
  });

  it('lets a prepared distant survivor disengage into a terminal evasion window', () => {
    const base = createEncounter({
      zombieCount: 3,
      initialZombies: { distant: 3, approaching: 0, engaged: 0, downed: 0 },
      initialRangeBand: 'far',
    });
    const state = normalizeTacticalEncounter({ ...base, escapeProgress: 100 });

    const result = resolveTacticalAction(state, {
      actionId: 'disengage',
      expectedTurn: state.turn,
    }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.nextState.status).toBe('escaped');
    expect(result.effects.evasionMinutes).toBeGreaterThan(0);
    expect(result.effects.zombieKills).toBe(0);
    expect(isTacticalEncounterTerminal(result.nextState)).toBe(true);
  });
});

describe('survivor pressure and presentation summary', () => {
  it('makes fatigue, panic, wounds, and overload materially increase response risk', () => {
    const state = createEncounter({
      zombieCount: 4,
      initialZombies: { distant: 0, approaching: 0, engaged: 4, downed: 0 },
      initialRangeBand: 'contact',
    });
    const healthy = makeContext();
    const compromised = makeContext({
      vitals: { ...makeContext().vitals, endurance: 4, fatigue: 96, panic: 92 },
      body: {
        pain: 80,
        wounds: [
          { bodyPart: 'left_arm', type: 'laceration', severity: 8, bleeding: true },
          { bodyPart: 'right_leg', type: 'deep_wound', severity: 9, bleeding: true },
        ],
      },
      usedSpace: 29,
      capacity: 20,
    });

    const healthyBrace = listTacticalActions(state, healthy).find(({ id }) => id === 'brace');
    const compromisedBrace = listTacticalActions(state, compromised).find(({ id }) => id === 'brace');

    expect(compromisedBrace.risk).toBeGreaterThan(healthyBrace.risk);

    const healthyResult = resolveTacticalAction(state, {
      actionId: 'brace',
      expectedTurn: state.turn,
    }, healthy);
    const compromisedResult = resolveTacticalAction(state, {
      actionId: 'brace',
      expectedTurn: state.turn,
    }, compromised);
    const healthyHarm = -healthyResult.effects.vitalsDelta.health + healthyResult.effects.newWounds.length * 10;
    const compromisedHarm = -compromisedResult.effects.vitalsDelta.health
      + compromisedResult.effects.newWounds.length * 10;

    expect(compromisedHarm).toBeGreaterThanOrEqual(healthyHarm);
  });

  it('emits survival-compatible wound fields and marks bites as Knox infections', () => {
    const axe = makeWeapon({
      id: 'fire_axe',
      stackId: 'axe:exact',
      tags: ['weapon', 'axe'],
      skill: 'axe',
    });
    const context = makeContext({
      inventory: [axe],
      skills: { axe: 1, strength: 1, fitness: 1, nimble: 0 },
      vitals: { health: 100, endurance: 3, fatigue: 100, panic: 100 },
      body: {
        pain: 100,
        wounds: [
          { severity: 10, bleeding: true },
          { severity: 10, bleeding: true },
        ],
      },
      usedSpace: 40,
      capacity: 20,
      world: { threat: 100, isNight: true },
    });
    const state = createEncounter({
      seed: 1,
      zombieCount: 4,
      selectedWeaponStackId: 'axe:exact',
      initialRangeBand: 'contact',
      initialZombies: { distant: 0, approaching: 0, engaged: 4, downed: 0 },
    });

    const result = resolveTacticalAction(state, {
      actionId: 'melee',
      expectedTurn: 0,
      weaponStackId: 'axe:exact',
    }, context);

    expect(result.effects.newWounds).toHaveLength(1);
    expect(result.effects.newWounds[0]).toMatchObject({
      type: 'bite',
      bleeding: true,
      bandaged: false,
      dirtyBandage: false,
      bandageAgeHours: 0,
      disinfected: false,
      infected: false,
      knoxInfection: true,
      ageHours: 0,
    });
  });

  it('returns a UI-ready summary without asking the view to recalculate pressure', () => {
    const state = createEncounter({
      zombieCount: 6,
      initialZombies: { distant: 1, approaching: 2, engaged: 2, downed: 1 },
      initialRangeBand: 'contact',
    });

    const summary = summarizeTacticalEncounter(state);

    expect(summary).toMatchObject({
      id: state.id,
      status: 'active',
      turn: 0,
      rangeBand: 'contact',
      escapeProgress: 0,
      remainingZombies: 6,
      standingZombies: 5,
      pressure: expect.any(Number),
      pressureBand: 'critical',
      canAct: true,
    });
    expect(summary.label).toEqual(expect.any(String));
    expect(summary.tone).toEqual(expect.any(String));
  });
});
