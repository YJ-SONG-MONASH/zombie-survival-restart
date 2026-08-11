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
          <dt>姓名</dt>
          <dd>{{ game.ending.survivorName }}</dd>
        </div>
        <div>
          <dt>出生点</dt>
          <dd>{{ game.ending.spawnName }}</dd>
        </div>
        <div>
          <dt>击倒僵尸</dt>
          <dd>{{ Math.round(game.ending.stats?.zombiesKilled ?? 0) }}</dd>
        </div>
        <div>
          <dt>完成行动</dt>
          <dd>{{ Math.round(game.ending.stats?.actions ?? 0) }}</dd>
        </div>
        <div>
          <dt>迁移节点</dt>
          <dd>{{ Math.round(game.ending.stats?.distanceTravelled ?? 0) }}</dd>
        </div>
        <div>
          <dt>制作物品</dt>
          <dd>{{ Math.round(game.ending.stats?.crafted ?? 0) }}</dd>
        </div>
        <div v-for="vital in endingVitals" :key="vital.id">
          <dt>{{ vital.label }}</dt>
          <dd>{{ vital.value }}</dd>
        </div>
      </dl>

      <section class="highlight-box">
        <h2>高光时刻</h2>
        <p>{{ game.ending.highlight }}</p>
      </section>

      <section class="inventory-summary">
        <h2>最高技能</h2>
        <p v-if="!game.ending.topSkills?.length">没有明显技能优势</p>
        <span v-for="skill in game.ending.topSkills" :key="skill.id" class="skill-chip">
          <span class="skill-icon">
            <img :src="skillIconSrc(skill)" :alt="skill.canonicalName" @error="markIconMissing" />
            <span>{{ skill.fallbackIcon }}</span>
          </span>
          {{ skill.name }} {{ skill.level }}
        </span>
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
        <p v-if="!game.ending.inventory?.length">背包已空</p>
        <span v-for="item in game.ending.inventory ?? []" :key="item.name">{{ item.icon }} {{ item.name }} x{{ item.count }}</span>
      </section>

      <section class="inventory-summary">
        <h2>身体记录</h2>
        <p v-if="!game.ending.wounds?.length">最终没有留下未愈伤口</p>
        <span v-for="(wound, index) in game.ending.wounds ?? []" :key="`${wound.bodyPart}-${wound.type}-${index}`">
          {{ bodyPartLabels[wound.bodyPart] ?? wound.bodyPart }} · {{ woundTypeLabels[wound.type] ?? wound.type }}
        </span>
        <span v-if="game.ending.infectionLevel">感染 {{ Math.round(game.ending.infectionLevel) }}%</span>
      </section>

      <section class="highlight-box">
        <h2>最后五次决定</h2>
        <p v-for="entry in finalDecisions" :key="`${entry.day}-${entry.time}-${entry.title}`">
          第{{ entry.day }}天 {{ entry.time || '' }} · {{ entry.title }}：{{ entry.result }}
        </p>
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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { vitalDefinitions } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';
import { bodyPartLabels, woundTypeLabels } from '../services/survival.js';

const router = useRouter();
const game = useGameStore();
const nickname = ref('');
const endingVitals = computed(() => vitalDefinitions.map((vital) => ({
  ...vital,
  value: game.ending?.vitals?.[vital.id] ?? 0,
})));
const finalDecisions = computed(() => [...game.history].slice(-5).reverse());

function saveArchive() {
  game.saveArchive(nickname.value.trim() || game.survivorName || game.profession?.name || '匿名幸存者');
  router.push('/');
}

function restart() {
  game.resetGame();
  router.push('/profession');
}

function skillIconSrc(skill) {
  return `${import.meta.env.BASE_URL}pz-skills/${skill.iconFile}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}
</script>
