<template>
  <section class="screen survival-screen map-survival-screen">
    <header class="map-command-bar">
      <div class="map-identity">
        <p>{{ game.survivorName || '无名幸存者' }} · {{ game.profession?.name }} · {{ game.spawnLocation?.name }}</p>
        <h1>第 {{ game.day }} 天</h1>
        <span>{{ currentNode?.name ?? '未展开地图' }} · 剩余移动 {{ game.movesRemaining }} 步 · 还需 {{ Math.max(0, game.maxDay - game.day + 1) }} 天</span>
      </div>

      <div class="map-vitals">
        <label v-for="vital in vitalsForDisplay" :key="vital.id" :class="{ danger: vital.danger }">
          <span>{{ vital.fallbackIcon }} {{ vital.label }}</span>
          <progress :value="vital.value" max="100"></progress>
          <b>{{ vital.value }}</b>
        </label>
      </div>
    </header>

    <main class="map-playfield">
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
          :class="[
            'map-node',
            node.visibility,
            `scale-${node.displayScale}`,
            { adjacent: node.isAdjacent, movable: node.canMove, inspected: inspectedNode?.id === node.id },
          ]"
          :style="{ left: `${node.x}%`, top: `${node.y}%` }"
          :aria-pressed="inspectedNode?.id === node.id"
          :title="nodeTooltip(node)"
          @click="inspectNode(node)"
        >
          <span class="map-node-icon">{{ node.typeMeta?.icon ?? '□' }}</span>
          <strong>{{ node.displayName }}</strong>
          <small v-if="node.visibility !== 'unknown'">风险 {{ node.danger }}</small>
          <small v-else>未知区域</small>
        </button>
      </section>

      <aside class="map-quick-panel">
        <p class="panel-kicker">CURRENT NODE</p>
        <h2>{{ currentNode?.name ?? '未定位' }}</h2>
        <div class="node-meta-row">
          <span>{{ currentNodeType?.label ?? '未知类型' }}</span>
          <span>风险 {{ dangerStars(currentNode?.danger) }}</span>
        </div>
        <p>{{ currentNode?.description ?? '地图尚未初始化。' }}</p>
        <div class="quick-action-row">
          <button
            v-for="action in game.currentNodeActions"
            :key="action.id"
            class="map-action-chip"
            @click="runNodeAction(action.id)"
          >
            {{ action.label }}
          </button>
          <button class="map-action-chip inspect-chip" @click="inspectNode(currentNode)">
            查看地点
          </button>
        </div>
      </aside>

      <nav class="map-drawer-tabs" aria-label="地图侧栏">
        <button :class="{ active: activeDrawer === 'location' }" @click="toggleDrawer('location')">地点</button>
        <button :class="{ active: activeDrawer === 'inventory' }" @click="toggleDrawer('inventory')">背包</button>
        <button :class="{ active: activeDrawer === 'skills' }" @click="toggleDrawer('skills')">技能</button>
        <button :class="{ active: activeDrawer === 'log' }" @click="toggleDrawer('log')">记录</button>
      </nav>

      <aside v-if="activeDrawer" class="map-side-drawer">
        <header class="drawer-header">
          <div>
            <p class="panel-kicker">{{ drawerTitle.kicker }}</p>
            <h2>{{ drawerTitle.title }}</h2>
          </div>
          <button class="drawer-close" @click="activeDrawer = ''">关闭</button>
        </header>

        <section v-if="activeDrawer === 'location'" class="drawer-section node-scene-section">
          <article v-if="!canShowInspectedDetail" class="unknown-detail-panel">
            <p class="panel-kicker">UNSCOUTED AREA</p>
            <h3>???</h3>
            <p>距离太远，只能确认这里还有一处区域轮廓。接近或侦察后才会显示建筑、人物和可搜索对象。</p>
            <dl class="node-detail-list">
              <div>
                <dt>可见信息</dt>
                <dd>{{ inspectedNodeType?.label ?? '未知区域' }}</dd>
              </div>
              <div>
                <dt>行动建议</dt>
                <dd>先移动到相邻节点，或在当前位置执行侦察路线。</dd>
              </div>
            </dl>
          </article>

          <template v-else>
            <article class="scene-hero">
              <div class="scene-image-frame">
                <img
                  v-if="sceneAsset"
                  :src="assetSrc(sceneAsset)"
                  :alt="sceneAsset.name"
                  @error="markSceneAssetMissing"
                />
                <span>{{ sceneAsset?.fallback ?? inspectedNode?.region ?? 'MAP' }}</span>
              </div>
              <div>
                <p class="panel-kicker">{{ inspectedNodeType?.label ?? 'NODE' }}</p>
                <h3>{{ inspectedDetail?.headline ?? inspectedNode?.name }}</h3>
                <p>{{ inspectedDetail?.mood ?? inspectedNode?.description }}</p>
              </div>
            </article>

            <dl class="node-detail-list">
              <div>
                <dt>资源倾向</dt>
                <dd>{{ inspectedNode?.resourceHint ?? '未知' }}</dd>
              </div>
              <div>
                <dt>地区</dt>
                <dd>{{ inspectedNode?.region ?? '未知' }}</dd>
              </div>
              <div>
                <dt>可挂载庇护所</dt>
                <dd>{{ shelterNames(inspectedNode?.shelterIds).join(' / ') || '暂无记录' }}</dd>
              </div>
            </dl>

            <div class="node-detail-actions">
              <button v-if="inspectedNode?.id === currentNode?.id" class="secondary" disabled>当前位置</button>
              <button v-else-if="canMove(inspectedNode?.id)" class="primary-action" @click="queueMoveToNode(inspectedNode)">
                前往这里
              </button>
              <span v-else>需要接近后才能移动到这里。</span>
            </div>

            <h3>标志性地区</h3>
            <div class="scene-card-grid">
              <button
                v-for="entry in landmarksForDisplay"
                :key="entry.id"
                :class="['scene-card', { active: selectedSceneElement?.id === entry.id && selectedSceneElement?.section === 'landmark' }]"
                :title="assetTooltip(entry.assetId)"
                @click="selectSceneElement('landmark', entry)"
              >
                <span class="scene-card-icon">
                  <img :src="assetSrc(assetById(entry.assetId))" :alt="entry.name" @error="markDetailAssetMissing" />
                  <b>{{ assetById(entry.assetId)?.fallback ?? '地' }}</b>
                </span>
                <strong>{{ entry.name }}</strong>
                <small>{{ entry.description }}</small>
              </button>
            </div>

            <h3>建筑</h3>
            <div class="scene-card-grid">
              <button
                v-for="entry in inspectedDetail?.buildings ?? []"
                :key="entry.id"
                :class="['scene-card', { active: selectedSceneElement?.id === entry.id && selectedSceneElement?.section === 'building' }]"
                :title="assetTooltip(entry.assetId)"
                @click="selectSceneElement('building', entry)"
              >
                <span class="scene-card-icon">
                  <img :src="assetSrc(assetById(entry.assetId))" :alt="entry.name" @error="markDetailAssetMissing" />
                  <b>{{ assetById(entry.assetId)?.fallback ?? '建' }}</b>
                </span>
                <strong>{{ entry.name }}</strong>
                <small>风险 {{ entry.risk }} · {{ entry.description }}</small>
              </button>
            </div>

            <h3>人物</h3>
            <div class="scene-card-grid">
              <button
                v-for="entry in inspectedDetail?.characters ?? []"
                :key="entry.id"
                :class="['scene-card', { active: selectedSceneElement?.id === entry.id && selectedSceneElement?.section === 'character' }]"
                :title="assetTooltip(entry.assetId)"
                @click="selectSceneElement('character', entry)"
              >
                <span class="scene-card-icon npc">
                  <img :src="assetSrc(assetById(entry.assetId))" :alt="entry.name" @error="markDetailAssetMissing" />
                  <b>{{ assetById(entry.assetId)?.fallback ?? '人' }}</b>
                </span>
                <strong>{{ entry.name }}</strong>
                <small>{{ entry.role }} · {{ entry.attitude }} · {{ entry.description }}</small>
              </button>
            </div>

            <h3>可搜索对象</h3>
            <div class="scene-card-grid">
              <button
                v-for="entry in inspectedDetail?.searchables ?? []"
                :key="entry.id"
                :class="['scene-card', { active: selectedSceneElement?.id === entry.id && selectedSceneElement?.section === 'searchable' }]"
                :title="assetTooltip(entry.assetId)"
                @click="selectSceneElement('searchable', entry)"
              >
                <span :class="['scene-card-icon', `quality-${entry.quality}`]">
                  <img :src="assetSrc(assetById(entry.assetId))" :alt="entry.name" @error="markDetailAssetMissing" />
                  <b>{{ assetById(entry.assetId)?.fallback ?? '搜' }}</b>
                </span>
                <strong>{{ entry.name }}</strong>
                <small>{{ entry.description }}</small>
              </button>
            </div>

            <article v-if="selectedSceneElement" class="scene-inspection-panel">
              <p class="panel-kicker">{{ selectedSceneLabel }}</p>
              <h3>{{ selectedSceneElement.name }}</h3>
              <p>{{ selectedSceneDescription }}</p>
              <dl class="scene-inspection-meta">
                <div>
                  <dt>来源素材</dt>
                  <dd>{{ assetById(selectedSceneElement.assetId)?.name ?? '本地标记' }}</dd>
                </div>
                <div>
                  <dt>当前状态</dt>
                  <dd>{{ selectedSceneState }}</dd>
                </div>
              </dl>
              <div class="scene-inspection-actions">
                <button class="secondary" @click="sceneInspectFeedback = selectedScenePassiveResult">
                  {{ selectedScenePassiveAction }}
                </button>
                <button
                  v-if="selectedSceneElement.section === 'searchable'"
                  class="primary-action"
                  :disabled="inspectedNode?.id !== currentNode?.id || isSelectedSearchableSpent"
                  @click="openLocationSearch"
                >
                  {{ selectedSearchButtonText }}
                </button>
              </div>
              <p v-if="sceneInspectFeedback" class="scene-feedback">{{ sceneInspectFeedback }}</p>
            </article>

            <h3>地区线索</h3>
            <ul class="scene-clue-list">
              <li v-for="clue in inspectedDetail?.clues ?? []" :key="clue">{{ clue }}</li>
            </ul>

            <h3>周边节点</h3>
            <button
              v-for="node in neighborVisibleNodes"
              :key="node.id"
              class="secondary movement-button inspect-target-button"
              @click="inspectNode(node)"
            >
              <span>{{ node.displayName ?? node.name }}</span>
              <small>{{ nodeTypeLabel(node.type) }} · 风险 {{ node.visibility === 'unknown' ? '未知' : node.danger }} · {{ node.visibility === 'unknown' ? '尚未侦察' : node.resourceHint }}</small>
            </button>
          </template>
        </section>

        <section v-else-if="activeDrawer === 'inventory'" class="drawer-section">
          <div class="vehicle-strip drawer-vehicle-strip">
            <span>交通：{{ vehicleLabel }}</span>
            <span>燃料 {{ game.vehicle?.fuel ?? 0 }}</span>
            <span>状态 {{ vehicleStatusLabel }}</span>
          </div>
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
          <h3>状态</h3>
          <p v-if="game.hiddenTags.length === 0">暂无特殊状态</p>
          <div v-else class="tag-list drawer-tag-list">
            <span v-for="tag in game.hiddenTags" :key="tag">{{ tag }}</span>
          </div>
        </section>

        <section v-else-if="activeDrawer === 'skills'" class="drawer-section">
          <h3>最高技能</h3>
          <div class="skill-grid compact-skill-grid">
            <span v-for="skill in topSkills" :key="skill.id" class="skill-chip">
              <span class="skill-icon">
                <img :src="skillIconSrc(skill)" :alt="skill.canonicalName" @error="markIconMissing" />
                <span>{{ skill.fallbackIcon }}</span>
              </span>
              {{ skill.label }} {{ skill.level }}
            </span>
          </div>
          <h3>特性</h3>
          <p v-if="game.selectedTraits.length === 0">无特性开局</p>
          <div v-else class="tag-list drawer-tag-list">
            <span v-for="trait in game.selectedTraits" :key="trait.id">{{ trait.name }}</span>
          </div>
        </section>

        <section v-else class="drawer-section">
          <h3>地图记录</h3>
          <article v-for="entry in recentMapLog" :key="`${entry.day}-${entry.title}-${entry.text}`" class="drawer-log-entry">
            <strong>第{{ entry.day }}天 · {{ entry.title }}</strong>
            <p>{{ entry.text }}</p>
          </article>
          <h3>生存记录</h3>
          <article v-for="entry in [...game.history].reverse().slice(0, 5)" :key="`${entry.day}-${entry.title}`" class="drawer-log-entry">
            <strong>第{{ entry.day }}天 · {{ entry.title }}</strong>
            <p>{{ entry.result }}</p>
            <small>{{ entry.notes }} · 判定 {{ entry.score }}</small>
          </article>
        </section>
      </aside>
    </main>

    <section v-if="pendingMoveNode" class="move-confirm-backdrop" role="dialog" aria-modal="true">
      <article class="move-confirm-dialog">
        <p class="panel-kicker">CONFIRM MOVE</p>
        <h2>前往 {{ pendingMoveNode.name }}</h2>
        <p>{{ pendingMoveNode.description }}</p>
        <dl class="move-risk-grid">
          <div>
            <dt>区域类型</dt>
            <dd>{{ nodeTypeLabel(pendingMoveNode.type) }}</dd>
          </div>
          <div>
            <dt>风险等级</dt>
            <dd>{{ dangerStars(pendingMoveNode.danger) }}</dd>
          </div>
          <div>
            <dt>可能资源</dt>
            <dd>{{ pendingMoveNode.resourceHint }}</dd>
          </div>
          <div>
            <dt>移动代价</dt>
            <dd>{{ moveConsequenceText }}</dd>
          </div>
        </dl>
        <p class="move-warning">{{ moveRiskText(pendingMoveNode) }}</p>
        <footer>
          <button class="secondary" @click="pendingMoveNode = null">取消</button>
          <button class="primary-action" @click="confirmMove">确认移动</button>
        </footer>
      </article>
    </section>

    <section v-if="locationSearch" class="move-confirm-backdrop" role="dialog" aria-modal="true">
      <article class="location-search-dialog">
        <header class="location-search-header">
          <div>
            <p class="panel-kicker">AREA SEARCH</p>
            <h2>搜索 {{ locationSearch.searchable.name }}</h2>
            <span>{{ currentNode?.name }} · {{ locationSearch.searchable.description }}</span>
          </div>
          <strong>{{ locationSearchProgressText }}</strong>
        </header>

        <div class="loot-grid location-loot-grid" aria-label="地点物资搜索区">
          <button
            v-for="slot in locationSearch.slots"
            :key="slot.id"
            :class="locationLootSlotClass(slot)"
            :disabled="isLocationSlotDisabled(slot)"
            :title="locationLootTooltip(slot)"
            @click="searchLocationSlot(slot)"
          >
            <template v-if="slot.status === 'hidden'">
              <span class="loot-silhouette"></span>
              <em>{{ slot.space }} 格</em>
              <strong>未知物资</strong>
            </template>

            <template v-else-if="slot.status === 'searching'">
              <span class="search-lens">⌕</span>
              <strong>搜索中</strong>
            </template>

            <template v-else>
              <span class="item-icon">
                <img v-if="lootItem(slot)" :src="itemIconSrc(lootItem(slot))" :alt="lootItem(slot).name" @error="markLocationItemIconMissing" />
                <span>{{ lootItem(slot)?.fallbackIcon ?? '??' }}</span>
              </span>
              <strong>{{ lootItem(slot)?.name ?? '未知物资' }}</strong>
              <em>{{ slot.status === 'taken' ? `${slot.space} 格` : '背包已满' }}</em>
            </template>
          </button>
        </div>

        <footer class="location-search-actions">
          <button class="secondary" :disabled="locationSearch.started || locationSearch.searchingSlotId" @click="cancelLocationSearch">放弃搜索</button>
          <button class="secondary" :disabled="!canSearchAllLocationSlots" @click="searchAllLocationSlots">
            {{ locationSearch.searchingSlotId ? '搜索中' : `一键搜索 ${locationHiddenSlots.length}` }}
          </button>
          <button class="primary-action" :disabled="!locationSearch.started || locationSearch.searchingSlotId" @click="finishLocationSearch">
            结束搜索并结算
          </button>
        </footer>
      </article>
    </section>

    <section v-if="resolutionReport" class="move-confirm-backdrop" role="dialog" aria-modal="true">
      <article class="resolution-dialog">
        <p class="panel-kicker">RESOLUTION</p>
        <h2>{{ resolutionReport.title }}</h2>
        <p>{{ resolutionReport.result }}</p>

        <dl class="resolution-meta">
          <div>
            <dt>时间</dt>
            <dd>{{ resolutionReport.dayText }}</dd>
          </div>
          <div>
            <dt>位置</dt>
            <dd>{{ currentNode?.name ?? '未知地点' }}</dd>
          </div>
          <div>
            <dt>行动记录</dt>
            <dd>{{ resolutionReport.notes || '无额外记录' }}</dd>
          </div>
        </dl>

        <div class="resolution-columns">
          <section>
            <h3>状态变化</h3>
            <p v-if="!resolutionReport.vitalChanges.length">状态没有明显变化。</p>
            <span
              v-for="change in resolutionReport.vitalChanges"
              :key="change.id"
              :class="['resolution-pill', change.tone]"
            >
              {{ change.label }} {{ signed(change.delta) }} → {{ change.value }}
            </span>
          </section>

          <section>
            <h3>资源变化</h3>
            <p v-if="!resolutionReport.inventoryChanges.length && !resolutionReport.tagChanges.length && !resolutionReport.vehicleChange">没有资源变化。</p>
            <span
              v-for="change in resolutionReport.inventoryChanges"
              :key="change.id"
              :class="['resolution-pill', change.delta > 0 ? 'good' : 'bad']"
            >
              {{ change.delta > 0 ? '获得' : '消耗' }} {{ change.name }} x{{ Math.abs(change.delta) }}
            </span>
            <span
              v-for="change in resolutionReport.tagChanges"
              :key="change.label"
              :class="['resolution-pill', change.tone]"
            >
              {{ change.label }}
            </span>
            <span v-if="resolutionReport.vehicleChange" class="resolution-pill warn">
              {{ resolutionReport.vehicleChange }}
            </span>
          </section>
        </div>

        <footer>
          <button class="primary-action" @click="closeResolutionReport">继续</button>
        </footer>
      </article>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { itemTiers, lootTierWeights, mapEdges, mapNodeTypes, marketItems, shelters, skillDefinitions, vitalDefinitions, wikiAssetManifest } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const activeDrawer = ref('');
