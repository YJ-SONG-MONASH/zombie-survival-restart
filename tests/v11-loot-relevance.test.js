import { describe, expect, it } from 'vitest';

import { mapNodeDetails, mapNodes, marketItems } from '../src/data/zombie.js';
import { createWorldLootContainer } from '../src/services/world-loot.js';

const hasAnyTag = (item, tags) => (
  Array.isArray(item.tags) && item.tags.some((tag) => tags.includes(tag))
);

const promisedItemMatchers = Object.freeze({
  maintenance: (item) => item.category === 'tool'
    || hasAnyTag(item, ['tool', 'repair', 'carpentry', 'mechanics', 'fuel', 'metalworking']),
  kitchen: (item) => ['food', 'drink'].includes(item.category)
    || hasAnyTag(item, ['food', 'water', 'canned', 'food_prep']),
  medical: (item) => item.category === 'medical' || hasAnyTag(item, ['medical', 'suture']),
  firearms: (item) => item.category === 'ammo' || hasAnyTag(item, ['ammo', 'firearm']),
  fuel: (item) => item.category === 'vehicle' || hasAnyTag(item, ['fuel', 'vehicle', 'mechanics']),
});

function nodeById(nodeId) {
  return mapNodes.find((node) => node.id === nodeId);
}

function searchableById(nodeId, searchableId, parent = null) {
  const searchable = mapNodeDetails[nodeId].searchables.find((entry) => entry.id === searchableId);
  return parent ? {
    ...searchable,
    parentSection: parent.section,
    parentId: parent.id,
    parentName: parent.name,
  } : searchable;
}

const canonicalPromises = Object.freeze([
  {
    label: '车库货架',
    nodeId: 'riverside',
    searchable: searchableById('riverside', 'riverside_garage_shelf'),
    matches: promisedItemMatchers.maintenance,
  },
  {
    label: '工具箱',
    nodeId: 'riverside_farms',
    searchable: searchableById('riverside_farms', 'farm_tool_chest'),
    matches: promisedItemMatchers.maintenance,
  },
  {
    label: '厨房柜（即使挂在五金店父节点下）',
    nodeId: 'riverside',
    searchable: searchableById('riverside', 'riverside_kitchen', {
      section: 'landmark',
      id: 'riverside_hardware',
      name: '五金店角落',
    }),
    matches: promisedItemMatchers.kitchen,
  },
  {
    label: '后厨冰柜',
    nodeId: 'chinatown',
    searchable: searchableById('chinatown', 'chinatown_freezer'),
    matches: promisedItemMatchers.kitchen,
  },
  {
    label: '急救包残件',
    nodeId: 'riverside_bridge',
    searchable: searchableById('riverside_bridge', 'bridge_medbag'),
    matches: promisedItemMatchers.medical,
  },
  {
    label: '医疗箱',
    nodeId: 'valley_checkpoint',
    searchable: searchableById('valley_checkpoint', 'checkpoint_medcrate'),
    matches: promisedItemMatchers.medical,
  },
  {
    label: '弹药货架',
    nodeId: 'west_point_gun_store',
    searchable: searchableById('west_point_gun_store', 'gun_ammo_shelf'),
    matches: promisedItemMatchers.firearms,
  },
  {
    label: '警车后备箱以描述中的枪械弹药承诺为准',
    nodeId: 'valley_checkpoint',
    searchable: searchableById('valley_checkpoint', 'checkpoint_cruiser_trunk'),
    matches: promisedItemMatchers.firearms,
  },
  {
    label: '燃油缓存',
    nodeId: 'louisville_outskirts',
    searchable: searchableById('louisville_outskirts', 'outskirts_fuel_cache'),
    matches: promisedItemMatchers.fuel,
  },
]);

describe('v0.11 location promise relevance', () => {
  it.each(canonicalPromises)('$label keeps a strict majority relevant across deterministic seeds', ({ nodeId, searchable, matches }) => {
    let relevantSlots = 0;
    let totalSlots = 0;

    for (let seedIndex = 0; seedIndex < 32; seedIndex += 1) {
      const context = {
        worldSeed: `v11-relevance-${seedIndex}`,
        searchKey: [nodeId, searchable.parentSection, searchable.parentId, searchable.id].filter(Boolean).join(':'),
        searchable,
        node: nodeById(nodeId),
        catalog: marketItems,
      };
      const generated = createWorldLootContainer(context);
      const reordered = createWorldLootContainer({ ...context, catalog: [...marketItems].reverse() });
      const catalogIndex = new Map(marketItems.map((item) => [item.id, item]));
      const matching = generated.slots.filter((slot) => matches(catalogIndex.get(slot.item.id)));

      expect(generated).toEqual(reordered);
      expect(generated.slots.length).toBeGreaterThan(0);
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(matching.length).toBeGreaterThan(Math.floor(generated.slots.length / 2));
      expect(generated.slots.every((slot) => !catalogIndex.get(slot.item.id).tags?.includes('prepared'))).toBe(true);

      relevantSlots += matching.length;
      totalSlots += generated.slots.length;
    }

    // This makes the playtest promise measurable rather than accepting a
    // single lucky seed: at least two thirds of all slots match the fixture.
    expect(relevantSlots / totalSlots).toBeGreaterThanOrEqual(2 / 3);
  });
});
