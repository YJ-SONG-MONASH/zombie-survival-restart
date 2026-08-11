import { describe, expect, it } from 'vitest';
import { createItemConditionState } from '../src/services/item-condition.js';
import {
  FOOD_PREPARATION_RECIPES,
  FOOD_PREPARATION_VERSION,
  listFoodPreparationOptions,
  previewFoodPreparation,
  resolveFoodPreparation,
} from '../src/services/food-preparation.js';

const HOUR = 60;

const catalog = [
  food('fresh_meat', 2, 24 * HOUR, 72 * HOUR),
  food('cabbage', 1, 3 * 24 * HOUR, 7 * 24 * HOUR),
  food('apple', 1, 5 * 24 * HOUR, 10 * 24 * HOUR),
  food('wild_berries', 1, 2 * 24 * HOUR, 4 * 24 * HOUR),
  food('canned_soup', 1),
  tool('cooking_pot', 2),
  tool('kitchen_knife', 1),
  tool('hunting_knife', 1),
  tool('machete', 3),
  food('cooked_meat', 2, 2 * 24 * HOUR, 4 * 24 * HOUR),
  food('vegetable_soup', 2, 24 * HOUR, 3 * 24 * HOUR),
  food('meat_stew', 2, 24 * HOUR, 3 * 24 * HOUR),
  food('fruit_salad', 1, 12 * HOUR, 36 * HOUR),
  food('heated_canned_soup', 1, 24 * HOUR, 3 * 24 * HOUR),
];

const catalogById = new Map(catalog.map((item) => [item.id, item]));

function food(id, space, freshForMinutes = null, rottenAfterMinutes = null) {
  return {
    id,
    name: id,
    category: 'food',
    space,
    effects: { hunger: -10 },
    tags: freshForMinutes == null ? ['food'] : ['food', 'perishable'],
    ...(freshForMinutes == null ? {} : { spoilage: { freshForMinutes, rottenAfterMinutes } }),
  };
}

function tool(id, space) {
  return { id, name: id, category: 'tool', space, effects: {}, tags: ['tool'] };
}

function stack(itemId, count = 1, sequence = 1, freshness = null) {
  const item = catalogById.get(itemId);
  const conditionState = createItemConditionState(item, {
    acquiredMinutes: 100,
    acquisitionSequence: sequence,
    sourceId: 'test',
    ...(freshness ? { freshness } : {}),
  });
  return {
    ...structuredClone(item),
    count,
    stackId: conditionState.stackId,
    conditionState,
  };
}

function baseContext(overrides = {}) {
  return {
    catalog: structuredClone(catalog),
    containers: {
      carry: [],
      base: [
        stack('fresh_meat', 2, 1),
        stack('cabbage', 2, 2),
        stack('apple', 2, 3),
        stack('wild_berries', 2, 4),
        stack('canned_soup', 2, 5),
        stack('cooking_pot', 1, 6),
        stack('kitchen_knife', 1, 7),
      ],
    },
    capacities: { carry: 30, base: 100 },
    cookingSkill: 3,
    nowMinutes: 2_000,
    powerAvailableMinutes: 180,
    municipalWaterOn: true,
    baseWaterReserve: 2,
    revision: 4,
    appliedCommandIds: ['earlier-command'],
    nextItemSequence: 100,
    ...overrides,
  };
}

function ingredient(context, itemId, occurrence = 0) {
  const matches = Object.entries(context.containers)
    .flatMap(([containerId, entries]) => entries.map((entry) => ({ containerId, entry })))
    .filter(({ entry }) => entry.id === itemId);
  const selected = matches[occurrence];
  if (!selected) throw new Error(`Missing test ingredient ${itemId}`);
  return { containerId: selected.containerId, stackId: selected.entry.stackId, count: 1 };
}

function command(context, recipeId, itemIds, overrides = {}) {
  return {
    recipeId,
    ingredientSelections: itemIds.map((itemId) => ingredient(context, itemId)),
    destinationId: 'base',
    expectedRevision: context.revision,
    commandId: `prepare:${recipeId}:${context.revision}`,
    ...overrides,
  };
}

