import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  mapNodes,
  marketItems,
  shelters,
  skillDefinitions,
  vitalDefinitions,
} from '../src/data/zombie.js';
import { createNodeZombieState } from '../src/services/encounters.js';
import { applyWeaponWear } from '../src/services/item-condition.js';
import {
  createSkillExperience,
  grantSkillExperience as applySkillExperience,
} from '../src/services/progression.js';
import { resolveTacticalAction } from '../src/services/tactical-encounter.js';
import { storageUsedSpace } from '../src/services/storage.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';

const TACTICAL_ACTION_IDS = new Set([
  'push',
  'melee',
  'stomp',
  'step_back',
  'aim',
  'reload',
  'fire',
  'disengage',
  'brace',
]);
const TERMINAL_TACTICAL_STATUSES = new Set(['cleared', 'escaped', 'dead']);

const clone = (value) => JSON.parse(JSON.stringify(value));
const catalogItem = (id) => marketItems.find((entry) => entry.id === id);

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
  if (!node) throw new Error(`Unknown test node: ${nodeId}`);
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
  return game.nodeZombieStates[node.id];
}

function addItem(game, itemId, count = 1) {
  expect(game.addItem(catalogItem(itemId), count, true)).toBe(true);
  return game.inventory.filter((entry) => entry.id === itemId);
}

function synchronizeSkillXp(game) {
  game.skillXp = createSkillExperience(game.skills, skillDefinitions.map((skill) => skill.id));
}

function splitAmmo(game, itemId, stacks) {
  const total = stacks.reduce((sum, entry) => sum + entry.count, 0);
  addItem(game, itemId, total);
  const original = game.inventory.find((entry) => entry.id === itemId);
  const replacements = stacks.map(({ stackId, count }, index) => {
    const entry = clone(original);
    entry.stackId = stackId;
    entry.count = count;
    entry.conditionState = {
      ...entry.conditionState,
      instanceId: stackId,
      stackId,
      // A distinct normalized batch state prevents the storage normalizer
      // from correctly coalescing these stacks before exact-source removal.
      freshness: {
        perishable: false,
        ageMinutes: index,
        spoilageMinutes: index,
        freshForMinutes: null,
        rottenAfterMinutes: null,
        state: 'fresh',
      },
    };
    return entry;
  });
  game.inventory = [
    ...game.inventory.filter((entry) => entry !== original),
    ...replacements,
  ];
  return replacements;
}

function startEncounter(game, preferredActionId = 'combat_melee') {
  const result = game.startTacticalEncounter(preferredActionId);
  expect(game.activeTacticalEncounter).toEqual(expect.objectContaining({
    id: expect.any(String),
    nodeId: game.currentNodeId,
    status: 'active',
    turn: expect.any(Number),
    rng: expect.objectContaining({
      seed: expect.any(Number),
      cursor: expect.any(Number),
    }),
  }));
  return result;
}

function tacticalCommand(game, actionId, options = {}) {
  const encounter = game.activeTacticalEncounter;
  const targetId = options.targetId ?? tacticalTargetId(game, actionId);
  return game.performTacticalAction(actionId, {
    encounterId: encounter.id,
    expectedTurn: encounter.turn,
    ...(targetId ? { targetId } : {}),
    ...options,
  });
}

function expectRejected(result, reason) {
  if (result && typeof result === 'object') {
    expect(result.ok).toBe(false);
    if (reason) expect(result.reason).toBe(reason);
  } else {
    expect(result).toBe(false);
  }
}

