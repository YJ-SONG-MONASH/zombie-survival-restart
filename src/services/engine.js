import { eventDeck, marketItems, skillDefinitions, vehicleEvents, vitalDefinitions } from '../data/zombie.js';
import { createWound, durationForAction, resolveCombatEncounter, weatherDefinitions } from './survival.js';

const foodIds = ['canned_soup', 'canned_beans', 'canned_tuna', 'cereal', 'chips', 'peanut_butter'];
const waterIds = ['water_bottle'];

export function createDayEvent({ day, vitals, inventory, tags, traits = [], shelter }) {
  const pressure =
    (vitals.health < 35 ? 1 : 0) +
    (vitals.hunger > 70 ? 1 : 0) +
    (vitals.thirst > 70 ? 1 : 0) +
    (vitals.fatigue > 70 ? 1 : 0) +
    (Math.max(vitals.panic, vitals.stress) > 70 ? 1 : 0) +
    (tags.length > 2 ? 1 : 0);
  const scoutBias = traits.some((trait) => ['eagle_eyed', 'keen_hearing', 'outdoorsman'].includes(trait.id)) ? 1 : 0;
  const index = (day * 3 + pressure + (shelter?.defense ?? 0) + scoutBias) % eventDeck.length;
  const event = eventDeck[index];
  return {
    ...event,
    log: tuneLogForDay(event.log, day, inventory),
  };
}

export function resolveAction({ day, actionText, optionId, event, profession, shelter, inventory, tags, traits = [], vitals, skills }) {
  const option = event.options.find((entry) => entry.id === optionId);
  const action = `${option?.label ?? ''} ${actionText ?? ''}`.toLowerCase();
  const traitIds = new Set(traits.map((trait) => trait.id));
  const profile = scoreProfile({ action, option, profession, shelter, inventory, tags, traits, vitals, skills, event });
  const needsFood = !(traitIds.has('light_eater') && day % 2 === 0);
  const needsWater = !(traitIds.has('low_thirst') && day % 2 === 0);
  const food = needsFood ? consumeOne(inventory, foodIds) : null;
  const water = needsWater ? consumeOne(inventory, waterIds) : null;

  const vitalDelta = {
    health: profile.health,
    endurance: profile.endurance,
    hunger: 7,
    thirst: 9,
    fatigue: (traitIds.has('wakeful') ? 3 : 6) + profile.fatigue,
    panic: profile.panic,
    stress: profile.stress,
  };
  const consume = [];
  const add = [];
  const addTags = [];
  const removeTags = [];
  const notes = [];

  if (food) {
    consume.push(food.id);
    vitalDelta.hunger -= food.effects?.hunger ? Math.abs(food.effects.hunger) : 22;
  } else if (!needsFood) {
    notes.push('轻食简餐节省了一份食物');
  } else {
    vitalDelta.hunger += traitIds.has('hearty_appetite') ? 22 : 16;
    vitalDelta.health -= vitals.hunger > 75 ? 12 : 5;
    notes.push('缺少食物');
    addTags.push('饥饿');
  }

  if (water) {
    consume.push(water.id);
    vitalDelta.thirst -= water.effects?.thirst ? Math.abs(water.effects.thirst) : 30;
  } else if (!needsWater) {
    notes.push('低口渴节省了一瓶水');
  } else {
    vitalDelta.thirst += traitIds.has('high_thirst') ? 30 : 22;
    vitalDelta.health -= vitals.thirst > 75 ? 18 : 8;
    vitalDelta.stress += 3;
    notes.push('缺少饮水');
    addTags.push('脱水');
  }

  if (traitIds.has('high_thirst')) {
    const consumedWater = consume.filter((id) => id === 'water_bottle').length;
    const extraWater = inventory.find((item) => waterIds.includes(item.id) && item.count > consumedWater);
    if (extraWater) {
      consume.push(extraWater.id);
      vitalDelta.thirst -= 18;
      notes.push('高口渴额外消耗饮水');
    } else {
      vitalDelta.thirst += 12;
      vitalDelta.health -= 6;
      notes.push('高口渴加重脱水压力');
    }
  }

  if (traitIds.has('smoker')) {
    const consumedCigarettes = consume.filter((id) => id === 'cigarette').length;
    const cigarette = inventory.find((item) => item.id === 'cigarette' && item.count > consumedCigarettes);
    if (cigarette) {
      consume.push(cigarette.id);
      vitalDelta.stress -= 12;
      notes.push('烟瘾得到缓解');
    } else {
      vitalDelta.stress += 10;
      addTags.push('焦躁');
      notes.push('烟瘾发作');
    }
  }

  if (inventory.some((item) => item.id === 'teabag')) vitalDelta.stress -= 2;
  if (inventory.some((item) => item.id === 'coffee') && vitals.fatigue > 55) vitalDelta.fatigue -= 4;
  if (profile.score < 35) addTags.push(profile.injury ? '受伤' : '精神紧绷');
  if (action.includes('绷带') || action.includes('包扎')) removeTags.push('受伤');
  if (action.includes('抗生素')) removeTags.push('感染');

  if (event.id === 'shop' && profile.score >= 55) {
    add.push(randomSupply(day));
    notes.push('搜到额外物资');
  }
  if (event.id === 'rain' && (optionId === 'collect' || action.includes('接水'))) {
    add.push({ ...marketItems.find((item) => item.id === 'water_bottle'), count: 2 });
    notes.push('雨水补给');
  }
  if (event.id === 'broadcast' && profile.score >= 50) {
    addTags.push('撤离路线');
    notes.push('记下撤离点');
  }

  const result = buildNarrative({ actionText, day, event, option, profession, score: profile.score });
  return {
    vitals: vitalDelta,
    score: profile.score,
    consume,
    add,
    addTags,
    removeTags,
    notes: notes.join(' / ') || '物资与状态基本稳定',
    result,
    highlight: profile.score >= 86 ? `第${day}天：${result}` : null,
  };
}

