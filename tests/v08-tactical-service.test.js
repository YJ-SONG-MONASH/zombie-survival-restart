import { describe, expect, it } from 'vitest';
import {
  TACTICAL_ENCOUNTER_VERSION,
  createTacticalEncounter,
  listTacticalActions,
  normalizeTacticalEncounter,
  resolveTacticalAction,
  summarizeTacticalEncounter,
} from '../src/services/tactical-encounter.js';

const weapon = ({
  id = 'baseball_bat',
  stackId = `${id}:one`,
  tags = ['weapon', 'melee', 'long_blunt'],
  skill = 'long_blunt',
} = {}) => ({
  id,
  name: id,
  stackId,
  count: 1,
  category: 'weapon',
  tags,
  effects: { skill },
  conditionState: { condition: { current: 100, maximum: 100, broken: false } },
});

const context = (inventory = [weapon()]) => ({
  inventory,
  equippedWeaponStackId: inventory[0]?.stackId ?? null,
  skills: {
    strength: 10,
    fitness: 10,
    nimble: 10,
    long_blunt: 10,
    short_blade: 10,
    spear: 10,
    aiming: 10,
    reloading: 10,
    sneaking: 10,
  },
  vitals: { health: 100, endurance: 100, fatigue: 0, panic: 0, hunger: 0, thirst: 0, stress: 0 },
  body: { pain: 0, wounds: [] },
  usedSpace: 0,
  capacity: 20,
  world: { threat: 0, isNight: false },
});

const individualEncounter = ({ enemy, selectedWeaponStackId = 'baseball_bat:one', seed = 17 } = {}) => (
  createTacticalEncounter({
    id: `v2-test:${seed}`,
    nodeId: 'rosewood',
    zombieCount: 1,
    seed,
    selectedWeaponStackId,
    enemies: [enemy ?? {
      id: `v2-test:${seed}:z:0`,
      profileId: 'shambler',
      hp: 40,
      maxHp: 40,
      distance: 0,
      posture: 'standing',
    }],
  })
);

