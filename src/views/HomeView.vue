<template>
  <section class="home-screen screen pz-home">
    <button class="icon-button settings-button" title="自定义叙事尚未接入当前玩法" disabled>⚙️</button>

    <header class="hero pz-hero">
      <p class="pz-kicker">KNOX EVENT / SOLO SURVIVAL</p>
      <h1>PROJECT ZOMBOID<br />生存模拟器</h1>
      <p class="pz-subtitle">This is how you died.</p>
      <div class="server-switch" role="group" aria-label="运行模式">
        <button :class="{ active: settings.mode === 'offline' }" @click="settings.useOfficial()">离线规则</button>
        <button disabled title="后续版本接入">自定义叙事（开发中）</button>
      </div>
      <p class="server-status">
        <span class="status-dot"></span>
        本地规则引擎已就绪
      </p>
    </header>

    <section v-if="hasActiveRun" class="continue-run-card">
      <div>
        <p class="panel-kicker">ACTIVE SAVE</p>
        <h2>{{ game.survivorName || '无名幸存者' }} · 第 {{ game.day }} 天 {{ game.clockLabel }}</h2>
        <p>{{ game.currentMapNode?.name ?? game.spawnLocation?.name }} · {{ game.activeWeather.label }} · {{ game.ending?.title ? game.ending.title : '仍在挣扎求生' }}</p>
      </div>
      <button class="primary-action" @click="continueGame">继续游戏</button>
    </section>

    <div class="scenario-list pz-scenario-list">
      <button
        v-for="scenario in scenarios"
        :key="scenario.id"
        class="scenario-card pz-scenario-card"
        :class="[{ locked: scenario.locked }, `accent-${scenario.accent || 'muted'}`]"
        :disabled="scenario.locked"
        @click="start(scenario)"
      >
        <span class="scenario-icon">{{ scenarioGlyph(scenario.icon) }}</span>
        <span>
          <strong>{{ scenario.name }}</strong>
          <small>{{ scenario.description }}</small>
        </span>
        <em v-if="scenario.locked">LOCKED</em>
      </button>
    </div>

    <p class="hint">选择模式后进入角色创建。</p>

    <section class="home-codex-section" aria-labelledby="home-codex-title">
      <div class="codex-heading">
        <div>
          <p class="panel-kicker">IMPLEMENTED CATALOG</p>
          <h2 id="home-codex-title">末世图鉴</h2>
        </div>
        <dl>
          <div>
            <dt>道具</dt>
            <dd>{{ marketItems.length }}</dd>
          </div>
          <div>
            <dt>避难所</dt>
            <dd>{{ shelters.length }}</dd>
          </div>
        </dl>
      </div>

      <div class="codex-tabs" role="tablist" aria-label="图鉴类型">
        <button :class="{ active: compendiumTab === 'items' }" type="button" @click="compendiumTab = 'items'">
          道具图鉴
        </button>
        <button :class="{ active: compendiumTab === 'shelters' }" type="button" @click="compendiumTab = 'shelters'">
          避难所图鉴
        </button>
      </div>

      <div v-if="compendiumTab === 'items'" class="home-codex-panel">
        <div class="codex-filter-row" aria-label="道具分类筛选">
          <button
            v-for="category in itemCategoryOptions"
            :key="category.id"
            type="button"
            :class="{ active: activeItemCategory === category.id }"
            @click="activeItemCategory = category.id"
          >
            {{ category.label }}
            <span>{{ category.count }}</span>
          </button>
        </div>

        <div class="codex-grid item-codex-grid">
          <article
            v-for="item in visibleItems"
            :key="item.id"
            class="codex-card codex-item-card"
            :class="`quality-${item.tier}`"
            :title="itemTooltip(item)"
          >
            <div class="codex-icon item-icon">
              <img :src="itemIconSrc(item)" :alt="item.name" @error="markIconMissing" />
              <span>{{ item.fallbackIcon }}</span>
            </div>
            <div class="codex-card-copy">
              <div class="codex-title-line">
                <strong>{{ item.name }}</strong>
                <b>{{ tierMeta(item.tier).shortLabel }}</b>
              </div>
              <small>{{ categoryLabel(item.category) }} · {{ item.space }} 格</small>
              <p>{{ item.description }}</p>
              <div class="codex-effect-list">
                <span v-for="effect in itemEffects(item)" :key="effect">{{ effect }}</span>
              </div>
              <div class="codex-tags">
                <span v-for="tag in item.tags.slice(0, 4)" :key="tag">{{ tag }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div v-else class="home-codex-panel">
        <div class="codex-filter-row" aria-label="避难所品质筛选">
          <button
            v-for="quality in shelterQualityOptions"
            :key="quality.id"
            type="button"
            :class="{ active: activeShelterQuality === quality.id }"
            @click="activeShelterQuality = quality.id"
          >
            {{ quality.label }}
            <span>{{ quality.count }}</span>
          </button>
        </div>

        <div class="codex-grid shelter-codex-grid">
          <article
            v-for="shelter in visibleShelters"
            :key="shelter.id"
            class="codex-card codex-shelter-card"
            :class="`quality-${shelter.quality}`"
          >
            <div class="codex-title-line">
              <strong>{{ shelter.name }}</strong>
              <b>{{ qualityMeta(shelter.quality).shortLabel }}</b>
            </div>
            <small>{{ shelterLocationText(shelter) }}</small>
            <dl class="codex-metrics">
              <div>
                <dt>容量</dt>
                <dd>{{ shelter.space }}</dd>
              </div>
              <div>
                <dt>防御</dt>
                <dd>{{ defenseText(shelter.defense) }}</dd>
              </div>
              <div>
                <dt>定位</dt>
                <dd>{{ qualityMeta(shelter.quality).tone }}</dd>
              </div>
            </dl>
            <p>{{ shelter.description }}</p>
            <em>{{ shelter.hidden }}</em>
            <div class="codex-tags">
              <span v-for="tag in shelter.tags.slice(0, 5)" :key="tag">{{ tag }}</span>
            </div>
          </article>
        </div>
      </div>
    </section>

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
              <dt>幸存者</dt>
              <dd>{{ archive.survivorName || archive.profession?.name || '未知' }}</dd>
            </div>
            <div>
              <dt>出生点</dt>
              <dd>{{ archive.spawnLocation?.name || '未知' }}</dd>
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
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { itemTiers, marketItems, scenarios, shelterQualities, shelters, spawnLocations } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';
import { useSettingsStore } from '../stores/settings.js';

const router = useRouter();
const game = useGameStore();
const settings = useSettingsStore();
const showSettings = ref(false);
const compendiumTab = ref('items');
const activeItemCategory = ref('all');
const activeShelterQuality = ref('all');
const settingsDraft = reactive({
  apiBase: settings.apiBase,
  model: settings.model,
  apiKey: settings.apiKey,
});
const hasActiveRun = computed(() => Boolean(game.profession || game.shelter || game.history.length || game.ending));

const itemCategoryLabels = {
  all: '全部',
  food: '食物/饮品',
  morale: '心态消耗',
  medical: '医疗',
  weapon: '武器',
  ammo: '弹药',
  tool: '工具',
  base: '基地',
  bag: '背包',
  survival: '求生',
  vehicle: '车辆',
};
const effectLabels = {
  thirst: '口渴',
  hunger: '饥饿',
  stress: '压力',
  fatigue: '疲劳',
  health: '生命',
  panic: '恐慌',
  skill: '技能',
  ammo: '弹药',
  capacity: '容量',
  barricade: '封堵',
  repair: '维修',
  demolition: '破拆',
  power: '供电',
  knowledge: '知识',
  night: '夜行',
  fishing: '钓鱼',
  fuel: '燃料',
};

const itemCategoryOptions = computed(() => {
  const categoryCounts = marketItems.reduce((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
  return [
    { id: 'all', label: '全部', count: marketItems.length },
    ...Object.entries(categoryCounts)
      .map(([id, count]) => ({ id, label: categoryLabel(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
  ];
});

const visibleItems = computed(() => marketItems
  .filter((item) => activeItemCategory.value === 'all' || item.category === activeItemCategory.value)
  .sort((a, b) => {
    const categoryCompare = categoryLabel(a.category).localeCompare(categoryLabel(b.category), 'zh-CN');
    if (categoryCompare) return categoryCompare;
    return tierMeta(b.tier).rank - tierMeta(a.tier).rank || a.name.localeCompare(b.name, 'zh-CN');
  }));

const shelterQualityOptions = computed(() => [
  { id: 'all', label: '全部', count: shelters.length },
  ...shelterQualities.map((quality) => ({
    id: quality.id,
    label: `${quality.shortLabel}色`,
    count: shelters.filter((shelter) => shelter.quality === quality.id).length,
  })),
]);

const visibleShelters = computed(() => shelters
  .filter((shelter) => activeShelterQuality.value === 'all' || shelter.quality === activeShelterQuality.value)
  .sort((a, b) => qualityMeta(b.quality).rank - qualityMeta(a.quality).rank || a.name.localeCompare(b.name, 'zh-CN')));

function start(scenario) {
  if (scenario.locked) return;
  if (hasActiveRun.value && !globalThis.confirm('开始新游戏会覆盖当前生存进度（档案馆记录会保留）。确定继续吗？')) return;
  if (game.startScenario(scenario.id)) router.push('/profession');
}

function continueGame() {
  if (game.ending?.title) router.push('/ending');
  else if (game.profession && game.shelter) router.push('/survival');
  else if (game.profession) router.push('/market');
  else router.push('/profession');
}

function scenarioGlyph(icon) {
  return {
    biohazard: '☣',
    classified: '§',
    map: '▦',
  }[icon] ?? icon;
}

function saveSettings() {
  settings.useCustom(settingsDraft);
  showSettings.value = false;
}

function categoryLabel(categoryId) {
  return itemCategoryLabels[categoryId] ?? categoryId;
}

function tierMeta(tierId) {
  return itemTiers.find((tier) => tier.id === tierId) ?? itemTiers[0];
}

function qualityMeta(qualityId) {
  return shelterQualities.find((quality) => quality.id === qualityId) ?? shelterQualities[shelterQualities.length - 1];
}

function itemIconSrc(item) {
  return `${import.meta.env.BASE_URL}pz-items/${item.iconFile}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function itemEffects(item) {
  return Object.entries(item.effects ?? {})
    .map(([key, value]) => {
      const label = effectLabels[key] ?? key;
      if (typeof value === 'number') return `${label} ${value > 0 ? '+' : ''}${value}`;
      if (key === 'capacity') return `${label} +${value}`;
      return `${label}: ${value}`;
    })
    .slice(0, 3);
}

function itemTooltip(item) {
  const effects = itemEffects(item);
  return [
    `${item.name} / ${item.canonicalName}`,
    `${categoryLabel(item.category)} · ${tierMeta(item.tier).tone}`,
    `占用 ${item.space} 格`,
    effects.length ? effects.join(' / ') : '',
    item.description,
  ].filter(Boolean).join('\n');
}

function shelterLocationText(shelter) {
  if (!shelter.locations?.length) return '通用避难所';
  const names = shelter.locations.map((id) => spawnLocations.find((location) => location.id === id)?.name ?? id);
  return `${names.join(' / ')} 独有`;
}

function defenseText(value) {
  return '★'.repeat(Math.max(1, value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}
</script>
