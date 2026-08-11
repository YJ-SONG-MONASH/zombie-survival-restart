const MINUTES_PER_DAY = 24 * 60;
const START_MINUTE = 8 * 60;
const DIRTY_BANDAGE_HOURS = 8;

export const weatherDefinitions = [
  { id: 'clear', label: '晴朗', icon: '☀', temperatureC: 22, searchMod: 4, combatMod: 2, noiseCover: 0 },
  { id: 'overcast', label: '阴天', icon: '☁', temperatureC: 17, searchMod: 1, combatMod: 0, noiseCover: 2 },
  { id: 'rain', label: '降雨', icon: '☂', temperatureC: 13, searchMod: -2, combatMod: -3, noiseCover: 8 },
  { id: 'fog', label: '浓雾', icon: '≋', temperatureC: 11, searchMod: -5, combatMod: -5, noiseCover: 5 },
  { id: 'storm', label: '雷暴', icon: 'ϟ', temperatureC: 10, searchMod: -7, combatMod: -6, noiseCover: 14 },
  { id: 'cold_snap', label: '寒潮', icon: '❄', temperatureC: 4, searchMod: -4, combatMod: -3, noiseCover: 1 },
];

export const bodyPartLabels = {
  head: '头部',
  torso: '躯干',
  left_arm: '左臂',
  right_arm: '右臂',
  left_hand: '左手',
  right_hand: '右手',
  left_leg: '左腿',
  right_leg: '右腿',
};

export const woundTypeLabels = {
  scratch: '抓伤',
  laceration: '撕裂伤',
  bite: '咬伤',
  blunt: '钝挫伤',
};

const actionMinutes = {
  search: 180,
  scout: 120,
  rest: 240,
  sleep: 480,
  vehicle: 180,
  forage: 150,
  fortify: 240,
  combat_melee: 90,
  combat_firearm: 60,
  evade: 75,
  treat: 45,
  craft: 120,
};

const meleePowerById = {
  fire_axe: 18,
  machete: 17,
  spiked_baseball_bat: 16,
  crowbar: 14,
  baseball_bat: 13,
  hand_axe: 12,
  crafted_spear: 12,
  hunting_knife: 10,
  hammer: 9,
  pipe_wrench: 9,
  wrench: 8,
  kitchen_knife: 7,
};

const firearmPowerById = {
  shotgun: 23,
  m9_pistol: 16,
  m36_revolver: 15,
};

export function createWorldState({ day = 1, spawnId = 'muldraugh', nodeDanger = 3, shelterDefense = 0 } = {}) {
  const seed = hashSeed(spawnId);
  const weather = weatherForDay(day, seed);
  return {
    seed,
    weatherId: weather.id,
    temperatureC: weather.temperatureC,
    powerShutoffDay: 8 + (seed % 6),
    waterShutoffDay: 6 + (seed % 6),
    powerOn: true,
    waterOn: true,
    noise: 4,
    threat: clamp(nodeDanger * 11 - shelterDefense * 2, 8, 92),
    lastNotice: '紧急广播仍在重复疏散指令。',
  };
}

export function createBodyState() {
  return {
    wounds: [],
    infectionLevel: 0,
    pain: 0,
    wetness: 0,
  };
}

export function createBaseState(shelter = null) {
  return {
    defense: Math.max(0, Number(shelter?.defense) || 0),
    barricades: 0,
    generatorFuel: 0,
    generatorOn: false,
    waterReserve: 0,
  };
}

export function createSurvivalStats() {
  return {
    actions: 0,
    hoursSurvived: 0,
    zombiesKilled: 0,
    crafted: 0,
    distanceTravelled: 0,
  };
}

