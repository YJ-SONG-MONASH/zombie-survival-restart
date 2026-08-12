import { describe, expect, it } from 'vitest';

import {
  fishingSpots,
  mapNodeActions,
  mapNodes,
  marketItems,
} from '../src/data/zombie.js';
import { createItemConditionState } from '../src/services/item-condition.js';
import {
  FOOD_PREPARATION_RECIPES,
  resolveFoodPreparation,
} from '../src/services/food-preparation.js';
import { createWorldLootContainer } from '../src/services/world-loot.js';

const DAY = 24 * 60;
const item = (id) => marketItems.find((entry) => entry.id === id);

function stack(itemId, sequence, freshness = null) {
  const catalogItem = item(itemId);
  const conditionState = createItemConditionState(catalogItem, {
    acquiredMinutes: 120,
    acquisitionSequence: sequence,
    sourceId: 'v12-fishing-test',
    ...(freshness ? { freshness } : {}),
  });
  return {
    ...structuredClone(catalogItem),
    count: 1,
    stackId: conditionState.stackId,
    conditionState,
  };
}

function cookingContext(fish) {
  return {
    catalog: structuredClone(marketItems),
    containers: {
      carry: [],
      base: [fish, stack('cooking_pot', 2)],
    },
    capacities: { carry: 30, base: 100 },
    cookingSkill: 0,
    nowMinutes: 2_000,
    powerAvailableMinutes: 45,
    municipalWaterOn: false,
    baseWaterReserve: 0,
    revision: 0,
    appliedCommandIds: [],
    nextItemSequence: 10,
  };
}

function cookFishCommand(fish) {
  return {
    recipeId: 'cook_fish',
    ingredientSelections: [{ containerId: 'base', stackId: fish.stackId, count: 1 }],
    destinationId: 'base',
    expectedRevision: 0,
    commandId: `v12:cook-fish:${fish.stackId}`,
  };
}

describe('v0.12 fishing data contract', () => {
  it('exports the three explicit, bounded fishing spots', () => {
    expect(fishingSpots).toEqual([
      { nodeId: 'riverside', capacity: 4, regenPerDay: 1, baseCatchChance: 0.38 },
      { nodeId: 'riverside_farms', capacity: 3, regenPerDay: 1, baseCatchChance: 0.35 },
      { nodeId: 'west_point', capacity: 6, regenPerDay: 2, baseCatchChance: 0.42 },
    ]);
    expect(new Set(fishingSpots.map(({ nodeId }) => nodeId)).size).toBe(fishingSpots.length);
  });

  it('publishes fish as a canonical map action at every fishing spot', () => {
    expect(mapNodeActions.find(({ id }) => id === 'fish')).toEqual(expect.objectContaining({
      label: '捕鱼',
      stat: 'fishing',
      description: expect.any(String),
    }));
    fishingSpots.forEach(({ nodeId }) => {
      expect(mapNodes.find((node) => node.id === nodeId)?.actions).toContain('fish');
    });
  });
});

describe('v0.12 fish catalog and preparation contract', () => {
  it('defines frozen raw and cooked fish spoilage thresholds', () => {
    expect(item('fresh_fish')).toEqual(expect.objectContaining({
      category: 'food',
      spoilage: { freshForMinutes: DAY, rottenAfterMinutes: 3 * DAY },
      tags: expect.arrayContaining(['food', 'fishing', 'perishable']),
    }));
    expect(item('fresh_fish').tags).not.toContain('prepared');

    expect(item('cooked_fish')).toEqual(expect.objectContaining({
      category: 'food',
      spoilage: { freshForMinutes: 2 * DAY, rottenAfterMinutes: 5 * DAY },
      tags: expect.arrayContaining(['food', 'fishing', 'prepared', 'perishable']),
    }));
    expect(item('cooked_fish').effects.hunger).toBeLessThan(item('fresh_fish').effects.hunger);
    expect(item('cooked_fish').effects.health).toBeGreaterThan(item('fresh_fish').effects.health);
  });

  it('defines cook_fish as one fresh fish plus a retained pot and 45 minutes of heat', () => {
    expect(FOOD_PREPARATION_RECIPES.find(({ id }) => id === 'cook_fish')).toEqual(expect.objectContaining({
      resultId: 'cooked_fish',
      resultCount: 1,
      ingredients: [{ itemId: 'fresh_fish', count: 1 }],
      tools: ['cooking_pot'],
      baseMinutes: 45,
      minutes: 45,
      heatRequired: true,
      requiresHeat: true,
      waterUnits: 0,
    }));
  });

  it('keeps prepared fish out of generic world loot', () => {
    const generated = createWorldLootContainer({
      worldSeed: 'v12-fishing',
      searchKey: 'riverside:river-bank',
      searchable: { id: 'river-bank', name: '河岸', quality: 'blue', description: '河岸补给。' },
      node: { id: 'riverside', type: 'spawn_town', danger: 2, resourceHint: '河岸补给' },
      catalog: [item('cooked_fish')],
    });

    expect(generated.slots).toEqual([]);
  });

  it('inherits stale fish spoilage progress through the existing preparation service', () => {
    const staleFish = stack('fresh_fish', 3, {
      perishable: true,
      ageMinutes: 2 * DAY,
      spoilageMinutes: 2 * DAY,
      freshForMinutes: DAY,
      rottenAfterMinutes: 3 * DAY,
      state: 'stale',
    });
    const context = cookingContext(staleFish);
    const result = resolveFoodPreparation(context, cookFishCommand(staleFish));

    expect(result).toMatchObject({ ok: true, resultId: 'cooked_fish', minutes: 45 });
    expect(result.nextState.containers.base.some(({ id }) => id === 'cooking_pot')).toBe(true);
    expect(result.preparedStack.conditionState.freshness.state).toBe('stale');
    expect(result.preparedStack.conditionState.freshness.spoilageMinutes)
      .toBeGreaterThanOrEqual(Math.ceil((2 / 3) * 5 * DAY));
  });

  it('atomically rejects rotten fish through ingredient_rotten', () => {
    const rottenFish = stack('fresh_fish', 4, {
      perishable: true,
      ageMinutes: 3 * DAY,
      spoilageMinutes: 3 * DAY,
      freshForMinutes: DAY,
      rottenAfterMinutes: 3 * DAY,
      state: 'rotten',
    });
    const context = cookingContext(rottenFish);
    const before = structuredClone(context.containers);
    const result = resolveFoodPreparation(context, cookFishCommand(rottenFish));

    expect(result).toMatchObject({ ok: false, reason: 'ingredient_rotten' });
    expect(result.nextState.containers).toEqual(before);
    expect(context.containers).toEqual(before);
  });
});
