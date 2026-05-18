<template>
  <section class="screen market-screen">
    <header class="sticky-status loot-status">
      <span>🏚️ {{ game.shelter?.name ?? '避难所待定' }}</span>
      <strong>{{ lootProgressText }}</strong>
      <span>📦 {{ game.shelter ? `${game.remainingSpace} 格` : '待定' }}</span>
    </header>

    <template v-if="!game.shelter">
      <section class="shelter-roll-header">
        <div>
          <p>SAFEHOUSE ROLL</p>
          <h1>随机避难所</h1>
          <span>第 {{ game.shelterRollsUsed || 1 }} / {{ game.maxShelterRolls }} 次抽样 · 每次出现 3 个不重复地点</span>
        </div>
        <button class="secondary reroll-button" :disabled="remainingRolls <= 0" @click="rollAgain">
          重新抽样 {{ remainingRolls }} 次
        </button>
      </section>

      <div class="roll-meter">
        <span v-for="index in game.maxShelterRolls" :key="index" :class="{ used: index <= game.shelterRollsUsed }"></span>
      </div>

      <div class="shelter-roll-grid">
        <article
          v-for="shelter in game.shelterChoices"
          :key="shelter.id"
          :class="['shelter-card', 'shelter-roll-card', `quality-${shelter.quality}`]"
        >
          <div class="shelter-quality">
            <span>{{ qualityMeta(shelter.quality).label }}</span>
            <strong>{{ qualityMeta(shelter.quality).tone }}</strong>
          </div>
          <div class="shelter-card-copy">
            <strong>{{ shelter.name }}</strong>
            <small class="shelter-scope">{{ shelterScopeText(shelter) }}</small>
            <small>{{ shelter.description }}</small>
            <em>📦 {{ shelter.space }} 格　🛡️ {{ defenseText(shelter.defense) }}</em>
            <p>{{ shelter.hidden }}</p>
            <div class="shelter-guarantees" aria-label="保底物资">
              <span>保底物资</span>
              <b v-for="(label, index) in guaranteedLootPreview(shelter)" :key="`${label}-${index}`">{{ label }}</b>
            </div>
          </div>
          <button class="secondary" @click="selectShelter(shelter.id)">选择这个据点</button>
        </article>
      </div>
    </template>

    <template v-else>
      <section class="loot-brief">
        <div>
          <p>SAFEHOUSE SEARCH</p>
          <h1>搜索物资</h1>
          <span>{{ game.shelter.name }} · {{ qualityMeta(game.shelter.quality).label }} · {{ game.shelter.hidden }}</span>
        </div>
        <aside>
          <strong>{{ game.takenLootCount }}</strong>
          <span>已带走 / {{ game.lootSlots.length }} 个可疑物资</span>
        </aside>
      </section>

      <div class="loot-metrics">
        <span>未知 {{ hiddenCount }}</span>
        <span>已搜索 {{ searchedCount }}</span>
        <span>剩余容量 {{ game.remainingSpace }} 格</span>
        <button class="secondary search-all-button" :disabled="!canSearchAll" @click="searchAllSlots">
          {{ searchAllButtonText }}
        </button>
      </div>

      <div class="loot-grid" aria-label="未知物资搜索区">
        <button
          v-for="slot in game.lootSlots"
          :key="slot.id"
          :class="lootSlotClass(slot)"
          :disabled="isSlotDisabled(slot)"
          :title="lootTooltip(slot)"
          :aria-label="lootAriaLabel(slot)"
          @click="searchSlot(slot)"
        >
          <template v-if="slot.status === 'hidden'">
            <span class="loot-silhouette"></span>
            <em>{{ slot.space }} 格</em>
            <strong>未知物资</strong>
          </template>

          <template v-else-if="slot.status === 'searching'">
            <span class="search-lens">⌕</span>
            <strong>搜索中</strong>
          </template>

          <template v-else>
            <span class="item-icon">
              <img v-if="lootItem(slot)" :src="itemIconSrc(lootItem(slot))" :alt="lootItem(slot).name" @error="markIconMissing" />
              <span>{{ lootItem(slot)?.fallbackIcon ?? '??' }}</span>
            </span>
            <strong>{{ lootItem(slot)?.name ?? '未知物资' }}</strong>
            <em>{{ lootStatusText(slot) }}</em>
          </template>
        </button>
      </div>

      <section class="loot-inventory">
        <h2>已带走物资</h2>
        <p v-if="!game.inventory.length">背包还是空的。</p>
        <span v-for="item in game.inventory" :key="item.id" class="inventory-item">
          <span class="item-icon inventory-icon" aria-hidden="true">
            <img :src="itemIconSrc(item)" :alt="item.name" @error="markInventoryIconMissing" />
            <span></span>
          </span>
          <strong>{{ item.name }}</strong>
          <em>x{{ item.count }}</em>
        </span>
      </section>

      <button class="primary-action loot-start-action" @click="startSurvival">开始生存</button>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { itemTiers, marketItems, shelterConsumableGuarantees, shelterLootProfiles, shelterQualities } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();