function tacticalServiceContext(game) {
  return {
    node: mapNodes.find((entry) => entry.id === game.currentNodeId) ?? null,
    inventory: clone(game.inventory),
    skills: clone(game.skills),
    vitals: clone(game.vitals),
    body: clone(game.body),
    world: clone(game.world),
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

function expectedTacticalResolution(game, actionId, options = {}) {
  const encounter = clone(game.activeTacticalEncounter);
  const targetId = options.targetId ?? tacticalTargetId(game, actionId);
  const command = {
    actionId,
    encounterId: encounter.id,
    expectedTurn: encounter.turn,
    weaponStackId: options.weaponStackId
      ?? game.equippedWeaponStackId
      ?? encounter.selectedWeaponStackId
      ?? null,
    ...(targetId ? { targetId } : {}),
    ...options,
  };
  const resolution = resolveTacticalAction(encounter, command, tacticalServiceContext(game));
  expect(resolution).toEqual(expect.objectContaining({
    ok: true,
    nextState: expect.any(Object),
    effects: expect.objectContaining({
      durationMinutes: expect.any(Number),
      zombieKills: expect.any(Number),
      ammoConsumption: expect.any(Array),
      weaponUses: expect.any(Array),
      vitalsDelta: expect.any(Object),
      newWounds: expect.any(Array),
      noiseDelta: expect.any(Number),
      threatDelta: expect.any(Number),
      skillXp: expect.any(Object),
      evasionMinutes: expect.any(Number),
      firearmLoads: expect.any(Object),
    }),
    events: expect.any(Array),
  }));
  expect(resolution.effects.durationMinutes).toBeGreaterThan(0);
  return { command, resolution };
}

function performWithOracle(game, actionId, options = {}) {
  const expected = expectedTacticalResolution(game, actionId, options);
  expect(game.performTacticalAction(actionId, expected.command)).toEqual(expect.objectContaining({ ok: true }));
  return expected.resolution;
}

function tacticalTargetId(game, actionId) {
  if (!['push', 'melee', 'stomp', 'fire'].includes(actionId)) return null;
  const enemies = Array.isArray(game.activeTacticalEncounter?.enemies)
    ? game.activeTacticalEncounter.enemies
    : [];
  return [...enemies]
    .filter((enemy) => {
      if (!(Number(enemy?.hp) > 0)) return false;
      if (actionId === 'push') return enemy.posture === 'standing' && enemy.distance === 0;
      if (actionId === 'stomp') return enemy.posture === 'downed' && enemy.distance === 0;
      return true;
    })
    .sort((left, right) => (
      Number(left.distance) - Number(right.distance)
      || String(left.id).localeCompare(String(right.id))
    ))[0]?.id ?? null;
}

function bucketSize(bucket) {
  if (Array.isArray(bucket)) return bucket.length;
  if (Number.isFinite(bucket)) return bucket;
  if (bucket && typeof bucket === 'object') return Object.keys(bucket).length;
  return 0;
}

function zombieTotal(encounter) {
  return Object.values(encounter?.zombies ?? {})
    .reduce((total, bucket) => total + bucketSize(bucket), 0);
}

function bucketEntries(bucket) {
  if (Array.isArray(bucket)) return bucket;
  if (bucket && typeof bucket === 'object') return Object.values(bucket);
  return [];
}

function forceZombieBucket(encounter, targetBucket) {
  if (Array.isArray(encounter?.enemies)) {
    encounter.enemies.forEach((enemy) => {
      enemy.posture = targetBucket === 'downed' ? 'downed' : 'standing';
      enemy.distance = targetBucket === 'distant' ? 3 : targetBucket === 'approaching' ? 1 : 0;
    });
    encounter.zombies = {
      distant: targetBucket === 'distant' ? encounter.enemies.length : 0,
      approaching: targetBucket === 'approaching' ? encounter.enemies.length : 0,
      engaged: targetBucket === 'engaged' ? encounter.enemies.length : 0,
      downed: targetBucket === 'downed' ? encounter.enemies.length : 0,
    };
    encounter.rangeBand = targetBucket === 'distant' ? 'far' : targetBucket === 'approaching' ? 'near' : 'contact';
    return;
  }
  const buckets = encounter.zombies;
  const names = ['distant', 'approaching', 'engaged', 'downed'];
  const arrays = names.every((name) => Array.isArray(buckets[name]));
  if (arrays) {
    const all = names.flatMap((name) => bucketEntries(buckets[name]));
    names.forEach((name) => {
      buckets[name] = name === targetBucket ? all : [];
    });
  } else {
    const total = names.reduce((sum, name) => sum + bucketSize(buckets[name]), 0);
    names.forEach((name) => {
      buckets[name] = name === targetBucket ? total : 0;
    });
  }
  const remaining = names.reduce((sum, name) => sum + bucketSize(buckets[name]), 0);
  if ('remainingZombies' in encounter) encounter.remainingZombies = remaining;
  if ('standingZombies' in encounter) encounter.standingZombies = targetBucket === 'downed' ? 0 : remaining;
}

function clampVital(key, value) {
  const max = vitalDefinitions.find((entry) => entry.id === key)?.max ?? 100;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function projectSurvivalEffects(beforeState, effects) {
  const shadow = useGameStore(createPinia());
  shadow.$patch(clone(beforeState));
  Object.entries(effects.vitalsDelta).forEach(([key, delta]) => {
    if (key in shadow.vitals && Number.isFinite(delta)) {
      shadow.vitals[key] = clampVital(key, shadow.vitals[key] + delta);
    }
  });
  effects.newWounds.filter(Boolean).forEach((wound) => {
    if (!shadow.body.wounds.some((entry) => entry.id === wound.id)) shadow.body.wounds.push(clone(wound));
  });
  shadow.advanceSimulation({
    minutes: effects.durationMinutes,
    mode: 'active',
    noiseDelta: effects.noiseDelta,
    threatDelta: effects.threatDelta,
  });
  return {
    day: shadow.day,
    clockMinutes: shadow.clockMinutes,
    vitals: clone(shadow.vitals),
    body: clone(shadow.body),
    world: clone(shadow.world),
    base: clone(shadow.base),
  };
}

function expectExactXp(game, beforeSkills, beforeXp, gains) {
  const expected = applySkillExperience({
    skills: beforeSkills,
    skillXp: beforeXp,
    gains,
    skillIds: skillDefinitions.map((skill) => skill.id),
  });
  expect(game.skills).toEqual(expected.skills);
  expect(game.skillXp).toEqual(expected.skillXp);
  expect(game.lastSkillGains).toEqual(expected.appliedGains);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('v0.5 tactical save migration and projections', () => {
  it('migrates a v4 save with missing tactical fields to empty v5 defaults', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 4,
        day: 4,
        clockMinutes: 11 * 60,
        spawnLocation: { id: 'muldraugh' },
        currentNodeId: 'muldraugh',
        inspectedNodeId: 'muldraugh',
      },
    }));

    const game = useGameStore();
    game.loadPersistedState();

    expect(SAVE_VERSION).toBe(9);
    expect(game.saveVersion).toBe(9);
    expect(game.activeTacticalEncounter).toBeNull();
    expect(game.nextEncounterSequence).toBe(1);
    expect(game.firearmLoads).toEqual({});
  });

  it('discards malformed tactical state and orphaned or impossible firearm loads on load', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 4,
        day: 3,
        spawnLocation: { id: 'muldraugh' },
        currentNodeId: 'muldraugh',
        activeTacticalEncounter: {
          encounterId: '',
          nodeId: 'not-a-map-node',
          status: 'fighting-ish',
          turn: -9,
          rng: { seed: -1, cursor: -20 },
          zombies: { distant: -3, approaching: null, engaged: 99_999, downed: 'many' },
        },
        nextEncounterSequence: -100,
        firearmLoads: {
          '../../ghost-gun': {
            ammoItemId: '9mm_rounds',
            ammoStackId: '../../ghost-ammo',
            rounds: 99_999,
          },
        },
      },
    }));

    const game = useGameStore();
    game.loadPersistedState();

    expect(game.activeTacticalEncounter).toBeNull();
    expect(game.nextEncounterSequence).toBe(1);
    expect(game.firearmLoads).toEqual({});
    expect(JSON.stringify(game.$state)).not.toContain('not-a-map-node');
    expect(JSON.stringify(game.$state)).not.toContain('../../ghost');
  });

  it('starts once without spending time and exposes stable tactical projections', () => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    const game = useGameStore();
    prepareRun(game, { zombies: 7 });
    const [bat] = addItem(game, 'spiked_baseball_bat');
    const [pistol] = addItem(game, 'm9_pistol');
    addItem(game, '9mm_rounds', 5);
    expect(game.equipWeapon(bat.stackId)).toBe(true);
    const before = {
      day: game.day,
      clockMinutes: game.clockMinutes,
      vitals: clone(game.vitals),
      body: clone(game.body),
      inventory: clone(game.inventory),
      zombies: clone(game.currentZombieState),
      actions: game.survivalStats.actions,
      sequence: game.nextEncounterSequence,
    };

    startEncounter(game, 'combat_melee');

    expect(game.day).toBe(before.day);
    expect(game.clockMinutes).toBe(before.clockMinutes);
    expect(game.vitals).toEqual(before.vitals);
    expect(game.body).toEqual(before.body);
    expect(game.inventory).toEqual(before.inventory);
    expect(game.currentZombieState).toEqual(before.zombies);
    expect(game.survivalStats.actions).toBe(before.actions);
    expect(game.nextEncounterSequence).toBe(before.sequence + 1);

    const summary = game.tacticalEncounterSummary;
    expect(summary).toEqual(expect.objectContaining({
      nodeName: expect.any(String),
      zombies: expect.objectContaining({
        distant: expect.anything(),
        approaching: expect.anything(),
        engaged: expect.anything(),
        downed: expect.anything(),
      }),
      remainingZombies: expect.any(Number),
      standingZombies: expect.any(Number),
      pressure: expect.any(Number),
      pressureBand: expect.any(String),
      threat: expect.any(Number),
      noise: expect.any(Number),
      health: expect.any(Number),
      endurance: expect.any(Number),
      panic: expect.any(Number),
      pain: expect.any(Number),
      encumbrance: expect.any(Number),
      bleeding: expect.any(Number),
    }));
    expect(summary.remainingZombies).toBe(
      ['distant', 'approaching', 'engaged', 'downed']
        .reduce((sum, name) => sum + bucketSize(summary.zombies[name]), 0),
    );
    expect(summary.encumbrance).toBeCloseTo(
      storageUsedSpace(game.inventory) / game.maxSpace * 100,
      2,
    );

    expect(game.tacticalActionList.length).toBeGreaterThan(0);
    game.tacticalActionList.forEach((action) => {
      expect(TACTICAL_ACTION_IDS.has(action.id)).toBe(true);
      expect(action).toEqual(expect.objectContaining({
        label: expect.any(String),
        minutes: expect.any(Number),
        staminaCost: expect.any(Number),
        noiseDelta: expect.any(Number),
        disabled: expect.any(Boolean),
        disabledReason: expect.any(String),
      }));
      expect(action.risk ?? action.tone).toBeTruthy();
      expect(action.estimatedOutcome ?? action.outcome).toEqual(expect.any(String));
    });
    expect(game.tacticalActionList.map((action) => action.id)).toEqual(expect.arrayContaining([
      'push', 'melee', 'step_back', 'aim', 'reload', 'fire', 'disengage', 'brace',
    ]));

    expect(game.tacticalWeaponOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stackId: bat.stackId,
        name: bat.name,
        equipped: true,
        firearm: false,
        broken: false,
        conditionLabel: expect.any(String),
        conditionTone: expect.any(String),
        loaded: 0,
        capacity: 0,
        reserve: 0,
        ammoItemId: null,
      }),
      expect.objectContaining({
        stackId: pistol.stackId,
        name: pistol.name,
        equipped: false,
        firearm: true,
        broken: false,
        conditionLabel: expect.any(String),
        conditionTone: expect.any(String),
        loaded: 0,
        capacity: 15,
        reserve: 5,
        ammoItemId: '9mm_rounds',
      }),
    ]));

    const firstEncounter = clone(game.activeTacticalEncounter);
    const sequenceAfterFirstStart = game.nextEncounterSequence;
    game.startTacticalEncounter('combat_firearm');
    expect(game.activeTacticalEncounter).toEqual(firstEncounter);
    expect(game.nextEncounterSequence).toBe(sequenceAfterFirstStart);
    expect(game.day).toBe(before.day);
    expect(game.clockMinutes).toBe(before.clockMinutes);
  });

  it('routes the public legacy firearm command into tactical start without spending loose ammo', () => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    const game = useGameStore();
    prepareRun(game, { zombies: 5 });
    const [pistol] = addItem(game, 'm9_pistol');
    const [ammo] = addItem(game, '9mm_rounds', 6);
    expect(game.equipWeapon(pistol.stackId)).toBe(true);
    const beforeMinutes = game.totalWorldMinutes;
    const beforeAmmo = ammo.count;

    expect(game.resolveNodeAction('combat_firearm')).toBe(true);

    expect(game.activeTacticalEncounter).toEqual(expect.objectContaining({
      status: 'active',
      turn: 0,
      selectedWeaponStackId: pistol.stackId,
    }));
    expect(game.totalWorldMinutes).toBe(beforeMinutes);
    expect(game.inventory.find((entry) => entry.stackId === ammo.stackId)?.count).toBe(beforeAmmo);
    expect(game.firearmLoads[pistol.stackId]).toBeUndefined();
  });
});

