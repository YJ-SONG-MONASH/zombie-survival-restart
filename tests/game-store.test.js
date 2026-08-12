import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mapNodes, marketItems, scenarios, shelters } from '../src/data/zombie.js';
import { SAVE_VERSION, useGameStore } from '../src/stores/game.js';
import { cumulativeXpForLevel } from '../src/services/progression.js';
import { createWorldState } from '../src/services/survival.js';

const storage = () => {
  const values = new Map();
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    values,
  };
};

const catalogItem = (id) => marketItems.find((entry) => entry.id === id);
const secureNode = (game, nodeId) => {
  const state = game.ensureNodeZombieState(nodeId);
  state.count = 0;
  state.clearedDay = game.day;
  state.lastRefreshDay = game.day;
  return state;
};
const syncPressureClock = (game) => {
  game.localPressure.lastProcessedMinute = game.totalWorldMinutes;
};

describe('game store invariants', () => {
  let localStorage;
  let game;

  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    game = useGameStore();
  });

  it('rejects zero, negative, fractional, and excessive inventory mutations atomically', () => {
    const water = catalogItem('water_bottle');
    const startingMoney = game.money;

    expect(game.addItem(water, -2)).toBe(false);
    expect(game.addItem(water, 0)).toBe(false);
    expect(game.addItem(water, 1.5)).toBe(false);
    expect(game.inventory).toEqual([]);
    expect(game.money).toBe(startingMoney);

    expect(game.addItem(water, 2)).toBe(true);
    expect(game.inventory).toEqual([expect.objectContaining({ id: 'water_bottle', count: 2 })]);
    expect(game.money).toBe(startingMoney - water.price * 2);

    expect(game.removeItem('water_bottle', -1)).toBe(false);
    expect(game.removeItem('water_bottle', 3)).toBe(false);
    expect(game.inventory[0].count).toBe(2);
    expect(game.removeItem('water_bottle', 2)).toBe(true);
    expect(game.inventory).toEqual([]);
  });

  it('rejects actions and item use after a terminal state', () => {
    game.vitals.health = 0;
    const before = {
      day: game.day,
      clockMinutes: game.clockMinutes,
      history: [...game.history],
      inventory: [...game.inventory],
    };

    expect(game.submitAction('等待')).toBe(false);
    expect(game.resolveNodeAction('rest')).toBe(false);
    expect(game.moveToNode('west_point')).toBe(false);
    expect(game.useItem('bandage')).toBe(false);
    expect(game.equipWeapon('baseball_bat')).toBe(false);
    expect(game.day).toBe(before.day);
    expect(game.clockMinutes).toBe(before.clockMinutes);
    expect(game.history).toEqual(before.history);
    expect(game.inventory).toEqual(before.inventory);
  });

  it('advances ordinary choices by clock time instead of consuming a whole calendar day', () => {
    expect(game.day).toBe(1);
    expect(game.clockMinutes).toBe(8 * 60);

    expect(game.submitAction('谨慎检查周围')).toBe(true);

    expect(game.day).toBe(1);
    expect(game.clockMinutes).toBe(16 * 60);
    expect(game.survivalStats.hoursSurvived).toBeCloseTo(8);
  });

  it('describes daytime sleep as sleep rather than pretending a night passed', () => {
    game.currentNodeId = game.spawnLocation.id;
    game.inspectedNodeId = game.spawnLocation.id;
    secureNode(game, game.currentNodeId);

    expect(game.resolveNodeAction('sleep')).toBe(true);

    expect(game.day).toBe(1);
    expect(game.clockMinutes).toBe(16 * 60);
    expect(game.history.at(-1)).toEqual(expect.objectContaining({
      title: '补足睡眠',
      result: expect.stringContaining('还没有浪费掉整整一天'),
    }));
  });

  it('locks character setup mutations after the survival run starts', () => {
    game.initializeMapState();
    expect(game.runPhase).toBe('running');
    const before = JSON.parse(JSON.stringify(game.$state));

    expect(game.setSurvivorName('重置角色')).toBe(false);
    expect(game.selectSpawnLocation('riverside')).toBe(false);
    expect(game.selectProfession('unemployed')).toBe(false);
    expect(game.toggleTrait('strong')).toBe(false);
    expect(game.rollShelters()).toBe(false);

    expect(game.$state).toEqual(before);
  });

  it('also treats full infection as terminal', () => {
    game.body.infectionLevel = 100;

    expect(game.isGameOver).toBe(true);
    expect(game.submitAction('继续前进')).toBe(false);
    expect(game.resolveNodeAction('scout')).toBe(false);
  });

  it('bandages, disinfects, and treats an ordinary wound while consuming supplies', () => {
    game.vitals.health = 50;
    game.body = {
      wounds: [{
        id: 'wound-test',
        bodyPart: 'left_arm',
        type: 'laceration',
        severity: 3,
        bleeding: true,
        bandaged: false,
        disinfected: false,
        infected: true,
        knoxInfection: false,
        ageHours: 8,
        source: 'test',
      }],
      infectionLevel: 30,
      pain: 21,
      wetness: 0,
    };
    ['bandage', 'disinfectant', 'antibiotics'].forEach((id) => {
      expect(game.addItem(catalogItem(id), 1, true)).toBe(true);
    });

    expect(game.useItem('bandage')).toBe(true);
    expect(game.body.wounds[0]).toMatchObject({ bandaged: true, bleeding: false });
    expect(game.inventory.some((entry) => entry.id === 'bandage')).toBe(false);

    expect(game.useItem('disinfectant')).toBe(true);
    expect(game.body.wounds[0]).toMatchObject({ disinfected: true, infected: false });
    expect(game.body.infectionLevel).toBeGreaterThanOrEqual(22);
    expect(game.body.infectionLevel).toBeLessThan(23);

    expect(game.useItem('antibiotics')).toBe(true);
    expect(game.body.infectionLevel).toBe(0);
    expect(game.inventory.some((entry) => entry.id === 'antibiotics')).toBe(false);
    expect(game.vitals.health).toBeGreaterThan(50);
  });

  it('cannot cure Knox infection with ordinary antibiotics', () => {
    game.body.wounds = [{
      id: 'bite-test',
      bodyPart: 'right_hand',
      type: 'bite',
      severity: 5,
      bleeding: false,
      bandaged: true,
      disinfected: true,
      infected: false,
      knoxInfection: true,
      ageHours: 4,
      source: 'test',
    }];
    game.body.infectionLevel = 30;
    expect(game.addItem(catalogItem('antibiotics'), 1, true)).toBe(true);

    expect(game.useItem('antibiotics')).toBe(true);
    expect(game.body.infectionLevel).toBeGreaterThan(25);
    expect(game.body.infectionLevel).toBeLessThan(27);
    expect(game.body.wounds[0].knoxInfection).toBe(true);
  });

  it('does not expose the legacy UI-supplied loot injection action', () => {
    expect(game.resolveSceneSearch).toBeUndefined();
  });

  it('rejects a loot action atomically when all found items do not fit', () => {
    game.currentNodeId = 'muldraugh';
    game.inspectedNodeId = 'muldraugh';
    game.inventory = [{ ...catalogItem('water_bottle'), count: 30 }];
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const before = {
      day: game.day,
      clockMinutes: game.clockMinutes,
      inventory: JSON.parse(JSON.stringify(game.inventory)),
      history: JSON.parse(JSON.stringify(game.history)),
      actions: game.survivalStats.actions,
      searchCount: game.nodeSearchCounts.muldraugh ?? 0,
    };

    expect(game.resolveNodeAction('search')).toBe(false);
    expect(game.day).toBe(before.day);
    expect(game.clockMinutes).toBe(before.clockMinutes);
    expect(game.inventory).toEqual(before.inventory);
    expect(game.history).toEqual(before.history);
    expect(game.survivalStats.actions).toBe(before.actions);
    expect(game.nodeSearchCounts.muldraugh ?? 0).toBe(before.searchCount);
    random.mockRestore();
  });

  it('requires reaching an evacuation node during the day 20 to 25 window', () => {
    game.day = game.maxDay;
    game.currentNodeId = 'muldraugh';
    expect(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(false);

    game.currentNodeId = 'valley_checkpoint';
    secureNode(game, 'valley_checkpoint');
    expect(game.isVictory).toBe(true);
    expect(game.isGameOver).toBe(true);

    game.currentNodeId = 'muldraugh';
    game.day = game.maxDay + 6;
    expect(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(true);

    game.currentNodeId = 'valley_checkpoint';
    expect(game.isVictory).toBe(false);
  });

  it('uses the vehicle state from the start of a trip before consuming its final fuel', () => {
    game.currentNodeId = 'muldraugh';
    game.inspectedNodeId = 'muldraugh';
    game.vehicle = { status: 'working', fuel: 1, name: '测试车辆', condition: 70 };
    secureNode(game, 'muldraugh');

    expect(game.moveToNode('dixie_highway_north')).toBe(true);
    expect(game.clockMinutes).toBe(9 * 60);
    expect(game.vehicle.fuel).toBe(0);
    expect(game.history.at(-1).notes).toContain('测试车辆节省了体力');
  });

  it('fully commits time, history, statistics, and ending when a move reaches evacuation', () => {
    game.day = game.maxDay;
    game.clockMinutes = 10 * 60;
    game.currentNodeId = 'west_point';
    game.inspectedNodeId = 'west_point';
    game.visitedNodeIds = ['west_point'];
    game.knownNodeIds = ['west_point', 'valley_checkpoint'];
    game.vitals.health = 2;
    syncPressureClock(game);
    secureNode(game, 'west_point');
    secureNode(game, 'valley_checkpoint');

    expect(game.moveToNode('valley_checkpoint')).toBe(true);
    expect(game.currentNodeId).toBe('valley_checkpoint');
    expect(game.clockMinutes).toBe(13 * 60);
    expect(game.history).toHaveLength(1);
    expect(game.survivalStats.actions).toBe(1);
    expect(game.survivalStats.distanceTravelled).toBe(1);
    expect(game.isVictory).toBe(true);
    expect(game.ending).toEqual(expect.objectContaining({ victory: true, title: expect.any(String) }));
  });

  it('does not bypass a live evacuation horde when travel reaches the checkpoint', () => {
    game.day = game.maxDay;
    game.clockMinutes = 10 * 60;
    game.currentNodeId = 'west_point';
    game.inspectedNodeId = 'west_point';
    game.visitedNodeIds = ['west_point'];
    game.knownNodeIds = ['west_point', 'valley_checkpoint'];
    syncPressureClock(game);
    secureNode(game, 'west_point');
    const checkpointState = game.ensureNodeZombieState('valley_checkpoint');
    checkpointState.count = Math.max(1, checkpointState.count);
    checkpointState.evasionUntilMinutes = 0;

    expect(game.moveToNode('valley_checkpoint')).toBe(true);

    expect(game.currentNodeId).toBe('valley_checkpoint');
    expect(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(false);
    expect(game.ending).toBeNull();
    expect(game.currentEncounter).toEqual(expect.objectContaining({ active: true }));
  });

  it('never awards evacuation victory after Knox infection becomes terminal', () => {
    game.day = game.maxDay;
    game.currentNodeId = 'valley_checkpoint';
    secureNode(game, 'valley_checkpoint');
    game.body.infectionLevel = 100;

    expect(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(true);
  });

  it('fails when travel reaches an evacuation node after the final window closes', () => {
    game.day = game.maxDay + 5;
    game.clockMinutes = 23 * 60;
    game.currentNodeId = 'west_point';
    game.inspectedNodeId = 'west_point';
    game.visitedNodeIds = ['west_point'];
    game.knownNodeIds = ['west_point', 'valley_checkpoint'];
    syncPressureClock(game);
    secureNode(game, 'west_point');

    expect(game.moveToNode('valley_checkpoint')).toBe(true);
    expect(game.day).toBe(game.maxDay + 6);
    expect(game.currentNodeId).toBe('valley_checkpoint');
    expect(game.isVictory).toBe(false);
    expect(game.isGameOver).toBe(true);
    expect(game.ending).toEqual(expect.objectContaining({ victory: false, reason: '错过最后撤离窗口' }));
  });

  it('advances time and action statistics when consuming an item', () => {
    expect(game.addItem(catalogItem('water_bottle'), 1, true)).toBe(true);
    const startingThirst = game.vitals.thirst;

    expect(game.useItem('water_bottle')).toBe(true);
    expect(game.clockMinutes).toBe(8 * 60 + 10);
    expect(game.survivalStats.actions).toBe(1);
    expect(game.survivalStats.hoursSurvived).toBeCloseTo(1 / 6);
    expect(game.vitals.thirst).toBeLessThan(startingThirst);
  });

  it('persists local zombie populations and locks unsafe node actions until the encounter is handled', () => {
    game.initializeMapState();
    expect(game.currentNodeId).toBe('muldraugh');
    expect(game.currentZombieState.count).toBe(0);
    expect(game.isCurrentNodeSecured).toBe(true);

    expect(game.moveToNode('dixie_highway_north')).toBe(true);
    expect(game.currentZombieState.count).toBeGreaterThan(0);
    expect(game.currentEncounter).toEqual(expect.objectContaining({ active: true, nodeId: 'dixie_highway_north' }));
    expect(game.currentNodeActions.find((action) => action.id === 'search')).toEqual(expect.objectContaining({
      disabled: true,
      disabledReason: expect.stringContaining('先战斗或绕行'),
    }));
  });

  it('routes the legacy melee command into tactical combat and keeps a cleared node secure', () => {
    game.initializeMapState();
    expect(game.addItem(catalogItem('baseball_bat'), 1, true)).toBe(true);
    expect(game.moveToNode('dixie_highway_north')).toBe(true);
    game.nodeZombieStates.dixie_highway_north.count = 1;
    game.skills.strength = 10;
    game.skills.fitness = 10;
    const killsBefore = game.survivalStats.zombiesKilled;

    expect(game.resolveNodeAction('combat_melee')).toBe(true);
    expect(game.nodeZombieStates.dixie_highway_north.count).toBe(1);
    expect(game.activeTacticalEncounter).toEqual(expect.objectContaining({ status: 'active', turn: 0 }));
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

    expect(game.nodeZombieStates.dixie_highway_north.count).toBe(0);
    expect(game.nodeZombieStates.dixie_highway_north.clearedDay).toBe(game.day);
    expect(game.survivalStats.zombiesKilled).toBe(killsBefore + 1);
    expect(game.currentEncounter).toBeNull();
    expect(game.currentNodeActions.find((action) => action.id === 'combat_melee')?.disabledReason).toContain('已经清空');
  });

  it('grants a temporary action window after evasion without deleting the horde', () => {
    game.initializeMapState();
    expect(game.moveToNode('dixie_highway_north')).toBe(true);
    game.nodeZombieStates.dixie_highway_north.count = 10;
    game.skills.sneaking = 10;
    expect(game.resolveNodeAction('evade')).toBe(true);
    expect(game.activeTacticalEncounter).toEqual(expect.objectContaining({ status: 'active' }));
    game.activeTacticalEncounter.escapeProgress = 100;
    expect(game.performTacticalAction('disengage', {
      encounterId: game.activeTacticalEncounter.id,
      expectedTurn: game.activeTacticalEncounter.turn,
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(game.nodeZombieStates.dixie_highway_north.count).toBe(10);
    expect(game.isCurrentNodeSecured).toBe(true);
    expect(game.currentEncounter).toBeNull();
    expect(game.currentNodeActions.find((action) => action.id === 'search')).toEqual(expect.objectContaining({
      label: '去查看地点',
      disabled: true,
      disabledReason: expect.stringContaining('具体容器'),
    }));

    game.advanceSimulation({ minutes: 181, mode: 'active' });
    expect(game.isCurrentNodeSecured).toBe(false);
    expect(game.currentEncounter).toEqual(expect.objectContaining({ population: 10 }));
  });

  it('repopulates a cleared current node after a day boundary', () => {
    game.initializeMapState();
    game.nodeZombieStates.muldraugh.count = 0;
    game.nodeZombieStates.muldraugh.clearedDay = game.day;
    game.nodeZombieStates.muldraugh.lastRefreshDay = game.day;

    game.advanceSimulation({ minutes: 17 * 60, mode: 'rest' });

    expect(game.day).toBe(2);
    expect(game.nodeZombieStates.muldraugh.count).toBeGreaterThan(0);
    expect(game.baseInteriorSafe).toBe(true);
    expect(game.currentEncounter).toBeNull();
    expect(game.storageContainers.find((entry) => entry.id === 'base')?.accessible).toBe(true);
    expect(game.currentNodeActions.find((action) => action.id === 'sleep')?.disabled).toBe(false);

    game.baseSecurity.openings[0].integrity = 0;
    expect(game.baseInteriorSafe).toBe(false);
    expect(game.currentEncounter).toEqual(expect.objectContaining({
      active: true,
      population: game.nodeZombieStates.muldraugh.count,
    }));
    expect(game.mapLog.some((entry) => entry.text?.includes('尸群迁入了这个地区'))).toBe(true);
  });

  it('awards skill experience and levels skills only after a successful action', () => {
    game.initializeMapState();
    game.skills.sneaking = 0;
    game.skillXp.sneaking = 70;

    expect(game.resolveNodeAction('scout')).toBe(true);

    expect(game.skills.sneaking).toBe(1);
    expect(game.lastSkillGains.sneaking).toBe(8);
    expect(game.skillProgressList.find((skill) => skill.id === 'sneaking')).toEqual(expect.objectContaining({
      level: 1,
      currentLevelXp: 3,
      nextLevelXp: 150,
    }));
    expect(game.history.at(-1).notes).toContain('潜行提升至 Lv.1');
  });

  it('replaces a dirty bandage and grants first-aid experience', () => {
    game.body.wounds = [{
      id: 'dirty-bandage',
      bodyPart: 'left_arm',
      type: 'laceration',
      severity: 3,
      bleeding: false,
      bandaged: true,
      dirtyBandage: true,
      bandageAgeHours: 9,
      disinfected: false,
      infected: false,
      knoxInfection: false,
      ageHours: 9,
      source: 'test',
    }];
    expect(game.addItem(catalogItem('bandage'), 1, true)).toBe(true);

    expect(game.useItem('bandage')).toBe(true);

    expect(game.body.wounds[0].dirtyBandage).toBe(false);
    expect(game.body.wounds[0].bandageAgeHours).toBeCloseTo(0.5);
    expect(game.lastSkillGains.first_aid).toBe(10);
    expect(game.inventory.some((item) => item.id === 'bandage')).toBe(false);
  });
});

describe('save migration and recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('normalizes a legacy malformed save into bounded current state', () => {
    const localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        day: -7,
        maxDay: 'not-a-number',
        clockMinutes: 'bad-clock',
        money: -50,
        scenario: { id: 'removed-scenario' },
        spawnLocation: { id: 'removed-location' },
        inventory: [
          { id: 'water_bottle', count: 2 },
          { id: 'water_bottle', count: 3 },
          { id: 'water_bottle', count: -10 },
          { id: 'removed-item', count: 99 },
        ],
        hiddenTags: null,
        history: null,
        archives: 'invalid',
        world: { weatherId: 'removed-weather', noise: 999, threat: -5 },
        body: { wounds: [{ id: '', type: 'bite' }], infectionLevel: 'bad' },
        base: { barricades: -4, generatorFuel: 999, generatorOn: true },
      },
    }));

    const game = useGameStore();
    game.loadPersistedState();

    expect(game.saveVersion).toBe(SAVE_VERSION);
    expect(game.day).toBe(1);
    expect(game.maxDay).toBe(scenarios[0].maxDay);
    expect(game.clockMinutes).toBe(8 * 60);
    expect(game.money).toBe(0);
    expect(game.scenario.id).toBe(scenarios[0].id);
    expect(game.inventory).toEqual([expect.objectContaining({ id: 'water_bottle', count: 5 })]);
    expect(game.hiddenTags).toEqual([]);
    expect(game.history).toEqual([]);
    expect(game.archives).toEqual([]);
    expect(game.world.noise).toBe(100);
    expect(game.world.threat).toBe(0);
    expect(game.body.wounds).toEqual([]);
    expect(game.body.infectionLevel).toBe(0);
    expect(game.base.barricades).toBe(0);
    expect(game.base.generatorFuel).toBe(20);
    expect(game.base.generatorOn).toBe(false);
    expect(game.base.installedGeneratorStackId).toBeNull();
    expect(Object.keys(game.nodeZombieStates)).toHaveLength(mapNodes.length);
    expect(game.skillXp).toEqual(expect.objectContaining({ fitness: expect.any(Number), aiming: expect.any(Number) }));
  });

  it('derives v2 world, base, and wounds from legacy location, shelter, and tags', () => {
    const localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 1,
        day: 4,
        spawnLocation: { id: 'riverside' },
        currentNodeId: 'riverside',
        shelter: { id: 'gated_villa' },
        hiddenTags: ['受伤'],
      },
    }));

    const game = useGameStore();
    game.loadPersistedState();

    expect(game.world.seed).toBe(createWorldState({ spawnId: 'riverside' }).seed);
    expect(game.base.defense).toBe(shelters.find((entry) => entry.id === 'gated_villa').defense);
    expect(game.body.wounds).toEqual([expect.objectContaining({ type: 'laceration', source: '旧版存档迁移' })]);
  });

  it('upgrades a v2 save with persistent horde state and experience floors', () => {
    const localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', JSON.stringify({
      game: {
        saveVersion: 2,
        day: 6,
        spawnLocation: { id: 'riverside' },
        currentNodeId: 'riverside',
        skills: { sneaking: 3 },
        world: createWorldState({ day: 6, spawnId: 'riverside' }),
      },
    }));

    const game = useGameStore();
    game.loadPersistedState();

    expect(game.saveVersion).toBe(SAVE_VERSION);
    expect(Object.keys(game.nodeZombieStates)).toHaveLength(mapNodes.length);
    expect(game.nodeZombieStates.riverside).toEqual(expect.objectContaining({
      count: 0,
      clearedDay: 6,
      lastRefreshDay: 6,
    }));
    expect(game.skillXp.sneaking).toBe(cumulativeXpForLevel(3));
    expect(game.skillProgressList.find((skill) => skill.id === 'sneaking')).toEqual(expect.objectContaining({
      level: 3,
      currentLevelXp: 0,
      nextLevelXp: 750,
    }));
  });

  it('backs up corrupt JSON and removes the unusable primary save', () => {
    const localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    localStorage.values.set('moshi-survival-state', '{not-json');
    const game = useGameStore();

    game.loadPersistedState();

    expect(localStorage.values.get('moshi-survival-state-corrupt-backup')).toBe('{not-json');
    expect(localStorage.values.has('moshi-survival-state')).toBe(false);
    expect(game.saveVersion).toBe(SAVE_VERSION);
  });

  it('backs up and refuses a save from a newer unsupported version', () => {
    const localStorage = storage();
    vi.stubGlobal('localStorage', localStorage);
    const raw = JSON.stringify({ game: { saveVersion: SAVE_VERSION + 1, day: 99 } });
    localStorage.values.set('moshi-survival-state', raw);
    const game = useGameStore();

    game.loadPersistedState();

    expect(localStorage.values.get('moshi-survival-state-future-backup')).toBe(raw);
    expect(game.day).toBe(1);
    expect(game.saveVersion).toBe(SAVE_VERSION);
  });
});