export function resolveMapMove({ day, node, inventory, tags = [], traits = [], vitals, skills, vehicle, world = null }) {
  const traitIds = new Set(traits.map((trait) => trait.id));
  const consume = [];
  const addTags = [];
  const notes = [`抵达${node.name}`];
  const danger = node.danger ?? 3;
  const vitalDelta = {
    health: danger >= 6 ? -2 : 0,
    endurance: -Math.max(5, danger * 4),
    hunger: 0,
    thirst: 0,
    fatigue: traitIds.has('wakeful') ? Math.max(0, danger - 3) : Math.max(1, danger - 2),
    panic: Math.max(0, danger * 2 - 2),
    stress: Math.max(0, danger - 1),
  };

  if (vehicle?.status && vehicle.status !== 'none' && (vehicle.fuel ?? 0) > 0) {
    vitalDelta.fatigue -= vehicle.status === 'working' ? 4 : 2;
    notes.push(`${vehicle.name ?? '车辆'}节省了体力`);
  }

  const score = Math.max(10, Math.min(95, 72 - danger * 7 + mobilityScore(skills, inventory, traits)));
  const result = `你沿着地图边缘推进到${node.name}。${node.description}今天的路线没有给你太多喘息，但新的位置已经打开。`;
  return {
    title: `抵达 ${node.name}`,
    result,
    notes: notes.join(' / '),
    score,
    vitals: vitalDelta,
    consume,
    add: [],
    addTags,
    removeTags: [],
    revealNodeIds: [],
    vehicle: null,
    minutes: durationForAction('move', { vehicle }),
    mode: 'active',
    noiseDelta: vehicle?.status !== 'none' && (vehicle.fuel ?? 0) > 0 ? 18 : 4,
    threatDelta: Math.max(0, danger * 2 - (world?.weatherId === 'rain' ? 3 : 0)),
    highlight: score >= 86 ? `第${day}天：你抵达${node.name}，路线被重新打开。` : null,
  };
}