describe('v0.5 tactical command ownership and optimistic concurrency', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    prepareRun(game, { zombies: 8 });
  });

  it('blocks world mutations atomically while tactical state is active but still permits weapon equip', () => {
    const [water] = addItem(game, 'water_bottle');
    addItem(game, 'plank');
    addItem(game, 'kitchen_knife');
    const [firstBat, secondBat] = addItem(game, 'baseball_bat', 2);
    game.skills.carpentry = 2;
    game.vitals.thirst = 70;
    expect(game.equipWeapon(firstBat.stackId)).toBe(true);
    startEncounter(game);

    // This makes the underlying node safe enough for every command below.
    // Rejection must therefore come from tactical ownership, not the legacy
    // node-encounter gate.
    game.nodeZombieStates[game.currentNodeId].evasionUntilMinutes = game.totalWorldMinutes + 2_000;

    const attempts = [
      () => game.moveToNode(game.currentNeighborNodes[0].id),
      () => game.resolveNodeAction('search'),
      () => game.useItem(water.stackId),
      () => game.craftRecipe('crafted_spear'),
      () => game.removeItem(firstBat.stackId, 1),
      () => game.addItem(catalogItem('bandage'), 1, true),
      () => game.collectLootItem(catalogItem('bandage'), 1),
      () => game.transferItem({
        fromId: 'carry',
        toId: 'base',
        stackId: water.stackId,
        quantity: 1,
      }),
      () => game.submitAction('等待到天亮'),
    ];

    attempts.forEach((invoke) => {
      const before = clone(game.$state);
      expectRejected(invoke());
      expect(game.$state).toEqual(before);
    });

    const encounterId = game.activeTacticalEncounter.id;
    const turn = game.activeTacticalEncounter.turn;
    const beforeTime = game.totalWorldMinutes;
    expect(game.equipWeapon(secondBat.stackId)).toBe(true);
    expect(game.equippedWeaponStackId).toBe(secondBat.stackId);
    expect(game.activeTacticalEncounter.id).toBe(encounterId);
    expect(game.activeTacticalEncounter.turn).toBe(turn);
    expect(game.totalWorldMinutes).toBe(beforeTime);
  });

  it('uses encounterId and expectedTurn to make double-clicks and stale clients zero-mutation failures', () => {
    startEncounter(game);
    const encounterId = game.activeTacticalEncounter.id;
    const expectedTurn = game.activeTacticalEncounter.turn;

    for (const missingToken of [
      {},
      { encounterId },
      { expectedTurn },
    ]) {
      const before = clone(game.$state);
      expectRejected(game.performTacticalAction('brace', missingToken));
      expect(game.$state).toEqual(before);
    }

    const first = performWithOracle(game, 'brace');
    expect(first.ok).toBe(true);
    expect(game.activeTacticalEncounter.turn).toBe(expectedTurn + 1);
    const afterFirst = clone(game.$state);

    const replay = game.performTacticalAction('brace', { encounterId, expectedTurn });
    expectRejected(replay, 'stale_turn');
    expect(game.$state).toEqual(afterFirst);

    const wrongEncounter = game.performTacticalAction('brace', {
      encounterId: `${encounterId}-stale-client`,
      expectedTurn: game.activeTacticalEncounter.turn,
    });
    expectRejected(wrongEncounter);
    expect(game.$state).toEqual(afterFirst);
  });
});

