export const SKILL_LEVEL_CAP = 10;

const XP_TO_NEXT_LEVEL = [
  75,
  150,
  300,
  750,
  1500,
  3000,
  4500,
  6000,
  7500,
  9000,
];

export function cumulativeXpForLevel(level) {
  const normalizedLevel = clampInteger(level, 0, SKILL_LEVEL_CAP);
  return XP_TO_NEXT_LEVEL.slice(0, normalizedLevel).reduce((sum, value) => sum + value, 0);
}

export function xpForNextLevel(level) {
  const normalizedLevel = clampInteger(level, 0, SKILL_LEVEL_CAP);
  return normalizedLevel >= SKILL_LEVEL_CAP ? 0 : XP_TO_NEXT_LEVEL[normalizedLevel];
}

export function createSkillExperience(skills = {}, skillIds = Object.keys(skills)) {
  return Object.fromEntries(
    skillIds.map((skillId) => [skillId, cumulativeXpForLevel(skills[skillId] ?? 0)])
  );
}

export function normalizeSkillExperience(rawExperience, skills = {}, skillIds = Object.keys(skills)) {
  const source = rawExperience && typeof rawExperience === 'object' ? rawExperience : {};
  const cap = cumulativeXpForLevel(SKILL_LEVEL_CAP);
  return Object.fromEntries(skillIds.map((skillId) => {
    const minimum = cumulativeXpForLevel(skills[skillId] ?? 0);
    const value = Number(source[skillId]);
    return [skillId, Number.isFinite(value) ? clamp(value, minimum, cap) : minimum];
  }));
}

export function grantSkillExperience({ skills = {}, skillXp = {}, gains = {}, skillIds = Object.keys(skills) } = {}) {
  const nextSkills = { ...skills };
  const nextSkillXp = normalizeSkillExperience(skillXp, nextSkills, skillIds);
  const appliedGains = {};
  const levelUps = [];
  const allowed = new Set(skillIds);
  const capXp = cumulativeXpForLevel(SKILL_LEVEL_CAP);

  Object.entries(gains ?? {}).forEach(([skillId, rawAmount]) => {
    const amount = Number(rawAmount);
    if (!allowed.has(skillId) || !Number.isFinite(amount) || amount <= 0) return;
    const previousLevel = clampInteger(nextSkills[skillId], 0, SKILL_LEVEL_CAP);
    const previousXp = nextSkillXp[skillId];
    const granted = Math.min(Math.round(amount * 100) / 100, Math.max(0, capXp - previousXp));
    if (granted <= 0) return;
    const totalXp = Math.min(capXp, previousXp + granted);
    const earnedLevel = levelForExperience(totalXp);
    const nextLevel = Math.max(previousLevel, earnedLevel);
    nextSkillXp[skillId] = totalXp;
    nextSkills[skillId] = nextLevel;
    appliedGains[skillId] = granted;
    if (nextLevel > previousLevel) {
      levelUps.push({ skillId, from: previousLevel, to: nextLevel });
    }
  });

  return { skills: nextSkills, skillXp: nextSkillXp, appliedGains, levelUps };
}

export function skillProgressFor(skillId, skills = {}, skillXp = {}) {
  const level = clampInteger(skills[skillId], 0, SKILL_LEVEL_CAP);
  const totalXp = normalizeSkillExperience(skillXp, skills, [skillId])[skillId];
  if (level >= SKILL_LEVEL_CAP) {
    return {
      id: skillId,
      level,
      xp: totalXp,
      currentLevelXp: 0,
      nextLevelXp: 0,
      progress: 100,
    };
  }
  const levelFloor = cumulativeXpForLevel(level);
  const nextLevelXp = xpForNextLevel(level);
  const currentLevelXp = clamp(totalXp - levelFloor, 0, nextLevelXp);
  return {
    id: skillId,
    level,
    xp: totalXp,
    currentLevelXp,
    nextLevelXp,
    progress: nextLevelXp > 0 ? Math.round(currentLevelXp / nextLevelXp * 100) : 100,
  };
}

export function buildSkillProgressList(definitions = [], skills = {}, skillXp = {}, recentGains = {}) {
  return definitions.map((definition) => ({
    ...definition,
    ...skillProgressFor(definition.id, skills, skillXp),
    recentGain: Math.max(0, Number(recentGains?.[definition.id]) || 0),
  }));
}

function levelForExperience(totalXp) {
  let level = 0;
  while (level < SKILL_LEVEL_CAP && totalXp >= cumulativeXpForLevel(level + 1)) level += 1;
  return level;
}

function clampInteger(value, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? Math.trunc(number) : minimum));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
