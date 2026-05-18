<template>
  <section class="screen select-screen">
    <header class="view-header">
      <p>你的前世身份</p>
      <h1>{{ current.icon }} {{ current.name }}</h1>
      <span>点击骰子随机切换职业</span>
    </header>

    <article class="profile-card">
      <div class="big-icon">{{ current.icon }}</div>
      <h2>{{ current.name }}</h2>
      <p>{{ current.summary }}</p>
      <div class="stat-row">
        <span>💰 金钱 <strong>¥{{ (6500 + current.money).toLocaleString() }}</strong></span>
        <span>❤️ 生命 <strong>{{ 100 + current.hp }}</strong></span>
        <span>🧠 理智 <strong>{{ 100 + current.san }}</strong></span>
      </div>
      <div class="tag-list">
        <span v-for="tag in current.tags" :key="tag">{{ tag }}</span>
      </div>
    </article>

    <button class="dice-button" @click="roll">🎲</button>
    <button class="primary-action" @click="confirm">确认身份，选择特性</button>
    <p class="hint">距离封城还有 3 分钟</p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { professions } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const index = ref(Math.floor(Math.random() * professions.length));
const current = computed(() => professions[index.value]);

function roll() {
  index.value = Math.floor(Math.random() * professions.length);
}

function confirm() {
  game.selectProfession(current.value.id);
  router.push('/traits');
}
</script>
