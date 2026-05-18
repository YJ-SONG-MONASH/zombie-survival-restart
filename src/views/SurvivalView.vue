<template>
  <section class="screen survival-screen map-survival-screen">
    <header class="survival-header map-survival-header">
      <div>
        <p>{{ game.survivorName || '无名幸存者' }} · {{ game.profession?.name }} · {{ game.spawnLocation?.name }}</p>
        <h1>第 {{ game.day }} 天</h1>
        <span>
          当前位置：{{ currentNode?.name ?? '未展开地图' }} · 剩余移动 {{ game.movesRemaining }} 步 · 距离胜利 {{ Math.max(0, game.maxDay - game.day + 1) }} 天
        </span>
      </div>
      <div class="meter-stack">
        <label v-for="vital in vitalsForDisplay" :key="vital.id" :class="{ danger: vital.danger }">
          {{ vital.fallbackIcon }} {{ vital.label }}
          <progress :value="vital.value" max="100"></progress>
          <span>{{ vital.value }}</span>
        </label>
      </div>
    </header>

    <section class="vehicle-strip">
      <span>交通：{{ vehicleLabel }}</span>
      <span>燃料 {{ game.vehicle?.fuel ?? 0 }}</span>
      <span>状态 {{ vehicleStatusLabel }}</span>
      <span>今日可移动 {{ game.movesRemaining }} / {{ game.movementAllowance() }}</span>
    </section>

    <main class="map-survival-layout">
      <section class="map-board" aria-label="地区节点地图">
        <svg class="map-edge-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line
            v-for="edge in visibleEdges"
            :key="edge.id"
            :class="['map-edge', edge.visibility]"
            :x1="edge.from.x"
            :y1="edge.from.y"
            :x2="edge.to.x"
            :y2="edge.to.y"
          />
        </svg>
        <button
          v-for="node in visibleNodes"
          :key="node.id"
          :class="['map-node', node.visibility, { adjacent: node.isAdjacent, movable: node.canMove }]"
          :style="{ left: `${node.x}%`, top: `${node.y}%` }"
          :disabled="!node.canMove"
          :title="nodeTooltip(node)"
          @click="moveToNode(node.id)"
        >
          <span class="map-node-icon">{{ node.typeMeta?.icon ?? '□' }}</span>
          <strong>{{ node.displayName }}</strong>
          <small v-if="node.visibility !== 'unknown'">{{ node.typeMeta?.label }} · 风险 {{ node.danger }}</small>
          <small v-else>未知区域</small>
        </button>
      </section>

      <aside class="map-detail-panel">
        <p class="panel-kicker">CURRENT NODE</p>
        <h2>{{ currentNode?.name ?? '未定位' }}</h2>
        <div class="node-meta-row">
          <span>{{ currentNodeType?.label ?? '未知类型' }}</span>
          <span>风险 {{ dangerStars(currentNode?.danger) }}</span>
        </div>
        <p>{{ currentNode?.description ?? '地图尚未初始化。' }}</p>
        <dl class="node-detail-list">
          <div>
            <dt>资源倾向</dt>
            <dd>{{ currentNode?.resourceHint ?? '未知' }}</dd>
          </div>
          <div>
            <dt>地区</dt>
            <dd>{{ currentNode?.region ?? '未知' }}</dd>
          </div>
          <div>
            <dt>可挂载庇护所</dt>
            <dd>{{ shelterNames(currentNode?.shelterIds).join(' / ') || '暂无记录' }}</dd>
          </div>
        </dl>

        <section class="movement-targets">
          <h3>相邻区域</h3>
          <button
            v-for="node in neighborNodes"
            :key="node.id"
            class="secondary movement-button"
            :disabled="!canMove(node.id)"
            @click="moveToNode(node.id)"
          >
            <span>{{ node.name }}</span>
            <small>{{ nodeTypeLabel(node.type) }} · 风险 {{ node.danger }}</small>
          </button>
        </section>

        <section class="map-actions">
          <h3>区域行动</h3>
          <button
            v-for="action in game.currentNodeActions"
            :key="action.id"
            class="secondary map-action-button"
            @click="runNodeAction(action.id)"
          >
            <span>{{ action.label }}</span>
            <small>{{ action.description }}</small>
          </button>
        </section>
      </aside>
    </main>

    <section class="status-grid map-status-grid">
      <article>
        <h3>背包</h3>
        <p v-if="game.inventory.length === 0">空空如也</p>
        <ul v-else class="map-inventory-list">
          <li v-for="item in game.inventory" :key="item.id">
            <span class="item-icon inventory-icon" aria-hidden="true">
              <img :src="itemIconSrc(item)" :alt="item.name" @error="markInventoryIconMissing" />
              <span></span>
            </span>
            {{ item.name }} x{{ item.count }}
          </li>
        </ul>
      </article>
      <article>
        <h3>状态</h3>
        <p v-if="game.hiddenTags.length === 0">暂无特殊状态</p>
        <div v-else class="tag-list">
          <span v-for="tag in game.hiddenTags" :key="tag">{{ tag }}</span>
        </div>
      </article>
      <article>
        <h3>技能</h3>
        <div class="skill-grid compact-skill-grid">
          <span v-for="skill in topSkills" :key="skill.id" class="skill-chip">
            <span class="skill-icon">
              <img :src="skillIconSrc(skill)" :alt="skill.canonicalName" @error="markIconMissing" />
              <span>{{ skill.fallbackIcon }}</span>
            </span>
            {{ skill.label }} {{ skill.level }}
          </span>
        </div>
      </article>
      <article>
        <h3>特性</h3>
        <p v-if="game.selectedTraits.length === 0">无特性开局</p>
        <div v-else class="tag-list">
          <span v-for="trait in game.selectedTraits" :key="trait.id">{{ trait.name }}</span>
        </div>
      </article>
    </section>

    <section class="map-log-panel">
      <div>
        <p class="panel-kicker">MAP LOG</p>
        <h2>地图记录</h2>
      </div>
      <article v-for="entry in recentMapLog" :key="`${entry.day}-${entry.title}-${entry.text}`">
        <strong>第{{ entry.day }}天 · {{ entry.title }}</strong>
        <p>{{ entry.text }}</p>
      </article>
    </section>

    <section v-if="game.history.length" class="timeline">
      <h2>生存记录</h2>
      <article v-for="entry in [...game.history].reverse().slice(0, 4)" :key="`${entry.day}-${entry.title}`">
        <strong>第{{ entry.day }}天 · {{ entry.title }}</strong>
        <p>{{ entry.result }}</p>
        <small>{{ entry.notes }} · 判定 {{ entry.score }}</small>
      </article>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mapEdges, mapNodeTypes, marketItems, shelters, skillDefinitions, vitalDefinitions } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const vitalsForDisplay = computed(() => vitalDefinitions.map((vital) => {
  const value = game.vitals[vital.id] ?? 0;
  return {
    ...vital,
    value,
    danger: vital.kind === 'good' ? value <= 35 : value >= 70,
  };
}));
const topSkills = computed(() => skillDefinitions
  .map((skill) => ({ ...skill, level: game.skills[skill.id] ?? 0 }))
  .sort((a, b) => b.level - a.level)
  .slice(0, 10));
