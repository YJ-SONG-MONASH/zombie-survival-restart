import { createRouter, createWebHashHistory } from 'vue-router';
import HomeView from './views/HomeView.vue';
import RebirthView from './views/RebirthView.vue';
import ProfessionView from './views/ProfessionView.vue';
import MarketView from './views/MarketView.vue';
import SurvivalView from './views/SurvivalView.vue';
import EndingView from './views/EndingView.vue';

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/rebirth', name: 'rebirth', component: RebirthView },
    { path: '/profession', name: 'profession', component: ProfessionView },
    { path: '/market', name: 'market', component: MarketView },
    { path: '/survival', name: 'survival', component: SurvivalView },
    { path: '/ending', name: 'ending', component: EndingView },
  ],
});

export default router;
