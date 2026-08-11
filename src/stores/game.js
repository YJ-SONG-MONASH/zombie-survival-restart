import { defineStore } from 'pinia';
import {
  craftingRecipes,
  hiddenProfessionAliases,
  hiddenSurvivorPresets,
  lootTierWeights,
  mapEdges,
  mapNodeDetails,
  mapNodeScaleById,
  mapNodeActions,
  mapNodeTypes,
  mapNodes,
  marketItems,
  professions,
  scenarios,
  shelterConsumableGuarantees,
  shelterLootProfiles,
  shelterQualities,
  shelters,
  skillDefinitions,
  spawnLocations,
  traitAttributeMods,
  traits,
  universalShelterLootPools,
  vitalDefinitions,
} from '../data/zombie.js';
import { createDayEvent, createEnding, resolveAction, resolveMapMove, resolveNodeAction as resolveMapNodeAction } from '../services/engine.js';
import {
  applyZombieKills,
  createNodeZombieState,
  grantEvasionWindow,
  isNodeSecured,
  normalizeNodeZombieStates,
  refreshNodeZombieState,
} from '../services/encounters.js';
import {
  buildSkillProgressList,
  createSkillExperience,
  grantSkillExperience as applySkillExperience,
  normalizeSkillExperience,
} from '../services/progression.js';
import {
  START_MINUTE,
  advanceSurvivalState,
  bodyPartLabels,
  createBaseState,
  createBodyState,
  createSurvivalStats,
  createWorldState,
  durationForAction,
  formatClock,
  moodlesFor,
  normalizeBaseState,
  normalizeBodyState,
  normalizeSurvivalStats,
  normalizeWorldState,
  weatherDefinitions,
  woundTypeLabels,
} from '../services/survival.js';

export const SAVE_VERSION = 3;

const defaultState = () => ({
  saveVersion: SAVE_VERSION,
  scenario: cloneCatalogRecord(scenarios[0]),
  day: 1,
  clockMinutes: START_MINUTE,
  maxDay: 20,
  vitals: createBaseVitals(),
  skills: createBaseSkills(),
  skillXp: createSkillExperience(createBaseSkills()),
  lastSkillGains: {},
  baseTraitPoints: 0,
  survivorName: '',
  spawnLocation: cloneCatalogRecord(spawnLocations[0]),
  money: 6500,
  profession: null,
  selectedTraits: [],
  shelter: null,
  shelterChoices: [],
  shelterRollsUsed: 0,
  maxShelterRolls: 10,
  lootSlots: [],
  lootSearchStarted: false,
  searchingSlotId: null,
  inventory: [],
  hiddenTags: [],
  history: [],
  activeEvent: null,
  currentNodeId: null,
  inspectedNodeId: null,
  visitedNodeIds: [],
  knownNodeIds: [],
  vehicle: { status: 'none', fuel: 0, name: '徒步', condition: 0 },
  movesRemaining: 1,
  mapLog: [],
  searchedSceneObjectIds: [],
  nodeSearchCounts: {},
  nodeZombieStates: {},
  world: createWorldState(),
  body: createBodyState(),
  base: createBaseState(),
  equippedWeaponId: null,
  survivalStats: createSurvivalStats(),
  ending: null,
  archives: [],
});

