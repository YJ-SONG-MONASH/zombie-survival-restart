import { describe, expect, it } from 'vitest';
import {
  craftingRecipes,
  eventDeck,
  hiddenProfessionAliases,
  hiddenSurvivorPresets,
  mapEdges,
  mapNodeActions,
  mapNodeDetails,
  mapNodes,
  marketItems,
  professions,
  scenarios,
  shelterLootProfiles,
  shelters,
  skillDefinitions,
  spawnLocations,
  traits,
  universalShelterLootPools,
} from '../src/data/zombie.js';

const duplicateIds = (entries) => {
  const seen = new Set();
  const duplicates = new Set();
  entries.forEach(({ id }) => {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  });
  return [...duplicates];
};

const idsOf = (entries) => new Set(entries.map(({ id }) => id));

describe('catalog integrity', () => {
  it.each([
    ['scenarios', scenarios],
    ['spawn locations', spawnLocations],
    ['professions', professions],
    ['traits', traits],
    ['shelters', shelters],
    ['items', marketItems],
    ['map nodes', mapNodes],
    ['map actions', mapNodeActions],
    ['events', eventDeck],
    ['skills', skillDefinitions],
    ['recipes', craftingRecipes],
  ])('%s have non-empty unique ids', (_name, entries) => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);
    expect(duplicateIds(entries)).toEqual([]);
  });

  it('keeps profession, hidden-character, and trait references valid', () => {
    const professionIds = idsOf(professions);
    const traitIds = idsOf(traits);
    const itemIds = idsOf(marketItems);

    expect(professions.flatMap((profession) =>
      (profession.unlocks ?? []).filter((id) => !itemIds.has(id)).map((id) => `${profession.id}->${id}`)
    )).toEqual([]);
    expect(traits.flatMap((trait) =>
      (trait.conflicts ?? []).filter((id) => !traitIds.has(id)).map((id) => `${trait.id}->${id}`)
    )).toEqual([]);
    expect(hiddenProfessionAliases
      .filter((entry) => !professionIds.has(entry.professionId))
      .map((entry) => entry.professionId)).toEqual([]);
    expect(hiddenSurvivorPresets.flatMap((preset) => [
      ...(professionIds.has(preset.professionId) ? [] : [`profession:${preset.professionId}`]),
      ...preset.traitIds.filter((id) => !traitIds.has(id)).map((id) => `trait:${id}`),
    ])).toEqual([]);
  });

  it('keeps the map connected with valid edges, actions, and details', () => {
    const nodeIds = idsOf(mapNodes);
    const actionIds = idsOf(mapNodeActions);
    const invalidEdges = mapEdges.flatMap(([from, to]) => [
      ...(nodeIds.has(from) ? [] : [from]),
      ...(nodeIds.has(to) ? [] : [to]),
    ]);
    const invalidActions = mapNodes.flatMap((node) =>
      (node.actions ?? []).filter((id) => !actionIds.has(id)).map((id) => `${node.id}->${id}`)
    );

    const visited = new Set([mapNodes[0].id]);
    const queue = [mapNodes[0].id];
    while (queue.length) {
      const current = queue.shift();
      mapEdges.forEach(([from, to]) => {
        const neighbor = from === current ? to : to === current ? from : null;
        if (neighbor && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }

    expect(invalidEdges).toEqual([]);
    expect(invalidActions).toEqual([]);
    expect(Object.keys(mapNodeDetails).filter((id) => !nodeIds.has(id))).toEqual([]);
    expect(mapNodes.filter((node) => !mapNodeDetails[node.id]).map((node) => node.id)).toEqual([]);
    expect(mapNodes.filter((node) => !visited.has(node.id)).map((node) => node.id)).toEqual([]);
  });

  it('keeps shelter and loot references valid', () => {
    const shelterIds = idsOf(shelters);
    const locationIds = idsOf(spawnLocations);
    const itemIds = idsOf(marketItems);
    const invalidLocations = shelters.flatMap((shelter) =>
      (shelter.locations ?? []).filter((id) => !locationIds.has(id)).map((id) => `${shelter.id}->${id}`)
    );
    const invalidPools = Object.entries(universalShelterLootPools).flatMap(([pool, ids]) =>
      ids.filter((id) => !itemIds.has(id)).map((id) => `${pool}->${id}`)
    );
    const invalidProfiles = Object.entries(shelterLootProfiles).flatMap(([shelterId, profile]) => [
      ...(shelterIds.has(shelterId) ? [] : [`profile:${shelterId}`]),
      ...(profile.guaranteed ?? []).flatMap((entry) => [
        ...(entry.itemId && !itemIds.has(entry.itemId) ? [`${shelterId}->${entry.itemId}`] : []),
        ...(entry.itemIds ?? []).filter((id) => !itemIds.has(id)).map((id) => `${shelterId}->${id}`),
      ]),
    ]);

    expect(invalidLocations).toEqual([]);
    expect(invalidPools).toEqual([]);
    expect(invalidProfiles).toEqual([]);
  });

  it('keeps crafting inputs, outputs, tools, and skills valid', () => {
    const itemIds = idsOf(marketItems);
    const skillIds = idsOf(skillDefinitions);
    const invalid = craftingRecipes.flatMap((recipe) => [
      ...(itemIds.has(recipe.resultId) ? [] : [`${recipe.id}:result:${recipe.resultId}`]),
      ...recipe.ingredients.filter(({ itemId }) => !itemIds.has(itemId)).map(({ itemId }) => `${recipe.id}:ingredient:${itemId}`),
      ...(recipe.tools ?? []).filter((id) => !itemIds.has(id)).map((id) => `${recipe.id}:tool:${id}`),
      ...(recipe.anyTools ?? []).filter((id) => !itemIds.has(id)).map((id) => `${recipe.id}:anyTool:${id}`),
      ...(skillIds.has(recipe.skillId) ? [] : [`${recipe.id}:skill:${recipe.skillId}`]),
    ]);

    expect(invalid).toEqual([]);
  });
});
