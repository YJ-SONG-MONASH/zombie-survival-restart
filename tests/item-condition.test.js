import { describe, expect, it } from 'vitest';
import { marketItems } from '../src/data/zombie.js';
import {
  FOOD_FRESHNESS_STATES,
  ITEM_CONDITION_VERSION,
  POWERED_REFRIGERATION_RATE,
  advanceFoodSpoilage,
  applyWeaponWear,
  canMergeItemConditionStates,
  createItemConditionState,
  createItemInstanceId,
  getFoodConsumptionModifiers,
  getItemConditionDisplay,
  isWeaponBroken,
  normalizeItemConditionState,
} from '../src/services/item-condition.js';

const catalogItem = (id) => marketItems.find((item) => item.id === id);

describe('catalog-backed item condition state', () => {
  it('creates deterministic per-instance food and weapon state without mutating catalog data', () => {
    const berries = catalogItem('wild_berries');
    const crowbar = catalogItem('crowbar');
    const berriesSnapshot = structuredClone(berries);
    const crowbarSnapshot = structuredClone(crowbar);

    const foodState = createItemConditionState(berries);
    const weaponState = createItemConditionState(crowbar);

    expect(foodState).toEqual(createItemConditionState(berries));
    expect(foodState).toMatchObject({
      version: ITEM_CONDITION_VERSION,
      itemId: 'wild_berries',
      condition: null,
      freshness: {
        perishable: true,
        ageMinutes: 0,
        spoilageMinutes: 0,
        state: FOOD_FRESHNESS_STATES.FRESH,
      },
    });
    expect(weaponState).toMatchObject({
      itemId: 'crowbar',
      freshness: null,
      condition: {
        current: 100,
        maximum: 100,
        broken: false,
      },
    });
    expect(JSON.parse(JSON.stringify(foodState))).toEqual(foodState);
    expect(JSON.parse(JSON.stringify(weaponState))).toEqual(weaponState);
    expect(berries).toEqual(berriesSnapshot);
    expect(crowbar).toEqual(crowbarSnapshot);
  });

  it('derives stable instance and stack identity from explicit acquisition context', () => {
    const item = catalogItem('wild_berries');
    const first = createItemConditionState(item, { acquiredMinutes: 720, sequence: 2, sourceId: 'market' });
    const repeated = createItemConditionState(item, { acquiredMinutes: 720, sequence: 2, sourceId: 'market' });
    const next = createItemConditionState(item, { acquiredMinutes: 720, sequence: 3, sourceId: 'market' });

    expect(first.instanceId).toBe(createItemInstanceId(item.id, {
      acquiredMinutes: 720,
      sequence: 2,
      sourceId: 'market',
    }));
    expect(first.stackId).toBe(first.instanceId);
    expect(repeated).toEqual(first);
    expect(next.instanceId).not.toBe(first.instanceId);
    expect(advanceFoodSpoilage(first, { elapsedMinutes: 60 }).stackId).toBe(first.stackId);
  });

  it('keeps canned and shelf-stable food fresh while still tracking chronological age', () => {
    for (const id of ['canned_soup', 'cereal', 'water_bottle']) {
      const initial = createItemConditionState(catalogItem(id));
      const aged = advanceFoodSpoilage(initial, { elapsedMinutes: 365 * 24 * 60 });

      expect(aged.freshness).toMatchObject({
        perishable: false,
        ageMinutes: 365 * 24 * 60,
        spoilageMinutes: 0,
        freshForMinutes: null,
        rottenAfterMinutes: null,
        state: FOOD_FRESHNESS_STATES.FRESH,
      });
      expect(getFoodConsumptionModifiers(aged)).toEqual({
        edible: true,
        freshnessState: FOOD_FRESHNESS_STATES.FRESH,
        effectMultiplier: 1,
        foodPoisoningRisk: false,
      });
    }
  });
});