export const useGameStore = defineStore('game', {
  state: defaultState,
  getters: {
    isVictory: (state) => {
      if (state.day < state.maxDay || state.day > state.maxDay + 5) return false;
      if (!['valley_checkpoint', 'louisville_outskirts'].includes(state.currentNodeId)) return false;
      if (state.vitals.health <= 0 || (state.body?.infectionLevel ?? 0) >= 100) return false;
      const zombieState = state.nodeZombieStates?.[state.currentNodeId];
      return Boolean(zombieState && isNodeSecured(zombieState, worldMinutesForState(state)));
    },
    isGameOver() {
      return this.vitals.health <= 0 || this.body?.infectionLevel >= 100 || this.isVictory || this.day > this.maxDay + 5;
    },
    runPhase() {
      if (this.isGameOver || this.ending?.title) return 'ended';
      return this.currentNodeId ? 'running' : 'setup';
    },
    evacuationWindowOpen: (state) => state.day >= state.maxDay && state.day <= state.maxDay + 5,
    evacuationDeadline: (state) => state.maxDay + 5,
    usedSpace: (state) => state.inventory.reduce((sum, item) => sum + item.space * item.count, 0),
    maxSpace: (state) => inventoryCapacityForState(state, state.inventory),
    remainingSpace() {
      return this.maxSpace - this.usedSpace;
    },
    searchedLootCount: (state) => state.lootSlots.filter((slot) => slot.status !== 'hidden').length,
    takenLootCount: (state) => state.lootSlots.filter((slot) => slot.status === 'taken').length,
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
    currentMapNode: (state) => mapNodes.find((node) => node.id === state.currentNodeId) ?? null,
    totalWorldMinutes: (state) => worldMinutesForState(state),
    clockLabel: (state) => formatClock(state.clockMinutes),
    activeWeather: (state) => weatherDefinitions.find((weather) => weather.id === state.world?.weatherId) ?? weatherDefinitions[0],
    isAtHome: (state) => Boolean(state.currentNodeId && state.currentNodeId === state.spawnLocation?.id),
    equippedWeapon: (state) => state.inventory.find((item) => item.id === state.equippedWeaponId && item.count > 0) ?? null,
    woundList: (state) => (state.body?.wounds ?? []).map((wound) => ({
      ...wound,
      bodyPartLabel: bodyPartLabels[wound.bodyPart] ?? wound.bodyPart,
      typeLabel: woundTypeLabels[wound.type] ?? wound.type,
    })),
    skillProgressList: (state) => buildSkillProgressList(skillDefinitions, state.skills, state.skillXp, state.lastSkillGains),
    currentZombieState: (state) => {
      const node = mapNodes.find((entry) => entry.id === state.currentNodeId);
      if (!node) return null;
      return state.nodeZombieStates?.[node.id] ?? createNodeZombieState({
        nodeId: node.id,
        danger: node.danger,
        seed: state.world?.seed,
        day: state.day,
      });
    },
    isCurrentNodeSecured() {
      return Boolean(this.currentZombieState && isNodeSecured(this.currentZombieState, this.totalWorldMinutes));
    },
    currentEncounter() {
      if (!this.currentZombieState || this.isCurrentNodeSecured) return null;
      return {
        active: true,
        nodeId: this.currentMapNode?.id,
        nodeName: this.currentMapNode?.name ?? '未知地区',
        population: this.currentZombieState.count,
      };
    },
    moodles() {
      return moodlesFor({
        vitals: this.vitals,
        body: this.body,
        world: this.world,
        usedSpace: this.usedSpace,
        maxSpace: this.maxSpace,
      });
    },
    recipeList: (state) => craftingRecipes.map((recipe) => recipeStatus(recipe, state)),
    inspectedMapNode: (state) => mapNodes.find((node) => node.id === state.inspectedNodeId) ?? null,
    inspectedNodeDetail: (state) => mapNodeDetails[state.inspectedNodeId] ?? null,
    visibleMapNodeList: (state) => buildVisibleMapNodes(state),
    currentNeighborNodes: (state) => neighborsForNode(state.currentNodeId).map((id) => mapNodes.find((node) => node.id === id)).filter(Boolean),
    currentNodeActions: (state) => {
      const node = mapNodes.find((entry) => entry.id === state.currentNodeId);
      const zombieState = node ? state.nodeZombieStates?.[node.id] : null;
      const totalMinutes = worldMinutesForState(state);
      const secured = zombieState ? isNodeSecured(zombieState, totalMinutes) : true;
      const encounterActive = Boolean(zombieState && zombieState.count > 0 && !secured);
      const evasionSecured = Boolean(zombieState && zombieState.count > 0 && secured);
      const actionIds = [...(node?.actions ?? ['search', 'scout', 'rest'])];
      if ((node?.danger ?? 0) >= 2 || (zombieState?.count ?? 0) > 0) actionIds.push('evade', 'combat_melee', 'combat_firearm');
      if (node?.type === 'wilds') actionIds.push('forage');
      if (state.currentNodeId === state.spawnLocation?.id) actionIds.push('fortify', 'sleep');
      else if ((node?.danger ?? 9) <= 2 && !actionIds.includes('rest')) actionIds.push('rest', 'sleep');
      return [...new Set(actionIds)]
        .map((id) => {
          const action = mapNodeActions.find((entry) => entry.id === id);
          if (!action) return null;
          let disabledReason = '';
          const actionMinutes = durationForAction(id);
          const encounterAction = ['evade', 'combat_melee', 'combat_firearm'].includes(id);
          if (encounterActive && !encounterAction) disabledReason = `附近还有 ${zombieState.count} 只游荡者，先战斗或绕行`;
          if (encounterAction && (zombieState?.count ?? 0) <= 0) disabledReason = '这个地区暂时已经清空';
          if (!encounterAction && evasionSecured && totalMinutes + actionMinutes > zombieState.evasionUntilMinutes) {
            disabledReason = '临时安全窗口不足以完成这项行动';
          }
          if (id === 'combat_firearm') {
            const hasUsableFirearm = state.inventory
              .filter((item) => item.count > 0 && item.tags?.includes('firearm'))
              .some((firearm) => state.inventory.some((item) => item.id === (firearm.id === 'shotgun' ? 'shotgun_shells' : '9mm_rounds') && item.count > 0));
            if (!hasUsableFirearm && !disabledReason) disabledReason = '需要枪械和对应弹药';
          }
          if (id === 'fortify') {
            const has = (itemId) => state.inventory.some((item) => item.id === itemId && item.count > 0);
            if ((!has('hammer') || !has('plank') || !has('nails')) && !disabledReason) disabledReason = '需要锤子、木板和钉子';
          }
          if (id === 'search' && (state.nodeSearchCounts?.[node?.id] ?? 0) >= 3 && !disabledReason) disabledReason = '周边已被搜空，请检查具体建筑容器';
          return {
            ...action,
            minutes: actionMinutes,
            disabled: Boolean(disabledReason),
            disabledReason,
          };
        })
        .filter(Boolean);
    },
    currentNodeType: (state) => {
      const node = mapNodes.find((entry) => entry.id === state.currentNodeId);
      return mapNodeTypes.find((type) => type.id === node?.type) ?? null;
    },
  },
  actions: {
    loadPersistedState() {
      let raw = null;
      try {
        raw = localStorage.getItem('moshi-survival-state');
      } catch {
        return;
      }
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed?.game || typeof parsed.game !== 'object') return;
        if (Number(parsed.game.saveVersion) > SAVE_VERSION) {
          try {
            localStorage.setItem('moshi-survival-state-future-backup', raw);
          } catch {
            // The current save remains untouched even if a backup cannot be written.
          }
          return;
        }
        this.$patch(parsed.game);
        this.migrateLegacySurvivalState(parsed.game);
        this.normalizeCatalogReferences();
        if (!parsed?.game?.vitals || !parsed?.game?.skills) this.recalculateCharacterState(false);
      } catch {
        try {
          localStorage.setItem('moshi-survival-state-corrupt-backup', raw);
        } catch {
          // Storage may be unavailable; resetting the in-memory game is still safe.
        }
        try {
          localStorage.removeItem('moshi-survival-state');
        } catch {
          // Ignore storage backends that reject writes and deletes.
        }
      }
    },
    resetGame() {
      const archives = this.archives;
      this.$patch(defaultState());
      this.archives = archives;
    },
    migrateLegacySurvivalState(rawState = {}) {
      const hasOwn = (key) => Object.prototype.hasOwnProperty.call(rawState, key);
      const location = spawnLocations.find((entry) => entry.id === this.spawnLocation?.id) ?? spawnLocations[0];
      const shelter = shelters.find((entry) => entry.id === this.shelter?.id) ?? null;
      const node = mapNodes.find((entry) => entry.id === (this.currentNodeId ?? location.id)) ?? mapNodes.find((entry) => entry.id === location.id);
      if (!hasOwn('clockMinutes')) this.clockMinutes = START_MINUTE;
      if (!hasOwn('world')) {
        this.world = createWorldState({
          day: clampInteger(this.day, 1, 999, 1),
          spawnId: location.id,
          nodeDanger: node?.danger ?? 3,
          shelterDefense: shelter?.defense ?? 0,
        });
      }
      if (!hasOwn('base')) this.base = createBaseState(shelter);
      if (!hasOwn('survivalStats')) this.survivalStats = createSurvivalStats();
      if (!hasOwn('equippedWeaponId')) this.equippedWeaponId = null;
      if (!hasOwn('nodeSearchCounts')) this.nodeSearchCounts = {};
      if (!hasOwn('skillXp')) this.skillXp = createSkillExperience(normalizeSkills(this.skills));
      if (!hasOwn('lastSkillGains')) this.lastSkillGains = {};
      if (!hasOwn('nodeZombieStates')) {
        this.nodeZombieStates = normalizeNodeZombieStates({}, {
          nodes: mapNodes,
          seed: this.world?.seed,
          day: clampInteger(this.day, 1, 999, 1),
        });
        const spawnState = this.nodeZombieStates[location.id];
        if (spawnState) {
          spawnState.count = 0;
          spawnState.clearedDay = clampInteger(this.day, 1, 999, 1);
        }
        const currentState = this.nodeZombieStates[node?.id];
        if (currentState && node.id !== location.id && currentState.count > 0) {
          this.nodeZombieStates[node.id] = grantEvasionWindow(currentState, {
            totalMinutes: worldMinutesForState(this.$state),
            minutes: 240,
          });
        }
      }
      if (!hasOwn('body')) {
        const tags = new Set(Array.isArray(this.hiddenTags) ? this.hiddenTags : []);
        const body = createBodyState();
        if (tags.has('疑似咬伤')) {
          body.wounds.push(legacyWound('bite', 5, true));
          body.infectionLevel = 12;
        } else if (tags.has('感染')) {
          body.wounds.push({ ...legacyWound('laceration', 3, false), infected: true });
          body.infectionLevel = 18;
        } else if (tags.has('受伤')) {
          body.wounds.push(legacyWound('laceration', 2, false));
        }
        this.body = body;
      }
      this.saveVersion = SAVE_VERSION;
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
      if (this.runPhase !== 'setup') return false;
      this.survivorName = name;
      const preset = findHiddenSurvivorPreset(name);
      if (preset) {
        return this.applyHiddenSurvivorPreset(preset);
      }
      if (this.profession?.hiddenOnly && !this.unlockedProfessionIds.includes(this.profession.id)) {
        this.profession = null;
        this.selectedTraits = [];
        this.inventory = [];
        this.clearLootSearch();
        this.clearMapState();
      }
      return true;
    },
    selectSpawnLocation(id) {
      if (this.runPhase !== 'setup') return false;
      const location = spawnLocations.find((item) => item.id === id);
      if (!location) return false;
      this.spawnLocation = cloneCatalogRecord(location);
      this.clearMapState();
      if (this.profession) this.recalculateCharacterState(false);
      return true;
    },
    selectProfession(id) {
      if (this.runPhase !== 'setup') return false;
      if (this.isHiddenPresetLocked && id !== this.activeHiddenPreset.professionId) return false;
      const profession = professions.find((item) => item.id === id);
      if (!profession || (profession.hiddenOnly && !this.unlockedProfessionIds.includes(id))) return false;
      this.profession = cloneCatalogRecord(profession);
      this.selectedTraits = [];
      this.inventory = [];
      this.shelter = null;
      this.shelterChoices = [];
      this.shelterRollsUsed = 0;
      this.clearLootSearch();
      this.activeEvent = null;
      this.clearMapState();
      this.recalculateCharacterState(true);
      return true;
    },
    applyHiddenSurvivorPreset(preset) {
      if (this.runPhase !== 'setup') return false;
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
      this.clearLootSearch();
      this.activeEvent = null;
      this.clearMapState();
      this.recalculateCharacterState(true);
      return true;
    },
    normalizeCatalogReferences() {
      this.saveVersion = SAVE_VERSION;
      const scenario = scenarios.find((item) => item.id === this.scenario?.id) ?? scenarios[0];
      const location = spawnLocations.find((item) => item.id === this.spawnLocation?.id) ?? spawnLocations[0];
      const profession = this.profession ? professions.find((item) => item.id === this.profession.id) : null;
      const shelter = this.shelter ? shelters.find((item) => item.id === this.shelter.id) : null;
      this.scenario = cloneCatalogRecord(scenario);
      this.day = clampInteger(this.day, 1, 999, 1);
      this.maxDay = clampInteger(scenario.maxDay, 1, 999, 20);
      this.clockMinutes = ((clampInteger(this.clockMinutes, 0, 24 * 60 - 1, START_MINUTE) % (24 * 60)) + 24 * 60) % (24 * 60);
      this.money = clampInteger(this.money, 0, 9999999, 6500);
      this.survivorName = typeof this.survivorName === 'string' ? this.survivorName.slice(0, 48) : '';
      this.spawnLocation = cloneCatalogRecord(location);
      this.profession = profession ? cloneCatalogRecord(profession) : null;
      this.shelter = shelter ? cloneCatalogRecord(shelter) : null;
      this.shelterChoices = Array.isArray(this.shelterChoices)
        ? this.shelterChoices
            .map((choice) => shelters.find((item) => item.id === choice?.id))
            .filter(Boolean)
            .filter((choice) => isShelterAvailableForLocation(choice, location.id))
            .map(cloneCatalogRecord)
        : [];
      this.shelterRollsUsed = Number.isFinite(this.shelterRollsUsed) ? Math.max(0, this.shelterRollsUsed) : 0;
      this.maxShelterRolls = 10;
      this.searchingSlotId = null;
      this.vitals = normalizeVitals(this.vitals, this.stats);
      this.skills = normalizeSkills(this.skills);
      this.skillXp = normalizeSkillExperience(this.skillXp, this.skills, skillDefinitions.map((skill) => skill.id));
      this.lastSkillGains = normalizeSkillGains(this.lastSkillGains);
      const rawInventory = Array.isArray(this.inventory) ? this.inventory : [];
      this.inventory = normalizeInventory(rawInventory);
      this.selectedTraits = Array.isArray(this.selectedTraits)
        ? this.selectedTraits
            .map((trait) => traits.find((entry) => entry.id === trait?.id))
            .filter(Boolean)
            .map(cloneCatalogRecord)
        : [];
      this.baseTraitPoints = this.profession?.traitPointMod ?? 0;
      this.lootSlots = this.shelter ? normalizeLootSlots(this.lootSlots, this.shelter) : [];
      this.lootSearchStarted = Boolean(this.shelter && this.lootSlots.some((slot) => slot.status !== 'hidden'));
      const currentNode = mapNodes.find((node) => node.id === this.currentNodeId);
      this.currentNodeId = currentNode ? currentNode.id : null;
      const inspectedNode = mapNodes.find((node) => node.id === this.inspectedNodeId);
      this.inspectedNodeId = inspectedNode ? inspectedNode.id : this.currentNodeId;
      this.visitedNodeIds = uniqueValidNodeIds(this.visitedNodeIds);
      this.knownNodeIds = uniqueValidNodeIds(this.knownNodeIds);
      if (this.currentNodeId) {
        this.visitedNodeIds = uniqueValidNodeIds([...this.visitedNodeIds, this.currentNodeId]);
        this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, this.currentNodeId, ...neighborsForNode(this.currentNodeId)]);
        if (!this.inspectedNodeId) this.inspectedNodeId = this.currentNodeId;
      }
      this.vehicle = normalizeVehicle(this.vehicle);
      this.movesRemaining = Number.isFinite(this.movesRemaining) ? Math.max(0, Math.round(this.movesRemaining)) : 1;
      this.mapLog = Array.isArray(this.mapLog) ? this.mapLog.slice(0, 80) : [];
      this.history = normalizeHistory(this.history);
      this.hiddenTags = Array.isArray(this.hiddenTags)
        ? [...new Set(this.hiddenTags.filter((tag) => typeof tag === 'string' && tag).map((tag) => tag.slice(0, 40)))].slice(0, 40)
        : [];
      this.archives = normalizeArchives(this.archives);
      this.ending = this.ending && typeof this.ending === 'object' ? this.ending : null;
      this.searchedSceneObjectIds = Array.isArray(this.searchedSceneObjectIds)
        ? [...new Set(this.searchedSceneObjectIds.filter(Boolean))].slice(0, 240)
        : [];
      this.nodeSearchCounts = normalizeNodeSearchCounts(this.nodeSearchCounts);
      const currentDanger = mapNodes.find((node) => node.id === this.currentNodeId)?.danger ?? 3;
      this.world = normalizeWorldState(this.world, {
        day: this.day,
        spawnId: this.spawnLocation?.id,
        nodeDanger: currentDanger,
        shelterDefense: this.shelter?.defense ?? 0,
      });
      this.nodeZombieStates = normalizeNodeZombieStates(this.nodeZombieStates, {
        nodes: mapNodes,
        seed: this.world.seed,
        day: this.day,
      });
      this.body = normalizeBodyState(this.body);
      this.base = normalizeBaseState(this.base, this.shelter);
      this.world.powerOn = this.day < this.world.powerShutoffDay || (this.base.generatorOn && this.base.generatorFuel > 0);
      this.world.waterOn = this.day < this.world.waterShutoffDay;
      this.survivalStats = normalizeSurvivalStats(this.survivalStats);
      this.equippedWeaponId = this.inventory.some((item) => item.id === this.equippedWeaponId && item.tags?.includes('weapon'))
        ? this.equippedWeaponId
        : null;
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
      this.skillXp = createSkillExperience(skills, skillDefinitions.map((skill) => skill.id));
      this.lastSkillGains = {};
      if (!includeUnlocks) return;
      this.profession.unlocks?.forEach((itemId) => {
        const item = marketItems.find((entry) => entry.id === itemId);
        if (item) this.addItem(item, 1, true);
      });
    },
    toggleTrait(id) {
      if (this.runPhase !== 'setup') return false;
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
      if (this.runPhase !== 'setup') return false;
      if (this.isHiddenPresetLocked) return this.selectedTraits.some((item) => item.id === id);
      const trait = traits.find((item) => item.id === id);
      if (!trait) return false;
      if (this.selectedTraits.some((item) => item.id === id)) return true;
      return !this.selectedTraits.some((item) => item.conflicts?.includes(id) || trait.conflicts?.includes(item.id));
    },
    rollShelters() {
      if (this.runPhase !== 'setup') return false;
      if (this.shelter || this.shelterRollsUsed >= this.maxShelterRolls) return false;
      this.shelterChoices = drawShelterChoices(3, this.spawnLocation?.id).map(cloneCatalogRecord);
      this.shelterRollsUsed += 1;
      return true;
    },
    selectShelter(id) {
      if (this.runPhase !== 'setup') return false;
      const shelter = this.shelterChoices.find((item) => item.id === id);
      if (!shelter) return false;
      this.shelter = cloneCatalogRecord(shelter);
      this.lootSlots = createLootSlotsForShelter(this.shelter);
      this.lootSearchStarted = false;
      this.searchingSlotId = null;
      this.clearMapState();
      this.base = createBaseState(this.shelter);
      this.world = createWorldState({
        day: this.day,
        spawnId: this.spawnLocation?.id,
        nodeDanger: mapNodes.find((node) => node.id === this.spawnLocation?.id)?.danger ?? 3,
        shelterDefense: this.shelter?.defense ?? 0,
      });
      return true;
    },
    ensureLootSlots() {
      if (!this.shelter) return false;
      if (!Array.isArray(this.lootSlots) || !this.lootSlots.length) {
        this.lootSlots = createLootSlotsForShelter(this.shelter);
        this.lootSearchStarted = false;
      }
      this.searchingSlotId = null;
      return true;
    },
    clearLootSearch() {
      this.lootSlots = [];
      this.lootSearchStarted = false;
      this.searchingSlotId = null;
    },
    async searchLootSlot(slotId) {
      if (this.runPhase !== 'setup') return false;
      if (this.searchingSlotId) return false;
      const slot = this.lootSlots.find((entry) => entry.id === slotId);
      if (!slot || slot.status !== 'hidden') return false;
      slot.status = 'searching';
      this.searchingSlotId = slot.id;
      this.lootSearchStarted = true;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
      if (this.runPhase !== 'setup') {
        slot.status = 'hidden';
        this.searchingSlotId = null;
        return false;
      }
      const item = marketItems.find((entry) => entry.id === slot.itemId);
      const collected = item ? this.collectLootItem(item) : false;
      slot.status = collected ? 'taken' : 'revealed';
      this.searchingSlotId = null;
      return collected;
    },
    async searchAllLootSlots() {
      if (this.runPhase !== 'setup') return false;
      if (this.searchingSlotId) return false;
      const slots = this.lootSlots.filter((entry) => entry.status === 'hidden');
      if (!slots.length) return false;
      slots.forEach((slot) => {
        slot.status = 'searching';
      });
      this.searchingSlotId = 'bulk';
      this.lootSearchStarted = true;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
      if (this.runPhase !== 'setup') {
        slots.forEach((slot) => {
          if (slot.status === 'searching') slot.status = 'hidden';
        });
        this.searchingSlotId = null;
        return false;
      }
      slots.forEach((slot) => {
        if (slot.status !== 'searching') return;
        const item = marketItems.find((entry) => entry.id === slot.itemId);
        const collected = item ? this.collectLootItem(item) : false;
        slot.status = collected ? 'taken' : 'revealed';
      });
      this.searchingSlotId = null;
      return true;
    },
    collectLootItem(item, count = 1) {
      const quantity = positiveInteger(count);
      if (!item || !quantity || this.remainingSpace < item.space * quantity) return false;
      const existing = this.inventory.find((entry) => entry.id === item.id);
      if (existing) existing.count += quantity;
      else this.inventory.push({ ...cloneCatalogRecord(item), count: quantity });
      return true;
    },
    addItem(item, count = 1, free = false) {
      const quantity = positiveInteger(count);
      if (!item || !quantity) return false;
      if (this.remainingSpace < item.space * quantity) return false;
      if (!free && this.money < item.price * quantity) return false;
      const existing = this.inventory.find((entry) => entry.id === item.id);
      if (existing) existing.count += quantity;
      else this.inventory.push({ ...cloneCatalogRecord(item), count: quantity });
      if (!free) this.money -= item.price * quantity;
      return true;
    },
    removeItem(id, count = 1) {
      const quantity = positiveInteger(count);
      if (!quantity) return false;
      const item = this.inventory.find((entry) => entry.id === id || entry.name === id);
      if (!item || item.count < quantity) return false;
      item.count -= quantity;
      if (item.count <= 0) this.inventory = this.inventory.filter((entry) => entry !== item);
      if (this.equippedWeaponId === item.id && !this.inventory.some((entry) => entry.id === item.id)) this.equippedWeaponId = null;
      return true;
    },
    equipWeapon(id) {
      if (this.isGameOver) return false;
      const weapon = this.inventory.find((item) => item.id === id && item.count > 0 && item.tags?.includes('weapon'));
      if (!weapon) return false;
      this.equippedWeaponId = this.equippedWeaponId === id ? null : id;
      return true;
    },
    useItem(id) {
      if (this.isGameOver) return false;
      const item = this.inventory.find((entry) => entry.id === id && entry.count > 0);
      if (!item || !['food', 'medical', 'morale'].includes(item.category)) return false;
      const useMinutes = item.category === 'medical' ? 30 : item.tags?.includes('water') ? 10 : item.category === 'food' ? 20 : 10;
      if (!this.canPerformWorldAction('item', useMinutes)) return false;
      const wound = selectTreatmentWound(this.body?.wounds ?? [], item);
      const requiresWound = item.tags?.includes('bandage') || item.tags?.includes('disinfect') || item.id === 'first_aid_kit';
      if (requiresWound && !wound) return false;
      const treatsWound = Boolean(requiresWound && wound);
      if (item.tags?.includes('bandage') && wound) {
        wound.bandaged = true;
        wound.dirtyBandage = false;
        wound.bandageAgeHours = 0;
        wound.bleeding = false;
      }
      if (item.tags?.includes('disinfect') && wound) {
        wound.disinfected = true;
        if (!wound.knoxInfection) wound.infected = false;
        this.body.infectionLevel = Math.max(0, this.body.infectionLevel - (item.id === 'disinfectant' ? 8 : 4));
      }
      if (item.id === 'first_aid_kit' && wound) {
        wound.bandaged = true;
        wound.dirtyBandage = false;
        wound.bandageAgeHours = 0;
        wound.bleeding = false;
        wound.disinfected = true;
        if (!wound.knoxInfection) wound.infected = false;
      }
      if (item.id === 'antibiotics') {
        const hasKnoxInfection = (this.body?.wounds ?? []).some((entry) => entry.knoxInfection);
        this.body.infectionLevel = Math.max(0, this.body.infectionLevel - (hasKnoxInfection ? 5 : 22));
        if (!hasKnoxInfection && this.body.infectionLevel < 1) this.body.infectionLevel = 0;
      }
      if (item.id === 'painkillers') this.body.pain = Math.max(0, this.body.pain - 28);
      applyVitalMods(this.vitals, item.effects ?? {});
      if (item.id === 'foraged_mushrooms' && !this.selectedTraits.some((trait) => trait.id === 'herbalist') && (this.world.seed + this.day) % 5 === 0) {
        applyVitalMods(this.vitals, { health: -8, stress: 10 });
        if (!this.hiddenTags.includes('食物中毒')) this.hiddenTags.push('食物中毒');
      }
      this.removeItem(item.id, 1);
      const progression = this.grantSkillXp(treatsWound
        ? { first_aid: item.id === 'first_aid_kit' ? 18 : 10 }
        : {});
      const levelUpText = levelUpSummary(progression);
      this.mapLog.unshift({
        day: this.day,
        time: this.clockLabel,
        title: `使用 ${item.name}`,
        text: [treatsWound ? `你处理了${bodyPartLabels[wound.bodyPart] ?? wound.bodyPart}的${woundTypeLabels[wound.type] ?? wound.type}。` : `${item.name}已经消耗。`, levelUpText].filter(Boolean).join(' '),
        mode: 'item',
      });
      this.mapLog = this.mapLog.slice(0, 80);
      this.survivalStats.actions += 1;
      this.advanceSimulation({
        minutes: useMinutes,
        mode: 'rest',
        noiseDelta: -1,
        threatDelta: 0,
      });
      this.finishIfGameOver();
      return true;
    },
    craftRecipe(recipeId) {
      if (this.isGameOver) return false;
      const recipe = craftingRecipes.find((entry) => entry.id === recipeId);
      if (!recipe) return false;
      const craftMinutes = recipe.minutes ?? durationForAction('craft');
      if (!this.canPerformWorldAction('craft', craftMinutes)) return false;
      const status = recipeStatus(recipe, this.$state);
      if (!status.canCraft) return false;
      recipe.ingredients.forEach((ingredient) => this.removeItem(ingredient.itemId, ingredient.count));
      const result = marketItems.find((item) => item.id === recipe.resultId);
      if (!result || !this.collectLootItem(result, recipe.resultCount ?? 1)) return false;
      this.survivalStats.crafted += 1;
      this.survivalStats.actions += 1;
      const progression = this.grantSkillXp({ [recipe.skillId]: 18 + (recipe.minSkill ?? 0) * 3 });
      const levelUpText = levelUpSummary(progression);
      const beforeDay = this.day;
      const beforeTime = this.clockLabel;
      this.advanceSimulation({
        minutes: craftMinutes,
        mode: 'active',
        noiseDelta: 8,
        threatDelta: 2,
      });
      this.history.push({
        day: beforeDay,
        time: beforeTime,
        title: recipe.name,
        log: '制作与维护',
        action: recipe.name,
        result: `你制作了${result.name}。`,
        notes: [`耗时 ${Math.round((recipe.minutes ?? 120) / 60 * 10) / 10} 小时`, levelUpText].filter(Boolean).join(' / '),
        score: 60 + (this.skills[recipe.skillId] ?? 0) * 4,
      });
      this.mapLog.unshift({ day: beforeDay, time: beforeTime, title: recipe.name, text: [`制作完成：${result.name}`, levelUpText].filter(Boolean).join(' '), mode: 'craft' });
      this.finishIfGameOver();
      return true;
    },
    toggleGenerator() {
      if (this.isGameOver || !this.isAtHome) return false;
      if (!this.canPerformWorldAction('base', 20)) return false;
      const generator = this.inventory.find((item) => item.id === 'generator' && item.count > 0);
      const knowsGenerator = this.inventory.some((item) => item.id === 'how_to_use_generators' && item.count > 0) || (this.skills.electrical ?? 0) >= 3;
      if (!generator || !knowsGenerator) return false;
      if (this.base.generatorOn) {
        this.base.generatorOn = false;
        this.world.powerOn = this.day < this.world.powerShutoffDay;
        this.grantSkillXp({});
        return true;
      }
      if (this.base.generatorFuel <= 0) {
        if (!this.removeItem('gas_can', 1)) return false;
        this.base.generatorFuel = 3;
      }
      this.base.generatorOn = true;
      this.world.powerOn = true;
      this.world.noise = Math.min(100, this.world.noise + 18);
      this.world.threat = Math.min(100, this.world.threat + 8);
      this.mapLog.unshift({ day: this.day, time: this.clockLabel, title: '启动发电机', text: '据点恢复供电，但引擎低鸣会持续吸引附近尸群。', mode: 'base' });
      this.survivalStats.actions += 1;
      this.grantSkillXp({ electrical: 8 });
      this.advanceSimulation({ minutes: 20, mode: 'active', noiseDelta: 4, threatDelta: 2 });
      this.finishIfGameOver();
      return true;
    },
    drinkBaseWater() {
      if (this.isGameOver || !this.isAtHome || (this.base.waterReserve ?? 0) <= 0) return false;
      if (!this.canPerformWorldAction('base', 10)) return false;
      this.base.waterReserve -= 1;
      applyVitalMods(this.vitals, { thirst: -28 });
      this.survivalStats.actions += 1;
      this.grantSkillXp({});
      this.advanceSimulation({ minutes: 10, mode: 'rest', noiseDelta: -1 });
      this.finishIfGameOver();
      return true;
    },
    clearMapState() {
      this.currentNodeId = null;
      this.inspectedNodeId = null;
      this.visitedNodeIds = [];
      this.knownNodeIds = [];
      this.vehicle = { status: 'none', fuel: 0, name: '徒步', condition: 0 };
      this.movesRemaining = 1;
      this.mapLog = [];
      this.searchedSceneObjectIds = [];
      this.nodeSearchCounts = {};
      this.nodeZombieStates = {};
    },
    ensureNodeZombieState(nodeId) {
      const node = mapNodes.find((entry) => entry.id === nodeId);
      if (!node) return null;
      const missing = !this.nodeZombieStates?.[node.id];
      const current = this.nodeZombieStates?.[node.id] ?? createNodeZombieState({
        nodeId: node.id,
        danger: node.danger,
        seed: this.world?.seed,
        day: this.day,
      });
      if (missing && node.id === this.spawnLocation?.id) {
        current.count = 0;
        current.clearedDay = this.day;
      }
      const refreshed = refreshNodeZombieState(current, {
        danger: node.danger,
        seed: this.world?.seed,
        day: this.day,
        worldThreat: this.world?.threat,
      });
      this.nodeZombieStates = { ...(this.nodeZombieStates ?? {}), [node.id]: refreshed };
      return refreshed;
    },
    refreshNodeZombieMigration() {
      const previousCurrent = this.nodeZombieStates?.[this.currentNodeId]?.count ?? null;
      const refreshed = {};
      mapNodes.forEach((node) => {
        const current = this.nodeZombieStates?.[node.id] ?? createNodeZombieState({
          nodeId: node.id,
          danger: node.danger,
          seed: this.world?.seed,
          day: this.day,
        });
        refreshed[node.id] = refreshNodeZombieState(current, {
          danger: node.danger,
          seed: this.world?.seed,
          day: this.day,
          worldThreat: this.world?.threat,
        });
      });
      this.nodeZombieStates = refreshed;
      const currentCount = refreshed[this.currentNodeId]?.count ?? null;
      return previousCurrent === 0 && currentCount > 0 ? currentCount : 0;
    },
    grantSkillXp(gains = {}) {
      const progression = applySkillExperience({
        skills: this.skills,
        skillXp: this.skillXp,
        gains,
        skillIds: skillDefinitions.map((skill) => skill.id),
      });
      this.skills = progression.skills;
      this.skillXp = progression.skillXp;
      this.lastSkillGains = progression.appliedGains;
      return progression;
    },
    canPerformWorldAction(kind = 'world', minutes = 0, requireFullWindow = true) {
      if (this.isGameOver) return false;
      if (!this.currentNodeId) return true;
      const zombieState = this.nodeZombieStates?.[this.currentNodeId];
      if (!zombieState) return false;
      if (zombieState.count <= 0) return true;
      const encounterActions = new Set(['combat', 'evade', 'equip']);
      if (encounterActions.has(kind)) return true;
      const now = this.totalWorldMinutes;
      if (!isNodeSecured(zombieState, now)) return false;
      if (!requireFullWindow) return true;
      const duration = Math.max(0, Math.round(Number(minutes) || 0));
      return now + duration <= zombieState.evasionUntilMinutes;
    },
    initializeMapState(force = false) {
      if (this.currentNodeId && !force) {
        this.nodeZombieStates = normalizeNodeZombieStates(this.nodeZombieStates, {
          nodes: mapNodes,
          seed: this.world?.seed,
          day: this.day,
        });
        this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, this.currentNodeId, ...neighborsForNode(this.currentNodeId)]);
        if (!this.inspectedNodeId) this.inspectedNodeId = this.currentNodeId;
        this.movesRemaining = this.movementAllowance();
        return true;
      }
      const spawnNode = mapNodes.find((node) => node.id === this.spawnLocation?.id) ?? mapNodes.find((node) => node.id === 'muldraugh');
      if (!spawnNode) return false;
      this.currentNodeId = spawnNode.id;
      this.inspectedNodeId = spawnNode.id;
      this.visitedNodeIds = [spawnNode.id];
      this.knownNodeIds = uniqueValidNodeIds([spawnNode.id, ...neighborsForNode(spawnNode.id)]);
      this.vehicle = normalizeVehicle(this.vehicle);
      this.movesRemaining = this.movementAllowance();
      this.world = normalizeWorldState(this.world, {
        day: this.day,
        spawnId: this.spawnLocation?.id,
        nodeDanger: spawnNode.danger,
        shelterDefense: this.shelter?.defense ?? 0,
      });
      const hadZombieStates = Boolean(Object.keys(this.nodeZombieStates ?? {}).length);
      this.nodeZombieStates = normalizeNodeZombieStates(this.nodeZombieStates, {
        nodes: mapNodes,
        seed: this.world.seed,
        day: this.day,
      });
      if (!hadZombieStates) {
        const spawnState = this.nodeZombieStates[spawnNode.id];
        if (spawnState) {
          spawnState.count = 0;
          spawnState.clearedDay = this.day;
        }
      }
      this.activeEvent = null;
      this.mapLog = [{
        day: this.day,
        title: '地图展开',
        text: `你从${spawnNode.name}开始标记路线，初始避难所是${this.shelter?.name ?? '未知据点'}。`,
      }];
      return true;
    },
    visibleMapNodes() {
      return buildVisibleMapNodes(this.$state);
    },
    movementAllowance() {
      if (this.vehicle?.status === 'working' && (this.vehicle.fuel ?? 0) > 0) return 3;
      if (this.vehicle?.status === 'damaged' && (this.vehicle.fuel ?? 0) > 0) return 2;
      return 1;
    },
    canMoveToNode(nodeId) {
      const travelMinutes = durationForAction('move', { vehicle: this.vehicle });
      return this.vitals.endurance > 4 &&
        neighborsForNode(this.currentNodeId).includes(nodeId) &&
        this.canPerformWorldAction('move', travelMinutes, false);
    },
    inspectMapNode(nodeId) {
      const node = mapNodes.find((entry) => entry.id === nodeId);
      if (!node) return false;
      this.inspectedNodeId = node.id;
      return true;
    },
    moveToNode(nodeId) {
      if (this.isGameOver) return false;
      const node = mapNodes.find((entry) => entry.id === nodeId);
      if (!node || !this.canMoveToNode(nodeId)) return false;
      const from = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const travelVehicle = normalizeVehicle(this.vehicle);
      this.ensureNodeZombieState(node.id);
      const previousMapState = {
        currentNodeId: this.currentNodeId,
        inspectedNodeId: this.inspectedNodeId,
        visitedNodeIds: [...this.visitedNodeIds],
        knownNodeIds: [...this.knownNodeIds],
        vehicle: { ...this.vehicle },
        movesRemaining: this.movesRemaining,
      };
      const outcome = resolveMapMove({
        day: this.day,
        node,
        inventory: this.inventory,
        tags: this.hiddenTags,
        traits: this.selectedTraits,
        vitals: this.vitals,
        skills: this.skills,
        vehicle: travelVehicle,
        world: this.world,
      });
      outcome.title = `${from?.name ?? '未知地点'} → ${node.name}`;
      outcome.skillXpGains = skillGainsForMapAction({
        actionId: 'move',
        outcome,
        inventory: this.inventory,
        equippedWeaponId: this.equippedWeaponId,
        node,
        vehicle: travelVehicle,
      });
      this.currentNodeId = node.id;
      this.inspectedNodeId = node.id;
      this.visitedNodeIds = uniqueValidNodeIds([...this.visitedNodeIds, node.id]);
      this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, node.id, ...neighborsForNode(node.id)]);
      const usingVehicle = this.vehicle?.status !== 'none' && (this.vehicle.fuel ?? 0) > 0;
      if (usingVehicle) {
        this.vehicle.fuel = Math.max(0, (this.vehicle.fuel ?? 0) - 1);
      }
      this.movesRemaining = this.movementAllowance();
      if (this.applyMapOutcome(outcome, 'move', true)) return true;
      this.currentNodeId = previousMapState.currentNodeId;
      this.inspectedNodeId = previousMapState.inspectedNodeId;
      this.visitedNodeIds = previousMapState.visitedNodeIds;
      this.knownNodeIds = previousMapState.knownNodeIds;
      this.vehicle = previousMapState.vehicle;
      this.movesRemaining = previousMapState.movesRemaining;
      return false;
    },
    resolveNodeAction(actionId) {
      if (this.isGameOver) return false;
      if (!this.currentNodeId) this.initializeMapState();
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const action = mapNodeActions.find((entry) => entry.id === actionId);
      if (node) this.ensureNodeZombieState(node.id);
      const availableAction = this.currentNodeActions.find((entry) => entry.id === actionId);
      if (!node || !action || !availableAction || availableAction.disabled) return false;
      const encounterKind = actionId === 'evade' ? 'evade' : ['combat_melee', 'combat_firearm'].includes(actionId) ? 'combat' : actionId;
      if (!this.canPerformWorldAction(encounterKind, durationForAction(actionId))) return false;
      const outcome = resolveMapNodeAction({
        actionId,
        node,
        day: this.day,
        clockMinutes: this.clockMinutes,
        inventory: this.inventory,
        tags: this.hiddenTags,
        traits: this.selectedTraits,
        vitals: this.vitals,
        skills: this.skills,
        profession: this.profession,
        vehicle: this.vehicle,
        world: this.world,
        body: this.body,
        base: this.base,
        equippedWeaponId: this.equippedWeaponId,
        searchCount: this.nodeSearchCounts[node.id] ?? 0,
        zombiePopulation: this.nodeZombieStates[node.id]?.count ?? 0,
      });
      if (!outcome || !(outcome.minutes > 0)) return false;
      if (['combat_melee', 'combat_firearm'].includes(actionId)) outcome.zombieKills = outcome.kills;
      if (actionId === 'evade' && outcome.score >= 55) outcome.encounterEvasionMinutes = 180;
      outcome.skillXpGains = skillGainsForMapAction({
        actionId,
        outcome,
        inventory: this.inventory,
        equippedWeaponId: this.equippedWeaponId,
        node,
        vehicle: this.vehicle,
      });
      if (!this.applyMapOutcome(outcome, 'action')) return false;
      if (actionId === 'search') this.nodeSearchCounts[node.id] = (this.nodeSearchCounts[node.id] ?? 0) + 1;
      return true;
    },
    resolveSceneSearch(searchable, collectedItems = [], searchKey = '') {
      if (this.isGameOver || (searchKey && this.searchedSceneObjectIds.includes(searchKey))) return false;
      if (!this.currentNodeId) this.initializeMapState();
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      if (!node || !(node.actions ?? []).includes('search')) return false;
      this.ensureNodeZombieState(node.id);
      if (!this.canPerformWorldAction('search', durationForAction('search'))) return false;
      const outcome = resolveMapNodeAction({
        actionId: 'search',
        node,
        day: this.day,
        clockMinutes: this.clockMinutes,
        inventory: this.inventory,
        tags: this.hiddenTags,
        traits: this.selectedTraits,
        vitals: this.vitals,
        skills: this.skills,
        profession: this.profession,
        vehicle: this.vehicle,
        world: this.world,
        body: this.body,
        base: this.base,
        equippedWeaponId: this.equippedWeaponId,
        manualLoot: {
          sourceName: searchable?.name ?? node.name,
          collectedItems,
        },
        zombiePopulation: this.nodeZombieStates[node.id]?.count ?? 0,
      });
      outcome.skillXpGains = skillGainsForMapAction({
        actionId: 'search',
        outcome,
        inventory: this.inventory,
        equippedWeaponId: this.equippedWeaponId,
        node,
        vehicle: this.vehicle,
      });
      if (!this.applyMapOutcome(outcome, 'search')) return false;
      if (searchKey) this.markSceneSearchableSearched(searchKey);
      return true;
    },
    markSceneSearchableSearched(searchKey) {
      if (!searchKey || this.searchedSceneObjectIds.includes(searchKey)) return false;
      this.searchedSceneObjectIds = [...this.searchedSceneObjectIds, searchKey].slice(-240);
      return true;
    },
    applyMapOutcome(outcome, mode = 'action', allowTerminalCommit = false) {
      if (!outcome || (this.isGameOver && !allowTerminalCommit)) return false;
      const projectedInventory = this.inventory.map((item) => ({ ...cloneCatalogRecord(item), count: item.count }));
      for (const itemId of outcome.consume ?? []) {
        const item = projectedInventory.find((entry) => entry.id === itemId || entry.name === itemId);
        if (!item || item.count < 1) return false;
        item.count -= 1;
      }
      for (const item of outcome.add ?? []) {
        const quantity = positiveInteger(item?.count ?? 1);
        if (!item || !quantity || !Number.isFinite(Number(item.space)) || Number(item.space) < 0) return false;
        const existing = projectedInventory.find((entry) => entry.id === item.id);
        if (existing) existing.count += quantity;
        else projectedInventory.push({ ...cloneCatalogRecord(item), count: quantity });
      }
      const committedInventory = projectedInventory.filter((item) => item.count > 0);
      const projectedUsedSpace = committedInventory.reduce((sum, item) => sum + item.space * item.count, 0);
      if (projectedUsedSpace > inventoryCapacityForState(this.$state, committedInventory)) return false;
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const actionDay = this.day;
      const actionTime = this.clockLabel;
      const actionStartMinutes = this.totalWorldMinutes;
      const actionDuration = Math.max(0, Math.round(Number(outcome.minutes) || 0));
      const actionEndMinutes = actionStartMinutes + actionDuration;
      const actionEndDay = Math.floor(actionEndMinutes / (24 * 60)) + 1;
      this.inventory = committedInventory;
      if (this.equippedWeaponId && !this.inventory.some((item) => item.id === this.equippedWeaponId)) this.equippedWeaponId = null;
      outcome.removeTags?.forEach((tag) => {
        this.hiddenTags = this.hiddenTags.filter((entry) => entry !== tag);
      });
      outcome.addTags?.forEach((tag) => {
        if (tag && !this.hiddenTags.includes(tag)) this.hiddenTags.push(tag);
      });
      if (outcome.vehicle) this.vehicle = normalizeVehicle(outcome.vehicle);
      outcome.wounds?.filter(Boolean).forEach((wound) => {
        if (!this.body.wounds.some((entry) => entry.id === wound.id)) this.body.wounds.push({ ...wound });
      });
      if (outcome.baseDelta) {
        this.base.defense = Math.max(0, Math.min(20, this.base.defense + (outcome.baseDelta.defense ?? 0)));
        this.base.barricades = Math.max(0, Math.min(20, this.base.barricades + (outcome.baseDelta.barricades ?? 0)));
      }
      if (outcome.revealNodeIds?.length) this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, ...outcome.revealNodeIds]);
      if (outcome.scoutDepth) this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, ...nodeNeighborhood(this.currentNodeId, outcome.scoutDepth)]);
      if (node && Number(outcome.zombieKills) > 0) {
        const before = this.ensureNodeZombieState(node.id);
        const after = applyZombieKills(before, outcome.zombieKills, {
          day: actionEndDay,
          totalMinutes: actionEndMinutes,
        });
        outcome.kills = Math.max(0, before.count - after.count);
        this.nodeZombieStates = { ...this.nodeZombieStates, [node.id]: after };
      }
      if (node && Number(outcome.encounterEvasionMinutes) > 0) {
        const before = this.ensureNodeZombieState(node.id);
        const after = grantEvasionWindow(before, {
          totalMinutes: actionEndMinutes,
          minutes: outcome.encounterEvasionMinutes,
        });
        this.nodeZombieStates = { ...this.nodeZombieStates, [node.id]: after };
      }
      const progression = this.grantSkillXp(outcome.skillXpGains ?? {});
      const levelUpText = progression.levelUps
        .map((entry) => `${skillDefinitions.find((skill) => skill.id === entry.skillId)?.label ?? entry.skillId}提升至 Lv.${entry.to}`)
        .join('、');
      this.vitals = applyVitalDelta(this.vitals, outcome.vitals);
      this.survivalStats.actions += 1;
      this.survivalStats.zombiesKilled += Math.max(0, Number(outcome.kills) || 0);
      if (mode === 'move') this.survivalStats.distanceTravelled += 1;
      this.history.push({
        day: actionDay,
        time: actionTime,
        title: outcome.title,
        log: node ? `${node.name} · ${node.resourceHint}` : '地图行动',
        action: outcome.action ?? outcome.title,
        result: outcome.result,
        notes: [outcome.notes, levelUpText].filter(Boolean).join(' / '),
        score: outcome.score,
      });
      this.mapLog.unshift({
        day: actionDay,
        time: actionTime,
        title: outcome.title,
        text: [outcome.result, levelUpText].filter(Boolean).join(' '),
        mode,
      });
      this.mapLog = this.mapLog.slice(0, 80);
      if (outcome.highlight) this.ending = { ...(this.ending || {}), highlight: outcome.highlight };
      this.advanceSimulation({
        minutes: outcome.minutes ?? 120,
        mode: outcome.mode ?? 'active',
        noiseDelta: outcome.noiseDelta ?? 0,
        threatDelta: outcome.threatDelta ?? 0,
      });
      this.activeEvent = null;
      this.movesRemaining = this.movementAllowance();
      this.finishIfGameOver();
      return true;
    },
    advanceSimulation({ minutes = 0, mode = 'active', noiseDelta = 0, threatDelta = 0 } = {}) {
      const previousDay = this.day;
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const result = advanceSurvivalState({
        day: this.day,
        clockMinutes: this.clockMinutes,
        minutes,
        vitals: this.vitals,
        world: this.world,
        body: this.body,
        base: this.base,
        traits: this.selectedTraits,
        nodeDanger: node?.danger ?? 3,
        atHome: this.isAtHome,
        mode,
        noiseDelta,
        threatDelta,
      });
      this.day = result.day;
      this.clockMinutes = result.clockMinutes;
      this.vitals = result.vitals;
      this.world = result.world;
      this.body = result.body;
      this.base = result.base;
      if (this.day > previousDay) {
        const migratedCount = this.refreshNodeZombieMigration();
        if (migratedCount > 0) result.notices.push(`尸群迁入了这个地区，附近重新出现约 ${migratedCount} 只游荡者。`);
      }
      this.survivalStats.hoursSurvived += result.elapsedHours;
      result.notices.forEach((notice) => {
        this.mapLog.unshift({
          day: this.day,
          time: this.clockLabel,
          title: '世界状态变化',
          text: notice,
          mode: 'world',
        });
      });
      this.mapLog = this.mapLog.slice(0, 80);
      if (this.body.wounds.length && !this.hiddenTags.includes('受伤')) this.hiddenTags.push('受伤');
      if (!this.body.wounds.length) this.hiddenTags = this.hiddenTags.filter((tag) => tag !== '受伤');
      if (this.body.infectionLevel > 0 && !this.hiddenTags.includes('感染征兆')) this.hiddenTags.push('感染征兆');
      if (this.body.infectionLevel <= 0) this.hiddenTags = this.hiddenTags.filter((tag) => tag !== '感染征兆');
      return result;
    },
    finishIfGameOver() {
      if (!this.isGameOver) return false;
      const previousHighlight = this.ending?.highlight;
      this.ending = createEnding({
        day: Math.max(1, Math.min(this.day, this.maxDay + 5)),
        maxDay: this.maxDay,
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
        highlight: previousHighlight,
        body: this.body,
        world: this.world,
        stats: this.survivalStats,
      });
      return true;
    },
    ensureActiveEvent() {
      if (this.isGameOver) return false;
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
      return true;
    },
    submitAction(actionText, optionId = null) {
      if (this.isGameOver || !this.canPerformWorldAction('event', 8 * 60) || !this.ensureActiveEvent()) return false;
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

      this.survivalStats.actions += 1;
      this.advanceSimulation({ minutes: 8 * 60, mode: optionId === 'rest' ? 'rest' : 'active' });
      this.activeEvent = null;

      if (!this.finishIfGameOver()) {
        this.ensureActiveEvent();
      }
      return true;
    },
    saveArchive(nickname = '匿名幸存者') {
      if (!this.ending?.title) return false;
      const snapshot = {
        id: crypto.randomUUID(),
        nickname: typeof nickname === 'string' ? nickname.slice(0, 32) : '匿名幸存者',
        createdAt: Date.now(),
        ending: this.ending,
        profession: this.profession,
        survivorName: this.survivorName,
        spawnLocation: this.spawnLocation,
        traits: this.selectedTraits,
        scenario: this.scenario,
      };
      this.archives.unshift(cloneSnapshot(snapshot));
      this.archives = this.archives.slice(0, 24);
      return true;
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

function buildVisibleMapNodes(state) {
  const visited = new Set(uniqueValidNodeIds(state.visitedNodeIds));
  const known = new Set(uniqueValidNodeIds(state.knownNodeIds));
  const adjacent = new Set(neighborsForNode(state.currentNodeId));
  return mapNodes.map((node) => {
    const visibility = node.id === state.currentNodeId
      ? 'current'
      : visited.has(node.id)
        ? 'visited'
        : known.has(node.id) || adjacent.has(node.id)
          ? 'known'
          : 'unknown';
    return {
      ...node,
      typeMeta: mapNodeTypes.find((type) => type.id === node.type),
      displayScale: mapNodeScaleById[node.id] ?? 'normal',
      visibility,
      isAdjacent: adjacent.has(node.id),
      canMove: adjacent.has(node.id) && (state.movesRemaining ?? 0) > 0,
      displayName: visibility === 'unknown' ? '???' : node.name,
    };
  });
}

function neighborsForNode(nodeId) {
  if (!nodeId) return [];
  return mapEdges
    .filter(([from, to]) => from === nodeId || to === nodeId)
    .map(([from, to]) => (from === nodeId ? to : from))
    .filter((id, index, list) => list.indexOf(id) === index);
}

function nodeNeighborhood(startNodeId, depth = 1) {
  if (!startNodeId || depth <= 0) return [];
  const seen = new Set([startNodeId]);
  let frontier = [startNodeId];
  for (let layer = 0; layer < depth; layer += 1) {
    const next = [];
    frontier.forEach((nodeId) => {
      neighborsForNode(nodeId).forEach((neighborId) => {
        if (seen.has(neighborId)) return;
        seen.add(neighborId);
        next.push(neighborId);
      });
    });
    frontier = next;
  }
  return [...seen];
}

function uniqueValidNodeIds(ids) {
  const valid = new Set(mapNodes.map((node) => node.id));
  return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => valid.has(id)))];
}

function normalizeVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return { status: 'none', fuel: 0, name: '徒步', condition: 0 };
  const status = ['none', 'damaged', 'working'].includes(vehicle.status) ? vehicle.status : 'none';
  return {
    status,
    fuel: Math.max(0, Math.min(5, Number.isFinite(vehicle.fuel) ? Math.round(vehicle.fuel) : 0)),
    name: status === 'none' ? '徒步' : vehicle.name || (status === 'working' ? '可用车辆' : '受损车辆'),
    condition: Math.max(0, Math.min(100, Number.isFinite(vehicle.condition) ? Math.round(vehicle.condition) : 0)),
  };
}

const defaultLootSlotsByQuality = {
  white: 10,
  green: 14,
  blue: 17,
  purple: 20,
  gold: 24,
  red: 26,
};

function createLootSlotsForShelter(shelter) {
  const profile = shelterLootProfiles[shelter?.id] ?? {};
  const guarantees = [...universalLootGuaranteesForShelter(shelter), ...(profile.guaranteed ?? [])];
  const qualityTarget = defaultLootSlotsByQuality[shelter?.quality] ?? 12;
  const targetCount = Math.max(profile.slotCount ?? qualityTarget, qualityTarget, guarantees.length);
  const slots = guarantees
    .map((entry, index) => createLootSlot(pickGuaranteedItem(entry, profile), index, 'guaranteed'))
    .filter(Boolean);

  let attempts = 0;
  while (slots.length < targetCount && attempts < targetCount * 40) {
    attempts += 1;
    const tier = pickLootTier();
    const item = pickWeightedItem(marketItems.filter((entry) => entry.tier === tier), profile);
    const slot = createLootSlot(item, slots.length, 'random');
    if (slot) slots.push(slot);
  }

  while (slots.length < targetCount) {
    const slot = createLootSlot(pickWeightedItem(marketItems, profile), slots.length, 'random');
    if (!slot) break;
    slots.push(slot);
  }

  return slots.slice(0, targetCount);
}