function countItem(containers, itemId) {
  return Object.values(containers)
    .flat()
    .filter((item) => item.id === itemId)
    .reduce((sum, item) => sum + item.count, 0);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

describe('food preparation recipe contract', () => {
  it('publishes a JSON-safe fixed five-recipe catalog', () => {
    expect(FOOD_PREPARATION_VERSION).toBe(1);
    expect(FOOD_PREPARATION_RECIPES.map((recipe) => recipe.resultId)).toEqual([
      'cooked_meat',
      'vegetable_soup',
      'meat_stew',
      'fruit_salad',
      'heated_canned_soup',
    ]);
    expect(JSON.parse(JSON.stringify(FOOD_PREPARATION_RECIPES))).toEqual(FOOD_PREPARATION_RECIPES);
  });

  it.each([
    ['cook_meat', ['fresh_meat'], 'cooked_meat'],
    ['vegetable_soup', ['cabbage'], 'vegetable_soup'],
    ['meat_stew', ['fresh_meat', 'cabbage'], 'meat_stew'],
    ['fruit_salad', ['apple', 'wild_berries'], 'fruit_salad'],
    ['heat_canned_soup', ['canned_soup'], 'heated_canned_soup'],
  ])('resolves %s with authoritative inputs and output', (recipeId, inputIds, outputId) => {
    const context = baseContext();
    const before = snapshot(context);
    const result = resolveFoodPreparation(context, command(context, recipeId, inputIds));

    expect(result).toMatchObject({
      ok: true,
      reason: null,
      recipeId,
      resultId: outputId,
      waterSource: ['vegetable_soup', 'meat_stew'].includes(recipeId) ? 'municipal' : 'none',
    });
    expect(result.minutes).toBeGreaterThan(0);
    expect(result.skillXp).toBeGreaterThan(0);
    expect(result.preparedStack).toMatchObject({ id: outputId, count: expect.any(Number) });
    expect(countItem(result.nextState.containers, outputId)).toBe(result.preparedStack.count);
    inputIds.forEach((id) => expect(countItem(result.nextState.containers, id)).toBe(countItem(before.containers, id) - 1));
    expect(countItem(result.nextState.containers, 'cooking_pot')).toBe(1);
    expect(countItem(result.nextState.containers, 'kitchen_knife')).toBe(1);
    expect(result.nextState).toMatchObject({
      revision: context.revision + 1,
      nextItemSequence: context.nextItemSequence + result.preparedStack.count,
    });
    expect(result.nextState.appliedCommandIds.at(-1)).toBe(`prepare:${recipeId}:${context.revision}`);
    expect(context).toEqual(before);
  });

  it('lists deterministic options with exact suggested stack selections and disabled reasons', () => {
    const context = baseContext({ powerAvailableMinutes: 0 });
    const before = snapshot(context);
    const options = listFoodPreparationOptions(context);

    expect(options).toHaveLength(5);
    expect(options.find((entry) => entry.id === 'fruit_salad')).toMatchObject({ enabled: true, disabledReason: '' });
    expect(options.find((entry) => entry.id === 'cook_meat')).toMatchObject({ enabled: false, disabledReason: 'power_unavailable' });
    expect(options.find((entry) => entry.id === 'fruit_salad').suggestedIngredientSelections)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ containerId: 'base', stackId: ingredient(context, 'apple').stackId }),
        expect.objectContaining({ containerId: 'base', stackId: ingredient(context, 'wild_berries').stackId }),
      ]));
    expect(context).toEqual(before);
  });
});

describe('exact, atomic ingredient projection', () => {
  it('consumes only the selected container and stack while leaving an identical lot untouched', () => {
    const first = stack('fresh_meat', 1, 20);
    const selected = stack('fresh_meat', 1, 21);
    const context = baseContext({
      containers: {
        carry: [first],
        base: [selected, stack('cooking_pot', 1, 22)],
      },
    });
    const result = resolveFoodPreparation(context, command(context, 'cook_meat', [], {
      ingredientSelections: [{ containerId: 'base', stackId: selected.stackId, count: 1 }],
    }));

    expect(result.ok).toBe(true);
    expect(result.nextState.containers.carry).toEqual([first]);
    expect(result.nextState.containers.base.some((item) => item.stackId === selected.stackId)).toBe(false);
  });

  it.each([
    ['wrong container', { containerId: 'carry' }, 'stack_missing'],
    ['item id instead of stack id', { stackId: 'fresh_meat' }, 'stack_missing'],
    ['extra selected ingredient', { extra: true }, 'ingredient_mismatch'],
  ])('rejects %s without consuming anything', (_label, mutation, reason) => {
    const context = baseContext();
    const valid = command(context, 'cook_meat', ['fresh_meat']);
    const selection = { ...valid.ingredientSelections[0], ...mutation };
    const request = {
      ...valid,
      ingredientSelections: mutation.extra
        ? [selection, ingredient(context, 'cabbage')]
        : [selection],
    };
    const before = snapshot(context);
    const result = resolveFoodPreparation(context, request);

    expect(result).toMatchObject({ ok: false, reason });
    expect(result.nextState).toEqual(expect.objectContaining({ containers: before.containers }));
    expect(context).toEqual(before);
  });

  it('rejects output capacity atomically after projecting ingredient removal', () => {
    const context = baseContext({ capacities: { carry: 0, base: 100 } });
    const before = snapshot(context);
    const result = resolveFoodPreparation(context, command(context, 'cook_meat', ['fresh_meat'], { destinationId: 'carry' }));

    expect(result).toMatchObject({ ok: false, reason: 'capacity_exceeded' });
    expect(result.nextState.containers).toEqual(before.containers);
    expect(context).toEqual(before);
  });
});

