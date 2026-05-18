<template>
  <section class="screen market-screen">
    <header class="sticky-status">
      <span>💰 ¥{{ game.money.toLocaleString() }}</span>
      <strong>{{ timerText }}</strong>
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
            <small>{{ shelter.description }}</small>
            <em>📦 {{ shelter.space }} 格　🛡️ {{ defenseText(shelter.defense) }}</em>
            <p>{{ shelter.hidden }}</p>
          </div>
          <button class="secondary" @click="selectShelter(shelter.id)">选择这个据点</button>
        </article>
      </div>
    </template>

    <template v-else>
      <h1>采购物资</h1>
      <p class="subtle">当前避难所：{{ game.shelter.name }} · {{ qualityMeta(game.shelter.quality).label }} · {{ game.shelter.hidden }}</p>
      <div class="category-tabs">
        <button
          v-for="category in categories"
          :key="category.id"
          :class="{ active: activeCategory === category.id }"
          @click="activeCategory = category.id"
        >
          {{ category.icon }} {{ category.label }}
        </button>
      </div>
      <div class="item-grid">
        <button
          v-for="item in filteredItems"
          :key="item.id"
          :class="['item-card', 'risk-item-card', `quality-${item.tier}`]"
          :disabled="!canBuy(item)"
          @click="game.addItem(item)"
        >
          <span class="item-icon">
            <img :src="itemIconSrc(item)" :alt="item.canonicalName" @error="markIconMissing" />
            <span>{{ item.fallbackIcon }}</span>
          </span>
          <i>{{ tierMeta(item.tier).label }}</i>
          <strong>{{ item.name }}</strong>
          <em>{{ item.canonicalName }}</em>
          <small>{{ item.description }}</small>
          <span class="effect-list">
            <span v-for="effect in itemEffects(item)" :key="effect">{{ effect }}</span>
          </span>
          <em>¥{{ item.price }} · {{ item.space }}格</em>
          <b v-if="owned(item.id)">x{{ owned(item.id) }}</b>
        </button>
      </div>
      <button class="primary-action fixed-action" @click="startSurvival">开始生存</button>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { categories, itemTiers, marketItems, shelterQualities } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const activeCategory = ref('all');
const countdown = ref(180);
let timer = null;

const timerText = computed(() => {
  if (!game.shelter) return '--:--';
  const min = Math.floor(countdown.value / 60).toString().padStart(2, '0');
  const sec = (countdown.value % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
});

const filteredItems = computed(() => marketItems.filter((item) => activeCategory.value === 'all' || item.category === activeCategory.value));
const remainingRolls = computed(() => Math.max(0, game.maxShelterRolls - game.shelterRollsUsed));

function owned(id) {
  return game.inventory.find((item) => item.id === id)?.count || 0;
}

function canBuy(item) {
  return game.money >= item.price && game.remainingSpace >= item.space;
}

function qualityMeta(qualityId) {
  return shelterQualities.find((quality) => quality.id === qualityId) ?? shelterQualities[shelterQualities.length - 1];
}

function tierMeta(tierId) {
  return itemTiers.find((tier) => tier.id === tierId) ?? itemTiers[0];
}

function itemIconSrc(item) {
  return `${import.meta.env.BASE_URL}pz-items/${item.iconFile}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function itemEffects(item) {
  const entries = Object.entries(item.effects ?? {});
  if (!entries.length) return item.tags?.slice(0, 2) ?? [];
  return entries.map(([key, value]) => {
    if (key === 'skill') return `关联 ${value}`;
    if (key === 'capacity') return `容量 +${value}`;
    if (typeof value === 'number') return `${key} ${value > 0 ? '+' : ''}${value}`;
    return `${key}: ${value}`;
  }).slice(0, 3);
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

function startSurvival() {
  if (!game.shelter) return;
  game.ensureActiveEvent();
  router.push('/survival');
}

function startTimer() {
  if (timer || !game.shelter) return;
  timer = window.setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) startSurvival();
  }, 1000);
}

onMounted(() => {
  if (!game.profession) router.replace('/profession');
  if (!game.shelter && !game.shelterChoices.length) game.rollShelters();
  startTimer();
});

watch(
  () => game.shelter?.id,
  () => startTimer(),
);

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>
