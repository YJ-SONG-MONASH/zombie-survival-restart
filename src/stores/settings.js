import { defineStore } from 'pinia';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    mode: 'offline',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
  }),
  getters: {
    isCustomMode: (state) => state.mode === 'custom' && Boolean(state.apiKey.trim()),
  },
  actions: {
    useOfficial() {
      this.mode = 'offline';
    },
    useCustom(payload) {
      this.mode = 'custom';
      this.apiBase = payload.apiBase || this.apiBase;
      this.model = payload.model || this.model;
      this.apiKey = payload.apiKey || this.apiKey;
    },
  },
});
