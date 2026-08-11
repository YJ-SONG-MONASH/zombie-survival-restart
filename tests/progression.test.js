import { describe, expect, it } from 'vitest';
import {
  SKILL_LEVEL_CAP,
  buildSkillProgressList,
  createSkillExperience,
  cumulativeXpForLevel,
  grantSkillExperience,
  normalizeSkillExperience,
  skillProgressFor,
  xpForNextLevel,
} from '../src/services/progression.js';

describe('skill experience progression', () => {
  it('anchors starting skills at the beginning of their current level', () => {
    const skills = { fitness: 5, aiming: 2, carpentry: 0 };
    const experience = createSkillExperience(skills);

    expect(experience).toEqual({
      fitness: cumulativeXpForLevel(5),
      aiming: cumulativeXpForLevel(2),
      carpentry: 0,
    });
    expect(xpForNextLevel(5)).toBe(3000);
  });

  it('grants deterministic experience and reports every crossed level', () => {
    const skills = { aiming: 0, reloading: 0 };
    const result = grantSkillExperience({
      skills,
      skillXp: createSkillExperience(skills),
      gains: { aiming: 230, reloading: 25 },
    });

    expect(result.skills).toEqual({ aiming: 2, reloading: 0 });
    expect(result.skillXp).toEqual({ aiming: 230, reloading: 25 });
    expect(result.appliedGains).toEqual({ aiming: 230, reloading: 25 });
    expect(result.levelUps).toEqual([{ skillId: 'aiming', from: 0, to: 2 }]);
    expect(skills).toEqual({ aiming: 0, reloading: 0 });
  });

  it('ignores unknown, negative, and non-finite grants', () => {
    const result = grantSkillExperience({
      skills: { sneaking: 1 },
      skillXp: { sneaking: cumulativeXpForLevel(1) },
      gains: { sneaking: -5, removed_skill: 200, bad: Number.NaN },
    });

    expect(result.skills).toEqual({ sneaking: 1 });
    expect(result.appliedGains).toEqual({});
    expect(result.levelUps).toEqual([]);
  });

  it('normalizes migrated experience to at least the saved level and clamps at level ten', () => {
    const capXp = cumulativeXpForLevel(SKILL_LEVEL_CAP);
    expect(normalizeSkillExperience({ strength: -20, axe: 999999 }, { strength: 5, axe: 10 }))
      .toEqual({ strength: cumulativeXpForLevel(5), axe: capXp });

    const capped = grantSkillExperience({
      skills: { axe: 10 },
      skillXp: { axe: capXp },
      gains: { axe: 500 },
    });
    expect(capped.skills.axe).toBe(10);
    expect(capped.skillXp.axe).toBe(capXp);
    expect(capped.appliedGains).toEqual({});
  });

  it('builds progress values for the UI without exposing raw threshold arithmetic', () => {
    const floor = cumulativeXpForLevel(2);
    const progress = skillProgressFor('carpentry', { carpentry: 2 }, { carpentry: floor + 150 });
    expect(progress).toMatchObject({
      level: 2,
      currentLevelXp: 150,
      nextLevelXp: 300,
      progress: 50,
    });

    expect(buildSkillProgressList(
      [{ id: 'carpentry', label: '木工' }],
      { carpentry: 2 },
      { carpentry: floor + 150 },
      { carpentry: 8 }
    )[0]).toMatchObject({ label: '木工', progress: 50, recentGain: 8 });
  });
});
