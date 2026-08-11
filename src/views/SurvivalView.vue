<template>
  <section class="screen survival-screen map-survival-screen">
    <header class="map-command-bar">
      <div class="map-identity">
        <p>{{ game.survivorName || '无名幸存者' }} · {{ game.profession?.name }} · {{ game.spawnLocation?.name }}</p>
        <div class="map-dayline">
          <h1>第 {{ game.day }} 天</h1>
          <strong>{{ game.clockLabel }} · {{ game.activeWeather.icon }} {{ game.activeWeather.label }}</strong>
        </div>
        <span>{{ currentNode?.name ?? '未展开地图' }} · {{ game.world?.temperatureC ?? game.activeWeather.temperatureC }}°C · {{ evacuationStatus }}</span>
        <div class="map-world-strip" aria-label="世界状态">
          <span class="world-status-chip status-weather">
            <b>{{ game.activeWeather.icon }}</b>
            {{ game.activeWeather.label }} {{ game.world?.temperatureC ?? game.activeWeather.temperatureC }}°C
          </span>
          <span :class="['world-status-chip', game.world?.powerOn ? 'good' : 'danger']">
            <b>ϟ</b>{{ game.world?.powerOn ? '电力在线' : '电力中断' }}
          </span>
          <span :class="['world-status-chip', game.world?.waterOn ? 'good' : 'danger']">
            <b>≈</b>{{ game.world?.waterOn ? '供水在线' : '供水中断' }}
          </span>
          <span :class="['world-status-chip', worldSignalTone(game.world?.noise)]">
            <b>⌁</b>噪声 {{ Math.round(game.world?.noise ?? 0) }} · {{ noiseLabel }}
          </span>
          <span :class="['world-status-chip', worldSignalTone(game.world?.threat)]">
            <b>☣</b>尸群 {{ Math.round(game.world?.threat ?? 0) }} · {{ threatLabel }}
          </span>
        </div>
      </div>

      <div class="map-survival-readout">
        <div class="map-vitals">
          <label
            v-for="vital in vitalsForDisplay"
            :key="vital.id"
            :class="[`vital-${vital.id}`, { danger: vital.danger, 'mobile-secondary-vital': !['health', 'endurance'].includes(vital.id) }]"
          >
            <span>{{ vital.fallbackIcon }} {{ vital.label }}</span>
            <progress :value="vital.value" max="100"></progress>
            <b>{{ vital.value }}</b>
          </label>
        </div>
        <div class="map-moodle-strip" aria-label="当前生存状态">
          <span v-if="!game.moodles.length" class="moodle-stable"><b>✓</b> 状态稳定</span>
          <span
            v-for="moodle in game.moodles"
            :key="moodle.id"
            :class="['moodle-chip', `tone-${moodle.tone}`]"
            :title="moodle.detail"
          >
            <b>{{ moodleIcon(moodle.id) }}</b>
            {{ moodle.label }}
          </span>
        </div>
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
            :class="['map-action-chip', { blocked: action.disabled }]"
            :disabled="action.disabled || game.isGameOver"
            :title="action.disabledReason || action.description"
            @click="runNodeAction(action.id)"
          >
            <strong>{{ action.label }}</strong>
            <small>{{ formatDuration(action.minutes) }}</small>
            <em v-if="action.disabledReason">{{ action.disabledReason }}</em>
          </button>
          <button class="map-action-chip inspect-chip" @click="inspectNode(currentNode)">
            <strong>查看地点</strong>
            <small>不耗时</small>
          </button>
        </div>
      </aside>

      <nav class="map-drawer-tabs" aria-label="地图侧栏">
        <button :class="{ active: activeDrawer === 'location' }" @click="toggleDrawer('location')">地点</button>
        <button :class="{ active: activeDrawer === 'inventory' }" @click="toggleDrawer('inventory')">背包</button>
        <button :class="{ active: activeDrawer === 'survival' }" @click="toggleDrawer('survival')">生存</button>
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
              </div>
              <p v-if="sceneInspectFeedback" class="scene-feedback">{{ sceneInspectFeedback }}</p>

              <template v-if="selectedNestedSearchables.length">
                <h4>可搜索对象</h4>
                <div class="scene-card-grid nested-search-grid">
                  <button
                    v-for="entry in selectedNestedSearchables"
                    :key="entry.id"
                    :class="[
                      'scene-card',
                      'nested-search-card',
                      {
                        active: selectedSearchTarget?.id === entry.id,
                        searched: isSearchableSpent(entry),
                      },
                    ]"
                    :title="assetTooltip(entry.assetId)"
                    @click="selectSearchTarget(entry)"
                  >
                    <span :class="['scene-card-icon', `quality-${entry.quality}`]">
                      <img :src="assetSrc(assetById(entry.assetId))" :alt="entry.name" @error="markDetailAssetMissing" />
                      <b>{{ assetById(entry.assetId)?.fallback ?? '搜' }}</b>
                    </span>
                    <strong>{{ entry.name }}</strong>
                    <small>{{ entry.description }}</small>
                    <em>{{ searchButtonTextFor(entry) }}</em>
                  </button>
                </div>
                <div class="scene-inspection-actions">
                  <button
                    class="primary-action"
                    :disabled="!selectedSearchTarget || inspectedNode?.id !== currentNode?.id || isSearchableSpent(selectedSearchTarget)"
                    @click="openLocationSearch(selectedSearchTarget)"
                  >
                    {{ selectedSearchTarget ? searchButtonTextFor(selectedSearchTarget) : '选择一个对象' }}
                  </button>
                </div>
              </template>
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
          <div class="inventory-capacity-heading">
            <h3>背包</h3>
            <strong>{{ game.usedSpace }} / {{ game.maxSpace }} 格</strong>
          </div>
          <progress class="inventory-capacity-meter" :value="game.usedSpace" :max="Math.max(1, game.maxSpace)"></progress>
          <p class="equipped-weapon-line">
            主手：<strong>{{ game.equippedWeapon?.name ?? '徒手' }}</strong>
          </p>
          <p v-if="game.inventory.length === 0">空空如也</p>
          <ul v-else class="map-inventory-list">
            <li v-for="item in game.inventory" :key="item.id" :class="{ equipped: game.equippedWeapon?.id === item.id }">
              <div class="inventory-item-main">
                <span class="item-icon inventory-icon" aria-hidden="true">
                  <img :src="itemIconSrc(item)" :alt="item.name" @error="markInventoryIconMissing" />
                  <span></span>
                </span>
                <span>
                  <strong>{{ item.name }} x{{ item.count }}</strong>
                  <small>{{ item.space }} 格/件 · {{ item.description }}</small>
                </span>
              </div>
              <div v-if="canUseInventoryItem(item) || isWeapon(item)" class="inventory-item-actions">
                <button v-if="canUseInventoryItem(item)" class="secondary" @click="useInventoryItem(item)">使用</button>
                <button v-if="isWeapon(item)" class="secondary" @click="toggleWeapon(item)">
                  {{ game.equippedWeapon?.id === item.id ? '卸下' : '装备' }}
                </button>
              </div>
            </li>
          </ul>
          <h3>状态</h3>
          <p v-if="game.hiddenTags.length === 0">暂无特殊状态</p>
          <div v-else class="tag-list drawer-tag-list">
            <span v-for="tag in game.hiddenTags" :key="tag">{{ tag }}</span>
          </div>
        </section>

        <section v-else-if="activeDrawer === 'survival'" class="drawer-section survival-drawer-section">
          <section class="survival-drawer-block evacuation-objective-card">
            <p class="panel-kicker">EVACUATION WINDOW</p>
            <h3>第 {{ game.maxDay }}–{{ game.evacuationDeadline }} 天抵达撤离区</h3>
            <p>目标：谷地检查点或路易斯维尔外环。提前抵达可以整备，错过窗口则本局失败。</p>
            <strong>{{ evacuationStatus }}</strong>
          </section>

          <section class="survival-drawer-block">
            <div class="drawer-subheading">
              <h3>Moodle</h3>
              <span>{{ game.moodles.length || '稳定' }}</span>
            </div>
            <p v-if="!game.moodles.length" class="survival-empty-state">目前没有明显负面状态。</p>
            <div v-else class="survival-moodle-grid">
              <article v-for="moodle in game.moodles" :key="moodle.id" :class="[`tone-${moodle.tone}`]">
                <b>{{ moodleIcon(moodle.id) }}</b>
                <span><strong>{{ moodle.label }}</strong><small>{{ moodle.detail }}</small></span>
              </article>
            </div>
          </section>

          <section class="survival-drawer-block">
            <div class="drawer-subheading">
              <h3>身体与伤口</h3>
              <span>疼痛 {{ Math.round(game.body?.pain ?? 0) }} · 感染 {{ Math.round(game.body?.infectionLevel ?? 0) }}%</span>
            </div>
            <p v-if="!game.woundList.length" class="survival-empty-state">没有可见伤口。</p>
            <article v-for="wound in game.woundList" :key="wound.id" class="wound-card">
              <div>
                <strong>{{ wound.bodyPartLabel }} · {{ wound.typeLabel }}</strong>
                <small>{{ wound.source }} · 严重度 {{ wound.severity.toFixed(1) }}</small>
              </div>
              <div class="wound-tags">
                <span v-if="wound.bleeding" class="danger">流血</span>
                <span v-if="wound.bandaged" class="good">已包扎</span>
                <span v-if="wound.disinfected" class="good">已消毒</span>
                <span v-if="wound.infected" class="warn">伤口感染</span>
                <span v-if="wound.knoxInfection" class="danger">疑似 Knox 感染</span>
              </div>
            </article>
          </section>

          <section class="survival-drawer-block">
            <div class="drawer-subheading">
              <h3>基地</h3>
              <span>{{ game.isAtHome ? '当前位于据点' : '远离据点' }}</span>
            </div>
            <dl class="base-status-grid">
              <div><dt>避难所</dt><dd>{{ game.shelter?.name ?? '无' }}</dd></div>
              <div><dt>防御</dt><dd>{{ Math.round(game.base?.defense ?? 0) }}</dd></div>
              <div><dt>路障</dt><dd>{{ game.base?.barricades ?? 0 }}</dd></div>
              <div><dt>发电机</dt><dd>{{ game.base?.generatorOn ? `运行 · 燃料 ${game.base?.generatorFuel ?? 0}` : '关闭' }}</dd></div>
              <div><dt>储水</dt><dd>{{ game.base?.waterReserve ?? 0 }}</dd></div>
            </dl>
            <div class="base-action-grid">
              <div>
                <button class="secondary" :disabled="Boolean(generatorDisabledReason)" @click="toggleBaseGenerator">
                  {{ game.base?.generatorOn ? '关闭发电机' : '启动发电机' }}
                </button>
                <small>{{ generatorDisabledReason || (game.base?.generatorOn ? '停止噪声并切回公共电网状态' : '恢复供电，但会制造持续噪声') }}</small>
              </div>
              <div>
                <button class="secondary" :disabled="Boolean(baseWaterDisabledReason)" @click="drinkStoredWater">饮用储水</button>
                <small>{{ baseWaterDisabledReason || '消耗 1 份储水并降低口渴' }}</small>
              </div>
            </div>
          </section>

          <section class="survival-drawer-block">
            <div class="drawer-subheading">
              <h3>制作</h3>
              <span>{{ game.recipeList.filter((recipe) => recipe.canCraft).length }} 项可制作</span>
            </div>
            <article v-for="recipe in game.recipeList" :key="recipe.id" :class="['recipe-card', { blocked: !recipe.canCraft }]">
              <div>
                <strong>{{ recipe.name }}</strong>
                <small>{{ formatDuration(recipe.minutes) }} · 产出 {{ recipe.result?.name ?? recipe.resultId }}</small>
                <p>{{ recipe.description }}</p>
                <em>{{ recipe.canCraft ? '材料与技能已满足' : recipe.missing.join(' · ') }}</em>
              </div>
              <button class="secondary" :disabled="!recipe.canCraft || game.isGameOver" @click="craftSurvivalRecipe(recipe)">制作</button>
            </article>
          </section>
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
          <div class="location-search-summary">
            <strong>{{ locationSearchProgressText }}</strong>
            <small>暂存 {{ locationStagedSpace }} 格 · 剩余 {{ locationRemainingSpace }} 格</small>
          </div>
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
              <em>{{ slot.status === 'taken' ? `暂存 · ${slot.space} 格` : '空间不足，未拿取' }}</em>
            </template>
          </button>
        </div>

        <p v-if="locationSearch.error" class="location-search-error">{{ locationSearch.error }}</p>

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
            <dd>{{ resolutionReport.timeText }}</dd>
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
            <p v-if="!resolutionReport.vitalChanges.length && !resolutionReport.woundChanges.length">状态没有明显变化。</p>
            <span
              v-for="change in resolutionReport.vitalChanges"
              :key="change.id"
              :class="['resolution-pill', change.tone]"
            >
              {{ change.label }} {{ signed(change.delta) }} → {{ change.value }}
            </span>
            <span
              v-for="change in resolutionReport.woundChanges"
              :key="change.label"
              :class="['resolution-pill', change.tone]"
            >
              {{ change.label }}
            </span>
          </section>

          <section>
            <h3>资源与环境</h3>
            <p v-if="!resolutionReport.inventoryChanges.length && !resolutionReport.tagChanges.length && !resolutionReport.vehicleChange && !resolutionReport.worldChanges.length">没有资源或环境变化。</p>
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
            <span
              v-for="change in resolutionReport.worldChanges"
              :key="change.label"
              :class="['resolution-pill', change.tone]"
            >
              {{ change.label }}
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
const selectedSearchTarget = ref(null);
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
  if (entry.section === 'character') return '可尝试交谈';
  if (entry.section === 'building') return selectedNestedSearchables.value.length ? '可展开搜索对象' : '可评估风险';
  if (entry.section === 'landmark') return selectedNestedSearchables.value.length ? '可展开搜索对象' : '已标记';
  return '已标记';
});
const selectedScenePassiveAction = computed(() => {
  const section = selectedSceneElement.value?.section;
  if (section === 'character') return '交谈';
  if (section === 'building') return '评估风险';
  return '评估入口';
});
const selectedScenePassiveResult = computed(() => {
  const entry = selectedSceneElement.value;
  if (!entry) return '';
  if (entry.section === 'character') return `${entry.name}给出了一条线索：${entry.description}`;
  if (entry.section === 'building') return `${entry.name}已纳入风险评估，进入前建议确认体力和撤退路线。`;
  return `${entry.name}已标记为当前区域的参考点，下方对象可以逐个翻找。`;
});
const selectedNestedSearchables = computed(() => nestedSearchablesForSceneElement(selectedSceneElement.value, inspectedDetail.value));
const locationHiddenSlots = computed(() => locationSearch.value?.slots.filter((slot) => slot.status === 'hidden') ?? []);
const locationSearchedSlots = computed(() => locationSearch.value?.slots.filter((slot) => slot.status !== 'hidden') ?? []);
const locationStagedSlots = computed(() => locationSearch.value?.slots.filter((slot) => slot.status === 'taken') ?? []);
const locationStagedSpace = computed(() => locationStagedSlots.value.reduce((sum, slot) => sum + slot.space, 0));
const locationRemainingSpace = computed(() => Math.max(0, game.remainingSpace - locationStagedSpace.value));
const locationSearchProgressText = computed(() => {
  if (!locationSearch.value) return '';
  return `${locationSearchedSlots.value.length}/${locationSearch.value.slots.length}`;
});
const canSearchAllLocationSlots = computed(() => Boolean(locationSearch.value && locationHiddenSlots.value.length && !locationSearch.value.searchingSlotId));
const noiseLabel = computed(() => signalLabel(game.world?.noise, ['安静', '可闻', '嘈杂', '刺耳']));
const threatLabel = computed(() => signalLabel(game.world?.threat, ['零散', '游荡', '聚集', '逼近']));
const evacuationStatus = computed(() => {
  const atEvacuation = ['valley_checkpoint', 'louisville_outskirts'].includes(game.currentNodeId);
  if (game.isVictory) return '已进入撤离区，救援正在接应';
  if (game.day < game.maxDay) {
    return `${atEvacuation ? '已抵达撤离区' : '向谷地检查点/外环推进'} · 窗口还有 ${game.maxDay - game.day} 天`;
  }
  if (game.day <= game.evacuationDeadline) {
    return `${atEvacuation ? '已抵达撤离区' : '撤离窗口开放'} · 剩 ${game.evacuationDeadline - game.day + 1} 天`;
  }
  return '撤离窗口已经关闭';
});
const generatorDisabledReason = computed(() => {
  if (game.isGameOver) return '本局已经结束';
  if (!game.isAtHome) return '需要返回初始据点';
  if (!game.inventory.some((item) => item.id === 'generator' && item.count > 0)) return '背包中没有发电机';
  const knowsGenerator = game.inventory.some((item) => item.id === 'how_to_use_generators' && item.count > 0)
    || (game.skills.electrical ?? 0) >= 3;
  if (!knowsGenerator) return '需要《如何使用发电机》或电工 3';
  if (!game.base?.generatorOn && (game.base?.generatorFuel ?? 0) <= 0 && !game.inventory.some((item) => item.id === 'gas_can' && item.count > 0)) {
    return '需要一桶汽油';
  }
  return '';
});
const baseWaterDisabledReason = computed(() => {
  if (game.isGameOver) return '本局已经结束';
  if (!game.isAtHome) return '需要返回初始据点';
  if ((game.base?.waterReserve ?? 0) <= 0) return '据点没有储水';
  return '';
});
const recentMapLog = computed(() => game.mapLog.slice(0, 5));
const vehicleLabel = computed(() => game.vehicle?.name ?? '徒步');
const vehicleStatusLabel = computed(() => {
  if (game.vehicle?.status === 'working') return '可用';
  if (game.vehicle?.status === 'damaged') return '受损';
  return '无车';
});
const drawerTitle = computed(() => {
  if (activeDrawer.value === 'inventory') return { kicker: 'BAG / STATUS', title: '背包与状态' };
  if (activeDrawer.value === 'survival') return { kicker: 'SURVIVAL / BODY / BASE', title: '生存管理' };
  if (activeDrawer.value === 'skills') return { kicker: 'SKILLS / TRAITS', title: '技能与特性' };
  if (activeDrawer.value === 'log') return { kicker: 'MAP LOG', title: '记录' };
  return {
    kicker: 'NODE DETAIL',
    title: canShowInspectedDetail.value ? inspectedNode.value?.name ?? '地点详情' : '???',
  };
});
const moveConsequenceText = computed(() => {
  const usingVehicle = game.vehicle?.status !== 'none' && (game.vehicle?.fuel ?? 0) > 0;
  const moveMinutes = game.vehicle?.status === 'working' && usingVehicle ? 60 : game.vehicle?.status === 'damaged' && usingVehicle ? 90 : 180;
  const vehicleText = usingVehicle ? `消耗 1 燃料，耗时 ${formatDuration(moveMinutes)}` : `徒步耗时 ${formatDuration(moveMinutes)}`;
  return `${vehicleText}，期间会推进生理需求并结算区域风险`;
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
    selectedSearchTarget.value = null;
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
  selectedSearchTarget.value = null;
  sceneInspectFeedback.value = '';
}

function selectSearchTarget(entry) {
  selectedSearchTarget.value = { ...entry };
  sceneInspectFeedback.value = '';
}

function openLocationSearch(searchable = selectedSearchTarget.value) {
  if (!searchable) return;
  if (inspectedNode.value?.id !== currentNode.value?.id) {
    sceneInspectFeedback.value = '需要先移动到这个节点，才能搜索这里。';
    return;
  }
  if (isSearchableSpent(searchable)) {
    sceneInspectFeedback.value = '这里已经被你翻过一遍，继续搜只会浪费时间。';
    return;
  }
  locationSearch.value = {
    searchKey: searchKeyFor(searchable),
    searchable: { ...searchable },
    nodeId: currentNode.value.id,
    slots: createLocationSearchSlots(searchable, currentNode.value),
    searchingSlotId: null,
    started: false,
    error: '',
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

function canUseInventoryItem(item) {
  return ['food', 'medical', 'morale'].includes(item?.category);
}

function isWeapon(item) {
  return Boolean(item?.tags?.includes('weapon'));
}

function useInventoryItem(item) {
  const before = captureGameSnapshot();
  if (!game.useItem(item.id)) return;
  showResolutionReport(before, {
    title: `使用 ${item.name}`,
    result: `${item.name}已经使用，身体与背包状态已更新。`,
  });
}

function toggleWeapon(item) {
  game.equipWeapon(item.id);
}

function craftSurvivalRecipe(recipe) {
  const before = captureGameSnapshot();
  if (!game.craftRecipe(recipe.id)) return;
  showResolutionReport(before, {
    title: `制作 ${recipe.name}`,
    result: `制作完成：${recipe.result?.name ?? recipe.resultId}。`,
  });
}

function toggleBaseGenerator() {
  const wasOn = Boolean(game.base?.generatorOn);
  const before = captureGameSnapshot();
  if (!game.toggleGenerator()) return;
  showResolutionReport(before, {
    title: wasOn ? '关闭发电机' : '启动发电机',
    result: wasOn ? '发电机已经停止，持续噪声随之下降。' : '据点恢复供电，但发电机噪声会吸引附近尸群。',
  });
}

function drinkStoredWater() {
  const before = captureGameSnapshot();
  if (!game.drinkBaseWater()) return;
  showResolutionReport(before, {
    title: '饮用据点储水',
    result: '你喝掉一份储水，缓解了口渴。',
  });
}

async function searchLocationSlot(slot) {
  if (!locationSearch.value || locationSearch.value.searchingSlotId || slot.status !== 'hidden') return;
  slot.status = 'searching';
  locationSearch.value.searchingSlotId = slot.id;
  locationSearch.value.started = true;
  locationSearch.value.error = '';
  await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
  const item = lootItem(slot);
  const staged = Boolean(item && item.space <= locationRemainingSpace.value);
  slot.status = staged ? 'taken' : 'revealed';
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
  locationSearch.value.error = '';
  await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
  let remainingSpace = locationRemainingSpace.value;
  slots.forEach((slot) => {
    if (slot.status !== 'searching') return;
    const item = lootItem(slot);
    const staged = Boolean(item && item.space <= remainingSpace);
    if (staged) remainingSpace -= item.space;
    slot.status = staged ? 'taken' : 'revealed';
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
  const resolved = game.resolveSceneSearch(search.searchable, collectedItems, search.searchKey);
  if (!resolved) {
    search.error = '搜索结算失败：地点状态已经变化或当前无法执行搜索。请保留窗口并重试。';
    return;
  }
  locationSearch.value = null;
  selectedSearchTarget.value = null;
  showResolutionReport(search.initialSnapshot, { title: `搜索 ${search.searchable.name}` });
}

function nestedSearchablesForSceneElement(parent, detail) {
  if (!parent || !['landmark', 'building'].includes(parent.section)) return [];
  if (Array.isArray(parent.searchables) && parent.searchables.length) {
    return parent.searchables.map((entry) => normalizeNestedSearchable(entry, parent));
  }

  const directMatches = (detail?.searchables ?? [])
    .filter((entry) => searchableMatchesParent(entry, parent))
    .map((entry) => normalizeNestedSearchable(entry, parent));
  const generated = generatedSearchablesForParent(parent);
  const merged = [...directMatches, ...generated];
  const seen = new Set();
  return merged.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(0, parent.section === 'landmark' ? 3 : 2);
}

function normalizeNestedSearchable(entry, parent) {
  return {
    id: entry.id || `${parent.id}_${slugify(entry.name)}`,
    name: entry.name,
    assetId: entry.assetId || parent.assetId || 'tile_locker',
    quality: entry.quality || qualityForSceneParent(parent),
    description: entry.description || `${parent.name}里还有一处可以翻找的角落。`,
    parentId: parent.id,
    parentName: parent.name,
  };
}

function searchableMatchesParent(searchable, parent) {
  const text = `${parent.name} ${parent.description ?? ''} ${parent.assetId ?? ''}`.toLowerCase();
  const target = `${searchable.name} ${searchable.description ?? ''} ${searchable.assetId ?? ''}`.toLowerCase();
  return text.split(/\s+/).some((part) => part.length >= 3 && target.includes(part))
    || parent.assetId === searchable.assetId
    || target.includes(parent.name.toLowerCase().slice(0, 2));
}

function generatedSearchablesForParent(parent) {
  const text = `${parent.name} ${parent.description ?? ''} ${parent.assetId ?? ''}`.toLowerCase();
  const quality = qualityForSceneParent(parent);
  const make = (suffix, name, assetId, description, tierShift = 0) => ({
    id: `${parent.id}_${suffix}`,
    name,
    assetId,
    quality: shiftedQuality(quality, tierShift),
    description,
    parentId: parent.id,
    parentName: parent.name,
  });

  if (/药|医|诊|hospital|clinic|medical|med/.test(text)) {
    return [
      make('medicine_cabinet', '药柜', 'tile_medical', '药品、绷带和消毒用品集中。', 1),
      make('first_aid_case', '急救箱', 'tile_medical', '急救包、止痛药和β受体阻滞剂。'),
    ];
  }
  if (/警|枪|弹|gun|police|ammo|cruiser/.test(text)) {
    return [
      make('duty_locker', '值班储物柜', 'tile_locker', '弹药、手电和钥匙线索。', 1),
      make('desk_drawer', '办公桌抽屉', 'tile_police', '文件、地图碎片和少量警用补给。'),
    ];
  }
  if (/消防|斧|fire/.test(text)) {
    return [
      make('axe_locker', '斧头柜', 'tile_fire', '消防斧、手斧和防护装备。', 1),
      make('tool_wall', '工具墙', 'tile_locker', '喷灯、胶带和维修工具。'),
    ];
  }
  if (/餐|厨|食|饮|罐头|冰柜|杂货|store|restaurant|kitchen|pantry|shelf|shop/.test(text)) {
    return [
      make('shelf', '货架', 'tile_store', '罐头、饮料、零食和香烟。'),
      make('counter', '柜台抽屉', 'tile_store', '电池、胶带和轻量补给。'),
      make('freezer', '后厨冰柜', 'tile_restaurant', '短期食物和饮料。', 1),
    ];
  }
  if (/加油|燃油|车辆|后备箱|车|gas|fuel|trunk|wreck|vehicle/.test(text)) {
    return [
      make('pump', '加油泵', 'tile_gas', '汽油桶、车钥匙和电池线索。', 1),
      make('trunk', '后备箱', 'tile_wreck', '工具、背包和散装食物。'),
    ];
  }
  if (/仓|工具|车库|柜|箱|托盘|warehouse|locker|crate|storage|garage|shed/.test(text)) {
    return [
      make('rack', '工具架', 'tile_locker', '锤子、锯子、扳手和胶带。'),
      make('crate', '木箱', 'tile_warehouse', '木板、钉子和基地材料。'),
      make('pallet', '托盘堆', 'tile_warehouse', '大件工具和维修材料。', 1),
    ];
  }
  if (/学校|教室|school|book/.test(text)) {
    return [
      make('locker', '储物柜', 'tile_school', '背包、书本和基础药品。'),
      make('office', '办公室柜', 'tile_locker', '地图、文具和电池。'),
    ];
  }
  if (/农|种子|园艺|钓|河|farm|seed|fishing|camp|river/.test(text)) {
    return [
      make('supply_box', '补给箱', 'tile_camp', '水瓶、手电和野外工具。'),
      make('tool_bin', '农具箱', 'tile_farm', '种子、小铲子和钓具。'),
    ];
  }
  if (/公寓|民宅|旅馆|拖车|住宅|house|apartment|motel|trailer|home/.test(text)) {
    return [
      make('kitchen', '厨房柜', 'tile_house', '食物、饮水和轻药品。'),
      make('bedroom', '卧室抽屉', 'tile_apartment', '背包、衣物和电池。'),
    ];
  }
  return [
    make('container', `${parent.name}储物箱`, parent.assetId || 'tile_locker', '能翻到少量通用补给。'),
    make('drawer', `${parent.name}抽屉`, 'tile_locker', '小件工具、食物或药品。'),
  ];
}

function qualityForSceneParent(parent) {
  if (parent.quality) return parent.quality;
  if (parent.risk === '极高') return 'red';
  if (parent.risk === '高') return 'purple';
  if (parent.risk === '中') return 'blue';
  if (parent.risk === '低') return 'green';
  return parent.section === 'landmark' ? 'blue' : 'green';
}

function shiftedQuality(quality, shift = 0) {
  const order = ['white', 'green', 'blue', 'purple', 'gold', 'red'];
  const index = Math.max(0, order.indexOf(quality));
  return order[Math.max(0, Math.min(order.length - 1, index + shift))];
}

function searchKeyFor(searchable) {
  return `${currentNode.value?.id ?? 'unknown'}:${searchable.id}`;
}

function isSearchableSpent(searchable) {
  return Boolean(searchable && game.searchedSceneObjectIds?.includes(searchKeyFor(searchable)));
}

function searchButtonTextFor(searchable) {
  if (inspectedNode.value?.id !== currentNode.value?.id) return '到达后搜索';
  if (isSearchableSpent(searchable)) return '已经搜过';
  return '搜索这里';
}

function slugify(value = '') {
  return `${value}`.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '') || 'searchable';
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
  const searchKey = searchKeyFor(searchable);
  const rng = createSearchRandom(game.world?.seed, searchKey);
  const guaranteedItem = pickLocationSearchItem(searchable, node, quality, rng);
  if (guaranteedItem) slots.push(createLocationSearchSlot(guaranteedItem, slots.length, searchable, 'marked'));
  let attempts = 0;
  while (slots.length < targetCount && attempts < targetCount * 30) {
    attempts += 1;
    const tier = pickLocationLootTier(rng);
    const item = pickLocationSearchItem(searchable, node, tier, rng);
    if (item) slots.push(createLocationSearchSlot(item, slots.length, searchable, 'random'));
  }
  return slots;
}

function createLocationSearchSlot(item, index, searchable, source) {
  return {
    id: `area-${searchable.id}-${index}-${item.id}`,
    itemId: item.id,
    status: 'hidden',
    space: item.space,
    footprint: footprintForSpace(item.space),
    tier: item.tier,
    source,
  };
}

function createSearchRandom(worldSeed, searchKey) {
  const normalizedSeed = Number.isFinite(Number(worldSeed)) ? Math.trunc(Number(worldSeed)) : 0;
  const input = `${normalizedSeed}:${searchKey}`;
  let state = (2166136261 ^ (normalizedSeed >>> 0)) >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    state ^= input.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pickLocationLootTier(rng) {
  const totalWeight = lootTierWeights.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
  for (const entry of lootTierWeights) {
    roll -= entry.weight;
    if (roll < 0) return entry.tier;
  }
  return lootTierWeights[lootTierWeights.length - 1].tier;
}

function pickLocationSearchItem(searchable, node, tier, rng) {
  const candidates = marketItems.filter((item) => item.tier === tier);
  const pool = candidates.length ? candidates : marketItems;
  const weighted = pool.map((item) => ({ item, weight: locationItemWeight(item, searchable, node) }));
  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * totalWeight;
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
    clockMinutes: game.clockMinutes,
    clockLabel: game.clockLabel,
    vitals: { ...game.vitals },
    inventory: Object.fromEntries(game.inventory.map((item) => [item.id, { count: item.count, name: item.name }])),
    hiddenTags: [...game.hiddenTags],
    vehicle: { ...game.vehicle },
    world: { ...game.world },
    body: {
      ...game.body,
      wounds: game.woundList.map((wound) => ({ ...wound })),
    },
    base: { ...game.base },
    stats: { ...game.survivalStats },
    equippedWeaponId: game.equippedWeaponId,
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
  const elapsedMinutes = Math.max(0, (after.day - before.day) * 24 * 60 + (after.clockMinutes - before.clockMinutes));
  return {
    title: context.title ?? latestHistory?.title ?? latestMapLog?.title ?? '行动结算',
    result: context.result ?? latestHistory?.result ?? latestMapLog?.text ?? '行动已经结算。',
    notes: context.notes ?? latestHistory?.notes ?? latestMapLog?.text ?? '',
    dayText: after.day === before.day ? `第 ${after.day} 天` : `第 ${before.day} 天 → 第 ${after.day} 天`,
    timeText: `第 ${before.day} 天 ${before.clockLabel} → 第 ${after.day} 天 ${after.clockLabel}（${formatDuration(elapsedMinutes)}）`,
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
    woundChanges: woundDiff(before.body, after.body),
    inventoryChanges: inventoryDiff(before.inventory, after.inventory),
    tagChanges: tagDiff(before.hiddenTags, after.hiddenTags),
    vehicleChange: vehicleDiff(before.vehicle, after.vehicle),
    worldChanges: worldDiff(before, after),
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

function woundDiff(before = {}, after = {}) {
  const beforeWounds = before.wounds ?? [];
  const afterWounds = after.wounds ?? [];
  const beforeById = new Map(beforeWounds.map((wound) => [wound.id, wound]));
  const afterById = new Map(afterWounds.map((wound) => [wound.id, wound]));
  const changes = [];
  afterWounds.forEach((wound) => {
    const previous = beforeById.get(wound.id);
    const label = `${wound.bodyPartLabel ?? wound.bodyPart} ${wound.typeLabel ?? wound.type}`;
    if (!previous) {
      changes.push({ label: `新增伤口：${label}`, tone: 'bad' });
      return;
    }
    if (!previous.bandaged && wound.bandaged) changes.push({ label: `已包扎：${label}`, tone: 'good' });
    if (!previous.disinfected && wound.disinfected) changes.push({ label: `已消毒：${label}`, tone: 'good' });
    if (!previous.infected && wound.infected) changes.push({ label: `伤口感染：${label}`, tone: 'bad' });
    if ((wound.severity ?? 0) < (previous.severity ?? 0)) changes.push({ label: `伤势缓解：${label}`, tone: 'good' });
  });
  beforeWounds.forEach((wound) => {
    if (!afterById.has(wound.id)) changes.push({ label: `伤口恢复：${wound.bodyPartLabel ?? wound.bodyPart} ${wound.typeLabel ?? wound.type}`, tone: 'good' });
  });
  const infectionDelta = Math.round((after.infectionLevel ?? 0) - (before.infectionLevel ?? 0));
  if (infectionDelta) changes.push({ label: `感染 ${signed(infectionDelta)} → ${Math.round(after.infectionLevel ?? 0)}%`, tone: infectionDelta > 0 ? 'bad' : 'good' });
  const painDelta = Math.round((after.pain ?? 0) - (before.pain ?? 0));
  if (painDelta) changes.push({ label: `疼痛 ${signed(painDelta)} → ${Math.round(after.pain ?? 0)}`, tone: painDelta > 0 ? 'bad' : 'good' });
  return changes;
}

function worldDiff(before, after) {
  const changes = [];
  const addNumeric = (label, beforeValue, afterValue, positiveIsBad = true) => {
    const delta = Math.round((afterValue ?? 0) - (beforeValue ?? 0));
    if (!delta) return;
    const bad = positiveIsBad ? delta > 0 : delta < 0;
    changes.push({ label: `${label} ${signed(delta)} → ${Math.round(afterValue ?? 0)}`, tone: bad ? 'bad' : 'good' });
  };
  addNumeric('尸群威胁', before.world?.threat, after.world?.threat);
  addNumeric('噪声', before.world?.noise, after.world?.noise);
  addNumeric('击杀', before.stats?.zombiesKilled, after.stats?.zombiesKilled, false);
  addNumeric('基地防御', before.base?.defense, after.base?.defense, false);
  addNumeric('路障', before.base?.barricades, after.base?.barricades, false);
  addNumeric('储水', before.base?.waterReserve, after.base?.waterReserve, false);
  if (before.world?.powerOn !== after.world?.powerOn) changes.push({ label: after.world?.powerOn ? '电力恢复' : '电力中断', tone: after.world?.powerOn ? 'good' : 'bad' });
  if (before.world?.waterOn !== after.world?.waterOn) changes.push({ label: after.world?.waterOn ? '供水恢复' : '供水中断', tone: after.world?.waterOn ? 'good' : 'bad' });
  if (before.base?.generatorOn !== after.base?.generatorOn) changes.push({ label: after.base?.generatorOn ? '发电机启动' : '发电机关闭', tone: after.base?.generatorOn ? 'warn' : 'good' });
  if (before.equippedWeaponId !== after.equippedWeaponId) {
    changes.push({ label: `主手：${game.equippedWeapon?.name ?? '徒手'}`, tone: 'good' });
  }
  return changes;
}

function closeResolutionReport() {
  resolutionReport.value = null;
  if (game.isGameOver) router.push('/ending');
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function formatDuration(minutes = 0) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function signalLabel(value = 0, labels = []) {
  const number = Math.max(0, Math.min(100, Number(value) || 0));
  return labels[number >= 75 ? 3 : number >= 50 ? 2 : number >= 25 ? 1 : 0] ?? '';
}

function worldSignalTone(value = 0) {
  const number = Number(value) || 0;
  return number >= 70 ? 'danger' : number >= 45 ? 'warn' : 'good';
}

function moodleIcon(id) {
  return {
    hungry: '◒',
    thirsty: '◇',
    tired: '☾',
    pain: '✚',
    infection: '☣',
    wet: '☂',
    encumbered: '▣',
    horde: '!',
  }[id] ?? '•';
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
  return '低风险不代表安全。移动仍会推进时间，并结算饥饿、口渴、疲劳和区域压力。';
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
