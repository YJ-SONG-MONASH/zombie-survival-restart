import { defineStore } from 'pinia';
import { hiddenProfessionAliases, marketItems, professions, scenarios, shelterQualities, shelters, spawnLocations, traits } from '../data/zombie.js';
import { createDayEvent, createEnding, resolveAction } from '../services/engine.js';

const defaultState = () => ({
  scenario: cloneCatalogRecord(scenarios[0]),
  day: 1,
  maxDay: 20,
  stats: { hp: 100, san: 100 },
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
    isGameOver: (state) => state.stats.hp <= 0 || state.stats.san <= 0 || state.day > state.maxDay,
    isVictory: (state) => state.day > state.maxDay && state.stats.hp > 0 && state.stats.san > 0,
    usedSpace: (state) => state.inventory.reduce((sum, item) => sum + item.space * item.count, 0),
    maxSpace: (state) => {
      const base = state.shelter?.space ?? 30;
      if (state.selectedTraits.some((trait) => trait.id === 'organized')) return Math.floor(base * 1.3);
      if (state.selectedTraits.some((trait) => trait.id === 'disorganized')) return Math.floor(base * 0.7);
      return base;
    },
    remainingSpace() {
      return this.maxSpace - this.usedSpace;
    },
    traitPointsRemaining: (state) => state.baseTraitPoints + state.selectedTraits.reduce((sum, trait) => sum + trait.points, 0),
    traitTags: (state) => [...new Set(state.selectedTraits.flatMap((trait) => trait.tags ?? []))],
    unlockedProfessionIds: (state) => {
      const normalized = normalizeName(state.survivorName);
      return hiddenProfessionAliases
        .filter((entry) => entry.names.some((name) => normalizeName(name) === normalized))
        .map((entry) => entry.professionId);
    },
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
      if (this.profession) this.applyCharacterProfile(false);
      return true;
    },
    selectProfession(id) {
      const profession = professions.find((item) => item.id === id);
      if (!profession || (profession.hiddenOnly && !this.unlockedProfessionIds.includes(id))) return false;
      this.profession = cloneCatalogRecord(profession);
      this.selectedTraits = [];
      this.inventory = [];
      this.shelter = null;
      this.shelterChoices = [];
      this.shelterRollsUsed = 0;
      this.activeEvent = null;
      this.applyCharacterProfile(true);
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
    },
    applyCharacterProfile(includeUnlocks = false) {
      if (!this.profession) return;
      const location = this.spawnLocation ?? spawnLocations[0];
      this.baseTraitPoints = this.profession.traitPointMod ?? 0;
      this.money = 6500 + this.profession.money + (location.moneyMod ?? 0);
      this.stats.hp = Math.max(1, 100 + this.profession.hp + (location.hpMod ?? 0));
      this.stats.san = Math.max(1, 100 + this.profession.san + (location.sanMod ?? 0));
      if (!includeUnlocks) return;
      this.profession.unlocks?.forEach((itemId) => {
        const item = marketItems.find((entry) => entry.id === itemId);
        if (item) this.addItem(item, 1, true);
      });
    },
    toggleTrait(id) {
      const trait = traits.find((item) => item.id === id);
      if (!trait) return false;
      const selected = this.selectedTraits.find((item) => item.id === id);
      if (selected) {
        this.selectedTraits = this.selectedTraits.filter((item) => item.id !== id);
        return true;
      }
      if (this.selectedTraits.some((item) => item.conflicts?.includes(id) || trait.conflicts?.includes(item.id))) return false;
      this.selectedTraits.push(trait);
      return true;
    },
    canSelectTrait(id) {
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
          stats: this.stats,
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
        stats: this.stats,
      });

      outcome.consume.forEach((itemId) => this.removeItem(itemId, 1));
      outcome.add.forEach((item) => this.addItem(item, item.count ?? 1, true));
      outcome.removeTags.forEach((tag) => {
        this.hiddenTags = this.hiddenTags.filter((entry) => entry !== tag);
      });
      outcome.addTags.forEach((tag) => {
        if (!this.hiddenTags.includes(tag)) this.hiddenTags.push(tag);
      });
      this.stats.hp = Math.max(0, Math.min(140, this.stats.hp + outcome.hp));
      this.stats.san = Math.max(0, Math.min(140, this.stats.san + outcome.san));
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
          stats: this.stats,
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

function cloneCatalogRecord(record) {
  if (!record) return null;
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
    unlocks: record.unlocks ? [...record.unlocks] : undefined,
  };
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