describe('minute-based food spoilage', () => {
  it('prioritizes validated catalog spoilage over saved and built-in thresholds', () => {
    const configuredFood = {
      id: 'fresh_milk',
      category: 'food',
      tags: ['food', 'perishable'],
      spoilage: { freshForMinutes: 90, rottenAfterMinutes: 240 },
    };
    const created = createItemConditionState(configuredFood, {
      freshness: { freshForMinutes: 900, rottenAfterMinutes: 1_800 },
    });
    const normalized = normalizeItemConditionState({
      itemId: 'fresh_milk',
      freshness: {
        perishable: true,
        ageMinutes: 100,
        spoilageMinutes: 100,
        freshForMinutes: 900,
        rottenAfterMinutes: 1_800,
      },
    }, configuredFood);

    expect(created.freshness).toMatchObject({
      freshForMinutes: 90,
      rottenAfterMinutes: 240,
      state: FOOD_FRESHNESS_STATES.FRESH,
    });
    expect(normalized.freshness).toMatchObject({
      freshForMinutes: 90,
      rottenAfterMinutes: 240,
      state: FOOD_FRESHNESS_STATES.STALE,
    });
    expect(advanceFoodSpoilage(created, { elapsedMinutes: 240 }).freshness.state)
      .toBe(FOOD_FRESHNESS_STATES.ROTTEN);
  });

  it('clamps or falls back from malformed catalog spoilage thresholds', () => {
    const invalid = createItemConditionState({
      id: 'custom_perishable',
      category: 'food',
      tags: ['food', 'perishable'],
      spoilage: { freshForMinutes: -20, rottenAfterMinutes: Number.NaN },
    });
    const reversed = createItemConditionState({
      id: 'short_lived_food',
      category: 'food',
      tags: ['food', 'perishable'],
      spoilage: { freshForMinutes: 120, rottenAfterMinutes: 60 },
    });
    const enormous = createItemConditionState({
      id: 'oversized_threshold_food',
      category: 'food',
      tags: ['food', 'perishable'],
      spoilage: { freshForMinutes: 1e30, rottenAfterMinutes: 1e30 },
    });

    expect(invalid.freshness).toMatchObject({
      freshForMinutes: 2 * 24 * 60,
      rottenAfterMinutes: 5 * 24 * 60,
    });
    expect(reversed.freshness.freshForMinutes).toBe(120);
    expect(reversed.freshness.rottenAfterMinutes).toBe(121);
    expect(enormous.freshness.freshForMinutes).toBeLessThan(enormous.freshness.rottenAfterMinutes);
    expect(Number.isFinite(enormous.freshness.rottenAfterMinutes)).toBe(true);
  });

  it('crosses fresh, stale, and rotten boundaries at ambient temperature', () => {
    const initial = createItemConditionState(catalogItem('wild_berries'));
    const almostStale = advanceFoodSpoilage(initial, { elapsedMinutes: 2 * 24 * 60 - 1 });
    const stale = advanceFoodSpoilage(almostStale, { elapsedMinutes: 1 });
    const rotten = advanceFoodSpoilage(stale, { elapsedMinutes: 2 * 24 * 60 });

    expect(almostStale.freshness.state).toBe(FOOD_FRESHNESS_STATES.FRESH);
    expect(stale.freshness).toMatchObject({
      spoilageMinutes: 2 * 24 * 60,
      state: FOOD_FRESHNESS_STATES.STALE,
    });
    expect(rotten.freshness).toMatchObject({
      spoilageMinutes: 4 * 24 * 60,
      state: FOOD_FRESHNESS_STATES.ROTTEN,
    });
    expect(initial.freshness.spoilageMinutes).toBe(0);
  });

  it('slows spoilage only in a powered refrigerator and treats an outage as ambient storage', () => {
    const initial = createItemConditionState(catalogItem('wild_berries'));
    const elapsed = 24 * 60;
    const powered = advanceFoodSpoilage(initial, {
      elapsedMinutes: elapsed,
      refrigerated: true,
      powerOn: true,
    });
    const outage = advanceFoodSpoilage(initial, {
      elapsedMinutes: elapsed,
      refrigerated: true,
      powerOn: false,
    });
    const unrefrigerated = advanceFoodSpoilage(initial, {
      elapsedMinutes: elapsed,
      refrigerated: false,
      powerOn: true,
    });

    expect(powered.freshness.ageMinutes).toBe(elapsed);
    expect(powered.freshness.spoilageMinutes).toBe(elapsed * POWERED_REFRIGERATION_RATE);
    expect(outage.freshness.spoilageMinutes).toBe(elapsed);
    expect(unrefrigerated.freshness.spoilageMinutes).toBe(elapsed);
  });

  it('is call-frequency invariant across refrigeration followed by a power outage', () => {
    const initial = createItemConditionState(catalogItem('foraged_mushrooms'));
    const steppedCold = Array.from({ length: 24 }, () => 60).reduce(
      (state, elapsedMinutes) => advanceFoodSpoilage(state, {
        elapsedMinutes,
        refrigerated: true,
        powerOn: true,
      }),
      initial,
    );
    const directCold = advanceFoodSpoilage(initial, {
      elapsedMinutes: 24 * 60,
      refrigerated: true,
      powerOn: true,
    });
    const steppedOutage = Array.from({ length: 12 }, () => 60).reduce(
      (state, elapsedMinutes) => advanceFoodSpoilage(state, {
        elapsedMinutes,
        refrigerated: true,
        powerOn: false,
      }),
      steppedCold,
    );
    const directOutage = advanceFoodSpoilage(directCold, {
      elapsedMinutes: 12 * 60,
      refrigerated: true,
      powerOn: false,
    });

    expect(steppedCold).toEqual(directCold);
    expect(steppedOutage).toEqual(directOutage);
  });

  it('returns explicit eating multipliers and flags only rotten food for poisoning risk', () => {
    const fresh = createItemConditionState(catalogItem('wild_berries'));
    const stale = advanceFoodSpoilage(fresh, { elapsedMinutes: 2 * 24 * 60 });
    const rotten = advanceFoodSpoilage(fresh, { elapsedMinutes: 4 * 24 * 60 });

    expect(getFoodConsumptionModifiers(fresh)).toEqual({
      edible: true,
      freshnessState: 'fresh',
      effectMultiplier: 1,
      foodPoisoningRisk: false,
    });
    expect(getFoodConsumptionModifiers(stale)).toEqual({
      edible: true,
      freshnessState: 'stale',
      effectMultiplier: 0.65,
      foodPoisoningRisk: false,
    });
    expect(getFoodConsumptionModifiers(rotten)).toEqual({
      edible: true,
      freshnessState: 'rotten',
      effectMultiplier: 0.25,
      foodPoisoningRisk: true,
    });
    expect(getFoodConsumptionModifiers(createItemConditionState(catalogItem('bandage'))).edible).toBe(false);
  });
});