export function resolveNodeAction({
  actionId,
  node,
  day,
  clockMinutes = 480,
  inventory,
  tags = [],
  traits = [],
  vitals,
  skills,
  profession,
  vehicle,
  world = null,
  body = null,
  base = null,
  equippedWeaponId = null,
  searchCount = 0,
  manualLoot = null,
  zombiePopulation = null,
}) {
  const traitIds = new Set(traits.map((trait) => trait.id));
  const danger = node.danger ?? 3;
  const consume = [];
  const add = [];
  const addTags = [];
  const removeTags = [];
  const notes = [];
  const vitalDelta = {
    health: -Math.max(0, danger - 3),
    endurance: -Math.max(3, danger * 3),
    hunger: 0,
    thirst: 0,
    fatigue: traitIds.has('wakeful') ? 1 : 2,
    panic: Math.max(0, danger * 2 - 2),
    stress: Math.max(0, danger * 2 - 1),
  };

  if (['combat_melee', 'combat_firearm', 'evade'].includes(actionId)) {
    const combat = resolveCombatEncounter({
      approach: actionId,
      node,
      day,
      clockMinutes,
      inventory,
      skills,
      traits,
      vitals,
      world,
      equippedWeaponId,
      zombiePopulation,
    });
    return mapOutcome({
      day,
      title: combat.title,
      result: combat.result,
      notes: [combat.notes],
      score: combat.score,
      vitalDelta: combat.vitals,
      consume: combat.consume,
      add,
      addTags: combat.wounds.some((wound) => wound.type === 'bite') ? ['疑似咬伤'] : [],
      removeTags,
      wounds: combat.wounds,
      kills: combat.kills,
      minutes: combat.minutes,
      mode: combat.mode,
      noiseDelta: combat.noiseDelta,
      threatDelta: combat.threatDelta,
    });
  }

  if (actionId === 'rest') {
    vitalDelta.health = 2;
    // Endurance, fatigue, panic, and stress recovery are owned by the
    // minute-based survival simulation. Applying a second flat recovery here
    // made rest disproportionately strong and let players erase fatigue by
    // stacking two independent recovery models.
    vitalDelta.endurance = 0;
    vitalDelta.fatigue = 0;
    vitalDelta.panic = 0;
    vitalDelta.stress = 0;
    notes.push('临时休整');
    return mapOutcome({
      day,
      title: '临时休整',
      result: `你在${node.name}找了一处能挡住视线的角落，把呼吸和背包都重新整理了一遍。外面仍然危险，但身体没有继续往下掉。`,
      notes,
      score: 72 - danger * 2 + (skills.first_aid ?? 0),
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      minutes: durationForAction('rest'),
      mode: 'rest',
      noiseDelta: -8,
      threatDelta: -5,
    });
  }

  if (actionId === 'sleep') {
    const sleepMinutes = durationForAction('sleep');
    const sleepCrossesNight = clockMinutes < 6 * 60 || clockMinutes >= 18 * 60 || clockMinutes + sleepMinutes >= 24 * 60;
    vitalDelta.health = base?.defense >= 4 ? 4 : 1;
    // Sleep quality still affects the small health reward and narration, but
    // all time-dependent recovery is calculated once by advanceSurvivalState.
    vitalDelta.endurance = 0;
    vitalDelta.fatigue = 0;
    vitalDelta.panic = 0;
    vitalDelta.stress = 0;
    notes.push('完整睡眠');
    return mapOutcome({
      day,
      title: sleepCrossesNight ? '熬过一夜' : '补足睡眠',
      result: `你在${node.name}把入口重新检查一遍，然后断断续续睡了几个小时。${(world?.threat ?? 0) >= 70 ? '远处持续有撞击和拖行声，这段睡眠并不安稳。' : sleepCrossesNight ? '天亮前没有东西真正靠近你的藏身处。' : '醒来时附近依旧安静，你还没有浪费掉整整一天。'}`,
      notes,
      score: 72 + (base?.defense ?? 0) * 3 - danger * 4,
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      minutes: sleepMinutes,
      mode: 'sleep',
      noiseDelta: -12,
      threatDelta: -8,
    });
  }

  if (actionId === 'scout') {
    vitalDelta.endurance -= 2;
    vitalDelta.fatigue += 2;
    vitalDelta.panic += Math.max(0, danger - 3);
    vitalDelta.stress += Math.max(0, danger - 2);
    notes.push('标记路线');
    return mapOutcome({
      day,
      title: '侦察路线',
      result: `你没有急着进建筑，而是绕着${node.name}走了一圈。路障、尸群和可疑灯光被标在地图边上，远处的问号少了一些。`,
      notes,
      score: 62 - danger * 3 + scoutScore(skills, traits),
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      scoutDepth: 2,
      minutes: durationForAction('scout'),
      mode: 'active',
      noiseDelta: -4,
      threatDelta: -8,
      highlight: danger >= 5 ? `第${day}天：你在${node.name}摸清了一条高危路线。` : null,
    });
  }

  if (actionId === 'forage') {
    const weather = weatherDefinitions.find((entry) => entry.id === world?.weatherId) ?? weatherDefinitions[0];
    const score = Math.max(10, Math.min(98,
      46 + (skills.foraging ?? 0) * 8 + (traitIds.has('outdoorsman') ? 10 : 0) + weather.searchMod - danger * 4 + Math.floor(Math.random() * 18)
    ));
    const foundIds = score >= 75 ? ['wild_berries', 'foraged_mushrooms'] : score >= 42 ? ['wild_berries'] : [];
    foundIds.forEach((id) => {
      const item = marketItems.find((entry) => entry.id === id);
      if (item) add.push({ ...item, count: 1 });
    });
    if (score >= 82 && day % 2 === 0) {
      const seeds = marketItems.find((entry) => entry.id === 'cabbage_seeds');
      if (seeds) add.push({ ...seeds, count: 1 });
    }
    vitalDelta.health = 0;
    vitalDelta.endurance = -10;
    vitalDelta.fatigue = 2;
    vitalDelta.panic = Math.max(0, danger - 2);
    vitalDelta.stress = 0;
    notes.push(foundIds.length ? `找到${foundIds.length}份野外食物` : '没有找到可确认安全的食物');
    return mapOutcome({
      day,
      title: '野外觅食',
      result: foundIds.length
        ? `你在${node.name}的林线和荒地里慢慢筛过可食用植物，带回了${foundIds.map((id) => marketItems.find((item) => item.id === id)?.name).join('、')}。`
        : `你在${node.name}绕了很久，只找到无法确认是否有毒的植物，最后空手返回。`,
      notes,
      score,
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      minutes: durationForAction('forage'),
      mode: 'active',
      noiseDelta: -3,
      threatDelta: -4,
    });
  }

  if (actionId === 'fortify') {
    const hasHammer = inventory.some((item) => item.id === 'hammer' && item.count > 0);
    const hasPlank = inventory.some((item) => item.id === 'plank' && item.count > 0);
    const hasNails = inventory.some((item) => item.id === 'nails' && item.count > 0);
    const ready = hasHammer && hasPlank && hasNails;
    if (ready) consume.push('plank', 'nails');
    vitalDelta.health = 0;
    vitalDelta.endurance = ready ? -12 : -2;
    vitalDelta.fatigue = ready ? 4 : 0;
    vitalDelta.panic = -2;
    vitalDelta.stress = ready ? -4 : 2;
    notes.push(ready ? '木板与钉子构成一层新路障' : '缺少锤子、木板或钉子');
    return mapOutcome({
      day,
      title: ready ? '据点加固' : '材料不足',
      result: ready
        ? `你用木板封住${node.name}据点最薄弱的入口。路障不可能永远挡住尸群，但能换来宝贵的反应时间。`
        : '你检查了入口，但没有齐备锤子、木板和钉子，只能先把薄弱点记下来。',
      notes,
      score: ready ? 62 + (skills.carpentry ?? 0) * 6 : 20,
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      minutes: ready ? durationForAction('fortify') : 20,
      mode: 'active',
      noiseDelta: ready ? 24 : 0,
      threatDelta: ready ? 8 : 0,
      baseDelta: ready ? { defense: 1, barricades: 1 } : null,
    });
  }

  if (actionId === 'vehicle') {
    const vehicleOutcome = resolveVehicleSearch({ node, day, inventory, traits, skills, profession, danger, vehicle });
    vitalDelta.health += vehicleOutcome.vitalDelta.health;
    vitalDelta.endurance += vehicleOutcome.vitalDelta.endurance;
    vitalDelta.fatigue += vehicleOutcome.vitalDelta.fatigue;
    vitalDelta.panic += vehicleOutcome.vitalDelta.panic;
    vitalDelta.stress += vehicleOutcome.vitalDelta.stress;
    notes.push(...vehicleOutcome.notes);
    vehicleOutcome.consume.forEach((id) => consume.push(id));
    if (vehicleOutcome.addTag) addTags.push(vehicleOutcome.addTag);
    return mapOutcome({
      day,
      title: '寻找车辆',
      result: vehicleOutcome.result,
      notes,
      score: vehicleOutcome.score,
      vitalDelta,
      consume,
      add,
      addTags,
      removeTags,
      vehicle: vehicleOutcome.vehicle,
      vehicleOperation: vehicleOutcome.vehicleOperation,
      minutes: durationForAction('vehicle'),
      mode: 'active',
      noiseDelta: 16,
      threatDelta: 8,
      highlight: vehicleOutcome.vehicle?.status === 'working' ? `第${day}天：你在${node.name}弄到了一辆能开的车。` : null,
    });
  }

  const foundItems = manualLoot
    ? normalizeManualLootItems(manualLoot.collectedItems)
    : searchCount >= 3
      ? []
      : nodeLoot({ node, day: day + searchCount * 7, skills, traits, inventory }).slice(0, Math.max(1, 2 - searchCount));
  foundItems.forEach((item) => add.push({ ...item, count: item.count ?? 1 }));
  const searchScore = Math.max(10, Math.min(98, 54 - danger * 4 + scoutScore(skills, traits) + lootToolScore(inventory) - (manualLoot ? 0 : searchCount * 9)));
  const wounds = [];
  if (searchScore < 42) {
    vitalDelta.health -= danger >= 5 ? 10 : 5;
    vitalDelta.panic += 10;
    addTags.push('受伤');
    wounds.push(createWound({ danger, score: searchScore, day, clockMinutes, source: `${node.name}搜刮事故` }));
    notes.push('搜刮时受伤');
  } else if (foundItems.length) {
    notes.push(`${manualLoot ? '带走' : '找到'}${foundItems.map((item) => item.name).join('、')}`);
  } else {
    notes.push(manualLoot ? '没有带走有价值物资' : searchCount >= 3 ? '周边已被反复翻找，资源耗尽' : '没有找到有价值物资');
  }

  return mapOutcome({
    day,
    title: manualLoot ? `搜索 ${manualLoot.sourceName}` : '搜索周边',
    result: `你搜索了${manualLoot?.sourceName ?? `${node.name}附近的建筑和路边残骸`}。${foundItems.length ? `背包里多了${foundItems.map((item) => item.name).join('、')}。` : '能带走的东西比想象中少。'}${danger >= 5 ? '这里的尸群一直在压缩你的退路。' : '这片区域暂时还给你留了撤离空间。'}`,
    notes,
    score: searchScore,
    vitalDelta,
    consume,
    add,
    addTags,
    removeTags,
    wounds,
    minutes: durationForAction('search'),
    mode: 'active',
    noiseDelta: 10 + danger * 2,
    threatDelta: Math.max(0, danger - 2),
    highlight: searchScore >= 86 ? `第${day}天：你在${node.name}找到关键补给。` : null,
  });
}

