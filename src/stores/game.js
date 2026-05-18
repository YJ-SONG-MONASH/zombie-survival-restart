import { defineStore } from 'pinia';
import {
  hiddenProfessionAliases,
  hiddenSurvivorPresets,
  marketItems,
  professions,
  scenarios,
  shelterQualities,
  shelters,
  skillDefinitions,
  spawnLocations,
  traitAttributeMods,
  traits,
  vitalDefinitions,
} from '../data/zombie.js';
import { createDayEvent, createEnding, resolveAction } from '../services/engine.js';

const defaultState = () => ({
  scenario: cloneCatalogRecord(scenarios[0]),
  day: 1,
  maxDay: 20,
  vitals: createBaseVitals(),
  skills: createBaseSkills(),
  baseTraitPoints: 0,
  survivorName: '',
  spawnLocation: cloneCatalogRecord(spawnLocations[0]),
  money: 6500,
  profession: null,
  selectedTraits: [],
  shelter: null,
  shelterChoices: [],
  shelterRollsUsed: 0,
  maxShelterRolls: 3,
  inventory: [],
  hiddenTags: [],
  history: [],
  activeEvent: null,
  ending: null,
  archives: [],
});

export const useGameStore = defineStore('game', {
  state: defaultState,
  getters: {
    isGameOver: (state) => state.vitals.health <= 0 || state.day > state.maxDay,
    isVictory: (state) => state.day > state.maxDay && state.vitals.health > 0,
    usedSpace: (state) => state.inventory.reduce((sum, item) => sum + item.space * item.count, 0),
    maxSpace: (state) => {
      const base = state.shelter?.space ?? 30;
      const strengthBonus = Math.max(0, (state.skills?.strength ?? 5) - 5) * 3;
      const bagBonus = state.inventory.reduce((sum, item) => sum + ((item.effects?.capacity ?? 0) * item.count), 0);
      const total = base + strengthBonus + bagBonus;
      if (state.selectedTraits.some((trait) => trait.id === 'organized')) return Math.floor(total * 1.3);
      if (state.selectedTraits.some((trait) => trait.id === 'disorganized')) return Math.floor(total * 0.7);
      return total;
    },
    remainingSpace() {
      return this.maxSpace - this.usedSpace;
    },
    traitPointsRemaining: (state) => state.baseTraitPoints + state.selectedTraits.reduce((sum, trait) => sum + trait.points, 0),
    traitTags: (state) => [...new Set(state.selectedTraits.flatMap((trait) => trait.tags ?? []))],
    legacyStats: (state) => ({
      hp: state.vitals.health,
      san: Math.max(0, 100 - Math.max(state.vitals.panic, state.vitals.stress)),
    }),
    unlockedProfessionIds: (state) => {
      const normalized = normalizeName(state.survivorName);
      return hiddenProfessionAliases
        .filter((entry) => entry.names.some((name) => normalizeName(name) === normalized))
        .map((entry) => entry.professionId);
    },
    activeHiddenPreset: (state) => findHiddenSurvivorPreset(state.survivorName),
    isHiddenPresetLocked: (state) => Boolean(findHiddenSurvivorPreset(state.survivorName)?.lockedTraits),
    sortedArchives: (state) => [...state.archives].sort((a, b) => b.createdAt - a.createdAt),
  },
  actions: {
    loadPersistedState() {
      const raw = localStorage.getItem('moshi-survival-state');
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.game) this.$patch(parsed.game);
        this.normalizeCatalogReferences();
        if (!Array.isArray(this.selectedTraits)) this.selectedTraits = [];
        if (this.baseTraitPoints === undefined || this.baseTraitPoints === null) this.baseTraitPoints = this.profession?.traitPointMod ?? 0;
        if (!this.spawnLocation) this.spawnLocation = cloneCatalogRecord(spawnLocations[0]);
        if (!this.survivorName) this.survivorName = '';
        if (!parsed?.game?.vitals || !parsed?.game?.skills) this.recalculateCharacterState(false);
      } catch {
        localStorage.removeItem('moshi-survival-state');
      }
    },
    resetGame() {
      const archives = this.archives;
      this.$patch(defaultState());
      this.archives = archives;
    },
    startScenario(scenarioId) {
      const selected = scenarios.find((scenario) => scenario.id === scenarioId);
      if (!selected || selected.locked) return false;
      this.resetGame();
      this.scenario = cloneCatalogRecord(selected);
      this.maxDay = selected.maxDay;
      return true;
    },
    setSurvivorName(name) {
      this.survivorName = name;
      const preset = findHiddenSurvivorPreset(name);
      if (preset) {
        this.applyHiddenSurvivorPreset(preset);
        return;
      }
      if (this.profession?.hiddenOnly && !this.unlockedProfessionIds.includes(this.profession.id)) {
        this.profession = null;
        this.selectedTraits = [];
        this.inventory = [];
      }
    },
    selectSpawnLocation(id) {
      const location = spawnLocations.find((item) => item.id === id);
      if (!location) return false;
      this.spawnLocation = cloneCatalogRecord(location);
      if (this.profession) this.recalculateCharacterState(false);
      return true;
    },
    selectProfession(id) {
      if (this.isHiddenPresetLocked && id !== this.activeHiddenPreset.professionId) return false;
      const profession = professions.find((item) => item.id === id);
      if (!profession || (profession.hiddenOnly && !this.unlockedProfessionIds.includes(id))) return false;
      this.profession = cloneCatalogRecord(profession);
      this.selectedTraits = [];
      this.inventory = [];
      this.shelter = null;
      this.shelterChoices = [];
      this.shelterRollsUsed = 0;
      this.activeEvent = null;
      this.recalculateCharacterState(true);
      return true;
    },
    applyHiddenSurvivorPreset(preset) {
      const profession = professions.find((item) => item.id === preset.professionId);
      if (!profession) return false;
      const presetTraits = preset.traitIds
        .map((traitId) => traits.find((trait) => trait.id === traitId))
        .filter(Boolean)
        .map(cloneCatalogRecord);
      const currentTraitIds = this.selectedTraits.map((trait) => trait.id).join('|');
      const presetTraitIds = preset.traitIds.join('|');
      if (this.profession?.id === preset.professionId && currentTraitIds === presetTraitIds) return true;
      this.profession = cloneCatalogRecord(profession);
      this.selectedTraits = presetTraits;
      this.inventory = [];
      this.shelter = null;
      this.shelterChoices = [];
      this.shelterRollsUsed = 0;
      this.activeEvent = null;
      this.recalculateCharacterState(true);
      return true;
    },
    normalizeCatalogReferences() {
      const scenario = scenarios.find((item) => item.id === this.scenario?.id) ?? scenarios[0];
      const location = spawnLocations.find((item) => item.id === this.spawnLocation?.id) ?? spawnLocations[0];
      const profession = this.profession ? professions.find((item) => item.id === this.profession.id) : null;
      const shelter = this.shelter ? shelters.find((item) => item.id === this.shelter.id) : null;
      this.scenario = cloneCatalogRecord(scenario);
      this.spawnLocation = cloneCatalogRecord(location);
      this.profession = profession ? cloneCatalogRecord(profession) : null;
      this.shelter = shelter ? cloneCatalogRecord(shelter) : null;
      this.shelterChoices = Array.isArray(this.shelterChoices)
        ? this.shelterChoices
            .map((choice) => shelters.find((item) => item.id === choice?.id))
            .filter(Boolean)
            .map(cloneCatalogRecord)
        : [];
      this.shelterRollsUsed = Number.isFinite(this.shelterRollsUsed) ? Math.max(0, this.shelterRollsUsed) : 0;
      this.maxShelterRolls = Number.isFinite(this.maxShelterRolls) ? this.maxShelterRolls : 3;
      this.vitals = normalizeVitals(this.vitals, this.stats);
      this.skills = normalizeSkills(this.skills);
      const rawInventory = Array.isArray(this.inventory) ? this.inventory : [];
      this.inventory = rawInventory
        .map((item) => marketItems.find((entry) => entry.id === item?.id || entry.name === item?.name))
        .filter(Boolean)
        .map((item) => ({ ...cloneCatalogRecord(item), count: rawInventory.find((entry) => entry?.id === item.id || entry?.name === item.name)?.count ?? 1 }));
      this.selectedTraits = Array.isArray(this.selectedTraits)
        ? this.selectedTraits
            .map((trait) => traits.find((entry) => entry.id === trait?.id))
            .filter(Boolean)
            .map(cloneCatalogRecord)
        : [];
    },
    recalculateCharacterState(includeUnlocks = false) {
      if (!this.profession) return;
      const location = this.spawnLocation ?? spawnLocations[0];
      const vitals = createBaseVitals();
      const skills = createBaseSkills();
      applyVitalMods(vitals, {
        health: location.hpMod ?? 0,
        panic: -(location.sanMod ?? 0),
        stress: -(location.sanMod ?? 0),
        ...(location.vitalMods ?? {}),
      });
      applyVitalMods(vitals, this.profession.vitalMods ?? {});
      applySkillMods(skills, this.profession.skillMods ?? {});
      this.selectedTraits.forEach((trait) => {
        const mods = traitAttributeMods[trait.id] ?? {};
        applyVitalMods(vitals, { ...(mods.vitalMods ?? {}), ...(trait.vitalMods ?? {}) });
        applySkillMods(skills, { ...(mods.skillMods ?? {}), ...(trait.skillMods ?? {}) });
      });
      this.baseTraitPoints = this.profession.traitPointMod ?? 0;
      this.money = 6500 + this.profession.money + (location.moneyMod ?? 0);
      this.vitals = vitals;
      this.skills = skills;
      if (!includeUnlocks) return;
      this.profession.unlocks?.forEach((itemId) => {
        const item = marketItems.find((entry) => entry.id === itemId);
        if (item) this.addItem(item, 1, true);
      });
    },
    toggleTrait(id) {
      if (this.isHiddenPresetLocked) return false;
      const trait = traits.find((item) => item.id === id);
      if (!trait) return false;
      const selected = this.selectedTraits.find((item) => item.id === id);
      if (selected) {
        this.selectedTraits = this.selectedTraits.filter((item) => item.id !== id);
        this.recalculateCharacterState(false);
        return true;
      }
      if (this.selectedTraits.some((item) => item.conflicts?.includes(id) || trait.conflicts?.includes(item.id))) return false;
      this.selectedTraits.push(trait);
      this.recalculateCharacterState(false);
      return true;
    },
    canSelectTrait(id) {
      if (this.isHiddenPresetLocked) return this.selectedTraits.some((item) => item.id === id);
      const trait = traits.find((item) => item.id === id);
      if (!trait) return false;
      if (this.selectedTraits.some((item) => item.id === id)) return true;
      return !this.selectedTraits.some((item) => item.conflicts?.includes(id) || trait.conflicts?.includes(item.id));
    },
    rollShelters() {
      if (this.shelter || this.shelterRollsUsed >= this.maxShelterRolls) return false;
      this.shelterChoices = drawShelterChoices(3).map(cloneCatalogRecord);
      this.shelterRollsUsed += 1;
      return true;
    },
    selectShelter(id) {
      const shelter = this.shelterChoices.find((item) => item.id === id);
      if (!shelter) return false;
      this.shelter = cloneCatalogRecord(shelter);
      return true;
    },
    addItem(item, count = 1, free = false) {
      if (!free && (this.money < item.price * count || this.remainingSpace < item.space * count)) return false;
      const existing = this.inventory.find((entry) => entry.id === item.id);
      if (existing) existing.count += count;
      else this.inventory.push({ ...item, count });
      if (!free) this.money -= item.price * count;
      return true;
    },
    removeItem(id, count = 1) {
      const item = this.inventory.find((entry) => entry.id === id || entry.name === id);
      if (!item) return false;
      item.count -= count;
      if (item.count <= 0) this.inventory = this.inventory.filter((entry) => entry !== item);
      return true;
    },
    ensureActiveEvent() {
      if (!this.activeEvent) {
        this.activeEvent = createDayEvent({
          day: this.day,
          vitals: this.vitals,
          skills: this.skills,
          inventory: this.inventory,
          tags: this.hiddenTags,
          traits: this.selectedTraits,
          shelter: this.shelter,
        });
      }
    },
    submitAction(actionText, optionId = null) {
      this.ensureActiveEvent();
      const outcome = resolveAction({
        day: this.day,
        actionText,
        optionId,
        event: this.activeEvent,
        profession: this.profession,
        shelter: this.shelter,
        inventory: this.inventory,
        tags: this.hiddenTags,
        traits: this.selectedTraits,
        vitals: this.vitals,
        skills: this.skills,
      });

      outcome.consume.forEach((itemId) => this.removeItem(itemId, 1));
      outcome.add.forEach((item) => this.addItem(item, item.count ?? 1, true));
      outcome.removeTags.forEach((tag) => {
        this.hiddenTags = this.hiddenTags.filter((entry) => entry !== tag);
      });
      outcome.addTags.forEach((tag) => {
        if (!this.hiddenTags.includes(tag)) this.hiddenTags.push(tag);
      });
      this.vitals = applyVitalDelta(this.vitals, outcome.vitals);
      this.history.push({
        day: this.day,
        title: this.activeEvent.title,
        log: this.activeEvent.log,
        action: actionText || this.activeEvent.options.find((entry) => entry.id === optionId)?.label,
        result: outcome.result,
        notes: outcome.notes,
        score: outcome.score,
      });
      if (outcome.highlight) this.ending = { ...(this.ending || {}), highlight: outcome.highlight };

      this.day += 1;
      this.activeEvent = null;

      if (this.isGameOver) {
        this.ending = createEnding({
          day: this.day - 1,
          victory: this.isVictory,
          vitals: this.vitals,
          skills: this.skills,
          profession: this.profession,
          survivorName: this.survivorName,
          spawnLocation: this.spawnLocation,
          shelter: this.shelter,
          inventory: this.inventory,
          history: this.history,
          traits: this.selectedTraits,
          highlight: this.ending?.highlight,
        });
      } else {
        this.ensureActiveEvent();
      }
    },
    saveArchive(nickname = '匿名幸存者') {
      if (!this.ending) return;
      this.archives.unshift({
        id: crypto.randomUUID(),
        nickname,
        createdAt: Date.now(),
        ending: this.ending,
        profession: this.profession,
        survivorName: this.survivorName,
        spawnLocation: this.spawnLocation,
        traits: this.selectedTraits,
        scenario: this.scenario,
      });
      this.archives = this.archives.slice(0, 24);
    },
  },
});

