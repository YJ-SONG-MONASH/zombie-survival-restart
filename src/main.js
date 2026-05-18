import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router.js';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.mount('#app');

watch(
  pinia.state,
  (state) => {
    localStorage.setItem('moshi-survival-state', JSON.stringify(state));
  },
  { deep: true }
);