function normalizeManualLootItems(items = []) {
  const byId = new Map();
  items.filter(Boolean).forEach((item) => {
    const existing = byId.get(item.id);
    if (existing) existing.count += Math.max(1, Number(item.count) || 1);
    else byId.set(item.id, { ...item, count: Math.max(1, Number(item.count) || 1) });
  });
  return [...byId.values()];
}

export function createEnding({ day, maxDay = 20, victory, vitals, skills, profession, survivorName, spawnLocation, shelter, inventory, history, traits = [], highlight, body = null, world = null, stats = null }) {
  const best = [...history].sort((a, b) => b.score - a.score)[0];
  const worst = [...history].sort((a, b) => a.score - b.score)[0];
  const reason = victory
    ? '等到军方撤离'
    : (body?.infectionLevel ?? 0) >= 100
      ? 'Knox 感染吞噬了最后的意识'
      : vitals.health <= 0
        ? '生命值耗尽'
        : day > maxDay
          ? '错过最后撤离窗口'
          : '生存记录中断';
  const archetype = pickArchetype({ history, profession, vitals, victory });
  const topSkills = Object.entries(skills ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, level]) => {
      const skill = skillDefinitions.find((entry) => entry.id === id);
      return {
        id,
        level,
        name: skill?.label ?? id,
        canonicalName: skill?.canonicalName ?? id,
        iconFile: skill?.iconFile ?? '',
        fallbackIcon: skill?.fallbackIcon ?? id.slice(0, 3).toUpperCase(),
      };
    });
  const comment = victory
    ? `${profession?.name ?? '幸存者'}撑过了封城二十天。你不是无伤通关，只是每一次快倒下时都找到了下一口气。`
    : `${worst?.title ?? '末日'}没有给你第二次解释的机会。${reason}不是突然发生的，它是每个代价累积后的最后一句话。`;

  return {
    day,
    victory,
    reason,
    title: archetype.title,
    icon: archetype.icon,
    color: archetype.color,
    comment,
    highlight: highlight || best?.result || '没有特别耀眼的时刻，但每一天都算数。',
    vitals: Object.fromEntries(vitalDefinitions.map((vital) => [vital.id, vitals[vital.id]])),
    topSkills,
    survivorName: survivorName || '无名幸存者',
    professionName: profession?.name ?? '未知身份',
    spawnName: spawnLocation?.name ?? '未知出生点',
    traits: traits.map((trait) => ({ name: trait.name, canonicalName: trait.canonicalName, points: trait.points, icon: trait.icon })),
    shelterName: shelter?.name ?? '无避难所',
    inventory: inventory.map((item) => ({ name: item.name, count: item.count, icon: item.fallbackIcon ?? item.icon })),
    world: world ? {
      weatherId: world.weatherId,
      threat: world.threat,
      powerOn: world.powerOn,
      waterOn: world.waterOn,
    } : null,
    wounds: (body?.wounds ?? []).map((wound) => ({
      bodyPart: wound.bodyPart,
      type: wound.type,
      severity: wound.severity,
      knoxInfection: wound.knoxInfection,
    })),
    infectionLevel: body?.infectionLevel ?? 0,
    stats: stats ? { ...stats } : null,
  };
}