function normalizeName(name) {
  return `${name ?? ''}`.trim().replace(/\s+/g, '').toLowerCase();
}

function findHiddenSurvivorPreset(name) {
  const normalized = normalizeName(name);
  return hiddenSurvivorPresets.find((preset) => preset.names.some((entry) => normalizeName(entry) === normalized)) ?? null;
}

function cloneCatalogRecord(record) {
  if (!record) return null;
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
    unlocks: record.unlocks ? [...record.unlocks] : undefined,
    effects: record.effects ? { ...record.effects } : undefined,
    vitalMods: record.vitalMods ? { ...record.vitalMods } : undefined,
    skillMods: record.skillMods ? { ...record.skillMods } : undefined,
  };
}

function createBaseVitals() {
  return Object.fromEntries(vitalDefinitions.map((vital) => [vital.id, vital.kind === 'bad' ? 20 : 100]));
}

function createBaseSkills() {
  return Object.fromEntries(skillDefinitions.map((skill) => [skill.id, skill.defaultLevel ?? 0]));
}

function normalizeVitals(vitals, legacyStats = null) {
  const normalized = createBaseVitals();
  if (legacyStats?.hp !== undefined) normalized.health = legacyStats.hp;
  if (legacyStats?.san !== undefined) {
    const pressure = Math.max(0, Math.min(90, 100 - legacyStats.san));
    normalized.panic = pressure;
    normalized.stress = pressure;
  }
  Object.entries(vitals ?? {}).forEach(([key, value]) => {
    if (key in normalized && Number.isFinite(value)) normalized[key] = value;
  });
  return clampVitals(normalized);
}

