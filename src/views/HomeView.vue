<template>
  <section class="home-screen screen">
    <button class="icon-button settings-button" title="API 设置" @click="showSettings = true">⚙️</button>

    <header class="hero">
      <h1>末世模拟器</h1>
      <div class="server-switch" role="group" aria-label="运行模式">
        <button :class="{ active: settings.mode === 'offline' }" @click="settings.useOfficial()">离线规则</button>
        <button :class="{ active: settings.mode === 'custom' }" @click="showSettings = true">自定义 API</button>
      </div>
      <p class="server-status">
        <span class="status-dot"></span>
        {{ settings.isCustomMode ? '自定义 API 已配置' : '本地规则引擎已就绪' }}
      </p>
    </header>

    <div class="scenario-list">
      <button
        v-for="scenario in scenarios"
        :key="scenario.id"
        class="scenario-card"
        :class="[{ locked: scenario.locked }, `accent-${scenario.accent || 'muted'}`]"
        @click="start(scenario)"
      >
        <span class="scenario-icon">{{ scenario.icon }}</span>
        <span>
          <strong>{{ scenario.name }}</strong>
          <small>{{ scenario.description }}</small>
        </span>
        <em v-if="scenario.id === 'ice'">NEXT</em>
      </button>
    </div>

    <p class="hint">点击选择末日场景开始游戏</p>

    <section class="archive-section">
      <h2>🏛️ 末世档案馆</h2>
      <p>见证其他幸存者的末日传奇</p>
      <div v-if="game.archives.length === 0" class="empty-state">
        暂无档案记录。完成一局后，结局会保存在这里。
      </div>
      <div v-else class="archive-grid">
        <article v-for="archive in game.sortedArchives" :key="archive.id" class="archive-card">
          <div class="archive-art">{{ archive.ending.icon }}</div>
          <p class="archive-kicker">末世模拟器 · {{ archive.scenario.name }}篇</p>
          <h3>{{ archive.ending.title }}</h3>
          <dl>
            <div>
              <dt>存活天数</dt>
              <dd>{{ archive.ending.day }}</dd>
            </div>
            <div>
              <dt>职业</dt>
              <dd>{{ archive.profession?.name || '未知' }}</dd>
            </div>
          </dl>
          <blockquote>“{{ archive.ending.comment }}”</blockquote>
          <footer>{{ archive.nickname }} · {{ formatDate(archive.createdAt) }}</footer>
        </article>
      </div>
    </section>

    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false">
      <form class="settings-modal" @submit.prevent="saveSettings">
        <h2>自定义 API 设置</h2>
        <p>可填 OpenAI-compatible 接口。当前版本默认使用本地规则引擎，API 设置会先保存备用。</p>
        <label>
          API Base
          <input v-model="settingsDraft.apiBase" placeholder="https://api.deepseek.com" />
        </label>
        <label>
          Model
          <input v-model="settingsDraft.model" placeholder="deepseek-chat" />
        </label>
        <label>
          API Key
          <input v-model="settingsDraft.apiKey" type="password" placeholder="sk-..." />
        </label>
        <div class="modal-actions">
          <button type="button" class="secondary" @click="settings.useOfficial(); showSettings = false">使用离线规则</button>
          <button type="submit">保存</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { scenarios } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';
import { useSettingsStore } from '../stores/settings.js';

const router = useRouter();
const game = useGameStore();
const settings = useSettingsStore();
const showSettings = ref(false);
const settingsDraft = reactive({
  apiBase: settings.apiBase,
  model: settings.model,
  apiKey: settings.apiKey,
});

function start(scenario) {
  if (game.startScenario(scenario.id)) router.push('/rebirth');
}

function saveSettings() {
  settings.useCustom(settingsDraft);
  showSettings.value = false;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}
</script>