function mapOutcome({
  day,
  title,
  result,
  notes,
  score,
  vitalDelta,
  consume,
  add,
  addTags,
  removeTags,
  scoutDepth = 0,
  vehicle = null,
  vehicleOperation = null,
  highlight = null,
  minutes = 120,
  mode = 'active',
  wounds = [],
  kills = 0,
  noiseDelta = 0,
  threatDelta = 0,
  baseDelta = null,
}) {
  return {
    title,
    result,
    notes: notes.join(' / ') || '地图状态稳定',
    score: Math.max(5, Math.min(98, Math.round(score))),
    vitals: vitalDelta,
    consume,
    add,
    addTags,
    removeTags,
    scoutDepth,
    revealNodeIds: [],
    vehicle,
    vehicleOperation,
    highlight,
    minutes,
    mode,
    wounds,
    kills,
    noiseDelta,
    threatDelta,
    baseDelta,
    action: title,
    day,
  };
}

function applyDailyNeeds({ day, inventory, traits, vitals, consume, vitalDelta, addTags, notes }) {
  const needsFood = !(traits.has('light_eater') && day % 2 === 0);
  const needsWater = !(traits.has('low_thirst') && day % 2 === 0);
  const food = needsFood ? consumeOne(inventory, foodIds) : null;
  const water = needsWater ? consumeOne(inventory, waterIds) : null;

  if (food) {
    consume.push(food.id);
    vitalDelta.hunger -= food.effects?.hunger ? Math.abs(food.effects.hunger) : 22;
  } else if (!needsFood) {
    notes.push('少食节省了一份食物');
  } else {
    vitalDelta.hunger += traits.has('hearty_appetite') ? 20 : 14;
    vitalDelta.health -= vitals.hunger > 75 ? 10 : 4;
    addTags.push('饥饿');
    notes.push('缺少食物');
  }

  if (water) {
    consume.push(water.id);
    vitalDelta.thirst -= water.effects?.thirst ? Math.abs(water.effects.thirst) : 30;
  } else if (!needsWater) {
    notes.push('低口渴节省了一瓶水');
  } else {
    vitalDelta.thirst += traits.has('high_thirst') ? 28 : 20;
    vitalDelta.health -= vitals.thirst > 75 ? 16 : 7;
    vitalDelta.stress += 3;
    addTags.push('脱水');
    notes.push('缺少饮水');
  }

  if (traits.has('high_thirst')) {
    const consumedWater = consume.filter((id) => id === 'water_bottle').length;
    const extraWater = inventory.find((item) => waterIds.includes(item.id) && item.count > consumedWater);
    if (extraWater) {
      consume.push(extraWater.id);
      vitalDelta.thirst -= 16;
      notes.push('高口渴额外消耗饮水');
    } else {
      vitalDelta.thirst += 10;
      vitalDelta.health -= 5;
      notes.push('高口渴加重脱水压力');
    }
  }

  if (traits.has('smoker')) {
    const consumedCigarettes = consume.filter((id) => id === 'cigarette').length;
    const cigarette = inventory.find((item) => item.id === 'cigarette' && item.count > consumedCigarettes);
    if (cigarette) {
      consume.push(cigarette.id);
      vitalDelta.stress -= 10;
      notes.push('烟瘾得到缓解');
    } else {
      vitalDelta.stress += 9;
      addTags.push('焦躁');
      notes.push('烟瘾发作');
    }
  }
}