describe('v0.8 tactical enemy roster contract', () => {
  it('creates a deterministic authoritative v2 enemy roster', () => {
    const input = { nodeId: 'west_point', zombieCount: 9, seed: 991, encounterSequence: 4 };
    const first = createTacticalEncounter(input);
    const repeated = createTacticalEncounter(input);

    expect(TACTICAL_ENCOUNTER_VERSION).toBe(2);
    expect(first).toEqual(repeated);
    expect(first.version).toBe(2);
    expect(first.enemies).toHaveLength(9);
    expect(new Set(first.enemies.map((enemy) => enemy.id)).size).toBe(9);
    expect(first.enemies.every((enemy) => (
      enemy.hp > 0
      && enemy.hp <= enemy.maxHp
      && Number.isInteger(enemy.distance)
      && enemy.distance >= 0
      && enemy.distance <= 3
      && ['standing', 'downed'].includes(enemy.posture)
    ))).toBe(true);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    const longIdState = createTacticalEncounter({
      id: 'encounter'.repeat(30),
      nodeId: 'west_point',
      zombieCount: 9,
      seed: 991,
    });
    expect(new Set(longIdState.enemies.map((enemy) => enemy.id)).size).toBe(9);
    expect(longIdState.enemies.every((enemy) => enemy.id.length <= 160)).toBe(true);

    const explicitRoster = createTacticalEncounter({
      id: 'explicit-roster',
      nodeId: 'west_point',
      seed: 1,
      enemies: [
        { id: 'explicit-one', profileId: 'tough', hp: 19, maxHp: 58, distance: 2, posture: 'standing' },
      ],
    });
    expect(explicitRoster.enemies).toEqual([
      expect.objectContaining({ id: 'explicit-one', hp: 19, distance: 2 }),
    ]);
  });

  it('migrates v1 buckets deterministically without consuming the saved RNG cursor', () => {
    const legacy = {
      version: 1,
      id: 'legacy:v1',
      nodeId: 'rosewood',
      status: 'active',
      turn: 3,
      startedAtMinutes: 700,
      elapsedMinutes: 5,
      rng: { seed: 44, cursor: 7 },
      rangeBand: 'near',
      escapeProgress: 22,
      player: { balance: 70, grabbedBy: 1, aimFocus: 10, loadedByWeapon: {} },
      zombies: { distant: 2, approaching: 2, engaged: 1, downed: 1 },
      selectedWeaponStackId: null,
      log: [],
    };
    const snapshot = structuredClone(legacy);

    const migrated = normalizeTacticalEncounter(legacy, { zombieCount: 6, seed: 999 });
    const repeated = normalizeTacticalEncounter(legacy, { zombieCount: 6, seed: 999 });

    expect(migrated).toEqual(repeated);
    expect(migrated.version).toBe(2);
    expect(migrated.rng).toEqual({ seed: 44, cursor: 7 });
    expect(migrated.enemies.filter((enemy) => enemy.posture === 'downed')).toEqual([
      expect.objectContaining({ distance: 0, hp: expect.any(Number) }),
    ]);
    expect(migrated.enemies.filter((enemy) => enemy.posture === 'standing' && enemy.distance === 0)).toHaveLength(1);
    expect(migrated.enemies.filter((enemy) => enemy.distance === 1)).toHaveLength(2);
    expect(migrated.enemies.filter((enemy) => enemy.distance === 3)).toHaveLength(2);
    expect(migrated.player.grabbedByEnemyIds).toHaveLength(1);
    expect(legacy).toEqual(snapshot);
  });

  it('requires an exact target for offensive actions and rejects it with zero mutation', () => {
    const state = individualEncounter();
    const before = structuredClone(state);
    const result = resolveTacticalAction(state, {
      actionId: 'melee',
      encounterId: state.id,
      expectedTurn: state.turn,
      weaponStackId: 'baseball_bat:one',
    }, context());

    expect(result).toMatchObject({ ok: false, reason: 'target_required' });
    expect(result.nextState).toEqual(before);
    expect(state).toEqual(before);
  });

  it('applies deterministic partial damage and only kills when HP reaches zero', () => {
    let observed = null;
    for (let seed = 1; seed <= 100 && !observed; seed += 1) {
      const state = individualEncounter({
        seed,
        enemy: {
          id: `durable:${seed}`,
          profileId: 'tough',
          hp: 999,
          maxHp: 999,
          distance: 0,
          posture: 'standing',
        },
      });
      const result = resolveTacticalAction(state, {
        actionId: 'melee',
        encounterId: state.id,
        expectedTurn: state.turn,
        weaponStackId: 'baseball_bat:one',
        targetId: state.enemies[0].id,
      }, context());
      if (result.ok && result.effects.enemyChanges[0]?.damage > 0) observed = { state, result };
    }

    expect(observed).not.toBeNull();
    const change = observed.result.effects.enemyChanges[0];
    expect(change).toMatchObject({
      targetId: observed.state.enemies[0].id,
      hpBefore: 999,
      killed: false,
    });
    expect(change.damage).toBeGreaterThan(0);
    expect(change.hpAfter).toBe(999 - change.damage);
    expect(observed.result.effects.zombieKills).toBe(0);
    expect(observed.result.nextState.enemies).toHaveLength(1);
  });

  it('applies push posture changes to the authoritative roster rather than a detached target copy', () => {
    let observed = null;
    for (let seed = 1; seed <= 100 && !observed; seed += 1) {
      const state = individualEncounter({ seed });
      const result = resolveTacticalAction(state, {
        actionId: 'push',
        encounterId: state.id,
        expectedTurn: state.turn,
        targetId: state.enemies[0].id,
      }, context());
      if (result.ok && result.effects.enemyChanges[0]?.knockedDown) observed = result;
    }

    expect(observed).not.toBeNull();
    expect(observed.nextState.enemies[0]).toMatchObject({ posture: 'downed', distance: 0 });
    expect(observed.nextState.zombies).toMatchObject({ engaged: 0, downed: 1 });
  });

  it('enforces weapon reach and only permits stomping a downed contact target', () => {
    const knife = weapon({ id: 'kitchen_knife', stackId: 'knife:one', tags: ['weapon', 'melee', 'short_blade'], skill: 'short_blade' });
    const spear = weapon({ id: 'crafted_spear', stackId: 'spear:one', tags: ['weapon', 'melee', 'spear'], skill: 'spear' });
    const standing = individualEncounter({
      selectedWeaponStackId: knife.stackId,
      enemy: { id: 'range-target', profileId: 'shambler', hp: 40, maxHp: 40, distance: 2, posture: 'standing' },
    });

    expect(listTacticalActions(standing, context([knife]), { targetId: 'range-target', weaponStackId: knife.stackId })
      .find((action) => action.id === 'melee')).toMatchObject({ enabled: false, disabledReason: 'target_out_of_reach', reach: 0 });
    expect(listTacticalActions(standing, context([spear]), { targetId: 'range-target', weaponStackId: spear.stackId })
      .find((action) => action.id === 'melee')).toMatchObject({ enabled: true, reach: 2 });

    const downedFar = individualEncounter({
      enemy: { id: 'downed-target', profileId: 'shambler', hp: 20, maxHp: 40, distance: 1, posture: 'downed' },
    });
    expect(listTacticalActions(downedFar, context(), { targetId: 'downed-target' })
      .find((action) => action.id === 'stomp')).toMatchObject({ enabled: false, disabledReason: 'target_out_of_reach' });
    downedFar.enemies[0].distance = 0;
    expect(listTacticalActions(downedFar, context(), { targetId: 'downed-target' })
      .find((action) => action.id === 'stomp')).toMatchObject({ enabled: true });
  });

  it('keeps a lone downed enemy attackable at weapon range instead of soft-locking the encounter', () => {
    const spear = weapon({ id: 'crafted_spear', stackId: 'spear:one', tags: ['weapon', 'melee', 'spear'], skill: 'spear' });
    const state = individualEncounter({
      selectedWeaponStackId: spear.stackId,
      enemy: { id: 'last-downed', profileId: 'shambler', hp: 20, maxHp: 40, distance: 1, posture: 'downed' },
    });
    const preview = listTacticalActions(state, context([spear]), {
      targetId: 'last-downed',
      weaponStackId: spear.stackId,
    }).find((action) => action.id === 'melee');
    const result = resolveTacticalAction(state, {
      actionId: 'melee',
      encounterId: state.id,
      expectedTurn: state.turn,
      targetId: 'last-downed',
      weaponStackId: spear.stackId,
    }, context([spear]));

    expect(preview).toMatchObject({ enabled: true, reach: 2 });
    expect(result.ok).toBe(true);
    expect(result.effects.weaponUses).toEqual([
      expect.objectContaining({ stackId: spear.stackId, attacks: 1 }),
    ]);
  });

  it('lets a fast shambler advance two distance steps during the response', () => {
    const state = individualEncounter({
      enemy: { id: 'fast-one', profileId: 'fast_shambler', hp: 34, maxHp: 34, distance: 3, posture: 'standing' },
    });
    const result = resolveTacticalAction(state, {
      actionId: 'brace',
      encounterId: state.id,
      expectedTurn: state.turn,
    }, context());

    expect(result.ok).toBe(true);
    expect(result.nextState.enemies[0]).toMatchObject({ id: 'fast-one', distance: 1 });
    expect(result.events.find((event) => event.type === 'zombie_response')).toMatchObject({ enemyId: 'fast-one' });
  });

  it('returns six visible enemy cards, hidden count, and actionable combat telemetry', () => {
    const state = createTacticalEncounter({ nodeId: 'louisville', zombieCount: 9, seed: 81 });
    const summary = summarizeTacticalEncounter(state, context());

    expect(summary.visibleEnemies).toHaveLength(6);
    expect(summary.hiddenEnemyCount).toBe(3);
    expect(summary.visibleEnemies[0]).toMatchObject({
      id: expect.any(String),
      profileId: expect.any(String),
      profileLabel: expect.any(String),
      hp: expect.any(Number),
      maxHp: expect.any(Number),
      distance: expect.any(Number),
      distanceMeters: expect.any(String),
      distanceLabel: expect.any(String),
      speed: expect.any(Number),
      attack: expect.any(Number),
      grip: expect.any(Number),
    });
  });

  it('keeps the actual retaliation risk inside the previewed risk range', () => {
    const state = individualEncounter();
    const targetId = state.enemies[0].id;
    const preview = listTacticalActions(state, context(), {
      targetId,
      weaponStackId: 'baseball_bat:one',
    }).find((action) => action.id === 'melee');
    const result = resolveTacticalAction(state, {
      actionId: 'melee',
      encounterId: state.id,
      expectedTurn: state.turn,
      weaponStackId: 'baseball_bat:one',
      targetId,
    }, context());
    const response = result.events.find((event) => event.type === 'zombie_response');

    expect(preview.retaliationRiskRange).toHaveLength(2);
    expect(preview.retaliationRiskRange).not.toEqual([2, 98]);
    expect(preview.retaliationRiskRange[1] - preview.retaliationRiskRange[0]).toBeLessThan(40);
    expect(response.risk * 100).toBeGreaterThanOrEqual(preview.retaliationRiskRange[0]);
    expect(response.risk * 100).toBeLessThanOrEqual(preview.retaliationRiskRange[1]);
  });

  it('makes a successful retreat create net space while moving downed enemies out of stomp range', () => {
    let observed = null;
    for (let seed = 1; seed <= 50 && !observed; seed += 1) {
      const state = createTacticalEncounter({
        id: `retreat:${seed}`,
        nodeId: 'rosewood',
        zombieCount: 2,
        seed,
        enemies: [
          { id: 'standing-one', profileId: 'shambler', hp: 40, maxHp: 40, distance: 0, posture: 'standing' },
          { id: 'downed-one', profileId: 'shambler', hp: 20, maxHp: 40, distance: 0, posture: 'downed' },
        ],
      });
      const result = resolveTacticalAction(state, {
        actionId: 'step_back',
        encounterId: state.id,
        expectedTurn: state.turn,
      }, context());
      if (result.ok && result.events[0].success) observed = result;
    }

    expect(observed).not.toBeNull();
    expect(observed.nextState.enemies.find((enemy) => enemy.id === 'standing-one').distance).toBe(1);
    expect(observed.nextState.enemies.find((enemy) => enemy.id === 'downed-one').distance).toBe(2);
    expect(listTacticalActions(observed.nextState, context(), { targetId: 'downed-one' })
      .find((action) => action.id === 'stomp'))
      .toMatchObject({ enabled: false, disabledReason: 'target_out_of_reach' });
  });

  it('turns a long reload into more response exposure than a one-minute brace', () => {
    const pistol = weapon({
      id: 'm9_pistol',
      stackId: 'pistol:one',
      tags: ['weapon', 'firearm', '9mm'],
      skill: 'aiming',
    });
    const ammo = {
      id: '9mm_rounds',
      stackId: 'ammo:one',
      count: 12,
      category: 'ammo',
      tags: ['ammo', '9mm'],
    };
    const combatContext = context([pistol, ammo]);
    const state = individualEncounter({
      selectedWeaponStackId: pistol.stackId,
      enemy: { id: 'reload-pursuer', profileId: 'shambler', hp: 40, maxHp: 40, distance: 3, posture: 'standing' },
    });
    const reloadPreview = listTacticalActions(state, combatContext, {
      weaponStackId: pistol.stackId,
    }).find((action) => action.id === 'reload');
    const braced = resolveTacticalAction(state, {
      actionId: 'brace',
      encounterId: state.id,
      expectedTurn: state.turn,
    }, combatContext);
    const reloaded = resolveTacticalAction(state, {
      actionId: 'reload',
      encounterId: state.id,
      expectedTurn: state.turn,
      weaponStackId: pistol.stackId,
      ammoStackId: ammo.stackId,
      rounds: 12,
    }, combatContext);
    const braceResponse = braced.events.find((event) => event.type === 'zombie_response');
    const reloadResponse = reloaded.events.find((event) => event.type === 'zombie_response');

    expect(reloadPreview.durationMinutes).toBe(4);
    expect(braceResponse.exposureSteps).toBe(1);
    expect(reloadResponse.exposureSteps).toBe(2);
    expect(reloadResponse.distanceAfter).toBeLessThan(braceResponse.distanceAfter);
    expect(reloadResponse.risk * 100).toBeGreaterThanOrEqual(reloadPreview.retaliationRiskRange[0]);
    expect(reloadResponse.risk * 100).toBeLessThanOrEqual(reloadPreview.retaliationRiskRange[1]);
  });
});
