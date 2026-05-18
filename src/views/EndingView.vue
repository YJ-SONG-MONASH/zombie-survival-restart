<template>
  <section class="screen ending-screen">
    <article v-if="game.ending" class="ending-card" :class="`ending-${game.ending.color}`">
      <p class="archive-kicker">末世模拟器 · {{ game.scenario.name }}篇</p>
      <div class="ending-art">{{ game.ending.icon }}</div>
      <h1>{{ game.ending.title }}</h1>
      <p class="ending-comment">“{{ game.ending.comment }}”</p>

      <dl class="ending-stats">
        <div>
          <dt>存活天数</dt>
          <dd>{{ game.ending.day }}</dd>
        </div>
        <div>
          <dt>结局状态</dt>
          <dd>{{ game.ending.victory ? '胜利结局' : '生存终结' }}</dd>
        </div>
        <div>
          <dt>死因/终点</dt>
          <dd>{{ game.ending.reason }}</dd>
        </div>
        <div>
          <dt>理智</dt>
          <dd>{{ game.ending.san }}</dd>
        </div>
      </dl>

      <section class="highlight-box">
        <h2>高光时刻</h2>
        <p>{{ game.ending.highlight }}</p>
      </section>

      <section class="inventory-summary">
        <h2>开局特性</h2>
        <p v-if="!game.ending.traits?.length">没有选择特性</p>
        <span v-for="trait in game.ending.traits" :key="trait.canonicalName">
          {{ trait.icon }} {{ trait.name }} {{ trait.points > 0 ? `+${trait.points}` : trait.points }}
        </span>
      </section>

      <section class="inventory-summary">
        <h2>最终背包</h2>
        <p v-if="game.ending.inventory.length === 0">背包已空</p>
        <span v-for="item in game.ending.inventory" :key="item.name">{{ item.icon }} {{ item.name }} x{{ item.count }}</span>
      </section>

      <form class="share-form" @submit.prevent="saveArchive">
        <input v-model="nickname" placeholder="输入你的昵称" />
        <button type="submit">分享到末世档案</button>
      </form>
    </article>

    <div class="ending-actions">
      <button class="secondary" @click="router.push('/')">返回首页</button>
      <button class="primary-action" @click="restart">重新开始</button>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const nickname = ref('');

function saveArchive() {
  game.saveArchive(nickname.value.trim() || game.profession?.name || '匿名幸存者');
  router.push('/');
}

function restart() {
  game.resetGame();
  router.push('/rebirth');
}
</script>