const pendingMoveNode = ref(null);
const selectedSceneElement = ref(null);
const sceneInspectFeedback = ref('');
const locationSearch = ref(null);
const resolutionReport = ref(null);
const searchSlotCountByQuality = {
  white: 4,
  green: 5,
  blue: 6,
  purple: 7,
  gold: 8,
  red: 9,
};
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
const neighborVisibleNodes = computed(() => neighborNodes.value.map((node) => nodeById.value[node.id] ?? node));
const inspectedNode = computed(() => nodeById.value[game.inspectedNodeId] ?? game.inspectedMapNode ?? currentNode.value);
const inspectedDetail = computed(() => game.inspectedNodeDetail);
const inspectedNodeType = computed(() => mapNodeTypes.find((type) => type.id === inspectedNode.value?.type) ?? null);
const canShowInspectedDetail = computed(() => Boolean(inspectedNode.value && inspectedNode.value.visibility !== 'unknown' && inspectedDetail.value));
const sceneAsset = computed(() => assetById(inspectedDetail.value?.sceneImage));
const shelterLandmark = computed(() => {
  if (!game.shelter || inspectedNode.value?.id !== game.spawnLocation?.id) return null;
  return {
    id: `home_shelter_${game.shelter.id}`,
    section: 'landmark',
    name: `生存据点：${game.shelter.name}`,
    assetId: 'tile_house',
    quality: game.shelter.quality,
    description: `你的开局避难所，容量 ${game.shelter.space}，防御 ${game.shelter.defense}。${game.shelter.hidden}`,
  };
});
const landmarksForDisplay = computed(() => [
  ...(shelterLandmark.value ? [shelterLandmark.value] : []),
  ...(inspectedDetail.value?.landmarks ?? []),
]);
const selectedSceneLabel = computed(() => {
  const labels = {
    landmark: 'LANDMARK',
    building: 'BUILDING',
    character: 'SURVIVOR',
    searchable: 'SEARCHABLE',
  };
  return labels[selectedSceneElement.value?.section] ?? 'INSPECTION';
});
const selectedSceneDescription = computed(() => {
  const entry = selectedSceneElement.value;
  if (!entry) return '';
  if (entry.section === 'building') return `风险 ${entry.risk ?? '未知'}。${entry.description}`;
  if (entry.section === 'character') return `${entry.role ?? '幸存者'}，态度 ${entry.attitude ?? '不明'}。${entry.description}`;
  return entry.description ?? '';
});
const selectedSceneState = computed(() => {
  const entry = selectedSceneElement.value;
  if (!entry) return '未选择';
  if (entry.section === 'searchable') return inspectedNode.value?.id === currentNode.value?.id ? '可立即搜索' : '需要先到达此地';
  if (entry.section === 'character') return '可尝试交谈';
  if (entry.section === 'building') return '可评估风险';
  return '已标记';
});
const selectedScenePassiveAction = computed(() => {
  const section = selectedSceneElement.value?.section;
  if (section === 'character') return '交谈';
  if (section === 'building') return '评估风险';
  if (section === 'searchable') return '检查容器';
  return '标记路线';
});
const selectedScenePassiveResult = computed(() => {
  const entry = selectedSceneElement.value;
  if (!entry) return '';
  if (entry.section === 'character') return `${entry.name}给出了一条线索：${entry.description}`;
  if (entry.section === 'building') return `${entry.name}已纳入风险评估，进入前建议确认体力和撤退路线。`;
  if (entry.section === 'searchable') return `${entry.name}可以翻找；真正结算需要在当前节点执行搜索。`;
  return `${entry.name}已标记为当前区域的参考点。`;
});
const selectedSearchKey = computed(() => {
  if (selectedSceneElement.value?.section !== 'searchable' || !currentNode.value?.id) return '';
  return `${currentNode.value.id}:${selectedSceneElement.value.id}`;
});
const isSelectedSearchableSpent = computed(() => Boolean(selectedSearchKey.value && game.searchedSceneObjectIds?.includes(selectedSearchKey.value)));
const selectedSearchButtonText = computed(() => {
  if (inspectedNode.value?.id !== currentNode.value?.id) return '到达后搜索';
  if (isSelectedSearchableSpent.value) return '已经搜过';
  return '搜索这里';
});
const locationHiddenSlots = computed(() => locationSearch.value?.slots.filter((slot) => slot.status === 'hidden') ?? []);
const locationSearchedSlots = computed(() => locationSearch.value?.slots.filter((slot) => slot.status !== 'hidden') ?? []);
const locationSearchProgressText = computed(() => {
  if (!locationSearch.value) return '';
  return `${locationSearchedSlots.value.length}/${locationSearch.value.slots.length}`;
});
const canSearchAllLocationSlots = computed(() => Boolean(locationSearch.value && locationHiddenSlots.value.length && !locationSearch.value.searchingSlotId));
const recentMapLog = computed(() => game.mapLog.slice(0, 5));
const vehicleLabel = computed(() => game.vehicle?.name ?? '徒步');
const vehicleStatusLabel = computed(() => {
  if (game.vehicle?.status === 'working') return '可用';
  if (game.vehicle?.status === 'damaged') return '受损';
  return '无车';
});
const drawerTitle = computed(() => {
  if (activeDrawer.value === 'inventory') return { kicker: 'BAG / STATUS', title: '背包与状态' };
  if (activeDrawer.value === 'skills') return { kicker: 'SKILLS / TRAITS', title: '技能与特性' };
  if (activeDrawer.value === 'log') return { kicker: 'MAP LOG', title: '记录' };
  return {
    kicker: 'NODE DETAIL',
    title: canShowInspectedDetail.value ? inspectedNode.value?.name ?? '地点详情' : '???',
  };
});
const moveConsequenceText = computed(() => {
  const vehicleText = game.vehicle?.status !== 'none' && (game.vehicle?.fuel ?? 0) > 0
    ? `消耗 1 燃料，今日剩余移动 ${Math.max(0, game.movesRemaining - 1)} 步`
    : '消耗今天 1 次移动并推进一天';
  return `${vehicleText}，会消耗基础食水并结算区域风险`;
});

