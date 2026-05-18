<template>
  <main class="app-shell" :class="{ 'danger-haze': Math.max(game.vitals.panic, game.vitals.stress) > 75 }">
    <RouterView />
  </main>
</template>

<script setup>
import { RouterView } from 'vue-router';
import { useGameStore } from './stores/game.js';

const game = useGameStore();
game.loadPersistedState();
</script>