describe('freshness, heat, water, tools, and skill gates', () => {
  it('carries the worst spoilage progress into the output and never launders stale food into fresh food', () => {
    const rawCatalog = catalogById.get('fresh_meat');
    const staleMeat = stack('fresh_meat', 1, 30, {
      perishable: true,
      ageMinutes: 40 * HOUR,
      spoilageMinutes: 40 * HOUR,
      freshForMinutes: rawCatalog.spoilage.freshForMinutes,
      rottenAfterMinutes: rawCatalog.spoilage.rottenAfterMinutes,
      state: 'stale',
    });
    const context = baseContext({ containers: { carry: [], base: [staleMeat, stack('cooking_pot', 1, 31)] } });
    const result = resolveFoodPreparation(context, command(context, 'cook_meat', [], {
      ingredientSelections: [{ containerId: 'base', stackId: staleMeat.stackId, count: 1 }],
    }));

    expect(result.ok).toBe(true);
    expect(result.preparedStack.conditionState.freshness.state).toBe('stale');
    const inputProgress = 40 / 72;
    const outputFreshness = result.preparedStack.conditionState.freshness;
    expect(outputFreshness.spoilageMinutes / outputFreshness.rottenAfterMinutes).toBeGreaterThanOrEqual(inputProgress);
  });

  it('rejects rotten ingredients with a complete zero-change projection', () => {
    const rawCatalog = catalogById.get('fresh_meat');
    const rottenMeat = stack('fresh_meat', 1, 32, {
      perishable: true,
      ageMinutes: 80 * HOUR,
      spoilageMinutes: 80 * HOUR,
      freshForMinutes: rawCatalog.spoilage.freshForMinutes,
      rottenAfterMinutes: rawCatalog.spoilage.rottenAfterMinutes,
      state: 'rotten',
    });
    const context = baseContext({ containers: { carry: [], base: [rottenMeat, stack('cooking_pot', 1, 33)] } });
    const before = snapshot(context);
    const result = resolveFoodPreparation(context, command(context, 'cook_meat', [], {
      ingredientSelections: [{ containerId: 'base', stackId: rottenMeat.stackId, count: 1 }],
    }));

    expect(result).toMatchObject({ ok: false, reason: 'ingredient_rotten' });
    expect(result.nextState.containers).toEqual(before.containers);
  });

  it('requires a cooking pot and uninterrupted power for every heated recipe, but not for fruit salad', () => {
    const powered = baseContext();
    const preview = previewFoodPreparation(powered, command(powered, 'cook_meat', ['fresh_meat']));
    expect(preview.ok).toBe(true);

    const shortPower = baseContext({ powerAvailableMinutes: preview.minutes - 1 });
    expect(resolveFoodPreparation(shortPower, command(shortPower, 'cook_meat', ['fresh_meat'])))
      .toMatchObject({ ok: false, reason: 'power_unavailable' });

    const noPot = baseContext({ containers: {
      carry: [],
      base: baseContext().containers.base.filter((item) => item.id !== 'cooking_pot'),
    } });
    expect(resolveFoodPreparation(noPot, command(noPot, 'cook_meat', ['fresh_meat'])))
      .toMatchObject({ ok: false, reason: 'tool_missing' });

    const coldPrep = baseContext({ powerAvailableMinutes: 0 });
    expect(resolveFoodPreparation(coldPrep, command(coldPrep, 'fruit_salad', ['apple', 'wild_berries'])).ok).toBe(true);
  });

  it('requires one knife for fruit salad and accepts any supported knife without consuming it', () => {
    const withoutKnife = baseContext({ containers: {
      carry: [],
      base: baseContext().containers.base.filter((item) => !['kitchen_knife', 'hunting_knife', 'machete'].includes(item.id)),
    } });
    expect(resolveFoodPreparation(withoutKnife, command(withoutKnife, 'fruit_salad', ['apple', 'wild_berries'])))
      .toMatchObject({ ok: false, reason: 'tool_missing' });

    const machete = stack('machete', 1, 40);
    const withMachete = baseContext({ containers: {
      carry: [machete],
      base: withoutKnife.containers.base,
    } });
    const result = resolveFoodPreparation(withMachete, command(withMachete, 'fruit_salad', ['apple', 'wild_berries']));
    expect(result.ok).toBe(true);
    expect(result.nextState.containers.carry).toContainEqual(machete);
  });

  it('uses municipal water without draining reserve, otherwise drains exactly one reserve, and fails dry', () => {
    const municipal = baseContext({ baseWaterReserve: 2, municipalWaterOn: true });
    const municipalResult = resolveFoodPreparation(municipal, command(municipal, 'vegetable_soup', ['cabbage']));
    expect(municipalResult).toMatchObject({ ok: true, waterSource: 'municipal' });
    expect(municipalResult.nextState.baseWaterReserve).toBe(2);

    const reserve = baseContext({ baseWaterReserve: 2, municipalWaterOn: false });
    const reserveResult = resolveFoodPreparation(reserve, command(reserve, 'vegetable_soup', ['cabbage']));
    expect(reserveResult).toMatchObject({ ok: true, waterSource: 'reserve' });
    expect(reserveResult.nextState.baseWaterReserve).toBe(1);

    const dry = baseContext({ baseWaterReserve: 0, municipalWaterOn: false });
    expect(resolveFoodPreparation(dry, command(dry, 'vegetable_soup', ['cabbage'])))
      .toMatchObject({ ok: false, reason: 'water_unavailable' });
  });

  it('uses cooking skill only for unlocks and deterministic time reduction', () => {
    const novice = baseContext({ cookingSkill: 0 });
    expect(resolveFoodPreparation(novice, command(novice, 'meat_stew', ['fresh_meat', 'cabbage'])))
      .toMatchObject({ ok: false, reason: 'skill_too_low' });

    const trained = baseContext({ cookingSkill: 3 });
    const expert = baseContext({ cookingSkill: 10 });
    const trainedPreview = previewFoodPreparation(trained, command(trained, 'cook_meat', ['fresh_meat']));
    const expertPreview = previewFoodPreparation(expert, command(expert, 'cook_meat', ['fresh_meat']));
    expect(expertPreview.minutes).toBeLessThan(trainedPreview.minutes);
    expect(expertPreview.preparedStack.count).toBe(trainedPreview.preparedStack.count);
  });
});