onMounted(() => {
  if (!game.profession || !game.shelter) {
    router.replace('/profession');
    return;
  }
  if (!game.currentNodeId) game.initializeMapState();
  if (!game.inspectedNodeId && game.currentNodeId) game.inspectMapNode(game.currentNodeId);
});

watch(
  () => game.isGameOver,
  (value) => {
    if (value && !resolutionReport.value) router.push('/ending');
  }
);

watch(
  () => game.inspectedNodeId,
  () => {
    selectedSceneElement.value = null;
    sceneInspectFeedback.value = '';
  }
);

function toggleDrawer(drawer) {
  activeDrawer.value = activeDrawer.value === drawer ? '' : drawer;
}

function inspectNode(node) {
  if (!node?.id) return;
  if (!game.inspectMapNode(node.id)) return;
  activeDrawer.value = 'location';
}

function selectSceneElement(section, entry) {
  selectedSceneElement.value = { ...entry, section };
  sceneInspectFeedback.value = '';
}

function openLocationSearch() {
  if (selectedSceneElement.value?.section !== 'searchable') return;
  if (inspectedNode.value?.id !== currentNode.value?.id) {
    sceneInspectFeedback.value = '需要先移动到这个节点，才能搜索这里。';
    return;
  }
  if (isSelectedSearchableSpent.value) {
    sceneInspectFeedback.value = '这里已经被你翻过一遍，继续搜只会浪费时间。';
    return;
  }
  locationSearch.value = {
    searchKey: selectedSearchKey.value,
    searchable: { ...selectedSceneElement.value },
    nodeId: currentNode.value.id,
    slots: createLocationSearchSlots(selectedSceneElement.value, currentNode.value),
    searchingSlotId: null,
    started: false,
    initialSnapshot: captureGameSnapshot(),
  };
  sceneInspectFeedback.value = '';
}

