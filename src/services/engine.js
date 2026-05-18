import { eventDeck, marketItems, skillDefinitions, vitalDefinitions } from '../data/zombie.js';

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

export function createEnding({ day, victory, vitals, skills, profession, survivorName, spawnLocation, shelter, inventory, history, traits = [], highlight }) {
  const best = [...history].sort((a, b) => b.score - a.score)[0];
  const worst = [...history].sort((a, b) => a.score - b.score)[0];
  const reason = victory ? '等到军方撤离' : vitals.health <= 0 ? '生命值耗尽' : '生存记录中断';
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
  };
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
    .filter((item) => item.tags?.includes('weapon'))
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