describe('optimistic concurrency and serialization', () => {
  it('rejects stale revisions and duplicate command IDs without changing the projected state', () => {
    const context = baseContext();
    const before = snapshot(context);
    const stale = resolveFoodPreparation(context, command(context, 'cook_meat', ['fresh_meat'], { expectedRevision: 3 }));
    const duplicate = resolveFoodPreparation(context, command(context, 'cook_meat', ['fresh_meat'], { commandId: 'earlier-command' }));

    expect(stale).toMatchObject({ ok: false, reason: 'stale_revision', replayed: false });
    expect(duplicate).toMatchObject({ ok: false, reason: 'duplicate_command', replayed: true });
    expect(stale.nextState.containers).toEqual(before.containers);
    expect(duplicate.nextState.containers).toEqual(before.containers);
    expect(context).toEqual(before);
  });

  it('keeps only the latest 64 committed command IDs', () => {
    const context = baseContext({ appliedCommandIds: Array.from({ length: 64 }, (_, index) => `old-${index}`) });
    const result = resolveFoodPreparation(context, command(context, 'cook_meat', ['fresh_meat'], { commandId: 'new-command' }));
    expect(result.ok).toBe(true);
    expect(result.nextState.appliedCommandIds).toHaveLength(64);
    expect(result.nextState.appliedCommandIds[0]).toBe('old-1');
    expect(result.nextState.appliedCommandIds.at(-1)).toBe('new-command');
  });

  it('accepts deeply frozen JSON input, returns JSON-safe output, and never mutates caller state', () => {
    const context = deepFreeze(baseContext());
    const request = deepFreeze(command(context, 'fruit_salad', ['apple', 'wild_berries']));
    const before = snapshot(context);
    const result = resolveFoodPreparation(context, request);

    expect(result.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(context).toEqual(before);
  });
});
