<template>
  <section class="screen survival-screen">
    <header class="survival-header">
      <div>
        <p>距离胜利还需坚持 {{ Math.max(0, game.maxDay - game.day + 1) }} 天</p>
        <h1>第 {{ game.day }} 天</h1>
      </div>
      <div class="meter-stack">
        <label>❤️ 生命 <progress :value="game.stats.hp" max="140"></progress><span>{{ game.stats.hp }}</span></label>
        <label>🧠 理智 <progress :value="game.stats.san" max="140"></progress><span>{{ game.stats.san }}</span></label>
      </div>
    </header>

    <section class="log-panel">
      <p class="panel-kicker">今日事件</p>
      <h2>{{ game.activeEvent?.title }}</h2>
      <p>{{ game.activeEvent?.log }}</p>
    </section>

    <div class="option-list">
      <button
        v-for="option in game.activeEvent?.options"
        :key="option.id"
        :class="{ selected: selectedOption === option.id }"
        @click="selectedOption = option.id"
      >
        {{ option.label }}
      </button>
    </div>

    <label class="free-input">
      自由输入
      <textarea v-model="freeText" rows="3" placeholder="输入你想做的事，例如：用棒球棍清理楼道，然后把门堵上。"></textarea>
    </label>

    <button class="primary-action" :disabled="!selectedOption && !freeText.trim()" @click="submit">
      确定
    </button>

    <section class="status-grid">
      <article>
        <h3>背包</h3>
        <p v-if="game.inventory.length === 0">空空如也</p>
        <ul v-else>
          <li v-for="item in game.inventory" :key="item.id">{{ item.icon }} {{ item.name }} x{{ item.count }}</li>
        </ul>
      </article>
      <article>
        <h3>状态</h3>
        <p v-if="game.hiddenTags.length === 0">暂无特殊状态</p>
        <div v-else class="tag-list">
          <span v-for="tag in game.hiddenTags" :key="tag">{{ tag }}</span>
        </div>
      </article>
    </section>

    <section v-if="game.history.length" class="timeline">
      <h2>生存记录</h2>
      <article v-for="entry in [...game.history].reverse().slice(0, 4)" :key="entry.day">
        <strong>第{{ entry.day }}天 · {{ entry.title }}</strong>
        <p>{{ entry.result }}</p>
        <small>{{ entry.notes }} · 判定 {{ entry.score }}</small>
      </article>
    </section>
  </section>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const selectedOption = ref('');
const freeText = ref('');

onMounted(() => {
  if (!game.profession || !game.shelter) router.replace('/profession');
  game.ensureActiveEvent();
});

watch(
  () => game.isGameOver,
  (value) => {
    if (value) router.push('/ending');
  }
);

function submit() {
  game.submitAction(freeText.value.trim(), selectedOption.value);
  selectedOption.value = '';
  freeText.value = '';
  if (game.isGameOver) router.push('/ending');
}
</script>