export function normalizeWorldState(world, fallback = {}) {
  const base = createWorldState(fallback);
  const next = { ...base, ...(world && typeof world === 'object' ? world : {}) };
  next.seed = finiteInteger(next.seed, base.seed, 0);
  next.powerShutoffDay = finiteInteger(next.powerShutoffDay, base.powerShutoffDay, 1);
  next.waterShutoffDay = finiteInteger(next.waterShutoffDay, base.waterShutoffDay, 1);
  next.noise = clampNumber(next.noise, base.noise, 0, 100);
  next.threat = clampNumber(next.threat, base.threat, 0, 100);
  const weather = weatherDefinitions.find((entry) => entry.id === next.weatherId) ?? weatherForDay(fallback.day ?? 1, next.seed);
  next.weatherId = weather.id;
  next.temperatureC = clampNumber(next.temperatureC, weather.temperatureC, -30, 50);
  next.powerOn = Boolean(next.powerOn);
  next.waterOn = Boolean(next.waterOn);
  next.lastNotice = typeof next.lastNotice === 'string' ? next.lastNotice.slice(0, 240) : base.lastNotice;
  return next;
}

export function normalizeBodyState(body) {
  const source = body && typeof body === 'object' ? body : {};
  return {
    wounds: Array.isArray(source.wounds) ? source.wounds.map(normalizeWound).filter(Boolean).slice(0, 12) : [],
    infectionLevel: clampNumber(source.infectionLevel, 0, 0, 100),
    pain: clampNumber(source.pain, 0, 0, 100),
    wetness: clampNumber(source.wetness, 0, 0, 100),
  };
}

export function normalizeBaseState(base, shelter = null) {
  const fallback = createBaseState(shelter);
  const source = base && typeof base === 'object' ? base : {};
  return {
    defense: clampNumber(source.defense, fallback.defense, 0, 20),
    barricades: finiteInteger(source.barricades, 0, 0, 20),
    generatorFuel: finiteInteger(source.generatorFuel, 0, 0, 20),
    generatorOn: Boolean(source.generatorOn) && finiteInteger(source.generatorFuel, 0, 0) > 0,
    waterReserve: finiteInteger(source.waterReserve, 0, 0, 30),
  };
}

export function normalizeSurvivalStats(stats) {
  const source = stats && typeof stats === 'object' ? stats : {};
  return Object.fromEntries(
    Object.keys(createSurvivalStats()).map((key) => [key, clampNumber(source[key], 0, 0, 999999)])
  );
}

