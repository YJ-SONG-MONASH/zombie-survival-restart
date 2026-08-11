import { describe, expect, it } from 'vitest';
import {
  marketItems,
  shelterLootProfiles,
  universalShelterLootPools,
  vehicleEvents,
} from '../src/data/zombie.js';

const expectedPerishables = {
  apple: { freshForMinutes: 5 * 24 * 60, rottenAfterMinutes: 10 * 24 * 60 },
  cabbage: { freshForMinutes: 3 * 24 * 60, rottenAfterMinutes: 7 * 24 * 60 },
  milk: { freshForMinutes: 2 * 24 * 60, rottenAfterMinutes: 5 * 24 * 60 },
  fresh_meat: { freshForMinutes: 1 * 24 * 60, rottenAfterMinutes: 3 * 24 * 60 },
  bread: { freshForMinutes: 4 * 24 * 60, rottenAfterMinutes: 8 * 24 * 60 },
};

describe('v0.4 catalog additions', () => {
  it('defines five distinct perishable foods with valid effects and spoilage thresholds', () => {
    const profiles = Object.entries(expectedPerishables).map(([id, spoilage]) => {
      const item = marketItems.find((entry) => entry.id === id);
      expect(item).toBeTruthy();
      expect(item.category).toBe('food');
      expect(item.tags).toEqual(['food', 'perishable']);
      expect(item.effects).toEqual(expect.objectContaining({ hunger: expect.any(Number) }));
      expect(item.spoilage).toEqual(spoilage);
      expect(item.spoilage.freshForMinutes).toBeGreaterThan(0);
      expect(item.spoilage.rottenAfterMinutes).toBeGreaterThan(item.spoilage.freshForMinutes);
      return `${item.spoilage.freshForMinutes}:${item.spoilage.rottenAfterMinutes}`;
    });

    expect(new Set(profiles).size).toBe(Object.keys(expectedPerishables).length);
  });

  it('makes every new perishable available to generic shelter food rolls and a matching profile', () => {
    const profiledItems = new Set(Object.values(shelterLootProfiles)
      .flatMap((profile) => Object.keys(profile.itemBoosts ?? {})));

    Object.keys(expectedPerishables).forEach((id) => {
      expect(universalShelterLootPools.foods).toContain(id);
      expect(profiledItems).toContain(id);
    });
  });

  it('defines vehicle trunk capacities used by storage containers', () => {
    expect(Object.fromEntries(vehicleEvents.map(({ id, trunkSpace }) => [id, trunkSpace]))).toEqual({
      abandoned_sedan: 25,
      utility_truck: 50,
      police_cruiser: 35,
    });
    expect(vehicleEvents.every((event) => Number.isInteger(event.trunkSpace) && event.trunkSpace > 0)).toBe(true);
  });
});
