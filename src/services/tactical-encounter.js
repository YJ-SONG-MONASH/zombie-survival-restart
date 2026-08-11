export const TACTICAL_ENCOUNTER_VERSION = 1;

export const TACTICAL_ACTION_IDS = Object.freeze([
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

const ACTIVE_STATUS = 'active';
const TERMINAL_STATUSES = new Set(['cleared', 'escaped', 'dead', 'aborted']);
const VALID_STATUSES = new Set([ACTIVE_STATUS, ...TERMINAL_STATUSES]);
const VALID_RANGE_BANDS = new Set(['contact', 'near', 'far']);
const MAX_ZOMBIES = 10_000;
const MAX_MINUTES = 1_000_000_000;
const MAX_TURNS = 1_000_000;
const MAX_RNG_CURSOR = 1_000_000_000;
const MAX_LOG_ENTRIES = 40;
const UINT32_RANGE = 4_294_967_296;

const ACTION_DEFINITIONS = Object.freeze({
  push: { label: '推开', durationMinutes: 1, staminaCost: 5, noiseDelta: 1, riskMultiplier: 0.9, estimatedOutcome: '争取一步空间，可能将目标推倒' },
  melee: { label: '近战攻击', durationMinutes: 1, staminaCost: 6, noiseDelta: 3, riskMultiplier: 1, estimatedOutcome: '使用当前武器打击近身目标' },
  stomp: { label: '踩踏', durationMinutes: 1, staminaCost: 4, noiseDelta: 2, riskMultiplier: 1.05, estimatedOutcome: '处决一只倒地僵尸' },
  step_back: { label: '后撤', durationMinutes: 1, staminaCost: 4, noiseDelta: 0, riskMultiplier: 0.8, estimatedOutcome: '拉开距离并积累脱离进度' },
  aim: { label: '瞄准', durationMinutes: 1, staminaCost: 1, noiseDelta: 0, riskMultiplier: 1.05, estimatedOutcome: '提高下一发枪击命中率' },
  reload: { label: '装填', durationMinutes: 1, staminaCost: 1, noiseDelta: 1, riskMultiplier: 1.1, estimatedOutcome: '从指定弹药堆装入当前枪械' },
  fire: { label: '开火', durationMinutes: 1, staminaCost: 2, noiseDelta: 30, riskMultiplier: 1.2, estimatedOutcome: '消耗一发已装弹药并吸引尸群' },
  disengage: { label: '脱离', durationMinutes: 2, staminaCost: 6, noiseDelta: 0, riskMultiplier: 0.75, estimatedOutcome: '尝试脱离并取得短暂安全窗口' },
  brace: { label: '稳住阵脚', durationMinutes: 1, staminaCost: 0, noiseDelta: 0, riskMultiplier: 0.65, estimatedOutcome: '恢复平衡与少量耐力，并承受尸群推进' },
});

const FIREARM_PROFILES = Object.freeze({
  shotgun: { ammoItemId: 'shotgun_shells', ammoTag: 'shotgun', capacity: 6, accuracy: 0.5, noise: 48 },
  m9_pistol: { ammoItemId: '9mm_rounds', ammoTag: '9mm', capacity: 15, accuracy: 0.57, noise: 30 },
  m36_revolver: { ammoItemId: '9mm_rounds', ammoTag: '9mm', capacity: 6, accuracy: 0.62, noise: 28 },
});

const DEFAULT_FIREARM_PROFILE = Object.freeze({
  ammoItemId: '9mm_rounds',
  ammoTag: '9mm',
  capacity: 10,
  accuracy: 0.52,
  noise: 30,
});

const VITAL_KEYS = Object.freeze([
  'health',
  'endurance',
  'fatigue',
  'hunger',
  'thirst',
  'panic',
  'stress',
]);

/**
 * Creates one deterministic, JSON-safe encounter. The caller supplies all
 * clock and random inputs; this module never reads ambient time or randomness.
 */
export function createTacticalEncounter(input = {}) {
  const source = isRecord(input) ? input : {};
  const nodeId = runtimeId(source.nodeId) || 'unknown_node';
  const seed = normalizeSeed(source.seed, 0);
  const startedAtMinutes = boundedInteger(source.startedAtMinutes, 0, MAX_MINUTES, 0);
  const encounterSequence = boundedInteger(
    source.encounterSequence ?? source.sequence,
    0,
    MAX_TURNS,
    0,
  );
  const zombieCount = boundedInteger(
    source.zombieCount ?? source.nodePopulation ?? source.count,
    0,
    MAX_ZOMBIES,
    0,
  );
  const rangeBand = VALID_RANGE_BANDS.has(source.initialRangeBand)
    ? source.initialRangeBand
    : 'near';
  const initialZombies = isRecord(source.initialZombies)
    ? source.initialZombies
    : createInitialBuckets(zombieCount, rangeBand);
  const id = runtimeId(source.id ?? source.encounterId) || `tactical:${hash32(
    `${nodeId}|${startedAtMinutes}|${encounterSequence}|${seed}`,
  ).toString(36).padStart(7, '0')}`;
  const initialPlayer = isRecord(source.player) ? source.player : {};
  const loadedByWeapon = source.loadedByWeapon
    ?? source.firearmLoads
    ?? initialPlayer.loadedByWeapon
    ?? {};

  return normalizeTacticalEncounter({
    version: TACTICAL_ENCOUNTER_VERSION,
    id,
    nodeId,
    status: zombieCount > 0 ? ACTIVE_STATUS : 'cleared',
    turn: 0,
    startedAtMinutes,
    elapsedMinutes: 0,
    rng: { seed, cursor: 0 },
    rangeBand,
    escapeProgress: source.escapeProgress ?? 0,
    player: {
      balance: initialPlayer.balance ?? 100,
      grabbedBy: initialPlayer.grabbedBy ?? 0,
      aimFocus: initialPlayer.aimFocus ?? 0,
      loadedByWeapon,
    },
    zombies: initialZombies,
    selectedWeaponStackId: runtimeId(source.selectedWeaponStackId) || null,
    log: [],
  }, { zombieCount, seed });
}

/**
 * Repairs save data and legacy load shapes. If options.zombieCount is supplied,
 * buckets are deterministically rebalanced to that exact population.
 */
export function normalizeTacticalEncounter(rawState, options = {}) {
  const source = isRecord(rawState) ? rawState : {};
  const settings = isRecord(options) ? options : {};
  const nodeId = runtimeId(source.nodeId) || runtimeId(settings.nodeId) || 'unknown_node';
  const fallbackSeed = normalizeSeed(settings.seed, 0);
  const seed = normalizeSeed(source.rng?.seed ?? source.seed, fallbackSeed);
  const startedAtMinutes = boundedInteger(source.startedAtMinutes, 0, MAX_MINUTES, 0);
  const turn = boundedInteger(source.turn, 0, MAX_TURNS, 0);
  const rawBuckets = isRecord(source.zombies) ? source.zombies : source;
  const hasTargetCount = finiteNumber(settings.zombieCount ?? settings.nodePopulation) !== null;
  const targetCount = hasTargetCount
    ? boundedInteger(settings.zombieCount ?? settings.nodePopulation, 0, MAX_ZOMBIES, 0)
    : undefined;
  const zombies = normalizeZombieBuckets(rawBuckets, targetCount);
  const total = zombieBucketTotal(zombies);
  let status = VALID_STATUSES.has(source.status) ? source.status : ACTIVE_STATUS;
  if (total === 0 && status === ACTIVE_STATUS) status = 'cleared';
  if (total > 0 && status === 'cleared') status = ACTIVE_STATUS;
  const loadedSource = source.player?.loadedByWeapon
    ?? source.loadedByWeapon
    ?? source.firearmLoads
    ?? {};
  const loadedByWeapon = normalizeLoadedByWeapon(loadedSource);
  const id = runtimeId(source.id ?? source.encounterId) || `tactical:${hash32(
    `${nodeId}|${startedAtMinutes}|${turn}|${seed}`,
  ).toString(36).padStart(7, '0')}`;
  const engaged = zombies.engaged;
  const log = Array.isArray(source.log)
    ? source.log.slice(-MAX_LOG_ENTRIES).map((entry) => jsonSafeClone(entry))
    : [];

  return {
    version: TACTICAL_ENCOUNTER_VERSION,
    id,
    encounterId: id,
    nodeId,
    status,
    turn,
    startedAtMinutes,
    elapsedMinutes: boundedInteger(source.elapsedMinutes, 0, MAX_MINUTES, 0),
    rng: {
      seed,
      cursor: boundedInteger(source.rng?.cursor ?? source.rngCursor, 0, MAX_RNG_CURSOR, 0),
    },
    rangeBand: VALID_RANGE_BANDS.has(source.rangeBand) ? source.rangeBand : 'near',
    escapeProgress: roundTo(boundedNumber(source.escapeProgress, 0, 100, 0), 2),
    player: {
      balance: roundTo(boundedNumber(source.player?.balance, 0, 100, 100), 2),
      grabbedBy: boundedInteger(source.player?.grabbedBy, 0, engaged, 0),
      aimFocus: roundTo(boundedNumber(source.player?.aimFocus, 0, 100, 0), 2),
      loadedByWeapon,
    },
    zombies,
    selectedWeaponStackId: runtimeId(source.selectedWeaponStackId) || null,
    log,
  };
}

/** Returns all tactical verbs, including disabled ones with stable reason IDs. */
export function listTacticalActions(rawState, context = {}) {
  const state = normalizeTacticalEncounter(rawState);
  return TACTICAL_ACTION_IDS.map((actionId) => {
    const availability = actionAvailability(state, context, { actionId });
    const definition = ACTION_DEFINITIONS[actionId];
    const risk = Math.round(responseRisk(state, context, actionId) * 100);
    let durationMinutes = definition.durationMinutes;
    let noiseDelta = definition.noiseDelta;
    if (actionId === 'reload' && availability.enabled && availability.weapon && availability.ammo) {
      const profile = firearmProfile(availability.weapon);
      const loaded = effectiveLoad(state, context, availability.weapon).rounds;
      const rounds = Math.min(itemCount(availability.ammo), Math.max(0, profile.capacity - loaded));
      durationMinutes = Math.max(1, Math.ceil(rounds / 3));
    }
    if (actionId === 'fire' && availability.weapon) {
      noiseDelta = firearmProfile(availability.weapon).noise;
    }
    return {
      id: actionId,
      label: definition.label,
      enabled: availability.enabled,
      disabled: !availability.enabled,
      disabledReason: availability.enabled ? '' : availability.reason,
      risk,
      tone: risk >= 75 ? 'critical' : risk >= 50 ? 'danger' : risk >= 25 ? 'warning' : 'neutral',
      durationMinutes,
      minutes: durationMinutes,
      staminaCost: definition.staminaCost,
      noiseDelta,
      estimatedOutcome: definition.estimatedOutcome,
      weaponStackId: availability.weapon?.stackId ?? null,
    };
  });
}

/**
 * Resolves a single command and the horde response as an atomic transaction.
 * Rejected commands return a deep-equal nextState and do not advance RNG.
 */
export function resolveTacticalAction(rawState, command = {}, context = {}) {
  const effects = createZeroEffects();
  const originalState = cloneValue(rawState);
  const sourceState = isRecord(rawState) ? rawState : {};
  const request = isRecord(command) ? command : {};

  if (isTacticalEncounterTerminal(sourceState)) {
    return failureResult('encounter_terminal', originalState, effects);
  }

  const state = normalizeTacticalEncounter(sourceState);
  if (isTacticalEncounterTerminal(state)) {
    return failureResult('encounter_terminal', originalState, effects);
  }
  if (request.encounterId !== undefined && request.encounterId !== state.id) {
    return failureResult('stale_encounter', originalState, effects);
  }
  if (request.expectedTurn !== undefined
    && boundedInteger(request.expectedTurn, -1, MAX_TURNS, -1) !== state.turn) {
    return failureResult('stale_turn', originalState, effects);
  }

  const actionId = runtimeId(request.actionId ?? request.id);
  if (!TACTICAL_ACTION_IDS.includes(actionId)) {
    return failureResult('invalid_action', originalState, effects);
  }

  const availability = actionAvailability(state, context, { ...request, actionId });
  if (!availability.enabled) {
    return failureResult(availability.reason, originalState, effects);
  }

  const nextState = cloneValue(state);
  const rng = { ...nextState.rng };
  const actionTurn = nextState.turn;
  const beforeZombieCount = zombieBucketTotal(nextState.zombies);
  const actionOutcome = applyPlayerAction({
    actionId,
    state: nextState,
    request,
    context,
    availability,
    effects,
    rng,
  });

  effects.durationMinutes = actionOutcome.durationMinutes;
  nextState.turn = Math.min(MAX_TURNS, nextState.turn + 1);
  nextState.elapsedMinutes = Math.min(
    MAX_MINUTES,
    nextState.elapsedMinutes + effects.durationMinutes,
  );
  if (availability.weapon?.stackId) {
    nextState.selectedWeaponStackId = availability.weapon.stackId;
  }

  const events = [createPlayerActionEvent(
    actionTurn + 1,
    actionId,
    availability.weapon,
    actionOutcome,
    effects,
  )];

  if (zombieBucketTotal(nextState.zombies) === 0) nextState.status = 'cleared';
  if (nextState.status === ACTIVE_STATUS) {
    const responseEvent = applyZombieResponse(
      nextState,
      context,
      actionId,
      effects,
      rng,
      actionOutcome,
    );
    events.push(responseEvent);
  }

  const projectedHealth = vital(context, 'health', 100) + effects.vitalsDelta.health;
  if (projectedHealth <= 0) nextState.status = 'dead';

  const expectedZombieCount = Math.max(0, beforeZombieCount - effects.zombieKills);
  nextState.zombies = normalizeZombieBuckets(nextState.zombies, expectedZombieCount);
  nextState.player.grabbedBy = boundedInteger(
    nextState.player.grabbedBy,
    0,
    nextState.zombies.engaged,
    0,
  );
  nextState.player.balance = roundTo(boundedNumber(nextState.player.balance, 0, 100, 100), 2);
  nextState.player.aimFocus = roundTo(boundedNumber(nextState.player.aimFocus, 0, 100, 0), 2);
  nextState.escapeProgress = roundTo(boundedNumber(nextState.escapeProgress, 0, 100, 0), 2);
  nextState.rng = {
    seed: normalizeSeed(rng.seed, state.rng.seed),
    cursor: boundedInteger(rng.cursor, 0, MAX_RNG_CURSOR, state.rng.cursor),
  };
  nextState.log = [...nextState.log, ...events]
    .slice(-MAX_LOG_ENTRIES)
    .map((entry) => jsonSafeClone(entry));

  return {
    ok: true,
    reason: null,
    nextState,
    effects: normalizeEffects(effects),
    events,
  };
}

export function isTacticalEncounterTerminal(state) {
  return TERMINAL_STATUSES.has(state?.status);
}

/** A presentation-safe snapshot; callers need not recreate pressure thresholds. */
export function summarizeTacticalEncounter(rawState, context = {}) {
  const state = normalizeTacticalEncounter(rawState);
  const remainingZombies = zombieBucketTotal(state.zombies);
  const standingZombies = state.zombies.distant + state.zombies.approaching + state.zombies.engaged;
  let pressureBand = 'low';
  if (state.player.grabbedBy > 0 || state.zombies.engaged >= 2
    || (state.rangeBand === 'contact' && state.zombies.engaged > 0)) {
    pressureBand = 'critical';
  } else if (state.zombies.engaged > 0 || state.zombies.approaching >= 3) {
    pressureBand = 'high';
  } else if (state.zombies.approaching > 0) {
    pressureBand = 'moderate';
  }
  const presentation = summaryPresentation(state.status, pressureBand);
  const capacity = Math.max(1, boundedNumber(context?.capacity, 1, 1_000_000, 1));
  const usedSpace = boundedNumber(context?.usedSpace, 0, 1_000_000, 0);
  const wounds = Array.isArray(context?.body?.wounds) ? context.body.wounds : [];

  return {
    id: state.id,
    nodeId: state.nodeId,
    status: state.status,
    turn: state.turn,
    elapsedMinutes: state.elapsedMinutes,
    rangeBand: state.rangeBand,
    escapeProgress: state.escapeProgress,
    zombies: cloneValue(state.zombies),
    remainingZombies,
    standingZombies,
    downedZombies: state.zombies.downed,
    pressure: Math.round(responseRisk(state, context, 'melee') * 100),
    pressureBand,
    threat: roundTo(boundedNumber(context?.world?.threat, 0, 100, 0), 2),
    noise: roundTo(boundedNumber(context?.world?.noise, 0, 100, 0), 2),
    health: roundTo(vital(context, 'health', 100), 2),
    endurance: roundTo(vital(context, 'endurance', 100), 2),
    panic: roundTo(vital(context, 'panic', 0), 2),
    pain: roundTo(boundedNumber(context?.body?.pain, 0, 100, 0), 2),
    encumbrance: roundTo(usedSpace / capacity * 100, 2),
    bleeding: wounds.filter((wound) => wound?.bleeding).length,
    balance: state.player.balance,
    grabbedBy: state.player.grabbedBy,
    aimFocus: state.player.aimFocus,
    selectedWeaponStackId: state.selectedWeaponStackId,
    canAct: state.status === ACTIVE_STATUS,
    label: presentation.label,
    tone: presentation.tone,
  };
}

function applyPlayerAction({ actionId, state, request, context, availability, effects, rng }) {
  switch (actionId) {
    case 'push':
      return resolvePush(state, context, effects, rng);
    case 'melee':
      return resolveMelee(state, context, availability.weapon, effects, rng);
    case 'stomp':
      return resolveStomp(state, context, effects, rng);
    case 'step_back':
      return resolveStepBack(state, context, effects, rng);
    case 'aim':
      return resolveAim(state, context, availability.weapon, effects);
    case 'reload':
      return resolveReload(state, request, context, availability, effects);
    case 'fire':
      return resolveFire(state, context, availability.weapon, effects, rng);
    case 'disengage':
      return resolveDisengage(state, context, effects, rng);
    case 'brace':
      return resolveBrace(state, context, effects);
    default:
      return { success: false, durationMinutes: 0 };
  }
}

function resolvePush(state, context, effects, rng) {
  const chance = clamp(
    0.5
      + skill(context, 'strength') * 0.035
      + skill(context, 'fitness') * 0.015
      + state.player.balance * 0.001
      - responseRisk(state, context, 'push') * 0.25,
    0.08,
    0.98,
  );
  const roll = draw(rng, 'push');
  const success = roll < chance;
  if (success) {
    if (state.player.grabbedBy > 0) state.player.grabbedBy -= 1;
    if (state.zombies.engaged > 0) {
      state.zombies.engaged -= 1;
      if (roll < chance * 0.55) state.zombies.downed += 1;
      else state.zombies.approaching += 1;
    }
    state.player.balance = Math.min(100, state.player.balance + 8);
    addSkillXp(effects, 'strength', 2);
    addSkillXp(effects, 'nimble', 2);
  } else {
    state.player.balance -= 14;
    effects.vitalsDelta.panic += 3;
    addSkillXp(effects, 'nimble', 1);
  }
  effects.vitalsDelta.endurance -= 5;
  effects.vitalsDelta.fatigue += 0.5;
  effects.noiseDelta += 1;
  return { success, durationMinutes: 1, chance: roundTo(chance, 4) };
}

function resolveMelee(state, context, weapon, effects, rng) {
  const weaponSkill = weaponSkillId(weapon);
  const chance = clamp(
    0.42
      + skill(context, weaponSkill) * 0.045
      + skill(context, 'strength') * 0.012
      + state.player.balance * 0.0012
      - responseRisk(state, context, 'melee') * 0.28,
    0.08,
    0.97,
  );
  const roll = draw(rng, `melee:${weapon.stackId}`);
  const hit = roll < chance;
  let kills = 0;
  if (hit) {
    kills = removeZombie(state.zombies, ['engaged', 'approaching']);
  } else if (roll < Math.min(0.99, chance + 0.18)) {
    knockDownZombie(state.zombies, ['engaged', 'approaching']);
  }
  effects.zombieKills += kills;
  effects.weaponUses.push({
    stackId: weapon.stackId,
    attacks: 1,
    impacts: hit ? 1 : 0,
    kills,
  });
  addSkillXp(effects, weaponSkill, hit ? 6 : 2);
  addSkillXp(effects, 'maintenance', hit ? 1 : 0.5);
  effects.vitalsDelta.endurance -= 6;
  effects.vitalsDelta.fatigue += 0.7;
  effects.noiseDelta += hasTag(weapon, 'silent') ? 1 : 3;
  state.player.aimFocus = 0;
  return { success: hit, hit, kills, durationMinutes: 1, chance: roundTo(chance, 4) };
}

function resolveStomp(state, context, effects, rng) {
  const expertStomp = skill(context, 'strength') >= 9
    && skill(context, 'fitness') >= 9
    && state.player.grabbedBy === 0;
  const chance = expertStomp ? 1 : clamp(
    0.64
      + skill(context, 'strength') * 0.025
      + skill(context, 'fitness') * 0.01
      - responseRisk(state, context, 'stomp') * 0.18,
    0.12,
    0.98,
  );
  const roll = draw(rng, 'stomp');
  const hit = roll < chance;
  const kills = hit ? removeZombie(state.zombies, ['downed']) : 0;
  effects.zombieKills += kills;
  effects.vitalsDelta.endurance -= 4;
  effects.vitalsDelta.fatigue += 0.5;
  effects.noiseDelta += 2;
  addSkillXp(effects, 'strength', hit ? 3 : 1);
  return { success: hit, hit, kills, durationMinutes: 1, chance: roundTo(chance, 4) };
}

function resolveStepBack(state, context, effects, rng) {
  const chance = clamp(
    0.52
      + skill(context, 'nimble') * 0.04
      + skill(context, 'fitness') * 0.015
      + state.player.balance * 0.001
      - responseRisk(state, context, 'step_back') * 0.25,
    0.1,
    0.98,
  );
  const roll = draw(rng, 'step_back');
  const success = roll < chance;
  if (success) {
    if (state.rangeBand === 'contact') {
      state.rangeBand = 'near';
      moveZombies(state.zombies, 'engaged', 'approaching', state.zombies.engaged);
      state.escapeProgress += 25;
    } else {
      state.rangeBand = 'far';
      moveZombies(state.zombies, 'engaged', 'approaching', state.zombies.engaged);
      state.escapeProgress += 40;
    }
    state.player.balance = Math.min(100, state.player.balance + 4);
    addSkillXp(effects, 'nimble', 4);
  } else {
    state.player.balance -= 18;
    effects.vitalsDelta.panic += 4;
    addSkillXp(effects, 'nimble', 1);
  }
  state.player.aimFocus = Math.max(0, state.player.aimFocus - 15);
  effects.vitalsDelta.endurance -= 4;
  effects.vitalsDelta.fatigue += 0.4;
  return { success, durationMinutes: 1, chance: roundTo(chance, 4) };
}

function resolveAim(state, context, weapon, effects) {
  const gain = 22 + skill(context, 'aiming') * 4;
  state.player.aimFocus = Math.min(100, state.player.aimFocus + gain);
  addSkillXp(effects, 'aiming', 1);
  effects.vitalsDelta.endurance -= 1;
  return { success: true, durationMinutes: 1, focusGain: gain, weaponStackId: weapon.stackId };
}

function resolveReload(state, request, context, availability, effects) {
  const weapon = availability.weapon;
  const ammo = availability.ammo;
  const profile = firearmProfile(weapon);
  const previous = effectiveLoad(state, context, weapon);
  const availableRounds = boundedInteger(ammo.count, 0, 1_000_000, 0);
  const remainingCapacity = Math.max(0, profile.capacity - previous.rounds);
  const requestedRounds = boundedInteger(request.rounds, 1, profile.capacity, 1);
  const rounds = Math.min(availableRounds, remainingCapacity, requestedRounds);
  const loaded = {
    ammoItemId: runtimeId(ammo.id) || profile.ammoItemId,
    ammoStackId: runtimeId(ammo.stackId) || null,
    rounds: previous.rounds + rounds,
  };
  state.player.loadedByWeapon[weapon.stackId] = loaded;
  effects.ammoConsumption.push({ stackId: ammo.stackId, count: rounds });
  effects.firearmLoads[weapon.stackId] = cloneValue(loaded);
  addSkillXp(effects, 'reloading', rounds * 2);
  effects.vitalsDelta.endurance -= 1;
  effects.noiseDelta += 1;
  return {
    success: true,
    durationMinutes: Math.max(1, Math.ceil(rounds / 3)),
    rounds,
    weaponStackId: weapon.stackId,
  };
}

function resolveFire(state, context, weapon, effects, rng) {
  const profile = firearmProfile(weapon);
  const previous = effectiveLoad(state, context, weapon);
  const rangeAdjustment = state.rangeBand === 'contact'
    ? -0.08
    : state.rangeBand === 'far' ? -0.04 : 0.04;
  const expertShot = skill(context, 'aiming') >= 10
    && vital(context, 'panic', 0) <= 5
    && vital(context, 'fatigue', 0) <= 5
    && state.player.grabbedBy === 0;
  const chance = expertShot ? 1 : clamp(
    profile.accuracy
      + skill(context, 'aiming') * 0.035
      + state.player.aimFocus * 0.0035
      + rangeAdjustment
      - responseRisk(state, context, 'fire') * 0.2,
    0.08,
    0.98,
  );
  const roll = draw(rng, `fire:${weapon.stackId}`);
  const hit = roll < chance;
  const kills = hit ? removeZombie(state.zombies, ['engaged', 'approaching', 'distant']) : 0;
  const loaded = {
    ammoItemId: previous.ammoItemId,
    ammoStackId: previous.ammoStackId,
    rounds: Math.max(0, previous.rounds - 1),
  };
  state.player.loadedByWeapon[weapon.stackId] = loaded;
  effects.firearmLoads[weapon.stackId] = cloneValue(loaded);
  effects.weaponUses.push({
    stackId: weapon.stackId,
    attacks: 1,
    impacts: hit ? 1 : 0,
    kills,
  });
  effects.zombieKills += kills;
  effects.noiseDelta += profile.noise;
  effects.threatDelta += Math.max(1, Math.round(profile.noise * 0.45));
  effects.vitalsDelta.endurance -= 2;
  effects.vitalsDelta.panic += 1;
  addSkillXp(effects, weaponSkillId(weapon), hit ? 8 : 3);
  state.player.aimFocus = Math.max(0, state.player.aimFocus - 35);
  return { success: hit, hit, kills, durationMinutes: 1, chance: roundTo(chance, 4) };
}

function resolveDisengage(state, context, effects, rng) {
  const completelySeparated = state.zombies.engaged === 0 && state.zombies.approaching === 0;
  const mobility = skill(context, 'sneaking') + skill(context, 'nimble') + skill(context, 'fitness');
  const guaranteed = state.escapeProgress >= 100 || (completelySeparated && mobility >= 24);
  const chance = guaranteed ? 1 : clamp(
    0.24
      + state.escapeProgress * 0.006
      + skill(context, 'sneaking') * 0.035
      + skill(context, 'nimble') * 0.02
      + skill(context, 'fitness') * 0.012
      - responseRisk(state, context, 'disengage') * 0.28,
    0.08,
    0.96,
  );
  const roll = draw(rng, 'disengage');
  const success = roll < chance;
  if (success) {
    state.status = 'escaped';
    effects.evasionMinutes = 120 + Math.round(skill(context, 'sneaking') * 6);
    addSkillXp(effects, 'sneaking', 8);
    addSkillXp(effects, 'nimble', 3);
  } else {
    state.rangeBand = 'near';
    state.escapeProgress = Math.max(0, state.escapeProgress - 30);
    effects.vitalsDelta.panic += 6;
    addSkillXp(effects, 'sneaking', 2);
  }
  effects.vitalsDelta.endurance -= 6;
  effects.vitalsDelta.fatigue += 0.7;
  return { success, durationMinutes: 2, chance: roundTo(chance, 4) };
}

function resolveBrace(state, context, effects) {
  const gain = Math.min(30, 100 - state.player.balance);
  const enduranceGain = Math.min(3, Math.max(0, 100 - vital(context, 'endurance', 100)));
  const underPressure = state.player.grabbedBy > 0
    || state.zombies.engaged > 0
    || state.zombies.approaching > 0;
  state.player.balance += gain;
  state.player.aimFocus = Math.max(0, state.player.aimFocus - 5);
  effects.vitalsDelta.endurance += enduranceGain;
  effects.vitalsDelta.fatigue += 0.2;
  if (gain > 0 && underPressure) addSkillXp(effects, 'fitness', 1);
  return {
    success: true,
    durationMinutes: 1,
    balanceGain: gain,
    enduranceGain,
  };
}

function applyZombieResponse(state, context, actionId, effects, rng, actionOutcome = {}) {
  const roll = draw(rng, `response:${actionId}`);
  const successfulRetreat = actionId === 'step_back' && actionOutcome.success === true;
  if (state.rangeBand === 'far') {
    moveZombies(state.zombies, 'distant', 'approaching', 1);
    if (state.zombies.approaching > 0) state.escapeProgress = Math.max(0, state.escapeProgress - 4);
    // Far range is a short-lived opening, not a permanent safe zone. Only a
    // deliberate retreat can preserve it; aiming, bracing, reloading, or
    // attacking lets the leading zombie close back to near range.
    if (!successfulRetreat && state.zombies.approaching > 0) {
      state.rangeBand = 'near';
    }
  } else if (state.rangeBand === 'near') {
    moveZombies(state.zombies, 'distant', 'approaching', 1);
    if (!successfulRetreat) moveZombies(state.zombies, 'approaching', 'engaged', 1);
    if (state.zombies.engaged > 0) state.rangeBand = 'contact';
  } else {
    moveZombies(state.zombies, 'approaching', 'engaged', 1);
  }

  const risk = responseRisk(state, context, actionId);
  let outcome = 'closing';
  if (state.zombies.engaged > 0) {
    if (roll < risk * 0.28) {
      outcome = 'wounded';
      const severity = roundTo(3 + risk * 7, 1);
      const damage = Math.max(3, Math.round(4 + risk * 9));
      effects.vitalsDelta.health -= damage;
      effects.vitalsDelta.panic += Math.round(8 + risk * 8);
      effects.vitalsDelta.stress += Math.round(4 + risk * 5);
      state.player.balance -= 35;
      state.player.grabbedBy = Math.min(state.zombies.engaged, state.player.grabbedBy + 1);
      state.player.aimFocus = 0;
      effects.newWounds.push(createZombieWound(state, rng, roll, severity));
    } else if (roll < risk * 0.68) {
      outcome = 'grabbed';
      state.player.grabbedBy = Math.min(state.zombies.engaged, state.player.grabbedBy + 1);
      state.player.balance -= 24;
      state.player.aimFocus = 0;
      effects.vitalsDelta.panic += Math.round(5 + risk * 6);
      effects.vitalsDelta.endurance -= 3;
    } else if (roll < risk) {
      outcome = 'stumbled';
      state.player.balance -= 16;
      state.player.aimFocus = Math.max(0, state.player.aimFocus - 20);
      effects.vitalsDelta.health -= Math.max(1, Math.round(risk * 3));
      effects.vitalsDelta.panic += 3;
    } else {
      outcome = 'evaded';
      state.player.balance -= 7;
      addSkillXp(effects, 'nimble', 1);
    }
  }

  effects.threatDelta += state.zombies.engaged > 0 ? 1 : 0;
  return {
    type: 'zombie_response',
    turn: state.turn,
    outcome,
    risk: roundTo(risk, 4),
    engaged: state.zombies.engaged,
    grabbedBy: state.player.grabbedBy,
  };
}

function actionAvailability(state, context, request) {
  const actionId = request.actionId;
  if (isTacticalEncounterTerminal(state)) return disabled('encounter_terminal');
  const inventory = contextInventory(context);
  const weaponStackId = runtimeId(request.weaponStackId)
    || state.selectedWeaponStackId
    || runtimeId(context?.equippedWeaponStackId);
  const weapon = weaponStackId
    ? inventory.find((entry) => entry?.stackId === weaponStackId && itemCount(entry) > 0)
    : null;
  const strenuous = ['push', 'melee', 'stomp', 'step_back'].includes(actionId);
  if (strenuous && vital(context, 'endurance', 100) <= 2) return disabled('too_exhausted', weapon);

  switch (actionId) {
    case 'push':
      if (state.zombies.engaged <= 0 && state.player.grabbedBy <= 0) return disabled('no_contact_target');
      return enabled(null);
    case 'melee':
      if (!weapon) return disabled('weapon_missing');
      if (isWeaponBroken(weapon)) return disabled('weapon_broken', weapon);
      if (!isMeleeWeapon(weapon)) return disabled('requires_melee_weapon', weapon);
      if (state.rangeBand === 'far' || state.zombies.engaged + state.zombies.approaching <= 0) {
        return disabled('no_reachable_target', weapon);
      }
      return enabled(weapon);
    case 'stomp':
      if (state.player.grabbedBy > 0) return disabled('currently_grabbed');
      if (state.zombies.downed <= 0) return disabled('no_downed_target');
      return enabled(null);
    case 'step_back':
      if (state.player.grabbedBy > 0) return disabled('currently_grabbed');
      if (state.rangeBand === 'far' && state.escapeProgress >= 100) {
        return disabled('escape_ready');
      }
      return enabled(null);
    case 'aim':
      return firearmAvailability(state, weapon, { requireLoaded: false });
    case 'reload':
      return reloadAvailability(state, context, request, weapon);
    case 'fire':
      return firearmAvailability(state, weapon, { requireLoaded: true, context });
    case 'disengage':
      if (state.player.grabbedBy > 0) return disabled('currently_grabbed');
      if (state.rangeBand !== 'far'
        && (state.zombies.engaged > 0 || state.zombies.approaching > 0)) {
        return disabled('need_more_distance');
      }
      if (state.escapeProgress < 40
        && (state.zombies.engaged > 0 || state.zombies.approaching > 0)) {
        return disabled('escape_not_prepared');
      }
      return enabled(null);
    case 'brace':
      return enabled(null);
    default:
      return disabled('invalid_action');
  }
}

function firearmAvailability(state, weapon, { requireLoaded, context = {} }) {
  if (!weapon) return disabled('weapon_missing');
  if (!isFirearm(weapon)) return disabled('requires_firearm', weapon);
  if (isWeaponBroken(weapon)) return disabled('weapon_broken', weapon);
  if (state.player.grabbedBy > 0) return disabled('currently_grabbed', weapon);
  if (standingZombieCount(state.zombies) <= 0) return disabled('no_standing_target', weapon);
  if (requireLoaded && effectiveLoad(state, context, weapon).rounds <= 0) {
    return disabled('firearm_unloaded', weapon);
  }
  return enabled(weapon);
}

function reloadAvailability(state, context, request, weapon) {
  if (!weapon) return disabled('weapon_missing');
  if (!isFirearm(weapon)) return disabled('requires_firearm', weapon);
  if (isWeaponBroken(weapon)) return disabled('weapon_broken', weapon);
  if (state.player.grabbedBy > 0) return disabled('currently_grabbed', weapon);
  const profile = firearmProfile(weapon);
  const load = effectiveLoad(state, context, weapon);
  if (load.rounds >= profile.capacity) return disabled('firearm_full', weapon);
  const inventory = contextInventory(context);
  const exactAmmoStackId = runtimeId(request.ammoStackId);
  const ammo = exactAmmoStackId
    ? inventory.find((entry) => entry?.stackId === exactAmmoStackId && itemCount(entry) > 0)
    : inventory.find((entry) => (
        runtimeId(entry?.stackId) && itemCount(entry) > 0 && ammoMatchesWeapon(entry, weapon)
      ));
  if (!ammo || !ammoMatchesWeapon(ammo, weapon)) return disabled('no_matching_ammo', weapon);
  if (load.rounds > 0 && load.ammoItemId && load.ammoItemId !== ammo.id) {
    return disabled('mixed_ammo_type', weapon);
  }
  return { enabled: true, reason: null, weapon, ammo };
}

function responseRisk(state, context, actionId = 'brace') {
  const vitals = isRecord(context?.vitals) ? context.vitals : {};
  const body = isRecord(context?.body) ? context.body : {};
  const wounds = Array.isArray(body.wounds)
    ? body.wounds
    : Array.isArray(body.injuries) ? body.injuries : [];
  const woundPressure = wounds.reduce((total, wound) => {
    const severity = boundedNumber(wound?.severity ?? wound?.pain, 0, 10, 1);
    return total + severity * 0.006 + (wound?.bleeding ? 0.025 : 0);
  }, 0);
  const capacity = Math.max(1, boundedNumber(context?.capacity, 1, 1_000_000, 1));
  const usedSpace = boundedNumber(context?.usedSpace, 0, 1_000_000, 0);
  const loadRatio = usedSpace / capacity;
  const encumbrance = Math.max(0, loadRatio - 0.65) * 0.22 + (loadRatio > 1 ? 0.12 : 0);
  const weatherRisk = context?.world?.isNight ? 0.035 : 0;
  const threatRisk = boundedNumber(context?.world?.threat, 0, 100, 0) * 0.003;
  const definition = ACTION_DEFINITIONS[actionId] ?? ACTION_DEFINITIONS.brace;
  const base = 0.07
    + state.zombies.engaged * 0.105
    + state.zombies.approaching * 0.018
    + state.player.grabbedBy * 0.15
    + boundedNumber(vitals.fatigue, 0, 100, 0) * 0.0024
    + boundedNumber(vitals.panic, 0, 100, 0) * 0.002
    + (100 - boundedNumber(vitals.endurance, 0, 100, 100)) * 0.0015
    + boundedNumber(body.pain, 0, 100, 0) * 0.0014
    + Math.min(0.24, woundPressure)
    + Math.min(0.3, encumbrance)
    + weatherRisk
    + threatRisk
    + (100 - state.player.balance) * 0.0014
    - skill(context, 'nimble') * 0.012
    - skill(context, 'fitness') * 0.009
    + (state.rangeBand === 'far' ? -0.18 : state.rangeBand === 'near' ? -0.07 : 0);
  return clamp(base * definition.riskMultiplier, 0.02, 0.98);
}

function effectiveLoad(state, context, weapon) {
  const stateLoad = state.player?.loadedByWeapon?.[weapon.stackId];
  const contextLoad = context?.firearmLoads?.[weapon.stackId]
    ?? context?.loadedByWeapon?.[weapon.stackId];
  const normalized = normalizeOneLoad(stateLoad ?? contextLoad);
  const profile = firearmProfile(weapon);
  if (!normalized) {
    return { ammoItemId: profile.ammoItemId, ammoStackId: null, rounds: 0 };
  }
  return {
    ammoItemId: normalized.ammoItemId || profile.ammoItemId,
    ammoStackId: normalized.ammoStackId,
    rounds: Math.min(profile.capacity, normalized.rounds),
  };
}

function firearmProfile(weapon) {
  const catalogProfile = FIREARM_PROFILES[weapon?.id];
  if (catalogProfile) return catalogProfile;
  const ammoItemId = runtimeId(weapon?.effects?.ammoItemId ?? weapon?.ammoItemId)
    || DEFAULT_FIREARM_PROFILE.ammoItemId;
  const ammoTag = runtimeId(weapon?.effects?.ammo ?? weapon?.ammoTag)
    || (ammoItemId === 'shotgun_shells' ? 'shotgun' : DEFAULT_FIREARM_PROFILE.ammoTag);
  return {
    ...DEFAULT_FIREARM_PROFILE,
    ammoItemId,
    ammoTag,
    capacity: boundedInteger(
      weapon?.effects?.capacity ?? weapon?.capacity,
      1,
      100,
      DEFAULT_FIREARM_PROFILE.capacity,
    ),
  };
}

function ammoMatchesWeapon(ammo, weapon) {
  if (!ammo || itemCount(ammo) <= 0) return false;
  const isAmmo = ammo.category === 'ammo'
    || hasTag(ammo, 'ammo')
    || Boolean(runtimeId(ammo.effects?.ammo));
  if (!isAmmo) return false;
  const profile = firearmProfile(weapon);
  return ammo.id === profile.ammoItemId
    || runtimeId(ammo.effects?.ammo) === profile.ammoTag
    || hasTag(ammo, profile.ammoTag);
}

function createInitialBuckets(count, rangeBand) {
  if (count <= 0) return { distant: 0, approaching: 0, engaged: 0, downed: 0 };
  if (rangeBand === 'far') return { distant: count, approaching: 0, engaged: 0, downed: 0 };
  const engaged = rangeBand === 'contact'
    ? Math.min(count, Math.max(1, Math.ceil(count * 0.45)))
    : Math.min(count, Math.max(1, Math.ceil(count * 0.25)));
  const approaching = Math.min(count - engaged, Math.max(0, Math.ceil(count * 0.35)));
  return {
    distant: count - engaged - approaching,
    approaching,
    engaged,
    downed: 0,
  };
}

function normalizeZombieBuckets(rawBuckets, exactTotal) {
  const source = isRecord(rawBuckets) ? rawBuckets : {};
  const buckets = {
    distant: boundedInteger(source.distant, 0, MAX_ZOMBIES, 0),
    approaching: boundedInteger(source.approaching, 0, MAX_ZOMBIES, 0),
    engaged: boundedInteger(source.engaged, 0, MAX_ZOMBIES, 0),
    downed: boundedInteger(source.downed, 0, MAX_ZOMBIES, 0),
  };
  const target = exactTotal === undefined
    ? Math.min(MAX_ZOMBIES, zombieBucketTotal(buckets))
    : boundedInteger(exactTotal, 0, MAX_ZOMBIES, 0);
  let total = zombieBucketTotal(buckets);

  if (total > target) {
    let excess = total - target;
    for (const key of ['distant', 'approaching', 'downed', 'engaged']) {
      const removed = Math.min(buckets[key], excess);
      buckets[key] -= removed;
      excess -= removed;
      if (excess <= 0) break;
    }
  } else if (total < target) {
    buckets.distant += target - total;
  }
  total = zombieBucketTotal(buckets);
  if (total > MAX_ZOMBIES) buckets.distant = Math.max(0, buckets.distant - (total - MAX_ZOMBIES));
  return buckets;
}

function normalizeLoadedByWeapon(rawLoads) {
  const source = isRecord(rawLoads) ? rawLoads : {};
  const normalized = {};
  for (const [rawStackId, rawLoad] of Object.entries(source)) {
    const stackId = runtimeId(rawStackId);
    const load = normalizeOneLoad(rawLoad);
    if (!stackId || !load) continue;
    normalized[stackId] = load;
  }
  return normalized;
}

function normalizeOneLoad(rawLoad) {
  if (!isRecord(rawLoad)) return null;
  const ammoItemId = runtimeId(rawLoad.ammoItemId ?? rawLoad.ammoId);
  const ammoStackId = runtimeId(rawLoad.ammoStackId);
  if (!ammoItemId) return null;
  const legacyCapacity = finiteNumber(rawLoad.capacity);
  const maximum = legacyCapacity === null
    ? 100
    : boundedInteger(legacyCapacity, 0, 100, 100);
  return {
    ammoItemId,
    ammoStackId: ammoStackId || null,
    rounds: boundedInteger(rawLoad.rounds ?? rawLoad.loaded, 0, maximum, 0),
  };
}

function createZeroEffects() {
  return {
    durationMinutes: 0,
    zombieKills: 0,
    ammoConsumption: [],
    weaponUses: [],
    vitalsDelta: Object.fromEntries(VITAL_KEYS.map((key) => [key, 0])),
    newWounds: [],
    noiseDelta: 0,
    threatDelta: 0,
    skillXp: {},
    evasionMinutes: 0,
    firearmLoads: {},
  };
}

function normalizeEffects(effects) {
  const normalized = cloneValue(effects);
  normalized.durationMinutes = boundedInteger(normalized.durationMinutes, 0, 120, 0);
  normalized.zombieKills = boundedInteger(normalized.zombieKills, 0, MAX_ZOMBIES, 0);
  normalized.noiseDelta = roundTo(boundedNumber(normalized.noiseDelta, -1_000, 1_000, 0), 2);
  normalized.threatDelta = roundTo(boundedNumber(normalized.threatDelta, -1_000, 1_000, 0), 2);
  normalized.evasionMinutes = boundedInteger(normalized.evasionMinutes, 0, MAX_MINUTES, 0);
  for (const key of VITAL_KEYS) {
    normalized.vitalsDelta[key] = roundTo(
      boundedNumber(normalized.vitalsDelta[key], -1_000, 1_000, 0),
      2,
    );
  }
  for (const [skillId, amount] of Object.entries(normalized.skillXp)) {
    normalized.skillXp[skillId] = roundTo(boundedNumber(amount, 0, 10_000, 0), 2);
  }
  return normalized;
}

function failureResult(reason, nextState, effects) {
  return {
    ok: false,
    reason,
    nextState,
    effects,
    events: [],
  };
}

function createPlayerActionEvent(turn, actionId, weapon, outcome, effects) {
  return {
    type: 'player_action',
    turn,
    actionId,
    weaponStackId: weapon?.stackId ?? null,
    weaponName: runtimeId(weapon?.name ?? weapon?.canonicalName ?? weapon?.id) || null,
    success: Boolean(outcome.success),
    zombieKills: effects.zombieKills,
    durationMinutes: outcome.durationMinutes,
  };
}

function createZombieWound(state, rng, roll, severity) {
  const parts = ['left_arm', 'right_arm', 'left_hand', 'right_hand', 'torso', 'left_leg', 'right_leg'];
  const bodyPart = parts[Math.min(parts.length - 1, Math.floor(roll * parts.length))];
  const type = severity >= 8 ? 'bite' : severity >= 5 ? 'laceration' : 'scratch';
  return {
    id: `wound:${state.id}:${state.turn}:${rng.cursor}`,
    bodyPart,
    type,
    severity,
    bleeding: true,
    bandaged: false,
    dirtyBandage: false,
    bandageAgeHours: 0,
    disinfected: false,
    infected: false,
    knoxInfection: type === 'bite',
    ageHours: 0,
    source: 'zombie',
  };
}

function summaryPresentation(status, pressure) {
  if (status === 'cleared') return { label: '威胁清除', tone: 'success' };
  if (status === 'escaped') return { label: '已脱离尸群', tone: 'info' };
  if (status === 'dead') return { label: '幸存者倒下', tone: 'danger' };
  if (status === 'aborted') return { label: '生存期限结束', tone: 'danger' };
  const labels = {
    low: '保持距离',
    moderate: '尸群正在逼近',
    high: '近身威胁',
    critical: '致命缠斗',
  };
  const tones = { low: 'neutral', moderate: 'warning', high: 'danger', critical: 'critical' };
  return { label: labels[pressure], tone: tones[pressure] };
}

function enabled(weapon) {
  return { enabled: true, reason: null, weapon };
}

function disabled(reason, weapon = null) {
  return { enabled: false, reason, weapon };
}

function contextInventory(context) {
  if (Array.isArray(context?.inventory)) return context.inventory;
  if (Array.isArray(context?.carry)) return context.carry;
  if (Array.isArray(context?.carry?.items)) return context.carry.items;
  return [];
}

function isFirearm(item) {
  return hasTag(item, 'firearm');
}

function isMeleeWeapon(item) {
  return hasTag(item, 'weapon') && !isFirearm(item);
}

function isWeaponBroken(item) {
  const condition = isRecord(item?.conditionState?.condition)
    ? item.conditionState.condition
    : isRecord(item?.condition) ? item.condition : null;
  if (condition) {
    if (condition.broken === true) return true;
    const current = finiteNumber(condition.current);
    if (current !== null && current <= 0) return true;
  }
  const numericCondition = finiteNumber(item?.condition);
  if (numericCondition !== null && numericCondition <= 0) return true;
  const durability = finiteNumber(item?.durability);
  return item?.broken === true || (durability !== null && durability <= 0);
}

function weaponSkillId(weapon) {
  const explicit = runtimeId(weapon?.effects?.skill);
  if (explicit) return explicit;
  if (isFirearm(weapon)) return 'aiming';
  const known = ['axe', 'long_blunt', 'short_blunt', 'long_blade', 'short_blade', 'spear'];
  return known.find((tag) => hasTag(weapon, tag)) ?? 'short_blunt';
}

function skill(context, skillId) {
  const raw = context?.skills?.[skillId];
  const value = isRecord(raw) ? raw.level : raw;
  return boundedNumber(value, 0, 10, 0);
}

function vital(context, key, fallback) {
  return boundedNumber(context?.vitals?.[key], 0, 100, fallback);
}

function addSkillXp(effects, skillId, amount) {
  if (!skillId || amount <= 0) return;
  effects.skillXp[skillId] = (effects.skillXp[skillId] ?? 0) + amount;
}

function standingZombieCount(zombies) {
  return zombies.distant + zombies.approaching + zombies.engaged;
}

function zombieBucketTotal(zombies) {
  return zombies.distant + zombies.approaching + zombies.engaged + zombies.downed;
}

function removeZombie(zombies, order) {
  for (const bucket of order) {
    if (zombies[bucket] > 0) {
      zombies[bucket] -= 1;
      return 1;
    }
  }
  return 0;
}

function knockDownZombie(zombies, order) {
  for (const bucket of order) {
    if (zombies[bucket] > 0) {
      zombies[bucket] -= 1;
      zombies.downed += 1;
      return true;
    }
  }
  return false;
}

function moveZombies(zombies, from, to, requestedCount) {
  const count = Math.min(
    zombies[from],
    boundedInteger(requestedCount, 0, MAX_ZOMBIES, 0),
  );
  zombies[from] -= count;
  zombies[to] += count;
  return count;
}

function draw(rng, salt) {
  const cursor = boundedInteger(rng.cursor, 0, MAX_RNG_CURSOR, 0);
  const value = hash32(`${normalizeSeed(rng.seed, 0)}|${cursor}|${salt}`) / UINT32_RANGE;
  rng.cursor = Math.min(MAX_RNG_CURSOR, cursor + 1);
  return value;
}

function hash32(text) {
  let hash = 0x811c9dc5;
  const normalized = String(text);
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function normalizeSeed(value, fallback) {
  const number = finiteNumber(value);
  if (number === null) return Math.abs(Math.trunc(fallback)) >>> 0;
  return Math.abs(Math.trunc(number)) >>> 0;
}

function runtimeId(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().slice(0, 160);
  if (['__proto__', 'constructor', 'prototype'].includes(normalized)) return '';
  return normalized;
}

function itemCount(item) {
  return boundedInteger(item?.count, 0, 1_000_000, 0);
}

function hasTag(item, tag) {
  return Array.isArray(item?.tags) && item.tags.includes(tag);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = finiteNumber(value);
  return Math.max(minimum, Math.min(maximum, number === null ? fallback : Math.trunc(number)));
}

function boundedNumber(value, minimum, maximum, fallback) {
  const number = finiteNumber(value);
  return Math.max(minimum, Math.min(maximum, number === null ? fallback : number));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundTo(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  }
  return value;
}

function jsonSafeClone(value) {
  if (Array.isArray(value)) return value.map((entry) => jsonSafeClone(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined && typeof entry !== 'function')
      .map(([key, entry]) => [key, jsonSafeClone(entry)]));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  return null;
}