describe('v0.5 tactical atomic effects and exact stack ownership', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
  });

  it('reloads the chosen ammo stack, then fires once with exact time, vitals, kills, wear, and XP', () => {
    prepareRun(game, { zombies: 12 });
    game.skills.aiming = 10;
    game.skills.reloading = 10;
    synchronizeSkillXp(game);
    game.vitals.endurance = 100;
    game.vitals.fatigue = 0;
    game.vitals.panic = 0;
    const [selectedPistol, otherPistol] = addItem(game, 'm9_pistol', 2);
    const [ammoA, ammoB] = splitAmmo(game, '9mm_rounds', [
      { stackId: 'carry:9mm:test-a', count: 3 },
      { stackId: 'carry:9mm:test-b', count: 5 },
    ]);
    expect(game.equipWeapon(selectedPistol.stackId)).toBe(true);
    startEncounter(game, 'combat_firearm');

    const reloadTurn = game.activeTacticalEncounter.turn;
    const reloadStart = game.totalWorldMinutes;
    forceZombieBucket(game.activeTacticalEncounter, 'distant');
    game.activeTacticalEncounter.rangeBand = 'far';
    const reload = performWithOracle(game, 'reload', {
      weaponStackId: selectedPistol.stackId,
      ammoStackId: ammoB.stackId,
      rounds: 2,
    });
    const reloadEffects = reload.effects;
    expect(reloadEffects.ammoConsumption).toEqual([{ stackId: ammoB.stackId, count: 2 }]);
    expect(game.totalWorldMinutes).toBe(reloadStart + reloadEffects.durationMinutes);
    expect(game.activeTacticalEncounter.turn).toBe(reloadTurn + 1);
    expect(game.inventory.find((entry) => entry.stackId === ammoA.stackId)?.count).toBe(3);
    expect(game.inventory.find((entry) => entry.stackId === ammoB.stackId)?.count).toBe(3);
    expect(game.firearmLoads[selectedPistol.stackId]).toEqual({
      ammoItemId: '9mm_rounds',
      ammoStackId: ammoB.stackId,
      rounds: 2,
    });
    expect(game.firearmLoads[otherPistol.stackId]).toBeUndefined();

    const beforeFire = clone(game.$state);
    const beforeTotalMinutes = game.totalWorldMinutes;
    const beforeNodeCount = game.currentZombieState.count;
    const beforeKills = game.survivalStats.zombiesKilled;
    const beforeActions = game.survivalStats.actions;
    const beforeSkills = clone(game.skills);
    const beforeXp = clone(game.skillXp);
    const fireEncounterId = game.activeTacticalEncounter.id;
    const fireTurn = game.activeTacticalEncounter.turn;
    const fire = performWithOracle(game, 'fire', {
      weaponStackId: selectedPistol.stackId,
      ammoStackId: ammoB.stackId,
      rounds: 1,
    });
    const fireEffects = fire.effects;

    expect(fireEffects.zombieKills).toBeGreaterThan(0);
    expect(fireEffects.ammoConsumption).toEqual([]);
    expect(game.totalWorldMinutes).toBe(beforeTotalMinutes + fireEffects.durationMinutes);
    expect(game.currentZombieState.count).toBe(beforeNodeCount - fireEffects.zombieKills);
    expect(game.survivalStats.zombiesKilled).toBe(beforeKills + fireEffects.zombieKills);
    expect(game.survivalStats.actions).toBe(beforeActions + 1);
    expect(game.firearmLoads[selectedPistol.stackId]).toEqual({
      ammoItemId: '9mm_rounds',
      ammoStackId: ammoB.stackId,
      rounds: 1,
    });
    expect(game.inventory.find((entry) => entry.stackId === ammoA.stackId)?.count).toBe(3);
    expect(game.inventory.find((entry) => entry.stackId === ammoB.stackId)?.count).toBe(3);

    const selectedUse = fireEffects.weaponUses.find((entry) => entry.stackId === selectedPistol.stackId);
    expect(selectedUse).toEqual(expect.objectContaining({
      stackId: selectedPistol.stackId,
      attacks: expect.any(Number),
      impacts: expect.any(Number),
      kills: fireEffects.zombieKills,
    }));
    const expectedCondition = applyWeaponWear(
      beforeFire.inventory.find((entry) => entry.stackId === selectedPistol.stackId).conditionState,
      { attacks: selectedUse.attacks, kills: selectedUse.kills },
    );
    expect(game.inventory.find((entry) => entry.stackId === selectedPistol.stackId).conditionState).toEqual(expectedCondition);
    expect(game.inventory.find((entry) => entry.stackId === otherPistol.stackId).conditionState).toEqual(
      beforeFire.inventory.find((entry) => entry.stackId === otherPistol.stackId).conditionState,
    );
    expectExactXp(game, beforeSkills, beforeXp, fireEffects.skillXp);
    expect(fireEffects.skillXp.aiming).toBeGreaterThan(0);

    const expectedSurvival = projectSurvivalEffects(beforeFire, fireEffects);
    expect({
      day: game.day,
      clockMinutes: game.clockMinutes,
      vitals: game.vitals,
      body: game.body,
      world: game.world,
      base: game.base,
    }).toEqual(expectedSurvival);

    expect(fire.events).toContainEqual(expect.objectContaining({
      type: 'player_action',
      turn: fireTurn + 1,
      actionId: 'fire',
      weaponStackId: selectedPistol.stackId,
      weaponName: selectedPistol.name,
    }));

    const afterFire = clone(game.$state);
    const replay = game.performTacticalAction('fire', {
      encounterId: fireEncounterId,
      expectedTurn: fireTurn,
      weaponStackId: selectedPistol.stackId,
      ammoStackId: ammoB.stackId,
      rounds: 1,
    });
    expectRejected(replay, 'stale_turn');
    expect(game.$state).toEqual(afterFire);
  });

  it('attributes a spiked-bat action log, wear, and long-blunt XP to the same selected stack', () => {
    prepareRun(game, { zombies: 9 });
    game.skills.long_blunt = 5;
    game.skills.maintenance = 4;
    game.skills.strength = 10;
    game.skills.fitness = 10;
    synchronizeSkillXp(game);
    const [otherBat, selectedBat] = addItem(game, 'spiked_baseball_bat', 2);
    expect(game.equipWeapon(selectedBat.stackId)).toBe(true);
    startEncounter(game, 'combat_melee');
    const beforeInventory = clone(game.inventory);
    const beforeSkills = clone(game.skills);
    const beforeXp = clone(game.skillXp);

    const result = performWithOracle(game, 'melee', { weaponStackId: selectedBat.stackId });
    const effects = result.effects;
    const selectedUse = effects.weaponUses.find((entry) => entry.stackId === selectedBat.stackId);
    expect(selectedUse).toEqual(expect.objectContaining({
      stackId: selectedBat.stackId,
      attacks: expect.any(Number),
      impacts: expect.any(Number),
      kills: effects.zombieKills,
    }));
    expect(effects.weaponUses.some((entry) => entry.stackId === otherBat.stackId)).toBe(false);

    const expectedCondition = applyWeaponWear(
      beforeInventory.find((entry) => entry.stackId === selectedBat.stackId).conditionState,
      { attacks: selectedUse.attacks, kills: selectedUse.kills },
    );
    expect(game.inventory.find((entry) => entry.stackId === selectedBat.stackId).conditionState).toEqual(expectedCondition);
    expect(game.inventory.find((entry) => entry.stackId === otherBat.stackId).conditionState).toEqual(
      beforeInventory.find((entry) => entry.stackId === otherBat.stackId).conditionState,
    );
    expectExactXp(game, beforeSkills, beforeXp, effects.skillXp);
    expect(effects.skillXp.long_blunt).toBeGreaterThan(0);

    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'player_action',
      actionId: 'melee',
      weaponStackId: selectedBat.stackId,
      weaponName: selectedBat.name,
    }));
    expect(JSON.stringify(game.activeTacticalEncounter)).toContain(selectedBat.stackId);
    expect(JSON.stringify(game.activeTacticalEncounter)).toContain('钉刺棒球棍');
  });
});

