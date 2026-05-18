import { defineStore } from 'pinia';
import { marketItems, professions, scenarios, shelters } from '../data/zombie.js';
import { createDayEvent, createEnding, resolveAction } from '../services/engine.js';

const defaultState = () => ({
  scenario: scenarios[0],
  day: 1,
  maxDay: 20,
  stats: { hp: 100, san: 100 },
  money: 6500,
  profession: null,
  shelter: null,
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
    maxSpace: (state) => state.shelter?.space ?? 30,
    remainingSpace() {
      return this.maxSpace - this.usedSpace;
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
      this.scenario = selected;
      this.maxDay = selected.maxDay;
      return true;
    },
    selectProfession(id) {
      const profession = professions.find((item) => item.id === id);
      if (!profession) return;
      this.profession = profession;
      this.money = 6500 + profession.money;
      this.stats.hp = Math.max(1, 100 + profession.hp);
      this.stats.san = Math.max(1, 100 + profession.san);
      profession.unlocks?.forEach((itemId) => {
        const item = marketItems.find((entry) => entry.id === itemId);
        if (item) this.addItem(item, 1, true);
      });
    },
    selectShelter(id) {
      const shelter = shelters.find((item) => item.id === id);
      if (!shelter || this.money < shelter.price) return false;
      this.shelter = shelter;
      this.money -= shelter.price;
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
          shelter: this.shelter,
          inventory: this.inventory,
          history: this.history,
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
        scenario: this.scenario,
      });
      this.archives = this.archives.slice(0, 24);
    },
  },
});