function queueMoveToNode(node) {
  if (!node?.canMove && !canMove(node?.id)) return;
  pendingMoveNode.value = node;
}

function confirmMove() {
  if (!pendingMoveNode.value) return;
  const nodeId = pendingMoveNode.value.id;
  pendingMoveNode.value = null;
  const before = captureGameSnapshot();
  if (!game.moveToNode(nodeId)) return;
  showResolutionReport(before, { title: '移动结算' });
}

function runNodeAction(actionId) {
  const before = captureGameSnapshot();
  if (!game.resolveNodeAction(actionId)) return;
  showResolutionReport(before);
}

async function searchLocationSlot(slot) {
  if (!locationSearch.value || locationSearch.value.searchingSlotId || slot.status !== 'hidden') return;
  slot.status = 'searching';
  locationSearch.value.searchingSlotId = slot.id;
  locationSearch.value.started = true;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
  const item = lootItem(slot);
  const collected = item ? game.collectLootItem(item) : false;
  slot.status = collected ? 'taken' : 'revealed';
  locationSearch.value.searchingSlotId = null;
}

async function searchAllLocationSlots() {
  if (!locationSearch.value || locationSearch.value.searchingSlotId) return;
  const slots = locationHiddenSlots.value;
  if (!slots.length) return;
  slots.forEach((slot) => {
    slot.status = 'searching';
  });
  locationSearch.value.searchingSlotId = 'bulk';
  locationSearch.value.started = true;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
  slots.forEach((slot) => {
    if (slot.status !== 'searching') return;
    const item = lootItem(slot);
    const collected = item ? game.collectLootItem(item) : false;
    slot.status = collected ? 'taken' : 'revealed';
  });
  locationSearch.value.searchingSlotId = null;
}

