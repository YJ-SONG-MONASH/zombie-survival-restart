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
  vehicleEvents,
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
  advanceFoodSpoilage,
  applyWeaponWear,
  canMergeItemConditionStates,
  createItemConditionState,
  getFoodConsumptionModifiers,
  getItemConditionDisplay,
  isWeaponBroken,
  normalizeItemConditionState,
} from '../services/item-condition.js';
import {
  TACTICAL_ENEMY_PROFILES,
  createTacticalEncounter,
  isTacticalEncounterTerminal,
  listTacticalActions,
  normalizeTacticalEncounter,
  resolveTacticalAction,
  summarizeTacticalEncounter,
} from '../services/tactical-encounter.js';
import {
  STORAGE_CONTAINERS,
  baseStorageCapacity,
  carryStorageCapacity,
  normalizeStorageInventory,
  previewStorageTransfer,
  projectStorageTransfer,
  storageUsedSpace,
  trunkStorageCapacity,
} from '../services/storage.js';
import {
  claimWorldLoot,
  createWorldLootContainer,
  normalizeWorldLootContainer,
  previewWorldLootClaim,
  revealWorldLootSlots,
  summarizeWorldLootContainer,
} from '../services/world-loot.js';
import {
  FOOD_PREPARATION_RECIPES,
  listFoodPreparationOptions,
  previewFoodPreparation as previewFoodPreparationProjection,
  resolveFoodPreparation,
} from '../services/food-preparation.js';
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
import {
  advanceBaseSecurity,
  createBaseSecurity,
  normalizeBaseSecurity,
  previewBaseWork as previewBaseWorkProjection,
  resolveBaseWork,
  summarizeBaseSecurity,
} from '../services/base-security.js';
import {
  abandonExpedition as abandonExpeditionProjection,
  createExpeditionState,
  normalizeExpeditionState,
  previewExpeditionPlan as previewExpeditionPlanProjection,
  replanExpedition as replanExpeditionProjection,
  resolveExpeditionEvent as resolveExpeditionEventProjection,
  startExpedition as startExpeditionProjection,
  summarizeExpedition,
} from '../services/expedition.js';

export const SAVE_VERSION = 10;