function normalizeSkills(skills) {
  const normalized = createBaseSkills();
  Object.entries(skills ?? {}).forEach(([key, value]) => {
    if (key in normalized && Number.isFinite(value)) normalized[key] = clampSkill(value);
  });
  return normalized;
}

function applyVitalMods(vitals, mods = {}) {
  Object.entries(mods).forEach(([key, value]) => {
    if (key in vitals && Number.isFinite(value)) vitals[key] = clampVital(key, vitals[key] + value);
  });
}

function applySkillMods(skills, mods = {}) {
  Object.entries(mods).forEach(([key, value]) => {
    if (key in skills && Number.isFinite(value)) skills[key] = clampSkill(skills[key] + value);
  });
}

function applyVitalDelta(vitals, delta = {}) {
  const next = normalizeVitals(vitals);
  applyVitalMods(next, delta);
  return next;
}

function clampVitals(vitals) {
  const next = { ...vitals };
  vitalDefinitions.forEach((vital) => {
    next[vital.id] = clampVital(vital.id, next[vital.id]);
  });
  return next;
}

function clampVital(key, value) {
  const max = vitalDefinitions.find((vital) => vital.id === key)?.max ?? 100;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function clampSkill(value) {
  return Math.max(0, Math.min(10, Math.round(value)));
}

export function drawShelterChoices(count = 3) {
  const choices = [];
  let attempts = 0;
  const maxAttempts = count * 80;

  while (choices.length < count && attempts < maxAttempts) {
    attempts += 1;
    const quality = pickShelterQuality();
    const candidates = shelters.filter((shelter) => shelter.quality === quality.id && !choices.some((choice) => choice.id === shelter.id));
    if (!candidates.length) continue;
    choices.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  while (choices.length < count) {
    const candidates = shelters.filter((shelter) => !choices.some((choice) => choice.id === shelter.id));
    if (!candidates.length) break;
    choices.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  return choices;
}

function pickShelterQuality() {
  const totalWeight = shelterQualities.reduce((sum, quality) => sum + quality.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const quality of shelterQualities) {
    roll -= quality.weight;
    if (roll < 0) return quality;
  }
  return shelterQualities[shelterQualities.length - 1];
}