function cancelLocationSearch() {
  if (locationSearch.value?.started || locationSearch.value?.searchingSlotId) return;
  locationSearch.value = null;
}

function finishLocationSearch() {
  if (!locationSearch.value || locationSearch.value.searchingSlotId || !locationSearch.value.started) return;
  const search = locationSearch.value;
  const collectedItems = search.slots
    .filter((slot) => slot.status === 'taken')
    .map((slot) => lootItem(slot))
    .filter(Boolean);
  game.markSceneSearchableSearched(search.searchKey);
  game.resolveSceneSearch(search.searchable, collectedItems);
  locationSearch.value = null;
  selectedSceneElement.value = null;
  showResolutionReport(search.initialSnapshot, { title: `搜索 ${search.searchable.name}` });
}

function locationLootSlotClass(slot) {
  return [
    'loot-slot',
    `footprint-${slot.footprint}`,
    `status-${slot.status}`,
    slot.status === 'hidden' || slot.status === 'searching' ? 'quality-unknown' : `quality-${slot.tier}`,
  ];
}

function isLocationSlotDisabled(slot) {
  return slot.status === 'hidden' && Boolean(locationSearch.value?.searchingSlotId);
}

function locationLootTooltip(slot) {
  if (slot.status === 'hidden') return `未知物资\n占用：${slot.space} 格\n点击搜索。`;
  if (slot.status === 'searching') return '搜索中';
  const item = lootItem(slot);
  if (!item) return '未知物资';
  return [
    item.name,
    `品质：${tierMeta(item.tier).shortLabel}`,
    `占用：${item.space} 格`,
    item.description,
  ].filter(Boolean).join('\n');
}

