import { eventDeck, marketItems } from '../data/zombie.js';

const foodIds = ['biscuit', 'canned', 'noodle'];
const waterIds = ['water'];

export function createDayEvent({ day, stats, inventory, tags, shelter }) {
  const pressure = (stats.hp < 35 ? 1 : 0) + (stats.san < 35 ? 1 : 0) + (tags.length > 2 ? 1 : 0);
  const index = (day * 3 + pressure + (shelter?.defense ?? 0)) % eventDeck.length;
  const event = eventDeck[index];
  return {
    ...event,
    log: tuneLogForDay(event.log, day, inventory),
  };
}

export function resolveAction({ day, actionText, optionId, event, profession, shelter, inventory, tags, stats }) {
  const option = event.options.find((entry) => entry.id === optionId);
  const action = `${option?.label ?? ''} ${actionText ?? ''}`.toLowerCase();
  const profile = scoreProfile({ action, option, profession, shelter, inventory, tags, stats, event });
  const food = consumeOne(inventory, foodIds);
  const water = consumeOne(inventory, waterIds);

  let hp = profile.hp;
  let san = profile.san;
  const consume = [];
  const add = [];
  const addTags = [];
  const removeTags = [];
  const notes = [];

  if (food) consume.push(food.id);
  else {
    hp -= profession?.tags?.includes('高消耗') ? 26 : 18;
    notes.push('缺少食物');
    addTags.push('饥饿');
  }

  if (water) consume.push(water.id);
  else {
    hp -= 32;
    san -= 4;
    notes.push('缺少饮水');
    addTags.push('脱水');
  }

  if (inventory.some((item) => item.id === 'cat')) {
    san += 5;
    notes.push('橘猫让夜晚没那么空');
  }

  if (inventory.some((item) => item.id === 'book') && stats.san < 45) {
    san += 3;
  }

  if (profile.score < 35) addTags.push(profile.injury ? '受伤' : '精神紧绷');
  if (action.includes('绷带') || action.includes('包扎')) removeTags.push('受伤');
  if (action.includes('抗生素')) removeTags.push('感染');

  if (event.id === 'shop' && profile.score >= 55) {
    add.push(randomSupply(day));
    notes.push('搜到额外物资');
  }
  if (event.id === 'rain' && (optionId === 'collect' || action.includes('接水'))) {
    add.push({ ...marketItems.find((item) => item.id === 'water'), count: 2 });
    notes.push('雨水补给');
  }
  if (event.id === 'broadcast' && profile.score >= 50) {
    addTags.push('撤离路线');
    notes.push('记下撤离点');
  }

  const result = buildNarrative({ actionText, day, event, option, profession, score: profile.score });
  return {
    hp,
    san,
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

export function createEnding({ day, victory, stats, profession, shelter, inventory, history, highlight }) {
  const best = [...history].sort((a, b) => b.score - a.score)[0];
  const worst = [...history].sort((a, b) => a.score - b.score)[0];
  const reason = victory
    ? '等到军方撤离'
    : stats.hp <= 0
      ? '生命值耗尽'
      : stats.san <= 0
        ? '理智崩溃'
        : '生存记录中断';
  const archetype = pickArchetype({ history, profession, stats, victory });
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
    hp: stats.hp,
    san: stats.san,
    professionName: profession?.name ?? '未知身份',
    shelterName: shelter?.name ?? '无避难所',
    inventory: inventory.map((item) => ({ name: item.name, count: item.count, icon: item.icon })),
  };
}

function scoreProfile({ action, event, inventory, option, profession, shelter, stats, tags }) {
  let score = 54 + (shelter?.defense ?? 1) * 4 - event.risk * 8;
  let hp = -event.risk * 3;
  let san = -event.risk * 2;
  const professionTags = profession?.tags ?? [];

  if (option?.stat === 'fight' && professionTags.some((tag) => ['战斗经验', '体能充沛', '警戒'].includes(tag))) score += 18;
  if (option?.stat === 'scout' && professionTags.some((tag) => ['逻辑分析', '警戒', '野外求生'].includes(tag))) score += 14;
  if (option?.stat === 'empathy' && ['普通白领', '医生'].includes(profession?.name)) score += 12;
  if (option?.stat === 'san' && stats.san > 60) score += 10;

  if (inventory.some((item) => item.tags?.includes('weapon'))) score += option?.stat === 'fight' ? 15 : 5;
  if (inventory.some((item) => item.id === 'shotgun') && inventory.some((item) => item.id === 'shells')) score += 12;
  if (inventory.some((item) => item.tags?.includes('medical')) && tags.includes('受伤')) score += 8;
  if (professionTags.includes('傻人傻福') && event.id === 'shop') score += 18;

  if (tags.includes('受伤')) {
    score -= 10;
    hp -= 5;
  }
  if (tags.includes('精神紧绷')) san -= 4;
  if (action.includes('开枪') || action.includes('霰弹')) {
    score += inventory.some((item) => item.id === 'shells') ? 16 : -18;
    san -= 6;
  }
  if (action.includes('谈判') || action.includes('交换')) san += 3;
  if (action.includes('休息') || action.includes('等待')) san += 6;

  score = Math.max(5, Math.min(98, score + Math.floor(Math.random() * 21) - 10));
  if (score >= 75) {
    hp += 4;
    san += 5;
  } else if (score < 35) {
    hp -= 15;
    san -= 12;
  } else if (score < 50) {
    hp -= 8;
    san -= 6;
  }

  return { score, hp, san, injury: score < 45 };
}

function consumeOne(inventory, ids) {
  return inventory.find((item) => ids.includes(item.id) && item.count > 0);
}

function randomSupply(day) {
  const pool = ['biscuit', 'water', 'canned', 'bandage', 'cigarette'];
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

function buildNarrative({ actionText, day, option, profession, score }) {
  const actor = profession?.name ?? '你';
  const action = actionText || option?.label || '保持谨慎';
  if (score >= 80) {
    return `${actor}选择${action}。你把风险压到最低，在最糟糕的声音出现前完成了行动。第${day}天没有变得容易，但你把主动权抢回了一点。`;
  }
  if (score >= 55) {
    return `${actor}选择${action}。过程不漂亮，甚至有几秒钟你几乎想退回去，但结果还算站得住。你带着新的消耗回到避难所。`;
  }
  if (score >= 35) {
    return `${actor}选择${action}。判断没有完全错，执行却被噪音、恐惧和疲惫拖慢。你活着回来，但门关上后手还在抖。`;
  }
  return `${actor}选择${action}。这一步把你推向了更糟的局面：声音、血迹和错误的时机连在一起，代价比预想中沉重。`;
}

function pickArchetype({ history, profession, stats, victory }) {
  const avg = history.length ? history.reduce((sum, item) => sum + item.score, 0) / history.length : 50;
  if (!victory && avg < 35) return { title: '达尔文奖', icon: '🪦', color: 'red' };
  if (stats.san <= 0) return { title: '理智囚徒', icon: '🧠', color: 'violet' };
  if (profession?.tags?.includes('战斗经验') || avg > 78) return { title: '废土战神', icon: '⚔️', color: 'orange' };
  if (history.some((item) => item.action?.includes('帮') || item.action?.includes('救'))) return { title: '末世好人', icon: '🕯️', color: 'amber' };
  if (victory) return { title: '末日幸存者', icon: '🏅', color: 'green' };
  return { title: '末世孤狼', icon: '🌑', color: 'slate' };
}
