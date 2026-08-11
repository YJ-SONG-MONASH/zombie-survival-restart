import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from './views/HomeView.vue';
import ProfessionView from './views/ProfessionView.vue';
import TraitView from './views/TraitView.vue';
import MarketView from './views/MarketView.vue';
import SurvivalView from './views/SurvivalView.vue';
import EndingView from './views/EndingView.vue';
import { useGameStore } from './stores/game.js';

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/profession', name: 'profession', component: ProfessionView },
    { path: '/traits', name: 'traits', component: TraitView },
    { path: '/market', name: 'market', component: MarketView },
    { path: '/survival', name: 'survival', component: SurvivalView },
    { path: '/ending', name: 'ending', component: EndingView },
  ],
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition;
    return { top: 0, left: 0 };
  },
});

router.beforeEach((to) => {
  const game = useGameStore();
  if (to.name === 'traits' && !game.profession) return { name: 'profession' };
  if (to.name === 'market' && !game.profession) return { name: 'profession' };
  if (to.name === 'market' && game.traitPointsRemaining < 0 && !game.isHiddenPresetLocked) return { name: 'traits' };
  if (to.name === 'survival' && (!game.profession || !game.shelter)) return { name: 'profession' };
  if (to.name === 'survival' && game.traitPointsRemaining < 0 && !game.isHiddenPresetLocked) return { name: 'traits' };
  if (to.name === 'survival' && game.isGameOver) {
    if (!game.ending?.title) game.finishIfGameOver();
    return { name: 'ending' };
  }
  if (to.name === 'ending') {
    if (game.isGameOver && !game.ending?.title) game.finishIfGameOver();
    if (!game.ending?.title) return game.profession && game.shelter ? { name: 'survival' } : { name: 'home' };
  }
  return true;
});

export default router;
