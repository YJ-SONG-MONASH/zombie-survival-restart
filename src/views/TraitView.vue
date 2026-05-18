<template>
  <section class="screen trait-screen">
    <header class="trait-header">
      <div>
        <p>人物特性</p>
        <h1>Build 41 特性表</h1>
        <span>{{ game.profession?.name }} · 剩余点数必须不小于 0</span>
      </div>
      <aside :class="['points-panel', { negative: game.traitPointsRemaining < 0 }]">
        <small>剩余点数</small>
        <strong>{{ signed(game.traitPointsRemaining) }}</strong>
      </aside>
    </header>

    <div class="trait-tabs">
      <button
        v-for="group in traitGroups"
        :key="group.id"
        :class="{ active: activeGroup === group.id }"
        @click="activeGroup = group.id"
      >
        {{ group.label }}
      </button>
    </div>

    <section class="trait-list">
      <button
        v-for="trait in visibleTraits"
        :key="trait.id"
        :class="['trait-card', trait.type, { selected: isSelected(trait.id), blocked: isBlocked(trait) }]"
        :disabled="isBlocked(trait)"
        @click="game.toggleTrait(trait.id)"
      >
        <span class="trait-icon">
          <img :src="iconSrc(trait)" :alt="trait.canonicalName" @error="hideIcon" />
          <span>{{ trait.icon }}</span>
        </span>
        <span class="trait-copy">
          <strong>{{ trait.name }}</strong>
          <em>{{ trait.canonicalName }}</em>
          <small>{{ trait.description }}</small>
        </span>
        <b :class="{ gain: trait.points > 0 }">{{ signed(trait.points) }}</b>
      </button>
    </section>

    <section class="selected-traits">
      <h2>已选特性</h2>
      <p v-if="game.selectedTraits.length === 0">还没有选择任何特性。</p>
      <div v-else class="tag-list">
        <span v-for="trait in game.selectedTraits" :key="trait.id">
          {{ trait.name }} {{ signed(trait.points) }}
        </span>
      </div>
    </section>

    <div class="trait-actions">
      <button class="secondary" @click="game.selectedTraits = []">清空</button>
      <button class="primary-action" :disabled="game.traitPointsRemaining < 0" @click="router.push('/market')">
        确认特性，开始囤货
      </button>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { traitGroups, traits } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const activeGroup = ref('positive');
const baseUrl = import.meta.env.BASE_URL;

const visibleTraits = computed(() => traits.filter((trait) => trait.type === activeGroup.value));

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function isSelected(id) {
  return game.selectedTraits.some((trait) => trait.id === id);
}

function isBlocked(trait) {
  return !isSelected(trait.id) && !game.canSelectTrait(trait.id);
}

function iconSrc(trait) {
  return `${baseUrl}pz-traits/${trait.id}.png`;
}

function hideIcon(event) {
  event.currentTarget.classList.add('missing');
}

onMounted(() => {
  if (!game.profession) router.replace('/profession');
});
</script>
