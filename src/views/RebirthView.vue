<template>
  <section class="screen story-screen" @click="advance">
    <div class="story-copy">
      <p v-for="(line, index) in visibleLines" :key="index">{{ line }}</p>
    </div>
    <button class="primary-action" @click.stop="router.push('/profession')">
      回忆前世身份
    </button>
    <p class="hint">点击屏幕推进</p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const step = ref(1);
const lines = [
  '好痛。',
  '脖子被咬断的瞬间，你听见自己的呼吸像漏气的风箱。',
  '不想死。不想变成它们。',
  '你猛地从床上惊醒，冷汗浸透了睡衣。',
  '窗外阳光明媚，楼下早餐摊还在叫卖。',
  '手机屏幕亮起：末日爆发前 3 天。',
  '这一次，你要把前世的死亡变成情报。',
];

const visibleLines = computed(() => lines.slice(0, step.value));

function advance() {
  if (step.value < lines.length) step.value += 1;
  else router.push('/profession');
}
</script>