function createLocationSearchSlots(searchable, node) {
  const quality = searchable?.quality ?? 'green';
  const targetCount = searchSlotCountByQuality[quality] ?? 5;
  const slots = [];
  const guaranteedItem = pickLocationSearchItem(searchable, node, quality);
  if (guaranteedItem) slots.push(createLocationSearchSlot(guaranteedItem, slots.length, searchable, 'marked'));
  let attempts = 0;
  while (slots.length < targetCount && attempts < targetCount * 30) {
    attempts += 1;
    const tier = pickLocationLootTier();
    const item = pickLocationSearchItem(searchable, node, tier);
    if (item) slots.push(createLocationSearchSlot(item, slots.length, searchable, 'random'));
  }
  return slots;
}

function createLocationSearchSlot(item, index, searchable, source) {
  return {
    id: `area-${searchable.id}-${index}-${item.id}-${Math.random().toString(36).slice(2, 7)}`,
    itemId: item.id,
    status: 'hidden',
    space: item.space,
    footprint: footprintForSpace(item.space),
    tier: item.tier,
    source,
  };
}

function pickLocationLootTier() {
  const totalWeight = lootTierWeights.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of lootTierWeights) {
    roll -= entry.weight;
    if (roll < 0) return entry.tier;
  }
  return lootTierWeights[lootTierWeights.length - 1].tier;
}

