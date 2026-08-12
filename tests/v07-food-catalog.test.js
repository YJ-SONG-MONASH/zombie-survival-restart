import { describe, expect, it } from 'vitest';
import {
  marketItems,
  shelterLootProfiles,
  universalShelterLootPools,
} from '../src/data/zombie.js';

const NEW_FOOD_IDS = [
  'cooked_meat',
  'cooked_fish',
  'vegetable_soup',
  'meat_stew',
  'fruit_salad',
  'heated_canned_soup',
];

const RECIPE_CATALOG_IDS = [
  'cooking_pot',
  'fresh_meat',
  'fresh_fish',
  'cabbage',
  'water_bottle',
  'apple',
  'wild_berries',
  'canned_soup',
  ...NEW_FOOD_IDS,
];

const item = (id) => marketItems.find((entry) => entry.id === id);

describe('v0.7 food preparation catalog', () => {
  it('keeps item ids unique and defines every item expected by food preparation recipes', () => {
    const itemIds = marketItems.map(({ id }) => id);

    expect(new Set(itemIds).size).toBe(itemIds.length);
    expect(RECIPE_CATALOG_IDS.filter((id) => !itemIds.includes(id))).toEqual([]);
  });

  it('defines the cooking pot as a discoverable green food-preparation tool', () => {
    expect(item('cooking_pot')).toEqual(expect.objectContaining({
      category: 'tool',
      tier: 'green',
      space: 2,
      iconFile: '',
      fallbackIcon: expect.any(String),
      effects: { skill: 'cooking' },
      tags: expect.arrayContaining(['tool', 'food_prep']),
    }));
  });

  it('defines prepared food with useful effects and bounded spoilage', () => {
    NEW_FOOD_IDS.forEach((id) => {
      const prepared = item(id);

      expect(prepared).toEqual(expect.objectContaining({
        category: 'food',
        iconFile: '',
        fallbackIcon: expect.any(String),
        effects: expect.objectContaining({ hunger: expect.any(Number) }),
        tags: expect.arrayContaining(['food', 'prepared', 'perishable']),
      }));
      expect(prepared.fallbackIcon.length).toBeGreaterThan(0);
      expect(prepared.effects.hunger).toBeLessThan(0);
      expect(prepared.spoilage.freshForMinutes).toBeGreaterThan(0);
      expect(prepared.spoilage.rottenAfterMinutes).toBeGreaterThan(prepared.spoilage.freshForMinutes);
    });
  });

  it('makes cooking meaningfully safer and more satisfying than eating key ingredients directly', () => {
    expect(item('cooked_meat').effects.hunger).toBeLessThan(item('fresh_meat').effects.hunger);
    expect(item('cooked_meat').effects.health).toBeGreaterThan(item('fresh_meat').effects.health);
    expect(item('cooked_meat').effects.stress).toBeLessThan(item('fresh_meat').effects.stress);
    expect(item('cooked_fish').effects.hunger).toBeLessThan(item('fresh_fish').effects.hunger);
    expect(item('cooked_fish').effects.health).toBeGreaterThan(item('fresh_fish').effects.health);

    expect(item('vegetable_soup').effects.hunger).toBeLessThan(item('cabbage').effects.hunger);
    expect(item('meat_stew').effects.health).toBeGreaterThan(item('fresh_meat').effects.health);
    expect(item('fruit_salad').effects.hunger).toBeLessThan(item('apple').effects.hunger);
    expect(item('heated_canned_soup').effects.hunger).toBeLessThan(item('canned_soup').effects.hunger);
    expect(item('heated_canned_soup').effects.stress).toBeLessThan(item('canned_soup').effects.stress);
  });

  it('places the cooking pot in residential loot profiles without flooding guaranteed food rolls', () => {
    const residentialProfiles = [
      'damaged_house',
      'trailer_home',
      'cheap_apartment_room',
      'two_story_house',
      'single_floor_house',
      'shop_apartment',
      'gated_villa',
    ];

    residentialProfiles.forEach((profileId) => {
      expect(shelterLootProfiles[profileId]?.itemBoosts?.cooking_pot).toBeGreaterThan(0);
    });
    expect(universalShelterLootPools.foods).toEqual(expect.arrayContaining([
      'canned_soup',
      'apple',
      'cabbage',
      'fresh_meat',
    ]));
    NEW_FOOD_IDS.forEach((id) => {
      expect(universalShelterLootPools.foods).not.toContain(id);
    });
  });
});