function resolveVehicleSearch({ node, day, inventory, traits, skills, profession, danger, vehicle }) {
  const traitIds = new Set(traits.map((trait) => trait.id));
  const gasCan = inventory.find((item) => item.id === 'gas_can' && item.count > 0);
  const candidateEvents = vehicleEvents.filter((entry) => entry.nodeTypes.includes(node.type));
  const event = candidateEvents[day % Math.max(1, candidateEvents.length)] ?? vehicleEvents[0];
  let score =
    34 -
    danger * 4 +
    (skills.mechanics ?? 0) * 7 +
    (skills.electrical ?? 0) * 3 +
    (traitIds.has('speed_demon') ? 8 : 0) +
    (profession?.tags?.some((tag) => ['盗车老手', '车辆', '修理', '机械'].includes(tag)) ? 10 : 0) +
    (gasCan ? 12 : 0) +
    Math.floor(Math.random() * 21);
  const notes = [];
  const consume = [];
  const vitalDelta = { health: -Math.max(0, danger - 4), endurance: -6, fatigue: 6, panic: danger * 2, stress: danger * 2 };

  if (vehicle?.status === 'working' && gasCan) {
    consume.push('gas_can');
    notes.push('用汽油桶补充燃料');
    return {
      score: 78,
      result: `你没有换车，而是把汽油桶倒进${vehicle.name ?? '现有车辆'}。发动机声很粗，但路线选择明显变多了。`,
      notes,
      consume,
      vitalDelta: { ...vitalDelta, stress: -2, fatigue: -4 },
      vehicle: { ...vehicle, fuel: Math.min(5, (vehicle.fuel ?? 0) + 2), status: 'working' },
      vehicleOperation: 'refuel',
    };
  }

  if (score >= 58) {
    const fuelBonus = gasCan ? 1 : 0;
    if (gasCan) consume.push('gas_can');
    notes.push(`发现${event.name}`);
    return {
      score,
      result: `你在${node.name}附近找到${event.name}。${event.description}${gasCan ? '汽油桶让它多撑了一段路。' : '油量不多，必须谨慎规划下一步。'}`,
      notes,
      consume,
      vitalDelta: { ...vitalDelta, fatigue: Math.max(0, vitalDelta.fatigue - 3), stress: Math.max(-6, vitalDelta.stress - 5) },
      vehicle: {
        id: event.id,
        status: event.status,
        fuel: Math.max(1, event.fuel + fuelBonus),
        name: event.name,
        condition: event.condition,
        nodeId: node.id,
        trunkSpace: event.trunkSpace,
      },
      vehicleOperation: 'replace',
    };
  }

  notes.push('没有找到可靠车辆');
  return {
    score,
    result: `你翻过${node.name}附近的停车场和路边废车。能打开的车不是没油就是电瓶死透，引擎声只换来远处的回应。`,
    notes,
    consume,
    vitalDelta: { ...vitalDelta, health: vitalDelta.health - (score < 35 ? 5 : 0), panic: vitalDelta.panic + 4 },
    vehicle: null,
    vehicleOperation: null,
    addTag: score < 35 ? '精神紧绷' : null,
  };
}

function nodeLoot({ node, day, skills, traits, inventory }) {
  const pool = nodeLootPool(node);
  const count = node.danger >= 5 ? 1 : node.danger <= 2 ? 2 : day % 3 === 0 ? 2 : 1;
  const picks = [];
  let attempts = 0;
  while (picks.length < count && attempts < 30) {
    attempts += 1;
    const id = pool[(day + attempts + Math.floor(Math.random() * pool.length)) % pool.length];
    if (!picks.includes(id)) picks.push(id);
  }
  if ((skills.foraging ?? 0) >= 3 && ['wilds', 'town'].includes(node.type) && !picks.includes('cabbage_seeds')) picks.push('cabbage_seeds');
  if (traits.some((trait) => trait.id === 'lucky') && !picks.includes('bandage')) picks.push('bandage');
  if (inventory.some((item) => item.id === 'crowbar') && ['commercial', 'industrial'].includes(node.type) && !picks.includes('nails')) picks.push('nails');
  return picks
    .slice(0, 3)
    .map((id) => marketItems.find((item) => item.id === id))
    .filter(Boolean);
}

function nodeLootPool(node) {
  const common = ['water_bottle', 'canned_beans', 'chips', 'bandage'];
  const pools = {
    spawn_town: ['water_bottle', 'canned_soup', 'canned_tuna', 'cereal', 'apple', 'bread', 'milk', 'bandage', 'hammer', 'screwdriver', 'duffel_bag'],
    town: ['water_bottle', 'canned_beans', 'cereal', 'peanut_butter', 'apple', 'cabbage', 'bread', 'trowel', 'cabbage_seeds', 'hammer', 'bandage'],
    road: ['water_bottle', 'chips', 'gas_can', 'wrench', 'lug_wrench', 'jack', 'duffel_bag'],
    commercial: ['canned_soup', 'canned_beans', 'canned_tuna', 'apple', 'milk', 'fresh_meat', 'bread', 'coffee', 'teabag', 'painkillers', 'beta_blockers', 'baseball_bat'],
    industrial: ['hammer', 'saw', 'screwdriver', 'wrench', 'pipe_wrench', 'nails', 'duct_tape', 'propane_torch', 'gas_can'],
    wilds: ['water_bottle', 'chips', 'fishing_tackle', 'trowel', 'cabbage_seeds', 'crafted_spear', 'bandage'],
    checkpoint: ['first_aid_kit', 'painkillers', '9mm_rounds', 'shotgun_shells', 'm9_pistol', 'gas_can', 'wrench'],
    major_city: ['canned_tuna', 'peanut_butter', 'milk', 'fresh_meat', 'bread', 'antibiotics', 'first_aid_kit', 'hiking_bag', 'machete', '9mm_rounds'],
  };
  return pools[node.type] ?? common;
}

function scoutScore(skills, traits) {
  const traitIds = new Set(traits.map((trait) => trait.id));
  return (
    (skills.sneaking ?? 0) * 3 +
    (skills.lightfooted ?? 0) * 2 +
    (skills.nimble ?? 0) * 2 +
    (skills.foraging ?? 0) * 2 +
    (traitIds.has('inconspicuous') ? 5 : 0) +
    (traitIds.has('graceful') ? 5 : 0) +
    (traitIds.has('lucky') ? 4 : 0) -
    (traitIds.has('conspicuous') ? 7 : 0) -
    (traitIds.has('clumsy') ? 7 : 0) -
    (traitIds.has('unlucky') ? 5 : 0)
  );
}

