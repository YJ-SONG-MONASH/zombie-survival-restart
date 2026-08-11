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

    <main :class="['map-playfield', { 'tactical-drawer-open': tacticalModeVisible && activeDrawer === 'survival' }]">
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

      <aside :class="['map-quick-panel', { 'has-active-encounter': encounterActive || tacticalModeVisible, 'has-tactical-encounter': tacticalModeVisible }]">
        <p class="panel-kicker">CURRENT NODE</p>
        <h2>{{ currentNode?.name ?? '未定位' }}</h2>
        <div class="node-meta-row">
          <span>{{ currentNodeType?.label ?? '未知类型' }}</span>
          <span>风险 {{ dangerStars(currentNode?.danger) }}</span>
        </div>
        <div
          :class="['local-zombie-strip', `tone-${localZombieTone}`, { 'encounter-active': encounterActive }]"
          role="status"
          aria-live="polite"
        >
          <b>{{ encounterActive ? '!' : currentNodeSecured ? '✓' : '☣' }}</b>
          <span>
            <strong>{{ localZombieHeadline }}</strong>
            <small>{{ localZombieDetail }}</small>
          </span>
        </div>
        <p>{{ currentNode?.description ?? '地图尚未初始化。' }}</p>
        <div v-if="tacticalModeVisible" class="tactical-quick-summary" role="status" aria-live="polite">
          <span>
            <strong>{{ tacticalSummary.label }}</strong>
            <small>{{ tacticalSummary.remainingZombies }} 只剩余 · {{ tacticalPressureLabel }}</small>
          </span>
          <button class="map-action-chip tactical-open-button" @click="openTacticalDrawer">
            <strong>打开战术</strong>
            <small>回合 {{ tacticalSummary.turn }}</small>
          </button>
        </div>
        <div v-else class="quick-action-row">
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
        <button
          :class="['storage-drawer-tab', { active: activeDrawer === 'inventory' }]"
          :aria-label="game.storageWarningCount ? `物资，${game.storageWarningCount} 项腐败或损坏警告` : '物资'"
          @click="toggleDrawer('inventory')"
        >
          物资
          <b v-if="game.storageWarningCount" class="storage-warning-badge" aria-hidden="true">{{ Math.min(99, game.storageWarningCount) }}</b>
        </button>
        <button :class="[{ active: activeDrawer === 'survival' }, { 'tactical-tab': tacticalModeVisible }]" @click="toggleDrawer('survival')">
          {{ tacticalModeVisible ? '战术' : '生存' }}
        </button>
        <button :class="{ active: activeDrawer === 'skills' }" @click="toggleDrawer('skills')">技能</button>
        <button :class="{ active: activeDrawer === 'log' }" @click="toggleDrawer('log')">记录</button>
      </nav>

      <aside
        v-if="activeDrawer"
        :class="[
          'map-side-drawer',
          {
            'inventory-storage-drawer': activeDrawer === 'inventory',
            'tactical-encounter-drawer': activeDrawer === 'survival' && tacticalModeVisible,
            'tactical-sheet-expanded': tacticalSheetExpanded,
          },
        ]"
      >
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
              <span v-else-if="encounterActive">尸群封住了出口，先清场或成功绕行。</span>
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
                    :disabled="!selectedSearchTarget || Boolean(sceneSearchDisabledReason(selectedSearchTarget))"
                    @click="openLocationSearch(selectedSearchTarget)"
                  >
                    {{ selectedSearchTarget ? sceneSearchDisabledReason(selectedSearchTarget) || searchButtonTextFor(selectedSearchTarget) : '选择一个对象' }}
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

        <section v-else-if="activeDrawer === 'inventory'" class="drawer-section inventory-storage-section">
          <div class="vehicle-strip drawer-vehicle-strip">
            <span>交通：{{ vehicleLabel }}</span>
            <span>燃料 {{ game.vehicle?.fuel ?? 0 }}</span>
            <span>状态 {{ vehicleStatusLabel }}</span>
          </div>

          <div class="storage-equipment-strip">
            <span>主手 <strong>{{ game.equippedWeapon?.name ?? '徒手' }}</strong></span>
            <span>背包 <strong>{{ game.equippedBag?.name ?? '无' }}</strong></span>
            <span v-if="game.storageWarningCount" class="danger">{{ game.storageWarningCount }} 项物资需要处理</span>
          </div>

          <p v-if="encounterActive" class="drawer-encounter-warning">遭遇中只能更换随身武器；清场或成功绕行后才能使用、维修和转移物资。</p>

          <nav class="storage-container-selector" aria-label="选择地点容器">
            <button
              v-for="container in externalStorageContainers"
              :key="container.id"
              :class="[{ active: selectedExternalContainer?.id === container.id, blocked: !container.accessible }]"
              :aria-pressed="selectedExternalContainer?.id === container.id"
              @click="selectExternalStorageContainer(container.id)"
            >
              <strong>{{ container.name }}</strong>
              <span>{{ formatStorageSpace(container) }}</span>
              <small>{{ container.accessible ? container.preservationLabel : container.accessReason }}</small>
            </button>
          </nav>

          <div class="storage-route-bar" aria-label="当前转移路线">
            <button
              :class="['storage-route-button', { active: activeStoragePaneId === 'carry' }]"
              :aria-pressed="activeStoragePaneId === 'carry'"
              @click="activateStoragePane('carry')"
            >
              <small>随身</small>
              <strong>{{ carryStorageContainer?.name ?? '随身背包' }}</strong>
              <span>{{ formatStorageSpace(carryStorageContainer) }}</span>
            </button>
            <b class="storage-route-arrow" aria-hidden="true">⇄</b>
            <button
              :class="['storage-route-button', { active: activeStoragePaneId === selectedExternalContainer?.id, blocked: !selectedExternalContainer?.accessible }]"
              :aria-pressed="activeStoragePaneId === selectedExternalContainer?.id"
              @click="activateStoragePane(selectedExternalContainer?.id)"
            >
              <small>当前容器</small>
              <strong>{{ selectedExternalContainer?.name ?? '没有容器' }}</strong>
              <span>{{ formatStorageSpace(selectedExternalContainer) }}</span>
            </button>
          </div>

          <p v-if="storageActionFeedback" class="storage-action-feedback" role="status" aria-live="polite">{{ storageActionFeedback }}</p>

          <div class="storage-workspace">
            <article
              v-for="container in visibleStoragePanes"
              :key="container.id"
              :class="[
                'storage-pane',
                `storage-pane-${container.id}`,
                { 'mobile-active': activeStoragePaneId === container.id, inaccessible: !container.accessible },
              ]"
            >
              <header class="storage-pane-header">
                <div>
                  <small>{{ container.id === 'carry' ? 'PLAYER INVENTORY' : 'WORLD CONTAINER' }}</small>
                  <h3>{{ container.name }}</h3>
                </div>
                <strong :class="storageCapacityTone(container)">{{ formatStorageSpace(container) }}</strong>
              </header>
              <progress
                class="inventory-capacity-meter"
                :class="storageCapacityTone(container)"
                :value="container.usedSpace"
                :max="Math.max(1, container.capacity)"
                :aria-label="`${container.name}容量 ${formatStorageSpace(container)}`"
              ></progress>
              <p class="storage-preservation-line">{{ container.preservationLabel }}</p>

              <p v-if="!container.accessible" class="storage-access-warning">
                <b>当前不可访问</b>
                <span>{{ container.accessReason || '需要先满足容器访问条件' }}</span>
              </p>
              <p v-else-if="!container.items.length" class="storage-empty-state">这个容器是空的。</p>
              <ul v-else class="map-inventory-list storage-item-list">
                <li
                  v-for="item in container.items"
                  :key="item.stackId"
                  :class="[
                    { equipped: isStorageItemEquipped(item), selected: isStorageItemSelected(container, item) },
                    itemConditionDisplay(item) ? `tone-${itemConditionDisplay(item).tone}` : '',
                  ]"
                >
                  <button
                    class="storage-item-select"
                    :aria-pressed="isStorageItemSelected(container, item)"
                    @click="selectStorageItem(container, item)"
                  >
                    <span class="item-icon inventory-icon" aria-hidden="true">
                      <img :src="itemIconSrc(item)" :alt="item.name" @error="markInventoryIconMissing" />
                      <span></span>
                    </span>
                    <span class="storage-item-copy">
                      <span class="storage-item-title">
                        <strong>{{ item.name }}</strong>
                        <b>x{{ item.count }}</b>
                      </span>
                      <small>{{ item.space }} 格/件 · {{ itemCategoryLabel(item) }}</small>
                      <span v-if="itemConditionDisplay(item)" :class="['item-condition-strip', `tone-${itemConditionDisplay(item).tone}`]">
                        <span><b>{{ itemConditionDisplay(item).label }}</b><small>{{ itemConditionDisplay(item).detail }}</small></span>
                        <progress
                          v-if="Number.isFinite(itemConditionDisplay(item).percent)"
                          :value="itemConditionDisplay(item).percent"
                          max="100"
                          :aria-label="`${item.name}${itemConditionDisplay(item).label} ${itemConditionDisplay(item).percent}%`"
                        ></progress>
                      </span>
                    </span>
                  </button>

                  <div class="storage-item-actions">
                    <button
                      v-if="supportsItemUse(item)"
                      class="secondary"
                      :disabled="!item.canUse"
                      @click="useStorageItem(item)"
                    >{{ itemUseLabel(item) }}</button>
                    <button
                      v-if="isWeapon(item) || isBag(item)"
                      class="secondary"
                      :disabled="!canEquipStorageItem(item)"
                      @click="toggleStorageEquipment(item)"
                    >{{ itemEquipLabel(item) }}</button>
                    <button
                      v-if="isWeapon(item) && item.condition"
                      class="secondary"
                      :disabled="Boolean(itemRepairDisabledReason(item, container))"
                      @click="toggleRepairPicker(item)"
                    >{{ repairStackId === item.stackId ? '收起维修' : '维修' }}</button>
                  </div>

                  <div v-if="repairStackId === item.stackId" class="repair-material-picker">
                    <span>选择维修材料</span>
                    <button
                      v-for="material in repairMaterials"
                      :key="material.id"
                      class="secondary"
                      :disabled="Boolean(itemRepairDisabledReason(item, container)) || material.count < 1"
                      @click="repairStorageWeapon(item, material.id)"
                    >{{ material.name }} ×{{ material.count }}</button>
                  </div>

                  <ul v-if="storageItemDisabledReasons(item, container).length" class="storage-disabled-reasons">
                    <li v-for="reason in storageItemDisabledReasons(item, container)" :key="reason">{{ reason }}</li>
                  </ul>
                </li>
              </ul>
            </article>
          </div>

          <section v-if="selectedStorageItem && selectedStorageSource && transferDestination" class="storage-transfer-tray">
            <header>
              <span>
                <small>SELECTED STACK</small>
                <strong>{{ selectedStorageItem.name }} ×{{ selectedStorageItem.count }}</strong>
              </span>
              <button class="storage-selection-close" aria-label="取消选择物资" @click="clearStorageSelection">×</button>
            </header>
            <p>{{ selectedStorageSource.name }} → {{ transferDestination.name }}</p>
            <div class="storage-transfer-controls">
              <div class="transfer-stepper" aria-label="转移数量">
                <button :disabled="normalizedTransferQuantity <= 1" aria-label="减少转移数量" @click="adjustTransferQuantity(-1)">−</button>
                <input
                  v-model.number="transferQuantity"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  :max="Math.max(1, transferMaxQuantity)"
                  aria-label="转移数量"
                  @change="clampTransferQuantity"
                />
                <button :disabled="normalizedTransferQuantity >= Math.max(1, transferMaxQuantity)" aria-label="增加转移数量" @click="adjustTransferQuantity(1)">+</button>
                <button :disabled="transferMaxQuantity < 1" @click="setMaximumTransferQuantity">最多 {{ transferMaxQuantity }}</button>
              </div>
              <button class="primary-action storage-transfer-button" :disabled="Boolean(transferDisabledReason)" @click="commitStorageTransfer">
                {{ transferActionLabel }} ×{{ normalizedTransferQuantity }}
              </button>
            </div>
            <small v-if="transferDisabledReason" class="storage-transfer-reason">{{ transferDisabledReason }}</small>
            <small v-else>最多可转移 {{ transferMaxQuantity }} 件；整理会消耗少量时间。</small>
          </section>

          <section class="storage-special-status">
            <h3>角色状态</h3>
            <p v-if="game.hiddenTags.length === 0">暂无特殊状态</p>
            <div v-else class="tag-list drawer-tag-list">
              <span v-for="tag in game.hiddenTags" :key="tag">{{ tag }}</span>
            </div>
          </section>
        </section>

        <section v-else-if="activeDrawer === 'survival'" :class="['drawer-section', 'survival-drawer-section', { 'tactical-drawer-section': tacticalModeVisible }]">
          <template v-if="tacticalModeVisible">
            <section :class="['tactical-situation-card', `tone-${tacticalSummary.tone}`]">
              <div class="drawer-subheading tactical-situation-heading">
                <div>
                  <p class="panel-kicker">{{ tacticalNodeName }}</p>
                  <h3>{{ tacticalSummary.label }}</h3>
                </div>
                <span>{{ tacticalStatusLabel }}</span>
              </div>
              <div class="tactical-bucket-grid" aria-label="尸群距离分布">
                <article v-for="bucket in tacticalBuckets" :key="bucket.id" :class="[`bucket-${bucket.id}`, { hot: bucket.hot }]">
                  <span>{{ bucket.label }}</span>
                  <strong>{{ bucket.value }}</strong>
                </article>
              </div>
              <dl class="tactical-signal-row">
                <div><dt>威胁</dt><dd>{{ tacticalThreatLabel }}</dd></div>
                <div><dt>噪音</dt><dd>{{ tacticalNoiseLabel }}</dd></div>
                <div><dt>距离</dt><dd>{{ tacticalRangeLabel }}</dd></div>
                <div><dt>脱离</dt><dd>{{ tacticalSummary.escapeProgress }}%</dd></div>
              </dl>
            </section>

            <section class="tactical-vitals" aria-label="战斗状态">
              <article v-for="vital in tacticalVitals" :key="vital.id" :class="{ danger: vital.danger }">
                <span>{{ vital.label }}</span>
                <strong>{{ vital.value }}{{ vital.suffix }}</strong>
                <progress v-if="vital.max" :value="vital.value" :max="vital.max"></progress>
              </article>
            </section>

            <section class="tactical-weapon-section">
              <div class="drawer-subheading">
                <h3>当前主手</h3>
                <span>{{ tacticalWeapon?.name || '徒手' }}</span>
              </div>
              <article :class="['tactical-weapon-card', tacticalWeapon?.conditionTone ? `tone-${tacticalWeapon.conditionTone}` : '']">
                <div>
                  <strong>{{ tacticalWeapon?.name || '徒手' }}</strong>
                  <small>{{ tacticalWeaponConditionText }}</small>
                </div>
                <dl>
                  <div><dt>装填</dt><dd>{{ tacticalWeapon?.loadedAmmo ?? '—' }}</dd></div>
                  <div><dt>备用弹</dt><dd>{{ tacticalWeapon?.reserveAmmo ?? '—' }}</dd></div>
                </dl>
              </article>
              <div v-if="tacticalWeaponOptionsForDisplay.length > 1" class="tactical-weapon-options" aria-label="切换战术武器">
                <button
                  v-for="weapon in tacticalWeaponOptionsForDisplay"
                  :key="weapon.stackId"
                  :class="[{ active: weapon.stackId === tacticalWeapon?.stackId }, weapon.conditionTone ? `tone-${weapon.conditionTone}` : '']"
                  :disabled="weapon.disabled"
                  :title="weapon.disabledReason"
                  @click="selectTacticalWeapon(weapon)"
                >
                  <strong>{{ weapon.name }}</strong>
                  <small>{{ weapon.conditionText }}</small>
                </button>
              </div>
            </section>

            <section v-if="!tacticalTerminal" class="tactical-action-section">
              <div class="drawer-subheading">
                <h3>选择行动</h3>
                <span>{{ tacticalActions.filter((action) => !action.disabled).length }} / {{ tacticalActions.length }} 可用</span>
              </div>
              <div class="tactical-action-grid">
                <button
                  v-for="action in tacticalActions"
                  :key="action.id"
                  :class="['tactical-action-card', `tone-${action.tone}`, { blocked: action.disabled }]"
                  :disabled="action.disabled || tacticalActionBusy || game.isGameOver"
                  :title="action.disabledReason || action.description"
                  @click="performTacticalAction(action)"
                >
                  <span class="tactical-action-heading"><strong>{{ action.label }}</strong><b>{{ action.riskLabel }}</b></span>
                  <em>{{ action.estimatedOutcome }}</em>
                  <small>{{ formatDuration(action.minutes) }} · 体力 {{ action.staminaLabel }} · 噪音 {{ action.noiseLabel }}</small>
                  <i v-if="action.disabledReason">{{ action.disabledReason }}</i>
                </button>
              </div>
            </section>

            <section class="tactical-log-section" aria-live="polite">
              <div class="drawer-subheading">
                <h3>交锋记录</h3>
                <span>最近 {{ tacticalLog.length }} 条</span>
              </div>
              <p v-if="tacticalActionFeedback" :class="['tactical-action-feedback', { danger: tacticalActionFeedbackTone === 'danger' }]">{{ tacticalActionFeedback }}</p>
              <p v-if="!tacticalLog.length" class="survival-empty-state">尚未行动。先看距离、体力与退路。</p>
              <ol v-else class="tactical-log-list">
                <li v-for="entry in tacticalLog" :key="entry.id">
                  <span>{{ entry.turnLabel }}</span>
                  <p>{{ entry.text }}</p>
                </li>
              </ol>
            </section>

            <footer class="tactical-drawer-footer">
              <template v-if="tacticalTerminal">
                <button class="secondary" @click="endTacticalEncounter">结束遭遇</button>
                <button class="primary-action" @click="continueAfterTactical">继续探索</button>
              </template>
              <template v-else>
                <span>{{ tacticalFooterHint }}</span>
                <button class="tactical-sheet-toggle" @click="tacticalSheetExpanded = !tacticalSheetExpanded">
                  {{ tacticalSheetExpanded ? '收起面板' : '展开面板' }}
                </button>
              </template>
            </footer>
          </template>

          <template v-else>
          <section class="survival-drawer-block evacuation-objective-card">
            <p class="panel-kicker">EVACUATION WINDOW</p>
            <h3>第 {{ game.maxDay }}–{{ game.evacuationDeadline }} 天抵达撤离区</h3>
            <p>目标：谷地检查点或路易斯维尔外环。提前抵达可以整备，错过窗口则本局失败。</p>
            <strong>{{ evacuationStatus }}</strong>
          </section>

          <section :class="['survival-drawer-block', 'local-zombie-card', `tone-${localZombieTone}`]">
            <div class="drawer-subheading">
              <h3>本地尸群</h3>
              <span>{{ localZombieStatusLabel }}</span>
            </div>
            <div class="local-zombie-overview">
              <strong>{{ localZombiePopulationLabel }}</strong>
              <progress
                v-if="localZombieState.population !== null && localZombieState.cap !== null"
                :value="localZombieState.population"
                :max="Math.max(1, localZombieState.cap)"
              ></progress>
              <small>{{ localZombieDetail }}</small>
            </div>
            <dl class="base-status-grid local-zombie-stats">
              <div><dt>活动数量</dt><dd>{{ localZombieState.population ?? '未知' }}</dd></div>
              <div><dt>区域上限</dt><dd>{{ localZombieState.cap ?? '未知' }}</dd></div>
              <div><dt>最近清场</dt><dd>{{ localZombieState.clearedDay ? `第 ${localZombieState.clearedDay} 天` : '尚无记录' }}</dd></div>
              <div><dt>临时安全</dt><dd>{{ localZombieState.population === 0 ? '已清场' : currentNodeTemporarilySecured ? securedUntilLabel : '未建立' }}</dd></div>
            </dl>
            <div v-if="encounterActive" class="drawer-encounter-warning" role="alert">
              <b>遭遇进行中</b>
              <span>{{ encounterNodeName }} · {{ encounterPopulation }} 只正在接触，优先清场或脱离。</span>
            </div>
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
                <span v-if="wound.dirtyBandage" class="danger">绷带已脏</span>
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
                <em>{{ encounterActive ? '遭遇中无法制作' : recipe.canCraft ? '材料与技能已满足' : recipe.missing.join(' · ') }}</em>
              </div>
              <button class="secondary" :disabled="!recipe.canCraft || game.isGameOver || encounterActive" @click="craftSurvivalRecipe(recipe)">制作</button>
            </article>
          </section>
          </template>
        </section>

        <section v-else-if="activeDrawer === 'skills'" class="drawer-section skill-progress-section">
          <div class="drawer-subheading">
            <h3>技能成长</h3>
            <span>{{ skillProgressForDisplay.length }} 项</span>
          </div>
          <div class="skill-progress-list">
            <article v-for="skill in skillProgressForDisplay" :key="skill.id" class="skill-progress-card">
              <span class="skill-icon skill-progress-icon">
                <img v-if="skill.iconFile" :src="skillIconSrc(skill)" :alt="skill.canonicalName || skill.label" @error="markIconMissing" />
                <span>{{ skill.fallbackIcon }}</span>
              </span>
              <div class="skill-progress-copy">
                <div>
                  <strong>{{ skill.label }}</strong>
                  <b>Lv.{{ skill.level }}</b>
                </div>
                <progress :value="skill.progress" max="100"></progress>
                <small>
                  <span>{{ skill.xpLabel }}</span>
                  <em v-if="skill.recentGain > 0">最近 +{{ skill.recentGain }} XP</em>
                </small>
              </div>
            </article>
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

    <section
      v-if="locationSearch"
      class="move-confirm-backdrop location-search-backdrop"
      @click.self="leaveLocationSearch"
      @keydown.esc.stop.prevent="leaveLocationSearch"
    >
      <article
        ref="locationSearchDialog"
        class="location-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-search-title"
        tabindex="-1"
      >
        <header class="location-search-header">
          <div class="location-search-heading">
            <p class="panel-kicker">AREA SEARCH</p>
            <h2 id="location-search-title">搜索 {{ locationSearch.descriptor.name }}</h2>
            <span>{{ currentNode?.name }} · {{ locationSearch.descriptor.description }}</span>
          </div>
          <div class="location-search-summary" aria-label="地点物资进度">
            <strong>{{ locationSearchProgressText }}</strong>
            <span>留存 {{ locationLootSummary?.revealed ?? 0 }} 项</span>
            <small>背包剩余 {{ formatNumber(game.remainingSpace) }} 格</small>
          </div>
          <button class="location-search-close" aria-label="暂时离开地点搜索" @click="leaveLocationSearch">×</button>
        </header>

        <div class="location-search-context">
          <span>{{ locationSearchCostText }}</span>
          <strong>未带走的物资会留在这里。</strong>
        </div>

        <div class="location-search-main">
          <div v-if="locationLootSlots.length" class="loot-grid location-loot-grid" aria-label="地点物资搜索区">
            <button
              v-for="slot in locationLootSlots"
              :key="slot.slotId"
              :class="locationLootSlotClass(slot)"
              :disabled="isLocationSlotDisabled(slot)"
              :aria-pressed="slot.persistedStatus === 'revealed' ? slot.selected : undefined"
              :aria-label="locationLootAriaLabel(slot)"
              :title="locationLootTooltip(slot)"
              @click="toggleLocationLootSelection(slot)"
            >
              <template v-if="slot.status === 'hidden'">
                <span class="loot-silhouette"></span>
                <em>未翻找</em>
                <strong>未知物资</strong>
              </template>

              <template v-else-if="slot.status === 'searching'">
                <span class="search-lens">⌕</span>
                <strong>翻找中</strong>
              </template>

              <template v-else>
                <span class="item-icon">
                  <img v-if="slot.item" :src="itemIconSrc(slot.item)" :alt="slot.item.name" @error="markLocationItemIconMissing" />
                  <span>{{ slot.item?.fallbackIcon ?? '??' }}</span>
                </span>
                <span class="location-loot-copy">
                  <strong>{{ slot.item?.name ?? '未知物资' }}</strong>
                  <small v-if="(slot.item?.count ?? 1) > 1">×{{ slot.item.count }}</small>
                  <em>{{ slot.selected ? `准备带走 · ${formatNumber(slot.space)} 格` : `留在原处 · ${formatNumber(slot.space)} 格` }}</em>
                </span>
                <b v-if="slot.selected" class="location-loot-check" aria-hidden="true">✓</b>
              </template>
            </button>
          </div>

          <div v-else class="location-search-empty-state">
            <strong>已经搜空</strong>
            <span>{{ locationLootSummary?.legacy ? '旧存档已记录这里被搜空，不会重新生成物资。' : '这里已经没有能够带走的物资。' }}</span>
          </div>
        </div>

        <div class="location-search-lower">
          <p v-if="locationSearch.error" class="location-search-error" role="alert">{{ locationSearch.error }}</p>
          <p v-if="locationSearch.feedback" class="location-search-feedback" role="status" aria-live="polite">{{ locationSearch.feedback }}</p>

          <section v-if="locationSelectedSlots.length" class="storage-transfer-tray location-claim-tray">
            <header>
              <span>
                <small>SELECTED LOOT</small>
                <strong>已选 {{ locationSelectedSlots.length }} 项 · {{ formatNumber(locationSelectedSpace) }} 格</strong>
              </span>
              <button class="storage-selection-close" aria-label="清除地点物资选择" @click="clearLocationLootSelection">×</button>
            </header>
            <p>{{ locationSearch.descriptor.name }} → 随身背包</p>
            <small :class="{ 'storage-transfer-reason': locationClaimDisabledReason }">
              {{ locationClaimDisabledReason || `拿取后背包剩余 ${formatNumber(locationClaimPreview?.remainingSpace ?? game.remainingSpace)} 格。` }}
            </small>
          </section>

          <footer :class="['location-search-actions', { 'is-exhausted': locationLootSummary?.exhausted }]">
            <button class="secondary location-leave-button" @click="leaveLocationSearch">暂时离开</button>
            <button
              v-if="locationHiddenSlots.length"
              class="secondary location-reveal-button"
              :disabled="Boolean(locationSearch.busy)"
              @click="revealAllLocationLoot"
            >
              {{ locationSearch.busy === 'reveal' ? '翻找中…' : locationLootSummary?.revealed ? `继续翻找 ${locationHiddenSlots.length}` : `翻找全部 ${locationHiddenSlots.length}` }}
            </button>
            <button
              v-if="!locationLootSummary?.exhausted"
              class="primary-action location-claim-button"
              :disabled="Boolean(locationClaimDisabledReason)"
              @click="claimSelectedLocationLoot"
            >
              {{ locationSearch.busy === 'claim' ? '拿取中…' : locationSelectedSlots.length ? `拿走 ${locationSelectedSlots.length} 项（${formatNumber(locationSelectedSpace)} 格）` : '选择物资后拿取' }}
            </button>
          </footer>
        </div>
      </article>
    </section>

    <section
      v-if="resolutionReport"
      class="move-confirm-backdrop resolution-backdrop"
      @click.self="closeResolutionReport"
      @keydown.esc.stop.prevent="closeResolutionReport"
    >
      <article
        ref="resolutionDialog"
        class="resolution-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resolution-title"
        tabindex="-1"
      >
        <p class="panel-kicker">RESOLUTION</p>
        <h2 id="resolution-title">{{ resolutionReport.title }}</h2>
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

        <section v-if="resolutionReport.exploration" class="exploration-resolution" aria-label="探索过程与数值变化">
          <div class="exploration-resolution-facts">
            <span>
              <small>实际耗时</small>
              <strong>{{ resolutionReport.exploration.durationText }}</strong>
            </span>
            <span>
              <small>发现物资</small>
              <strong>{{ resolutionReport.exploration.discoveryText }}</strong>
            </span>
            <span>
              <small>翻找代价</small>
              <strong>{{ resolutionReport.exploration.costText }}</strong>
            </span>
            <span>
              <small>受伤 / 技能</small>
              <strong>{{ resolutionReport.exploration.injuryText }} · {{ resolutionReport.exploration.skillText }}</strong>
            </span>
          </div>

          <dl class="exploration-metric-grid">
            <div v-for="metric in resolutionReport.exploration.metrics" :key="metric.id" :class="metric.tone">
              <dt>{{ metric.label }}</dt>
              <dd>
                <span>{{ formatNumber(metric.before) }}</span>
                <b aria-hidden="true">→</b>
                <span>{{ formatNumber(metric.after) }}</span>
                <em>{{ signed(metric.delta) }}</em>
              </dd>
            </div>
          </dl>

          <p class="exploration-persistence-note">未拿走的物资会留在原处；暂时离开后，回来可以继续挑选。</p>
        </section>

        <div class="resolution-columns">
          <section>
            <h3>状态变化</h3>
            <p v-if="!resolutionReport.vitalChanges.length && !resolutionReport.woundChanges.length && !resolutionReport.skillChanges.length">状态没有明显变化。</p>
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
            <span
              v-for="change in resolutionReport.skillChanges"
              :key="change.id"
              class="resolution-pill good"
            >
              {{ change.label }} XP {{ signed(change.delta) }}{{ change.levelText ? ` · ${change.levelText}` : '' }}
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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mapEdges, mapNodeTypes, marketItems, shelters, skillDefinitions, vitalDefinitions, wikiAssetManifest } from '../data/zombie.js';
import { useGameStore } from '../stores/game.js';

