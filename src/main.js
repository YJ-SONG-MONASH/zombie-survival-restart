import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './styles.css';
import { useGameStore } from './stores/game.js';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
const game = useGameStore(pinia);
game.loadPersistedState();
app.use(router);
app.mount('#app');

watch(
  () => pinia.state.value.game,
  (gameState) => {
    try {
      localStorage.setItem('moshi-survival-state', JSON.stringify({ game: gameState }));
    } catch {
      // A full or unavailable storage backend must not interrupt play.
    }
  },
  { deep: true }
);