function pickLocationSearchItem(searchable, node, tier) {
  const candidates = marketItems.filter((item) => item.tier === tier);
  const pool = candidates.length ? candidates : marketItems;
  const weighted = pool.map((item) => ({ item, weight: locationItemWeight(item, searchable, node) }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return weighted[weighted.length - 1]?.item ?? null;
}

function locationItemWeight(item, searchable, node) {
  const text = `${searchable?.name ?? ''} ${searchable?.description ?? ''} ${searchable?.assetId ?? ''} ${node?.resourceHint ?? ''} ${node?.type ?? ''}`.toLowerCase();
  const bias = searchBiasFromText(text);
  let weight = 1;
  if (bias.categories.includes(item.category)) weight += 6;
  (item.tags ?? []).forEach((tag) => {
    if (bias.tags.includes(tag)) weight += 4;
  });
  if (bias.items.includes(item.id)) weight += 9;
  if (item.tier === searchable?.quality) weight += 2;
  return weight;
}

function searchBiasFromText(text) {
  const bias = { categories: [], tags: [], items: [] };
  const add = (field, values) => values.forEach((value) => {
    if (!bias[field].includes(value)) bias[field].push(value);
  });
  if (/药|医|诊|hospital|clinic|medical|med/.test(text)) add('categories', ['medical']);
  if (/警|枪|弹|gun|police|ammo|cruiser/.test(text)) {
    add('categories', ['weapon', 'ammo']);
    add('tags', ['firearm', 'ammo', 'weapon']);
    add('items', ['m9_pistol', 'm36_revolver', 'shotgun_shells', '9mm_rounds']);
  }
  if (/消防|斧|fire/.test(text)) {
    add('categories', ['weapon', 'tool', 'base']);
    add('tags', ['axe', 'tool']);
    add('items', ['fire_axe', 'hand_axe', 'crowbar']);
  }
  if (/餐|厨|食|饮|罐头|冰柜|杂货|store|restaurant|kitchen|pantry|shelf/.test(text)) {
    add('categories', ['food', 'morale']);
    add('tags', ['food', 'water', 'morale']);
  }
  if (/仓|工具|车库|柜|箱|托盘|warehouse|locker|crate|storage|garage/.test(text)) {
    add('categories', ['tool', 'base', 'bag']);
    add('tags', ['tool', 'material', 'repair', 'capacity']);
  }
  if (/加油|燃油|车辆|后备箱|车|gas|fuel|trunk|wreck|vehicle/.test(text)) {
    add('categories', ['vehicle', 'tool', 'bag', 'food']);
    add('tags', ['vehicle', 'fuel', 'mechanics', 'capacity']);
    add('items', ['gas_can', 'jack', 'lug_wrench']);
  }
  if (/农|种子|园艺|钓|河|farm|seed|fishing|camp/.test(text)) {
    add('categories', ['survival', 'food', 'tool']);
    add('tags', ['farming', 'fishing', 'seed', 'water']);
  }
  if (!bias.categories.length) add('categories', ['food', 'tool', 'medical']);
  return bias;
}

function footprintForSpace(space) {
  if (space >= 8) return '4x2';
  if (space >= 6) return '3x2';
  if (space >= 4) return '2x2';
  if (space >= 3) return '3x1';
  if (space >= 2) return '2x1';
  return '1x1';
}

function captureGameSnapshot() {
  return {
    day: game.day,
    vitals: { ...game.vitals },
    inventory: Object.fromEntries(game.inventory.map((item) => [item.id, { count: item.count, name: item.name }])),
    hiddenTags: [...game.hiddenTags],
    vehicle: { ...game.vehicle },
    currentNodeId: game.currentNodeId,
    movesRemaining: game.movesRemaining,
  };
}

function showResolutionReport(before, context = {}) {
  resolutionReport.value = buildResolutionReport(before, captureGameSnapshot(), context);
}

function buildResolutionReport(before, after, context = {}) {
  const latestHistory = game.history[game.history.length - 1];
  const latestMapLog = game.mapLog[0];
  return {
    title: context.title ?? latestHistory?.title ?? latestMapLog?.title ?? '行动结算',
    result: latestHistory?.result ?? latestMapLog?.text ?? '行动已经结算。',
    notes: latestHistory?.notes ?? latestMapLog?.text ?? '',
    dayText: after.day === before.day ? `第 ${after.day} 天` : `第 ${before.day} 天 → 第 ${after.day} 天`,
    vitalChanges: vitalDefinitions
      .map((vital) => {
        const delta = (after.vitals[vital.id] ?? 0) - (before.vitals[vital.id] ?? 0);
        if (!delta) return null;
        const bad = vital.kind === 'good' ? delta < 0 : delta > 0;
        return {
          id: vital.id,
          label: vital.label,
          delta,
          value: after.vitals[vital.id] ?? 0,
          tone: bad ? 'bad' : 'good',
        };
      })
      .filter(Boolean),
    inventoryChanges: inventoryDiff(before.inventory, after.inventory),
    tagChanges: tagDiff(before.hiddenTags, after.hiddenTags),
    vehicleChange: vehicleDiff(before.vehicle, after.vehicle),
  };
}

function inventoryDiff(before, after) {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return ids
    .map((id) => {
      const delta = (after[id]?.count ?? 0) - (before[id]?.count ?? 0);
      if (!delta) return null;
      return {
        id,
        name: after[id]?.name ?? before[id]?.name ?? itemName(id),
        delta,
      };
    })
    .filter(Boolean);
}

function tagDiff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [
    ...after.filter((tag) => !beforeSet.has(tag)).map((tag) => ({ label: `新增状态：${tag}`, tone: 'bad' })),
    ...before.filter((tag) => !afterSet.has(tag)).map((tag) => ({ label: `移除状态：${tag}`, tone: 'good' })),
  ];
}

function vehicleDiff(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return '';
  return `交通：${before.name ?? '徒步'}(${before.status}/${before.fuel}) → ${after.name ?? '徒步'}(${after.status}/${after.fuel})`;
}

function closeResolutionReport() {
  resolutionReport.value = null;
  if (game.isGameOver) router.push('/ending');
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function canMove(nodeId) {
  return game.canMoveToNode(nodeId);
}

function nodeTooltip(node) {
  if (node.visibility === 'unknown') return '远处区域尚未侦察';
  const moveHint = node.canMove ? '\n详情内可选择前往这里' : '';
  return `${node.name}\n${node.typeMeta?.label ?? '未知类型'}\n风险：${node.danger}\n资源：${node.resourceHint}${moveHint}`;
}

function nodeTypeLabel(typeId) {
  return mapNodeTypes.find((type) => type.id === typeId)?.label ?? typeId;
}

function dangerStars(value = 0) {
  return '■'.repeat(Math.max(1, value));
}

function moveRiskText(node) {
  if (!node) return '';
  if (node.danger >= 5) return '高危区域可能带来受伤、恐慌和额外消耗。建议确认背包里有食水、绷带或可撤退路线。';
  if (node.danger >= 3) return '中等风险区域通常会消耗耐力和时间，可能遇到路障、尸群或噪音事件。';
  return '低风险不代表安全。移动仍会推进一天，并结算饥饿、口渴、疲劳和区域压力。';
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

function lootItem(slot) {
  return marketItems.find((item) => item.id === slot.itemId);
}

function itemName(id) {
  return marketItems.find((item) => item.id === id)?.name ?? id;
}

function tierMeta(tierId) {
  return itemTiers.find((tier) => tier.id === tierId) ?? itemTiers[0];
}

function assetById(assetId) {
  return wikiAssetManifest.find((asset) => asset.id === assetId) ?? null;
}

function assetSrc(asset) {
  if (!asset?.fileName) return '';
  const folderByType = {
    scene: 'pz-scenes',
    tile: 'pz-tiles',
    npc: 'pz-npcs',
  };
  return `${import.meta.env.BASE_URL}${folderByType[asset.type] ?? 'pz-scenes'}/${asset.fileName}`;
}

function assetTooltip(assetId) {
  const asset = assetById(assetId);
  if (!asset) return '本地素材缺失时使用文字剪影';
  return `${asset.name}\n来源：${asset.sourceUrl}`;
}

function markIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function markInventoryIconMissing(event) {
  event.currentTarget.closest('.inventory-icon')?.classList.add('missing');
}

function markLocationItemIconMissing(event) {
  event.currentTarget.classList.add('missing');
}

function markSceneAssetMissing(event) {
  event.currentTarget.classList.add('missing');
  event.currentTarget.closest('.scene-image-frame')?.classList.add('missing');
}

function markDetailAssetMissing(event) {
  event.currentTarget.classList.add('missing');
  event.currentTarget.closest('.scene-card-icon')?.classList.add('missing');
}
</script>