describe('v0.5 tactical persistence, terminal ordering, and dismissal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('resumes with the same encounter RNG cursor and produces the same next random outcome', () => {
    const game = useGameStore();
    prepareRun(game, { zombies: 10 });
    game.skills.long_blunt = 7;
    game.skills.strength = 9;
    game.skills.fitness = 9;
    synchronizeSkillXp(game);
    const [bat] = addItem(game, 'spiked_baseball_bat');
    expect(game.equipWeapon(bat.stackId)).toBe(true);
    startEncounter(game);
    const snapshot = clone(game.$state);

    const restoredStorage = memoryStorage();
    restoredStorage.values.set('moshi-survival-state', JSON.stringify({ game: snapshot }));
    const restoredPinia = createPinia();
    const restored = useGameStore(restoredPinia);
    vi.stubGlobal('localStorage', restoredStorage);
    restored.loadPersistedState();

    expect(restored.activeTacticalEncounter).toEqual(snapshot.activeTacticalEncounter);
    expect(restored.activeTacticalEncounter.rng).toEqual(snapshot.activeTacticalEncounter.rng);
    expect(restored.firearmLoads).toEqual(snapshot.firearmLoads);
    // Loading also canonicalizes unrelated setup/catalog fields. Put the live
    // comparison store on that same canonical snapshot so this assertion
    // isolates tactical continuation rather than legacy setup normalization.
    game.$patch(clone(restored.$state));
    expect(game.$state).toEqual(restored.$state);
    const command = {
      encounterId: restored.activeTacticalEncounter.id,
      expectedTurn: restored.activeTacticalEncounter.turn,
      weaponStackId: bat.stackId,
      targetId: tacticalTargetId(restored, 'melee'),
    };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.001);
    const originalResult = game.performTacticalAction('melee', command);
    random.mockReturnValue(0.999);
    const restoredResult = restored.performTacticalAction('melee', command);

    expect(originalResult).toEqual(expect.objectContaining({ ok: true }));
    expect(restoredResult).toEqual(expect.objectContaining({ ok: true }));
    expect(restored.$state).toEqual(game.$state);
  });

  it('records a midnight clear at the action end, rejects terminal actions, then permits dismissal', () => {
    const game = useGameStore();
    prepareRun(game, { zombies: 1 });
    game.clockMinutes = 23 * 60 + 59;
    game.skills.strength = 10;
    game.skills.fitness = 10;
    synchronizeSkillXp(game);
    startEncounter(game);
    forceZombieBucket(game.activeTacticalEncounter, 'downed');
    game.activeTacticalEncounter.enemies[0].hp = 1;
    const beforeDismiss = clone(game.$state);

    expectRejected(game.dismissTacticalEncounter());
    expect(game.$state).toEqual(beforeDismiss);

    const actionStart = game.totalWorldMinutes;
    const result = performWithOracle(game, 'stomp');
    const effects = result.effects;
    expect(effects.zombieKills).toBe(1);
    expect(game.totalWorldMinutes).toBe(actionStart + effects.durationMinutes);
    expect(game.day).toBe(2);
    expect(game.currentZombieState).toEqual(expect.objectContaining({
      count: 0,
      clearedDay: 2,
      lastRefreshDay: 2,
      lastCombatMinutes: game.totalWorldMinutes,
    }));
    expect(game.activeTacticalEncounter.status).toBe('cleared');

    const terminalState = clone(game.$state);
    const terminalReplay = tacticalCommand(game, 'brace');
    expectRejected(terminalReplay, 'encounter_terminal');
    expect(game.$state).toEqual(terminalState);

    expect(game.dismissTacticalEncounter()).toBe(true);
    expect(game.activeTacticalEncounter).toBeNull();
    expect(game.currentZombieState.count).toBe(0);
  });

  it('keeps a nonterminal encounter and its node population synchronized across midnight', () => {
    const game = useGameStore();
    prepareRun(game, { zombies: 6 });
    game.clockMinutes = 23 * 60 + 59;
    startEncounter(game, 'evade');
    const startingPopulation = game.currentZombieState.count;

    const first = performWithOracle(game, 'brace');
    expect(first.effects.zombieKills).toBe(0);
    expect(game.day).toBe(2);
    expect(game.currentZombieState.count).toBe(startingPopulation);
    expect(game.currentZombieState.lastRefreshDay).toBe(2);
    expect(zombieTotal(game.activeTacticalEncounter)).toBe(startingPopulation);
    expect(game.activeTacticalEncounter.status).toBe('active');

    const nextTurn = game.activeTacticalEncounter.turn;
    expect(performWithOracle(game, 'brace').ok).toBe(true);
    expect(game.activeTacticalEncounter.turn).toBe(nextTurn + 1);
    expect(zombieTotal(game.activeTacticalEncounter)).toBe(game.currentZombieState.count);
  });

  it('marks a deadline overrun as aborted rather than falsely reporting combat death', () => {
    const game = useGameStore();
    prepareRun(game, { zombies: 4 });
    game.day = game.evacuationDeadline;
    game.clockMinutes = 23 * 60 + 59;
    game.currentZombieState.lastRefreshDay = game.day;
    startEncounter(game, 'evade');

    expect(performWithOracle(game, 'brace').ok).toBe(true);

    expect(game.day).toBe(game.evacuationDeadline + 1);
    expect(game.vitals.health).toBeGreaterThan(0);
    expect(game.body.infectionLevel).toBeLessThan(100);
    expect(game.activeTacticalEncounter.status).toBe('aborted');
    expect(game.ending).toEqual(expect.objectContaining({ title: expect.any(String) }));
  });

  it('lets disengage grant only a safety window and never converts escape into zombie kills', () => {
    const game = useGameStore();
    prepareRun(game, { zombies: 6 });
    game.skills.sneaking = 10;
    game.skills.lightfooted = 10;
    game.skills.nimble = 10;
    game.skills.fitness = 10;
    synchronizeSkillXp(game);
    game.vitals.endurance = 100;
    game.vitals.fatigue = 0;
    game.vitals.panic = 0;
    startEncounter(game, 'evade');
    forceZombieBucket(game.activeTacticalEncounter, 'distant');
    game.activeTacticalEncounter.rangeBand = 'far';
    game.activeTacticalEncounter.escapeProgress = 100;
    const beforeCount = game.currentZombieState.count;
    const beforeKills = game.survivalStats.zombiesKilled;

    const result = performWithOracle(game, 'disengage');
    const effects = result.effects;
    expect(effects.evasionMinutes).toBeGreaterThan(0);
    expect(effects.zombieKills).toBe(0);
    expect(game.currentZombieState.count).toBe(beforeCount);
    expect(game.survivalStats.zombiesKilled).toBe(beforeKills);
    expect(game.currentZombieState.evasionUntilMinutes).toBe(game.totalWorldMinutes + effects.evasionMinutes);
    expect(game.activeTacticalEncounter.status).toBe('escaped');
    expect(game.dismissTacticalEncounter()).toBe(true);
    expect(game.activeTacticalEncounter).toBeNull();
    expect(game.currentZombieState.count).toBe(beforeCount);
  });

  it('refuses encounter start or tactical actions after death without mutating state', () => {
    const deadBeforeStart = useGameStore();
    prepareRun(deadBeforeStart, { zombies: 4 });
    deadBeforeStart.vitals.health = 0;
    const deadState = clone(deadBeforeStart.$state);
    expectRejected(deadBeforeStart.startTacticalEncounter('combat_melee'));
    expect(deadBeforeStart.$state).toEqual(deadState);

    const livePinia = createPinia();
    const live = useGameStore(livePinia);
    prepareRun(live, { zombies: 4 });
    startEncounter(live);
    live.vitals.health = 0;
    const beforeAction = clone(live.$state);
    const result = tacticalCommand(live, 'brace');
    expectRejected(result);
    expect(live.$state).toEqual(beforeAction);
    expect(live.activeTacticalEncounter.status).toBe('active');
    expect(TERMINAL_TACTICAL_STATUSES.has(live.activeTacticalEncounter.status)).toBe(false);
  });
});