function mobilityScore(skills, inventory, traits) {
  const traitIds = new Set(traits.map((trait) => trait.id));
  return (
    (skills.fitness ?? 0) * 2 +
    (skills.sprinting ?? 0) * 2 +
    (skills.nimble ?? 0) +
    (inventory.some((item) => item.tags?.includes('capacity')) ? 4 : 0) +
    (traitIds.has('athletic') ? 5 : 0) +
    (traitIds.has('runner') ? 5 : 0) -
    (traitIds.has('out_of_shape') ? 5 : 0) -
    (traitIds.has('unfit') ? 8 : 0)
  );
}

function lootToolScore(inventory) {
  return (
    (inventory.some((item) => item.id === 'crowbar') ? 8 : 0) +
    (inventory.some((item) => item.id === 'screwdriver') ? 4 : 0) +
    (inventory.some((item) => item.id === 'hammer') ? 4 : 0) +
    (inventory.some((item) => item.id === 'flashlight') ? 3 : 0)
  );
}

function scoreProfile({ action, event, inventory, option, profession, shelter, vitals, skills, tags, traits }) {
  let score = 50 + (shelter?.defense ?? 1) * 4 - event.risk * 7;
  let health = -event.risk * 2;
  let endurance = -event.risk * 4;
  let fatigue = 0;
  let panic = event.risk * 4;
  let stress = event.risk * 3;
  const professionTags = profession?.tags ?? [];
  const traitIds = new Set(traits.map((trait) => trait.id));

  score += Math.floor(((skills.strength ?? 5) - 5) * 2);
  score += Math.floor(((skills.fitness ?? 5) - 5) * 2);
  if (vitals.endurance < 35) score -= 10;
  if (vitals.fatigue > 70) score -= 10;
  if (vitals.hunger > 80 || vitals.thirst > 80) score -= 12;
  if (vitals.panic > 70) score -= 8;
  if (vitals.stress > 70) score -= 6;

  if (option?.stat === 'fight') score += bestCombatSkill(skills, inventory) * 5 + Math.floor((skills.strength ?? 5) * 1.2);
  if (option?.stat === 'scout') score += ((skills.sneaking ?? 0) + (skills.lightfooted ?? 0) + (skills.nimble ?? 0) + (skills.foraging ?? 0)) * 2;
  if (option?.stat === 'defense') score += ((skills.carpentry ?? 0) + (skills.maintenance ?? 0) + (skills.metalworking ?? 0) + (skills.electrical ?? 0)) * 3;
  if (option?.stat === 'empathy') score += (skills.first_aid ?? 0) * 3;
  if (option?.stat === 'san') score += vitals.stress < 55 ? 10 : -4;

  if (option?.stat === 'fight' && professionTags.some((tag) => ['战斗经验', '体能充沛', '警戒', '枪械训练', '斧头', '斧头专家', '短钝器', '力量'].includes(tag))) score += 10;
  if (option?.stat === 'scout' && professionTags.some((tag) => ['警戒', '野外求生', '森林穿行', '潜行', '盗车老手', '车辆', '钓鱼', '户外'].includes(tag))) score += 8;
  if (option?.stat === 'defense' && professionTags.some((tag) => ['建造', '木工', '维护', '修理', '焊接', '防御', '金属加工', '高级电工'].includes(tag))) score += 8;

  if (inventory.some((item) => item.tags?.includes('weapon'))) score += option?.stat === 'fight' ? 12 : 4;
  if (inventory.some((item) => item.id === 'shotgun') && inventory.some((item) => item.id === 'shotgun_shells')) score += 12;
  if (inventory.some((item) => item.id === 'm9_pistol') && inventory.some((item) => item.id === '9mm_rounds')) score += 9;
  if (inventory.some((item) => item.tags?.includes('medical')) && tags.includes('受伤')) score += 8 + (skills.first_aid ?? 0) * 2;
  if (inventory.some((item) => item.tags?.includes('generator')) && action.includes('电')) score += 8 + (skills.electrical ?? 0) * 2;
  if (inventory.some((item) => item.id === 'gas_can') && (action.includes('车') || action.includes('发电机'))) score += 8;

  if (traitIds.has('lucky') && event.id === 'shop') score += 10;
  if (['cook', 'nutritionist', 'gardener', 'angler'].some((id) => traitIds.has(id)) && event.id === 'shop') score += 5;
  if (['herbalist', 'hiker', 'former_scout'].some((id) => traitIds.has(id)) && event.id === 'rain') score += 7;
  if (traitIds.has('night_owl') && dayIsNightLike(event, action)) score += 5;
  if (traitIds.has('speed_demon') && action.includes('车')) score += 8;
  if (traitIds.has('unlucky')) score -= 8;
  if (traitIds.has('pacifist') && option?.stat === 'fight') score -= 14;
  if (traitIds.has('cowardly') && ['fight', 'empathy'].includes(option?.stat)) score -= 10;
  if (traitIds.has('clumsy') && option?.stat === 'scout') score -= 8;
  if (traitIds.has('conspicuous') && ['scout', 'defense'].includes(option?.stat)) score -= 8;
  if (traitIds.has('deaf') && option?.stat === 'scout') score -= 14;
  if (traitIds.has('hard_of_hearing') && option?.stat === 'scout') score -= 7;
  if (traitIds.has('short_sighted') && option?.stat === 'scout') score -= 6;
  if (traitIds.has('weak') || traitIds.has('feeble')) score -= option?.stat === 'fight' ? 14 : 4;
  if (traitIds.has('out_of_shape') || traitIds.has('unfit') || traitIds.has('asthmatic')) score -= ['fight', 'scout'].includes(option?.stat) ? 8 : 0;
  if (traitIds.has('athletic') || traitIds.has('fit') || traitIds.has('runner')) score += ['fight', 'scout'].includes(option?.stat) ? 6 : 0;

  if (tags.includes('受伤')) {
    score -= 10;
    health -= traitIds.has('slow_healer') ? 8 : 5;
  }
  if (tags.includes('精神紧绷')) stress += 5;
  if (tags.includes('焦躁')) stress += 5;
  if (action.includes('开枪') || action.includes('霰弹')) {
    score += inventory.some((item) => item.id === 'shotgun_shells' || item.id === '9mm_rounds') ? 14 : -18;
    panic += 14;
    stress += 8;
  }
  if (action.includes('谈判') || action.includes('交换')) stress -= 3;
  if (action.includes('休息') || action.includes('等待')) {
    fatigue -= 8;
    stress -= 5;
  }

  score = Math.max(5, Math.min(98, score + Math.floor(Math.random() * 21) - 10));
  if (traitIds.has('fast_learner') && score < 55) score += 4;
  if (traitIds.has('slow_learner') && score < 55) score -= 4;
  if (traitIds.has('thick_skinned')) health += 4;
  if (traitIds.has('thin_skinned')) health -= score < 55 ? 8 : 3;
  if (traitIds.has('fast_healer') && tags.includes('受伤')) health += 6;
  if (traitIds.has('prone_to_illness') && event.id === 'rain') health -= 6;
  if (traitIds.has('resilient') && event.id === 'rain') health += 4;
  if (traitIds.has('sleepyhead') || traitIds.has('restless_sleeper')) fatigue += 5;

  if (score >= 75) {
    health += 3;
    panic -= 8;
    stress -= 7;
    endurance += 3;
  } else if (score < 35) {
    health -= 15;
    panic += 18;
    stress += 14;
    endurance -= 8;
  } else if (score < 50) {
    health -= 8;
    panic += 8;
    stress += 6;
    endurance -= 4;
  }

  return { score, health, endurance, fatigue, panic, stress, injury: score < 45 };
}