const visibleNodes = computed(() => game.visibleMapNodeList);
const nodeById = computed(() => Object.fromEntries(visibleNodes.value.map((node) => [node.id, node])));
const visibleEdges = computed(() => mapEdges.map(([fromId, toId]) => {
  const from = nodeById.value[fromId];
  const to = nodeById.value[toId];
  const visibility = from?.visibility === 'unknown' && to?.visibility === 'unknown'
    ? 'unknown'
    : from?.canMove || to?.canMove
      ? 'active'
      : 'known';
  return { id: `${fromId}-${toId}`, from, to, visibility };
}).filter((edge) => edge.from && edge.to));
const currentNode = computed(() => game.currentMapNode);
const currentNodeType = computed(() => game.currentNodeType);
const neighborNodes = computed(() => game.currentNeighborNodes);
const recentMapLog = computed(() => game.mapLog.slice(0, 5));
const vehicleLabel = computed(() => game.vehicle?.name ?? '徒步');
const vehicleStatusLabel = computed(() => {
  if (game.vehicle?.status === 'working') return '可用';
  if (game.vehicle?.status === 'damaged') return '受损';
  return '无车';
});

onMounted(() => {
  if (!game.profession || !game.shelter) {
    router.replace('/profession');
    return;
  }
  if (!game.currentNodeId) game.initializeMapState();
});

watch(
  () => game.isGameOver,
  (value) => {
    if (value) router.push('/ending');
  }
);

function moveToNode(nodeId) {
  if (!game.moveToNode(nodeId)) return;
  if (game.isGameOver) router.push('/ending');
}

function runNodeAction(actionId) {
  if (!game.resolveNodeAction(actionId)) return;
  if (game.isGameOver) router.push('/ending');
}

function canMove(nodeId) {
  return game.canMoveToNode(nodeId);
}

function nodeTooltip(node) {
  if (node.visibility === 'unknown') return '远处区域尚未侦察';
  const moveHint = node.canMove ? '\n点击移动到这里' : '';
  return `${node.name}\n${node.typeMeta?.label ?? '未知类型'}\n风险：${node.danger}\n资源：${node.resourceHint}${moveHint}`;
}

function nodeTypeLabel(typeId) {
  return mapNodeTypes.find((type) => type.id === typeId)?.label ?? typeId;
}

function dangerStars(value = 0) {
  return '■'.repeat(Math.max(1, value));
}

function shelterNames(ids = []) {
  return ids
    .map((id) => shelters.find((shelter) => shelter.id === id)?.name)
    .filter(Boolean)
    .slice(0, 4);
}

function skillIconSrc(skill) {
  return `${import.meta.env.BASE_URL}pz-skills/${skill.iconFile}`;
}

function itemIconSrc(item) {
  const catalogItem = marketItems.find((entry) => entry.id === item.id) ?? item;
  return `${import.meta.env.BASE_URL}pz-items/${catalogItem.iconFile}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function markInventoryIconMissing(event) {
  event.currentTarget.closest('.inventory-icon')?.classList.add('missing');
}
</script>
