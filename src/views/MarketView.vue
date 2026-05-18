<template>
  <section class="screen market-screen">
    <header class="sticky-status">
      <span>💰 ¥{{ game.money.toLocaleString() }}</span>
      <strong>{{ timerText }}</strong>
      <span>📦 {{ game.remainingSpace }} 格</span>
    </header>

    <template v-if="!game.shelter">
      <h1>选择避难所</h1>
      <div class="shelter-list">
        <button
          v-for="shelter in shelters"
          :key="shelter.id"
          class="shelter-card"
          :disabled="game.money < shelter.price"
          @click="game.selectShelter(shelter.id)"
        >
          <span class="shelter-icon">{{ shelter.icon }}</span>
          <span>
            <strong>{{ shelter.name }}</strong>
            <small>{{ shelter.description }}</small>
            <em>📦 {{ shelter.space }}格　🛡️ {{ '★'.repeat(shelter.defense) }}</em>
          </span>
          <b>¥{{ shelter.price }}</b>
        </button>
      </div>
    </template>

    <template v-else>
      <h1>采购物资</h1>
      <p class="subtle">当前避难所：{{ game.shelter.name }} · {{ game.shelter.hidden }}</p>
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
          class="item-card"
          :disabled="!canBuy(item)"
          @click="game.addItem(item)"
        >
          <span>{{ item.icon }}</span>
          <strong>{{ item.name }}</strong>
          <small>{{ item.description }}</small>
          <em>¥{{ item.price }} · {{ item.space }}格</em>
          <b v-if="owned(item.id)">x{{ owned(item.id) }}</b>
        </button>
      </div>
      <button class="primary-action fixed-action" @click="startSurvival">开始生存</button>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { categories, marketItems, shelters } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const activeCategory = ref('all');
const countdown = ref(180);
let timer = null;

const timerText = computed(() => {
  const min = Math.floor(countdown.value / 60).toString().padStart(2, '0');
  const sec = (countdown.value % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
});

const filteredItems = computed(() => marketItems.filter((item) => activeCategory.value === 'all' || item.category === activeCategory.value));

function owned(id) {
  return game.inventory.find((item) => item.id === id)?.count || 0;
}

function canBuy(item) {
  return game.money >= item.price && game.remainingSpace >= item.space;
}

function startSurvival() {
  if (!game.shelter && !game.selectShelter('rental')) return;
  game.ensureActiveEvent();
  router.push('/survival');
}

onMounted(() => {
  if (!game.profession) router.replace('/profession');
  timer = window.setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) startSurvival();
  }, 1000);
});

onUnmounted(() => window.clearInterval(timer));
</script>
