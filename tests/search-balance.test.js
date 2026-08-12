import { describe, expect, it, vi } from 'vitest';
import { resolveNodeAction } from '../src/services/engine.js';
import { createWound } from '../src/services/survival.js';

const HEALTHY_VITALS = Object.freeze({
  health: 100,
  endurance: 100,
  hunger: 20,
  thirst: 20,
  fatigue: 20,
  panic: 20,
  stress: 20,
});

function searchOutcome(seed, {
  danger = 2,
  zombiePopulation = 0,
  badCondition = false,
  exactContainer = true,
} = {}) {
  return resolveNodeAction({
    actionId: 'search',
    node: { id: `balance-danger-${danger}`, name: `危险度 ${danger} 测试点`, danger, type: 'town' },
    day: 1,
    clockMinutes: badCondition ? 22 * 60 : 8 * 60,
    inventory: [],
    tags: [],
    traits: badCondition ? [{ id: 'thin_skinned' }, { id: 'clumsy' }] : [],
    vitals: badCondition
      ? { health: 75, endurance: 18, hunger: 65, thirst: 65, fatigue: 88, panic: 82, stress: 75 }
      : { ...HEALTHY_VITALS },
    skills: {},
    profession: null,
    vehicle: null,
    world: {
      seed,
      weatherId: badCondition ? 'storm' : 'clear',
      threat: badCondition ? 85 : 20,
      noise: 4,
    },
    body: badCondition
      ? { wounds: [{ type: 'scratch', bleeding: true, bandaged: false }], pain: 42 }
      : { wounds: [], pain: 0 },
    base: {},
    manualLoot: exactContainer ? { sourceName: '普通容器', collectedItems: [] } : null,
    zombiePopulation,
  });
}

function sampleSearches(options, count = 4000) {
  const result = {
    total: count,
    injuries: 0,
    lacerations: 0,
    bites: 0,
    healthLoss: 0,
  };
  for (let seed = 0; seed < count; seed += 1) {
    const outcome = searchOutcome(seed, options);
    const wound = outcome.wounds[0];
    if (wound) {
      result.injuries += 1;
      if (wound.type === 'laceration') result.lacerations += 1;
      if (wound.type === 'bite') result.bites += 1;
    }
    result.healthLoss -= outcome.vitals.health;
  }
  return {
    injuryRate: result.injuries / count,
    lacerationRate: result.lacerations / count,
    biteRate: result.bites / count,
    averageHealthLoss: result.healthLoss / count,
  };
}

describe('scene-search injury balance', () => {
  it('makes a healthy cleared low-risk container primarily cost time, endurance, noise, and fatigue', () => {
    const outcome = searchOutcome(0, { danger: 2, zombiePopulation: 0 });

    expect(outcome.wounds).toEqual([]);
    expect(outcome.vitals).toMatchObject({ health: 0, endurance: -6, fatigue: 2 });
    expect(outcome.minutes).toBeGreaterThan(0);
    expect(outcome.noiseDelta).toBeGreaterThan(0);
  });

  it('keeps healthy cleared-container injuries rare across low, medium, and high danger', () => {
    const low = sampleSearches({ danger: 2, zombiePopulation: 0 });
    const medium = sampleSearches({ danger: 4, zombiePopulation: 0 });
    const high = sampleSearches({ danger: 6, zombiePopulation: 0 });

    expect(low.injuryRate).toBeLessThan(0.02);
    expect(low.lacerationRate).toBeLessThan(0.005);
    expect(low.averageHealthLoss).toBeLessThan(0.05);
    expect(medium.injuryRate).toBeGreaterThan(0.02);
    expect(medium.injuryRate).toBeLessThan(0.07);
    expect(medium.lacerationRate).toBeLessThan(0.01);
    expect(medium.averageHealthLoss).toBeLessThan(0.15);
    expect(high.injuryRate).toBeGreaterThan(medium.injuryRate);
    expect(high.injuryRate).toBeLessThan(0.11);
    expect(high.lacerationRate).toBeLessThan(0.02);
    expect(high.averageHealthLoss).toBeLessThan(0.25);
  });

  it('makes searching during an evasion window meaningfully riskier without making it certain injury', () => {
    const cleared = sampleSearches({ danger: 4, zombiePopulation: 0 });
    const exposed = sampleSearches({ danger: 4, zombiePopulation: 8 });

    expect(exposed.injuryRate).toBeGreaterThan(cleared.injuryRate * 3);
    expect(exposed.injuryRate).toBeLessThan(0.28);
    expect(exposed.lacerationRate).toBeGreaterThan(cleared.lacerationRate);
    expect(exposed.lacerationRate).toBeLessThan(0.1);
    expect(exposed.biteRate).toBe(0);
  });

  it('correlates severe search wounds with high danger and genuinely bad survivor condition', () => {
    const healthy = sampleSearches({ danger: 6, zombiePopulation: 8 });
    const compromised = sampleSearches({ danger: 6, zombiePopulation: 8, badCondition: true });

    expect(compromised.injuryRate).toBeGreaterThan(healthy.injuryRate + 0.12);
    expect(compromised.lacerationRate).toBeGreaterThan(healthy.lacerationRate + 0.1);
    expect(compromised.biteRate).toBeGreaterThan(0);
    expect(compromised.biteRate).toBeLessThan(0.03);
  });

  it('uses deterministic save-state rolls and leaves the default combat wound profile intact', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('scene search must not use ambient Math.random');
    });
    const first = searchOutcome(117, { danger: 6, zombiePopulation: 8, badCondition: true });
    const replay = searchOutcome(117, { danger: 6, zombiePopulation: 8, badCondition: true });
    randomSpy.mockRestore();

    expect(replay.wounds).toEqual(first.wounds);
    expect(replay.vitals).toEqual(first.vitals);

    const contactRolls = [0.1, 0.5];
    const combatWound = createWound({
      danger: 6,
      score: 10,
      day: 1,
      clockMinutes: 480,
      rng: () => contactRolls.shift() ?? 0.5,
    });
    expect(combatWound).toMatchObject({ type: 'bite', severity: 5, knoxInfection: true });
  });
});
