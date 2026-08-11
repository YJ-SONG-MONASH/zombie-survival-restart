import { describe, expect, it } from 'vitest';
import { mapNodes, marketItems } from '../src/data/zombie.js';
import { resolveNodeAction } from '../src/services/engine.js';
import {
  DIRTY_BANDAGE_HOURS,
  START_MINUTE,
  advanceSurvivalState,
  createBaseState,
  createBodyState,
  createWorldState,
  resolveCombatEncounter,
  weatherForDay,
} from '../src/services/survival.js';

const baseVitals = () => ({
  health: 100,
  endurance: 100,
  hunger: 20,
  thirst: 20,
  fatigue: 20,
  panic: 20,
  stress: 20,
});

const item = (id, count = 1) => ({
  ...marketItems.find((entry) => entry.id === id),
  count,
});

describe('survival clock and world simulation', () => {
  it('lets the minute simulation own rest and sleep recovery exactly once', () => {
    const node = mapNodes.find((entry) => entry.id === 'muldraugh');
    const common = {
      node,
      day: 1,
      clockMinutes: START_MINUTE,
      inventory: [],
      skills: {},
      traits: [],
      vitals: { ...baseVitals(), endurance: 30, fatigue: 80, panic: 50, stress: 50 },
      world: createWorldState({ day: 1, spawnId: 'muldraugh' }),
      body: createBodyState(),
      base: createBaseState(),
    };

    const rest = resolveNodeAction({ ...common, actionId: 'rest' });
    const sleep = resolveNodeAction({ ...common, actionId: 'sleep' });

    expect(rest.vitals).toMatchObject({ health: 2, endurance: 0, fatigue: 0, panic: 0, stress: 0 });
    expect(sleep.vitals).toMatchObject({ health: 1, endurance: 0, fatigue: 0, panic: 0, stress: 0 });

    const recovered = advanceSurvivalState({
      ...common,
      minutes: rest.minutes,
      mode: rest.mode,
    });
    expect(recovered.vitals.fatigue).toBe(63);
    expect(recovered.vitals.endurance).toBeCloseTo(50, 5);
  });

  it('crosses midnight, advances the day, and selects that day weather without mutating inputs', () => {
    const vitals = baseVitals();
    const world = createWorldState({ day: 1, spawnId: 'muldraugh' });
    const body = createBodyState();
    const base = createBaseState();

    const result = advanceSurvivalState({
      day: 1,
      clockMinutes: 23 * 60,
      minutes: 3 * 60,
      vitals,
      world,
      body,
      base,
      nodeDanger: 3,
    });

    expect(result.day).toBe(2);
    expect(result.clockMinutes).toBe(2 * 60);
    expect(result.daysElapsed).toBe(1);
    expect(result.elapsedHours).toBe(3);
    expect(result.world.weatherId).toBe(weatherForDay(2, world.seed).id);
    expect(vitals).toEqual(baseVitals());
    expect(world).not.toBe(result.world);
    expect(body).not.toBe(result.body);
    expect(base).not.toBe(result.base);
  });

  it('announces water and power shutoff when a long action crosses both days', () => {
    const world = {
      ...createWorldState({ day: 1, spawnId: 'rosewood' }),
      waterShutoffDay: 2,
      powerShutoffDay: 3,
      waterOn: true,
      powerOn: true,
    };

    const result = advanceSurvivalState({
      day: 1,
      clockMinutes: 23 * 60,
      minutes: 25 * 60,
      vitals: baseVitals(),
      world,
      body: createBodyState(),
      base: createBaseState(),
      atHome: true,
      mode: 'rest',
    });

    expect(result.day).toBe(3);
    expect(result.clockMinutes).toBe(0);
    expect(result.world.waterOn).toBe(false);
    expect(result.world.powerOn).toBe(false);
    expect(result.notices).toEqual(expect.arrayContaining([
      expect.stringContaining('市政供水停止'),
      expect.stringContaining('电网彻底熄灭'),
    ]));
  });

  it('keeps power through a shutoff while a fueled generator is running', () => {
    const result = advanceSurvivalState({
      day: 1,
      clockMinutes: 23 * 60,
      minutes: 2 * 60,
      vitals: baseVitals(),
      world: {
        ...createWorldState({ day: 1, spawnId: 'west_point' }),
        waterShutoffDay: 2,
        powerShutoffDay: 2,
      },
      body: createBodyState(),
      base: { ...createBaseState(), generatorOn: true, generatorFuel: 3 },
      atHome: true,
    });

    expect(result.base.generatorFuel).toBe(2);
    expect(result.base.generatorOn).toBe(true);
    expect(result.world.powerOn).toBe(true);
    expect(result.world.waterOn).toBe(false);
  });

  it('collects rainwater at the base on a rainy crossed day', () => {
    const world = createWorldState({ day: 1, spawnId: 'riverside' });
    const rainyDay = Array.from({ length: 20 }, (_, index) => index + 2)
      .find((day) => ['rain', 'storm'].includes(weatherForDay(day, world.seed).id));

    expect(rainyDay).toBeDefined();
    const result = advanceSurvivalState({
      day: rainyDay - 1,
      clockMinutes: 23 * 60,
      minutes: 2 * 60,
      vitals: baseVitals(),
      world,
      body: createBodyState(),
      base: { ...createBaseState(), waterReserve: 1 },
      atHome: true,
    });

    expect(result.day).toBe(rainyDay);
    expect(result.base.waterReserve).toBe(3);
    expect(result.notices).toContain('据点容器接到了两份雨水。');
  });

  it('clamps excessive elapsed time to three days', () => {
    const result = advanceSurvivalState({
      day: 4,
      clockMinutes: START_MINUTE,
      minutes: 10 * 24 * 60,
      vitals: baseVitals(),
    });

    expect(result.elapsedHours).toBe(72);
    expect(result.day).toBe(7);
    expect(result.clockMinutes).toBe(START_MINUTE);
  });
});