const router = useRouter();
const game = useGameStore();
const activeDrawer = ref('');
const pendingMoveNode = ref(null);
const selectedSceneElement = ref(null);
const selectedSearchTarget = ref(null);
const sceneInspectFeedback = ref('');
const locationSearch = ref(null);
const locationSearchDialog = ref(null);
const resolutionReport = ref(null);
const resolutionDialog = ref(null);
const selectedExternalContainerId = ref('base');
const activeStoragePaneId = ref('carry');
const selectedStorageContainerId = ref('');
const selectedStorageStackId = ref('');
const transferQuantity = ref(1);
const storageActionFeedback = ref('');
const repairStackId = ref('');
const tacticalActionBusy = ref(false);
const tacticalActionFeedback = ref('');
const tacticalActionFeedbackTone = ref('neutral');
const tacticalSheetExpanded = ref(false);
const selectedTacticalWeaponId = ref('');
const lastAutoOpenedTacticalKey = ref('');
const tacticalStartRequested = ref(false);
let locationSearchSessionToken = 0;
let locationSearchCommandSequence = 0;
const tacticalActionFallbacks = [
  { id: 'push', label: '推开', estimatedOutcome: '争取身位，打断贴身尸体', staminaCost: 5, noiseDelta: 1 },
  { id: 'melee', label: '近战攻击', estimatedOutcome: '用当前主手攻击贴身目标', staminaCost: 6, noiseLabel: '随武器' },
  { id: 'stomp', label: '踩踏', estimatedOutcome: '终结倒地目标', staminaCost: 4, noiseDelta: 2 },
  { id: 'step_back', label: '后撤', estimatedOutcome: '拉开距离并推进脱离', staminaCost: 4, noiseDelta: 0 },
  { id: 'aim', label: '瞄准', estimatedOutcome: '提高下一次射击稳定性', staminaCost: 1, noiseDelta: 0 },
  { id: 'reload', label: '装填', estimatedOutcome: '为当前枪械补充对应弹药', staminaCost: 1, noiseDelta: 1 },
  { id: 'fire', label: '开火', estimatedOutcome: '高效杀伤，但会吸引更多尸群', staminaCost: 2, noiseLabel: '高（28–48）' },
  { id: 'disengage', label: '脱离', estimatedOutcome: '尝试结束接触并建立安全窗口', staminaCost: 6, noiseDelta: 0 },
  { id: 'brace', label: '稳住阵脚', estimatedOutcome: '恢复平衡并少量恢复耐力，降低下一次失误风险', staminaCost: 0, noiseDelta: 0 },
];
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
const skillProgressForDisplay = computed(() => {
  const progressEntries = Array.isArray(game.skillProgressList) && game.skillProgressList.length
    ? game.skillProgressList
    : topSkills.value.map((skill) => ({ ...skill, xp: null, nextLevelXp: null, progress: 0, recentGain: 0 }));
  return progressEntries
    .map((entry) => {
      const definition = skillDefinitions.find((skill) => skill.id === entry.id) ?? {};
      const xp = finiteOrNull(entry.xp);
      const currentLevelXp = finiteOrNull(entry.currentLevelXp) ?? xp;
      const nextLevelXp = finiteOrNull(entry.nextLevelXp);
      const suppliedProgress = finiteOrNull(entry.progress);
      const calculatedProgress = nextLevelXp && xp !== null ? (xp / nextLevelXp) * 100 : 0;
      return {
        ...definition,
        ...entry,
        label: entry.label ?? definition.label ?? entry.id,
        canonicalName: definition.canonicalName ?? entry.label ?? entry.id,
        fallbackIcon: definition.fallbackIcon ?? String(entry.label ?? entry.id).slice(0, 2).toUpperCase(),
        level: Math.max(0, Math.round(Number(entry.level) || 0)),
        progress: Math.max(0, Math.min(100, suppliedProgress ?? calculatedProgress)),
        recentGain: Math.max(0, finiteOrNull(entry.recentGain) ?? 0),
        xpLabel: currentLevelXp === null
          ? 'XP 数据待同步'
          : nextLevelXp === null || nextLevelXp <= 0
            ? `${formatNumber(xp ?? currentLevelXp)} XP · 已满级`
            : `${formatNumber(currentLevelXp)} / ${formatNumber(nextLevelXp)} XP`,
      };
    })
    .sort((a, b) => b.level - a.level || b.progress - a.progress || a.label.localeCompare(b.label, 'zh-CN'));
});
const currentTotalMinute = computed(() => Math.max(0, (Math.max(1, Number(game.day) || 1) - 1) * 1440 + (Number(game.clockMinutes) || 0)));
const localZombieState = computed(() => {
  const state = game.currentZombieState && typeof game.currentZombieState === 'object'
    ? game.currentZombieState
    : {};
  return {
    population: finiteRoundedOrNull(state.population ?? state.count),
    cap: finiteRoundedOrNull(state.cap ?? state.capacity),
    clearedDay: finiteRoundedOrNull(state.clearedDay),
    securedUntilMinute: finiteRoundedOrNull(state.securedUntilMinute ?? state.evasionUntilMinutes),
  };
});
const currentNodeSecured = computed(() => {
  if (typeof game.isCurrentNodeSecured === 'boolean') return game.isCurrentNodeSecured;
  const until = normalizedSecuredUntilMinute.value;
  return until !== null && until > currentTotalMinute.value;
});
const currentNodeTemporarilySecured = computed(() => currentNodeSecured.value && localZombieState.value.population !== 0);
const normalizedSecuredUntilMinute = computed(() => {
  const until = localZombieState.value.securedUntilMinute;
  if (until === null) return null;
  return until < 1440 && game.day > 1 ? (game.day - 1) * 1440 + until : until;
});
const encounterState = computed(() => game.currentEncounter && typeof game.currentEncounter === 'object' ? game.currentEncounter : null);
const encounterActive = computed(() => Boolean(encounterState.value?.active));
const encounterPopulation = computed(() => finiteRoundedOrNull(encounterState.value?.population) ?? localZombieState.value.population ?? 0);
const encounterNodeName = computed(() => encounterState.value?.nodeName || currentNode.value?.name || '当前区域');
const tacticalEncounterState = computed(() => game.activeTacticalEncounter && typeof game.activeTacticalEncounter === 'object'
  ? game.activeTacticalEncounter
  : null);