describe('weapon durability and legacy migration', () => {
  it('applies catalog-specific deterministic wear from both attacks and kills', () => {
    const initial = createItemConditionState(catalogItem('baseball_bat'));
    const used = applyWeaponWear(initial, { attacks: 10, kills: 2 });

    expect(used.condition).toMatchObject({
      current: 90,
      maximum: 100,
      wearPerAttack: 0.75,
      wearPerKill: 1.25,
      broken: false,
    });
    expect(applyWeaponWear(initial, { attacks: 10, kills: 2 })).toEqual(used);
    expect(initial.condition.current).toBe(100);
  });

  it('clamps excessive use at zero and permanently reports a broken weapon', () => {
    const fragile = createItemConditionState(catalogItem('crafted_spear'), {
      condition: { current: 5 },
    });
    const broken = applyWeaponWear(fragile, { attacks: 2, kills: 1 });
    const usedAgain = applyWeaponWear(broken, { attacks: 100, kills: 100 });

    expect(broken.condition.current).toBe(0);
    expect(broken.condition.broken).toBe(true);
    expect(isWeaponBroken(broken)).toBe(true);
    expect(usedAgain).toEqual(broken);
  });

  it('normalizes legacy inventory records with missing, flat, and malformed fields', () => {
    const bat = catalogItem('baseball_bat');
    const missing = normalizeItemConditionState({ id: bat.id, tags: bat.tags, category: bat.category });
    const overfilled = normalizeItemConditionState({
      ...bat,
      condition: 999,
      maxCondition: -25,
      wearPerAttack: -3,
      wearPerKill: Number.POSITIVE_INFINITY,
      broken: false,
    });
    const broken = normalizeItemConditionState({ ...bat, durability: -50, broken: true });
    const rottenFood = normalizeItemConditionState({
      ...catalogItem('wild_berries'),
      ageMinutes: 999_999,
      freshnessMinutes: 999_999,
      freshnessState: 'fresh',
    });

    expect(missing.condition.current).toBe(100);
    expect(overfilled.condition).toMatchObject({
      current: 100,
      maximum: 100,
      wearPerAttack: 0.75,
      wearPerKill: 1.25,
      broken: false,
    });
    expect(broken.condition).toMatchObject({ current: 0, broken: true });
    expect(rottenFood.freshness.state).toBe(FOOD_FRESHNESS_STATES.ROTTEN);
    expect(JSON.parse(JSON.stringify(overfilled))).toEqual(overfilled);
  });

  it('ignores negative and non-finite elapsed/use values without producing invalid state', () => {
    const food = createItemConditionState(catalogItem('wild_berries'));
    const weapon = createItemConditionState(catalogItem('crowbar'));

    expect(advanceFoodSpoilage(food, { elapsedMinutes: -60 })).toEqual(food);
    expect(advanceFoodSpoilage(food, { elapsedMinutes: Number.NaN })).toEqual(food);
    expect(applyWeaponWear(weapon, { attacks: -2, kills: Number.POSITIVE_INFINITY })).toEqual(weapon);
  });

  it('provides UI-ready labels, tones, percentages, and broken-weapon disable reasons', () => {
    const fresh = createItemConditionState(catalogItem('wild_berries'));
    const stale = advanceFoodSpoilage(fresh, { elapsedMinutes: 2 * 24 * 60 });
    const rotten = advanceFoodSpoilage(fresh, { elapsedMinutes: 4 * 24 * 60 });
    const worn = applyWeaponWear(createItemConditionState(catalogItem('baseball_bat')), { attacks: 40 });
    const broken = applyWeaponWear(createItemConditionState(catalogItem('crafted_spear')), { attacks: 100 });

    expect(getItemConditionDisplay(fresh)).toEqual({
      label: '新鲜', tone: 'good', percent: 100, disabledReason: null,
    });
    expect(getItemConditionDisplay(stale)).toEqual({
      label: '不新鲜', tone: 'warn', percent: 50, disabledReason: null,
    });
    expect(getItemConditionDisplay(rotten)).toEqual({
      label: '腐烂', tone: 'danger', percent: 0, disabledReason: null,
    });
    expect(getItemConditionDisplay(worn)).toEqual({
      label: '耐久 70%', tone: 'good', percent: 70, disabledReason: null,
    });
    expect(getItemConditionDisplay(broken)).toMatchObject({
      label: '已损坏', tone: 'danger', percent: 0,
    });
    expect(getItemConditionDisplay(broken).disabledReason).toContain('无法装备');
  });

  it('merges only equivalent lots and never hides condition or spoilage differences', () => {
    const firstCan = createItemConditionState(catalogItem('canned_soup'), { sequence: 1 });
    const secondCan = createItemConditionState(catalogItem('canned_soup'), { sequence: 2 });
    const firstBat = createItemConditionState(catalogItem('baseball_bat'), { sequence: 1 });
    const secondBat = createItemConditionState(catalogItem('baseball_bat'), { sequence: 2 });
    const berries = createItemConditionState(catalogItem('wild_berries'), { sequence: 1 });
    const olderBerries = advanceFoodSpoilage(
      createItemConditionState(catalogItem('wild_berries'), { sequence: 2 }),
      { elapsedMinutes: 60 },
    );

    expect(canMergeItemConditionStates(firstCan, secondCan)).toBe(true);
    expect(canMergeItemConditionStates(firstBat, secondBat)).toBe(true);
    expect(canMergeItemConditionStates(firstBat, applyWeaponWear(secondBat, { attacks: 1 }))).toBe(false);
    expect(canMergeItemConditionStates(berries, olderBerries)).toBe(false);
    expect(canMergeItemConditionStates(berries, olderBerries, { freshnessToleranceMinutes: 60 })).toBe(true);
    expect(canMergeItemConditionStates(firstCan, firstBat)).toBe(false);
  });
});