function universalLootGuaranteesForShelter(shelter) {
  const counts = shelterConsumableGuarantees[shelter?.quality] ?? shelterConsumableGuarantees.green;
  return [
    ...Array.from({ length: counts.drinks }, () => ({ itemIds: universalShelterLootPools.drinks })),
    ...Array.from({ length: counts.foods }, () => ({ itemIds: universalShelterLootPools.foods })),
    { itemIds: universalShelterLootPools.essentials },
  ];
}

function normalizeLootSlots(slots, shelter) {
  if (!Array.isArray(slots) || !slots.length) return createLootSlotsForShelter(shelter);
  const normalized = slots
    .map((slot, index) => {
      const item = marketItems.find((entry) => entry.id === slot?.itemId);
      if (!item) return null;
      const status = ['hidden', 'revealed', 'taken'].includes(slot.status) ? slot.status : 'hidden';
      return {
        id: slot.id || `loot-${index}-${item.id}`,
        itemId: item.id,
        status,
        space: item.space,
        footprint: footprintForSpace(item.space),
        tier: item.tier,
        source: slot.source === 'guaranteed' ? 'guaranteed' : 'random',
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : createLootSlotsForShelter(shelter);
}

function createLootSlot(item, index, source) {
  if (!item) return null;
  return {
    id: `loot-${index}-${item.id}-${Math.random().toString(36).slice(2, 7)}`,
    itemId: item.id,
    status: 'hidden',
    space: item.space,
    footprint: footprintForSpace(item.space),
    tier: item.tier,
    source,
  };
}

function pickGuaranteedItem(entry, profile) {
  if (entry.itemId) return marketItems.find((item) => item.id === entry.itemId);
  let candidates = marketItems;
  if (entry.itemIds) candidates = candidates.filter((item) => entry.itemIds.includes(item.id));
  if (entry.tier) candidates = candidates.filter((item) => item.tier === entry.tier);
  if (entry.category) candidates = candidates.filter((item) => item.category === entry.category);
  if (entry.tag) candidates = candidates.filter((item) => item.tags?.includes(entry.tag));
  return pickWeightedItem(candidates, profile);
}

function pickLootTier() {
  const totalWeight = lootTierWeights.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of lootTierWeights) {
    roll -= entry.weight;
    if (roll < 0) return entry.tier;
  }
  return lootTierWeights[lootTierWeights.length - 1].tier;
}

function pickWeightedItem(candidates, profile = {}) {
  if (!candidates.length) return null;
  const weighted = candidates.map((item) => ({ item, weight: lootWeightForItem(item, profile) }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return weighted[weighted.length - 1].item;
}

function lootWeightForItem(item, profile = {}) {
  const categoryBoost = profile.categoryWeights?.[item.category] ?? 0;
  const tagBoost = (item.tags ?? []).reduce((sum, tag) => sum + (profile.tagBoosts?.[tag] ?? 0), 0);
  const itemBoost = profile.itemBoosts?.[item.id] ?? 0;
  return Math.max(1, 1 + categoryBoost + tagBoost + itemBoost);
}

function footprintForSpace(space) {
  if (space >= 8) return '4x2';
  if (space >= 6) return '3x2';
  if (space >= 4) return '2x2';
  if (space >= 3) return '3x1';
  if (space >= 2) return '2x1';
  return '1x1';
}

function cloneCatalogRecord(record) {
  if (!record) return null;
  return {
    ...record,
    tags: record.tags ? [...record.tags] : undefined,
    locations: record.locations ? [...record.locations] : undefined,
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

function normalizeSkillGains(gains) {
  if (!gains || typeof gains !== 'object' || Array.isArray(gains)) return {};
  const validIds = new Set(skillDefinitions.map((skill) => skill.id));
  return Object.fromEntries(
    Object.entries(gains)
      .filter(([skillId, amount]) => validIds.has(skillId) && Number.isFinite(Number(amount)) && Number(amount) > 0)
      .map(([skillId, amount]) => [skillId, Math.min(9999, Math.round(Number(amount) * 100) / 100)])
  );
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

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeInventory(rawInventory) {
  const counts = new Map();
  rawInventory.forEach((entry) => {
    const catalogItem = marketItems.find((item) => item.id === entry?.id || item.name === entry?.name);
    if (!catalogItem) return;
    const count = clampInteger(entry?.count, 0, 999, 0);
    if (!count) return;
    counts.set(catalogItem.id, Math.min(999, (counts.get(catalogItem.id) ?? 0) + count));
  });
  return [...counts.entries()].map(([id, count]) => ({
    ...cloneCatalogRecord(marketItems.find((item) => item.id === id)),
    count,
  }));
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      day: clampInteger(entry.day, 1, 999, 1),
      time: typeof entry.time === 'string' ? entry.time.slice(0, 8) : '',
      title: typeof entry.title === 'string' ? entry.title.slice(0, 100) : '生存记录',
      log: typeof entry.log === 'string' ? entry.log.slice(0, 300) : '',
      action: typeof entry.action === 'string' ? entry.action.slice(0, 120) : '',
      result: typeof entry.result === 'string' ? entry.result.slice(0, 800) : '',
      notes: typeof entry.notes === 'string' ? entry.notes.slice(0, 300) : '',
      score: clampInteger(entry.score, 0, 100, 0),
    }))
    .slice(-500);
}

function legacyWound(type, severity, knoxInfection) {
  return {
    id: `legacy-${type}-wound`,
    bodyPart: 'left_arm',
    type,
    severity,
    bleeding: true,
    bandaged: false,
    disinfected: false,
    infected: false,
    knoxInfection,
    ageHours: 1,
    source: '旧版存档迁移',
  };
}

function normalizeNodeSearchCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return {};
  const validIds = new Set(mapNodes.map((node) => node.id));
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([id]) => validIds.has(id))
      .map(([id, count]) => [id, clampInteger(count, 0, 3, 0)])
      .filter(([, count]) => count > 0)
  );
}

function normalizeArchives(archives) {
  if (!Array.isArray(archives)) return [];
  return archives
    .filter((entry) => entry && typeof entry === 'object' && entry.ending && typeof entry.ending === 'object')
    .map((entry, index) => ({
      ...entry,
      id: typeof entry.id === 'string' && entry.id ? entry.id : `legacy-archive-${index}-${clampInteger(entry.createdAt, 0, Number.MAX_SAFE_INTEGER, 0)}`,
      nickname: typeof entry.nickname === 'string' ? entry.nickname.slice(0, 32) : '匿名幸存者',
      createdAt: clampInteger(entry.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
      scenario: scenarios.find((scenario) => scenario.id === entry.scenario?.id) ?? scenarios[0],
      profession: professions.find((profession) => profession.id === entry.profession?.id) ?? null,
      spawnLocation: spawnLocations.find((location) => location.id === entry.spawnLocation?.id) ?? spawnLocations[0],
      survivorName: typeof entry.survivorName === 'string' ? entry.survivorName.slice(0, 48) : '',
    }))
    .slice(0, 24);
}

function recipeStatus(recipe, state) {
  if (!recipe) return { canCraft: false, missing: ['配方不存在'] };
  const missing = [];
  const itemCount = (id) => state.inventory.find((item) => item.id === id)?.count ?? 0;
  recipe.ingredients.forEach((ingredient) => {
    const available = itemCount(ingredient.itemId);
    if (available < ingredient.count) {
      const item = marketItems.find((entry) => entry.id === ingredient.itemId);
      missing.push(`${item?.name ?? ingredient.itemId} ${available}/${ingredient.count}`);
    }
  });
  (recipe.tools ?? []).forEach((toolId) => {
    if (itemCount(toolId) < 1) missing.push(`工具：${marketItems.find((item) => item.id === toolId)?.name ?? toolId}`);
  });
  if (recipe.anyTools?.length && !recipe.anyTools.some((toolId) => itemCount(toolId) > 0)) {
    missing.push(`任一工具：${recipe.anyTools.map((toolId) => marketItems.find((item) => item.id === toolId)?.name ?? toolId).join('/')}`);
  }
  const skillLevel = state.skills?.[recipe.skillId] ?? 0;
  if (skillLevel < (recipe.minSkill ?? 0)) missing.push(`${skillDefinitions.find((skill) => skill.id === recipe.skillId)?.label ?? recipe.skillId} ${skillLevel}/${recipe.minSkill}`);
  const consumedSpace = recipe.ingredients.reduce((sum, ingredient) => {
    const item = marketItems.find((entry) => entry.id === ingredient.itemId);
    return sum + (item?.space ?? 0) * ingredient.count;
  }, 0);
  const result = marketItems.find((item) => item.id === recipe.resultId);
  const outputSpace = (result?.space ?? 0) * (recipe.resultCount ?? 1);
  const usedSpace = state.inventory.reduce((sum, item) => sum + item.space * item.count, 0);
  const maxSpace = inventoryCapacityForState(state, state.inventory);
  if (usedSpace - consumedSpace + outputSpace > maxSpace) missing.push('制作后空间不足');
  return {
    ...recipe,
    result,
    missing,
    canCraft: missing.length === 0,
  };
}

function inventoryCapacityForState(state, inventory = []) {
  const base = state.shelter?.space ?? 30;
  const strengthBonus = Math.max(0, (state.skills?.strength ?? 5) - 5) * 3;
  const bagBonus = Math.max(0, ...inventory.map((item) => item.effects?.capacity ?? 0));
  const total = base + strengthBonus + bagBonus;
  if (state.selectedTraits?.some((trait) => trait.id === 'organized')) return Math.floor(total * 1.3);
  if (state.selectedTraits?.some((trait) => trait.id === 'disorganized')) return Math.floor(total * 0.7);
  return total;
}

function worldMinutesForState(state) {
  const day = clampInteger(state?.day, 1, 999999, 1);
  const clockMinutes = clampInteger(state?.clockMinutes, 0, 24 * 60 - 1, START_MINUTE);
  return (day - 1) * 24 * 60 + clockMinutes;
}

function skillGainsForMapAction({ actionId, outcome = {}, inventory = [], equippedWeaponId = null, node = null, vehicle = null } = {}) {
  const kills = Math.max(0, Math.round(Number(outcome.kills) || 0));
  if (actionId === 'combat_melee') {
    const weapon = selectProgressionWeapon(inventory, equippedWeaponId, false);
    return normalizeSkillGains({
      [weapon?.effects?.skill ?? 'short_blunt']: 8 + kills * 4,
      maintenance: 3 + kills * 2,
    });
  }
  if (actionId === 'combat_firearm') {
    return normalizeSkillGains({ aiming: 10 + kills * 4, reloading: 5 + kills * 2 });
  }
  if (actionId === 'evade') {
    const success = (outcome.score ?? 0) >= 55;
    return { sneaking: success ? 14 : 7, lightfooted: success ? 9 : 4, nimble: success ? 5 : 2 };
  }
  if (actionId === 'search') return { foraging: node?.type === 'wilds' ? 8 : 4, nimble: 2 };
  if (actionId === 'scout') return { sneaking: 8, foraging: 5 };
  if (actionId === 'forage') return { foraging: 16 };
  if (actionId === 'fortify' && outcome.baseDelta) return { carpentry: 18, maintenance: 7 };
  if (actionId === 'vehicle') return { mechanics: 14, electrical: 4 };
  if (actionId === 'move') {
    const usesVehicle = vehicle?.status !== 'none' && (vehicle?.fuel ?? 0) > 0;
    return usesVehicle ? { mechanics: 2 } : { fitness: 2, sprinting: 3 };
  }
  return {};
}

function selectProgressionWeapon(inventory, equippedWeaponId, firearm) {
  const weapons = inventory.filter((item) => item.count > 0 && item.tags?.includes('weapon'));
  const valid = weapons.filter((item) => firearm ? item.tags?.includes('firearm') : !item.tags?.includes('firearm'));
  return valid.find((item) => item.id === equippedWeaponId) ?? valid[0] ?? null;
}

function selectTreatmentWound(wounds, item) {
  const source = Array.isArray(wounds) ? wounds : [];
  let candidates = source;
  if (item?.tags?.includes('bandage')) {
    candidates = source.filter((wound) => !wound.bandaged || wound.dirtyBandage || wound.bleeding);
  } else if (item?.tags?.includes('disinfect')) {
    candidates = source.filter((wound) => !wound.disinfected || wound.infected);
  }
  return [...candidates].sort((a, b) => {
    const priority = (wound) => (wound.dirtyBandage ? 100 : 0) + (wound.bleeding ? 50 : 0) + (wound.infected ? 25 : 0) + (Number(wound.severity) || 0);
    return priority(b) - priority(a);
  })[0] ?? null;
}

function levelUpSummary(progression) {
  return (progression?.levelUps ?? [])
    .map((entry) => `${skillDefinitions.find((skill) => skill.id === entry.skillId)?.label ?? entry.skillId}提升至 Lv.${entry.to}`)
    .join('、');
}

function cloneSnapshot(value) {
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function drawShelterChoices(count = 3, locationId = null) {
  return drawShelterChoicesForLocation(count, locationId);
}

export function drawShelterChoicesForLocation(count = 3, locationId = null) {
  const choices = [];
  let attempts = 0;
  const maxAttempts = count * 80;
  const availableShelters = shelters.filter((shelter) => isShelterAvailableForLocation(shelter, locationId));

  while (choices.length < count && attempts < maxAttempts) {
    attempts += 1;
    const quality = pickShelterQuality();
    const candidates = availableShelters.filter((shelter) => shelter.quality === quality.id && !choices.some((choice) => choice.id === shelter.id));
    if (!candidates.length) continue;
    choices.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  while (choices.length < count) {
    const candidates = availableShelters.filter((shelter) => !choices.some((choice) => choice.id === shelter.id));
    if (!candidates.length) break;
    choices.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  return choices;
}

export function isShelterAvailableForLocation(shelter, locationId = null) {
  if (!locationId || !shelter.locations?.length) return true;
  return shelter.locations.includes(locationId);
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