const tacticalModeVisible = computed(() => Boolean(tacticalEncounterState.value));
const tacticalSummary = computed(() => {
  const supplied = game.tacticalEncounterSummary && typeof game.tacticalEncounterSummary === 'object'
    ? game.tacticalEncounterSummary
    : {};
  const state = tacticalEncounterState.value ?? {};
  const status = supplied.status ?? state.status ?? 'active';
  const standing = finiteRoundedOrNull(supplied.standingZombies)
    ?? ['distant', 'approaching', 'engaged'].reduce((sum, key) => sum + (finiteRoundedOrNull(state.zombies?.[key]) ?? 0), 0);
  const remaining = finiteRoundedOrNull(supplied.remainingZombies)
    ?? standing + (finiteRoundedOrNull(state.zombies?.downed) ?? 0);
  const suppliedPressure = finiteRoundedOrNull(supplied.pressure ?? supplied.pressureScore);
  const legacyPressureBand = typeof supplied.pressure === 'string' ? supplied.pressure : null;
  const pressure = Math.max(0, Math.min(100, suppliedPressure ?? tacticalPressureScoreFromCount(standing)));
  const pressureBand = supplied.pressureBand ?? legacyPressureBand ?? tacticalPressureBandFromScore(pressure);
  const fallbackLabel = {
    active: '尸群正在逼近',
    cleared: '区域已经清场',
    escaped: '已经脱离接触',
    defeated: '你失去了抵抗能力',
    dead: '你已失去生命体征',
    aborted: '遭遇已经结束',
  }[status] ?? '战术遭遇';
  return {
    ...supplied,
    id: supplied.id ?? state.id ?? `legacy-${state.nodeId ?? game.currentNodeId ?? 'node'}`,
    status,
    turn: finiteRoundedOrNull(supplied.turn ?? state.turn) ?? 0,
    rangeBand: supplied.rangeBand ?? state.rangeBand ?? 'near',
    escapeProgress: Math.max(0, Math.min(100, finiteRoundedOrNull(supplied.escapeProgress ?? state.escapeProgress) ?? 0)),
    remainingZombies: remaining,
    standingZombies: standing,
    pressure,
    pressureBand,
    canAct: supplied.canAct ?? status === 'active',
    label: supplied.label ?? fallbackLabel,
    tone: supplied.tone ?? (status === 'active' ? 'danger' : status === 'cleared' || status === 'escaped' ? 'good' : 'warn'),
  };
});
const tacticalTerminal = computed(() => tacticalSummary.value.status !== 'active' || tacticalSummary.value.canAct === false);
const tacticalNodeName = computed(() => {
  const nodeId = tacticalEncounterState.value?.nodeId;
  return game.visibleMapNodeList?.find((node) => node.id === nodeId)?.name
    ?? tacticalEncounterState.value?.nodeName
    ?? encounterNodeName.value;
});
const tacticalBuckets = computed(() => {
  const buckets = game.tacticalEncounterSummary?.zombies ?? tacticalEncounterState.value?.zombies ?? {};
  return [
    { id: 'distant', label: '远距', value: finiteRoundedOrNull(buckets.distant) ?? 0 },
    { id: 'approaching', label: '逼近', value: finiteRoundedOrNull(buckets.approaching) ?? 0 },
    { id: 'engaged', label: '缠斗', value: finiteRoundedOrNull(buckets.engaged) ?? 0 },
    { id: 'downed', label: '倒地', value: finiteRoundedOrNull(buckets.downed) ?? 0 },
  ].map((bucket) => ({ ...bucket, hot: bucket.value > 0 && ['approaching', 'engaged'].includes(bucket.id) }));
});
const tacticalStatusLabel = computed(() => ({
  active: `第 ${tacticalSummary.value.turn + 1} 回合`,
  cleared: '清场',
  escaped: '已脱离',
  defeated: '失去战斗力',
  dead: '死亡',
  aborted: '生存期限结束',
}[tacticalSummary.value.status] ?? tacticalSummary.value.status));
const tacticalPressureLabel = computed(() => {
  const label = {
    low: '压力较低',
    guarded: '需要警戒',
    moderate: '需要警戒',
    high: '高压接触',
    critical: '致命包围',
  }[tacticalSummary.value.pressureBand] ?? '压力未知';
  return `${label} · ${Math.round(Number(tacticalSummary.value.pressure) || 0)}%`;
});
const tacticalRangeLabel = computed(() => ({
  contact: '贴身', near: '近距', mid: '中距', far: '远距', distant: '远距',
}[tacticalSummary.value.rangeBand] ?? String(tacticalSummary.value.rangeBand || '未知')));
const tacticalThreatLabel = computed(() => `${Math.round(Number(tacticalSummary.value.threat ?? game.world?.threat) || 0)} · ${threatLabel.value}`);
const tacticalNoiseLabel = computed(() => `${Math.round(Number(tacticalSummary.value.noise ?? game.world?.noise) || 0)} · ${noiseLabel.value}`);
const tacticalVitals = computed(() => {
  const carry = Array.isArray(game.storageContainers) ? game.storageContainers.find((container) => container.id === 'carry') : null;
  const used = Number(carry?.usedSpace ?? game.usedSpace ?? 0) || 0;
  const capacity = Number(carry?.capacity ?? game.capacity ?? 0) || 0;
  const encumbrance = finiteRoundedOrNull(tacticalSummary.value.encumbrance)
    ?? (capacity > 0 ? Math.round((used / capacity) * 100) : 0);
  const bleeding = finiteRoundedOrNull(tacticalSummary.value.bleeding)
    ?? (game.body?.wounds ?? []).filter((wound) => wound.bleeding).length;
  return [
    tacticalVital('health', '生命', tacticalSummary.value.health ?? game.vitals?.health, true),
    tacticalVital('endurance', '耐力', tacticalSummary.value.endurance ?? game.vitals?.endurance, true),
    tacticalVital('panic', '恐慌', tacticalSummary.value.panic ?? game.vitals?.panic, false),
    tacticalVital('pain', '疼痛', tacticalSummary.value.pain ?? game.body?.pain, false),
    tacticalVital('encumbrance', '负重', encumbrance, false),
    { id: 'bleeding', label: '流血', value: bleeding, suffix: '处', max: null, danger: bleeding > 0 },
  ];
});
const tacticalWeaponOptionsForDisplay = computed(() => {
  const supplied = Array.isArray(game.tacticalWeaponOptions) ? game.tacticalWeaponOptions : [];
  const fallback = supplied.length
    ? supplied
    : (Array.isArray(game.inventory) ? game.inventory.filter((item) => item.count > 0 && item.tags?.includes('weapon')) : []);
  return fallback.map(normalizeTacticalWeapon);
});
const tacticalWeapon = computed(() => {
  const desired = selectedTacticalWeaponId.value
    || tacticalEncounterState.value?.selectedWeaponStackId
    || game.equippedWeaponStackId;
  return tacticalWeaponOptionsForDisplay.value.find((weapon) => weapon.stackId === desired)
    ?? tacticalWeaponOptionsForDisplay.value.find((weapon) => weapon.equipped)
    ?? null;
});
const tacticalWeaponConditionText = computed(() => tacticalWeapon.value?.conditionText ?? '无武器耐久');
const tacticalActions = computed(() => {
  const supplied = Array.isArray(game.tacticalActionList) ? game.tacticalActionList : [];
  const source = tacticalActionFallbacks.map((fallback) => {
    const action = supplied.find((entry) => entry?.id === fallback.id);
    return action
      ? { ...fallback, ...action }
      : { ...fallback, enabled: false, disabledReason: '战术行动数据正在同步' };
  });
  return source.map(normalizeTacticalAction);
});
const tacticalLog = computed(() => {
  const source = game.tacticalEncounterSummary?.log ?? tacticalEncounterState.value?.log ?? [];
  if (!Array.isArray(source)) return [];
  return source.slice(-8).reverse().map((entry, index) => ({
    id: entry?.id ?? `${tacticalSummary.value.turn}-${index}-${typeof entry === 'string' ? entry : entry?.text ?? ''}`,
    turnLabel: entry?.turn !== undefined ? `R${Math.max(1, Number(entry.turn) || 1)}` : `R${Math.max(1, tacticalSummary.value.turn - index)}`,
    text: typeof entry === 'string' ? entry : entry?.text ?? entry?.message ?? entry?.label ?? describeTacticalEvent(entry),
  }));
});
const tacticalFooterHint = computed(() => tacticalActionBusy.value
  ? '正在结算这一回合…'
  : `${tacticalPressureLabel.value} · ${tacticalWeapon.value?.name ?? '徒手'} · 先确认退路`);
