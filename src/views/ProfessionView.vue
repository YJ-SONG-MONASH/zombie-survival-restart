<template>
  <section class="screen character-screen">
    <header class="character-header">
      <p>CREATE SURVIVOR</p>
      <h1>角色创建</h1>
      <span>{{ game.scenario.name }} · {{ game.spawnLocation?.canonicalName }}</span>
    </header>

    <section class="character-layout">
      <aside class="character-panel">
        <label class="name-field">
          姓名
          <input v-model="survivorName" maxlength="16" placeholder="输入幸存者姓名" />
        </label>
        <div v-if="unlockedHidden.length" class="hidden-unlock">
          <strong>隐藏职业已解锁</strong>
          <span v-for="profession in unlockedHidden" :key="profession.id">{{ profession.name }}</span>
        </div>
        <article v-if="game.profession" class="profile-card compact-profile">
          <div class="occupation-mark">{{ professionGlyph(game.profession.icon) }}</div>
          <h2>{{ game.profession.name }}</h2>
          <p>{{ game.profession.canonicalName }}</p>
          <small>{{ game.profession.summary }}</small>
          <div class="stat-row">
            <span>点数 <strong>{{ signed(game.baseTraitPoints) }}</strong></span>
            <span>生命 <strong>{{ game.stats.hp }}</strong></span>
            <span>理智 <strong>{{ game.stats.san }}</strong></span>
          </div>
          <div class="tag-list">
            <span v-for="tag in game.profession.tags" :key="tag">{{ tag }}</span>
          </div>
        </article>
      </aside>

      <main class="character-main">
        <section class="creation-block">
          <h2>出生点</h2>
          <div class="spawn-grid">
            <button
              v-for="location in spawnLocations"
              :key="location.id"
              :class="['spawn-card', { selected: game.spawnLocation?.id === location.id }]"
              @click="game.selectSpawnLocation(location.id)"
            >
              <strong>{{ location.name }}</strong>
              <em>{{ location.canonicalName }}</em>
              <small>{{ location.description }}</small>
              <span>{{ location.difficulty }} · {{ location.loot }}</span>
            </button>
          </div>
        </section>

        <section class="creation-block">
          <div class="section-title-row">
            <h2>职业</h2>
            <small>{{ visibleProfessions.length }} 个可选职业</small>
          </div>
          <div class="profession-grid">
            <button
              v-for="profession in visibleProfessions"
              :key="profession.id"
              :class="['profession-card', { selected: game.profession?.id === profession.id, hidden: profession.hiddenOnly }]"
              @click="game.selectProfession(profession.id)"
            >
              <span>{{ professionGlyph(profession.icon) }}</span>
              <strong>{{ profession.name }}</strong>
              <em>{{ profession.canonicalName }}</em>
              <small>{{ profession.summary }}</small>
              <b>{{ signed(profession.traitPointMod ?? 0) }}</b>
            </button>
          </div>
        </section>
      </main>
    </section>

    <button class="primary-action fixed-action" :disabled="!canContinue" @click="continueToTraits">
      确认角色，选择特性
    </button>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { professions, spawnLocations } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const survivorName = ref(game.survivorName || '');

const visibleProfessions = computed(() => professions.filter((profession) => !profession.hiddenOnly || game.unlockedProfessionIds.includes(profession.id)));
const unlockedHidden = computed(() => visibleProfessions.value.filter((profession) => profession.hiddenOnly));
const canContinue = computed(() => survivorName.value.trim().length > 0 && Boolean(game.spawnLocation) && Boolean(game.profession));

watch(survivorName, (value) => game.setSurvivorName(value), { immediate: true });

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function professionGlyph(icon) {
  return {
    civilian: '□',
    fire: '🪓',
    badge: '★',
    forest: '♣',
    hammer: '▰',
    night: '◐',
    plank: '▥',
    key: '⚿',
    pan: '◒',
    wrench: '⚙',
    crop: '♧',
    fish: '≈',
    medical: '+',
    medal: '◆',
    nurse: '✚',
    axe: '⛏',
    fitness: '▲',
    burger: '☰',
    electric: 'ϟ',
    engineer: '⌬',
    welder: '▣',
    car: '▻',
    prison: '▦',
    circuit: '⌁',
  }[icon] ?? icon;
}

function continueToTraits() {
  game.setSurvivorName(survivorName.value.trim());
  router.push('/traits');
}

onMounted(() => {
  if (!game.spawnLocation) game.selectSpawnLocation('muldraugh');
  if (!game.profession) game.selectProfession('unemployed');
});
</script>
