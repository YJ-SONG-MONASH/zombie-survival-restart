import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  mapNodes,
  marketItems,
  shelters,
  skillDefinitions,
} from '../src/data/zombie.js';
import { createNodeZombieState } from '../src/services/encounters.js';
import { createSkillExperience } from '../src/services/progression.js';
import {
  TACTICAL_ENEMY_PROFILES,
  resolveTacticalAction,
} from '../src/services/tactical-encounter.js';
import { storageUsedSpace } from '../src/services/storage.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function prepareRun(game, { nodeId = 'muldraugh', zombies = 6 } = {}) {
  game.shelter = clone(shelters.find((entry) => entry.id === 'starter_house') ?? shelters[0]);
  game.initializeMapState();
  const node = mapNodes.find((entry) => entry.id === nodeId);
  game.currentNodeId = node.id;
  game.inspectedNodeId = node.id;
  game.nodeZombieStates[node.id] = {
    ...createNodeZombieState({
      nodeId: node.id,
      danger: node.danger,
      seed: game.world.seed,
      day: game.day,
    }),
    count: zombies,
    clearedDay: null,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
}

function addItem(game, itemId, count = 1) {
  const catalog = marketItems.find((entry) => entry.id === itemId);
  expect(game.addItem(catalog, count, true)).toBe(true);
  return game.inventory.filter((entry) => entry.id === itemId);
}

function serviceContext(game) {
  return {
    node: mapNodes.find((entry) => entry.id === game.currentNodeId),
    inventory: clone(game.inventory),
    skills: clone(game.skills),
    vitals: clone(game.vitals),
    body: clone(game.body),
    world: {
      ...clone(game.world),
      isNight: game.clockMinutes >= 20 * 60 || game.clockMinutes < 6 * 60,
    },
    traits: clone(game.selectedTraits),
    totalMinutes: game.totalWorldMinutes,
    day: game.day,
    clockMinutes: game.clockMinutes,
    usedSpace: storageUsedSpace(game.inventory),
    capacity: game.maxSpace,
    equippedWeaponStackId: game.equippedWeaponStackId,
    firearmLoads: clone(game.firearmLoads),
  };
}

function commandFor(game, actionId, options = {}) {
  return {
    actionId,
    encounterId: game.activeTacticalEncounter.id,
    expectedTurn: game.activeTacticalEncounter.turn,
    ...options,
  };
}

function findDeterministicResolution(game, actionId, options, predicate) {
  for (let seed = 1; seed <= 500; seed += 1) {
    const state = clone(game.activeTacticalEncounter);
    state.rng = { seed, cursor: 0 };
    const result = resolveTacticalAction(
      state,
      {
        actionId,
        encounterId: state.id,
        expectedTurn: state.turn,
        ...options,
      },
      serviceContext(game),
    );
    if (result.ok && predicate(result)) return { state, result };
  }
  throw new Error(`No deterministic ${actionId} seed matched the requested outcome`);
}