function bestCombatSkill(skills, inventory) {
  const weaponSkills = inventory
    .filter((item) => item.tags?.includes('weapon') && !item.conditionState?.condition?.broken)
    .map((item) => item.effects?.skill)
    .filter(Boolean);
  if (!weaponSkills.length) return Math.max(skills.strength ?? 5, skills.fitness ?? 5) / 2;
  return Math.max(...weaponSkills.map((skill) => skills[skill] ?? 0));
}

function consumeOne(inventory, ids) {
  return inventory.find((item) => ids.includes(item.id) && item.count > 0);
}

function randomSupply(day) {
  const pool = ['canned_beans', 'water_bottle', 'chips', 'bandage', 'cigarette'];
  const id = pool[day % pool.length];
  return { ...marketItems.find((item) => item.id === id), count: 1 };
}

function tuneLogForDay(log, day, inventory) {
  const suffix = day >= 15
    ? '远处偶尔传来军用车辆的轰鸣，像一个越来越近的承诺。'
    : day >= 8
      ? '城市已经彻底安静下来，安静得让每一次呼吸都显得太响。'
      : '手机网络还残留着零星信号，坏消息比求救更快抵达。';
  const hasWeapon = inventory.some((item) => item.tags?.includes('weapon'));
  return `${log}${hasWeapon ? '你摸了摸手边的武器。' : ''}${suffix}`;
}

function dayIsNightLike(event, action) {
  return event.id === 'broadcast' || action.includes('夜') || action.includes('等');
}

function buildNarrative({ actionText, day, option, profession, score }) {
  const actor = profession?.name ?? '你';
  const action = actionText || option?.label || '保持谨慎';
  if (score >= 80) {
    return `${actor}选择${action}。你把风险压到最低，在最糟糕的声音出现前完成了行动。第${day}天没有变得容易，但你把主动权抢回了一点。`;
  }
  if (score >= 55) {
    return `${actor}选择${action}。过程不漂亮，但结果够用。你损失了一点体力，也换回了今天继续活着的理由。`;
  }
  if (score >= 35) {
    return `${actor}选择${action}。犹豫和噪音让局面变坏，你勉强脱身，却把明天的压力推得更高。`;
  }
  return `${actor}选择${action}。这一步判断失误了。窗外的尸群、屋内的恐惧和身体的极限同时压下来，你付出了沉重代价。`;
}

function pickArchetype({ history, profession, vitals, victory }) {
  if (victory && history.some((entry) => entry.score >= 85)) return { title: '撤离名单上的人', icon: '🚁', color: 'gold' };
  if (profession?.tags?.includes('枪械训练')) return { title: '枪声幸存者', icon: '▣', color: 'red' };
  if (vitals.panic >= 90 || vitals.stress >= 90) return { title: '神经绷断的人', icon: '∿', color: 'violet' };
  if (vitals.hunger >= 90 || vitals.thirst >= 90) return { title: '耗尽补给的人', icon: '◇', color: 'cyan' };
  if (history.length >= 12) return { title: '封门专家', icon: '▤', color: 'cyan' };
  return { title: '普通幸存者', icon: '□', color: 'gray' };
}