const remainingRolls = computed(() => Math.max(0, game.maxShelterRolls - game.shelterRollsUsed));
const hiddenCount = computed(() => game.lootSlots.filter((slot) => slot.status === 'hidden').length);
const searchedCount = computed(() => game.lootSlots.filter((slot) => slot.status !== 'hidden').length);
const canSearchAll = computed(() => hiddenCount.value > 0 && !game.searchingSlotId);
const searchAllButtonText = computed(() => {
  if (game.searchingSlotId) return '搜索中';
  if (!hiddenCount.value) return '已全部搜索';
  return `一键搜索物资 ${hiddenCount.value}`;
});
const lootProgressText = computed(() => {
  if (!game.shelter) return '抽取据点';
  return `搜索 ${searchedCount.value}/${game.lootSlots.length}`;
});

function qualityMeta(qualityId) {
  return shelterQualities.find((quality) => quality.id === qualityId) ?? shelterQualities[shelterQualities.length - 1];
}

function defenseText(value) {
  return '★'.repeat(Math.max(1, value));
}

function rollAgain() {
  game.rollShelters();
}

function selectShelter(id) {
  game.selectShelter(id);
}

function shelterScopeText(shelter) {
  if (!shelter.locations?.length) return '通用据点';
  if (shelter.locations.length === 1 && shelter.locations.includes(game.spawnLocation?.id)) return `${game.spawnLocation.name}独有据点`;
  return '地区限定据点';
}

function guaranteedLootPreview(shelter) {
  const profile = shelterLootProfiles[shelter.id] ?? {};
  const consumables = shelterConsumableGuarantees[shelter.quality] ?? shelterConsumableGuarantees.green;
  return [
    `水/饮料 x${consumables.drinks}`,
    `食品 x${consumables.foods}`,
    '医疗/工具',
    ...(profile.guaranteed ?? []).map(guaranteeLabel).filter(Boolean),
  ].slice(0, 7);
}

function guaranteeLabel(entry) {
  if (entry.itemId) return itemName(entry.itemId);
  if (entry.itemIds?.length) {
    const names = entry.itemIds.map(itemName).filter(Boolean);
    if (!names.length) return '';
    return names.length > 2 ? `${names.slice(0, 2).join('/')}等` : names.join('/');
  }
  const tier = entry.tier ? tierMeta(entry.tier).shortLabel : '';
  if (entry.category) return `${tier}${entry.category}`.trim();
  if (entry.tag) return `${tier}${entry.tag}`.trim();
  return tier || '';
}

function itemName(id) {
  return marketItems.find((item) => item.id === id)?.name ?? '';
}

function lootItem(slot) {
  return marketItems.find((item) => item.id === slot.itemId);
}

function lootSlotClass(slot) {
  return [
    'loot-slot',
    `footprint-${slot.footprint}`,
    `status-${slot.status}`,
    slot.status === 'hidden' || slot.status === 'searching' ? 'quality-unknown' : `quality-${slot.tier}`,
  ];
}

function canSearch(slot) {
  return slot.status === 'hidden' && !game.searchingSlotId;
}

function isSlotDisabled(slot) {
  return slot.status === 'hidden' && Boolean(game.searchingSlotId);
}

async function searchSlot(slot) {
  await game.searchLootSlot(slot.id);
}

async function searchAllSlots() {
  await game.searchAllLootSlots();
}

function itemIconSrc(item) {
  return `${import.meta.env.BASE_URL}pz-items/${item.iconFile}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function markInventoryIconMissing(event) {
  event.currentTarget.closest('.inventory-icon')?.classList.add('missing');
}

function itemEffects(item) {
  if (!item) return [];
  const entries = Object.entries(item.effects ?? {});
  if (!entries.length) return item.tags?.slice(0, 2) ?? [];
  return entries.map(([key, value]) => {
    if (key === 'skill') return `关联 ${value}`;
    if (key === 'capacity') return `容量 +${value}`;
    if (typeof value === 'number') return `${key} ${value > 0 ? '+' : ''}${value}`;
    return `${key}: ${value}`;
  }).slice(0, 3);
}

function lootStatusText(slot) {
  if (slot.status === 'taken') return `${slot.space} 格`;
  return `${slot.space} 格 · 背包已满`;
}

function tierMeta(tierId) {
  return itemTiers.find((tier) => tier.id === tierId) ?? itemTiers[0];
}

function lootTooltip(slot) {
  if (slot.status === 'hidden') return `未知物资\n占用：${slot.space} 格\n点击搜索。`;
  if (slot.status === 'searching') return '搜索中';
  const item = lootItem(slot);
  if (!item) return '未知物资';
  const effects = itemEffects(item);
  return [
    item.name,
    `品质：${tierMeta(item.tier).shortLabel}`,
    `占用：${item.space} 格`,
    effects.length ? `属性：${effects.join(' / ')}` : '',
    item.description,
  ].filter(Boolean).join('\n');
}

function lootAriaLabel(slot) {
  if (slot.status === 'hidden') return `未知物资，${slot.space} 格`;
  if (slot.status === 'searching') return '搜索中';
  const item = lootItem(slot);
  if (!item) return `未知物资，${slot.space} 格`;
  return slot.status === 'taken'
    ? `${item.name}，${item.space} 格`
    : `${item.name}，${item.space} 格，背包已满，未带走`;
}

function startSurvival() {
  if (!game.shelter) return;
  game.initializeMapState(true);
  router.push('/survival');
}

onMounted(() => {
  if (!game.profession) router.replace('/profession');
  if (!game.shelter && !game.shelterChoices.length) game.rollShelters();
  if (game.shelter) game.ensureLootSlots();
});
</script>