describe('v0.8 tactical Store integration', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('migrates an in-progress v7 bucket encounter to a v8 enemy roster', () => {
    prepareRun(game, { zombies: 6 });
    const [bat] = addItem(game, 'baseball_bat');
    expect(game.equipWeapon(bat.stackId)).toBe(true);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);

    const snapshot = clone(game.$state);
    const v2 = snapshot.activeTacticalEncounter;
    const legacyPlayer = { ...v2.player };
    delete legacyPlayer.grabbedByEnemyIds;
    snapshot.saveVersion = 7;
    snapshot.activeTacticalEncounter = {
      ...v2,
      version: 1,
      turn: 4,
      rng: { seed: 73, cursor: 9 },
      player: legacyPlayer,
    };
    delete snapshot.activeTacticalEncounter.enemies;

    const storage = memoryStorage();
    storage.values.set('moshi-survival-state', JSON.stringify({ game: snapshot }));
    vi.stubGlobal('localStorage', storage);
    const restored = useGameStore(createPinia());
    restored.loadPersistedState();

    expect(SAVE_VERSION).toBe(8);
    expect(restored.saveVersion).toBe(8);
    expect(restored.activeTacticalEncounter).toMatchObject({
      version: 2,
      turn: 4,
      rng: { seed: 73, cursor: 9 },
    });
    expect(restored.activeTacticalEncounter.enemies).toHaveLength(
      restored.nodeZombieStates[restored.currentNodeId].count,
    );
    expect(JSON.parse(JSON.stringify(restored.activeTacticalEncounter))).toEqual(
      restored.activeTacticalEncounter,
    );
  });

  it('previews the selected target and rejects missing or stale targets with zero writes', () => {
    prepareRun(game, { zombies: 5 });
    const [spear] = addItem(game, 'crafted_spear');
    expect(game.equipWeapon(spear.stackId)).toBe(true);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    const target = [...game.activeTacticalEncounter.enemies]
      .filter((enemy) => enemy.posture === 'standing')
      .sort((left, right) => left.distance - right.distance)[0];

    const selected = game.tacticalActionsFor(target.id, spear.stackId);
    expect(selected.find((action) => action.id === 'melee')).toMatchObject({
      targetId: target.id,
      weaponStackId: spear.stackId,
    });
    expect(game.tacticalActionList.some((action) => action.targetId)).toBe(true);

    for (const targetId of [null, `${target.id}:stale`]) {
      const before = clone(game.$state);
      const result = game.performTacticalAction('melee', commandFor(game, 'melee', {
        weaponStackId: spear.stackId,
        targetId,
      }));
      expect(result).toBe(false);
      expect(game.$state).toEqual(before);
    }
  });

  it('commits partial HP damage without decrementing the node and returns a structured result', () => {
    prepareRun(game, { zombies: 4 });
    const [bat] = addItem(game, 'baseball_bat');
    game.skills = Object.fromEntries(Object.keys(game.skills).map((skillId) => [skillId, 10]));
    game.skillXp = createSkillExperience(game.skills, skillDefinitions.map((skill) => skill.id));
    expect(game.equipWeapon(bat.stackId)).toBe(true);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    const target = game.activeTacticalEncounter.enemies.find((enemy) => enemy.posture === 'standing');
    target.distance = 0;
    target.profileId = 'tough';
    target.hp = 999;
    target.maxHp = 999;

    const candidate = findDeterministicResolution(
      game,
      'melee',
      { weaponStackId: bat.stackId, targetId: target.id },
      (result) => result.effects.enemyChanges?.some((change) => change.targetId === target.id && change.damage > 0 && !change.killed),
    );
    game.activeTacticalEncounter = candidate.state;
    const beforeNodeCount = game.currentZombieState.count;
    const beforeTargetHp = game.activeTacticalEncounter.enemies.find((enemy) => enemy.id === target.id).hp;

    const result = game.performTacticalAction('melee', commandFor(game, 'melee', {
      weaponStackId: bat.stackId,
      targetId: target.id,
    }));

    expect(result).toMatchObject({
      ok: true,
      events: expect.any(Array),
      effects: expect.objectContaining({ zombieKills: 0, enemyChanges: expect.any(Array) }),
      summary: expect.any(Object),
      target: expect.objectContaining({
        targetId: target.id,
        targetName: TACTICAL_ENEMY_PROFILES.tough.label,
        killed: false,
      }),
    });
    expect(game.currentZombieState.count).toBe(beforeNodeCount);
    expect(game.activeTacticalEncounter.enemies).toHaveLength(beforeNodeCount);
    expect(game.activeTacticalEncounter.enemies.find((enemy) => enemy.id === target.id).hp).toBeLessThan(beforeTargetHp);
    expect(game.history.at(-1).result).toContain(TACTICAL_ENEMY_PROFILES.tough.label);
    expect(game.history.at(-1).result).toContain('剩余 HP');
    expect(game.mapLog[0].text).toContain('伤害');
  });

  it('removes exactly one enemy and one node zombie on a lethal targeted hit', () => {
    prepareRun(game, { zombies: 3 });
    const [bat] = addItem(game, 'spiked_baseball_bat');
    game.skills = Object.fromEntries(Object.keys(game.skills).map((skillId) => [skillId, 10]));
    game.skillXp = createSkillExperience(game.skills, skillDefinitions.map((skill) => skill.id));
    expect(game.equipWeapon(bat.stackId)).toBe(true);
    expect(game.startTacticalEncounter('combat_melee')).toBe(true);
    const target = game.activeTacticalEncounter.enemies.find((enemy) => enemy.posture === 'standing');
    target.distance = 0;
    target.hp = 1;

    const candidate = findDeterministicResolution(
      game,
      'melee',
      { weaponStackId: bat.stackId, targetId: target.id },
      (result) => result.effects.zombieKills === 1,
    );
    game.activeTacticalEncounter = candidate.state;
    const beforeNodeCount = game.currentZombieState.count;
    const beforeKills = game.survivalStats.zombiesKilled;

    const result = game.performTacticalAction('melee', commandFor(game, 'melee', {
      weaponStackId: bat.stackId,
      targetId: target.id,
    }));

    expect(result).toMatchObject({ ok: true, effects: { zombieKills: 1 }, killed: true, hpAfter: 0 });
    expect(game.currentZombieState.count).toBe(beforeNodeCount - 1);
    expect(game.activeTacticalEncounter.enemies).toHaveLength(beforeNodeCount - 1);
    expect(game.activeTacticalEncounter.enemies.some((enemy) => enemy.id === target.id)).toBe(false);
    expect(game.survivalStats.zombiesKilled).toBe(beforeKills + 1);
  });
});