export function formatClock(minutes = START_MINUTE) {
  const normalized = ((finiteInteger(minutes, START_MINUTE) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function weatherForDay(day = 1, seed = 0) {
  const cycle = ['overcast', 'clear', 'rain', 'overcast', 'fog', 'clear', 'storm', 'overcast', 'cold_snap', 'clear'];
  const id = cycle[Math.abs((finiteInteger(day, 1) * 3 + finiteInteger(seed, 0)) % cycle.length)];
  const weather = weatherDefinitions.find((entry) => entry.id === id) ?? weatherDefinitions[0];
  const temperatureShift = ((finiteInteger(day, 1) + finiteInteger(seed, 0)) % 5) - 2;
  return { ...weather, temperatureC: weather.temperatureC + temperatureShift };
}

export function durationForAction(actionId, { vehicle = null } = {}) {
  if (actionId === 'move') {
    if (vehicle?.status === 'working' && (vehicle.fuel ?? 0) > 0) return 60;
    if (vehicle?.status === 'damaged' && (vehicle.fuel ?? 0) > 0) return 90;
    return 180;
  }
  return actionMinutes[actionId] ?? 120;
}

export function advanceSurvivalState({
  day = 1,
  clockMinutes = START_MINUTE,
  minutes = 0,
  vitals = {},
  world = null,
  body = null,
  base = null,
  traits = [],
  nodeDanger = 3,
  atHome = false,
  mode = 'active',
  noiseDelta = 0,
  threatDelta = 0,
} = {}) {
  const elapsedMinutes = clampNumber(minutes, 0, 0, MINUTES_PER_DAY * 3);
  const elapsedHours = elapsedMinutes / 60;
  const totalMinutes = finiteInteger(clockMinutes, START_MINUTE, 0) + elapsedMinutes;
  const daysElapsed = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const nextDay = Math.max(1, finiteInteger(day, 1, 1) + daysElapsed);
  const nextClock = Math.round(totalMinutes % MINUTES_PER_DAY);
  const nextWorld = normalizeWorldState(world, { day, nodeDanger });
  const nextBody = normalizeBodyState(body);
  const nextBase = normalizeBaseState(base);
  const nextVitals = normalizeVitals(vitals);
  const traitIds = new Set((traits ?? []).map((trait) => typeof trait === 'string' ? trait : trait?.id).filter(Boolean));
  const notices = [];
  const isSleep = mode === 'sleep';
  const isRest = mode === 'rest' || isSleep;

  const hungerRate = (traitIds.has('light_eater') ? 0.75 : traitIds.has('hearty_appetite') ? 1.65 : 1.2) * (isSleep ? 0.72 : 1);
  const thirstRate = (traitIds.has('low_thirst') ? 0.95 : traitIds.has('high_thirst') ? 2.45 : 1.75) * (isSleep ? 0.78 : 1);
  const fatigueRate = traitIds.has('wakeful') ? 0.9 : traitIds.has('sleepyhead') ? 1.8 : 1.35;
  nextVitals.hunger += hungerRate * elapsedHours;
  nextVitals.thirst += thirstRate * elapsedHours;
  if (isSleep) {
    nextVitals.fatigue -= (traitIds.has('restless_sleeper') ? 6.2 : 8.5) * elapsedHours;
    nextVitals.endurance += 7 * elapsedHours;
    nextVitals.panic -= 2.2 * elapsedHours;
    nextVitals.stress -= 1.8 * elapsedHours;
  } else if (isRest) {
    nextVitals.fatigue -= 4.2 * elapsedHours;
    nextVitals.endurance += 5 * elapsedHours;
    nextVitals.panic -= 1.6 * elapsedHours;
    nextVitals.stress -= 1.2 * elapsedHours;
  } else {
    nextVitals.fatigue += fatigueRate * elapsedHours;
    nextVitals.endurance += 0.8 * elapsedHours;
  }

  if (nextVitals.hunger >= 85) nextVitals.health -= (nextVitals.hunger - 80) * 0.025 * elapsedHours;
  if (nextVitals.thirst >= 85) nextVitals.health -= (nextVitals.thirst - 80) * 0.045 * elapsedHours;
  if (nextVitals.fatigue >= 90 && !isRest) nextVitals.health -= 0.8 * elapsedHours;

  const startingNoise = clamp(nextWorld.noise + Number(noiseDelta || 0), 0, 100);
  nextWorld.noise = clamp(startingNoise - elapsedHours * (isSleep ? 4.2 : 2.8), 0, 100);
  const ambientThreat = clamp(Number(nodeDanger || 3) * 12, 8, 90);
  const attraction = startingNoise * 0.08 + Number(threatDelta || 0);
  const safetyDrain = elapsedHours * (atHome ? 1.2 + nextBase.defense * 0.22 : 0.75);
  nextWorld.threat = clamp(nextWorld.threat + attraction + (ambientThreat - nextWorld.threat) * 0.08 - safetyDrain, 0, 100);

  progressWounds(nextBody, nextVitals, elapsedHours, traitIds);

  const nextWeather = weatherForDay(nextDay, nextWorld.seed);
  const previousWeatherId = nextWorld.weatherId;
  nextWorld.weatherId = nextWeather.id;
  nextWorld.temperatureC = nextWeather.temperatureC;
  if (['rain', 'storm'].includes(nextWeather.id) && !atHome && !isRest) {
    nextBody.wetness = clamp(nextBody.wetness + elapsedHours * 9, 0, 100);
  } else {
    nextBody.wetness = clamp(nextBody.wetness - elapsedHours * (atHome ? 8 : 3), 0, 100);
  }
  if (nextBody.wetness > 55 && nextWorld.temperatureC < 10) {
    nextVitals.stress += elapsedHours * 1.2;
    nextVitals.health -= elapsedHours * 0.45;
  }

  for (let offset = 1; offset <= daysElapsed; offset += 1) {
    const crossedDay = finiteInteger(day, 1, 1) + offset;
    if (crossedDay === nextWorld.waterShutoffDay) notices.push('市政供水停止：水龙头只剩管道里的残水。');
    if (crossedDay === nextWorld.powerShutoffDay) notices.push('电网彻底熄灭：冰箱、照明和警报都停了。');
    if (crossedDay === 9) {
      nextWorld.threat = clamp(nextWorld.threat + 26, 0, 100);
      nextWorld.noise = clamp(nextWorld.noise + 18, 0, 100);
      notices.push('直升机在低空盘旋，整片区域的尸群开始迁移。');
    }
    if (crossedDay === 15) {
      nextWorld.threat = clamp(nextWorld.threat + 14, 0, 100);
      notices.push('远处的大尸群沿公路南下，安全路线正在变窄。');
    }
    if (nextBase.generatorOn) {
      nextBase.generatorFuel = Math.max(0, nextBase.generatorFuel - 1);
      if (nextBase.generatorFuel === 0) {
        nextBase.generatorOn = false;
        notices.push('发电机耗尽燃料并停机。');
      }
    }
    const dailyWeather = weatherForDay(crossedDay, nextWorld.seed);
    if (atHome && ['rain', 'storm'].includes(dailyWeather.id)) {
      nextBase.waterReserve = clamp(nextBase.waterReserve + 2, 0, 30);
      notices.push('据点容器接到了两份雨水。');
    }
  }

  nextWorld.powerOn = nextDay < nextWorld.powerShutoffDay || (nextBase.generatorOn && nextBase.generatorFuel > 0);
  nextWorld.waterOn = nextDay < nextWorld.waterShutoffDay;
  if (daysElapsed > 0 && previousWeatherId !== nextWeather.id) notices.push(`天气转为${nextWeather.label}，气温约 ${nextWeather.temperatureC}°C。`);
  if (isSleep && atHome && nextWorld.threat > 78 && nextBase.defense < 4) {
    nextVitals.panic += 14;
    nextVitals.stress += 10;
    nextWorld.threat = clamp(nextWorld.threat + 4, 0, 100);
    notices.push('睡梦中有尸体撞上据点外墙，薄弱的防线让你惊醒。');
  }

  clampVitalsInPlace(nextVitals);
  nextBody.pain = clamp(
    nextBody.wounds.reduce((sum, wound) => sum + wound.severity * (wound.bandaged ? 4 : 7), 0),
    0,
    100
  );
  nextWorld.lastNotice = notices[notices.length - 1] ?? nextWorld.lastNotice;

  return {
    day: nextDay,
    clockMinutes: nextClock,
    daysElapsed,
    elapsedHours,
    vitals: nextVitals,
    world: nextWorld,
    body: nextBody,
    base: nextBase,
    notices,
  };
}

export function resolveCombatEncounter({
  approach,
  node,
  day = 1,
  clockMinutes = START_MINUTE,
  inventory = [],
  skills = {},
  traits = [],
  vitals = {},
  world = {},
  equippedWeaponId = null,
  zombiePopulation = null,
  rng = Math.random,
} = {}) {
  const danger = clampNumber(node?.danger, 3, 1, 8);
  const traitIds = new Set((traits ?? []).map((trait) => trait?.id ?? trait).filter(Boolean));
  const roll = clampNumber(rng(), 0.5, 0, 0.999999);
  const fatiguePenalty = (Number(vitals.fatigue) || 0) * 0.12;
  const panicPenalty = (Number(vitals.panic) || 0) * 0.1;
  const nightPenalty = isNight(clockMinutes) ? 9 : 0;
  const weather = weatherDefinitions.find((entry) => entry.id === world?.weatherId) ?? weatherDefinitions[0];
  const threatPenalty = (Number(world?.threat) || danger * 10) * 0.12;
  const availableZombies = zombiePopulation !== null && zombiePopulation !== undefined && Number.isFinite(Number(zombiePopulation))
    ? finiteInteger(zombiePopulation, 0, 0, 120)
    : null;

  if (availableZombies === 0) {
    return {
      ok: false,
      title: '地区已经清空',
      score: 0,
      kills: 0,
      consume: [],
      wounds: [],
      noiseDelta: 0,
      threatDelta: 0,
      minutes: 0,
      mode: 'active',
      vitals: {},
      result: `${node?.name ?? '这个地区'}暂时没有需要处理的游荡者。`,
      notes: '没有有效目标',
    };
  }

  if (approach === 'evade') {
    const score = clamp(
      52 + (skills.sneaking ?? 0) * 7 + (skills.lightfooted ?? 0) * 4 + (skills.fitness ?? 5) * 2 +
      (traitIds.has('inconspicuous') ? 10 : 0) + (traitIds.has('graceful') ? 7 : 0) + weather.noiseCover -
      danger * 6 - fatiguePenalty - nightPenalty + roll * 20,
      5,
      98
    );
    const wound = score < 34 ? createWound({ danger, score, day, clockMinutes, source: '撤离时被尸群抓住', rng }) : null;
    return {
      ok: true,
      title: '潜行脱离',
      score,
      kills: 0,
      consume: [],
      wounds: wound ? [wound] : [],
      noiseDelta: score >= 55 ? -8 : 8,
      threatDelta: score >= 55 ? -10 : 6,
      minutes: durationForAction('evade'),
      mode: 'active',
      vitals: {
        health: wound ? -4 : 0,
        endurance: score >= 55 ? -10 : -22,
        hunger: 2,
        thirst: 4,
        fatigue: 3,
        panic: score >= 55 ? -5 : 12,
        stress: score >= 55 ? -3 : 8,
      },
      result: score >= 55
        ? `你贴着${node?.name ?? '街区'}的遮蔽物绕开尸群，没有把整条街拖在身后。`
        : `撤离路线被游荡者截断，你勉强退回掩体，尸群仍然封住出口。`,
      notes: score >= 55 ? '保持安静 / 尸群压力下降' : '绕行失败 / 体力消耗严重',
    };
  }

  const firearm = approach === 'combat_firearm';
  const weapon = firearm ? selectFirearmWithAmmo(inventory, equippedWeaponId) : selectWeapon(inventory, equippedWeaponId, false);
  const ammoId = weapon?.id === 'shotgun' ? 'shotgun_shells' : '9mm_rounds';
  const ammo = inventory.find((item) => item.id === ammoId && item.count > 0);
  if (firearm && (!weapon || !ammo)) {
    return {
      ok: false,
      title: '枪械无法使用',
      score: 0,
      kills: 0,
      consume: [],
      wounds: [],
      noiseDelta: 0,
      threatDelta: 0,
      minutes: 0,
      mode: 'active',
      vitals: {},
      result: '你需要一把可用枪械和对应弹药。',
      notes: '缺少武器或弹药',
    };
  }

  const skillId = weapon?.effects?.skill ?? (firearm ? 'aiming' : 'short_blunt');
  const skill = Number(skills[skillId]) || 0;
  const weaponPower = firearm ? firearmPowerById[weapon?.id] ?? 12 : meleePowerById[weapon?.id] ?? 2;
  const baseScore = firearm
    ? 44 + skill * 7 + (skills.reloading ?? 0) * 2 + weaponPower + weather.combatMod
    : 36 + skill * 7 + (skills.strength ?? 5) * 2.4 + (skills.fitness ?? 5) * 1.2 + weaponPower + weather.combatMod;
  const score = clamp(
    baseScore - danger * (firearm ? 5 : 7) - fatiguePenalty - panicPenalty - threatPenalty - nightPenalty + roll * 22,
    5,
    98
  );
  const potentialKills = firearm
    ? clamp(Math.round(1 + score / 18 + danger / 2), 2, 12)
    : clamp(Math.round(score / 30 + weaponPower / 9), 1, 5);
  const kills = availableZombies === null ? potentialKills : Math.min(potentialKills, availableZombies);
  const injuryThreshold = firearm ? 25 : 47;
  const wound = score < injuryThreshold ? createWound({ danger, score, day, clockMinutes, source: `${node?.name ?? '街区'}战斗`, rng }) : null;
  const weaponName = weapon?.name ?? '赤手空拳';
  const success = score >= 52;

  return {
    ok: true,
    title: firearm ? '枪械突围' : '近战清理',
    score,
    kills,
    consume: firearm ? [ammoId] : [],
    wounds: wound ? [wound] : [],
    noiseDelta: firearm ? 58 : 12,
    threatDelta: firearm ? 30 : success ? -Math.min(16, kills * 3) : 8,
    minutes: durationForAction(firearm ? 'combat_firearm' : 'combat_melee'),
    mode: 'active',
    vitals: {
      health: wound ? -(wound.type === 'bite' ? 14 : 7) : 0,
      endurance: firearm ? -8 : -(14 + danger * 2),
      hunger: firearm ? 1 : 3,
      thirst: firearm ? 2 : 5,
      fatigue: firearm ? 3 : 6,
      panic: success ? (firearm ? 5 : -3) : 14,
      stress: success ? (firearm ? 6 : -2) : 12,
    },
    result: success
      ? `你用${weaponName}在${node?.name ?? '街区'}击倒 ${kills} 具游荡者，${availableZombies !== null && kills >= availableZombies ? '本地尸群暂时被清空。' : '暂时清出一条路线。'}`
      : `你用${weaponName}硬撑着打开缺口，但尸群没有真正散开。`,
    notes: `${weaponName} / 击倒 ${kills} / ${firearm ? '巨响会吸引远处尸群' : wound ? '近战中受伤' : '保持近战节奏'}`,
  };
}

export function createWound({ danger = 3, score = 40, day = 1, clockMinutes = START_MINUTE, source = '尸群接触', rng = Math.random } = {}) {
  const typeRoll = clampNumber(rng(), 0.5, 0, 0.999999);
  const partRoll = clampNumber(rng(), 0.5, 0, 0.999999);
  const parts = ['left_arm', 'right_arm', 'left_hand', 'right_hand', 'left_leg', 'right_leg', 'torso'];
  let type = 'scratch';
  if (danger >= 5 && score < 22 && typeRoll < 0.16) type = 'bite';
  else if (score < 34 || typeRoll < 0.42) type = 'laceration';
  else if (typeRoll > 0.88) type = 'blunt';
  const severity = type === 'bite' ? 5 : type === 'laceration' ? 3 : type === 'blunt' ? 2 : 1;
  const bodyPart = parts[Math.min(parts.length - 1, Math.floor(partRoll * parts.length))];
  return {
    id: `wound-${finiteInteger(day, 1)}-${finiteInteger(clockMinutes, START_MINUTE)}-${bodyPart}-${Math.floor(typeRoll * 10000)}`,
    bodyPart,
    type,
    severity,
    bleeding: type !== 'blunt',
    bandaged: false,
    dirtyBandage: false,
    bandageAgeHours: 0,
    disinfected: false,
    infected: false,
    knoxInfection: type === 'bite',
    ageHours: 0,
    source: String(source).slice(0, 100),
  };
}

export function moodlesFor({ vitals = {}, body = {}, world = {}, usedSpace = 0, maxSpace = 1 } = {}) {
  const moodles = [];
  if ((vitals.hunger ?? 0) >= 75) moodles.push({ id: 'hungry', label: '极度饥饿', tone: 'danger', detail: '力量与恢复正在下降' });
  else if ((vitals.hunger ?? 0) >= 45) moodles.push({ id: 'hungry', label: '饥饿', tone: 'warn', detail: '需要进食' });
  if ((vitals.thirst ?? 0) >= 75) moodles.push({ id: 'thirsty', label: '严重脱水', tone: 'danger', detail: '生命正在流失' });
  else if ((vitals.thirst ?? 0) >= 45) moodles.push({ id: 'thirsty', label: '口渴', tone: 'warn', detail: '需要饮水' });
  if ((vitals.fatigue ?? 0) >= 75) moodles.push({ id: 'tired', label: '精疲力竭', tone: 'danger', detail: '战斗与潜行大幅受限' });
  else if ((vitals.fatigue ?? 0) >= 48) moodles.push({ id: 'tired', label: '疲倦', tone: 'warn', detail: '应该安排休息' });
  if ((body.pain ?? 0) >= 50) moodles.push({ id: 'pain', label: '剧痛', tone: 'danger', detail: '未处理伤口正在恶化' });
  else if ((body.pain ?? 0) > 0) moodles.push({ id: 'pain', label: '疼痛', tone: 'warn', detail: '检查身体状态' });
  if ((body.infectionLevel ?? 0) > 0) moodles.push({ id: 'infection', label: `感染 ${Math.round(body.infectionLevel)}%`, tone: body.infectionLevel >= 60 ? 'danger' : 'warn', detail: '发热与虚弱正在累积' });
  if ((body.wetness ?? 0) >= 50) moodles.push({ id: 'wet', label: '湿透', tone: 'warn', detail: '低温下容易失温' });
  if (maxSpace > 0 && usedSpace > maxSpace) moodles.push({ id: 'encumbered', label: '严重超重', tone: 'danger', detail: '无法继续装载，移动更吃力' });
  else if (maxSpace > 0 && usedSpace / maxSpace >= 0.85) moodles.push({ id: 'encumbered', label: '负重过高', tone: 'warn', detail: '背包接近极限' });
  if ((world.threat ?? 0) >= 75) moodles.push({ id: 'horde', label: '尸群逼近', tone: 'danger', detail: '噪声正在把尸群引来' });
  else if ((world.threat ?? 0) >= 50) moodles.push({ id: 'horde', label: '尸群活跃', tone: 'warn', detail: '行动需要更谨慎' });
  return moodles;
}

function selectWeapon(inventory, equippedWeaponId, firearm) {
  const candidates = (inventory ?? []).filter((item) => item.count > 0 && item.tags?.includes('weapon'));
  const valid = candidates.filter((item) => firearm ? item.tags.includes('firearm') : !item.tags.includes('firearm'));
  const equipped = valid.find((item) => item.id === equippedWeaponId);
  if (equipped) return equipped;
  return [...valid].sort((a, b) => {
    const powers = firearm ? firearmPowerById : meleePowerById;
    return (powers[b.id] ?? 0) - (powers[a.id] ?? 0);
  })[0] ?? null;
}

function selectFirearmWithAmmo(inventory, equippedWeaponId) {
  const ammoCount = (ammoId) => inventory.find((item) => item.id === ammoId)?.count ?? 0;
  const candidates = (inventory ?? []).filter((item) => {
    if (item.count <= 0 || !item.tags?.includes('firearm')) return false;
    return ammoCount(item.id === 'shotgun' ? 'shotgun_shells' : '9mm_rounds') > 0;
  });
  const equipped = candidates.find((item) => item.id === equippedWeaponId);
  if (equipped) return equipped;
  return [...candidates].sort((a, b) => (firearmPowerById[b.id] ?? 0) - (firearmPowerById[a.id] ?? 0))[0] ?? null;
}

function progressWounds(body, vitals, elapsedHours, traitIds) {
  let infectionGain = 0;
  body.wounds = body.wounds
    .map((wound) => {
      const oldAgeHours = wound.ageHours;
      const wasInfected = Boolean(wound.infected);
      const oldBandageAgeHours = wound.bandaged ? wound.bandageAgeHours ?? 0 : 0;
      const wasDirtyBandage = Boolean(wound.bandaged && wound.dirtyBandage);
      const next = {
        ...wound,
        ageHours: oldAgeHours + elapsedHours,
        bandageAgeHours: wound.bandaged ? oldBandageAgeHours + elapsedHours : 0,
      };
      const cleanBandagedHours = wound.bandaged && !wasDirtyBandage
        ? Math.min(elapsedHours, Math.max(0, DIRTY_BANDAGE_HOURS - oldBandageAgeHours))
        : 0;
      if (next.bandaged && (wasDirtyBandage || next.bandageAgeHours >= DIRTY_BANDAGE_HOURS)) next.dirtyBandage = true;
      if (!next.bandaged) next.dirtyBandage = false;
      if (next.bleeding && !next.bandaged) vitals.health -= next.severity * elapsedHours * 0.45;
      const ageThresholdOffset = Math.max(0, 6 - oldAgeHours);
      const unprotectedOffset = !next.bandaged
        ? 0
        : wasDirtyBandage
          ? 0
          : Math.max(0, DIRTY_BANDAGE_HOURS - oldBandageAgeHours);
      const infectionExposureHours = Math.max(0, elapsedHours - Math.max(ageThresholdOffset, unprotectedOffset));
      if (!next.disinfected && infectionExposureHours > 0 && next.type !== 'blunt') next.infected = true;
      if (next.knoxInfection) infectionGain += elapsedHours * (traitIds.has('resilient') ? 1.25 : traitIds.has('prone_to_illness') ? 2.3 : 1.75);
      else if (next.infected) {
        const infectedHours = wasInfected
          ? elapsedHours
          : infectionExposureHours;
        infectionGain += infectedHours * (next.disinfected ? 0.12 : 0.42);
      }
      if (next.bandaged && next.disinfected && !next.knoxInfection) next.severity = Math.max(0, next.severity - cleanBandagedHours * 0.025);
      return next;
    })
    .filter((wound) => wound.severity > 0.08);
  body.infectionLevel = clamp(body.infectionLevel + infectionGain, 0, 100);
  if (body.infectionLevel >= 35) {
    vitals.fatigue += elapsedHours * 1.1;
    vitals.stress += elapsedHours * 0.8;
  }
  if (body.infectionLevel >= 65) vitals.health -= elapsedHours * 1.7;
  if (body.infectionLevel >= 100) vitals.health = 0;
}

function normalizeWound(wound) {
  if (!wound || typeof wound !== 'object' || !wound.id) return null;
  const type = woundTypeLabels[wound.type] ? wound.type : 'scratch';
  const bodyPart = bodyPartLabels[wound.bodyPart] ? wound.bodyPart : 'torso';
  return {
    id: String(wound.id).slice(0, 120),
    bodyPart,
    type,
    severity: clampNumber(wound.severity, 1, 0, 5),
    bleeding: Boolean(wound.bleeding),
    bandaged: Boolean(wound.bandaged),
    dirtyBandage: Boolean(wound.bandaged && wound.dirtyBandage),
    bandageAgeHours: Boolean(wound.bandaged) ? clampNumber(wound.bandageAgeHours, 0, 0, 1000) : 0,
    disinfected: Boolean(wound.disinfected),
    infected: Boolean(wound.infected),
    knoxInfection: Boolean(wound.knoxInfection) || type === 'bite',
    ageHours: clampNumber(wound.ageHours, 0, 0, 1000),
    source: typeof wound.source === 'string' ? wound.source.slice(0, 100) : '未知伤害',
  };
}

function normalizeVitals(vitals) {
  return {
    health: clampNumber(vitals.health, 100, 0, 100),
    endurance: clampNumber(vitals.endurance, 100, 0, 100),
    hunger: clampNumber(vitals.hunger, 20, 0, 100),
    thirst: clampNumber(vitals.thirst, 20, 0, 100),
    fatigue: clampNumber(vitals.fatigue, 20, 0, 100),
    panic: clampNumber(vitals.panic, 20, 0, 100),
    stress: clampNumber(vitals.stress, 20, 0, 100),
  };
}

function clampVitalsInPlace(vitals) {
  Object.keys(vitals).forEach((key) => {
    vitals[key] = Math.round(clamp(vitals[key], 0, 100));
  });
}

function isNight(clockMinutes) {
  const hour = (((Number(clockMinutes) || 0) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY / 60;
  return hour < 6 || hour >= 21;
}

function hashSeed(value) {
  return [...String(value ?? '')].reduce((hash, char) => ((hash * 31 + char.charCodeAt(0)) >>> 0), 17);
}

function finiteInteger(value, fallback = 0, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export { DIRTY_BANDAGE_HOURS, MINUTES_PER_DAY, START_MINUTE };