describe('combat, ammunition, and wounds', () => {
  it('gives an untrained but fit survivor a viable high-roll escape at medium danger', () => {
    const outcome = resolveCombatEncounter({
      approach: 'evade',
      node: { name: '迪克西公路', danger: 3 },
      skills: { fitness: 5, sneaking: 0, lightfooted: 0 },
      vitals: { fatigue: 25, panic: 20 },
      world: { weatherId: 'clear', threat: 30 },
      zombiePopulation: 18,
      rng: () => 0.99,
    });

    expect(outcome.score).toBeGreaterThanOrEqual(55);
    expect(outcome.result).toContain('绕开尸群');
  });

  it('rejects firearm combat without matching ammunition', () => {
    const outcome = resolveCombatEncounter({
      approach: 'combat_firearm',
      node: { name: '西点枪店', danger: 5 },
      inventory: [item('m9_pistol')],
      skills: { aiming: 5, reloading: 3 },
      vitals: baseVitals(),
      world: { weatherId: 'clear', threat: 40 },
      rng: () => 0.5,
    });

    expect(outcome).toMatchObject({
      ok: false,
      score: 0,
      kills: 0,
      consume: [],
      minutes: 0,
    });
    expect(outcome.result).toContain('对应弹药');
  });

  it('consumes exactly one matching ammunition unit and creates firearm noise', () => {
    const inventory = [item('m9_pistol'), item('9mm_rounds', 2)];
    const outcome = resolveCombatEncounter({
      approach: 'combat_firearm',
      node: { name: '检查站', danger: 5 },
      inventory,
      skills: { aiming: 5, reloading: 3 },
      vitals: baseVitals(),
      world: { weatherId: 'clear', threat: 40 },
      equippedWeaponId: 'm9_pistol',
      rng: () => 0.5,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.consume).toEqual(['9mm_rounds']);
    expect(outcome.noiseDelta).toBe(58);
    expect(outcome.threatDelta).toBe(30);
    expect(outcome.kills).toBeGreaterThanOrEqual(2);
    expect(inventory.find((entry) => entry.id === '9mm_rounds').count).toBe(2);
  });

  it('can produce a deterministic bite during a disastrous high-risk melee', () => {
    const rolls = [0, 0.1, 0.25];
    const outcome = resolveCombatEncounter({
      approach: 'combat_melee',
      node: { name: '路易斯维尔', danger: 8 },
      day: 7,
      clockMinutes: 22 * 60,
      inventory: [item('baseball_bat')],
      skills: { long_blunt: 0, strength: 0, fitness: 0 },
      vitals: { ...baseVitals(), fatigue: 100, panic: 100 },
      world: { weatherId: 'storm', threat: 100 },
      equippedWeaponId: 'baseball_bat',
      rng: () => rolls.shift() ?? 0,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.score).toBe(5);
    expect(outcome.wounds).toHaveLength(1);
    expect(outcome.wounds[0]).toMatchObject({
      type: 'bite',
      severity: 5,
      bleeding: true,
      knoxInfection: true,
    });
    expect(outcome.vitals.health).toBe(-14);
  });

  it('progresses untreated bleeding and Knox infection over elapsed time', () => {
    const result = advanceSurvivalState({
      day: 1,
      clockMinutes: START_MINUTE,
      minutes: 4 * 60,
      vitals: baseVitals(),
      world: createWorldState(),
      body: {
        ...createBodyState(),
        wounds: [{
          id: 'bite-1',
          bodyPart: 'left_arm',
          type: 'bite',
          severity: 5,
          bleeding: true,
          bandaged: false,
          disinfected: false,
          infected: false,
          knoxInfection: true,
          ageHours: 0,
          source: 'test',
        }],
      },
    });

    expect(result.vitals.health).toBeLessThan(100);
    expect(result.body.infectionLevel).toBe(7);
    expect(result.body.pain).toBe(35);
    expect(result.body.wounds[0].ageHours).toBe(4);
  });

  it('progresses ordinary wound infection identically for one long action or split actions', () => {
    const wound = {
      id: 'laceration-1',
      bodyPart: 'right_arm',
      type: 'laceration',
      severity: 3,
      bleeding: false,
      bandaged: false,
      disinfected: false,
      infected: false,
      knoxInfection: false,
      ageHours: 0,
      source: 'test',
    };
    const startingState = {
      day: 1,
      clockMinutes: START_MINUTE,
      vitals: baseVitals(),
      world: createWorldState(),
      body: { ...createBodyState(), wounds: [wound] },
      base: createBaseState(),
    };

    const longAction = advanceSurvivalState({ ...startingState, minutes: 8 * 60 });
    let splitAction = startingState;
    for (let index = 0; index < 8; index += 1) {
      splitAction = advanceSurvivalState({ ...splitAction, minutes: 60 });
    }

    expect(longAction.body.wounds[0].infected).toBe(true);
    expect(longAction.body.infectionLevel).toBeCloseTo(0.84, 5);
    expect(splitAction.body.infectionLevel).toBeCloseTo(longAction.body.infectionLevel, 5);
  });

  it('turns an old bandage dirty and only counts infection exposure after it becomes dirty', () => {
    const wound = {
      id: 'bandaged-laceration',
      bodyPart: 'left_arm',
      type: 'laceration',
      severity: 3,
      bleeding: false,
      bandaged: true,
      dirtyBandage: false,
      bandageAgeHours: 0,
      disinfected: false,
      infected: false,
      knoxInfection: false,
      ageHours: 0,
      source: 'test',
    };
    const startingState = {
      day: 1,
      clockMinutes: START_MINUTE,
      vitals: baseVitals(),
      world: createWorldState(),
      body: { ...createBodyState(), wounds: [wound] },
      base: createBaseState(),
    };

    const longAction = advanceSurvivalState({ ...startingState, minutes: 10 * 60 });
    let splitAction = startingState;
    for (let index = 0; index < 10; index += 1) splitAction = advanceSurvivalState({ ...splitAction, minutes: 60 });

    expect(DIRTY_BANDAGE_HOURS).toBe(8);
    expect(longAction.body.wounds[0]).toMatchObject({ dirtyBandage: true, bandageAgeHours: 10, infected: true });
    expect(longAction.body.infectionLevel).toBeCloseTo(0.84, 5);
    expect(splitAction.body.infectionLevel).toBeCloseTo(longAction.body.infectionLevel, 5);
  });
});
