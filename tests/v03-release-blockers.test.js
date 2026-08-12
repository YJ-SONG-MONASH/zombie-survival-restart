import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mapNodes, marketItems } from '../src/data/zombie.js';
import { createNodeZombieState } from '../src/services/encounters.js';
import { useGameStore } from '../src/stores/game.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const catalogItem = (id, count = 1) => ({
  ...marketItems.find((item) => item.id === id),
  count,
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}

function setActiveEncounter(game, nodeId = 'muldraugh', count = 8) {
  if (!game.currentNodeId) game.initializeMapState();
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
    count,
    clearedDay: null,
    lastRefreshDay: game.day,
    evasionUntilMinutes: 0,
  };
  return game.nodeZombieStates[node.id];
}

function prepareEvacuation(game, { count, graceMinutes = 0 }) {
  game.initializeMapState();
  game.day = game.maxDay;
  game.clockMinutes = 10 * 60;
  game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
  game.fishing.lastProcessedMinute = game.totalWorldMinutes;
  const state = setActiveEncounter(game, 'valley_checkpoint', count);
  state.evasionUntilMinutes = graceMinutes > 0 ? game.totalWorldMinutes + graceMinutes : 0;
  if (count === 0) state.clearedDay = game.day;
  return state;
}

describe('v0.3 active encounter command gate', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    setActiveEncounter(game);
    game.baseSecurity.openings[0].integrity = 0;
    expect(game.currentEncounter).toEqual(expect.objectContaining({ active: true, population: 8 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      command: 'move',
      arrange: () => {},
      invoke: (store) => store.moveToNode(store.currentNeighborNodes[0].id),
    },
    {
      command: 'useItem',
      arrange: (store) => {
        store.inventory = [catalogItem('water_bottle')];
        store.vitals.thirst = 70;
      },
      invoke: (store) => store.useItem('water_bottle'),
    },
    {
      command: 'craftRecipe',
      arrange: (store) => {
        store.inventory = [catalogItem('plank'), catalogItem('kitchen_knife')];
        store.skills.carpentry = 1;
      },
      invoke: (store) => store.craftRecipe('crafted_spear'),
    },
    {
      command: 'toggleGenerator',
      arrange: (store) => {
        store.inventory = [catalogItem('generator'), catalogItem('how_to_use_generators')];
        store.base.generatorFuel = 2;
        store.base.generatorOn = false;
      },
      invoke: (store) => store.toggleGenerator(),
    },
    {
      command: 'drinkBaseWater',
      arrange: (store) => {
        store.base.waterReserve = 2;
        store.vitals.thirst = 70;
      },
      invoke: (store) => store.drinkBaseWater(),
    },
    {
      command: 'submitAction',
      arrange: () => {},
      invoke: (store) => store.submitAction('等待到天亮'),
    },
    {
      command: 'sleep',
      arrange: () => {},
      invoke: (store) => store.resolveNodeAction('sleep'),
    },
  ])('blocks $command atomically while the current encounter is active', ({ arrange, invoke }) => {
    arrange(game);
    const before = clone(game.$state);

    const result = invoke(game);

    expect.soft(result).toBe(false);
    expect(game.$state).toEqual(before);
  });
});