const securedUntilLabel = computed(() => {
  const until = normalizedSecuredUntilMinute.value;
  if (until === null) return currentNodeSecured.value ? '状态有效' : '未建立';
  const day = Math.floor(until / 1440) + 1;
  const minuteOfDay = ((until % 1440) + 1440) % 1440;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `至第 ${day} 天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
});
const localZombiePopulationLabel = computed(() => {
  const { population, cap } = localZombieState.value;
  if (population === null) return '尸群数据等待同步';
  return cap === null ? `${population} 只活动尸体` : `${population} / ${cap} 只`;
});
const localZombieStatusLabel = computed(() => {
  if (encounterActive.value) return '遭遇中';
  if (localZombieState.value.population === 0) return '已经清场';
  if (currentNodeTemporarilySecured.value) return '临时安全';
  if (localZombieState.value.population === null) return '情报未知';
  return '尸群活跃';
});
const localZombieHeadline = computed(() => encounterActive.value
  ? `遭遇中 · ${encounterPopulation.value} 只`
  : localZombieState.value.population === null
    ? '本地尸群情报未知'
    : `本地尸群 ${localZombiePopulationLabel.value}`);
const localZombieDetail = computed(() => {
  if (encounterActive.value) return `${encounterNodeName.value} · 清场或脱离后再整备`;
  if (localZombieState.value.population === 0) {
    return localZombieState.value.clearedDay
      ? `第 ${localZombieState.value.clearedDay} 天完成清场，当前区域没有活动尸体`
      : '区域已清空，当前没有活动尸体';
  }
  if (currentNodeTemporarilySecured.value) return `临时安全 ${securedUntilLabel.value}`;
  if (localZombieState.value.clearedDay) return `第 ${localZombieState.value.clearedDay} 天完成清场，目前没有安全窗口`;
  if (localZombieState.value.population === null) return '等待本地尸群数据';
  return '区域仍有活动尸群，行动可能触发遭遇';
});
const localZombieTone = computed(() => {
  if (encounterActive.value) return 'danger';
  const { population, cap } = localZombieState.value;
  if (population === null) return 'neutral';
  if (population === 0) return 'clear';
  if (currentNodeTemporarilySecured.value) return 'secured';
  if (cap && population / cap >= 0.7) return 'danger';
  if (cap && population / cap >= 0.35) return 'warn';
  return 'active';
});
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
const locationLootSummary = computed(() => {
  const search = locationSearch.value;
  if (!search) return null;
  return game.sceneLootSummary(search.descriptor, search.key) ?? null;
});
const locationLootSlots = computed(() => (locationLootSummary.value?.slots ?? [])
  .filter((slot) => slot.status !== 'claimed')
  .map((slot) => {
    const catalogItem = slot.item ? marketItems.find((item) => item.id === slot.item.id) ?? null : null;
    const count = Math.max(1, Number(slot.item?.count) || 1);
    const item = catalogItem ? { ...catalogItem, count, stackId: slot.item.stackId } : null;
    const space = item ? Math.max(0, Number(item.space) || 0) * count : 0;
    const selected = Boolean(item?.stackId && locationSearch.value?.selectedStackIds.includes(item.stackId));
    const status = locationSearch.value?.busy === 'reveal' && slot.status === 'hidden' ? 'searching' : slot.status;
    return {
      ...slot,
      persistedStatus: slot.status,
      status,
      item,
      space,
      selected,
      tier: item?.tier ?? 'white',
      footprint: item ? footprintForSpace(space) : '1x1',
    };
  }));
const locationHiddenSlots = computed(() => locationLootSlots.value.filter((slot) => slot.persistedStatus === 'hidden'));
const locationRevealedSlots = computed(() => locationLootSlots.value.filter((slot) => slot.persistedStatus === 'revealed'));
const locationSelectedSlots = computed(() => locationRevealedSlots.value.filter((slot) => slot.selected));
const locationSelectedStackIds = computed(() => locationSelectedSlots.value.map((slot) => slot.item.stackId));
const locationSelectedSpace = computed(() => locationSelectedSlots.value.reduce((sum, slot) => sum + slot.space, 0));
const locationSearchProgressText = computed(() => {
  const summary = locationLootSummary.value;
  if (!summary) return '0/0';
  return `${Math.max(0, summary.total - summary.hidden)}/${summary.total}`;
});
const locationSearchCostText = computed(() => {
  const summary = locationLootSummary.value;
  if (!summary) return '地点状态正在同步。';
  if (summary.exhausted) return '这里已经没有能够带走的物资。';
  if (summary.searchCostPaid) return summary.hidden > 0 ? '已经翻过一部分；继续翻找不再额外耗时。' : '翻找已经完成，可以选择要带走的物资。';
  const minutes = Math.max(0, Number(summary.searchCost?.minutes) || 0);
  const noise = Math.max(0, Number(summary.searchCost?.noise) || 0);
  return `首次翻找耗时 ${formatDuration(minutes)}${noise ? ` · 噪声 +${noise}` : ' · 保持安静'}`;
});
const locationClaimPreview = computed(() => {
  const search = locationSearch.value;
  const summary = locationLootSummary.value;
  if (!search || !summary || !locationSelectedStackIds.value.length) return null;
  return game.previewSceneLootClaim(search.descriptor, {
    expectedRevision: summary.revision,
    stackIds: locationSelectedStackIds.value,
  }, search.key);
});
const locationClaimDisabledReason = computed(() => {
  if (!locationSearch.value || !locationLootSummary.value) return '地点物资状态不可用';
  if (locationSearch.value.busy === 'reveal') return '正在翻找，稍等片刻';
  if (locationSearch.value.busy === 'claim') return '正在拿取物资';
  if (!locationSelectedStackIds.value.length) return '请选择要带走的物资';
  if (locationClaimPreview.value?.ok) return '';
  return sceneLootFailureMessage(locationClaimPreview.value, 'claim');
});
const noiseLabel = computed(() => signalLabel(game.world?.noise, ['安静', '可闻', '嘈杂', '刺耳']));
const threatLabel = computed(() => signalLabel(game.world?.threat, ['零散', '游荡', '聚集', '逼近']));
const evacuationStatus = computed(() => {
  const atEvacuation = ['valley_checkpoint', 'louisville_outskirts'].includes(game.currentNodeId);
  if (game.isVictory) return '已进入撤离区，救援正在接应';
  if (atEvacuation && encounterActive.value) return `撤离区尚未安全 · ${encounterPopulation.value} 只游荡者阻断接应`;
  if (game.day < game.maxDay) {
    return `${atEvacuation ? '已抵达撤离区' : '向谷地检查点/外环推进'} · 窗口还有 ${game.maxDay - game.day} 天`;
  }
  if (game.day <= game.evacuationDeadline) {
    return `${atEvacuation ? '已抵达撤离区' : '撤离窗口开放'} · 剩 ${game.evacuationDeadline - game.day + 1} 天`;
  }
  return '撤离窗口已经关闭';
});
const storageContainersForDisplay = computed(() => Array.isArray(game.storageContainers)
  ? game.storageContainers.filter((container) => container?.id)
  : []);
const carryStorageContainer = computed(() => storageContainersForDisplay.value.find((container) => container.id === 'carry') ?? null);
const externalStorageContainers = computed(() => storageContainersForDisplay.value.filter((container) => container.id !== 'carry'));
const selectedExternalContainer = computed(() => externalStorageContainers.value.find((container) => container.id === selectedExternalContainerId.value)
  ?? externalStorageContainers.value.find((container) => container.accessible)
  ?? externalStorageContainers.value[0]
  ?? null);
const visibleStoragePanes = computed(() => [carryStorageContainer.value, selectedExternalContainer.value]
  .filter((container, index, entries) => container && entries.findIndex((entry) => entry.id === container.id) === index));
const selectedStorageSource = computed(() => storageContainersForDisplay.value.find((container) => container.id === selectedStorageContainerId.value) ?? null);
const selectedStorageItem = computed(() => selectedStorageSource.value?.items?.find((item) => item.stackId === selectedStorageStackId.value) ?? null);
const transferDestination = computed(() => {
  if (!selectedStorageSource.value) return null;
  return selectedStorageSource.value.id === 'carry' ? selectedExternalContainer.value : carryStorageContainer.value;
});
const normalizedTransferQuantity = computed(() => Math.max(1, Math.round(Number(transferQuantity.value) || 1)));
const transferQuote = computed(() => {
  if (!selectedStorageItem.value || !selectedStorageSource.value || !transferDestination.value) {
    return { ok: false, maxQuantity: 0, disabledReason: '先选择要转移的物资' };
  }
  return game.previewTransfer({
    fromId: selectedStorageSource.value.id,
    toId: transferDestination.value.id,
    stackId: selectedStorageItem.value.stackId,
    quantity: normalizedTransferQuantity.value,
  });
});
const transferMaxQuantity = computed(() => Math.max(0, Number(transferQuote.value?.maxQuantity) || 0));
const transferDisabledReason = computed(() => {
  if (game.isGameOver) return '本局已经结束';
  if (!selectedStorageSource.value?.accessible) return selectedStorageSource.value?.accessReason || '当前无法接触来源容器';
  if (!transferDestination.value?.accessible) return transferDestination.value?.accessReason || '当前无法接触目标容器';
  return transferQuote.value?.ok ? '' : transferQuote.value?.disabledReason || '无法完成这次转移';
});
const transferActionLabel = computed(() => selectedStorageSource.value?.id === 'carry' ? '存入' : '取出');
const repairMaterials = computed(() => ['duct_tape', 'wood_glue'].map((id) => {
  const item = carryStorageContainer.value?.items?.find((entry) => entry.id === id);
  return { id, name: item?.name ?? (id === 'duct_tape' ? '胶带' : '木工胶'), count: item?.count ?? 0 };
}));
const generatorDisabledReason = computed(() => {
  if (game.isGameOver) return '本局已经结束';
  if (encounterActive.value) return '遭遇中无法操作基地设备';
  if (!game.isAtHome) return '需要返回初始据点';
  if (game.base?.generatorOn) return '';
  const homeItems = [...game.inventory, ...(Array.isArray(game.baseInventory) ? game.baseInventory : [])];
  if (!game.baseInventory.some((item) => item.id === 'generator' && item.count > 0)) {
    return '先把发电机存入据点仓储并完成安装';
  }
  const knowsGenerator = homeItems.some((item) => item.id === 'how_to_use_generators' && item.count > 0)
    || (game.skills.electrical ?? 0) >= 3;
  if (!knowsGenerator) return '需要《如何使用发电机》或电工 3';
  if (!game.base?.generatorOn && (game.base?.generatorFuel ?? 0) <= 0 && !homeItems.some((item) => item.id === 'gas_can' && item.count > 0)) {
    return '需要一桶汽油';
  }
  return '';
});
const baseWaterDisabledReason = computed(() => {
  if (game.isGameOver) return '本局已经结束';
  if (encounterActive.value) return '遭遇中无法取用储水';
  if (!game.isAtHome) return '需要返回初始据点';
  if ((game.base?.waterReserve ?? 0) <= 0) return '据点没有储水';
  return '';
});
const recentMapLog = computed(() => game.mapLog.slice(0, 5));
const vehicleIsElsewhere = computed(() => Boolean(game.vehicle?.status !== 'none' && game.vehicle?.nodeId && game.vehicle.nodeId !== game.currentNodeId));
const vehicleLabel = computed(() => {
  const name = game.vehicle?.name ?? '徒步';
  return vehicleIsElsewhere.value ? `${name}（停在其他地区）` : name;
});
const vehicleStatusLabel = computed(() => {
  if (vehicleIsElsewhere.value) return '停在其他地区';
  if (game.vehicle?.status === 'working') return '可用';
  if (game.vehicle?.status === 'damaged') return '受损';
  return '无车';
});
const drawerTitle = computed(() => {
  if (activeDrawer.value === 'inventory') return { kicker: 'MATERIALS / STORAGE', title: '物资与仓储' };
  if (activeDrawer.value === 'survival' && tacticalModeVisible.value) return { kicker: 'TACTICAL / ENCOUNTER', title: '战术遭遇' };
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

watch(
  () => game.currentNodeId,
  () => {
    if (locationSearch.value) leaveLocationSearch();
    clearStorageSelection();
    storageActionFeedback.value = '';
    const preferred = externalStorageContainers.value.find((container) => container.accessible)
      ?? externalStorageContainers.value[0];
    if (preferred) selectedExternalContainerId.value = preferred.id;
    activeStoragePaneId.value = 'carry';
  }
);

watch(
  [() => tacticalEncounterState.value?.id ?? '', () => encounterActive.value],
  ([encounterKey, legacyEncounterActive]) => {
    if (encounterKey) {
      tacticalStartRequested.value = false;
      selectedTacticalWeaponId.value = tacticalEncounterState.value?.selectedWeaponStackId ?? game.equippedWeaponStackId ?? '';
      if (lastAutoOpenedTacticalKey.value !== encounterKey) {
        lastAutoOpenedTacticalKey.value = encounterKey;
        tacticalSheetExpanded.value = false;
        tacticalActionFeedback.value = '';
        activeDrawer.value = 'survival';
      }
      return;
    }
    if (!legacyEncounterActive) {
      tacticalStartRequested.value = false;
      return;
    }
    if (!tacticalStartRequested.value && typeof game.startTacticalEncounter === 'function') {
      tacticalStartRequested.value = true;
      activeDrawer.value = 'survival';
      try {
        const started = game.startTacticalEncounter();
        if (started === false) tacticalStartRequested.value = false;
      } catch (error) {
        tacticalStartRequested.value = false;
        tacticalActionFeedback.value = error instanceof Error ? error.message : '无法开始战术遭遇';
        tacticalActionFeedbackTone.value = 'danger';
      }
    }
  },
  { immediate: true }
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
  const disabledReason = sceneSearchDisabledReason(searchable, { allowExhausted: true });
  if (disabledReason) {
    sceneInspectFeedback.value = disabledReason;
    return;
  }
  const descriptor = { ...searchable };
  const requestedKey = searchKeyFor(descriptor);
  const opened = game.openSceneLoot(descriptor, requestedKey);
  if (!opened?.ok && opened?.reason !== 'legacy_depleted') {
    sceneInspectFeedback.value = sceneLootFailureMessage(opened, 'open');
    return;
  }
  const summary = opened?.summary ?? game.sceneLootSummary(descriptor, opened?.searchKey ?? requestedKey);
  if (!summary) {
    sceneInspectFeedback.value = '地点物资状态未能建立，请重新选择这个对象。';
    return;
  }
  locationSearchSessionToken += 1;
  locationSearch.value = {
    descriptor,
    key: opened?.searchKey ?? requestedKey,
    selectedStackIds: [],
    busy: '',
    error: '',
    feedback: summary.legacy ? '旧存档已经记录这里被搜空，不会重新生成物资。' : '',
  };
  sceneInspectFeedback.value = '';
  nextTick(() => locationSearchDialog.value?.focus());
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
  const tacticalPreferredActions = {
    combat_melee: 'melee',
    combat_firearm: 'fire',
    evade: 'disengage',
  };
  if (tacticalPreferredActions[actionId] && typeof game.startTacticalEncounter === 'function') {
    startTacticalEncounter(tacticalPreferredActions[actionId]);
    return;
  }
  const before = captureGameSnapshot();
  if (!game.resolveNodeAction(actionId)) return;
  showResolutionReport(before);
}

function openTacticalDrawer() {
  activeDrawer.value = 'survival';
  if (!tacticalEncounterState.value && encounterActive.value && typeof game.startTacticalEncounter === 'function') {
    startTacticalEncounter();
  }
}

function startTacticalEncounter(preferredActionId) {
  if (typeof game.startTacticalEncounter !== 'function') return false;
  tacticalStartRequested.value = true;
  activeDrawer.value = 'survival';
  try {
    const started = game.startTacticalEncounter(preferredActionId);
    if (started === false) {
      tacticalStartRequested.value = false;
      tacticalActionFeedback.value = '当前无法开始战术遭遇。';
      tacticalActionFeedbackTone.value = 'danger';
      return false;
    }
    return true;
  } catch (error) {
    tacticalStartRequested.value = false;
    tacticalActionFeedback.value = error instanceof Error ? error.message : '无法开始战术遭遇';
    tacticalActionFeedbackTone.value = 'danger';
    return false;
  }
}

async function performTacticalAction(action) {
  if (!action || action.disabled || tacticalActionBusy.value) return;
  if (typeof game.performTacticalAction !== 'function') {
    tacticalActionFeedback.value = '战术行动服务尚未接入，无法结算这一回合。';
    tacticalActionFeedbackTone.value = 'danger';
    return;
  }
  tacticalActionBusy.value = true;
  tacticalActionFeedback.value = '';
  const encounterId = tacticalEncounterState.value?.id ?? tacticalEncounterState.value?.encounterId;
  const expectedTurn = tacticalEncounterState.value?.turn;
  try {
    const result = await game.performTacticalAction(action.id, {
      encounterId,
      expectedTurn,
      weaponStackId: tacticalWeapon.value?.stackId ?? null,
    });
    if (result === false || result?.ok === false) {
      tacticalActionFeedback.value = tacticalDisabledReason(result?.disabledReason ?? result?.reason) || '行动未能执行，状态没有变化。';
      tacticalActionFeedbackTone.value = 'danger';
      return;
    }
    tacticalActionFeedback.value = formatTacticalResult(result, action);
    tacticalActionFeedbackTone.value = 'neutral';
  } catch (error) {
    tacticalActionFeedback.value = error instanceof Error ? error.message : '战术行动结算失败';
    tacticalActionFeedbackTone.value = 'danger';
  } finally {
    // Keep the input lock through the browser's double-click window. The
    // captured encounter/turn above also lets the Store reject stale commands.
    await new Promise((resolve) => setTimeout(resolve, 280));
    tacticalActionBusy.value = false;
  }
}

function selectTacticalWeapon(weapon) {
  if (!weapon?.stackId || weapon.disabled) return;
  selectedTacticalWeaponId.value = weapon.stackId;
  if (weapon.stackId !== game.equippedWeaponStackId && typeof game.equipWeapon === 'function') {
    const equipped = game.equipWeapon(weapon.stackId);
    if (equipped === false) {
      tacticalActionFeedback.value = weapon.disabledReason || '现在无法切换到这件武器。';
      tacticalActionFeedbackTone.value = 'danger';
    }
  }
}

function endTacticalEncounter() {
  tacticalStartRequested.value = true;
  if (typeof game.dismissTacticalEncounter === 'function') game.dismissTacticalEncounter();
  tacticalSheetExpanded.value = false;
  activeDrawer.value = '';
}

function continueAfterTactical() {
  tacticalStartRequested.value = true;
  if (typeof game.dismissTacticalEncounter === 'function') game.dismissTacticalEncounter();
  tacticalSheetExpanded.value = false;
  activeDrawer.value = 'location';
}

function supportsItemUse(item) {
  return ['food', 'medical', 'morale'].includes(item?.category);
}

function isWeapon(item) {
  return Boolean(item?.tags?.includes('weapon'));
}

function isBag(item) {
  return Boolean(item?.tags?.includes('bag'));
}

function formatStorageSpace(container) {
  if (!container) return '—';
  return `${formatNumber(container.usedSpace ?? 0)} / ${formatNumber(container.capacity ?? 0)} 格`;
}

function storageCapacityTone(container) {
  const capacity = Math.max(0, Number(container?.capacity) || 0);
  const used = Math.max(0, Number(container?.usedSpace) || 0);
  if (capacity <= 0) return used > 0 ? 'danger' : 'neutral';
  if (used >= capacity) return 'danger';
  if (used / capacity >= 0.85) return 'warn';
  return 'normal';
}

function itemConditionDisplay(item) {
  return item?.condition ?? item?.freshness ?? null;
}

function itemCategoryLabel(item) {
  const labels = {
    food: '食物与饮水',
    medical: '医疗',
    morale: '精神用品',
    weapon: '武器',
    ammo: '弹药',
    tool: '工具',
    base: '基地物资',
    bag: '背包',
    survival: '生存工具',
    vehicle: '车辆物资',
  };
  return labels[item?.category] ?? '杂物';
}

function isStorageItemEquipped(item) {
  if (isWeapon(item)) return item.stackId === game.equippedWeaponStackId;
  if (isBag(item)) return item.stackId === game.equippedBagStackId;
  return false;
}

function isStorageItemSelected(container, item) {
  return selectedStorageContainerId.value === container?.id && selectedStorageStackId.value === item?.stackId;
}

function itemUseLabel(item) {
  if (item?.freshness?.tone === 'danger') return '冒险食用';
  if (item?.tags?.includes('water')) return '饮用';
  return item?.category === 'food' ? '食用' : '使用';
}

function itemEquipLabel(item) {
  if (isBag(item)) return item.stackId === game.equippedBagStackId ? '卸下背包' : '装备背包';
  return item.stackId === game.equippedWeaponStackId ? '卸下' : '装备';
}

function canEquipStorageItem(item) {
  return Boolean(item?.canEquip && !(isBag(item) && encounterActive.value));
}

function itemEquipDisabledReason(item) {
  if (isBag(item) && encounterActive.value) return '遭遇中只能更换随身武器';
  return item?.equipDisabledReason || '当前无法装备';
}

function itemRepairDisabledReason(item, container) {
  if (!isWeapon(item) || !item?.condition) return '';
  if (container?.id !== 'carry') return '先转移到随身背包';
  if (game.isGameOver) return '本局已经结束';
  if (encounterActive.value) return '遭遇中无法维修';
  if (!item.canRepair) {
    if ((Number(item.condition.percent) || 0) >= 100) return '耐久已经完好';
    return '当前无法维修这件武器';
  }
  if (!repairMaterials.value.some((material) => material.count > 0)) return '缺少胶带或木工胶';
  return '';
}

function storageItemDisabledReasons(item, container) {
  const reasons = [];
  if (supportsItemUse(item) && !item.canUse) reasons.push(`使用：${item.useDisabledReason || '当前无法使用'}`);
  if ((isWeapon(item) || isBag(item)) && !canEquipStorageItem(item)) reasons.push(`装备：${itemEquipDisabledReason(item)}`);
  const repairReason = itemRepairDisabledReason(item, container);
  if (repairReason) reasons.push(`维修：${repairReason}`);
  return [...new Set(reasons)];
}

function selectExternalStorageContainer(containerId) {
  const container = externalStorageContainers.value.find((entry) => entry.id === containerId);
  if (!container) return;
  if (selectedStorageContainerId.value && selectedStorageContainerId.value !== 'carry' && selectedStorageContainerId.value !== container.id) {
    clearStorageSelection();
  }
  selectedExternalContainerId.value = container.id;
  activeStoragePaneId.value = container.id;
  storageActionFeedback.value = container.accessible ? '' : container.accessReason;
}

function activateStoragePane(containerId) {
  if (!containerId || !visibleStoragePanes.value.some((container) => container.id === containerId)) return;
  activeStoragePaneId.value = containerId;
}

function selectStorageItem(container, item) {
  if (!container?.accessible || !item?.stackId) return;
  if (isStorageItemSelected(container, item)) {
    clearStorageSelection();
    return;
  }
  selectedStorageContainerId.value = container.id;
  selectedStorageStackId.value = item.stackId;
  activeStoragePaneId.value = container.id;
  transferQuantity.value = 1;
  repairStackId.value = '';
  storageActionFeedback.value = '';
}

function clearStorageSelection() {
  selectedStorageContainerId.value = '';
  selectedStorageStackId.value = '';
  transferQuantity.value = 1;
  repairStackId.value = '';
}

function clampTransferQuantity() {
  const maximum = Math.max(1, transferMaxQuantity.value);
  transferQuantity.value = Math.max(1, Math.min(maximum, normalizedTransferQuantity.value));
}

function adjustTransferQuantity(delta) {
  transferQuantity.value = Math.max(1, Math.min(Math.max(1, transferMaxQuantity.value), normalizedTransferQuantity.value + delta));
}

function setMaximumTransferQuantity() {
  if (transferMaxQuantity.value > 0) transferQuantity.value = transferMaxQuantity.value;
}

function commitStorageTransfer() {
  if (transferDisabledReason.value || !selectedStorageItem.value || !selectedStorageSource.value || !transferDestination.value) return;
  const itemName = selectedStorageItem.value.name;
  const fromName = selectedStorageSource.value.name;
  const toName = transferDestination.value.name;
  const quantity = normalizedTransferQuantity.value;
  const result = game.transferItem({
    fromId: selectedStorageSource.value.id,
    toId: transferDestination.value.id,
    stackId: selectedStorageItem.value.stackId,
    quantity,
  });
  if (!result?.ok || !result?.committed) {
    storageActionFeedback.value = result?.disabledReason || '转移失败，物资没有发生变化。';
    return;
  }
  storageActionFeedback.value = `${itemName} ×${quantity} 已从${fromName}转移到${toName}。`;
  const source = game.storageContainers.find((container) => container.id === selectedStorageContainerId.value);
  if (!source?.items?.some((item) => item.stackId === selectedStorageStackId.value)) clearStorageSelection();
  else {
    transferQuantity.value = 1;
    clampTransferQuantity();
  }
}

function useStorageItem(item) {
  const before = captureGameSnapshot();
  if (!game.useItem(item.stackId)) {
    storageActionFeedback.value = item.useDisabledReason || '当前无法使用这件物资。';
    return;
  }
  storageActionFeedback.value = `${item.name}已经使用。`;
  if (!game.inventory.some((entry) => entry.stackId === item.stackId)) clearStorageSelection();
  showResolutionReport(before, {
    title: `使用 ${item.name}`,
    result: `${item.name}已经使用，身体与背包状态已更新。`,
  });
}

function toggleStorageEquipment(item) {
  const wasEquipped = isStorageItemEquipped(item);
  const changed = isBag(item) ? game.equipBag(item.stackId) : game.equipWeapon(item.stackId);
  if (!changed) {
    storageActionFeedback.value = isBag(item) && wasEquipped
      ? '卸下这个背包后容量不足，请先腾出随身空间。'
      : item.equipDisabledReason || '当前无法更换这件装备。';
    return;
  }
  storageActionFeedback.value = `${item.name}已${wasEquipped ? '卸下' : '装备'}。`;
}

function toggleRepairPicker(item) {
  repairStackId.value = repairStackId.value === item.stackId ? '' : item.stackId;
  if (repairStackId.value && !repairMaterials.value.some((material) => material.count > 0)) {
    storageActionFeedback.value = '随身背包里没有胶带或木工胶。';
  }
}

function repairStorageWeapon(item, materialId) {
  const material = repairMaterials.value.find((entry) => entry.id === materialId);
  if (!material?.count) {
    storageActionFeedback.value = `没有可用的${material?.name ?? '维修材料'}。`;
    return;
  }
  const result = game.repairWeapon(item.stackId, materialId);
  if (!result?.ok) {
    storageActionFeedback.value = result?.disabledReason || '维修失败，物资没有发生变化。';
    return;
  }
  storageActionFeedback.value = `${item.name}恢复了 ${result.restored} 点耐久，消耗 1 份${material.name}。`;
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

async function revealAllLocationLoot() {
  const search = locationSearch.value;
  const summary = locationLootSummary.value;
  const slotIds = locationHiddenSlots.value.map((slot) => slot.slotId);
  if (!search || !summary || search.busy || !slotIds.length) return;

  const sessionToken = locationSearchSessionToken;
  const beforeReveal = captureGameSnapshot();
  search.busy = 'reveal';
  search.error = '';
  search.feedback = '';
  await new Promise((resolve) => globalThis.setTimeout(resolve, 720));
  if (sessionToken !== locationSearchSessionToken || locationSearch.value !== search) return;

  let result;
  try {
    result = game.revealSceneLoot(search.descriptor, {
      commandId: nextSceneLootCommandId('reveal', summary.revision),
      expectedRevision: summary.revision,
      slotIds,
    }, search.key);
  } catch (error) {
    search.busy = '';
    search.error = error instanceof Error ? error.message : '翻找失败，地点物资没有发生变化。';
    return;
  }
  if (sessionToken !== locationSearchSessionToken || locationSearch.value !== search) return;
  search.busy = '';
  if (!result?.ok) {
    search.error = sceneLootFailureMessage(result, 'reveal');
    return;
  }
  const revealedSlots = Array.isArray(result.revealedSlots) ? result.revealedSlots : [];
  const discoveredStacks = revealedSlots.length || slotIds.length;
  const discoveredCount = revealedSlots.length
    ? revealedSlots.reduce((sum, slot) => sum + Math.max(1, Number(slot?.item?.count) || 1), 0)
    : slotIds.length;
  search.feedback = `发现 ${discoveredCount} 件物资。点击物资选择要带走的部分，其余会留在原处。`;
  if (Math.max(0, Number(result.cost?.minutes) || 0) > 0) {
    showResolutionReport(beforeReveal, {
      title: `探索结算 · ${search.descriptor.name}`,
      result: `首次翻找完成：发现 ${discoveredCount} 件物资，但没有自动拿取。`,
      notes: `发现 ${discoveredCount} 件物资 · 未拿走的物资会留在原处`,
      exploration: true,
      discoveredCount,
      discoveredStacks,
      cost: result.cost,
    });
  }
}

function toggleLocationLootSelection(slot) {
  const search = locationSearch.value;
  const stackId = slot?.item?.stackId;
  if (!search || search.busy || slot?.persistedStatus !== 'revealed' || !stackId) return;
  search.selectedStackIds = search.selectedStackIds.includes(stackId)
    ? search.selectedStackIds.filter((id) => id !== stackId)
    : [...search.selectedStackIds, stackId];
  search.error = '';
  search.feedback = '';
}

function clearLocationLootSelection() {
  if (!locationSearch.value || locationSearch.value.busy) return;
  locationSearch.value.selectedStackIds = [];
  locationSearch.value.error = '';
}

async function claimSelectedLocationLoot() {
  const search = locationSearch.value;
  const summary = locationLootSummary.value;
  const stackIds = [...locationSelectedStackIds.value];
  if (!search || !summary || locationClaimDisabledReason.value || !stackIds.length) return;

  const sessionToken = locationSearchSessionToken;
  search.busy = 'claim';
  search.error = '';
  search.feedback = '';
  await nextTick();
  if (sessionToken !== locationSearchSessionToken || locationSearch.value !== search) return;

  let result;
  try {
    result = game.claimSceneLoot(search.descriptor, {
      commandId: nextSceneLootCommandId('claim', summary.revision),
      expectedRevision: summary.revision,
      stackIds,
    }, search.key);
  } catch (error) {
    search.busy = '';
    search.error = error instanceof Error ? error.message : '拿取失败，物资仍留在原处。';
    return;
  }
  if (sessionToken !== locationSearchSessionToken || locationSearch.value !== search) return;
  search.busy = '';
  if (!result?.ok) {
    search.error = sceneLootFailureMessage(result, 'claim');
    return;
  }
  const claimedNames = (result.claimedStacks ?? []).map((item) => `${itemName(item.id)}${item.count > 1 ? ` ×${item.count}` : ''}`);
  search.selectedStackIds = [];
  search.feedback = `${claimedNames.length ? `已拿走${claimedNames.join('、')}。` : '物资已经拿走。'}${result.summary?.remaining ? `原处还剩 ${result.summary.remaining} 项物资。` : '这里已经搜空。'}`;
}

function leaveLocationSearch() {
  locationSearchSessionToken += 1;
  locationSearch.value = null;
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
    parentSection: parent.section,
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
    parentSection: parent.section,
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
  const nodeId = currentNode.value?.id ?? '';
  const objectId = typeof searchable?.id === 'string' ? searchable.id.trim() : '';
  const parentSection = typeof searchable?.parentSection === 'string' ? searchable.parentSection.trim() : '';
  const parentId = typeof searchable?.parentId === 'string' ? searchable.parentId.trim() : '';
  if (!nodeId || !objectId) return '';
  return parentSection && parentId
    ? `${nodeId}:${parentSection}:${parentId}:${objectId}`
    : `${nodeId}:${objectId}`;
}

function isSearchableSpent(searchable) {
  if (!searchable) return false;
  return Boolean(game.sceneLootSummary(searchable, searchKeyFor(searchable))?.exhausted);
}

function searchButtonTextFor(searchable) {
  if (inspectedNode.value?.id !== currentNode.value?.id) return '到达后搜索';
  const summary = game.sceneLootSummary(searchable, searchKeyFor(searchable));
  if (summary?.exhausted) return '已经搜空';
  if (summary?.hidden && summary?.revealed) return `继续翻找 · 未知 ${summary.hidden}`;
  if (summary?.hidden && summary?.searchCostPaid) return `继续翻找 · 未知 ${summary.hidden}`;
  if (summary?.revealed) return `继续搜刮 · 留存 ${summary.revealed}`;
  return '搜索这里';
}

function sceneSearchDisabledReason(searchable, { allowExhausted = false } = {}) {
  if (!searchable) return '选择一个对象';
  if (game.isGameOver) return '本局已经结束';
  if (encounterActive.value) return '尸群仍在附近，先清场或脱离';
  if (inspectedNode.value?.id !== currentNode.value?.id) return '需要到达这个地点';
  const summary = game.sceneLootSummary(searchable, searchKeyFor(searchable));
  if (!allowExhausted && summary?.exhausted) return '这个容器已经搜空';
  return '';
}

function sceneLootFailureMessage(result, operation = 'open') {
  const reason = result?.reason;
  const messages = {
    game_over: '本局已经结束。',
    wrong_node: '需要到达这个地点，才能接触这里的物资。',
    invalid_search_key: '地点标识已经变化，请重新选择这个对象。',
    world_not_ready: '地点状态还没有准备好，请稍后重试。',
    unsafe_or_insufficient_window: '尸群仍在附近或安全窗口不足，先清场或脱离。',
    legacy_depleted: '旧存档已经记录这里被搜空。',
    container_missing: '地点物资尚未建立，请重新打开这个对象。',
    invalid_request: '物资请求无效，请重新选择。',
    invalid_command: '操作指令无效，请重试。',
    invalid_selection: operation === 'reveal' ? '没有可继续翻找的位置。' : '请选择要带走的物资。',
    slot_missing: '地点状态已变化，请重新打开搜索。',
    slot_not_hidden: '其中一处已经被翻开，列表已刷新。',
    stale_revision: '地点物资状态已变化，请重新选择。',
    duplicate_command: '这次操作已经处理，请勿重复提交。',
    stack_missing: '选中的物资已经不在原处。',
    stack_not_revealed: '先翻找出这件物资，再尝试拿取。',
    stack_id_conflict: '背包里存在冲突的物资记录，请重新打开搜索。',
    capacity_exceeded: `背包还差 ${formatNumber(result?.overflow ?? 0)} 格。`,
    catalog_item_missing: '这件物资的资料缺失，暂时无法拿取。',
  };
  return messages[reason] ?? (operation === 'claim' ? '无法拿取这些物资，它们仍留在原处。' : operation === 'reveal' ? '翻找失败，地点物资没有发生变化。' : '当前无法搜索这个对象。');
}

function nextSceneLootCommandId(kind, revision) {
  locationSearchCommandSequence += 1;
  return `scene-loot:${kind}:${game.totalWorldMinutes}:${revision}:${locationSearchCommandSequence}`;
}

function slugify(value = '') {
  return `${value}`.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '') || 'searchable';
}

function locationLootSlotClass(slot) {
  return [
    'loot-slot',
    'location-loot-slot',
    `footprint-${slot.footprint}`,
    `status-${slot.status}`,
    { selected: slot.selected, busy: Boolean(locationSearch.value?.busy) },
    slot.status === 'hidden' || slot.status === 'searching' ? 'quality-unknown' : `quality-${slot.tier}`,
  ];
}

function isLocationSlotDisabled(slot) {
  return Boolean(locationSearch.value?.busy) || slot.persistedStatus !== 'revealed';
}

function locationLootTooltip(slot) {
  if (slot.status === 'hidden') return '未知物资；使用下方翻找按钮揭示。';
  if (slot.status === 'searching') return '翻找中';
  const item = slot.item;
  if (!item) return '未知物资';
  return [
    item.name,
    item.count > 1 ? `数量：${item.count}` : '',
    `占用：${formatNumber(slot.space)} 格`,
    slot.selected ? '准备带走' : '留在原处',
    item.description,
  ].filter(Boolean).join('\n');
}

function locationLootAriaLabel(slot) {
  if (slot.status === 'hidden') return '未知物资，尚未翻找';
  if (slot.status === 'searching') return '未知物资，翻找中';
  const item = slot.item;
  if (!item) return '未知物资';
  return `${item.name}${item.count > 1 ? `，数量 ${item.count}` : ''}，占用 ${formatNumber(slot.space)} 格，${slot.selected ? '已选择，点击留在原处' : '留在原处，点击准备带走'}`;
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
    skills: { ...game.skills },
    skillXp: { ...game.skillXp },
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
  nextTick(() => resolutionDialog.value?.focus());
}

function buildResolutionReport(before, after, context = {}) {
  const latestHistory = game.history[game.history.length - 1];
  const latestMapLog = game.mapLog[0];
  const elapsedMinutes = Math.max(0, (after.day - before.day) * 24 * 60 + (after.clockMinutes - before.clockMinutes));
  const woundChanges = woundDiff(before.body, after.body);
  const skillChanges = skillXpDiff(before, after);
  const discoveredCount = Math.max(0, Number(context.discoveredCount) || 0);
  const discoveredStacks = Math.max(0, Number(context.discoveredStacks) || 0);
  const searchCostMinutes = Math.max(0, Number(context.cost?.minutes) || 0);
  const searchCostNoise = Math.max(0, Number(context.cost?.noise) || 0);
  const totalSkillXp = skillChanges.reduce((sum, change) => sum + change.delta, 0);
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
    woundChanges,
    skillChanges,
    inventoryChanges: inventoryDiff(before.inventory, after.inventory),
    tagChanges: tagDiff(before.hiddenTags, after.hiddenTags),
    vehicleChange: vehicleDiff(before.vehicle, after.vehicle),
    worldChanges: worldDiff(before, after),
    exploration: context.exploration ? {
      durationText: formatDuration(elapsedMinutes),
      discoveryText: discoveredStacks && discoveredStacks !== discoveredCount
        ? `${formatNumber(discoveredCount)} 件 · ${formatNumber(discoveredStacks)} 组`
        : `${formatNumber(discoveredCount)} 件`,
      costText: `${formatDuration(searchCostMinutes)}${searchCostNoise ? ` · 噪声 +${formatNumber(searchCostNoise)}` : ' · 无额外噪声'}`,
      injuryText: woundChanges.length ? `${woundChanges.length} 项伤势变化` : '无新增伤势',
      skillText: totalSkillXp > 0 ? `经验 +${formatNumber(totalSkillXp)}` : '无经验变化',
      metrics: explorationMetricDiff(before, after),
    } : null,
  };
}

function explorationMetricDiff(before, after) {
  const definitions = [
    { id: 'health', label: '生命', group: 'vitals', positiveIsBad: false },
    { id: 'endurance', label: '耐力', group: 'vitals', positiveIsBad: false },
    { id: 'fatigue', label: '疲劳', group: 'vitals', positiveIsBad: true },
    { id: 'panic', label: '恐慌', group: 'vitals', positiveIsBad: true },
    { id: 'stress', label: '压力', group: 'vitals', positiveIsBad: true },
    { id: 'noise', label: '噪声', group: 'world', positiveIsBad: true },
    { id: 'threat', label: '威胁', group: 'world', positiveIsBad: true },
  ];
  return definitions.map((definition) => {
    const beforeValue = Number(before[definition.group]?.[definition.id]) || 0;
    const afterValue = Number(after[definition.group]?.[definition.id]) || 0;
    const delta = Math.round((afterValue - beforeValue) * 10) / 10;
    const bad = definition.positiveIsBad ? delta > 0 : delta < 0;
    return {
      ...definition,
      before: beforeValue,
      after: afterValue,
      delta,
      tone: delta === 0 ? 'neutral' : bad ? 'bad' : 'good',
    };
  });
}

function skillXpDiff(before = {}, after = {}) {
  return skillDefinitions
    .map((skill) => {
      const delta = Math.round(((Number(after.skillXp?.[skill.id]) || 0) - (Number(before.skillXp?.[skill.id]) || 0)) * 100) / 100;
      if (delta <= 0) return null;
      const beforeLevel = Math.max(0, Number(before.skills?.[skill.id]) || 0);
      const afterLevel = Math.max(0, Number(after.skills?.[skill.id]) || 0);
      return {
        id: skill.id,
        label: skill.label,
        delta,
        levelText: afterLevel > beforeLevel ? `Lv.${beforeLevel} → Lv.${afterLevel}` : '',
      };
    })
    .filter(Boolean);
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

function tacticalPressureScoreFromCount(count = 0) {
  if (count >= 6) return 85;
  if (count >= 4) return 65;
  if (count >= 2) return 40;
  return 20;
}

function tacticalPressureBandFromScore(score = 0) {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
}

function tacticalVital(id, label, rawValue, higherIsGood) {
  const value = Math.max(0, Math.min(100, Math.round(Number(rawValue) || 0)));
  return {
    id,
    label,
    value,
    suffix: '%',
    max: 100,
    danger: higherIsGood ? value <= 30 : value >= 65,
  };
}

function normalizeTacticalWeapon(weapon) {
  const itemId = weapon?.itemId ?? weapon?.id;
  const catalog = marketItems.find((item) => item.id === itemId) ?? {};
  const stackId = weapon?.stackId ?? weapon?.instanceId ?? itemId ?? '';
  const inventoryWeapon = Array.isArray(game.inventory)
    ? game.inventory.find((item) => item.stackId === stackId)
    : null;
  const stateCondition = weapon?.conditionState?.condition ?? inventoryWeapon?.conditionState?.condition ?? {};
  const conditionDisplay = weapon?.condition && typeof weapon.condition === 'object' ? weapon.condition : {};
  const maximum = Math.max(1, Number(stateCondition.maximum ?? weapon?.maximumCondition ?? 100) || 100);
  const current = Math.max(0, Number(stateCondition.current ?? weapon?.currentCondition ?? conditionDisplay.current ?? maximum) || 0);
  const percent = Math.max(0, Math.min(100, Math.round(Number(conditionDisplay.percent) || (current / maximum) * 100)));
  const loadedState = tacticalEncounterState.value?.player?.loadedByWeapon?.[stackId] ?? {};
  const isFirearm = weapon?.firearm ?? weapon?.tags?.includes('firearm') ?? inventoryWeapon?.tags?.includes('firearm') ?? false;
  const loaded = weapon?.loadedAmmo ?? weapon?.loaded ?? weapon?.ammo?.loaded ?? loadedState.rounds ?? loadedState.loaded;
  const capacity = weapon?.ammoCapacity ?? weapon?.capacity ?? weapon?.ammo?.capacity ?? loadedState.capacity;
  const reserve = weapon?.reserveAmmo ?? weapon?.reserve ?? weapon?.ammo?.reserve;
  const disabledReason = tacticalDisabledReason(weapon?.disabledReason ?? weapon?.equipDisabledReason)
    || (weapon?.broken ?? stateCondition.broken ? '当前武器已经损坏' : '');
  return {
    ...weapon,
    itemId,
    stackId,
    name: weapon?.name ?? catalog.name ?? itemId ?? '未命名武器',
    equipped: weapon?.equipped ?? stackId === game.equippedWeaponStackId,
    disabled: Boolean(weapon?.disabled ?? weapon?.enabled === false) || Boolean(weapon?.broken ?? stateCondition.broken),
    disabledReason,
    conditionPercent: percent,
    conditionText: `${weapon?.conditionLabel ?? conditionDisplay.label ?? (stateCondition.broken || percent <= 0 ? '已损坏' : '耐久')} · ${Math.round(current)} / ${Math.round(maximum)}（${percent}%）`,
    loadedAmmo: loaded === undefined || loaded === null
      ? (isFirearm ? `0 / ${capacity ?? '—'}` : '不适用')
      : (isFirearm ? `${Math.max(0, Math.round(Number(loaded) || 0))}${capacity !== undefined ? ` / ${Math.max(0, Math.round(Number(capacity) || 0))}` : ''}` : '不适用'),
    reserveAmmo: reserve === undefined || reserve === null
      ? (isFirearm ? '待同步' : '不适用')
      : (isFirearm ? Math.max(0, Math.round(Number(reserve) || 0)) : '不适用'),
  };
}

function normalizeTacticalAction(action) {
  const rawRisk = action?.risk ?? action?.riskPercent ?? action?.preview?.risk;
  const riskNumber = finiteOrNull(rawRisk);
  const riskPercent = riskNumber === null ? null : Math.max(0, Math.min(100, Math.round(riskNumber <= 1 ? riskNumber * 100 : riskNumber)));
  const stamina = Math.abs(Math.round(Number(action?.staminaCost ?? action?.enduranceCost ?? action?.costs?.endurance ?? 0) || 0));
  const noise = Math.round(Number(action?.noiseDelta ?? action?.noiseCost ?? action?.costs?.noise ?? 0) || 0);
  const disabledReason = tacticalDisabledReason(action?.disabledReason);
  const disabled = Boolean(action?.disabled ?? action?.enabled === false) || Boolean(disabledReason && action?.enabled !== true);
  const riskTone = action?.tone ?? (riskPercent === null ? 'neutral' : riskPercent >= 65 ? 'danger' : riskPercent >= 35 ? 'warn' : 'good');
  const estimated = action?.estimatedOutcome ?? action?.estimatedResult ?? action?.outcome ?? action?.preview?.label ?? action?.description;
  return {
    ...action,
    id: action?.id,
    label: action?.label ?? action?.name ?? action?.id,
    description: action?.description ?? '',
    minutes: Math.max(0, Math.round(Number(action?.minutes ?? action?.durationMinutes ?? action?.timeMinutes ?? 0) || 0)),
    riskLabel: typeof rawRisk === 'string' ? rawRisk : riskPercent === null ? '风险未知' : `风险 ${riskPercent}%`,
    tone: riskTone,
    estimatedOutcome: typeof estimated === 'string' ? estimated : '结算结果取决于距离、状态与武器',
    staminaLabel: action?.staminaLabel ?? (stamina ? `-${stamina}` : '±0'),
    noiseLabel: action?.noiseLabel ?? (noise > 0 ? `+${noise}` : noise < 0 ? `${noise}` : '安静'),
    disabled,
    disabledReason,
  };
}

function tacticalDisabledReason(reason) {
  if (!reason) return '';
  const labels = {
    encounter_terminal: '遭遇已经结束',
    stale_encounter: '遭遇状态已变化，请重新打开战术面板',
    stale_turn: '回合状态已变化，请重新选择',
    invalid_action: '这个行动当前不存在',
    weapon_missing: '需要先装备一件可用武器',
    weapon_broken: '当前武器已经损坏',
    requires_weapon: '需要装备合适的武器',
    requires_melee: '需要装备近战武器',
    requires_melee_weapon: '需要装备近战武器',
    requires_firearm: '需要装备枪械',
    no_reachable_target: '当前距离没有近战可触及的目标',
    no_contact_target: '没有贴身目标可推开',
    currently_grabbed: '正被丧尸抓住，先推开挣脱',
    no_downed_target: '没有倒地目标可踩踏',
    too_exhausted: '耐力已经耗尽，无法执行这个动作',
    already_at_range: '已经拉到最远战术距离',
    no_standing_target: '没有仍然站立的目标',
    firearm_unloaded: '枪械尚未装填',
    firearm_full: '弹匣已经装满',
    no_matching_ammo: '没有对应口径的备用弹药',
    mixed_ammo_type: '弹匣内弹药类型不一致，无法混装',
    need_more_distance: '距离太近，先后撤再脱离',
    escape_not_prepared: '脱离准备不足，先拉开距离',
    escape_ready: '已经拉开足够距离，现在应立即脱离',
    no_downed_zombie: '没有可踩踏的倒地目标',
    no_engaged_zombie: '没有贴身目标',
    insufficient_endurance: '耐力不足',
    cannot_disengage: '还没有安全的脱离窗口',
  };
  return labels[reason] ?? String(reason).replaceAll('_', ' ');
}

function describeTacticalEvent(event) {
  if (!event || typeof event !== 'object') return '战况已更新。';
  if (event.type === 'player_action') {
    const label = tacticalActionFallbacks.find((action) => action.id === event.actionId)?.label ?? '行动';
    const result = event.success ? '成功' : '失手';
    const kills = Number(event.zombieKills) > 0 ? `，击倒 ${Math.round(event.zombieKills)} 只` : '';
    return `${label}${result}${kills}。`;
  }
  if (event.type === 'zombie_response') {
    const response = {
      closing: '尸群继续逼近。',
      grabbed: `你被 ${Math.max(1, Math.round(Number(event.grabbedBy) || 1))} 只丧尸抓住。`,
      hit: '尸群突破站位并造成伤害。',
      wounded: '尸群扑咬造成了新的流血伤口。',
      stumbled: '你在反扑中踉跄失衡。',
      evaded: '你避开了这一轮扑咬。',
    }[event.outcome];
    return response ?? '尸群作出反应，你的站位与压力发生变化。';
  }
  const labels = {
    zombie_killed: '一只丧尸失去行动能力。',
    player_hit: '你在交锋中受伤。',
    weapon_wear: '主手武器在使用中损耗。',
    reload: '弹药已装填。',
  };
  return labels[event.type] ?? event.description ?? event.type ?? '战况已更新。';
}

function formatTacticalResult(result, action) {
  if (typeof result === 'string') return result;
  if (result?.message) return result.message;
  if (result?.summary) return typeof result.summary === 'string' ? result.summary : action.estimatedOutcome;
  if (Array.isArray(result?.events) && result.events.length) return describeTacticalEvent(result.events[result.events.length - 1]);
  return `${action.label}已结算，战况与消耗已同步。`;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteRoundedOrNull(value) {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, Math.round(number));
}

function formatNumber(value) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
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

function itemName(id) {
  return marketItems.find((item) => item.id === id)?.name ?? id;
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