const TARGETED_TACTICAL_ACTION_IDS = new Set(['push', 'melee', 'stomp', 'fire']);

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
  baseInventory: [],
  vehicleInventory: [],
  nextItemSequence: 1,
  hiddenTags: [],
  history: [],
  activeEvent: null,
  currentNodeId: null,
  inspectedNodeId: null,
  visitedNodeIds: [],
  knownNodeIds: [],
  vehicle: emptyVehicleState(),
  movesRemaining: 1,
  mapLog: [],
  searchedSceneObjectIds: [],
  legacyDepletedSceneObjectIds: [],
  worldLootContainers: {},
  expedition: createExpeditionState(),
  foodPreparationRevision: 0,
  foodPreparationCommandIds: [],
  nodeSearchCounts: {},
  nodeZombieStates: {},
  activeTacticalEncounter: null,
  nextEncounterSequence: 1,
  firearmLoads: {},
  world: createWorldState(),
  body: createBodyState(),
  base: createBaseState(),
  baseSecurity: createBaseSecurity({ totalMinutes: START_MINUTE }),
  equippedWeaponId: null,
  equippedWeaponStackId: null,
  equippedBagStackId: null,
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
    usedSpace: (state) => storageUsedSpace(state.inventory),
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
    equippedWeapon: (state) => state.inventory.find((item) => (
      item.count > 0
      && item.tags?.includes('weapon')
      && !isWeaponBroken(item.conditionState)
      && (item.stackId === state.equippedWeaponStackId || (!state.equippedWeaponStackId && item.id === state.equippedWeaponId))
    )) ?? null,
    equippedBag: (state) => state.inventory.find((item) => (
      item.count > 0
      && item.tags?.includes('bag')
      && item.stackId === state.equippedBagStackId
    )) ?? null,
    storageContainers: (state) => buildStorageContainers(state),
    storageWarningCount: (state) => [state.inventory, state.baseInventory, state.vehicleInventory]
      .flatMap((entries) => Array.isArray(entries) ? entries : [])
      .filter((item) => {
        const display = getItemConditionDisplay(item.conditionState);
        return display.tone === 'danger';
      }).length,
    sceneLootSummary: (state) => (searchable, searchKey = '') => {
      const canonicalSearchable = canonicalSceneSearchable(state.currentNodeId, searchable);
      if (!canonicalSearchable) return null;
      const requested = typeof searchKey === 'string' ? searchKey.trim() : '';
      const key = requested && state.worldLootContainers?.[requested]
        ? requested
        : sceneLootKeyForState(state, canonicalSearchable, requested);
      if (!key) return null;
      const raw = state.worldLootContainers?.[key];
      if (!raw) {
        return isLegacySceneLootDepleted(state, canonicalSearchable)
          ? legacyDepletedSceneLootSummary(key)
          : null;
      }
      return summarizeWorldLootContainer(raw, worldLootContextForState(state, canonicalSearchable, key));
    },
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
    baseSecuritySummary: (state) => decorateBaseSecuritySummary(
      summarizeBaseSecurity(state.baseSecurity, baseSecurityContextForState(state))
    ),
    baseInteriorSafe() {
      return Boolean(this.baseSecuritySummary?.interiorSafe);
    },
    isCurrentNodeSecured() {
      if (this.isAtHome) return this.baseInteriorSafe;
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
    tacticalEncounterActive: (state) => Boolean(
      state.activeTacticalEncounter && !isTacticalEncounterTerminal(state.activeTacticalEncounter)
    ),
    tacticalActionList: (state) => {
      if (!state.activeTacticalEncounter) return [];
      const context = tacticalContextForState(state);
      const weaponStackId = state.equippedWeaponStackId
        ?? state.activeTacticalEncounter.selectedWeaponStackId
        ?? null;
      return listTacticalActions(
        state.activeTacticalEncounter,
        context,
        {
          targetId: nearestLegalTacticalTargetId(state.activeTacticalEncounter, context, weaponStackId),
          weaponStackId,
        },
      );
    },
    tacticalEncounterSummary: (state) => {
      if (!state.activeTacticalEncounter) return null;
      const node = mapNodes.find((entry) => entry.id === state.activeTacticalEncounter.nodeId);
      return {
        ...summarizeTacticalEncounter(state.activeTacticalEncounter, tacticalContextForState(state)),
        nodeName: node?.name ?? '未知地区',
        threat: Math.max(0, Math.round(Number(state.world?.threat) || 0)),
        noise: Math.max(0, Math.round(Number(state.world?.noise) || 0)),
        health: Math.max(0, Math.round(Number(state.vitals?.health) || 0)),
        endurance: Math.max(0, Math.round(Number(state.vitals?.endurance) || 0)),
        panic: Math.max(0, Math.round(Number(state.vitals?.panic) || 0)),
        pain: Math.max(0, Math.round(Number(state.body?.pain) || 0)),
        bleeding: (state.body?.wounds ?? []).filter((wound) => wound.bleeding).length,
      };
    },
    tacticalWeaponOptions: (state) => tacticalWeaponOptionsForState(state),
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
    foodPreparationOptions: (state) => listFoodPreparationOptions(foodPreparationContextForState(state)),
    inspectedMapNode: (state) => (
      mapNodeVisibilityForState(state, state.inspectedNodeId) === 'unknown'
        ? null
        : mapNodes.find((node) => node.id === state.inspectedNodeId) ?? null
    ),
    inspectedNodeDetail: (state) => (
      mapNodeVisibilityForState(state, state.inspectedNodeId) === 'unknown'
        ? null
        : mapNodeDetails[state.inspectedNodeId] ?? null
    ),
    canonicalSceneSearchablesFor: (state) => (nodeId) => (
      mapNodeVisibilityForState(state, nodeId) === 'unknown'
        ? []
        : canonicalSceneSearchableRegistry(nodeId).map(cloneSnapshot)
    ),
    visibleMapNodeList: (state) => buildVisibleMapNodes(state),
    currentNeighborNodes: (state) => neighborsForNode(state.currentNodeId).map((id) => mapNodes.find((node) => node.id === id)).filter(Boolean),
    expeditionPlan: (state) => normalizeExpeditionState(
      state.expedition,
      expeditionContextForState(state),
    ).active,
    expeditionSummary: (state) => summarizeExpedition(
      state.expedition,
      expeditionContextForState(state),
    ),
    expeditionRoutePreview: (state) => (request = {}) => previewExpeditionPlanForState(state, request),
    currentNodeActions: (state) => {
      const node = mapNodes.find((entry) => entry.id === state.currentNodeId);
      const zombieState = node ? state.nodeZombieStates?.[node.id] : null;
      const totalMinutes = worldMinutesForState(state);
      const normallySecured = zombieState ? isNodeSecured(zombieState, totalMinutes) : true;
      const protectedAtHome = Boolean(
        node?.id === state.spawnLocation?.id
        && baseInteriorSafetyForState(state)
      );
      const secured = node?.id === state.spawnLocation?.id ? protectedAtHome : normallySecured;
      const encounterActive = Boolean(zombieState && zombieState.count > 0 && !secured);
      const evasionSecured = Boolean(
        node?.id !== state.spawnLocation?.id
        && zombieState
        && zombieState.count > 0
        && normallySecured
      );
      const actionIds = [...(node?.actions ?? ['search', 'scout', 'rest'])].filter((id) => id !== 'fortify');
      if ((node?.danger ?? 0) >= 2 || (zombieState?.count ?? 0) > 0) actionIds.push('evade', 'combat_melee', 'combat_firearm');
      if (node?.type === 'wilds') actionIds.push('forage');
      if (state.currentNodeId === state.spawnLocation?.id) actionIds.push('sleep');
      else if ((node?.danger ?? 9) <= 2 && !actionIds.includes('rest')) actionIds.push('rest', 'sleep');
      return [...new Set(actionIds)]
        .map((id) => {
          const action = mapNodeActions.find((entry) => entry.id === id);
          if (!action) return null;
          let disabledReason = id === 'search'
            ? '请从“查看地点”选择具体容器进行搜索'
            : '';
          const actionMinutes = durationForAction(id);
          const encounterAction = ['evade', 'combat_melee', 'combat_firearm'].includes(id);
          if (encounterActive && !encounterAction) disabledReason = `附近还有 ${zombieState.count} 只游荡者，先战斗或绕行`;
          if (encounterAction && (zombieState?.count ?? 0) <= 0) disabledReason = '这个地区暂时已经清空';
          if (!encounterAction && evasionSecured && totalMinutes + actionMinutes > zombieState.evasionUntilMinutes) {
            disabledReason = '临时安全窗口不足以完成这项行动';
          }
          if (id === 'combat_firearm') {
            const hasUsableFirearm = state.inventory
              .filter((item) => item.count > 0 && item.tags?.includes('firearm') && !isWeaponBroken(item.conditionState))
              .some((firearm) => state.inventory.some((item) => item.id === (firearm.id === 'shotgun' ? 'shotgun_shells' : '9mm_rounds') && item.count > 0));
            if (!hasUsableFirearm && !disabledReason) disabledReason = '需要枪械和对应弹药';
          }
          if (id === 'vehicle' && storageUsedSpace(state.vehicleInventory) > 0 && !disabledReason) {
            const localVehicle = vehicleAtCurrentNodeForState(state);
            const canRefuelCurrentVehicle = localVehicle.status === 'working'
              && state.inventory.some((item) => item.id === 'gas_can' && item.count > 0);
            if (!canRefuelCurrentVehicle) disabledReason = '后备箱还有物资，先回到原车卸货再更换车辆';
          }
          if (id === 'search' && (state.nodeSearchCounts?.[node?.id] ?? 0) >= 3 && !disabledReason) disabledReason = '周边已被搜空，请检查具体建筑容器';
          return {
            ...action,
            label: id === 'search' ? '去查看地点' : action.label,
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
      if (this.base?.generatorOn && !Object.prototype.hasOwnProperty.call(rawState.base ?? {}, 'installedGeneratorStackId')) {
        this.base = { ...this.base, installedGeneratorStackId: '__legacy_auto__' };
      }
      if (!hasOwn('baseSecurity')) {
        this.baseSecurity = createBaseSecurity({
          shelter,
          totalMinutes: worldMinutesForState(this.$state),
          legacyBarricades: rawState?.base?.barricades ?? this.base?.barricades ?? 0,
        });
      }
      if (!hasOwn('survivalStats')) this.survivalStats = createSurvivalStats();
      if (!hasOwn('equippedWeaponId')) this.equippedWeaponId = null;
      if (!hasOwn('baseInventory')) this.baseInventory = [];
      if (!hasOwn('vehicleInventory')) this.vehicleInventory = [];
      if (!hasOwn('nextItemSequence')) this.nextItemSequence = 1;
      if (!hasOwn('equippedWeaponStackId')) this.equippedWeaponStackId = null;
      if (!hasOwn('equippedBagStackId')) this.equippedBagStackId = '__legacy_auto__';
      if (!hasOwn('nodeSearchCounts')) this.nodeSearchCounts = {};
      if (!hasOwn('skillXp')) this.skillXp = createSkillExperience(normalizeSkills(this.skills));
      if (!hasOwn('lastSkillGains')) this.lastSkillGains = {};
      if (!hasOwn('activeTacticalEncounter')) this.activeTacticalEncounter = null;
      if (!hasOwn('nextEncounterSequence')) this.nextEncounterSequence = 1;
      if (!hasOwn('firearmLoads')) this.firearmLoads = {};
      if (!hasOwn('worldLootContainers')) this.worldLootContainers = {};
      if (!hasOwn('expedition')) this.expedition = createExpeditionState();
      if (!hasOwn('foodPreparationRevision')) this.foodPreparationRevision = 0;
      if (!hasOwn('foodPreparationCommandIds')) this.foodPreparationCommandIds = [];
      if (!hasOwn('legacyDepletedSceneObjectIds')) {
        const rawSaveVersion = Number(rawState.saveVersion);
        this.legacyDepletedSceneObjectIds = !Number.isFinite(rawSaveVersion) || rawSaveVersion < 6
          ? [...new Set((Array.isArray(rawState.searchedSceneObjectIds) ? rawState.searchedSceneObjectIds : []).filter(Boolean))].slice(-512)
          : [];
      }
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
      this.baseInventory = [];
      this.vehicleInventory = [];
      this.equippedWeaponId = null;
      this.equippedWeaponStackId = null;
      this.equippedBagStackId = null;
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
      this.baseInventory = [];
      this.vehicleInventory = [];
      this.equippedWeaponId = null;
      this.equippedWeaponStackId = null;
      this.equippedBagStackId = null;
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
      const rawBaseInventory = Array.isArray(this.baseInventory) ? this.baseInventory : [];
      const rawVehicleInventory = Array.isArray(this.vehicleInventory) ? this.vehicleInventory : [];
      this.inventory = normalizeStorageInventory(rawInventory, marketItems, { containerId: STORAGE_CONTAINERS.CARRY });
      this.baseInventory = normalizeStorageInventory(rawBaseInventory, marketItems, { containerId: STORAGE_CONTAINERS.BASE });
      this.vehicleInventory = normalizeStorageInventory(rawVehicleInventory, marketItems, { containerId: STORAGE_CONTAINERS.TRUNK });
      const inventoryUnitCount = [this.inventory, this.baseInventory, this.vehicleInventory]
        .flat()
        .reduce((sum, item) => sum + Math.max(1, Number(item.count) || 1), 0);
      this.nextItemSequence = Math.max(
        clampInteger(this.nextItemSequence, 1, 1_000_000_000, inventoryUnitCount + 1),
        inventoryUnitCount + 1,
      );
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
      if (mapNodeVisibilityForState(this.$state, this.inspectedNodeId) === 'unknown') {
        this.inspectedNodeId = this.currentNodeId;
      }
      this.vehicle = normalizeVehicle(this.vehicle, this.currentNodeId ?? this.spawnLocation?.id);
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
      this.legacyDepletedSceneObjectIds = Array.isArray(this.legacyDepletedSceneObjectIds)
        ? [...new Set(this.legacyDepletedSceneObjectIds.filter((key) => typeof key === 'string' && key).map((key) => key.slice(0, 500)))].slice(-512)
        : [];
      this.nodeSearchCounts = normalizeNodeSearchCounts(this.nodeSearchCounts);
      const currentDanger = mapNodes.find((node) => node.id === this.currentNodeId)?.danger ?? 3;
      this.world = normalizeWorldState(this.world, {
        day: this.day,
        spawnId: this.spawnLocation?.id,
        nodeDanger: currentDanger,
        shelterDefense: this.shelter?.defense ?? 0,
      });
      this.worldLootContainers = normalizeWorldLootContainersForState(this.$state, this.worldLootContainers);
      this.foodPreparationRevision = clampInteger(this.foodPreparationRevision, 0, 1_000_000_000, 0);
      this.foodPreparationCommandIds = normalizeFoodPreparationCommandIds(this.foodPreparationCommandIds);
      this.nodeZombieStates = normalizeNodeZombieStates(this.nodeZombieStates, {
        nodes: mapNodes,
        seed: this.world.seed,
        day: this.day,
      });
      this.nextEncounterSequence = clampInteger(this.nextEncounterSequence, 1, 1_000_000_000, 1);
      const recoveredLoads = {
        ...(this.activeTacticalEncounter?.player?.loadedByWeapon ?? {}),
        ...(this.firearmLoads ?? {}),
      };
      this.firearmLoads = normalizeFirearmLoads(recoveredLoads, [this.inventory, this.baseInventory, this.vehicleInventory]);
      const tacticalNode = mapNodes.find((entry) => entry.id === this.activeTacticalEncounter?.nodeId);
      if (tacticalNode && tacticalNode.id === this.currentNodeId) {
        const zombieCount = this.nodeZombieStates[tacticalNode.id]?.count ?? 0;
        this.activeTacticalEncounter = normalizeTacticalEncounter(this.activeTacticalEncounter, {
          zombieCount,
          seed: tacticalEncounterSeed(this.world.seed, tacticalNode.id, this.totalWorldMinutes, this.nextEncounterSequence),
        });
        this.activeTacticalEncounter.player.loadedByWeapon = cloneSnapshot(this.firearmLoads);
      } else {
        this.activeTacticalEncounter = null;
      }
      this.body = normalizeBodyState(this.body);
      const migrateLegacyGenerator = this.base?.installedGeneratorStackId === '__legacy_auto__';
      this.base = normalizeBaseState(this.base, this.shelter);
      if (migrateLegacyGenerator && this.base.generatorOn && !this.baseInventory.some((item) => item.id === 'generator' && item.count > 0)) {
        const carriedGenerator = this.inventory.find((item) => item.id === 'generator' && item.count > 0);
        if (carriedGenerator) {
          const installation = projectStorageTransfer({
            containers: { carry: this.inventory, base: this.baseInventory, trunk: this.vehicleInventory },
            access: { base: true, trunk: true },
            skills: this.skills,
            selectedTraits: this.selectedTraits,
            shelter: this.shelter,
            vehicle: this.vehicle,
            equippedBagStackId: this.equippedBagStackId,
          }, {
            from: STORAGE_CONTAINERS.CARRY,
            to: STORAGE_CONTAINERS.BASE,
            stackId: carriedGenerator.stackId,
            count: 1,
          });
          if (installation.ok) {
            this.inventory = installation.containers.carry;
            this.baseInventory = installation.containers.base;
            this.equippedBagStackId = installation.nextEquippedBagStackId;
          }
        }
      }
      const installedGenerator = this.baseInventory.find((item) => (
        item.id === 'generator'
        && item.count > 0
        && (item.stackId === this.base.installedGeneratorStackId || migrateLegacyGenerator)
      ));
      if (this.base.generatorOn && installedGenerator) {
        this.base.installedGeneratorStackId = installedGenerator.stackId;
      } else if (this.base.generatorOn) {
        this.base.generatorOn = false;
        this.base.installedGeneratorStackId = null;
      } else if (!this.baseInventory.some((item) => item.stackId === this.base.installedGeneratorStackId && item.id === 'generator')) {
        this.base.installedGeneratorStackId = null;
      }
      this.baseSecurity = normalizeBaseSecurity(this.baseSecurity, {
        shelter: this.shelter,
        totalMinutes: worldMinutesForState(this.$state),
      });
      syncLegacyBaseProjection(this.$state);
      this.world.powerOn = this.day < this.world.powerShutoffDay || (this.base.generatorOn && this.base.generatorFuel > 0);
      this.world.waterOn = this.day < this.world.waterShutoffDay;
      this.survivalStats = normalizeSurvivalStats(this.survivalStats);
      const validEquippedWeapon = this.inventory.find((item) => (
        item.tags?.includes('weapon')
        && !isWeaponBroken(item.conditionState)
        && (item.stackId === this.equippedWeaponStackId || item.id === this.equippedWeaponId)
      ));
      this.equippedWeaponStackId = validEquippedWeapon?.stackId ?? null;
      this.equippedWeaponId = validEquippedWeapon?.id ?? null;
      const migrateLegacyBag = this.equippedBagStackId === '__legacy_auto__';
      const validEquippedBag = this.inventory.find((item) => item.stackId === this.equippedBagStackId && item.tags?.includes('bag'));
      const bestLegacyBag = [...this.inventory]
        .filter((item) => item.tags?.includes('bag'))
        .sort((left, right) => (right.effects?.capacity ?? 0) - (left.effects?.capacity ?? 0))[0];
      this.equippedBagStackId = validEquippedBag?.stackId ?? (migrateLegacyBag ? bestLegacyBag?.stackId ?? null : null);
      this.expedition = normalizeExpeditionState(
        this.expedition,
        expeditionContextForState(this.$state),
      );
      this.expedition = reconcileLoadedExpeditionForState(this.$state);
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
      this.baseSecurity = createBaseSecurity({
        shelter: this.shelter,
        totalMinutes: worldMinutesForState(this.$state),
      });
      syncLegacyBaseProjection(this.$state);
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
      const liveSlot = this.lootSlots.find((entry) => entry.id === slotId);
      const ownsSearch = this.searchingSlotId === slot.id && liveSlot === slot && slot.status === 'searching';
      if (this.runPhase !== 'setup' || !ownsSearch) {
        if (ownsSearch) {
          slot.status = 'hidden';
          this.searchingSlotId = null;
        }
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
      const ownsSearch = this.searchingSlotId === 'bulk' && slots.every((slot) => (
        slot.status === 'searching'
        && this.lootSlots.find((entry) => entry.id === slot.id) === slot
      ));
      if (this.runPhase !== 'setup' || !ownsSearch) {
        if (ownsSearch) {
          slots.forEach((slot) => {
            slot.status = 'hidden';
          });
          this.searchingSlotId = null;
        }
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
      if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) return false;
      const quantity = positiveInteger(count);
      if (!item || !quantity) return false;
      const projection = projectInventoryAddition(this.inventory, item, quantity, {
        acquiredMinutes: this.totalWorldMinutes,
        sequence: this.nextItemSequence,
        sourceId: 'loot',
      });
      if (!projection.ok || storageUsedSpace(projection.inventory) > inventoryCapacityForState(this.$state, projection.inventory)) return false;
      this.inventory = projection.inventory;
      this.nextItemSequence = projection.nextSequence;
      return true;
    },
    addItem(item, count = 1, free = false) {
      if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) return false;
      const quantity = positiveInteger(count);
      if (!item || !quantity) return false;
      if (!free && this.money < item.price * quantity) return false;
      const projection = projectInventoryAddition(this.inventory, item, quantity, {
        acquiredMinutes: this.totalWorldMinutes,
        sequence: this.nextItemSequence,
        sourceId: free ? 'grant' : 'market',
      });
      if (!projection.ok || storageUsedSpace(projection.inventory) > inventoryCapacityForState(this.$state, projection.inventory)) return false;
      this.inventory = projection.inventory;
      this.nextItemSequence = projection.nextSequence;
      if (!free) this.money -= item.price * quantity;
      return true;
    },
    removeItem(id, count = 1) {
      if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) return false;
      const quantity = positiveInteger(count);
      if (!quantity) return false;
      const projection = projectInventoryRemoval(this.inventory, id, quantity);
      if (!projection.ok) return false;
      this.inventory = projection.inventory;
      this.reconcileEquipment();
      return true;
    },
    equipWeapon(id) {
      if (this.isGameOver) return false;
      if (!this.canPerformWorldAction('equip', 0, false)) return false;
      const weapon = findInventoryStack(this.inventory, id, (item) => item.tags?.includes('weapon'));
      if (weapon && isWeaponBroken(weapon.conditionState)) return false;
      if (!weapon) return false;
      if (this.equippedWeaponStackId === weapon.stackId) {
        this.equippedWeaponStackId = null;
        this.equippedWeaponId = null;
        if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
          this.activeTacticalEncounter.selectedWeaponStackId = null;
        }
      } else {
        this.equippedWeaponStackId = weapon.stackId;
        this.equippedWeaponId = weapon.id;
        if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
          this.activeTacticalEncounter.selectedWeaponStackId = weapon.stackId;
        }
      }
      return true;
    },
    equipBag(id) {
      if (this.isGameOver || !this.canPerformWorldAction('equip', 0, false)) return false;
      const bag = findInventoryStack(this.inventory, id, (item) => item.tags?.includes('bag'));
      if (!bag) return false;
      const nextStackId = this.equippedBagStackId === bag.stackId ? null : bag.stackId;
      const nextCapacity = carryStorageCapacity({
        skills: this.skills,
        selectedTraits: this.selectedTraits,
        inventory: this.inventory,
        equippedBagStackId: nextStackId,
      });
      if (storageUsedSpace(this.inventory) > nextCapacity) return false;
      this.equippedBagStackId = nextStackId;
      return true;
    },
    reconcileEquipment() {
      const weapon = this.inventory.find((item) => (
        item.stackId === this.equippedWeaponStackId
        && item.tags?.includes('weapon')
        && !isWeaponBroken(item.conditionState)
      )) ?? this.inventory.find((item) => (
        !this.equippedWeaponStackId
        && item.id === this.equippedWeaponId
        && item.tags?.includes('weapon')
        && !isWeaponBroken(item.conditionState)
      ));
      this.equippedWeaponStackId = weapon?.stackId ?? null;
      this.equippedWeaponId = weapon?.id ?? null;
      if (!this.inventory.some((item) => item.stackId === this.equippedBagStackId && item.tags?.includes('bag'))) {
        this.equippedBagStackId = null;
      }
      this.firearmLoads = normalizeFirearmLoads(this.firearmLoads, [this.inventory, this.baseInventory, this.vehicleInventory]);
    },
    previewTransfer(request = {}) {
      return createTransferQuote(this.$state, request, false);
    },
    transferItem(request = {}) {
      const quote = createTransferQuote(this.$state, request, true);
      if (!quote.ok) return { ...quote, committed: false };
      const duration = transferDurationMinutes(quote.item, quote.quantity);
      if (!this.canPerformWorldAction('storage', duration)) {
        return { ...quote, ok: false, committed: false, disabledReason: '当前安全窗口不足，无法整理物资' };
      }
      const result = projectStorageTransfer(storageContextForState(this.$state), {
        from: quote.fromId,
        to: quote.toId,
        stackId: quote.stackId,
        count: quote.quantity,
      });
      if (!result.ok) return transferFailureResult(result, quote.maxQuantity);
      this.inventory = result.containers.carry;
      this.baseInventory = result.containers.base;
      this.vehicleInventory = result.containers.trunk;
      this.equippedBagStackId = result.nextEquippedBagStackId;
      if (!this.baseInventory.some((item) => item.stackId === this.base.installedGeneratorStackId && item.id === 'generator')) {
        this.base.installedGeneratorStackId = null;
      }
      this.reconcileEquipment();
      this.survivalStats.actions += 1;
      this.mapLog.unshift({
        day: this.day,
        time: this.clockLabel,
        title: '整理物资',
        text: `${quote.item.name} ×${quote.quantity} 已从${storageName(quote.fromId)}转移到${storageName(quote.toId)}。`,
        mode: 'storage',
      });
      this.mapLog = this.mapLog.slice(0, 80);
      this.advanceSimulation({ minutes: duration, mode: 'rest', noiseDelta: -1 });
      this.finishIfGameOver();
      return { ...quote, committed: true };
    },
    useItem(id) {
      if (this.isGameOver) return false;
      const item = findInventoryStack(this.inventory, id);
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
      const foodModifiers = item.category === 'food'
        ? getFoodConsumptionModifiers(item.conditionState)
        : { edible: true, freshnessState: null, effectMultiplier: 1, foodPoisoningRisk: false };
      const adjustedEffects = Object.fromEntries(Object.entries(item.effects ?? {}).map(([key, value]) => [
        key,
        typeof value === 'number' && item.category === 'food' && isBeneficialVitalEffect(key, value)
          ? value * foodModifiers.effectMultiplier
          : value,
      ]));
      applyVitalMods(this.vitals, adjustedEffects);
      if (foodModifiers.foodPoisoningRisk) {
        const traitIds = new Set(this.selectedTraits.map((trait) => trait.id));
        const sickness = traitIds.has('iron_gut') ? 6 : traitIds.has('weak_stomach') ? 18 : 12;
        applyVitalMods(this.vitals, { health: -sickness, stress: 12, hunger: 4 });
        if (!this.hiddenTags.includes('食物中毒')) this.hiddenTags.push('食物中毒');
      }
      if (item.id === 'foraged_mushrooms' && !this.selectedTraits.some((trait) => trait.id === 'herbalist') && (this.world.seed + this.day) % 5 === 0) {
        applyVitalMods(this.vitals, { health: -8, stress: 10 });
        if (!this.hiddenTags.includes('食物中毒')) this.hiddenTags.push('食物中毒');
      }
      this.removeItem(item.stackId, 1);
      const progression = this.grantSkillXp(treatsWound
        ? { first_aid: item.id === 'first_aid_kit' ? 18 : 10 }
        : {});
      const levelUpText = levelUpSummary(progression);
      this.mapLog.unshift({
        day: this.day,
        time: this.clockLabel,
        title: `使用 ${item.name}`,
        text: [
          treatsWound
            ? `你处理了${bodyPartLabels[wound.bodyPart] ?? wound.bodyPart}的${woundTypeLabels[wound.type] ?? wound.type}。`
            : `${item.name}已经消耗。${foodModifiers.freshnessState === 'stale' ? '味道已经不对，恢复效果有限。' : foodModifiers.foodPoisoningRisk ? '腐败气味很快变成胃里的绞痛。' : ''}`,
          levelUpText,
        ].filter(Boolean).join(' '),
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
    previewFoodPreparation(request = {}) {
      const gate = foodPreparationAccessFailure(this);
      if (gate) return foodPreparationFailure(this.$state, gate);
      const recipe = FOOD_PREPARATION_RECIPES.find((entry) => entry.id === request?.recipeId);
      if (!recipe) return foodPreparationFailure(this.$state, 'recipe_missing');
      const context = foodPreparationContextForState(this.$state, recipe.id);
      let preview;
      try {
        preview = previewFoodPreparationProjection(context, request);
      } catch {
        return foodPreparationFailure(this.$state, 'projection_failed');
      }
      if (!preview?.ok) return foodPreparationFailure(this.$state, preview?.reason ?? 'invalid_request', preview);
      const minutes = preparationMinutes(preview, recipe);
      if (!minutes) return foodPreparationFailure(this.$state, 'invalid_duration');
      if (!this.canPerformWorldAction('food_preparation', minutes)) {
        return foodPreparationFailure(this.$state, 'insufficient_safe_window', preview);
      }
      if (foodRecipeRequiresPower(recipe) && poweredMinutesForInterval({
        day: this.day,
        clockMinutes: this.clockMinutes,
        elapsedMinutes: minutes,
        world: this.world,
        base: this.base,
      }) < minutes) {
        return foodPreparationFailure(this.$state, 'power_unavailable', preview);
      }
      return {
        ...preview,
        committed: false,
        revision: context.revision,
      };
    },
    prepareFood(command = {}) {
      const commandId = normalizeFoodPreparationCommandId(command?.commandId);
      const expectedRevision = Number(command?.expectedRevision);
      if (!commandId || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 1_000_000_000) {
        return foodPreparationFailure(this.$state, 'invalid_command');
      }
      if (this.foodPreparationCommandIds.includes(commandId)) {
        return foodPreparationFailure(this.$state, 'duplicate_command', { replayed: true });
      }
      if (expectedRevision !== this.foodPreparationRevision) {
        return foodPreparationFailure(this.$state, 'stale_revision');
      }
      const gate = foodPreparationAccessFailure(this);
      if (gate) return foodPreparationFailure(this.$state, gate);
      const recipe = FOOD_PREPARATION_RECIPES.find((entry) => entry.id === command?.recipeId);
      if (!recipe) return foodPreparationFailure(this.$state, 'recipe_missing');
      const context = foodPreparationContextForState(this.$state, recipe.id);
      let preview;
      let resolved;
      try {
        preview = previewFoodPreparationProjection(context, command);
        if (!preview?.ok) return foodPreparationFailure(this.$state, preview?.reason ?? 'invalid_request', preview);
        const previewMinutes = preparationMinutes(preview, recipe);
        if (!previewMinutes) return foodPreparationFailure(this.$state, 'invalid_duration');
        if (!this.canPerformWorldAction('food_preparation', previewMinutes)) {
          return foodPreparationFailure(this.$state, 'insufficient_safe_window', preview);
        }
        if (foodRecipeRequiresPower(recipe) && poweredMinutesForInterval({
          day: this.day,
          clockMinutes: this.clockMinutes,
          elapsedMinutes: previewMinutes,
          world: this.world,
          base: this.base,
        }) < previewMinutes) {
          return foodPreparationFailure(this.$state, 'power_unavailable', preview);
        }
        resolved = resolveFoodPreparation(context, command);
      } catch {
        return foodPreparationFailure(this.$state, 'projection_failed');
      }
      if (!resolved?.ok) return foodPreparationFailure(this.$state, resolved?.reason ?? 'invalid_request', resolved);

      const minutes = preparationMinutes(resolved, recipe);
      const nextState = resolved.nextState;
      if (!validFoodPreparationProjection(nextState, context, commandId, minutes, preview)) {
        return foodPreparationFailure(this.$state, 'invalid_projection');
      }
      if (!this.canPerformWorldAction('food_preparation', minutes)) {
        return foodPreparationFailure(this.$state, 'insufficient_safe_window', resolved);
      }
      if (foodRecipeRequiresPower(recipe) && poweredMinutesForInterval({
        day: this.day,
        clockMinutes: this.clockMinutes,
        elapsedMinutes: minutes,
        world: this.world,
        base: this.base,
      }) < minutes) {
        return foodPreparationFailure(this.$state, 'power_unavailable', resolved);
      }

      const actionDay = this.day;
      const actionTime = this.clockLabel;
      this.inventory = cloneInventory(nextState.containers.carry);
      this.baseInventory = cloneInventory(nextState.containers.base);
      this.base.waterReserve = clampInteger(nextState.baseWaterReserve, 0, 30, this.base.waterReserve);
      this.nextItemSequence = clampInteger(nextState.nextItemSequence, 1, 1_000_000_000, this.nextItemSequence);
      this.foodPreparationRevision = clampInteger(nextState.revision, 0, 1_000_000_000, this.foodPreparationRevision + 1);
      this.foodPreparationCommandIds = normalizeFoodPreparationCommandIds(nextState.appliedCommandIds);
      this.reconcileEquipment();
      this.survivalStats.actions += 1;
      this.survivalStats.crafted += 1;
      const progression = this.grantSkillXp({ cooking: Math.max(0, Number(resolved.skillXp) || 0) });
      const levelUpText = levelUpSummary(progression);
      const preparedName = resolved.preparedStack?.name
        ?? marketItems.find((item) => item.id === resolved.resultId)?.name
        ?? recipe.name;
      const waterText = resolved.waterSource === 'reserve'
        ? '消耗据点储水'
        : resolved.waterSource === 'municipal' ? '使用市政供水' : '';
      this.history.push({
        day: actionDay,
        time: actionTime,
        title: recipe.name,
        log: '烹饪与食物准备',
        action: recipe.name,
        result: `你完成了${preparedName}。`,
        notes: [`耗时 ${formatFoodPreparationDuration(minutes)}`, waterText, levelUpText].filter(Boolean).join(' / '),
        score: Math.min(100, 58 + (this.skills.cooking ?? 0) * 4),
      });
      this.mapLog.unshift({
        day: actionDay,
        time: actionTime,
        title: recipe.name,
        text: [`制作完成：${preparedName}。`, waterText, levelUpText].filter(Boolean).join(' '),
        mode: 'cooking',
      });
      this.mapLog = this.mapLog.slice(0, 80);
      this.advanceSimulation({
        minutes,
        mode: 'active',
        noiseDelta: Number(resolved.noiseDelta) || 0,
        threatDelta: Number(resolved.threatDelta) || 0,
      });
      this.finishIfGameOver();
      return {
        ...resolved,
        committed: true,
        progression,
      };
    },
    craftRecipe(recipeId) {
      if (this.isGameOver) return false;
      const recipe = craftingRecipes.find((entry) => entry.id === recipeId);
      if (!recipe) return false;
      const craftMinutes = recipe.minutes ?? durationForAction('craft');
      if (!this.canPerformWorldAction('craft', craftMinutes)) return false;
      const status = recipeStatus(recipe, this.$state);
      if (!status.canCraft) return false;
      const result = marketItems.find((item) => item.id === recipe.resultId);
      if (!result) return false;
      const projection = projectInventoryTransaction(this.inventory, {
        consume: recipe.ingredients.map((ingredient) => ({ id: ingredient.itemId, count: ingredient.count })),
        add: [{ item: result, count: recipe.resultCount ?? 1 }],
        acquiredMinutes: this.totalWorldMinutes,
        sequence: this.nextItemSequence,
        sourceId: `craft:${recipe.id}`,
      });
      if (!projection.ok || storageUsedSpace(projection.inventory) > inventoryCapacityForState(this.$state, projection.inventory)) return false;
      this.inventory = projection.inventory;
      this.nextItemSequence = projection.nextSequence;
      this.reconcileEquipment();
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
    repairWeapon(stackId, materialId) {
      if (this.isGameOver) return { ok: false, disabledReason: '本局已经结束' };
      const repairMinutes = 45;
      if (!this.canPerformWorldAction('repair', repairMinutes)) return { ok: false, disabledReason: '当前环境不允许维修' };
      const weapon = findInventoryStack(this.inventory, stackId, (entry) => entry.tags?.includes('weapon'));
      const material = findInventoryStack(this.inventory, materialId, (entry) => (entry.effects?.repair ?? 0) > 0);
      if (!weapon) return { ok: false, disabledReason: '武器不在随身物资中' };
      if (!weapon.conditionState?.condition) return { ok: false, disabledReason: '该物品没有可维修耐久' };
      if (!material) return { ok: false, disabledReason: '缺少胶带或木工胶' };
      if (weapon.conditionState.condition.current >= weapon.conditionState.condition.maximum) {
        return { ok: false, disabledReason: '武器耐久已经完好' };
      }
      const projected = cloneInventory(this.inventory);
      const removal = projectInventoryRemoval(projected, material.stackId, 1);
      if (!removal.ok) return { ok: false, disabledReason: '维修材料不足' };
      const projectedWeapon = removal.inventory.find((entry) => entry.stackId === weapon.stackId);
      const repairCount = clampInteger(projectedWeapon.repairCount, 0, 50, 0);
      const skillBonus = (this.skills.maintenance ?? 0) * 1.5;
      const baseRepair = material.effects.repair >= 2 ? 38 : 24;
      const restored = Math.max(5, Math.round((baseRepair + skillBonus) * (0.72 ** repairCount)));
      const oldMaximum = projectedWeapon.conditionState.condition.maximum;
      const nextMaximum = Math.max(20, oldMaximum - Math.max(0, repairCount * 2));
      projectedWeapon.conditionState = normalizeItemConditionState({
        ...projectedWeapon.conditionState,
        condition: {
          ...projectedWeapon.conditionState.condition,
          maximum: nextMaximum,
          current: Math.min(nextMaximum, projectedWeapon.conditionState.condition.current + restored),
          broken: false,
        },
      }, projectedWeapon);
      projectedWeapon.repairCount = repairCount + 1;
      this.inventory = removal.inventory;
      this.survivalStats.actions += 1;
      const progression = this.grantSkillXp({ maintenance: 14 + material.effects.repair * 4 });
      this.mapLog.unshift({
        day: this.day,
        time: this.clockLabel,
        title: `维修 ${weapon.name}`,
        text: `${material.name}恢复了 ${restored} 点耐久。${levelUpSummary(progression)}`,
        mode: 'repair',
      });
      this.advanceSimulation({ minutes: repairMinutes, mode: 'active', noiseDelta: 3, threatDelta: 1 });
      this.finishIfGameOver();
      return { ok: true, restored, stackId: weapon.stackId };
    },
    previewBaseWork(command = {}) {
      const accessFailure = baseWorkAccessFailure(this);
      if (accessFailure) return baseWorkStoreFailure(this.$state, accessFailure);
      let result;
      try {
        result = previewBaseWorkProjection(this.baseSecurity, command, baseWorkContextForState(this.$state, true));
      } catch {
        return baseWorkStoreFailure(this.$state, 'projection_failed');
      }
      if (!result?.ok) return baseWorkStoreFailure(this.$state, result?.reason ?? 'invalid_command', result);
      return {
        ...result,
        committed: false,
        summary: decorateBaseSecuritySummary(summarizeBaseSecurity(
          result.nextState.baseSecurity,
          baseSecurityContextForState(this.$state),
        )),
      };
    },
    performBaseWork(command = {}) {
      const accessFailure = baseWorkAccessFailure(this);
      if (accessFailure) return baseWorkStoreFailure(this.$state, accessFailure);
      const context = baseWorkContextForState(this.$state, true);
      let result;
      try {
        result = resolveBaseWork(this.baseSecurity, command, context);
      } catch {
        return baseWorkStoreFailure(this.$state, 'projection_failed');
      }
      if (!result?.ok) return baseWorkStoreFailure(this.$state, result?.reason ?? 'invalid_command', result);
      if (!validBaseWorkProjection(result, this.$state, command)) {
        return baseWorkStoreFailure(this.$state, 'invalid_projection');
      }

      const beforeState = cloneSnapshot(this.$state);
      const actionDay = this.day;
      const actionTime = this.clockLabel;
      const openingBefore = this.baseSecuritySummary.openings.find((entry) => entry.id === result.openingId);
      try {
        this.inventory = cloneInventory(result.nextState.containers.carry);
        this.baseInventory = cloneInventory(result.nextState.containers.base);
        this.baseSecurity = normalizeBaseSecurity(result.nextState.baseSecurity, {
          shelter: this.shelter,
          totalMinutes: this.totalWorldMinutes,
        });
        syncLegacyBaseProjection(this.$state);
        this.reconcileEquipment();
        this.survivalStats.actions += 1;
        const progression = this.grantSkillXp(result.kind === 'repair'
          ? { carpentry: result.skillXp, maintenance: Math.max(1, Math.round(result.skillXp * 0.45)) }
          : { carpentry: result.skillXp, maintenance: Math.max(1, Math.round(result.skillXp * 0.4)) });
        const openingName = openingBefore?.label ?? result.openingId;
        const workLabel = result.kind === 'repair' ? '维修' : '加固';
        const effectText = result.kind === 'repair'
          ? `结构恢复 ${result.integrityDelta} 点`
          : `路障增加 ${result.barricadeDelta} 点`;
        const levelUpText = levelUpSummary(progression);
        this.history.push({
          day: actionDay,
          time: actionTime,
          title: `${workLabel}${openingName}`,
          log: '据点防线维护',
          action: `${workLabel}${openingName}`,
          result: `${openingName}${effectText}。`,
          notes: [`耗时 ${formatFoodPreparationDuration(result.minutes)}`, '消耗木板 ×1、钉子 ×1', levelUpText].filter(Boolean).join(' / '),
          score: Math.min(100, 55 + (this.skills.carpentry ?? 0) * 4),
        });
        this.mapLog.unshift({
          day: actionDay,
          time: actionTime,
          title: `${workLabel}${openingName}`,
          text: [`${effectText}，锤子仍可继续使用。`, levelUpText].filter(Boolean).join(' '),
          mode: 'base_security',
        });
        this.mapLog = this.mapLog.slice(0, 80);
        const simulation = this.advanceSimulation({
          minutes: result.minutes,
          mode: 'active',
          noiseDelta: result.noiseDelta,
          threatDelta: Math.max(0, Math.round(result.noiseDelta / 4)),
        });
        this.finishIfGameOver();
        return {
          ...result,
          committed: true,
          progression,
          incidents: cloneSnapshot(simulation.baseSecurity?.incidents ?? []),
          summary: cloneSnapshot(this.baseSecuritySummary),
        };
      } catch {
        this.$state = beforeState;
        return baseWorkStoreFailure(this.$state, 'commit_failed');
      }
    },
    toggleGenerator() {
      if (this.isGameOver || !this.isAtHome) return false;
      if (!this.canPerformWorldAction('base', 20)) return false;
      const homeItems = [...this.inventory, ...this.baseInventory];
      const generator = this.baseInventory.find((item) => item.id === 'generator' && item.count > 0);
      const knowsGenerator = homeItems.some((item) => item.id === 'how_to_use_generators' && item.count > 0) || (this.skills.electrical ?? 0) >= 3;
      if (this.base.generatorOn) {
        this.base.generatorOn = false;
        this.world.powerOn = this.day < this.world.powerShutoffDay;
        this.grantSkillXp({});
        return true;
      }
      if (!generator || !knowsGenerator) return false;
      if (this.base.generatorFuel <= 0) {
        const gasCan = this.inventory.find((item) => item.id === 'gas_can' && item.count > 0)
          ?? this.baseInventory.find((item) => item.id === 'gas_can' && item.count > 0);
        if (!gasCan) return false;
        const container = this.inventory.includes(gasCan) ? 'inventory' : 'baseInventory';
        const removal = projectInventoryRemoval(this[container], gasCan.stackId, 1);
        if (!removal.ok) return false;
        this[container] = removal.inventory;
        this.base.generatorFuel = 3;
      }
      this.base.generatorOn = true;
      this.base.installedGeneratorStackId = generator.stackId;
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
      this.vehicle = emptyVehicleState();
      this.vehicleInventory = [];
      this.movesRemaining = 1;
      this.mapLog = [];
      this.searchedSceneObjectIds = [];
      this.legacyDepletedSceneObjectIds = [];
      this.worldLootContainers = {};
      this.expedition = createExpeditionState();
      this.nodeSearchCounts = {};
      this.nodeZombieStates = {};
      this.activeTacticalEncounter = null;
      this.nextEncounterSequence = 1;
      this.firearmLoads = {};
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
      const lockedTacticalNodeId = this.activeTacticalEncounter
        && !isTacticalEncounterTerminal(this.activeTacticalEncounter)
        ? this.activeTacticalEncounter.nodeId
        : null;
      mapNodes.forEach((node) => {
        const current = this.nodeZombieStates?.[node.id] ?? createNodeZombieState({
          nodeId: node.id,
          danger: node.danger,
          seed: this.world?.seed,
          day: this.day,
        });
        if (node.id === lockedTacticalNodeId) {
          refreshed[node.id] = {
            ...cloneSnapshot(current),
            lastRefreshDay: Math.max(clampInteger(current.lastRefreshDay, 1, 999999, this.day), this.day),
          };
          return;
        }
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
    tacticalActionsFor(targetId = null, weaponStackId = null) {
      const encounter = this.activeTacticalEncounter;
      if (!encounter) return [];
      const selectedWeaponStackId = tacticalRuntimeId(weaponStackId)
        ?? this.equippedWeaponStackId
        ?? encounter.selectedWeaponStackId
        ?? null;
      return listTacticalActions(
        encounter,
        tacticalContextForState(this.$state),
        {
          targetId: tacticalRuntimeId(targetId),
          weaponStackId: selectedWeaponStackId,
        },
      );
    },
    startTacticalEncounter(preferredActionId = '') {
      if (this.isGameOver || !this.currentNodeId) return false;
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      if (!node) return false;
      const zombieState = this.ensureNodeZombieState(node.id);
      const breachedHomeRequiresCombat = node.id === this.spawnLocation?.id && !this.baseInteriorSafe;
      if (
        !zombieState
        || zombieState.count <= 0
        || (isNodeSecured(zombieState, this.totalWorldMinutes) && !breachedHomeRequiresCombat)
      ) return false;
      if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
        return this.activeTacticalEncounter.nodeId === node.id;
      }
      const selectedWeapon = selectTacticalStartingWeapon(this.$state, preferredActionId);
      const encounterSequence = clampInteger(this.nextEncounterSequence, 1, 1_000_000_000, 1);
      const firearmLoads = normalizeFirearmLoads(this.firearmLoads, [this.inventory, this.baseInventory, this.vehicleInventory]);
      const aggressiveEntry = ['melee', 'fire', 'combat_melee', 'combat_firearm'].includes(preferredActionId);
      this.activeTacticalEncounter = createTacticalEncounter({
        nodeId: node.id,
        zombieCount: zombieState.count,
        seed: tacticalEncounterSeed(this.world?.seed, node.id, this.totalWorldMinutes, encounterSequence),
        encounterSequence,
        startedAtMinutes: this.totalWorldMinutes,
        selectedWeaponStackId: selectedWeapon?.stackId ?? null,
        firearmLoads,
        // Merely arriving in a populated node means spotting the horde at a
        // distance, not materializing inside a grab. Players who explicitly
        // choose melee/fire still commit to a close engagement; automatic and
        // defensive entries retain enough space to assess, retreat, or equip.
        initialRangeBand: aggressiveEntry ? 'near' : 'far',
        escapeProgress: aggressiveEntry ? 0 : 40,
      });
      this.firearmLoads = firearmLoads;
      if (selectedWeapon) {
        this.equippedWeaponStackId = selectedWeapon.stackId;
        this.equippedWeaponId = selectedWeapon.id;
      }
      this.nextEncounterSequence = Math.min(1_000_000_000, encounterSequence + 1);
      return true;
    },
    performTacticalAction(actionId, options = {}) {
      const requestOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      const encounter = this.activeTacticalEncounter;
      if (!encounter || this.isGameOver || !this.canPerformWorldAction('tactical', 0, false)) return false;
      if (encounter.nodeId !== this.currentNodeId || isTacticalEncounterTerminal(encounter)) return false;
      const targetId = tacticalRuntimeId(requestOptions.targetId);
      if (TARGETED_TACTICAL_ACTION_IDS.has(actionId) && !targetId) return false;
      // A tactical command is an optimistic-concurrency transaction. Callers
      // must identify the encounter and turn they rendered; silently filling
      // in the latest values would turn a delayed double-click into a new turn.
      if (requestOptions.encounterId !== encounter.id
        || !Number.isInteger(requestOptions.expectedTurn)
        || requestOptions.expectedTurn !== encounter.turn) return false;
      const node = mapNodes.find((entry) => entry.id === encounter.nodeId);
      const zombieState = node ? this.nodeZombieStates?.[node.id] : null;
      if (!node || !zombieState || zombieState.count <= 0) return false;
      if (Array.isArray(encounter.enemies)) {
        if (!isValidTacticalEnemyRoster(encounter.enemies, zombieState.count)) return false;
      } else if (tacticalZombieTotal(encounter) !== zombieState.count) {
        return false;
      }
      const normalizedEncounter = normalizeTacticalEncounter(encounter, {
        zombieCount: zombieState.count,
        seed: encounter.rng?.seed
          ?? tacticalEncounterSeed(this.world?.seed, node.id, this.totalWorldMinutes, this.nextEncounterSequence),
      });
      const encounterPopulation = tacticalZombieTotal(normalizedEncounter);
      if (encounterPopulation !== zombieState.count) return false;
      if (!isValidTacticalEnemyRoster(normalizedEncounter.enemies, encounterPopulation)) return false;

      const context = tacticalContextForState(this.$state);
      const weaponStackId = tacticalRuntimeId(requestOptions.weaponStackId)
        ?? this.equippedWeaponStackId
        ?? normalizedEncounter.selectedWeaponStackId
        ?? null;
      const command = {
        actionId,
        encounterId: requestOptions.encounterId,
        expectedTurn: requestOptions.expectedTurn,
        weaponStackId,
        targetId,
      };
      if (actionId === 'reload') {
        const weapon = findInventoryStack(this.inventory, weaponStackId, (item) => item.tags?.includes('firearm'));
        const ammoItemId = weapon ? firearmAmmoId(weapon.id) : null;
        const ammo = requestOptions.ammoStackId
          ? findInventoryStack(this.inventory, requestOptions.ammoStackId, (item) => item.id === ammoItemId)
          : this.inventory.find((item) => item.id === ammoItemId && item.count > 0);
        const loaded = normalizedEncounter.player?.loadedByWeapon?.[weaponStackId]?.rounds ?? 0;
        const availableCapacity = Math.max(0, firearmCapacity(weapon?.id) - loaded);
        command.ammoStackId = ammo?.stackId ?? requestOptions.ammoStackId ?? null;
        command.rounds = requestOptions.rounds ?? Math.min(availableCapacity, Math.max(0, Number(ammo?.count) || 0));
      } else if (requestOptions.ammoStackId) {
        command.ammoStackId = requestOptions.ammoStackId;
      }
      if (requestOptions.rounds !== undefined && actionId !== 'reload') command.rounds = requestOptions.rounds;

      const resolution = resolveTacticalAction(normalizedEncounter, command, context);
      if (!resolution?.ok || !(resolution.effects?.durationMinutes > 0)) return false;
      const effects = resolution.effects;
      const rawKills = Number(effects.zombieKills);
      if (!Number.isInteger(rawKills) || rawKills < 0 || rawKills > encounterPopulation) return false;
      const rawNextEnemies = resolution.nextState?.enemies;
      const expectedEnemyCount = encounterPopulation - rawKills;
      if (!isValidTacticalEnemyRoster(rawNextEnemies, expectedEnemyCount)) return false;
      const beforeEnemyIds = new Set(normalizedEncounter.enemies.map((enemy) => enemy.id));
      const afterEnemyIds = new Set(rawNextEnemies.map((enemy) => enemy.id));
      const removedEnemyCount = [...beforeEnemyIds].filter((enemyId) => !afterEnemyIds.has(enemyId)).length;
      const insertedEnemyCount = [...afterEnemyIds].filter((enemyId) => !beforeEnemyIds.has(enemyId)).length;
      if (removedEnemyCount !== rawKills || insertedEnemyCount !== 0) return false;
      if (!Array.isArray(effects.enemyChanges)) return false;
      const changedEnemyIds = effects.enemyChanges
        .map((change) => tacticalRuntimeId(change?.targetId))
        .filter(Boolean);
      if (new Set(changedEnemyIds).size !== changedEnemyIds.length
        || changedEnemyIds.some((enemyId) => !beforeEnemyIds.has(enemyId))) return false;
      const killedEnemyIds = effects.enemyChanges
        .filter((change) => change?.killed)
        .map((change) => tacticalRuntimeId(change?.targetId))
        .filter(Boolean);
      if (killedEnemyIds.length !== rawKills
        || killedEnemyIds.some((enemyId) => afterEnemyIds.has(enemyId))) return false;

      let projectedInventory = cloneInventory(this.inventory);
      for (const request of effects.ammoConsumption ?? []) {
        const removal = projectExactInventoryRemoval(projectedInventory, request?.stackId, request?.count);
        if (!removal.ok) return false;
        projectedInventory = removal.inventory;
      }
      for (const use of effects.weaponUses ?? []) {
        const weapon = projectedInventory.find((item) => item.stackId === use?.stackId && item.tags?.includes('weapon'));
        if (!weapon?.conditionState || isWeaponBroken(weapon.conditionState)) return false;
        weapon.conditionState = applyWeaponWear(weapon.conditionState, {
          attacks: Math.max(0, Number(use.attacks) || 0),
          kills: Math.max(0, Number(use.kills ?? use.impacts) || 0),
        });
      }
      const projectedLoads = normalizeFirearmLoads({
        ...this.firearmLoads,
        ...(effects.firearmLoads ?? {}),
      }, [projectedInventory, this.baseInventory, this.vehicleInventory]);
      const projectedVitals = applyVitalDelta(this.vitals, effects.vitalsDelta);
      let projectedBody = normalizeBodyState(cloneSnapshot(this.body));
      for (const wound of effects.newWounds ?? []) {
        if (!wound?.id || projectedBody.wounds.some((entry) => entry.id === wound.id)) continue;
        projectedBody.wounds.push(cloneSnapshot(wound));
      }
      projectedBody = normalizeBodyState(projectedBody);
      const progression = applySkillExperience({
        skills: this.skills,
        skillXp: this.skillXp,
        gains: effects.skillXp ?? {},
        skillIds: skillDefinitions.map((skill) => skill.id),
      });
      const actionStartDay = this.day;
      const actionStartTime = this.clockLabel;
      const actionStartMinutes = this.totalWorldMinutes;
      const durationMinutes = Math.max(1, Math.round(Number(effects.durationMinutes) || 0));
      const actionEndMinutes = actionStartMinutes + durationMinutes;
      const actionEndDay = Math.floor(actionEndMinutes / (24 * 60)) + 1;
      const kills = rawKills;
      const nextZombieState = kills > 0
        ? applyZombieKills(zombieState, kills, { day: actionEndDay, totalMinutes: actionEndMinutes })
        : cloneSnapshot(zombieState);
      const escapedZombieState = Number(effects.evasionMinutes) > 0
        ? grantEvasionWindow(nextZombieState, {
            totalMinutes: actionEndMinutes,
            minutes: Math.max(0, Math.round(Number(effects.evasionMinutes) || 0)),
          })
        : nextZombieState;
      if (escapedZombieState.count !== expectedEnemyCount) return false;
      const nextEncounter = normalizeTacticalEncounter(resolution.nextState, {
        zombieCount: escapedZombieState.count,
        seed: normalizedEncounter.rng?.seed,
      });
      if (!isValidTacticalEnemyRoster(nextEncounter.enemies, escapedZombieState.count)
        || tacticalZombieTotal(nextEncounter) !== escapedZombieState.count) return false;
      nextEncounter.player.loadedByWeapon = cloneSnapshot(projectedLoads);
      const actionMeta = this.tacticalActionsFor(targetId, weaponStackId).find((entry) => entry.id === actionId);
      const targetOutcome = tacticalTargetOutcomeForResolution({
        actionId,
        targetId,
        beforeEncounter: normalizedEncounter,
        nextEncounter,
        effects,
      });
      const eventText = formatTacticalEvents(resolution.events);
      const targetText = formatTacticalTargetOutcome(targetOutcome);
      const resultText = [eventText, targetText].filter(Boolean).join(' ');

      const beforeCommitState = cloneSnapshot(this.$state);
      this.inventory = projectedInventory;
      this.firearmLoads = projectedLoads;
      this.vitals = projectedVitals;
      this.body = projectedBody;
      if ((effects.newWounds ?? []).some((wound) => wound.type === 'bite') && !this.hiddenTags.includes('疑似咬伤')) {
        this.hiddenTags.push('疑似咬伤');
      }
      this.skills = progression.skills;
      this.skillXp = progression.skillXp;
      this.lastSkillGains = progression.appliedGains;
      this.nodeZombieStates = { ...this.nodeZombieStates, [node.id]: escapedZombieState };
      this.activeTacticalEncounter = nextEncounter;
      this.reconcileEquipment();
      this.survivalStats.actions += 1;
      this.survivalStats.zombiesKilled += kills;
      const levelUpText = levelUpSummary(progression);
      const actionTitle = actionMeta?.label ?? tacticalActionLabel(actionId);
      this.history.push({
        day: actionStartDay,
        time: actionStartTime,
        title: `战术遭遇 · ${actionTitle}`,
        log: `${node.name} · 第 ${encounter.turn + 1} 回合`,
        action: actionTitle,
        result: resultText || `你执行了${actionTitle}。`,
        notes: [kills ? `击倒 ${kills}` : '', levelUpText].filter(Boolean).join(' / '),
        score: Math.max(0, Math.min(100, 100 - Math.round(
          (Number(actionMeta?.risk) || 0) <= 1
            ? (Number(actionMeta?.risk) || 0) * 100
            : Number(actionMeta?.risk) || 0
        ))),
      });
      this.mapLog.unshift({
        day: actionStartDay,
        time: actionStartTime,
        title: `战术遭遇 · ${actionTitle}`,
        text: [resultText, kills ? `本回合击倒 ${kills} 只。` : '', levelUpText].filter(Boolean).join(' '),
        mode: 'tactical',
      });
      this.mapLog = this.mapLog.slice(0, 80);
      this.advanceSimulation({
        minutes: durationMinutes,
        mode: 'active',
        noiseDelta: effects.noiseDelta ?? 0,
        threatDelta: effects.threatDelta ?? 0,
      });
      if (this.isGameOver && this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
        const survivorDied = this.vitals.health <= 0 || (this.body?.infectionLevel ?? 0) >= 100;
        this.activeTacticalEncounter = {
          ...this.activeTacticalEncounter,
          status: survivorDied ? 'dead' : 'aborted',
        };
      }
      this.movesRemaining = this.movementAllowance();
      let expeditionResult = null;
      if (survivorTerminalFailureForState(this.$state)) {
        this.finishIfGameOver();
      } else {
        try {
          expeditionResult = this.reconcileSecuredExpeditionNode(nextEncounter.id);
        } catch {
          this.$state = beforeCommitState;
          return false;
        }
        if (expeditionResult?.ok === false) {
          this.$state = beforeCommitState;
          return false;
        }
        this.finishIfGameOver();
      }
      const result = {
        ok: true,
        events: cloneSnapshot(Array.isArray(resolution.events) ? resolution.events : []),
        effects: cloneSnapshot(effects),
        summary: cloneSnapshot(this.tacticalEncounterSummary),
        expedition: expeditionResult ? cloneSnapshot(expeditionResult) : null,
      };
      if (targetOutcome) {
        result.target = cloneSnapshot(targetOutcome);
        result.targetId = targetOutcome.targetId;
        result.targetName = targetOutcome.targetName;
        result.damage = targetOutcome.damage;
        result.hpAfter = targetOutcome.hpAfter;
        result.maxHp = targetOutcome.maxHp;
        result.killed = targetOutcome.killed;
      }
      return result;
    },
    dismissTacticalEncounter() {
      if (!this.activeTacticalEncounter || !isTacticalEncounterTerminal(this.activeTacticalEncounter)) return false;
      this.activeTacticalEncounter = null;
      return true;
    },
    canPerformWorldAction(kind = 'world', minutes = 0, requireFullWindow = true) {
      if (this.isGameOver) return false;
      if (this.activeTacticalEncounter && !isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
        return kind === 'tactical' || kind === 'equip';
      }
      if (!this.currentNodeId) return true;
      const zombieState = this.nodeZombieStates?.[this.currentNodeId];
      if (!zombieState) return false;
      if (zombieState.count <= 0) return true;
      const encounterActions = new Set(['combat', 'evade', 'equip']);
      if (encounterActions.has(kind)) return true;
      if (this.isAtHome) return this.baseInteriorSafe;
      const now = this.totalWorldMinutes;
      if (!isNodeSecured(zombieState, now)) return false;
      if (!requireFullWindow) return true;
      const duration = Math.max(0, Math.round(Number(minutes) || 0));
      return now + duration <= zombieState.evasionUntilMinutes;
    },
    expeditionCommandToken(kind = 'command') {
      const state = normalizeExpeditionState(
        this.expedition,
        expeditionContextForState(this.$state),
      );
      return createExpeditionCommandToken(state, kind, this.totalWorldMinutes);
    },
    previewExpeditionPlan(command = {}) {
      return previewExpeditionPlanForState(this.$state, command);
    },
    startExpedition(command = {}) {
      const context = expeditionContextForState(this.$state, { request: command });
      const state = normalizeExpeditionState(this.expedition, context);
      if (requestedExpeditionSearchableIsInvalid(this.$state, command)) {
        return expeditionStoreFailure(state, 'unknown_target_searchable');
      }
      const result = startExpeditionProjection(
        this.expedition,
        command,
        context,
      );
      if (result.ok) this.expedition = result.nextState;
      return result;
    },
    replanExpedition(command = {}) {
      const result = replanExpeditionProjection(
        this.expedition,
        command,
        expeditionContextForState(this.$state),
      );
      if (result.ok) this.expedition = result.nextState;
      return result;
    },
    abandonExpedition(command = {}) {
      const result = abandonExpeditionProjection(
        this.expedition,
        command,
        expeditionContextForState(this.$state),
      );
      if (result.ok) this.expedition = result.nextState;
      return result;
    },
    reconcileExpeditionEvent(event = {}) {
      const result = resolveExpeditionEventProjection(
        this.expedition,
        event,
        expeditionContextForState(this.$state),
      );
      if (result.ok) this.expedition = result.nextState;
      return result;
    },
    reconcileSecuredExpeditionNode(encounterId = '') {
      const active = this.expeditionPlan;
      if (
        !active
        || active.phase !== 'objective'
        || active.targetNodeId !== this.currentNodeId
        || active.targetSecured
        || !this.isCurrentNodeSecured
      ) return null;
      const resolvedEncounterId = tacticalRuntimeId(encounterId)
        ?? tacticalRuntimeId(this.activeTacticalEncounter?.id);
      if (!resolvedEncounterId) {
        const state = normalizeExpeditionState(this.expedition, expeditionContextForState(this.$state));
        return expeditionStoreFailure(state, 'encounter_id_required');
      }
      const token = createExpeditionCommandToken(
        normalizeExpeditionState(this.expedition, expeditionContextForState(this.$state)),
        `secure:${resolvedEncounterId}`,
        this.totalWorldMinutes,
      );
      return this.reconcileExpeditionEvent({
        type: 'node_secured',
        ...token,
        nodeId: this.currentNodeId,
        encounterId: resolvedEncounterId,
      });
    },
    initializeMapState(force = false) {
      if (this.runPhase === 'setup' && this.searchingSlotId) return false;
      this.baseSecurity = normalizeBaseSecurity(this.baseSecurity, {
        shelter: this.shelter,
        totalMinutes: worldMinutesForState(this.$state),
      });
      syncLegacyBaseProjection(this.$state);
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
      const startingStorage = splitStartingStorage(this.$state);
      this.inventory = startingStorage.inventory;
      this.baseInventory = startingStorage.baseInventory;
      this.equippedBagStackId = startingStorage.equippedBagStackId;
      this.equippedWeaponStackId = startingStorage.equippedWeaponStackId;
      this.equippedWeaponId = startingStorage.equippedWeaponId;
      this.currentNodeId = spawnNode.id;
      this.inspectedNodeId = spawnNode.id;
      this.visitedNodeIds = [spawnNode.id];
      this.knownNodeIds = uniqueValidNodeIds([spawnNode.id, ...neighborsForNode(spawnNode.id)]);
      this.vehicle = normalizeVehicle(this.vehicle, spawnNode.id);
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
      const availableVehicle = activeTravelVehicleForState(this.$state);
      if (availableVehicle?.status === 'working' && (availableVehicle.fuel ?? 0) > 0) return 3;
      if (availableVehicle?.status === 'damaged' && (availableVehicle.fuel ?? 0) > 0) return 2;
      return 1;
    },
    canMoveToNode(nodeId) {
      const travelMinutes = durationForAction('move', { vehicle: activeTravelVehicleForState(this.$state) });
      return this.vitals.endurance > 4 &&
        neighborsForNode(this.currentNodeId).includes(nodeId) &&
        this.canPerformWorldAction('move', travelMinutes, false);
    },
    inspectMapNode(nodeId) {
      const node = mapNodes.find((entry) => entry.id === nodeId);
      if (!node || mapNodeVisibilityForState(this.$state, node.id) === 'unknown') return false;
      this.inspectedNodeId = node.id;
      return true;
    },
    moveToNode(nodeId, expeditionCommand = null) {
      if (this.isGameOver) return false;
      const node = mapNodes.find((entry) => entry.id === nodeId);
      if (!node || !this.canMoveToNode(nodeId)) return false;
      const from = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const travelVehicle = activeTravelVehicleForState(this.$state);
      const activeExpedition = this.expeditionPlan;
      const beforeState = cloneSnapshot(this.$state);
      try {
        this.ensureNodeZombieState(node.id);
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
          equippedWeaponId: this.equippedWeaponStackId ?? this.equippedWeaponId,
          node,
          vehicle: travelVehicle,
        });
        this.currentNodeId = node.id;
        this.inspectedNodeId = node.id;
        this.visitedNodeIds = uniqueValidNodeIds([...this.visitedNodeIds, node.id]);
        this.knownNodeIds = uniqueValidNodeIds([...this.knownNodeIds, node.id, ...neighborsForNode(node.id)]);
        const usingVehicle = travelVehicle?.status !== 'none' && (travelVehicle.fuel ?? 0) > 0;
        if (usingVehicle) {
          this.vehicle = {
            ...travelVehicle,
            fuel: Math.max(0, (travelVehicle.fuel ?? 0) - 1),
            nodeId: node.id,
          };
        }
        this.movesRemaining = this.movementAllowance();
        if (!this.applyMapOutcome(outcome, 'move', true, true)) {
          this.$state = beforeState;
          return false;
        }
        if (this.activeTacticalEncounter && isTacticalEncounterTerminal(this.activeTacticalEncounter)) {
          this.activeTacticalEncounter = null;
        }
        if (survivorTerminalFailureForState(this.$state)) {
          this.finishIfGameOver();
          return true;
        }
        if (activeExpedition && this.expeditionPlan) {
          const normalizedExpedition = normalizeExpeditionState(
            this.expedition,
            expeditionContextForState(this.$state),
          );
          const token = expeditionCommand === null || expeditionCommand === undefined
            ? createExpeditionCommandToken(
                normalizedExpedition,
                `leg:${from?.id ?? 'unknown'}:${node.id}`,
                this.totalWorldMinutes,
              )
            : expeditionCommand;
          const reconciled = this.reconcileExpeditionEvent({
            type: 'leg_completed',
            commandId: token?.commandId,
            expectedRevision: token?.expectedRevision,
            fromNodeId: from?.id,
            toNodeId: node.id,
            secured: this.isCurrentNodeSecured,
          });
          if (!reconciled?.ok) {
            this.$state = beforeState;
            return false;
          }
        }
        this.finishIfGameOver();
        return true;
      } catch {
        this.$state = beforeState;
        return false;
      }
    },
    resolveNodeAction(actionId) {
      if (this.isGameOver) return false;
      if (actionId === 'fortify' || actionId === 'search') return false;
      if (!this.currentNodeId) this.initializeMapState();
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const action = mapNodeActions.find((entry) => entry.id === actionId);
      if (node) this.ensureNodeZombieState(node.id);
      const availableAction = this.currentNodeActions.find((entry) => entry.id === actionId);
      if (!node || !action || !availableAction || availableAction.disabled) return false;
      if (['evade', 'combat_melee', 'combat_firearm'].includes(actionId)) {
        const encounterKind = actionId === 'evade' ? 'evade' : 'combat';
        if (!this.canPerformWorldAction(encounterKind, 0, false)) return false;
        return this.startTacticalEncounter(actionId);
      }
      const encounterKind = actionId;
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
        vehicle: vehicleAtCurrentNodeForState(this.$state),
        world: this.world,
        body: this.body,
        base: this.base,
        equippedWeaponId: this.equippedWeaponStackId ?? this.equippedWeaponId,
        searchCount: this.nodeSearchCounts[node.id] ?? 0,
        zombiePopulation: this.nodeZombieStates[node.id]?.count ?? 0,
      });
      if (!outcome || !(outcome.minutes > 0)) return false;
      outcome.skillXpGains = skillGainsForMapAction({
        actionId,
        outcome,
        inventory: this.inventory,
        equippedWeaponId: outcome.usedWeaponStackId ?? this.equippedWeaponStackId ?? this.equippedWeaponId,
        node,
        vehicle: vehicleAtCurrentNodeForState(this.$state),
      });
      if (!this.applyMapOutcome(outcome, 'action')) return false;
      if (actionId === 'search') this.nodeSearchCounts[node.id] = (this.nodeSearchCounts[node.id] ?? 0) + 1;
      return true;
    },
    openSceneLoot(searchable, searchKey = '') {
      const access = sceneLootAccess(this, searchable, searchKey);
      if (!access.ok) return access;
      const { key, node, context, searchable: canonicalSearchable } = access;
      const legacyDepleted = !this.worldLootContainers?.[key]
        && isLegacySceneLootDepleted(this.$state, canonicalSearchable);
      if (legacyDepleted) {
        return { ok: false, reason: 'legacy_depleted', searchKey: key, summary: legacyDepletedSceneLootSummary(key) };
      }
      const raw = this.worldLootContainers?.[key] ?? createSceneLootContainerForState(this.$state, context, key);
      const container = normalizeWorldLootContainer(raw, context);
      const summary = summarizeWorldLootContainer(container, context);
      const beforeState = cloneSnapshot(this.$state);
      try {
        this.worldLootContainers = commitWorldLootContainer(this.worldLootContainers, key, container);
        let expeditionResult = null;
        const active = this.expeditionPlan;
        if (
          summary.exhausted
          && active?.mode === 'round_trip'
          && active.phase === 'objective'
          && active.targetSecured
          && active.targetNodeId === node.id
          && active.targetSearchKey === key
        ) {
          const normalized = normalizeExpeditionState(this.expedition, expeditionContextForState(this.$state));
          expeditionResult = this.reconcileExpeditionEvent({
            type: 'container_exhausted',
            ...createExpeditionCommandToken(normalized, `empty-open:${key}`, this.totalWorldMinutes),
            nodeId: node.id,
            searchKey: key,
          });
          if (!expeditionResult?.ok) {
            this.$state = beforeState;
            return { ...expeditionResult, searchKey: key, expedition: expeditionResult };
          }
        }
        return {
          ok: true,
          reason: null,
          searchKey: key,
          nodeId: node.id,
          container: cloneSnapshot(container),
          summary,
          expedition: expeditionResult,
        };
      } catch {
        this.$state = beforeState;
        return { ok: false, reason: 'open_commit_failed', searchKey: key };
      }
    },
    revealSceneLoot(searchable, command = {}, searchKey = '') {
      const access = sceneLootAccess(this, searchable, searchKey);
      if (!access.ok) return access;
      const { key, node, context, searchable: canonicalSearchable } = access;
      const raw = this.worldLootContainers?.[key];
      if (!raw) {
        const legacyDepleted = isLegacySceneLootDepleted(this.$state, canonicalSearchable);
        if (legacyDepleted) return { ok: false, reason: 'legacy_depleted', searchKey: key };
      }
      const container = normalizeWorldLootContainer(raw ?? createSceneLootContainerForState(this.$state, context, key), context);
      const completedAtMinutes = this.totalWorldMinutes + (container.searchCostPaid ? 0 : container.searchCost.minutes);
      const result = revealWorldLootSlots(container, { ...command, completedAtMinutes }, context);
      if (!result.ok) return { ...result, searchKey: key };

      const beforeState = cloneSnapshot(this.$state);
      try {
        let committedContainer = result.nextState;
      if (result.cost.minutes > 0) {
        if (!this.canPerformWorldAction('search', result.cost.minutes)) {
          return { ok: false, reason: 'unsafe_or_insufficient_window', searchKey: key };
        }
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
          vehicle: vehicleAtCurrentNodeForState(this.$state),
          world: this.world,
          body: this.body,
          base: this.base,
          equippedWeaponId: this.equippedWeaponStackId ?? this.equippedWeaponId,
          manualLoot: { sourceName: canonicalSearchable?.name ?? node.name, collectedItems: [] },
          zombiePopulation: this.nodeZombieStates[node.id]?.count ?? 0,
        });
        if (!outcome) return { ok: false, reason: 'search_resolution_failed', searchKey: key };
        outcome.title = `翻找 ${canonicalSearchable?.name ?? node.name}`;
        outcome.result = `你花时间翻找了${canonicalSearchable?.name ?? '这个容器'}，确认了里面还能带走的物资。未拿走的东西会继续留在原处。`;
        outcome.notes = [
          `发现 ${result.revealedSlots.length} 处物资`,
          ...(typeof outcome.notes === 'string' ? outcome.notes.split(' / ') : Array.isArray(outcome.notes) ? outcome.notes : [])
            .filter((note) => note && note !== '没有带走有价值物资'),
        ].join(' / ');
        outcome.minutes = result.cost.minutes;
        outcome.noiseDelta = result.cost.noise;
        outcome.threatDelta = Math.max(0, Math.ceil(result.cost.noise / 3));
        outcome.add = [];
        outcome.skillXpGains = skillGainsForMapAction({
          actionId: 'search',
          outcome,
          inventory: this.inventory,
          equippedWeaponId: this.equippedWeaponStackId ?? this.equippedWeaponId,
          node,
          vehicle: vehicleAtCurrentNodeForState(this.$state),
        });
        if (!this.applyMapOutcome(outcome, 'scene_search')) {
          return { ok: false, reason: 'search_resolution_failed', searchKey: key };
        }
        committedContainer = advanceWorldLootConditionStates({ [key]: result.nextState }, result.cost.minutes)[key];
      } else if (!this.canPerformWorldAction('search', 0, false)) {
        return { ok: false, reason: 'unsafe_or_insufficient_window', searchKey: key };
      }

        this.worldLootContainers = commitWorldLootContainer(this.worldLootContainers, key, committedContainer);
        const summary = summarizeWorldLootContainer(committedContainer, context);
        let expeditionResult = null;
        const activeExpedition = this.expeditionPlan;
        if (
          summary.exhausted
          && activeExpedition?.mode === 'round_trip'
          && activeExpedition.phase === 'objective'
          && activeExpedition.targetNodeId === node.id
          && activeExpedition.targetSearchKey === key
        ) {
          const normalizedExpedition = normalizeExpeditionState(
            this.expedition,
            expeditionContextForState(this.$state),
          );
          const suppliedToken = command?.expeditionCommand;
          const token = suppliedToken === null || suppliedToken === undefined
            ? createExpeditionCommandToken(
                normalizedExpedition,
                `empty:${command?.commandId ?? key}`,
                this.totalWorldMinutes,
              )
            : suppliedToken;
          expeditionResult = this.reconcileExpeditionEvent({
            type: 'container_exhausted',
            commandId: token?.commandId,
            expectedRevision: token?.expectedRevision,
            nodeId: node.id,
            searchKey: key,
          });
          if (!expeditionResult?.ok) {
            this.$state = beforeState;
            return { ...expeditionResult, searchKey: key, expedition: expeditionResult };
          }
        }
        return {
          ...result,
          nextState: cloneSnapshot(committedContainer),
          searchKey: key,
          summary,
          expedition: expeditionResult,
        };
      } catch {
        this.$state = beforeState;
        return { ok: false, reason: 'search_commit_failed', searchKey: key };
      }
    },
    previewSceneLootClaim(searchable, request = {}, searchKey = '') {
      const access = sceneLootAccess(this, searchable, searchKey);
      if (!access.ok) return access;
      if (!this.canPerformWorldAction('loot', 0, false)) {
        return { ok: false, reason: 'unsafe_or_insufficient_window', searchKey: access.key };
      }
      const raw = this.worldLootContainers?.[access.key];
      if (!raw) return { ok: false, reason: 'container_missing', searchKey: access.key };
      return {
        ...previewWorldLootClaim(raw, request, {
          ...access.context,
          inventory: this.inventory,
          capacity: inventoryCapacityForState(this.$state, this.inventory),
        }),
        searchKey: access.key,
      };
    },
    claimSceneLoot(searchable, command = {}, searchKey = '') {
      const access = sceneLootAccess(this, searchable, searchKey);
      if (!access.ok) return access;
      if (!this.canPerformWorldAction('loot', 0, false)) {
        return { ok: false, reason: 'unsafe_or_insufficient_window', searchKey: access.key };
      }
      const raw = this.worldLootContainers?.[access.key];
      if (!raw) return { ok: false, reason: 'container_missing', searchKey: access.key };
      const beforeState = cloneSnapshot(this.$state);
      try {
        const result = claimWorldLoot(raw, command, {
          ...access.context,
          inventory: this.inventory,
          capacity: inventoryCapacityForState(this.$state, this.inventory),
        });
        if (!result.ok) return { ...result, searchKey: access.key };

        const activeExpedition = this.expeditionPlan;
        const objectiveClaim = Boolean(
          activeExpedition
          && activeExpedition.mode === 'round_trip'
          && activeExpedition.phase === 'objective'
          && activeExpedition.targetNodeId === access.node.id
          && activeExpedition.targetSearchKey === access.key
        );
        this.inventory = result.inventory;
      this.nextItemSequence = Math.min(
        1_000_000_000,
        this.nextItemSequence + result.claimedStacks.reduce((sum, item) => sum + Math.max(1, Number(item.count) || 1), 0),
      );
      this.worldLootContainers = commitWorldLootContainer(this.worldLootContainers, access.key, result.nextState);
      const summary = summarizeWorldLootContainer(result.nextState, access.context);
      let expeditionResult = null;
      if (objectiveClaim) {
        const normalizedExpedition = normalizeExpeditionState(
          this.expedition,
          expeditionContextForState(this.$state),
        );
        const suppliedToken = command?.expeditionCommand;
        const token = suppliedToken === null || suppliedToken === undefined
          ? createExpeditionCommandToken(
              normalizedExpedition,
              `loot:${command?.commandId ?? access.key}`,
              this.totalWorldMinutes,
            )
          : suppliedToken;
        expeditionResult = this.reconcileExpeditionEvent({
          type: 'loot_claimed',
          commandId: token?.commandId,
          expectedRevision: token?.expectedRevision,
          nodeId: access.node.id,
          searchKey: access.key,
          claimedStacks: result.claimedStacks.map((item) => ({
            stackId: item.stackId,
            id: item.id,
            count: item.count,
          })),
        });
        if (!expeditionResult?.ok) {
          this.$state = beforeState;
          return { ...expeditionResult, searchKey: access.key, expedition: expeditionResult };
        }
      }
      this.mapLog.unshift({
        day: this.day,
        time: this.clockLabel,
        title: `取走 ${searchable?.name ?? '地点物资'}`,
        text: `你带走了${result.claimedStacks.map((item) => marketItems.find((entry) => entry.id === item.id)?.name ?? item.id).join('、')}。${summary.remaining ? `原处还剩 ${summary.remaining} 件物资。` : '这里已经搜空。'}`,
        mode: 'loot',
      });
      this.mapLog = this.mapLog.slice(0, 80);
      return { ...result, searchKey: access.key, summary, expedition: expeditionResult };
      } catch {
        this.$state = beforeState;
        return { ok: false, reason: 'claim_commit_failed', searchKey: access.key };
      }
    },
    applyMapOutcome(outcome, mode = 'action', allowTerminalCommit = false, deferTerminalCommit = false) {
      if (!outcome || (this.isGameOver && !allowTerminalCommit)) return false;
      const transaction = projectInventoryTransaction(this.inventory, {
        consume: (outcome.consume ?? []).map((id) => ({ id, count: 1 })),
        add: (outcome.add ?? []).map((item) => ({ item, count: item?.count ?? 1 })),
        acquiredMinutes: this.totalWorldMinutes,
        sequence: this.nextItemSequence,
        sourceId: `action:${mode}`,
      });
      if (!transaction.ok || storageUsedSpace(transaction.inventory) > inventoryCapacityForState(this.$state, transaction.inventory)) return false;
      const committedInventory = transaction.inventory;
      if (outcome.weaponWear?.stackId) {
        const weapon = committedInventory.find((item) => item.stackId === outcome.weaponWear.stackId);
        if (weapon?.conditionState) {
          weapon.conditionState = applyWeaponWear(weapon.conditionState, {
            attacks: outcome.weaponWear.attacks,
            kills: outcome.weaponWear.kills,
          });
        }
      }
      const projectedVehicle = outcome.vehicle ? normalizeVehicle(outcome.vehicle, this.currentNodeId) : null;
      if (
        projectedVehicle
        && storageUsedSpace(this.vehicleInventory) > 0
        && !(outcome.vehicleOperation === 'refuel' && isSameVehicleRefuel(this.vehicle, projectedVehicle))
      ) return false;
      if (projectedVehicle && storageUsedSpace(this.vehicleInventory) > trunkStorageCapacity(projectedVehicle)) return false;
      const node = mapNodes.find((entry) => entry.id === this.currentNodeId);
      const actionDay = this.day;
      const actionTime = this.clockLabel;
      const actionStartMinutes = this.totalWorldMinutes;
      const actionDuration = Math.max(0, Math.round(Number(outcome.minutes) || 0));
      const actionEndMinutes = actionStartMinutes + actionDuration;
      const actionEndDay = Math.floor(actionEndMinutes / (24 * 60)) + 1;
      this.inventory = committedInventory;
      this.nextItemSequence = transaction.nextSequence;
      this.reconcileEquipment();
      outcome.removeTags?.forEach((tag) => {
        this.hiddenTags = this.hiddenTags.filter((entry) => entry !== tag);
      });
      outcome.addTags?.forEach((tag) => {
        if (tag && !this.hiddenTags.includes(tag)) this.hiddenTags.push(tag);
      });
      if (projectedVehicle) this.vehicle = projectedVehicle;
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
      if (!deferTerminalCommit) this.finishIfGameOver();
      return true;
    },
    advanceSimulation({ minutes = 0, mode = 'active', noiseDelta = 0, threatDelta = 0 } = {}) {
      const previousDay = this.day;
      const startTotalMinutes = worldMinutesForState(this.$state);
      const startingExteriorPopulation = Math.max(
        0,
        Math.round(Number(this.nodeZombieStates?.[this.spawnLocation?.id]?.count) || 0),
      );
      const startingSecurityPressure = {
        threat: this.world?.threat,
        noise: this.world?.noise,
        generatorOn: Boolean(this.base?.generatorOn),
      };
      const elapsedMinutes = Math.max(0, Math.round(Number(minutes) || 0));
      const poweredRefrigerationMinutes = poweredMinutesForInterval({
        day: this.day,
        clockMinutes: this.clockMinutes,
        elapsedMinutes,
        world: this.world,
        base: this.base,
      });
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
      this.inventory = advanceInventoryConditionStates(this.inventory, { elapsedMinutes });
      this.vehicleInventory = advanceInventoryConditionStates(this.vehicleInventory, { elapsedMinutes });
      this.baseInventory = advanceInventoryConditionStates(this.baseInventory, {
        elapsedMinutes,
        refrigerated: true,
        poweredMinutes: poweredRefrigerationMinutes,
      });
      this.worldLootContainers = advanceWorldLootConditionStates(this.worldLootContainers, elapsedMinutes);
      const endTotalMinutes = worldMinutesForState(this.$state);
      const securityAdvance = advanceBaseSecurity(this.baseSecurity, {
        fromTotalMinutes: startTotalMinutes,
        toTotalMinutes: endTotalMinutes,
        worldSeed: this.world?.seed,
        day: previousDay,
        threat: startingSecurityPressure.threat,
        noise: startingSecurityPressure.noise,
        generatorOn: startingSecurityPressure.generatorOn,
        exteriorPopulation: startingExteriorPopulation,
        shelterDefense: this.shelter?.defense ?? 0,
      });
      this.baseSecurity = securityAdvance.nextState;
      syncLegacyBaseProjection(this.$state);
      const baseSecurityNoticeTexts = new Set();
      securityAdvance.incidents.forEach((incident) => {
        const opening = this.baseSecuritySummary.openings.find((entry) => entry.id === incident.openingId);
        const incidentText = formatBaseSecurityIncident(incident, opening?.label ?? incident.openingId);
        baseSecurityNoticeTexts.add(incidentText);
        result.notices.push(incidentText);
        this.mapLog.unshift({
          day: Math.floor(incident.hour / 24) + 1,
          time: formatClock((incident.hour % 24) * 60),
          title: incident.breached ? '据点防线出现破口' : '尸群冲击据点',
          text: incidentText,
          mode: 'base_security',
        });
      });
      result.baseSecurity = cloneSnapshot(securityAdvance);
      if (this.day > previousDay) {
        const migratedCount = this.refreshNodeZombieMigration();
        if (migratedCount > 0) result.notices.push(`尸群迁入了这个地区，附近重新出现约 ${migratedCount} 只游荡者。`);
      }
      this.survivalStats.hoursSurvived += result.elapsedHours;
      result.notices.forEach((notice) => {
        if (baseSecurityNoticeTexts.has(notice)) return;
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
      const activeExpedition = this.expeditionPlan;
      if (activeExpedition) {
        const context = expeditionContextForState(this.$state);
        const expeditionState = normalizeExpeditionState(this.expedition, context);
        const result = abandonExpeditionProjection(
          expeditionState,
          createExpeditionCommandToken(expeditionState, 'ending', this.totalWorldMinutes),
          context,
        );
        if (result.ok) this.expedition = result.nextState;
      }
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

function createExpeditionCommandToken(state, kind = 'command', totalMinutes = 0) {
  const safeKind = `${kind ?? 'command'}`.trim().replace(/[^a-zA-Z0-9:_-]+/g, '-').slice(0, 96) || 'command';
  const activeToken = state?.active?.id ?? `next-${Math.max(1, Number(state?.nextSequence) || 1)}`;
  const revision = Math.max(0, Number(state?.revision) || 0);
  return {
    commandId: `${safeKind}:${activeToken}:r${revision}:t${Math.max(0, Math.round(Number(totalMinutes) || 0))}`.slice(0, 180),
    expectedRevision: revision,
  };
}

function expeditionStoreFailure(state, reason) {
  return {
    ok: false,
    reason,
    replayed: false,
    revision: Math.max(0, Number(state?.revision) || 0),
    nextState: cloneSnapshot(state),
  };
}

function previewExpeditionPlanForState(state, request = {}) {
  const context = expeditionContextForState(state, { request });
  const expeditionState = normalizeExpeditionState(state?.expedition, context);
  if (requestedExpeditionSearchableIsInvalid(state, request)) {
    return expeditionStoreFailure(expeditionState, 'unknown_target_searchable');
  }
  return previewExpeditionPlanProjection(state?.expedition, request, context);
}

function requestedExpeditionSearchableIsInvalid(state, request) {
  if (request?.mode !== 'round_trip' || !Object.prototype.hasOwnProperty.call(request ?? {}, 'targetSearchable')) {
    return false;
  }
  const nodeId = typeof request?.targetNodeId === 'string' ? request.targetNodeId.trim() : '';
  const allowedNodeIds = new Set(uniqueValidNodeIds([
    ...(Array.isArray(state?.knownNodeIds) ? state.knownNodeIds : []),
    ...(Array.isArray(state?.visitedNodeIds) ? state.visitedNodeIds : []),
    state?.currentNodeId,
  ]));
  // Unknown destinations must retain the service's sanitized unknown_target
  // response instead of revealing whether any supplied descriptor exists.
  if (!nodeId || !allowedNodeIds.has(nodeId)) return false;
  const canonical = canonicalSceneSearchable(nodeId, request.targetSearchable);
  return !canonical || canonicalSceneSearchableKey(nodeId, canonical) !== request.targetSearchKey;
}

function reconcileLoadedExpeditionForState(state) {
  const context = expeditionContextForState(state);
  let normalized = normalizeExpeditionState(state?.expedition, context);
  const active = normalized.active;
  if (!active) return normalized;

  const archive = (kind) => {
    const result = abandonExpeditionProjection(
      normalized,
      createExpeditionCommandToken(normalized, kind, worldMinutesForState(state)),
      context,
    );
    return result.ok ? result.nextState : createExpeditionState();
  };
  if (loadedStateIsTerminal(state) || !state?.currentNodeId) return archive('load-ended');

  if (active.mode === 'round_trip' && active.phase !== 'returning' && active.objectiveState === 'pending') {
    const registry = canonicalSceneSearchableRegistry(active.targetNodeId);
    const exact = registry.find((entry) => entry.searchKey === active.targetSearchKey);
    const parts = `${active.targetSearchKey ?? ''}`.split(':');
    const migrated = !exact && parts.length === 2 && parts[0] === active.targetNodeId
      ? registry.find((entry) => entry.id === parts[1])
      : null;
    const target = exact ?? migrated;
    if (!target) return archive('load-invalid-objective');
    if (migrated) active.targetSearchKey = migrated.searchKey;
  }

  const physicalNodeId = state.currentNodeId;
  if (['outbound', 'returning'].includes(active.phase)) {
    const route = active.phase === 'returning' ? active.returnPath : active.outboundPath;
    const cursorNodeId = route[active.legIndex] ?? null;
    if (physicalNodeId !== cursorNodeId) {
      active.offRouteFromPhase = active.phase;
      active.phase = 'off_route';
      active.legIndex = 0;
    }
  } else if (active.phase === 'objective' && physicalNodeId !== active.targetNodeId) {
    active.offRouteFromPhase = 'outbound';
    active.phase = 'off_route';
    active.legIndex = 0;
  }
  return normalized;
}

function loadedStateIsTerminal(state) {
  if (state?.ending?.title) return true;
  if ((Number(state?.vitals?.health) || 0) <= 0 || (Number(state?.body?.infectionLevel) || 0) >= 100) return true;
  const day = Number(state?.day) || 1;
  const maxDay = Number(state?.maxDay) || 20;
  if (day > maxDay + 5) return true;
  if (day < maxDay || !['valley_checkpoint', 'louisville_outskirts'].includes(state?.currentNodeId)) return false;
  const zombieState = state?.nodeZombieStates?.[state.currentNodeId];
  return Boolean(zombieState && isNodeSecured(zombieState, worldMinutesForState(state)));
}

function survivorTerminalFailureForState(state) {
  return (Number(state?.vitals?.health) || 0) <= 0
    || (Number(state?.body?.infectionLevel) || 0) >= 100
    || (Number(state?.day) || 1) > (Number(state?.maxDay) || 20) + 5;
}

function expeditionContextForState(state, overrides = {}) {
  const allowedNodeIds = new Set(uniqueValidNodeIds([
    ...(Array.isArray(state?.knownNodeIds) ? state.knownNodeIds : []),
    ...(Array.isArray(state?.visitedNodeIds) ? state.visitedNodeIds : []),
    state?.currentNodeId,
  ]));
  const knownNodes = mapNodes.filter((node) => allowedNodeIds.has(node.id));
  const tacticalActive = Boolean(
    state?.activeTacticalEncounter
    && !isTacticalEncounterTerminal(state.activeTacticalEncounter)
  );
  return {
    // Only IDs that the survivor already knows cross the service boundary.
    // Names, descriptions, coordinates, and unknown-node danger never enter a
    // preview or a persisted expedition result.
    nodes: knownNodes.map((node) => ({
      id: node.id,
      risk: Math.max(0, Number(node.danger) || 0) ** 2,
    })),
    edges: mapEdges
      .filter(([from, to]) => allowedNodeIds.has(from) && allowedNodeIds.has(to))
      .map(([from, to]) => ({
        from,
        to,
        footMinutes: durationForAction('move'),
        workingMinutes: durationForAction('move', { vehicle: { status: 'working', fuel: 1 } }),
        damagedMinutes: durationForAction('move', { vehicle: { status: 'damaged', fuel: 1 } }),
        // Destination-node risk is already charged by the route service.
        // Keeping edge risk at zero prevents the same danger being counted twice.
        risk: 0,
      })),
    currentNodeId: allowedNodeIds.has(state?.currentNodeId) ? state.currentNodeId : null,
    totalMinutes: worldMinutesForState(state),
    planningAllowed: typeof overrides.planningAllowed === 'boolean'
      ? overrides.planningAllowed
      : expeditionPlanningAllowedForState(state, tacticalActive),
    tacticalActive,
    vehicle: (() => {
      const localVehicle = vehicleAtCurrentNodeForState(state);
      return { status: localVehicle.status, fuel: localVehicle.fuel };
    })(),
    inventory: (Array.isArray(state?.inventory) ? state.inventory : []).map((item) => ({
      id: item?.id,
      count: item?.count,
      space: item?.space,
      category: item?.category,
      tags: Array.isArray(item?.tags) ? [...item.tags] : [],
    })),
    capacity: inventoryCapacityForState(state, state?.inventory),
    searchables: expeditionSearchablesForState(
      state,
      allowedNodeIds,
      validatedRequestedExpeditionSearchable(state, allowedNodeIds, overrides.request),
    ),
  };
}

function expeditionPlanningAllowedForState(state, tacticalActive = false) {
  if (!state?.currentNodeId || tacticalActive || state?.ending?.title) return false;
  if ((Number(state?.vitals?.health) || 0) <= 0 || (Number(state?.body?.infectionLevel) || 0) >= 100) return false;
  if ((Number(state?.day) || 1) > (Number(state?.maxDay) || 20) + 5) return false;
  const now = worldMinutesForState(state);
  const zombieState = state?.nodeZombieStates?.[state.currentNodeId];
  const protectedAtHome = state.currentNodeId === state?.spawnLocation?.id
    && baseInteriorSafetyForState(state);
  const securedInWorld = Boolean(zombieState && isNodeSecured(zombieState, now));
  if (!protectedAtHome && !securedInWorld) return false;
  if (
    (Number(state?.day) || 1) >= (Number(state?.maxDay) || 20)
    && ['valley_checkpoint', 'louisville_outskirts'].includes(state.currentNodeId)
    && securedInWorld
  ) return false;
  return true;
}

function validatedRequestedExpeditionSearchable(state, allowedNodeIds, request) {
  const nodeId = typeof request?.targetNodeId === 'string' ? request.targetNodeId.trim() : '';
  const searchKey = typeof request?.targetSearchKey === 'string' ? request.targetSearchKey.trim() : '';
  const searchable = request?.targetSearchable;
  if (!nodeId || !searchKey || !allowedNodeIds.has(nodeId) || !searchable || typeof searchable !== 'object' || Array.isArray(searchable)) {
    return null;
  }
  const stateAtTarget = { ...state, currentNodeId: nodeId };
  const canonicalSearchable = canonicalSceneSearchable(nodeId, searchable);
  if (!canonicalSearchable) return null;
  const canonicalKey = sceneLootKeyForState(stateAtTarget, canonicalSearchable, searchKey);
  if (!canonicalKey || canonicalKey !== searchKey) return null;
  return { nodeId, searchKey: canonicalKey, searchable: canonicalSearchable };
}

function expeditionSearchablesForState(state, allowedNodeIds, requested = null) {
  const result = new Map();
  const addSearchable = (nodeId, searchable, searchKey, rawContainer = null) => {
    const canonicalSearchable = canonicalSceneSearchable(nodeId, searchable);
    if (!allowedNodeIds.has(nodeId) || !canonicalSearchable) return;
    const canonicalKey = canonicalSceneSearchableKey(nodeId, canonicalSearchable);
    if (!canonicalKey || canonicalKey !== searchKey) return;
    const stateAtNode = { ...state, currentNodeId: nodeId };
    const context = worldLootContextForState(stateAtNode, canonicalSearchable, searchKey);
    const legacyDepleted = !rawContainer && isLegacySceneLootDepleted(stateAtNode, canonicalSearchable);
    const container = rawContainer
      ? normalizeWorldLootContainer(rawContainer, context)
      : createSceneLootContainerForState(stateAtNode, context, searchKey);
    const summary = summarizeWorldLootContainer(container, context);
    result.set(searchKey, {
      searchKey,
      nodeId,
      searchMinutes: summary.searchCostPaid || legacyDepleted ? 0 : summary.searchCost.minutes,
      exhausted: legacyDepleted || summary.exhausted,
    });
  };

  Object.entries(state?.worldLootContainers ?? {}).forEach(([searchKey, rawContainer]) => {
    if (typeof searchKey !== 'string') return;
    const parts = searchKey.split(':');
    const nodeId = typeof rawContainer?.source?.nodeId === 'string'
      ? rawContainer.source.nodeId
      : parts[0];
    if (parts[0] !== nodeId || !allowedNodeIds.has(nodeId)) return;
    const searchable = canonicalSceneSearchableRegistry(nodeId)
      .find((entry) => entry.searchKey === searchKey);
    if (!searchable || (rawContainer?.source?.searchableId && rawContainer.source.searchableId !== searchable.id)) return;
    addSearchable(nodeId, searchable, searchKey, rawContainer);
  });

  for (const nodeId of allowedNodeIds) {
    for (const searchable of canonicalSceneSearchableRegistry(nodeId)) {
      const searchKey = searchable.searchKey;
      if (!result.has(searchKey)) addSearchable(nodeId, searchable, searchKey);
    }
  }
  if (requested && !result.has(requested.searchKey)) {
    addSearchable(requested.nodeId, requested.searchable, requested.searchKey);
  }
  return [...result.values()];
}

function buildVisibleMapNodes(state) {
  const adjacent = new Set(neighborsForNode(state.currentNodeId));
  return mapNodes.map((node) => {
    const visibility = mapNodeVisibilityForState(state, node.id);
    if (visibility === 'unknown') {
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        visibility,
        isAdjacent: false,
        canMove: false,
        displayName: '???',
        displayScale: 'normal',
        typeMeta: null,
      };
    }
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

function emptyVehicleState() {
  return { id: null, status: 'none', fuel: 0, name: '徒步', condition: 0, nodeId: null, trunkSpace: 0 };
}

function normalizeVehicle(vehicle, fallbackNodeId = null) {
  if (!vehicle || typeof vehicle !== 'object') return emptyVehicleState();
  const status = ['none', 'damaged', 'working'].includes(vehicle.status) ? vehicle.status : 'none';
  if (status === 'none') return emptyVehicleState();
  const archetype = vehicleEvents.find((entry) => entry.id === vehicle.id || entry.name === vehicle.name) ?? null;
  const validNodeIds = new Set(mapNodes.map((node) => node.id));
  const nodeId = validNodeIds.has(vehicle.nodeId)
    ? vehicle.nodeId
    : validNodeIds.has(fallbackNodeId) ? fallbackNodeId : null;
  return {
    id: archetype?.id ?? (typeof vehicle.id === 'string' && vehicle.id ? vehicle.id.slice(0, 80) : 'survivor_vehicle'),
    status,
    fuel: Math.max(0, Math.min(5, Number.isFinite(vehicle.fuel) ? Math.round(vehicle.fuel) : 0)),
    name: status === 'none' ? '徒步' : vehicle.name || (status === 'working' ? '可用车辆' : '受损车辆'),
    condition: Math.max(0, Math.min(100, Number.isFinite(vehicle.condition) ? Math.round(vehicle.condition) : 0)),
    nodeId,
    trunkSpace: clampInteger(vehicle.trunkSpace ?? archetype?.trunkSpace, 1, 200, status === 'working' ? 35 : 25),
  };
}

function isSameVehicleRefuel(current, projected) {
  const before = normalizeVehicle(current);
  const after = normalizeVehicle(projected);
  return before.status !== 'none'
    && after.status !== 'none'
    && before.id === after.id
    && before.nodeId === after.nodeId
    && before.name === after.name
    && before.condition === after.condition
    && before.trunkSpace === after.trunkSpace
    && after.fuel >= before.fuel;
}

function activeTravelVehicleForState(state) {
  const normalized = vehicleAtCurrentNodeForState(state);
  if (normalized.status === 'none' || normalized.fuel <= 0) return emptyVehicleState();
  return normalized;
}

function vehicleAtCurrentNodeForState(state) {
  const normalized = normalizeVehicle(state?.vehicle, state?.currentNodeId);
  if (normalized.status === 'none' || normalized.nodeId !== state?.currentNodeId) return emptyVehicleState();
  return normalized;
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
  const lootCatalog = marketItems.filter((item) => !item.tags?.includes('prepared'));
  const guarantees = [...universalLootGuaranteesForShelter(shelter), ...(profile.guaranteed ?? [])];
  const qualityTarget = defaultLootSlotsByQuality[shelter?.quality] ?? 12;
  const targetCount = Math.max(profile.slotCount ?? qualityTarget, qualityTarget, guarantees.length);
  const slots = guarantees
    .map((entry, index) => createLootSlot(pickGuaranteedItem(entry, profile, lootCatalog), index, 'guaranteed'))
    .filter(Boolean);

  let attempts = 0;
  while (slots.length < targetCount && attempts < targetCount * 40) {
    attempts += 1;
    const tier = pickLootTier();
    const item = pickWeightedItem(lootCatalog.filter((entry) => entry.tier === tier), profile);
    const slot = createLootSlot(item, slots.length, 'random');
    if (slot) slots.push(slot);
  }

  while (slots.length < targetCount) {
    const slot = createLootSlot(pickWeightedItem(lootCatalog, profile), slots.length, 'random');
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

function pickGuaranteedItem(entry, profile, lootCatalog = marketItems) {
  if (entry.itemId) return lootCatalog.find((item) => item.id === entry.itemId);
  let candidates = lootCatalog;
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
    spoilage: record.spoilage ? { ...record.spoilage } : undefined,
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

function isBeneficialVitalEffect(key, value) {
  if (['health', 'endurance'].includes(key)) return value > 0;
  if (['hunger', 'thirst', 'fatigue', 'panic', 'stress'].includes(key)) return value < 0;
  return false;
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

function cloneInventory(inventory) {
  return JSON.parse(JSON.stringify(Array.isArray(inventory) ? inventory : []));
}

function findInventoryStack(inventory, id, predicate = () => true) {
  const entries = Array.isArray(inventory) ? inventory : [];
  return entries.find((entry) => entry.stackId === id && entry.count > 0 && predicate(entry))
    ?? entries.find((entry) => (entry.id === id || entry.name === id) && entry.count > 0 && predicate(entry))
    ?? null;
}

function projectInventoryAddition(inventory, rawItem, count, {
  acquiredMinutes = 0,
  sequence = 1,
  sourceId = 'inventory',
} = {}) {
  const quantity = positiveInteger(count);
  const catalogItem = marketItems.find((item) => item.id === rawItem?.id || item.name === rawItem?.name);
  if (!catalogItem || !quantity) return { ok: false, inventory: cloneInventory(inventory), nextSequence: sequence };
  const next = normalizeStorageInventory(cloneInventory(inventory), marketItems, { containerId: STORAGE_CONTAINERS.CARRY });
  const usedIds = new Set(next.map((item) => item.stackId).filter(Boolean));
  let nextSequence = clampInteger(sequence, 1, 1_000_000_000, 1);
  const isWeapon = catalogItem.tags?.includes('weapon');
  const isIndividualEquipment = isWeapon || catalogItem.tags?.includes('bag');

  if (isIndividualEquipment) {
    for (let index = 0; index < quantity; index += 1) {
      const conditionState = rawItem?.conditionState
        ? normalizeItemConditionState(rawItem.conditionState, catalogItem)
        : createItemConditionState(catalogItem, {
          acquiredMinutes,
          acquisitionSequence: nextSequence,
          sourceId,
        });
      const stackId = uniqueRuntimeStackId(conditionState.stackId, usedIds);
      next.push({
        ...cloneCatalogRecord(catalogItem),
        count: 1,
        stackId,
        conditionState: { ...cloneSnapshot(conditionState), instanceId: stackId, stackId },
        ...(isWeapon ? { repairCount: clampInteger(rawItem?.repairCount, 0, 50, 0) } : {}),
      });
      nextSequence += 1;
    }
    return { ok: true, inventory: next, nextSequence };
  }

  const conditionState = rawItem?.conditionState
    ? normalizeItemConditionState(rawItem.conditionState, catalogItem)
    : createItemConditionState(catalogItem, {
      acquiredMinutes,
      acquisitionSequence: nextSequence,
      sourceId,
    });
  const mergeTarget = next.find((entry) => (
    entry.id === catalogItem.id
    && !entry.tags?.includes('weapon')
    && canMergeItemConditionStates(entry.conditionState, conditionState)
  ));
  if (mergeTarget) {
    mergeTarget.count = Math.min(999_999, mergeTarget.count + quantity);
  } else {
    const stackId = uniqueRuntimeStackId(conditionState.stackId, usedIds);
    next.push({
      ...cloneCatalogRecord(catalogItem),
      count: quantity,
      stackId,
      conditionState: { ...cloneSnapshot(conditionState), instanceId: stackId, stackId },
    });
  }
  nextSequence = Math.min(1_000_000_000, nextSequence + quantity);
  return { ok: true, inventory: next, nextSequence };
}

function projectInventoryRemoval(inventory, id, count) {
  const quantity = positiveInteger(count);
  const original = normalizeStorageInventory(cloneInventory(inventory), marketItems, { containerId: STORAGE_CONTAINERS.CARRY });
  if (!quantity) return { ok: false, inventory: original };
  const exact = original.find((entry) => entry.stackId === id);
  const matches = exact
    ? [exact]
    : original.filter((entry) => entry.id === id || entry.name === id);
  if (matches.reduce((sum, entry) => sum + positiveInteger(entry.count), 0) < quantity) {
    return { ok: false, inventory: original };
  }
  let remaining = quantity;
  for (const entry of matches) {
    if (remaining <= 0) break;
    const removed = Math.min(remaining, entry.count);
    entry.count -= removed;
    remaining -= removed;
  }
  return { ok: true, inventory: original.filter((entry) => entry.count > 0) };
}

function projectExactInventoryRemoval(inventory, stackId, count) {
  const quantity = positiveInteger(count);
  const projected = cloneInventory(inventory);
  if (!quantity || typeof stackId !== 'string' || !stackId) return { ok: false, inventory: projected };
  const entry = projected.find((item) => item.stackId === stackId);
  if (!entry || positiveInteger(entry.count) < quantity) return { ok: false, inventory: projected };
  entry.count -= quantity;
  return { ok: true, inventory: projected.filter((item) => item.count > 0) };
}

function projectInventoryTransaction(inventory, {
  consume = [],
  add = [],
  acquiredMinutes = 0,
  sequence = 1,
  sourceId = 'transaction',
} = {}) {
  let projected = normalizeStorageInventory(cloneInventory(inventory), marketItems, { containerId: STORAGE_CONTAINERS.CARRY });
  let nextSequence = sequence;
  for (const request of consume) {
    const removal = projectInventoryRemoval(projected, request?.id, request?.count ?? 1);
    if (!removal.ok) return { ok: false, inventory: cloneInventory(inventory), nextSequence: sequence };
    projected = removal.inventory;
  }
  for (const request of add) {
    const addition = projectInventoryAddition(projected, request?.item, request?.count ?? 1, {
      acquiredMinutes,
      sequence: nextSequence,
      sourceId,
    });
    if (!addition.ok) return { ok: false, inventory: cloneInventory(inventory), nextSequence: sequence };
    projected = addition.inventory;
    nextSequence = addition.nextSequence;
  }
  return { ok: true, inventory: projected, nextSequence };
}

function uniqueRuntimeStackId(rawId, usedIds) {
  const base = typeof rawId === 'string' && rawId ? rawId : 'item:stack';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}~${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function baseSecurityContextForState(state) {
  const exteriorPopulation = Math.max(
    0,
    Math.round(Number(state.nodeZombieStates?.[state.spawnLocation?.id]?.count) || 0),
  );
  return {
    shelter: state.shelter,
    shelterDefense: state.shelter?.defense ?? 0,
    totalMinutes: worldMinutesForState(state),
    day: state.day,
    threat: state.world?.threat,
    noise: state.world?.noise,
    generatorOn: Boolean(state.base?.generatorOn),
    exteriorPopulation,
  };
}

function baseInteriorSafetyForState(state) {
  const summary = summarizeBaseSecurity(state.baseSecurity, baseSecurityContextForState(state));
  return Boolean(summary.interiorSafe || summary.exteriorPopulation <= 0);
}

function decorateBaseSecuritySummary(rawSummary) {
  const summary = rawSummary && typeof rawSummary === 'object' ? cloneSnapshot(rawSummary) : {};
  const structuralInteriorSafe = Boolean(summary.interiorSafe);
  const interiorSafe = structuralInteriorSafe || (Number(summary.exteriorPopulation) || 0) <= 0;
  const pressure = Math.max(0, Math.round(Number(summary.currentPressure) || 0));
  const statusLabel = summary.status === 'breached'
    ? interiorSafe ? '防线有破口 · 外围已清空' : '防线破口 · 尸群正在逼近'
    : summary.status === 'damaged' ? '防线受损' : '防线完整';
  const statusTone = summary.status === 'breached'
    ? interiorSafe ? 'warn' : 'danger'
    : summary.status === 'damaged' ? 'warn' : 'good';
  const pressureBand = pressure >= 75 ? '极高' : pressure >= 50 ? '高' : pressure >= 25 ? '中' : pressure > 0 ? '低' : '无';
  const pressureLabel = `${pressure} · ${pressureBand}`;
  const sources = summary.currentPressureSources ?? {};
  const pressureSource = [
    `外围 ${Math.max(0, Math.round(Number(sources.exteriorPopulation) || 0))} 只`,
    `威胁 ${Math.max(0, Math.round(Number(sources.threat) || 0))}`,
    `噪声 ${Math.max(0, Math.round(Number(sources.noise) || 0))}`,
    Number(sources.generator) > 0 ? '发电机运转' : '',
  ].filter(Boolean).join(' / ');
  const lastIncident = summary.lastIncident;
  return {
    ...summary,
    structuralInteriorSafe,
    interiorSafe,
    statusLabel,
    statusTone,
    pressure,
    pressureLabel,
    pressureSource,
    lastIncidentLabel: lastIncident
      ? formatBaseSecurityIncident(lastIncident, summary.openings?.find((entry) => entry.id === lastIncident.openingId)?.label ?? lastIncident.openingId)
      : '',
    openings: (Array.isArray(summary.openings) ? summary.openings : []).map((opening) => {
      const status = opening.integrity <= 0
        ? 'breached'
        : opening.integrity < opening.maxIntegrity ? 'damaged' : opening.barricade > 0 ? 'fortified' : 'intact';
      const matchingIncident = lastIncident?.openingId === opening.id ? lastIncident : null;
      return {
        ...opening,
        status,
        statusLabel: status === 'breached' ? '破口' : status === 'damaged' ? '受损' : status === 'fortified' ? '已加固' : '完整',
        statusTone: status === 'breached' ? 'danger' : status === 'damaged' ? 'warn' : 'good',
        lastImpactLabel: matchingIncident
          ? formatBaseSecurityIncident(matchingIncident, opening.label)
          : '',
      };
    }),
  };
}

function syncLegacyBaseProjection(state) {
  if (!state.base || typeof state.base !== 'object') state.base = createBaseState(state.shelter);
  const summary = summarizeBaseSecurity(state.baseSecurity, baseSecurityContextForState(state));
  state.base.defense = summary.legacyBaseProjection.defense;
  state.base.barricades = summary.legacyBaseProjection.barricades;
  return summary.legacyBaseProjection;
}

function baseWorkContextForState(state, accessAllowed = false) {
  return {
    containers: {
      carry: cloneInventory(Array.isArray(state.inventory) ? state.inventory : []),
      base: cloneInventory(Array.isArray(state.baseInventory) ? state.baseInventory : []),
    },
    catalog: marketItems,
    capacities: {
      carry: inventoryCapacityForState(state, state.inventory),
      base: baseStorageCapacity(state.shelter),
    },
    carpentrySkill: clampInteger(state.skills?.carpentry, 0, 10, 0),
    totalMinutes: worldMinutesForState(state),
    accessAllowed: Boolean(accessAllowed),
    shelter: state.shelter,
  };
}

function baseWorkAccessFailure(store) {
  if (store.isGameOver) return 'game_over';
  if (store.runPhase !== 'running') return 'not_running';
  if (store.activeTacticalEncounter && !isTacticalEncounterTerminal(store.activeTacticalEncounter)) {
    return 'active_tactical_encounter';
  }
  if (!store.currentNodeId || store.currentNodeId !== store.spawnLocation?.id) return 'not_at_home';
  const summary = store.baseSecuritySummary;
  if ((summary?.breachedCount ?? 0) > 0 && (summary?.exteriorPopulation ?? 0) > 0) {
    return 'exterior_not_cleared';
  }
  return '';
}

function baseWorkStoreFailure(state, reason, details = {}) {
  const safeDetails = details && typeof details === 'object' ? cloneSnapshot(details) : {};
  const normalized = normalizeBaseSecurity(state?.baseSecurity, {
    shelter: state?.shelter,
    totalMinutes: worldMinutesForState(state ?? {}),
  });
  return {
    ...safeDetails,
    ok: false,
    committed: false,
    reason: typeof reason === 'string' && reason ? reason : 'invalid_command',
    replayed: Boolean(safeDetails.replayed),
    revision: normalized.revision,
    nextState: {
      baseSecurity: cloneSnapshot(normalized),
      containers: {
        carry: cloneInventory(Array.isArray(state?.inventory) ? state.inventory : []),
        base: cloneInventory(Array.isArray(state?.baseInventory) ? state.baseInventory : []),
      },
    },
  };
}

function validBaseWorkProjection(result, state, command) {
  if (!result?.nextState || typeof result.nextState !== 'object') return false;
  if (!Array.isArray(result.nextState.containers?.carry) || !Array.isArray(result.nextState.containers?.base)) return false;
  if (!Number.isInteger(result.minutes) || result.minutes <= 0 || result.minutes > 24 * 60) return false;
  const current = normalizeBaseSecurity(state.baseSecurity, {
    shelter: state.shelter,
    totalMinutes: worldMinutesForState(state),
  });
  const projected = normalizeBaseSecurity(result.nextState.baseSecurity, {
    shelter: state.shelter,
    totalMinutes: worldMinutesForState(state),
  });
  const commandId = typeof command?.commandId === 'string' ? command.commandId.trim().slice(0, 240) : '';
  if (projected.revision !== Math.min(1_000_000_000, current.revision + 1)) return false;
  if (!commandId || projected.appliedCommandIds.at(-1) !== commandId) return false;
  if (storageUsedSpace(result.nextState.containers.carry) > inventoryCapacityForState(state, result.nextState.containers.carry)) return false;
  if (storageUsedSpace(result.nextState.containers.base) > baseStorageCapacity(state.shelter)) return false;
  return true;
}

function formatBaseSecurityIncident(incident, openingLabel = '入口') {
  const barricadeDamage = Math.max(0, Math.round(Number(incident?.barricadeDamage) || 0));
  const integrityDamage = Math.max(0, Math.round(Number(incident?.integrityDamage) || 0));
  const damageText = [
    barricadeDamage ? `路障损失 ${barricadeDamage}` : '',
    integrityDamage ? `结构损失 ${integrityDamage}` : '',
  ].filter(Boolean).join('，') || '防线没有受到有效损伤';
  const source = incident?.sources ?? {};
  return `${openingLabel}遭到外围尸群冲击：${damageText}。压力 ${Math.max(0, Math.round(Number(incident?.pressure) || 0))}（外围 ${Math.max(0, Math.round(Number(source.exteriorPopulation) || 0))} 只 / 噪声 ${Math.max(0, Math.round(Number(source.noise) || 0))}）${incident?.breached ? '，入口已经被撞破！' : ''}`;
}

function storageAccessForState(state) {
  const now = worldMinutesForState(state);
  const zombieState = state.currentNodeId ? state.nodeZombieStates?.[state.currentNodeId] : null;
  const normallySecured = Boolean(state.currentNodeId && zombieState && isNodeSecured(zombieState, now));
  const atHomeNode = Boolean(state.currentNodeId && state.currentNodeId === state.spawnLocation?.id);
  const protectedAtHome = atHomeNode && baseInteriorSafetyForState(state);
  const secured = atHomeNode ? protectedAtHome : normallySecured;
  const atHome = atHomeNode && protectedAtHome;
  const vehicle = normalizeVehicle(state.vehicle, state.currentNodeId);
  const atTrunk = secured && normallySecured && vehicle.status !== 'none' && vehicle.nodeId === state.currentNodeId;
  return { carry: true, base: atHome, trunk: atTrunk, secured, normallySecured, vehicle };
}

function storageContextForState(state) {
  const access = storageAccessForState(state);
  return {
    containers: {
      carry: Array.isArray(state.inventory) ? state.inventory : [],
      base: Array.isArray(state.baseInventory) ? state.baseInventory : [],
      trunk: Array.isArray(state.vehicleInventory) ? state.vehicleInventory : [],
    },
    access: { base: access.base, trunk: access.trunk },
    skills: state.skills,
    selectedTraits: state.selectedTraits,
    shelter: state.shelter,
    vehicle: access.vehicle,
    equippedBagStackId: state.equippedBagStackId,
  };
}

function createTransferQuote(state, request = {}) {
  const fromId = request.fromId ?? request.from;
  const toId = request.toId ?? request.to;
  const stackId = request.stackId;
  const context = storageContextForState(state);
  const source = context.containers?.[fromId];
  const item = Array.isArray(source) ? source.find((entry) => entry.stackId === stackId) : null;
  if (!item) return transferFailureResult({ reason: 'source_stack_missing' }, 0);
  if (fromId === STORAGE_CONTAINERS.BASE && item.id === 'generator' && state.base?.generatorOn) {
    return transferFailureResult({ reason: 'generator_running' }, 0);
  }
  if (!context.access[fromId] && fromId !== 'carry') return transferFailureResult({ reason: 'inaccessible_source' }, 0);
  if (!context.access[toId] && toId !== 'carry') return transferFailureResult({ reason: 'inaccessible_destination' }, 0);
  if (state.currentNodeId && !storageAccessForState(state).secured) {
    return { ok: false, committed: false, fromId, toId, stackId, maxQuantity: 0, disabledReason: '遭遇中无法整理容器', reason: 'active_encounter' };
  }

  let maxQuantity = 0;
  let limitingFailure = null;
  for (let quantity = 1; quantity <= Math.min(9999, item.count); quantity += 1) {
    const preview = previewStorageTransfer(context, { from: fromId, to: toId, stackId, count: quantity });
    if (!preview.ok) {
      limitingFailure = preview;
      break;
    }
    maxQuantity = quantity;
  }
  const requested = request.quantity ?? request.count ?? maxQuantity;
  const quantity = positiveInteger(requested);
  if (!quantity || quantity > maxQuantity) {
    if (maxQuantity === 0 && limitingFailure) {
      return {
        ...transferFailureResult(limitingFailure, 0),
        fromId,
        toId,
        stackId,
        item,
        quantity,
      };
    }
    return {
      ok: false,
      committed: false,
      fromId,
      toId,
      stackId,
      item,
      quantity,
      maxQuantity,
      disabledReason: maxQuantity > 0 ? `最多只能转移 ${maxQuantity} 件` : '目标容器没有足够空间',
      reason: maxQuantity > 0 ? 'insufficient_quantity' : 'destination_over_capacity',
    };
  }
  const result = previewStorageTransfer(context, { from: fromId, to: toId, stackId, count: quantity });
  if (!result.ok) return transferFailureResult(result, maxQuantity);
  return { ok: true, committed: false, fromId, toId, stackId, item, quantity, maxQuantity, disabledReason: '', reason: null };
}

function transferFailureResult(result = {}, maxQuantity = 0) {
  const messages = {
    invalid_request: '转移请求无效',
    invalid_container: '容器不存在',
    invalid_count: '数量必须是正整数',
    same_container: '来源和目标不能相同',
    inaccessible_source: '当前无法接触来源容器',
    inaccessible_destination: '当前无法接触目标容器',
    source_stack_missing: '物品已经不在来源容器中',
    insufficient_quantity: '来源数量不足',
    destination_over_capacity: '目标容器空间不足',
    equipped_bag_required: '卸下这个背包后随身物资会超重',
    generator_running: '先关闭发电机，再移动据点设备',
  };
  return {
    ok: false,
    committed: false,
    maxQuantity,
    disabledReason: messages[result.reason] ?? '无法完成这次转移',
    reason: result.reason ?? 'invalid_request',
  };
}

function transferDurationMinutes(item, quantity) {
  const effort = Math.max(1, Number(item?.space) || 1) * Math.max(1, quantity);
  return Math.min(30, 5 + Math.ceil(effort * 1.5));
}

function storageName(id) {
  return id === 'base' ? '据点仓储' : id === 'trunk' ? '车辆后备箱' : '随身背包';
}

function buildStorageContainers(state) {
  const access = storageAccessForState(state);
  const definitions = [
    {
      id: 'carry',
      name: '随身背包',
      items: state.inventory,
      capacity: carryStorageCapacity({
        skills: state.skills,
        selectedTraits: state.selectedTraits,
        inventory: state.inventory,
        equippedBagStackId: state.equippedBagStackId,
      }),
      accessible: true,
      accessReason: '',
      preservationLabel: '常温携带',
    },
    {
      id: 'base',
      name: '据点仓储',
      items: state.baseInventory,
      capacity: baseStorageCapacity(state.shelter),
      accessible: access.base,
      accessReason: access.base ? '' : state.currentNodeId !== state.spawnLocation?.id ? '需要返回初始据点' : '先处理据点附近的尸群',
      preservationLabel: state.world?.powerOn ? '通电冷藏 · 腐败速度 20%' : '断电 · 常温腐败',
    },
    {
      id: 'trunk',
      name: `${access.vehicle.name === '徒步' ? '车辆' : access.vehicle.name}后备箱`,
      items: state.vehicleInventory,
      capacity: trunkStorageCapacity(access.vehicle),
      accessible: access.trunk,
      accessReason: access.trunk ? '' : access.vehicle.status === 'none' ? '当前没有车辆' : access.vehicle.nodeId !== state.currentNodeId ? `车辆停在${mapNodes.find((node) => node.id === access.vehicle.nodeId)?.name ?? '其他地区'}` : '先处理车辆附近的尸群',
      preservationLabel: '后备箱常温',
    },
  ];
  return definitions.map((container) => ({
    ...container,
    kind: container.id,
    usedSpace: storageUsedSpace(container.items),
    items: (Array.isArray(container.items) ? container.items : []).map((item) => decorateStorageItem(item, state, container.id)),
  }));
}

function decorateStorageItem(item, state, containerId = 'carry') {
  const condition = getItemConditionDisplay(item.conditionState);
  const freshness = item.conditionState?.freshness ? condition : null;
  const durability = item.conditionState?.condition ? condition : null;
  const supportsUse = ['food', 'medical', 'morale'].includes(item.category);
  const supportsEquip = item.tags?.includes('weapon') || item.tags?.includes('bag');
  return {
    ...item,
    freshness: freshness ? { ...freshness, detail: itemConditionDetail(item.conditionState) } : null,
    condition: durability ? { ...durability, detail: itemConditionDetail(item.conditionState) } : null,
    canUse: supportsUse && containerId === 'carry' && !(state.currentNodeId && !storageAccessForState(state).secured),
    useDisabledReason: supportsUse && containerId !== 'carry'
      ? '先转移到随身背包'
      : supportsUse && state.currentNodeId && !storageAccessForState(state).secured ? '遭遇中无法使用物品' : '',
    canEquip: supportsEquip && containerId === 'carry' && !(durability?.disabledReason),
    equipDisabledReason: containerId !== 'carry' ? '先转移到随身背包' : durability?.disabledReason ?? '',
    canRepair: Boolean(containerId === 'carry' && durability && item.conditionState.condition.current < item.conditionState.condition.maximum),
  };
}

function itemConditionDetail(conditionState) {
  if (conditionState?.condition) {
    return `${Math.round(conditionState.condition.current)} / ${Math.round(conditionState.condition.maximum)}`;
  }
  const freshness = conditionState?.freshness;
  if (!freshness?.perishable) return freshness ? '不会自然腐败' : '';
  if (freshness.state === 'rotten') return '已经腐败，食用会导致疾病';
  const target = freshness.state === 'fresh' ? freshness.freshForMinutes : freshness.rottenAfterMinutes;
  const remaining = Math.max(0, target - freshness.spoilageMinutes);
  return `约 ${formatConditionDuration(remaining)}后${freshness.state === 'fresh' ? '变得不新鲜' : '腐败'}`;
}

function formatConditionDuration(minutes) {
  if (minutes >= 24 * 60) return `${Math.ceil(minutes / (24 * 60))} 天`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} 小时`;
  return `${Math.max(1, Math.ceil(minutes))} 分钟`;
}

function splitStartingStorage(state) {
  let containers = {
    carry: cloneInventory(state.inventory),
    base: cloneInventory(state.baseInventory),
    trunk: cloneInventory(state.vehicleInventory),
  };
  const bestBag = [...containers.carry]
    .filter((item) => item.tags?.includes('bag'))
    .sort((left, right) => (right.effects?.capacity ?? 0) - (left.effects?.capacity ?? 0))[0] ?? null;
  let equippedBagStackId = bestBag?.stackId ?? null;
  const context = {
    containers,
    access: { base: true, trunk: true },
    skills: state.skills,
    selectedTraits: state.selectedTraits,
    shelter: state.shelter,
    vehicle: state.vehicle,
    equippedBagStackId,
  };
  let capacity = carryStorageCapacity({ ...context, inventory: containers.carry });
  // A fresh survivor should leave home with room to loot instead of starting
  // at the absolute carry limit. Keep roughly one quarter of the pack free;
  // low-priority and bulky setup supplies stay in the base inventory.
  let targetCarrySpace = Math.max(1, Math.floor(capacity * 0.75));
  let safety = 0;
  while (storageUsedSpace(containers.carry) > targetCarrySpace && safety < 1000) {
    safety += 1;
    const candidate = [...containers.carry]
      .filter((item) => item.stackId !== equippedBagStackId)
      .sort((left, right) => startingCarryPriority(left) - startingCarryPriority(right))[0];
    if (!candidate) break;
    const excess = storageUsedSpace(containers.carry) - targetCarrySpace;
    const unitSpace = Math.max(0.01, Number(candidate.space) || 1);
    const quantity = Math.min(candidate.count, Math.max(1, Math.ceil(excess / unitSpace)));
    const projected = projectStorageTransfer({ ...context, containers, equippedBagStackId }, {
      from: 'carry',
      to: 'base',
      stackId: candidate.stackId,
      count: quantity,
    });
    if (!projected.ok) break;
    containers = projected.containers;
    equippedBagStackId = projected.nextEquippedBagStackId;
    capacity = projected.capacities.carry;
    targetCarrySpace = Math.max(1, Math.floor(capacity * 0.75));
  }
  const weapon = containers.carry.find((item) => item.stackId === state.equippedWeaponStackId && !isWeaponBroken(item.conditionState))
    ?? containers.carry.find((item) => item.id === state.equippedWeaponId && item.tags?.includes('weapon') && !isWeaponBroken(item.conditionState))
    ?? containers.carry.find((item) => item.tags?.includes('weapon') && !isWeaponBroken(item.conditionState));
  return {
    inventory: containers.carry,
    baseInventory: containers.base,
    equippedBagStackId,
    equippedWeaponStackId: weapon?.stackId ?? null,
    equippedWeaponId: weapon?.id ?? null,
  };
}

function startingCarryPriority(item) {
  if (item.tags?.includes('bag')) return 15;
  if (item.tags?.includes('weapon')) return 90;
  if (item.tags?.includes('water')) return 88;
  if (item.category === 'medical') return 85;
  if (item.category === 'food') return 80;
  if (item.category === 'ammo') return 70;
  if (item.tags?.includes('tool')) return 55;
  if (item.tags?.includes('heavy') || item.tags?.includes('generator')) return 5;
  return 35;
}

function advanceInventoryConditionStates(inventory, {
  elapsedMinutes = 0,
  refrigerated = false,
  poweredMinutes = 0,
} = {}) {
  const elapsed = Math.max(0, Number(elapsedMinutes) || 0);
  return cloneInventory(inventory).map((item) => {
    let conditionState = normalizeItemConditionState(item.conditionState ?? item, item);
    if (!conditionState.freshness || elapsed <= 0) return { ...item, conditionState };
    if (!refrigerated) {
      conditionState = advanceFoodSpoilage(conditionState, { elapsedMinutes: elapsed });
    } else {
      const powered = Math.max(0, Math.min(elapsed, Number(poweredMinutes) || 0));
      if (powered > 0) conditionState = advanceFoodSpoilage(conditionState, { elapsedMinutes: powered, refrigerated: true, powerOn: true });
      if (elapsed > powered) conditionState = advanceFoodSpoilage(conditionState, { elapsedMinutes: elapsed - powered, refrigerated: true, powerOn: false });
    }
    return { ...item, conditionState };
  });
}

function mapNodeVisibilityForState(state, nodeId) {
  if (!nodeId || !mapNodes.some((node) => node.id === nodeId)) return 'unknown';
  if (nodeId === state?.currentNodeId) return 'current';
  if (uniqueValidNodeIds(state?.visitedNodeIds).includes(nodeId)) return 'visited';
  if (
    uniqueValidNodeIds(state?.knownNodeIds).includes(nodeId)
    || neighborsForNode(state?.currentNodeId).includes(nodeId)
  ) return 'known';
  return 'unknown';
}

function advanceWorldLootConditionStates(containers, elapsedMinutes = 0) {
  const elapsed = Math.max(0, Number(elapsedMinutes) || 0);
  if (!elapsed || !containers || typeof containers !== 'object' || Array.isArray(containers)) {
    return containers && typeof containers === 'object' && !Array.isArray(containers) ? cloneSnapshot(containers) : {};
  }
  return Object.fromEntries(Object.entries(cloneSnapshot(containers)).map(([key, container]) => [
    key,
    {
      ...container,
      slots: Array.isArray(container?.slots) ? container.slots.map((slot) => {
        if (slot?.status === 'claimed' || !slot?.item) return slot;
        const catalogItem = marketItems.find((entry) => entry.id === slot.item.id);
        if (!catalogItem) return slot;
        let conditionState = normalizeItemConditionState(slot.item.conditionState, catalogItem);
        if (conditionState.freshness) conditionState = advanceFoodSpoilage(conditionState, { elapsedMinutes: elapsed });
        return { ...slot, item: { ...slot.item, conditionState } };
      }) : [],
    },
  ]));
}

function createSceneLootContainerForState(state, context, key) {
  const generated = createWorldLootContainer(context);
  const elapsedSinceOutbreakStart = Math.max(0, worldMinutesForState(state) - START_MINUTE);
  return advanceWorldLootConditionStates({ [key]: generated }, elapsedSinceOutbreakStart)[key];
}

function sceneLootKeyForState(state, searchable, requestedKey = '') {
  const nodeId = typeof state?.currentNodeId === 'string' ? state.currentNodeId : '';
  const objectId = typeof searchable?.id === 'string' ? searchable.id.trim() : '';
  if (!nodeId || !objectId) return '';
  const parentSection = typeof searchable?.parentSection === 'string' ? searchable.parentSection.trim() : '';
  const parentId = typeof searchable?.parentId === 'string' ? searchable.parentId.trim() : '';
  const canonical = [nodeId, parentSection, parentId, objectId].filter(Boolean).join(':');
  if (!requestedKey) return canonical;
  return typeof requestedKey === 'string' && requestedKey.trim() === canonical ? canonical : '';
}

const SCENE_PARENT_SECTIONS = Object.freeze([
  ['landmark', 'landmarks'],
  ['building', 'buildings'],
]);

const SCENE_QUALITY_ORDER = Object.freeze(['white', 'green', 'blue', 'purple', 'gold', 'red']);

function canonicalSceneSearchableRegistry(nodeId) {
  const detail = mapNodeDetails[nodeId];
  if (!detail) return [];
  const parents = SCENE_PARENT_SECTIONS.flatMap(([section, collection]) => (
    (Array.isArray(detail[collection]) ? detail[collection] : []).map((parent) => ({
      ...parent,
      section,
    }))
  ));
  const assignedDirectIds = new Set();
  const result = [];
  const seenKeys = new Set();
  const add = (descriptor) => {
    const key = canonicalSceneSearchableKey(nodeId, descriptor);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    result.push(Object.freeze({ ...descriptor, searchKey: key }));
  };

  for (const direct of Array.isArray(detail.searchables) ? detail.searchables : []) {
    const parent = parents.find((entry) => sceneSearchableMatchesParent(direct, entry));
    if (!parent) continue;
    assignedDirectIds.add(direct.id);
    add(canonicalNestedSceneSearchable(direct, parent));
  }
  for (const direct of Array.isArray(detail.searchables) ? detail.searchables : []) {
    if (!assignedDirectIds.has(direct.id)) add(canonicalRootSceneSearchable(direct));
  }
  for (const parent of parents) {
    const explicit = Array.isArray(parent.searchables) && parent.searchables.length > 0
      ? parent.searchables
      : [];
    const generated = explicit.length > 0 ? [] : generatedSceneSearchablesForParent(parent);
    for (const child of [...explicit, ...generated]) add(canonicalNestedSceneSearchable(child, parent));
  }
  return result;
}

function canonicalSceneSearchableKey(nodeId, searchable) {
  const objectId = typeof searchable?.id === 'string' ? searchable.id.trim() : '';
  if (!nodeId || !objectId) return '';
  const parentSection = typeof searchable?.parentSection === 'string' ? searchable.parentSection.trim() : '';
  const parentId = typeof searchable?.parentId === 'string' ? searchable.parentId.trim() : '';
  return parentSection && parentId
    ? `${nodeId}:${parentSection}:${parentId}:${objectId}`
    : `${nodeId}:${objectId}`;
}

function canonicalSceneSearchable(nodeId, requested) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return null;
  const objectId = typeof requested.id === 'string' ? requested.id.trim() : '';
  if (!objectId) return null;
  const parentSection = typeof requested.parentSection === 'string' ? requested.parentSection.trim() : '';
  const parentId = typeof requested.parentId === 'string' ? requested.parentId.trim() : '';
  const registry = canonicalSceneSearchableRegistry(nodeId);
  let canonical = registry.find((entry) => (
    entry.id === objectId
    && (entry.parentSection ?? '') === parentSection
    && (entry.parentId ?? '') === parentId
  ));
  // Existing callers may still pass the direct catalog record without its
  // derived parent. Resolve that record to the one registry identity instead
  // of creating a second two-part alias.
  if (!canonical && !parentSection && !parentId) {
    const direct = (mapNodeDetails[nodeId]?.searchables ?? []).find((entry) => entry.id === objectId);
    if (direct && sceneSearchableCatalogFieldsMatch(requested, direct)) {
      canonical = registry.find((entry) => entry.id === objectId) ?? null;
    }
  }
  if (!canonical || !sceneSearchableCatalogFieldsMatch(requested, canonical)) return null;
  const { searchKey: _searchKey, ...descriptor } = canonical;
  return cloneSnapshot(descriptor);
}

function sceneSearchableCatalogFieldsMatch(requested, canonical) {
  return ['name', 'quality', 'assetId'].every((field) => (
    requested[field] === undefined || requested[field] === canonical[field]
  ));
}

function canonicalRootSceneSearchable(entry) {
  return {
    id: entry.id,
    name: entry.name,
    assetId: entry.assetId,
    quality: entry.quality,
    description: entry.description,
  };
}

function canonicalNestedSceneSearchable(entry, parent) {
  return {
    id: entry.id || `${parent.id}_${sceneSlug(entry.name)}`,
    name: entry.name,
    assetId: entry.assetId || parent.assetId || 'tile_locker',
    quality: entry.quality || sceneQualityForParent(parent),
    description: entry.description || `${parent.name}里还有一处可以翻找的角落。`,
    parentSection: parent.section,
    parentId: parent.id,
    parentName: parent.name,
  };
}

function sceneSearchableMatchesParent(searchable, parent) {
  const text = `${parent.name} ${parent.description ?? ''} ${parent.assetId ?? ''}`.toLowerCase();
  const target = `${searchable.name} ${searchable.description ?? ''} ${searchable.assetId ?? ''}`.toLowerCase();
  return text.split(/\s+/).some((part) => part.length >= 3 && target.includes(part))
    || parent.assetId === searchable.assetId
    || target.includes(parent.name.toLowerCase().slice(0, 2));
}

function generatedSceneSearchablesForParent(parent) {
  const text = `${parent.name} ${parent.description ?? ''} ${parent.assetId ?? ''}`.toLowerCase();
  const quality = sceneQualityForParent(parent);
  const make = (suffix, name, assetId, description, tierShift = 0) => ({
    id: `${parent.id}_${suffix}`,
    name,
    assetId,
    quality: shiftedSceneQuality(quality, tierShift),
    description,
  });
  if (/药|医|诊|hospital|clinic|medical|med/.test(text)) {
    return [
      make('medicine_cabinet', '药柜', 'tile_medical', '药品、绷带和消毒用品集中。', 1),
      make('first_aid_case', '急救箱', 'tile_medical', '急救包、止痛药和β受体阻滞剂。'),
    ];
  }
  if (/警|枪|弹|gun|police|ammo|cruiser/.test(text)) {
    return [
      make('duty_locker', '值班储物柜', 'tile_locker', '弹药、手电和钥匙线索。', 1),
      make('desk_drawer', '办公桌抽屉', 'tile_police', '文件、地图碎片和少量警用补给。'),
    ];
  }
  if (/消防|斧|fire/.test(text)) {
    return [
      make('axe_locker', '斧头柜', 'tile_fire', '消防斧、手斧和防护装备。', 1),
      make('tool_wall', '工具墙', 'tile_locker', '喷灯、胶带和维修工具。'),
    ];
  }
  if (/餐|厨|食|饮|罐头|冰柜|杂货|store|restaurant|kitchen|pantry|shelf|shop/.test(text)) {
    return [
      make('shelf', '货架', 'tile_store', '罐头、饮料、零食和香烟。'),
      make('counter', '柜台抽屉', 'tile_store', '电池、胶带和轻量补给。'),
      make('freezer', '后厨冰柜', 'tile_restaurant', '短期食物和饮料。', 1),
    ];
  }
  if (/加油|燃油|车辆|后备箱|车|gas|fuel|trunk|wreck|vehicle/.test(text)) {
    return [
      make('pump', '加油泵', 'tile_gas', '汽油桶、车钥匙和电池线索。', 1),
      make('trunk', '后备箱', 'tile_wreck', '工具、背包和散装食物。'),
    ];
  }
  if (/仓|工具|车库|柜|箱|托盘|warehouse|locker|crate|storage|garage|shed/.test(text)) {
    return [
      make('rack', '工具架', 'tile_locker', '锤子、锯子、扳手和胶带。'),
      make('crate', '木箱', 'tile_warehouse', '木板、钉子和基地材料。'),
      make('pallet', '托盘堆', 'tile_warehouse', '大件工具和维修材料。', 1),
    ];
  }
  if (/学校|教室|school|book/.test(text)) {
    return [
      make('locker', '储物柜', 'tile_school', '背包、书本和基础药品。'),
      make('office', '办公室柜', 'tile_locker', '地图、文具和电池。'),
    ];
  }
  if (/农|种子|园艺|钓|河|farm|seed|fishing|camp|river/.test(text)) {
    return [
      make('supply_box', '补给箱', 'tile_camp', '水瓶、手电和野外工具。'),
      make('tool_bin', '农具箱', 'tile_farm', '种子、小铲子和钓具。'),
    ];
  }
  if (/公寓|民宅|旅馆|拖车|住宅|house|apartment|motel|trailer|home/.test(text)) {
    return [
      make('kitchen', '厨房柜', 'tile_house', '食物、饮水和轻药品。'),
      make('bedroom', '卧室抽屉', 'tile_apartment', '背包、衣物和电池。'),
    ];
  }
  return [
    make('container', `${parent.name}储物箱`, parent.assetId || 'tile_locker', '能翻到少量通用补给。'),
    make('drawer', `${parent.name}抽屉`, 'tile_locker', '小件工具、食物或药品。'),
  ];
}

function sceneQualityForParent(parent) {
  if (parent.quality) return parent.quality;
  if (parent.risk === '极高') return 'red';
  if (parent.risk === '高') return 'purple';
  if (parent.risk === '中') return 'blue';
  if (parent.risk === '低') return 'green';
  return parent.section === 'landmark' ? 'blue' : 'green';
}

function shiftedSceneQuality(quality, shift = 0) {
  const index = Math.max(0, SCENE_QUALITY_ORDER.indexOf(quality));
  return SCENE_QUALITY_ORDER[Math.max(0, Math.min(SCENE_QUALITY_ORDER.length - 1, index + shift))];
}

function sceneSlug(value) {
  return `${value ?? 'container'}`
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'container';
}

function legacySceneLootAliases(state, searchable) {
  const nodeId = typeof state?.currentNodeId === 'string' ? state.currentNodeId : '';
  const objectId = typeof searchable?.id === 'string' ? searchable.id.trim() : '';
  return nodeId && objectId ? [`${nodeId}:${objectId}`] : [];
}

function isLegacySceneLootDepleted(state, searchable) {
  const tombstones = new Set([
    ...(Array.isArray(state?.legacyDepletedSceneObjectIds) ? state.legacyDepletedSceneObjectIds : []),
    ...(Array.isArray(state?.searchedSceneObjectIds) ? state.searchedSceneObjectIds : []),
  ]);
  return legacySceneLootAliases(state, searchable).some((alias) => tombstones.has(alias));
}

function worldLootContextForState(state, searchable, searchKey) {
  const sourceNodeId = state?.worldLootContainers?.[searchKey]?.source?.nodeId;
  const node = mapNodes.find((entry) => entry.id === (sourceNodeId || state?.currentNodeId))
    ?? { id: sourceNodeId || state?.currentNodeId || 'unknown', danger: 0, type: 'unknown' };
  return {
    worldSeed: state?.world?.seed,
    searchKey,
    searchable: searchable && typeof searchable === 'object'
      ? cloneSnapshot(searchable)
      : { id: state?.worldLootContainers?.[searchKey]?.source?.searchableId || searchKey.split(':').at(-1) || 'unknown', quality: 'white' },
    node,
    catalog: marketItems,
  };
}

function sceneLootAccess(store, searchable, requestedKey = '') {
  if (store.isGameOver) return { ok: false, reason: 'game_over' };
  const node = mapNodes.find((entry) => entry.id === store.currentNodeId);
  if (!node || !(node.actions ?? []).includes('search')) return { ok: false, reason: 'wrong_node' };
  if (store.inspectedNodeId && store.inspectedNodeId !== node.id) return { ok: false, reason: 'wrong_node' };
  const canonicalSearchable = canonicalSceneSearchable(node.id, searchable);
  if (!canonicalSearchable) return { ok: false, reason: 'unknown_searchable' };
  const key = sceneLootKeyForState(store.$state, canonicalSearchable, requestedKey);
  if (!key) return { ok: false, reason: 'invalid_search_key' };
  if (!store.nodeZombieStates?.[node.id]) return { ok: false, reason: 'world_not_ready', searchKey: key };
  if (!store.canPerformWorldAction('loot', 0, false)) {
    return { ok: false, reason: 'unsafe_or_insufficient_window', searchKey: key };
  }
  return {
    ok: true,
    reason: null,
    key,
    node,
    searchable: canonicalSearchable,
    context: worldLootContextForState(store.$state, canonicalSearchable, key),
  };
}

function isValidSceneSearchable(nodeId, searchable) {
  return Boolean(canonicalSceneSearchable(nodeId, searchable));
}

function commitWorldLootContainer(rawContainers, key, container) {
  const next = rawContainers && typeof rawContainers === 'object' && !Array.isArray(rawContainers)
    ? cloneSnapshot(rawContainers)
    : {};
  delete next[key];
  next[key] = cloneSnapshot(container);
  return Object.fromEntries(Object.entries(next).slice(-512));
}

function normalizeWorldLootContainersForState(state, rawContainers) {
  if (!rawContainers || typeof rawContainers !== 'object' || Array.isArray(rawContainers)) return {};
  const result = {};
  const exactCanonicalKeys = new Set();
  Object.entries(rawContainers).slice(-512).forEach(([rawKey, raw]) => {
    const key = typeof rawKey === 'string' ? rawKey.trim().slice(0, 500) : '';
    const nodeId = typeof raw?.source?.nodeId === 'string' ? raw.source.nodeId : key.split(':')[0];
    const node = mapNodes.find((entry) => entry.id === nodeId);
    if (!key || !node) return;
    const searchableId = typeof raw?.source?.searchableId === 'string'
      ? raw.source.searchableId
      : key.split(':').at(-1);
    if (!searchableId || key.split(':')[0] !== nodeId) return;
    const registry = canonicalSceneSearchableRegistry(nodeId);
    const exact = registry.find((entry) => entry.searchKey === key && entry.id === searchableId);
    // v6-v9 stored direct catalog objects as two-part keys. If that object now
    // has one canonical parent, migrate the old key once; four-part aliases are
    // never guessed because that would preserve forged parent/child identities.
    const legacyDirect = key.split(':').length === 2
      ? registry.find((entry) => entry.id === searchableId)
      : null;
    const descriptor = exact ?? legacyDirect;
    if (!descriptor) return;
    const canonicalKey = descriptor.searchKey;
    if (!exact && exactCanonicalKeys.has(canonicalKey)) return;
    if (exact) exactCanonicalKeys.add(canonicalKey);
    const context = {
      worldSeed: state?.world?.seed,
      searchKey: canonicalKey,
      searchable: descriptor,
      node,
      catalog: marketItems,
    };
    result[canonicalKey] = normalizeWorldLootContainer(raw, context);
  });
  return result;
}

function legacyDepletedSceneLootSummary(searchKey) {
  return {
    searchKey,
    revision: 0,
    total: 0,
    hidden: 0,
    revealed: 0,
    claimed: 0,
    remaining: 0,
    exhausted: true,
    complete: true,
    legacy: true,
    searchCost: { minutes: 0, noise: 0 },
    searchCostPaid: true,
    searchCompletedAtMinutes: null,
    slots: [],
  };
}

function poweredMinutesForInterval({ day, clockMinutes, elapsedMinutes, world, base }) {
  const duration = Math.max(0, Math.round(Number(elapsedMinutes) || 0));
  if (!duration) return 0;
  let cursor = (Math.max(1, Number(day) || 1) - 1) * 24 * 60 + Math.max(0, Number(clockMinutes) || 0);
  const end = cursor + duration;
  let powered = 0;
  let generatorOn = Boolean(base?.generatorOn && (base?.generatorFuel ?? 0) > 0);
  let generatorFuel = Math.max(0, Math.round(Number(base?.generatorFuel) || 0));
  const shutoffDay = Math.max(1, Math.round(Number(world?.powerShutoffDay) || 1));
  const startingDay = Math.floor(cursor / (24 * 60)) + 1;
  const gridUnavailableEarly = world?.powerOn === false && startingDay < shutoffDay && !generatorOn;
  while (cursor < end) {
    const currentDay = Math.floor(cursor / (24 * 60)) + 1;
    const nextBoundary = currentDay * 24 * 60;
    const segmentEnd = Math.min(end, nextBoundary);
    if ((!gridUnavailableEarly && currentDay < shutoffDay) || (generatorOn && generatorFuel > 0)) powered += segmentEnd - cursor;
    cursor = segmentEnd;
    if (cursor === nextBoundary && cursor < end && generatorOn) {
      generatorFuel = Math.max(0, generatorFuel - 1);
      if (generatorFuel === 0) generatorOn = false;
    }
  }
  return powered;
}

function foodPreparationContextForState(state, recipeId = null) {
  const cookingSkill = clampInteger(state.skills?.cooking, 0, 10, 0);
  const recipe = recipeId
    ? FOOD_PREPARATION_RECIPES.find((entry) => entry.id === recipeId)
    : null;
  const intervalMinutes = Math.max(
    0,
    recipe ? foodPreparationRecipeMinutes(recipe, cookingSkill) : Math.max(
      0,
      ...FOOD_PREPARATION_RECIPES.map((entry) => foodPreparationRecipeMinutes(entry, cookingSkill)),
    ),
  );
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const baseInventory = Array.isArray(state.baseInventory) ? state.baseInventory : [];
  return {
    catalog: marketItems,
    containers: {
      carry: cloneInventory(inventory),
      base: cloneInventory(baseInventory),
    },
    capacities: {
      carry: inventoryCapacityForState(state, inventory),
      base: baseStorageCapacity(state.shelter),
    },
    cookingSkill,
    nowMinutes: worldMinutesForState(state),
    powerAvailableMinutes: poweredMinutesForInterval({
      day: state.day,
      clockMinutes: state.clockMinutes,
      elapsedMinutes: intervalMinutes,
      world: state.world,
      base: state.base,
    }),
    municipalWaterOn: Boolean(state.world?.waterOn),
    baseWaterReserve: clampInteger(state.base?.waterReserve, 0, 30, 0),
    revision: clampInteger(state.foodPreparationRevision, 0, 1_000_000_000, 0),
    appliedCommandIds: normalizeFoodPreparationCommandIds(state.foodPreparationCommandIds),
    nextItemSequence: clampInteger(state.nextItemSequence, 1, 1_000_000_000, 1),
  };
}

function normalizeFoodPreparationCommandIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return [...new Set(rawIds
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim().slice(0, 180)))]
    .slice(-64);
}

function normalizeFoodPreparationCommandId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 180) : '';
}

function foodPreparationAccessFailure(store) {
  if (store.runPhase !== 'running') return 'not_running';
  if (store.activeTacticalEncounter && !isTacticalEncounterTerminal(store.activeTacticalEncounter)) {
    return 'active_tactical_encounter';
  }
  if (!store.currentNodeId || store.currentNodeId !== store.spawnLocation?.id) return 'not_at_home';
  const zombieState = store.nodeZombieStates?.[store.currentNodeId];
  if (!zombieState || !baseInteriorSafetyForState(store.$state)) return 'node_not_secured';
  return '';
}

function foodPreparationFailure(state, reason, details = {}) {
  const safeDetails = details && typeof details === 'object' ? cloneSnapshot(details) : {};
  return {
    ...safeDetails,
    ok: false,
    committed: false,
    reason: typeof reason === 'string' && reason ? reason : 'invalid_request',
    replayed: Boolean(safeDetails.replayed),
    revision: clampInteger(state?.foodPreparationRevision, 0, 1_000_000_000, 0),
  };
}

function preparationMinutes(result, recipe) {
  const minutes = Number(result?.minutes ?? recipe?.baseMinutes ?? recipe?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(3 * 24 * 60, Math.round(minutes));
}

function foodPreparationRecipeMinutes(recipe, cookingSkill) {
  const baseMinutes = Number(recipe?.baseMinutes ?? recipe?.minutes);
  if (!Number.isFinite(baseMinutes) || baseMinutes <= 0) return 0;
  const reduction = Math.min(0.25, clampInteger(cookingSkill, 0, 10, 0) * 0.025);
  return Math.max(10, Math.round(baseMinutes * (1 - reduction)));
}

function foodRecipeRequiresPower(recipe) {
  return Boolean(recipe?.heatRequired ?? recipe?.requiresHeat);
}

function validFoodPreparationProjection(nextState, context, commandId, minutes, preview) {
  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) return false;
  if (!nextState.containers || typeof nextState.containers !== 'object' || Array.isArray(nextState.containers)) return false;
  if (!Array.isArray(nextState.containers.carry) || !Array.isArray(nextState.containers.base)) return false;
  if (!minutes || minutes !== preparationMinutes(preview, null)) return false;
  if (nextState.revision !== context.revision + 1) return false;
  if (!Number.isInteger(nextState.nextItemSequence) || nextState.nextItemSequence < context.nextItemSequence || nextState.nextItemSequence > 1_000_000_000) return false;
  if (!Number.isInteger(nextState.baseWaterReserve) || nextState.baseWaterReserve < 0 || nextState.baseWaterReserve > 30) return false;
  const commandIds = normalizeFoodPreparationCommandIds(nextState.appliedCommandIds);
  if (commandIds.length !== nextState.appliedCommandIds?.length || commandIds.at(-1) !== commandId) return false;
  if (!validProjectedFoodInventory(nextState.containers.carry) || !validProjectedFoodInventory(nextState.containers.base)) return false;
  if (storageUsedSpace(nextState.containers.carry) > context.capacities.carry) return false;
  if (storageUsedSpace(nextState.containers.base) > context.capacities.base) return false;
  return true;
}

function validProjectedFoodInventory(inventory) {
  const stackIds = new Set();
  return inventory.every((item) => {
    if (!item || typeof item !== 'object' || !marketItems.some((entry) => entry.id === item.id)) return false;
    if (!Number.isInteger(item.count) || item.count <= 0 || item.count > 999_999) return false;
    if (typeof item.stackId !== 'string' || !item.stackId || stackIds.has(item.stackId)) return false;
    stackIds.add(item.stackId);
    return Boolean(item.conditionState && typeof item.conditionState === 'object');
  });
}

function formatFoodPreparationDuration(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value >= 60 && value % 60 === 0) return `${value / 60} 小时`;
  if (value >= 60) return `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`;
  return `${value} 分钟`;
}

function firearmAmmoId(weaponId) {
  return weaponId === 'shotgun' ? 'shotgun_shells' : '9mm_rounds';
}

function firearmCapacity(weaponId) {
  if (weaponId === 'shotgun') return 6;
  if (weaponId === 'm36_revolver') return 6;
  return weaponId === 'm9_pistol' ? 15 : 0;
}

function normalizeFirearmLoads(rawLoads, inventories = []) {
  const weapons = (Array.isArray(inventories) ? inventories : [])
    .flatMap((inventory) => Array.isArray(inventory) ? inventory : [])
    .filter((item) => item?.stackId && item.count > 0 && item.tags?.includes('firearm'));
  const source = rawLoads && typeof rawLoads === 'object' && !Array.isArray(rawLoads) ? rawLoads : {};
  return Object.fromEntries(weapons.flatMap((weapon) => {
    const raw = source[weapon.stackId];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const capacity = firearmCapacity(weapon.id);
    if (capacity <= 0) return [];
    const rounds = clampInteger(raw.rounds, 0, capacity, 0);
    const ammoItemId = firearmAmmoId(weapon.id);
    return [[weapon.stackId, {
      ammoItemId,
      ammoStackId: typeof raw.ammoStackId === 'string' ? raw.ammoStackId.slice(0, 160) : null,
      rounds,
    }]];
  }));
}

function tacticalContextForState(state) {
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  return {
    node: mapNodes.find((entry) => entry.id === state.currentNodeId) ?? null,
    inventory,
    skills: state.skills ?? {},
    vitals: state.vitals ?? {},
    body: state.body ?? {},
    world: {
      ...(state.world ?? {}),
      isNight: (state.clockMinutes ?? START_MINUTE) >= 20 * 60 || (state.clockMinutes ?? START_MINUTE) < 6 * 60,
    },
    traits: state.selectedTraits ?? [],
    totalMinutes: worldMinutesForState(state),
    day: state.day,
    clockMinutes: state.clockMinutes,
    usedSpace: storageUsedSpace(inventory),
    capacity: inventoryCapacityForState(state, inventory),
    equippedWeaponStackId: state.equippedWeaponStackId,
    firearmLoads: normalizeFirearmLoads(state.firearmLoads, [state.inventory, state.baseInventory, state.vehicleInventory]),
  };
}

function tacticalWeaponOptionsForState(state) {
  const loads = normalizeFirearmLoads(state.firearmLoads, [state.inventory, state.baseInventory, state.vehicleInventory]);
  return (Array.isArray(state.inventory) ? state.inventory : [])
    .filter((item) => item.count > 0 && item.tags?.includes('weapon'))
    .map((item) => {
      const display = getItemConditionDisplay(item.conditionState);
      const ammoItemId = item.tags?.includes('firearm') ? firearmAmmoId(item.id) : null;
      const loaded = loads[item.stackId]?.rounds ?? 0;
      const reserve = ammoItemId
        ? state.inventory.filter((entry) => entry.id === ammoItemId).reduce((sum, entry) => sum + Math.max(0, Number(entry.count) || 0), 0)
        : 0;
      return {
        stackId: item.stackId,
        itemId: item.id,
        name: item.name,
        firearm: Boolean(item.tags?.includes('firearm')),
        equipped: item.stackId === state.equippedWeaponStackId,
        broken: isWeaponBroken(item.conditionState),
        conditionLabel: display.label,
        conditionTone: display.tone,
        loaded,
        capacity: firearmCapacity(item.id),
        reserve,
        ammoItemId,
      };
    });
}

function tacticalZombieTotal(encounter) {
  if (Array.isArray(encounter?.enemies)) return encounter.enemies.length;
  return Object.values(encounter?.zombies ?? {}).reduce((sum, value) => (
    sum + Math.max(0, Math.round(Number(value) || 0))
  ), 0);
}

function tacticalRuntimeId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, 160);
  if (!normalized || ['__proto__', 'constructor', 'prototype'].includes(normalized)) return null;
  return normalized;
}

function nearestLegalTacticalTargetId(encounter, context, weaponStackId) {
  const candidates = [...(Array.isArray(encounter?.enemies) ? encounter.enemies : [])]
    .filter((enemy) => tacticalRuntimeId(enemy?.id) && Number(enemy?.hp) > 0)
    .sort((left, right) => (
      Math.max(0, Number(left?.distance) || 0) - Math.max(0, Number(right?.distance) || 0)
      || (left?.posture === 'standing' ? 0 : 1) - (right?.posture === 'standing' ? 0 : 1)
      || String(left.id).localeCompare(String(right.id))
    ));
  for (const enemy of candidates.slice(0, 6)) {
    const actions = listTacticalActions(encounter, context, {
      targetId: enemy.id,
      weaponStackId,
    });
    if (actions.some((action) => TARGETED_TACTICAL_ACTION_IDS.has(action.id) && action.enabled)) {
      return enemy.id;
    }
  }
  return candidates[0]?.id ?? null;
}

function isValidTacticalEnemyRoster(rawEnemies, expectedCount) {
  if (!Array.isArray(rawEnemies) || rawEnemies.length !== expectedCount) return false;
  const seen = new Set();
  return rawEnemies.every((enemy) => {
    const id = tacticalRuntimeId(enemy?.id);
    const hp = Number(enemy?.hp);
    const maxHp = Number(enemy?.maxHp);
    const distance = Number(enemy?.distance);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return Number.isFinite(hp)
      && Number.isFinite(maxHp)
      && hp > 0
      && maxHp >= hp
      && Number.isInteger(distance)
      && distance >= 0
      && distance <= 3
      && ['standing', 'downed'].includes(enemy?.posture);
  });
}

function tacticalTargetOutcomeForResolution({ actionId, targetId, beforeEncounter, nextEncounter, effects }) {
  if (!TARGETED_TACTICAL_ACTION_IDS.has(actionId) || !targetId) return null;
  const before = beforeEncounter?.enemies?.find((enemy) => enemy.id === targetId);
  if (!before) return null;
  const after = nextEncounter?.enemies?.find((enemy) => enemy.id === targetId) ?? null;
  const changes = Array.isArray(effects?.enemyChanges) ? effects.enemyChanges : [];
  const change = changes.find((entry) => (
    tacticalRuntimeId(entry?.targetId ?? entry?.enemyId ?? entry?.id) === targetId
  )) ?? null;
  const numberOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const hpBefore = Math.max(0, Math.round(
    numberOrNull(change?.hpBefore) ?? numberOrNull(before.hp) ?? 0,
  ));
  const hpAfter = Math.max(0, Math.round(
    numberOrNull(change?.hpAfter)
      ?? numberOrNull(after?.hp)
      ?? (change?.killed ? 0 : hpBefore),
  ));
  const maxHp = Math.max(1, Math.round(
    numberOrNull(change?.maxHp)
      ?? numberOrNull(after?.maxHp)
      ?? numberOrNull(before.maxHp)
      ?? Math.max(1, hpBefore),
  ));
  const damage = Math.max(0, Math.round(
    numberOrNull(change?.damage)
      ?? numberOrNull(change?.damageDealt)
      ?? Math.max(0, hpBefore - hpAfter),
  ));
  const profileId = tacticalRuntimeId(after?.profileId ?? before.profileId) ?? 'shambler';
  const targetName = change?.targetName
    ?? change?.enemyName
    ?? TACTICAL_ENEMY_PROFILES[profileId]?.label
    ?? '游荡者';
  return {
    id: targetId,
    targetId,
    targetName,
    label: targetName,
    profileId,
    damage,
    hpBefore,
    hpAfter,
    maxHp,
    killed: Boolean(change?.killed || (!after && Number(effects?.zombieKills) > 0)),
  };
}

function formatTacticalTargetOutcome(outcome) {
  if (!outcome) return '';
  const terminal = outcome.killed ? '（已击倒）' : '';
  return `${outcome.targetName}：造成 ${outcome.damage} 伤害，剩余 HP ${outcome.hpAfter} / ${outcome.maxHp}${terminal}。`;
}

function selectTacticalStartingWeapon(state, preferredActionId = '') {
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const usable = inventory.filter((item) => (
    item.count > 0 && item.tags?.includes('weapon') && !isWeaponBroken(item.conditionState)
  ));
  const wantsFirearm = ['combat_firearm', 'fire'].includes(preferredActionId);
  const wantsMelee = ['combat_melee', 'melee'].includes(preferredActionId);
  const preferredType = usable.filter((item) => (
    wantsFirearm ? item.tags?.includes('firearm') : wantsMelee ? !item.tags?.includes('firearm') : true
  ));
  return preferredType.find((item) => item.stackId === state.equippedWeaponStackId)
    ?? usable.find((item) => item.stackId === state.equippedWeaponStackId)
    ?? preferredType[0]
    ?? usable[0]
    ?? null;
}

function tacticalEncounterSeed(worldSeed, nodeId, totalMinutes, encounterSequence) {
  const input = `${clampInteger(worldSeed, 1, 0x7fffffff, 1)}:${nodeId ?? 'unknown'}:${clampInteger(totalMinutes, 0, Number.MAX_SAFE_INTEGER, 0)}:${clampInteger(encounterSequence, 1, 1_000_000_000, 1)}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function tacticalActionLabel(actionId) {
  return {
    push: '推开',
    melee: '近战挥击',
    stomp: '踩踏',
    step_back: '后退拉开',
    aim: '稳定瞄准',
    reload: '装填弹药',
    fire: '开火',
    disengage: '脱离接触',
    brace: '稳住阵脚',
  }[actionId] ?? '战术行动';
}

function formatTacticalEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      if (typeof event === 'string') return event;
      if (!event || typeof event !== 'object') return '';
      if (event.type === 'player_action') {
        const action = tacticalActionLabel(event.actionId);
        const weapon = event.weaponName ? `（${event.weaponName}）` : '';
        const kills = Number(event.zombieKills) > 0 ? `，击倒 ${Math.round(event.zombieKills)} 只` : '';
        return `${action}${weapon}${event.success ? '成功' : '失手'}${kills}。`;
      }
      if (event.type === 'zombie_response') {
        return {
          closing: '尸群继续逼近。',
          wounded: '尸体突破站位，你在扑咬中受伤。',
          grabbed: `你被 ${Math.max(1, Math.round(Number(event.grabbedBy) || 1))} 只尸体抓住。`,
          stumbled: '你勉强避开扑咬，但站位已经失衡。',
          evaded: '你避开了这一轮扑咬。',
        }[event.outcome] ?? '尸群重新挤压了你的站位。';
      }
      return event.text ?? event.message ?? event.label ?? '';
    })
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
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
  const carryCapacity = carryStorageCapacity({
    skills: state.skills,
    selectedTraits: state.selectedTraits,
    inventory,
    equippedBagStackId: state.equippedBagStackId,
  });
  if (!state.currentNodeId) return Math.max(carryCapacity, baseStorageCapacity(state.shelter));
  return carryCapacity;
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
  const weapons = inventory.filter((item) => item.count > 0 && item.tags?.includes('weapon') && !isWeaponBroken(item.conditionState));
  const valid = weapons.filter((item) => firearm ? item.tags?.includes('firearm') : !item.tags?.includes('firearm'));
  return valid.find((item) => item.stackId === equippedWeaponId || item.id === equippedWeaponId) ?? valid[0] ?? null;
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
  if (globalThis.structuredClone) {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Vue/Pinia proxies are JSON-saveable but not structured-cloneable.
    }
  }
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