describe('v0.3 evasion grace', () => {
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    game = useGameStore();
    game.initializeMapState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('allows movement during the grace window after a successful evade', () => {
    const sourceId = 'dixie_highway_north';
    const sourceState = setActiveEncounter(game, sourceId, 10);
    game.skills.sneaking = 10;
    game.skills.lightfooted = 10;
    game.skills.fitness = 10;
    game.vitals.fatigue = 0;
    game.world.weatherId = 'clear';
    game.world.threat = 0;
    expect(game.resolveNodeAction('evade')).toBe(true);
    expect(game.activeTacticalEncounter).toEqual(expect.objectContaining({ status: 'active' }));
    game.activeTacticalEncounter.escapeProgress = 100;
    expect(game.performTacticalAction('disengage', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(sourceState.count).toBe(10);
    expect(game.nodeZombieStates[sourceId].evasionUntilMinutes).toBeGreaterThan(game.totalWorldMinutes);
    expect(game.isCurrentNodeSecured).toBe(true);

    const destinationId = game.currentNeighborNodes[0].id;
    expect(game.moveToNode(destinationId)).toBe(true);
    expect(game.currentNodeId).toBe(destinationId);
  });

  it('does not grant any grace window after a failed evade', () => {
    const nodeId = 'raven_creek';
    const state = setActiveEncounter(game, nodeId, 10);
    game.skills.sneaking = 0;
    game.skills.lightfooted = 0;
    game.skills.fitness = 0;
    game.vitals.fatigue = 100;
    game.world.weatherId = 'clear';
    game.world.threat = 100;
    expect(game.resolveNodeAction('evade')).toBe(true);
    game.activeTacticalEncounter.rng = { seed: 3, cursor: 0 };
    expect(game.performTacticalAction('disengage', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
    })).toEqual(expect.objectContaining({ ok: true }));

    expect(game.nodeZombieStates[nodeId].evasionUntilMinutes).toBe(state.evasionUntilMinutes);
    expect(game.isCurrentNodeSecured).toBe(false);
    expect(game.currentEncounter).toEqual(expect.objectContaining({ active: true, population: 10 }));
  });
});

describe('v0.3 evacuation security gate', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not award victory at an evacuation node with an active horde', () => {
    const game = useGameStore();
    prepareEvacuation(game, { count: 12 });

    expect.soft(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(false);
    expect(game.currentEncounter).toEqual(expect.objectContaining({ active: true, population: 12 }));
  });

  it('awards victory after the evacuation node is cleared', () => {
    const game = useGameStore();
    prepareEvacuation(game, { count: 0 });

    expect(game.isCurrentNodeSecured).toBe(true);
    expect(game.isVictory).toBe(true);
  });

  it('awards victory while a populated evacuation node has valid evasion grace', () => {
    const game = useGameStore();
    prepareEvacuation(game, { count: 12, graceMinutes: 30 });

    expect(game.currentZombieState.count).toBe(12);
    expect(game.isCurrentNodeSecured).toBe(true);
    expect(game.isVictory).toBe(true);
  });
});

describe('v0.3 compatibility and midnight ordering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('grants a compatibility safety window to a v2 save away from its spawn node', () => {
    setActivePinia(createPinia());
    const localStorage = memoryStorage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 2,
        day: 6,
        clockMinutes: 10 * 60,
        spawnLocation: { id: 'riverside' },
        currentNodeId: 'west_point',
        inspectedNodeId: 'west_point',
      },
    }));
    const game = useGameStore();

    game.loadPersistedState();

    expect(game.nodeZombieStates.riverside.count).toBe(0);
    expect(game.currentZombieState.count).toBeGreaterThan(0);
    expect(game.currentZombieState.evasionUntilMinutes).toBeGreaterThan(game.totalWorldMinutes);
    expect(game.isCurrentNodeSecured).toBe(true);
  });

  it('records a midnight clear at action end and does not immediately repopulate it', () => {
    setActivePinia(createPinia());
    vi.stubGlobal('localStorage', memoryStorage());
    const game = useGameStore();
    game.initializeMapState();
    game.clockMinutes = 23 * 60 + 59;
    game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
    game.fishing.lastProcessedMinute = game.totalWorldMinutes;
    const state = setActiveEncounter(game, 'muldraugh', 1);
    game.inventory = [catalogItem('baseball_bat')];
    game.equippedWeaponId = 'baseball_bat';
    game.skills.long_blunt = 10;
    game.skills.strength = 10;
    game.skills.fitness = 10;
    game.vitals.fatigue = 0;
    game.vitals.panic = 0;
    game.world.weatherId = 'clear';
    game.world.threat = 0;
    const actionStartMinutes = game.totalWorldMinutes;

    expect(game.resolveNodeAction('combat_melee')).toBe(true);
    game.activeTacticalEncounter.enemies[0].posture = 'downed';
    game.activeTacticalEncounter.enemies[0].distance = 0;
    game.activeTacticalEncounter.enemies[0].hp = 1;
    game.activeTacticalEncounter.zombies = { distant: 0, approaching: 0, engaged: 0, downed: 1 };
    game.activeTacticalEncounter.rangeBand = 'contact';
    expect(game.performTacticalAction('stomp', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
      targetId: game.activeTacticalEncounter.enemies[0].id,
    })).toEqual(expect.objectContaining({ ok: true }));

    expect(game.day).toBe(2);
    expect(game.clockMinutes).toBe(0);
    expect(game.totalWorldMinutes).toBe(actionStartMinutes + 1);
    expect(game.nodeZombieStates.muldraugh).toEqual(expect.objectContaining({
      count: 0,
      clearedDay: 2,
      lastRefreshDay: 2,
      lastCombatMinutes: game.totalWorldMinutes,
    }));
    expect(game.currentEncounter).toBeNull();
    expect(state.count).toBe(1);
  });
});
