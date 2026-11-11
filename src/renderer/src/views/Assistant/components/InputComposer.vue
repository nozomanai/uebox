<template>
  <div class="input-composer-shell">
    <!--
      排着队等下一轮的跟进消息，贴在输入框顶边，像别在本子上的便签。
      放在输入框**外面**：它是「已经交出去、但还没发生」的东西，和框里那些
      「还在手上、跟着这次发送一起走」的字和附件不是一类，塞在框里用户分不清
      哪条已经算数了。
      多条时只露队头（下一条就发它），其余收成「还有 N 条」，免得把输入框顶得老高。
    -->
    <div v-if="queuedFollowUps.length > 0" class="queued-tray">
      <div v-for="item in visibleQueued" :key="item.id" class="queued-item">
        <span class="queued-label">
          <PhClock />
          {{ t('assistantInputComposer.queueLabel') }}
        </span>
        <span class="queued-text" :title="item.text">{{ item.text }}</span>
        <!--
          排上之后随时能改主意：用户看着 agent 正往错的方向跑，这会儿
          「等你跑完」正是他不想要的。
          带不走的附件（Excel、PDF、@ 来源）那条不给这个按钮，点下去东西会静悄悄
          少一半。图能带走，只贴了图的那条照给。
        -->
        <button v-if="item.canSteer" class="queued-steer" @click.stop="handleSteerQueued(item.id)">
          {{ t('assistantInputComposer.queueSteerNow') }}
        </button>
        <!-- 改：退回输入框重新编辑。只有纯文字的那条给 —— 附件放不回去，退回去等于丢了 -->
        <AppTooltip v-if="item.canEdit" :title="t('assistantInputComposer.queueEdit')">
          <button
            class="queued-icon-btn"
            :aria-label="t('assistantInputComposer.queueEdit')"
            @click.stop="handleEditQueued(item.id, item.text)"
          >
            <PhPencilSimple />
          </button>
        </AppTooltip>
        <AppTooltip :title="t('assistantInputComposer.queueCancel')">
          <button
            class="queued-icon-btn"
            :aria-label="t('assistantInputComposer.queueCancel')"
            @click.stop="handleCancelQueued(item.id)"
          >
            <PhX />
          </button>
        </AppTooltip>
      </div>
      <button
        v-if="queuedFollowUps.length > 1"
        class="queued-more"
        @click.stop="queuedExpanded = !queuedExpanded"
      >
        {{
          queuedExpanded
            ? t('assistantInputComposer.queueCollapse')
            : t('assistantInputComposer.queueMore', { count: queuedFollowUps.length - 1 })
        }}
      </button>
    </div>

    <div
      class="input-composer"
      :class="{ 'drag-over': isDragging }"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <!-- 图片预览区域 -->
      <div v-if="pendingImages.length > 0" class="image-preview-row">
        <div v-for="(img, index) in pendingImages" :key="index" class="image-preview-item">
          <img
            :src="img.preview"
            alt="preview"
            class="preview-img"
            @click="openImagePreview(img)"
          />
          <div v-if="img.uploading" class="upload-overlay">
            <PhCircleNotch class="icon-spin" />
          </div>
          <PhXCircle weight="fill" class="remove-btn" @click="removeImage(index)" />
        </div>
      </div>

      <!-- 附件预览：Excel、文档、音视频，和发出去后气泡上的是同一张卡片 -->
      <div
        v-if="pendingExcelFiles.length > 0 || pendingDocFiles.length > 0"
        class="attachment-preview-row"
      >
        <AttachmentCard
          v-for="(excel, index) in pendingExcelFiles"
          :key="`excel-${index}`"
          :file-name="excel.fileName"
          kind="excel"
          :row-count="excel.rowCount"
          :busy="excel.parsing"
          :error="excel.error"
          removable
          @remove="removeExcelFile(index)"
        />
        <AttachmentCard
          v-for="(doc, index) in pendingDocFiles"
          :key="`doc-${index}`"
          :file-name="doc.fileName"
          :kind="docKind(doc)"
          :busy="doc.parsing || doc.uploading"
          :note="doc.statusNote"
          :error="doc.error"
          removable
          @remove="removeDocFile(index)"
        />
      </div>

      <!-- 知识库 @ 提及：已选来源标签（多选） -->
      <div v-if="mentionedSources.length > 0" class="mentioned-source-row">
        <div v-for="source in mentionedSources" :key="source.id" class="source-pill">
          <div class="pill-icon">
            <component :is="getSourceIcon(source.type)" />
          </div>
          <span class="pill-title">{{ source.title }}</span>
          <button class="pill-remove" @click.stop="handleRemoveMention(source.id)">
            <PhX />
          </button>
        </div>
      </div>

      <div v-if="props.boundNotebook && !notebookMode" class="bound-wiki-row">
        <div class="source-pill wiki-pill">
          <div class="pill-icon">
            <PhFileText />
          </div>
          <span class="pill-title">Wiki: {{ props.boundNotebook.title }}</span>
          <button class="pill-remove" @click.stop="handleClearBoundWiki">
            <PhX />
          </button>
        </div>
      </div>

      <!-- 知识库 @ 提及：来源选择弹出层 -->
      <Transition name="popover-fade">
        <div v-if="showMentionPopover" class="source-mention-popover">
          <div class="popover-header">
            <span class="header-title">{{ t('assistantInputComposer.mentionPopover.title') }}</span>
            <span class="header-hint">{{ t('assistantInputComposer.mentionPopover.hint') }}</span>
          </div>
          <!-- 什么都没打、也没有知识库来源可推荐：告诉用户该干什么，
             而不是甩一句「暂无来源」让他以为功能坏了 -->
          <div v-if="!hasMentionCandidates && !searchingNotes" class="empty-state">
            <span>
              {{
                mentionQuery
                  ? t('assistantInputComposer.mentionPopover.noMatch')
                  : t('assistantInputComposer.mentionPopover.typeToSearch')
              }}
            </span>
          </div>
          <div v-else class="source-list">
            <!-- 知识库来源：只有知识库的对话栏会有，按下 @ 就列出来 -->
            <template v-if="availableNotebookSources.length > 0">
              <div class="source-group-label">
                {{ t('assistantInputComposer.mentionPopover.groupSources') }}
              </div>
              <div
                v-for="source in availableNotebookSources"
                :key="source.id"
                class="source-item"
                :class="{ selected: isSourceSelected(source.id) }"
                @click="handleSourceSelect(source)"
              >
                <div class="source-icon">
                  <component :is="getSourceIcon(source.type)" />
                </div>
                <div class="source-info">
                  <div class="source-title">{{ source.title }}</div>
                  <div class="source-type">{{ getSourceTypeLabel(source.type) }}</div>
                </div>
                <div v-if="isSourceSelected(source.id)" class="check-mark">✓</div>
              </div>
            </template>

            <!-- 笔记：打了关键词才搜得出来 -->
            <template v-if="searchingNotes || noteMatches.length > 0">
              <div class="source-group-label">
                {{ t('assistantInputComposer.mentionPopover.groupNotes') }}
                <PhCircleNotch v-if="searchingNotes" class="icon-spin" />
              </div>
              <div
                v-for="note in noteMatches"
                :key="note.id"
                class="source-item"
                :class="{ selected: isSourceSelected(note.id) }"
                @click="handleSourceSelect(note)"
              >
                <div class="source-icon">
                  <PhNotePencil />
                </div>
                <div class="source-info">
                  <div class="source-title">{{ note.title }}</div>
                  <div class="source-type">
                    {{ t('assistantInputComposer.mentionPopover.noteLabel') }}
                  </div>
                </div>
                <div v-if="isSourceSelected(note.id)" class="check-mark">✓</div>
              </div>
            </template>
          </div>
        </div>
      </Transition>

      <Transition name="popover-fade">
        <div v-if="showWikiPopover" class="source-mention-popover wiki-popover">
          <div class="popover-header">
            <span class="header-title">{{ t('assistantInputComposer.wikiPopover.title') }}</span>
            <span class="header-hint">{{ t('assistantInputComposer.wikiPopover.hint') }}</span>
          </div>
          <div v-if="loadingWikiOptions" class="empty-state">
            <PhCircleNotch class="icon-spin" />
          </div>
          <div v-else-if="filteredWikiOptions.length === 0" class="empty-state">
            <span>{{ t('assistantInputComposer.wikiPopover.empty') }}</span>
          </div>
          <div v-else class="source-list">
            <div
              v-for="wiki in filteredWikiOptions"
              :key="wiki.notebookId"
              class="source-item"
              :class="{ selected: props.boundNotebook?.notebookId === wiki.notebookId }"
              @click="handleSelectWiki(wiki)"
            >
              <div class="source-icon">
                <PhFileText />
              </div>
              <div class="source-info">
                <div class="source-title">{{ wiki.title }}</div>
                <div class="source-type">
                  {{
                    t('assistantInputComposer.wikiPopover.sourceCount', {
                      count: wiki.sourceCount || 0
                    })
                  }}
                </div>
              </div>
              <div v-if="props.boundNotebook?.notebookId === wiki.notebookId" class="check-mark">
                <PhCheck />
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <Transition name="popover-fade">
        <SkillCommandMenu
          v-if="skillMenuVisible"
          ref="skillCommandMenuRef"
          :skills="installedSkills"
          :query="skillQuery ?? ''"
          :loading="loadingSkills"
          :error="skillLoadError"
          :show-attach="plusMenuOpen && skillQuery === null"
          :show-commands="skillCommandsEnabled"
          @select="handleSelectSkill"
          @select-command="handleSelectCommand"
          @attach="handleMenuAttach"
          @retry="loadSkills"
          @close="closeSkillMenu"
        />
      </Transition>

      <div class="placeholder-row">
        <button
          v-if="isImageGenerationMode"
          type="button"
          class="tool-indicator image-mode"
          :title="t('assistant.composer.exitImageGen')"
          aria-pressed="true"
          @click="emit('cancel-image-generation')"
        >
          <PhImage /> {{ t('assistant.composer.imageGen') }}
        </button>
        <button
          v-if="isGoalMode"
          type="button"
          class="tool-indicator goal-mode"
          :title="t('assistant.composer.exitGoalMode')"
          aria-pressed="true"
          @click="cancelGoalMode"
        >
          <PhTarget /> {{ t('assistant.composer.goalMode') }}
        </button>
        <button
          v-if="isTeamMode"
          type="button"
          class="tool-indicator goal-mode"
          :title="t('assistant.composer.exitTeamMode')"
          aria-pressed="true"
          @click="cancelTeamMode"
        >
          <PhUsersThree /> {{ t('assistant.composer.teamMode') }}
        </button>
        <a-textarea
          ref="textareaRef"
          v-model:value="composerContent"
          :placeholder="
            mentionedSources.length > 0
              ? t('assistantInputComposer.placeholderMentioned', { count: mentionedSources.length })
              : placeholderText
          "
          :bordered="false"
          :auto-size="{ minRows: 1, maxRows: 10 }"
          aria-autocomplete="list"
          aria-controls="assistant-skill-command-menu"
          :aria-expanded="skillMenuVisible"
          spellcheck="false"
          @keydown="handleKeydown"
          @blur="plusMenuOpen = false"
          @paste="handlePaste"
          @click="handleTextareaClick"
          @contextmenu.prevent="handleContextMenu"
        />
      </div>

      <div class="tools-row">
        <div class="left-tools">
          <!-- 知识库 @ 按钮（仅在知识库模式下显示） -->
          <AppTooltip
            v-if="notebookMode"
            :title="
              availableNotebookSources.length === 0
                ? t('assistantInputComposer.mentionPopover.empty')
                : t('assistantInputComposer.atMentionTooltip')
            "
          >
            <AppButton
              class="at-btn"
              :class="{
                disabled: availableNotebookSources.length === 0,
                active: mentionedSources.length > 0
              }"
              shape="circle"
              size="small"
              :disabled="availableNotebookSources.length === 0"
              @click="handleAtClick"
            >
              <span class="at-symbol">@</span>
            </AppButton>
          </AppTooltip>
          <!--
            「+」= 不用打 `/` 也能打开的那张命令与技能面板，顶上多一条「添加文件」。
            mousedown 不抢焦点：输入框一失焦面板就收起，按钮自己再点就成了开了又关。
          -->
          <AppTooltip :title="t('assistantInputComposer.skillMenu.plusTooltip')">
            <button
              type="button"
              class="plus-btn"
              :class="{ active: plusMenuOpen }"
              :aria-label="t('assistantInputComposer.skillMenu.plusTooltip')"
              :aria-expanded="plusMenuOpen"
              aria-controls="assistant-skill-command-menu"
              @mousedown.prevent
              @click="togglePlusMenu"
            >
              <PhPlus />
            </button>
          </AppTooltip>
          <input ref="fileInputRef" type="file" multiple hidden @change="handleFileSelect" />
          <!--
          审批策略。这是现在唯一的「让它别乱动」开关 —— 老的 Chat 模式已经删了，
          要纯对话就把审批档位调严，写操作到不了工程上。
        -->
          <div
            v-click-outside="closeApprovalDropdown"
            class="mode-selector approval-selector"
            :class="{ 'is-yolo': permissionMode === 'yolo' }"
            @keydown.esc.stop.prevent="dismissModeDropdown($event, closeApprovalDropdown)"
          >
            <!--
            触发器上**不要挂 tooltip**：下拉面板是往上弹的，tooltip 正好压在它
            上面，把选项的点击整个吃掉（真机验证时就是卡在这里）。
            而且每一档在面板里本来就有一行说明，再加一层浮层是重复。
          -->
            <AppButton
              variant="text"
              size="small"
              class="mode-trigger"
              :aria-expanded="showApprovalDropdown"
              :aria-label="currentApprovalConfig.label"
              :title="currentApprovalConfig.label"
              @click="toggleApprovalDropdown"
            >
              <component :is="currentApprovalConfig.icon" class="approval-trigger-icon" />
              <span class="mode-trigger-label">{{ currentApprovalConfig.label }}</span>
              <PhCaretDown class="mode-trigger-arrow" :class="{ open: showApprovalDropdown }" />
              <span class="mode-trigger-glow" />
            </AppButton>
            <Transition name="mode-dropdown">
              <div v-if="showApprovalDropdown" class="mode-dropdown approval-dropdown">
                <button
                  v-for="opt in approvalOptions"
                  :key="opt.value"
                  type="button"
                  class="mode-option"
                  :class="{ active: permissionMode === opt.value }"
                  :aria-pressed="permissionMode === opt.value"
                  @click="selectApproval(opt.value, $event)"
                >
                  <div
                    class="mode-option-icon-wrap"
                    :class="{ active: permissionMode === opt.value }"
                  >
                    <component :is="opt.icon" />
                  </div>
                  <div class="mode-option-text">
                    <span class="mode-option-name">{{ opt.label }}</span>
                    <span class="mode-option-desc">{{ opt.desc }}</span>
                  </div>
                  <div v-if="permissionMode === opt.value" class="mode-option-check">
                    <PhCheck />
                  </div>
                </button>
              </div>
            </Transition>
          </div>

          <!--
          思考程度。Chat 与 Agent 两种模式都走同一个内核，所以不像审批策略那样
          限定在 Agent —— 两边都用得上。
        -->
          <div
            v-click-outside="closeThinkingDropdown"
            class="mode-selector thinking-selector"
            @keydown.esc.stop.prevent="dismissModeDropdown($event, closeThinkingDropdown)"
          >
            <AppButton
              variant="text"
              size="small"
              class="mode-trigger"
              :aria-expanded="showThinkingDropdown"
              :aria-label="thinkingTriggerTitle"
              :title="thinkingTriggerTitle"
              @click="toggleThinkingDropdown"
            >
              <PhLightbulb class="thinking-trigger-icon" />
              <span class="mode-trigger-label">{{ currentThinkingLabel }}</span>
              <PhLightning v-if="fastModeOn" class="fast-mode-icon" weight="fill" />
              <PhCaretDown class="mode-trigger-arrow" :class="{ open: showThinkingDropdown }" />
              <span class="mode-trigger-glow" />
            </AppButton>
            <Transition name="mode-dropdown">
              <div v-if="showThinkingDropdown" class="mode-dropdown thinking-dropdown">
                <button
                  v-for="opt in thinkingOptions"
                  :key="opt.value"
                  type="button"
                  class="mode-option"
                  :class="{ active: thinkingLevel === opt.value }"
                  :aria-pressed="thinkingLevel === opt.value"
                  @click="selectThinkingLevel(opt.value, $event)"
                >
                  <span class="thinking-level-name">
                    {{ opt.label }}
                    <!-- 厂商给这一档起了别名时，把档位原名跟在后面 —— 用户在
                       官方文档或别的客户端里看到的是原名 -->
                    <span v-if="opt.original" class="thinking-alias">({{ opt.original }})</span>
                  </span>
                  <span class="mode-option-desc">{{ opt.desc }}</span>
                  <div v-if="thinkingLevel === opt.value" class="mode-option-check">
                    <PhCheck />
                  </div>
                </button>
                <!--
                选的档位当前模型没有时，内核会夹到最近的一档。不说出来的话
                这一行一个勾都没有，用户不知道自己这次到底跑在哪一档。
              -->
                <div v-if="thinkingClamped" class="mode-dropdown-note">
                  {{
                    t('assistantInputComposer.thinking.clamped', {
                      chosen: thinkingLevel,
                      actual: effectiveThinkingLevel,
                      model: thinkingSupport?.modelId ?? ''
                    })
                  }}
                </div>
                <!-- 「快速」只有支持的模型才露出来（Codex / Cursor Composer·Grok），见 supportsFastMode -->
                <button
                  v-if="thinkingSupport?.fastMode"
                  type="button"
                  class="mode-option fast-mode-option"
                  :class="{ active: fastModeOn }"
                  :aria-pressed="fastModeOn"
                  @click="aiConfigStore.setAgentFastMode(!fastModeOn)"
                >
                  <span class="thinking-level-name">
                    <PhLightning class="fast-mode-icon" weight="fill" />
                    {{ t('assistantInputComposer.thinking.fast') }}
                  </span>
                  <span class="mode-option-desc">{{
                    t('assistantInputComposer.thinking.fastDesc')
                  }}</span>
                  <div v-if="fastModeOn" class="mode-option-check">
                    <PhCheck />
                  </div>
                </button>
                <template v-if="thinkingSupport?.contextTiers?.length">
                  <div class="mode-dropdown-section">
                    {{ t('assistantInputComposer.thinking.context') }}
                  </div>
                  <button
                    v-for="tier in thinkingSupport.contextTiers"
                    :key="tier"
                    type="button"
                    class="mode-option"
                    :class="{ active: cursorContextOn === tier }"
                    :aria-pressed="cursorContextOn === tier"
                    @click="selectCursorContext(tier)"
                  >
                    <span class="thinking-level-name">{{ formatContextTierLabel(tier) }}</span>
                    <span class="mode-option-desc">{{
                      t(`assistantInputComposer.thinking.context${tier}Desc`)
                    }}</span>
                    <div v-if="cursorContextOn === tier" class="mode-option-check">
                      <PhCheck />
                    </div>
                  </button>
                </template>
              </div>
            </Transition>
          </div>
        </div>

        <!-- 保持 grid 布局的占位元素 -->
        <div class="chips-placeholder"></div>

        <div class="right-tools">
          <!-- Agent 模型快捷切换：放在发送区左侧，切换后下一轮立即使用新绑定。 -->
          <div
            v-if="!isImageGenerationMode"
            ref="agentModelSelectorEl"
            v-click-outside="closeAgentModelDropdown"
            class="agent-model-selector"
          >
            <AppButton
              variant="text"
              size="small"
              class="mode-trigger agent-model-trigger"
              :disabled="modelSwitchDisabled"
              :loading="agentModelSaving"
              :aria-label="agentModelTriggerTitle"
              :title="agentModelTriggerTitle"
              aria-haspopup="menu"
              :aria-expanded="showAgentModelDropdown"
              @click="toggleAgentModelDropdown"
            >
              <template #icon><PhCpu class="agent-model-trigger-icon" /></template>
              <span class="mode-trigger-label agent-model-trigger-label">
                {{ currentAgentModelLabel }}
              </span>
              <PhCaretDown
                class="mode-trigger-arrow agent-model-trigger-caret"
                :class="{ open: showAgentModelDropdown }"
              />
              <span class="mode-trigger-glow" />
            </AppButton>
            <Transition name="mode-dropdown">
              <div
                v-if="showAgentModelDropdown"
                class="mode-dropdown agent-model-dropdown"
                :style="{ maxBlockSize: agentModelDropdownMaxHeight }"
                role="menu"
              >
                <div
                  v-if="agentModelLoading && !agentModelSettings"
                  class="mode-dropdown-note agent-model-status"
                  role="status"
                >
                  <PhCircleNotch class="icon-spin" />
                  {{ t('assistantInputComposer.model.loading') }}
                </div>
                <button
                  v-else-if="agentModelLoadError && !agentModelSettings"
                  type="button"
                  class="mode-option agent-model-retry"
                  @click="loadAgentModels"
                >
                  {{ t('assistantInputComposer.model.loadFailed') }}
                </button>
                <template v-else-if="agentModelCatalog?.groups.length === 0">
                  <div class="mode-dropdown-note agent-model-status" role="status">
                    {{ t('assistantInputComposer.model.empty') }}
                  </div>
                  <button
                    type="button"
                    class="mode-option agent-model-settings"
                    role="menuitem"
                    @click="openModelSettings"
                  >
                    {{ t('assistantInputComposer.model.configure') }}
                  </button>
                </template>
                <template v-else>
                  <div
                    v-for="group in agentModelCatalog?.groups ?? []"
                    :key="group.providerId"
                    class="agent-model-group"
                    role="group"
                  >
                    <div class="agent-model-group-title">{{ group.providerName }}</div>
                    <button
                      v-for="option in group.options"
                      :key="option.key"
                      type="button"
                      class="mode-option agent-model-option"
                      :class="{ active: option.key === selectedAgentModelKey }"
                      role="menuitemradio"
                      :aria-checked="option.key === selectedAgentModelKey"
                      :title="option.description"
                      @click="selectAgentModel(option)"
                    >
                      <span class="agent-model-option-name">{{ option.modelName }}</span>
                      <span v-if="option.badge" class="agent-model-option-badge">
                        {{ option.badge }}
                      </span>
                      <span
                        v-if="option.modelName !== option.modelId"
                        class="mode-option-desc agent-model-option-id"
                      >
                        {{ option.modelId }}
                      </span>
                      <span v-if="option.key === selectedAgentModelKey" class="mode-option-check">
                        <PhCheck />
                      </span>
                    </button>
                  </div>
                </template>
              </div>
            </Transition>
          </div>
          <AppTooltip v-if="byokConfigured" placement="top">
            <template #title>
              <span>{{ t('assistantInputComposer.byokEnabled') }}</span>
            </template>
            <span class="byok-indicator" :aria-label="t('assistantInputComposer.byokEnabled')">
              <PhSliders />
            </span>
          </AppTooltip>
          <!--
          上下文用量。外面只有一个圆环，不带文字 —— 输入框那一排已经够挤了。
          悬停看详情，**点一下直接压缩**（不用再点第二个按钮）。
        -->
          <AppTooltip
            v-if="contextUsage"
            placement="top"
            overlay-class-name="context-usage-tip"
            :mouse-enter-delay="0.15"
          >
            <template #title>
              <div class="context-tip">
                <div class="context-tip-head">
                  <span>{{ t('assistantInputComposer.contextTitle') }}</span>
                  <span class="context-tip-value">
                    {{ formatTokens(contextUsage.tokens) }} /
                    {{ formatTokens(contextUsage.contextWindow) }}（{{ contextUsageLabel }}）
                  </span>
                </div>
                <div class="context-tip-track">
                  <div
                    class="context-tip-fill"
                    :class="{ high: contextUsagePercent >= 80 }"
                    :style="{ width: `${Math.max(contextUsagePercent, 1.5)}%` }"
                  />
                </div>
              </div>
            </template>
            <button
              type="button"
              class="context-ring"
              :class="{ high: contextUsagePercent >= 80, busy: compacting }"
              :disabled="compacting || props.isGenerating"
              :aria-label="contextUsageText"
              @click="handleCompact"
            >
              <svg viewBox="0 0 20 20" width="18" height="18">
                <circle class="context-ring-track" cx="10" cy="10" r="8" />
                <!--
                从 12 点开始顺时针：默认起点在 3 点，转 -90° 才符合"进度条"的直觉。
                dasharray 用整圈周长，dashoffset 按百分比留白。
              -->
                <circle
                  class="context-ring-fill"
                  cx="10"
                  cy="10"
                  r="8"
                  :stroke-dasharray="RING_CIRCUMFERENCE"
                  :stroke-dashoffset="ringOffset"
                  transform="rotate(-90 10 10)"
                />
              </svg>
            </button>
          </AppTooltip>
          <!--
          实时语音。点开就一直听着，说完模型直接答；要动 UE 时它会把指令
          交给现有的 Agent 链路跑（确认框、撤销栈都还在）。
        -->
          <AppTooltip
            v-if="!props.isGenerating || voiceVisible"
            placement="top"
            :title="
              props.voice.connecting.value
                ? t('assistantInputComposer.voice.cancelConnection')
                : props.voice.active.value
                  ? t('assistantInputComposer.voice.stop')
                  : t('assistantInputComposer.voice.start')
            "
          >
            <!--
            圆环画在按钮外面，不画在按钮里 —— 通话阶段（连接 / 在听 / 在想 /
            在调工具 / 在说）由它一个人交代，按钮只管颜色和按下去的手感。
            连接中不再换成 spinner 图标：麦克风图标一直在，外面的环负责表示在忙。
          -->
            <span class="voice-slot">
              <VoiceRing :phase="props.voice.phase.value" :level="props.voice.outputLevel.value" />
              <AppButton
                shape="circle"
                class="voice-btn"
                :class="{ live: props.voice.active.value }"
                :aria-label="
                  props.voice.connecting.value
                    ? t('assistantInputComposer.voice.cancelConnection')
                    : props.voice.active.value
                      ? t('assistantInputComposer.voice.stop')
                      : t('assistantInputComposer.voice.start')
                "
                :aria-pressed="props.voice.active.value"
                @click="toggleVoice"
              >
                <template #icon>
                  <PhMicrophone />
                </template>
              </AppButton>
            </span>
          </AppTooltip>
          <!--
          停止任务和挂断通话分别保留入口：挂断后后台任务仍会继续。

          跑着的时候输入框一有东西，这颗就从「停止」换回「发送」：人刚打完一句话，
          手边这颗最该是发出去，不是把正在跑的那一轮掐了。清空输入框才退回红色停止。
        -->
          <AppButton
            v-if="props.isGenerating && !canSendFollowUp"
            variant="primary"
            shape="circle"
            class="stop-btn"
            :aria-label="t('assistantInputComposer.stopTask')"
            danger
            @click="handleStop"
          >
            <template #icon>
              <PhStop />
            </template>
          </AppButton>
          <AppButton
            v-else
            variant="primary"
            shape="circle"
            class="send-btn"
            :aria-label="canSendFollowUp ? followUpActionLabel : t('common.send')"
            :disabled="isSendDisabled"
            :loading="isUploading"
            @click="handlePrimaryAction"
          >
            <template #icon>
              <PhArrowUp v-if="!isUploading" />
            </template>
          </AppButton>
        </div>
      </div>

      <!-- 开启完全访问权限前的二次确认 -->
      <AppModal
        v-model:open="showFullAccessConfirm"
        hide-footer
        :width="480"
        centered
        class="full-access-modal"
      >
        <div class="full-access">
          <h3 class="full-access-title">
            <PhWarning />
            {{ t('assistantInputComposer.approval.confirmTitle') }}
          </h3>
          <p class="full-access-intro">{{ t('assistantInputComposer.approval.confirmIntro') }}</p>

          <div class="full-access-list">
            <div v-for="scope in fullAccessScopes" :key="scope.title" class="full-access-item">
              <component :is="scope.icon" class="full-access-icon" />
              <div class="full-access-text">
                <span class="full-access-item-title">{{ scope.title }}</span>
                <span class="full-access-item-desc">{{ scope.desc }}</span>
              </div>
            </div>
          </div>

          <p class="full-access-risk">{{ t('assistantInputComposer.approval.confirmRisk') }}</p>

          <div class="full-access-actions">
            <AppButton @click="showFullAccessConfirm = false">
              {{ t('assistantInputComposer.approval.confirmCancel') }}
            </AppButton>
            <AppButton danger @click="confirmFullAccess">
              <PhWarning />
              {{ t('assistantInputComposer.approval.confirmOk') }}
            </AppButton>
          </div>
        </div>
      </AppModal>

      <!-- 拖拽提示遮罩 -->
      <div v-if="isDragging" class="drag-overlay">
        <PhImage class="drag-icon" />
        <span>{{ t('assistant.composer.dropFilesHere') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, watch, onMounted, onUnmounted, onActivated, nextTick, toRaw } from 'vue'
import { useRouter } from 'vue-router'
import { agentV3API, type AgentV3SkillSummary } from '@/api/agentV3'
import assetNoteAPI from '@renderer/api/assetNote'
import { aiProviderAPI } from '@/api/aiProvider'
import {
  buildThinkingOptions,
  formatContextTierLabel,
  resolveEffectiveLevel,
  thinkingDisplayLabel,
  type AgentCursorContext,
  type ModelThinkingSupport
} from '../composables/thinkingLevels'
import { buildAgentModelCatalog, type AgentModelOption } from '../composables/agentModelSelection'
import type {
  AttachmentKind,
  ChatMediaFile,
  SteerAttachments
} from '../composables/turnAttachments'
import type { ExcelFileInfo } from '@renderer/store/modules/chatMessages'
import { objectStorageAPI } from '@renderer/api/objectStorage'
import { resolveFollowUpAction } from '../composables/followUpQueue'
import { resolveComposerKeyAction } from '../composables/sendShortcut'
import { formatTokenCount } from '../composables/tokenUsageFormat'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import { useAIConfigStore } from '@/store/modules/aiConfig'
import {
  PhArrowUp,
  PhCaretDown,
  PhChartBar,
  PhCheck,
  PhClock,
  PhCircleNotch,
  PhCpu,
  PhEye,
  PhFile,
  PhFileText,
  PhGlobe,
  PhImage,
  PhLightbulb,
  PhLightning,
  PhLink,
  PhMicrophone,
  PhNotePencil,
  PhPencilSimple,
  PhPlus,
  PhSealCheck,
  PhSliders,
  PhStop,
  PhTarget,
  PhUsersThree,
  PhWarning,
  PhX,
  PhXCircle,
  PhYoutubeLogo
} from '@phosphor-icons/vue'
import {
  MAX_IMAGE_DRAFT_BYTES,
  useChatSessionsStore,
  type BoundNotebook,
  type ChatImageDraft
} from '@/store/modules/chatSessions'
import {
  resolvePermissionMode,
  setPermissionMode,
  type ChatPermissionMode
} from '../composables/sessionPermissionMode'
import type { Component } from 'vue'
import {
  isImageFile,
  isFileSizeValid,
  extractImagesFromPaste,
  extractImagesFromDrop,
  getMaxImageSizeText,
  fileToBase64,
  uploadImage,
  compressImageToTarget
} from '@renderer/utils/imageUpload'
import { openImageViewer } from '@renderer/services/imageViewer'
import SkillCommandMenu from './SkillCommandMenu.vue'
import AttachmentCard from './AttachmentCard.vue'
import { pointerStillInside } from './dragBounds'
import { parseSkillSlashQuery, skillMention } from './skillCommands'
import { noteToMentionSource, parseMentionQuery, stripMentionQuery } from './mentionQuery'
import {
  buildGoalCommandDraft,
  buildTeamCommandDraft,
  matchRunCommand,
  parseGoalCommandDraft,
  parseTeamCommandDraft,
  slashCommandInsertion,
  type SlashCommand
} from './slashCommands'
import VoiceRing from './VoiceRing.vue'
import type { RealtimeVoiceState } from '../composables/useRealtimeVoice'
import { startVoiceIn } from '../composables/voiceAssistant'
import type { SettingsView } from '@core/shared/aiProvider'

type PendingImage = ChatImageDraft

/**
 * 知识库来源项接口
 */
interface NotebookSourceItem {
  id: string
  title: string
  type:
    | 'file'
    | 'link'
    | 'youtube'
    | 'bilibili'
    | 'text'
    | 'note'
    | 'video'
    | 'image'
    | 'ue-project'
    | 'wechat'
    | 'mp'
  content?: string
  sourceUrl?: string
  loading?: boolean
  error?: string | null
}

interface NotebookOption {
  notebookId: string
  title: string
  sourceCount?: number
}

const emit = defineEmits<{
  (
    e: 'send',
    payload: {
      content: string
      images: string[]
      imageFiles?: File[]
      forcedSources?: NotebookSourceItem[]
      excelContext?: string
      /** Excel 文件元数据，用于在 UserBubble 中显示 */
      excelFiles?: Array<{ fileName: string; rowCount?: number }>
      /** 文档与音视频的元数据，用于在 UserBubble 中显示 */
      docFiles?: Array<{ fileName: string; kind: 'document' | 'video' | 'audio' }>
      /** 音视频只带路径，由 agent 自己决定怎么看（见 `turnAttachments.ts`） */
      mediaFiles?: ChatMediaFile[]
      /** 内嵌文档（PDF base64 数据，供 Gemini 直接处理） */
      inlineDocuments?: Array<{ fileName: string; mimeType: string; base64Data: string }>
    }
  ): void
  (e: 'attach'): void
  /**
   * 执行一条不带参数的内置命令（菜单里的 `/image`，以及手动输入兼容的 `/compact`）。
   *
   * 命令本身在这个组件里认（面板选中、或者用户把它敲全了回车），
   * 但真正干活的东西在对话那一层 —— 所以只把命令名冒上去。
   */
  (e: 'run-command', name: string): void
  (e: 'create-image'): void
  (e: 'cancel-image-generation'): void
  (e: 'search-web'): void
  (e: 'stop'): void
  (e: 'toggle-agent-mode', value: boolean): void
  (e: 'toggle-ask-mode', value: boolean): void
  (e: 'bind-wiki', value: BoundNotebook): void
  (e: 'clear-bound-wiki'): void
  /** 图片数量变化事件，用于通知父组件调整布局高度 */
  (e: 'images-change', hasImages: boolean): void
  /**
   * 运行中插话改方向。
   *
   * 和 `send` 是两回事：`send` 开新一轮，插话是把话塞进**正在跑的那一轮**，
   * 当前步骤做完后 agent 会看到它再决定下一步 —— 不打断、不丢掉已经做完的部分。
   *
   * 图跟着一起走。**不会为它换模型**：这一轮用哪个模型在跑起来那一刻就定了，
   * 中途换等于把整段 prompt cache 作废。当前模型看不了图时它会照实说看不到。
   */
  (
    e: 'steer',
    payload: {
      text: string
      images: string[]
      attachments?: SteerAttachments
      /** 插话没成时调：把这次摘走的字和附件放回输入框 */
      restore: () => void
    }
  ): void
  /** 取消一条还排着的跟进消息 */
  (e: 'cancel-queued', id: string): void
  /** 排着的这条别等了，现在就插进正在跑的那一轮 */
  (e: 'steer-queued', id: string): void
}>()

const props = defineProps<{
  disabled?: boolean
  isImageGenerationMode?: boolean
  isGenerating?: boolean
  isAgentMode?: boolean
  /** 是否处于 Ask 模式（只读模式） */
  askMode?: boolean
  /** 是否隐藏模式切换芯片（开启对话后不允许切换模式） */
  hideChips?: boolean
  /** 知识库模式：启用 @ 提及功能 */
  notebookMode?: boolean
  /** 知识库来源列表 */
  notebookSources?: NotebookSourceItem[]
  boundNotebook?: BoundNotebook | null
  /** 当前对话 ID。用于查内核推来的真实上下文用量 */
  chatSid?: string
  /** 页面级的语音通话状态。不能由这个会随欢迎态切换而销毁的组件持有。 */
  voice: RealtimeVoiceState
  /**
   * 这条对话上还排着、等下一轮发出去的跟进消息。
   *
   * 队列本身归页面管（它要跨对话存活，而这个组件会随欢迎态切换销毁），
   * 这里只负责把它画出来、以及把「取消这一条」冒上去。
   */
  queuedFollowUps?: ReadonlyArray<{
    id: string
    text: string
    /** 能不能「现在插话」。带着插话通道送不走的附件（Excel、PDF、@ 来源）就不能 */
    canSteer: boolean
    /** 能不能退回输入框改。只有纯文字的能 —— 附件放不回输入框，退回去等于丢了 */
    canEdit: boolean
  }>
}>()

const localContent = ref('')
const { t } = useI18n()
const router = useRouter()
const aiConfigStore = useAIConfigStore()
const chatSessionsStore = useChatSessionsStore()
const content = computed<string>({
  get: () => (props.chatSid ? chatSessionsStore.getDraft(props.chatSid) : localContent.value),
  set: (value) => {
    if (props.chatSid) {
      chatSessionsStore.setDraft(props.chatSid, value)
    } else {
      localContent.value = value
    }
  }
})

const voiceVisible = computed(() => props.voice.connecting.value || props.voice.active.value)

/**
 * 输入框里的麦克风：**在眼前这条对话上开口**。
 *
 * 曾经在这儿直接开语音，对白全落到一条固定的「语音助手」对话里 ——
 * 用户在某条对话里点麦克风，本来是想接着眼前这段上下文往下聊，结果语音既看不见
 * 这条对话说过什么，说的话也不写在这儿。绑定见 `voiceAssistant.startVoiceIn`。
 */
function toggleVoice(): void {
  if (props.voice.active.value || props.voice.connecting.value) {
    void props.voice.stop()
    return
  }
  void startVoiceIn(props.chatSid || '')
}

const isImageGenerationMode = computed(() => !!props.isImageGenerationMode)
const goalCommandText = computed(() =>
  isImageGenerationMode.value ? null : parseGoalCommandDraft(content.value)
)
const isGoalMode = computed(() => goalCommandText.value !== null)
// `/team ` 同一个折法：命令前缀收成标签，输入框里只剩那一句话
const teamCommandText = computed(() =>
  isImageGenerationMode.value ? null : parseTeamCommandDraft(content.value)
)
const isTeamMode = computed(() => teamCommandText.value !== null)
const composerContent = computed<string>({
  get: () => goalCommandText.value ?? teamCommandText.value ?? content.value,
  set: (value) => {
    content.value = isGoalMode.value
      ? buildGoalCommandDraft(value)
      : isTeamMode.value
        ? buildTeamCommandDraft(value)
        : value
  }
})

function cancelGoalMode(): void {
  const objective = parseGoalCommandDraft(content.value)
  if (objective === null) return
  content.value = objective
}

function cancelTeamMode(): void {
  const objective = parseTeamCommandDraft(content.value)
  if (objective === null) return
  content.value = objective
}

const isAgentMode = computed(() => !!props.isAgentMode)
const notebookMode = computed(() => !!props.notebookMode)
const byokConfigured = computed(() => !!aiConfigStore.getEnabledOpenAICompatibleByok())
type SkillCommandMenuExposed = {
  onKeydown: (event: KeyboardEvent) => boolean
}

// 只读选项沿用现有 Ask 能力；父页面持有真正执行时读取的状态
const localAskMode = ref(!!props.askMode)
watch(
  () => props.askMode,
  (val) => {
    localAskMode.value = !!val
  }
)

// ==================== 审批策略 ====================
/**
 * 四档按「管得严 → 管得松」排。只读复用 Agent 的 Ask 模式，
 * 其余三档对应内核的 `ApprovalMode`。
 *
 * 默认是中间那档：全都问的话每一步写操作都要点一次，实际用不了；
 * 全放行又太危险。可撤销的自动放行、不可逆的仍然问，是唯一能长期开着的档。
 *
 * **档位跟着这条对话走**，不是全局的 —— 见 composables/sessionPermissionMode.ts。
 */
type AgentPermissionMode = ChatPermissionMode

const approvalOptions = [
  {
    value: 'read-only' as const,
    label: t('assistantInputComposer.approval.readOnlyLabel'),
    desc: t('assistantInputComposer.approval.readOnlyDesc'),
    icon: PhEye
  },
  {
    value: 'ask' as const,
    label: t('assistantInputComposer.approval.askLabel'),
    desc: t('assistantInputComposer.approval.askDesc'),
    icon: PhSealCheck
  },
  {
    value: 'auto-edit' as const,
    label: t('assistantInputComposer.approval.autoEditLabel'),
    desc: t('assistantInputComposer.approval.autoEditDesc'),
    icon: PhSliders
  },
  {
    value: 'yolo' as const,
    label: t('assistantInputComposer.approval.yoloLabel'),
    desc: t('assistantInputComposer.approval.yoloDesc'),
    icon: PhLightning
  }
]

const showApprovalDropdown = ref(false)
/**
 * 显示哪一档：**问这条对话**，不问全局设置。
 *
 * 没有 chatSid 的那些用法（还没落到某条对话上的输入框）退回旧行为：
 * 只读看本地状态，其余看设置页的默认档位。
 */
const permissionMode = computed<AgentPermissionMode>(() => {
  if (props.chatSid) return resolvePermissionMode(props.chatSid)
  return localAskMode.value ? 'read-only' : aiConfigStore.agentPermissionMode
})
const currentApprovalConfig = computed(
  () => approvalOptions.find((opt) => opt.value === permissionMode.value) ?? approvalOptions[2]
)

function toggleApprovalDropdown(): void {
  showApprovalDropdown.value = !showApprovalDropdown.value
}

function closeApprovalDropdown(): void {
  showApprovalDropdown.value = false
}

function dismissModeDropdown(event: Event, close: () => void): void {
  const selector = (event.currentTarget as HTMLElement).closest('.mode-selector')
  close()
  selector?.querySelector<HTMLButtonElement>('button.mode-trigger')?.focus()
}

const showFullAccessConfirm = ref(false)

/** 弹窗里逐条列出放开之后 AI 能做什么。写具体的能力，不写"等等" */
const fullAccessScopes = computed(() => [
  {
    icon: PhChartBar,
    title: t('assistantInputComposer.approval.confirmProject'),
    desc: t('assistantInputComposer.approval.confirmProjectDesc')
  },
  {
    icon: PhFile,
    title: t('assistantInputComposer.approval.confirmFile'),
    desc: t('assistantInputComposer.approval.confirmFileDesc')
  },
  {
    icon: PhLightning,
    title: t('assistantInputComposer.approval.confirmCommand'),
    desc: t('assistantInputComposer.approval.confirmCommandDesc')
  }
])

// ==================== Agent 模型快捷切换 ====================
const agentModelSettings = ref<SettingsView | null>(null)
const agentModelLoading = ref(false)
const agentModelSaving = ref(false)
const agentModelLoadError = ref(false)
const showAgentModelDropdown = ref(false)

/** 模型跟着对话走：这条对话绑过模型就显示它，没绑过（还没发过消息）显示全局默认 */
const sessionModel = computed(() =>
  props.chatSid ? chatSessionsStore.getModel(props.chatSid) : undefined
)
const agentModelCatalog = computed(() =>
  agentModelSettings.value
    ? buildAgentModelCatalog(agentModelSettings.value, sessionModel.value)
    : null
)
const selectedAgentModelKey = computed(() => agentModelCatalog.value?.selected?.key ?? null)
const currentAgentModelLabel = computed(() => {
  const catalog = agentModelCatalog.value
  if (catalog?.selected) return catalog.selected.modelName
  if (catalog?.binding) return catalog.binding.modelId
  return t('assistantInputComposer.model.select')
})
const agentModelTriggerTitle = computed(() => {
  if (props.isGenerating) return t('assistantInputComposer.model.busy')
  const label = agentModelCatalog.value?.selected?.fullLabel ?? currentAgentModelLabel.value
  return t('assistantInputComposer.model.current', { model: label })
})
const modelSwitchDisabled = computed(
  () => !!props.disabled || !!props.isGenerating || agentModelSaving.value
)

async function loadAgentModels(): Promise<void> {
  if (agentModelLoading.value) return
  agentModelLoading.value = true
  agentModelLoadError.value = false
  try {
    agentModelSettings.value = await aiProviderAPI.getSettings()
  } catch (error) {
    agentModelLoadError.value = true
    console.warn('[输入框] 读取 Agent 模型列表失败:', error)
  } finally {
    agentModelLoading.value = false
  }
}

// 欢迎页的输入框竖直居中，弹窗向上展开时 50vh 会顶出窗口，按触发器上方的实际空间收窄。
const agentModelSelectorEl = ref<HTMLElement | null>(null)
const agentModelDropdownMaxHeight = ref('50vh')

function syncAgentModelDropdownHeight(): void {
  const top = agentModelSelectorEl.value?.getBoundingClientRect().top
  if (top == null) return
  // 10px 是弹窗与触发器的间距，另外给窗口顶部留 16px 余量。
  const available = Math.max(160, top - 26)
  agentModelDropdownMaxHeight.value = `${Math.round(Math.min(available, window.innerHeight * 0.5))}px`
}

function toggleAgentModelDropdown(): void {
  showAgentModelDropdown.value = !showAgentModelDropdown.value
  if (showAgentModelDropdown.value) {
    syncAgentModelDropdownHeight()
    void loadAgentModels()
  }
}

function closeAgentModelDropdown(): void {
  showAgentModelDropdown.value = false
}

function openModelSettings(): void {
  closeAgentModelDropdown()
  void router.push({ path: '/preferences', query: { tab: 'models' } })
}

async function selectAgentModel(option: AgentModelOption): Promise<void> {
  const settings = agentModelSettings.value
  if (!settings || option.key === selectedAgentModelKey.value || agentModelSaving.value) return

  showAgentModelDropdown.value = false
  agentModelSaving.value = true
  try {
    // 先改这条对话，再改全局默认：别的对话各自绑着自己的模型不受影响，
    // 以后新开的对话从这个模型起步
    if (props.chatSid) {
      chatSessionsStore.setModel(props.chatSid, {
        providerId: option.providerId,
        modelId: option.modelId
      })
    }
    agentModelSettings.value = await aiProviderAPI.setAgentRole(
      {
        providerId: option.providerId,
        modelId: option.modelId
      },
      t('assistantInputComposer.model.switchFailed')
    )
    await loadThinkingSupport()
    message.success(t('assistantInputComposer.model.switched', { model: option.fullLabel }))
  } catch (error) {
    message.error(
      error instanceof Error ? error.message : t('assistantInputComposer.model.switchFailed')
    )
  } finally {
    agentModelSaving.value = false
  }
}

// ==================== 思考程度 ====================
/**
 * 档位清单**向内核现问**，不在这里写死 —— 各家模型声明的档位差得很远，
 * 写死会列出当前模型根本没有的档位。清单逻辑在 composables/thinkingLevels.ts，
 * 那边有测试守着。
 */
const thinkingSupport = ref<ModelThinkingSupport | null>(null)

/**
 * 档位名不翻译，只翻译右边那句说明 —— 档位是模型自己的词汇，
 * 用户在厂商文档和别的客户端里看到的就是 low / high / xhigh 这些词。
 */
const describeThinkingLevel = (level: AgentV3ThinkingLevel): string =>
  t(`assistantInputComposer.thinking.${level}Desc`)

const thinkingOptions = computed(() =>
  buildThinkingOptions(thinkingSupport.value, describeThinkingLevel)
)

const showThinkingDropdown = ref(false)
const thinkingLevel = computed(() => aiConfigStore.agentThinkingLevel)

/** 选的档位当前模型没有时，内核会夹到最近的一档 —— 界面得说出来 */
const effectiveThinkingLevel = computed(() =>
  resolveEffectiveLevel(thinkingLevel.value, thinkingSupport.value)
)
/** 开着、而且当前模型认这个开关，触发器上才亮那个闪电 */
const fastModeOn = computed(
  () => aiConfigStore.agentFastMode && thinkingSupport.value?.fastMode === true
)
/** 当前选中的 Cursor Context；无档位时忽略 */
const cursorContextOn = computed(() => {
  if (!thinkingSupport.value?.contextTiers?.length) return null
  const choice = aiConfigStore.agentCursorContext
  if (choice === 'auto') return '500k' satisfies AgentCursorContext
  return choice
})
function selectCursorContext(tier: '256k' | '500k'): void {
  aiConfigStore.setAgentCursorContext(tier)
}
const thinkingClamped = computed(() => effectiveThinkingLevel.value !== thinkingLevel.value)

/** 触发器上那个词。显示实际会用的那一档，不是用户存的那一档 */
const currentThinkingLabel = computed(() =>
  thinkingDisplayLabel(effectiveThinkingLevel.value, thinkingSupport.value)
)

/**
 * 触发器的 title / aria-label。
 *
 * 窄容器下标签会被折掉只剩图标（见样式里的 `@container`），那时候
 * 「这个灯泡是干嘛的」只能靠它回答；宽的时候它也不多余 ——
 * 标签上只有档位名，没说这是「思考程度」。
 */
const thinkingTriggerTitle = computed(
  () => `${t('assistantInputComposer.thinking.label')}：${currentThinkingLabel.value}`
)

/**
 * 问一次当前绑定的模型支持哪几档。
 *
 * 失败就保持 null（下拉列全集）——这只是为了画一个下拉，
 * 不该因为取不到清单就把输入框弄坏。
 */
async function loadThinkingSupport(): Promise<void> {
  try {
    thinkingSupport.value = await agentV3API.thinkingLevels(sessionModel.value)
  } catch (error) {
    console.warn('[输入框] 取思考档位清单失败，按全集显示:', error)
    thinkingSupport.value = null
  }
}

// 打开时才问：用户可能在设置页换了模型，缓存住的清单会是上一个模型的
function toggleThinkingDropdown(): void {
  showThinkingDropdown.value = !showThinkingDropdown.value
  if (showThinkingDropdown.value) void loadThinkingSupport()
}

onMounted(() => {
  void loadThinkingSupport()
  void loadAgentModels()
})

/*
 * 切到一条对话时认回它绑的模型。对话上没记（存量对话、分支出来的）但主进程
 * 执行记录里有，就抄过来 —— 不然下拉显示的是全局默认，和下一轮实际用的对不上。
 */
watch(
  () => props.chatSid,
  async (sid) => {
    if (!sid || chatSessionsStore.getModel(sid)) return
    const agentSessionId = chatSessionsStore.getAgentSessionId(sid)
    if (!agentSessionId) return
    const saved = await agentV3API.sessionModel(agentSessionId).catch(() => null)
    if (saved && props.chatSid === sid) chatSessionsStore.setModel(sid, saved)
  },
  { immediate: true }
)

// 换了对话或对话换了模型，思考档位清单得按新模型重问
watch(
  () => [sessionModel.value?.providerId, sessionModel.value?.modelId],
  () => void loadThinkingSupport()
)

onActivated(() => {
  void loadAgentModels()
})

function closeThinkingDropdown(): void {
  showThinkingDropdown.value = false
}

function selectThinkingLevel(level: AgentV3ThinkingLevel, event: Event): void {
  dismissModeDropdown(event, closeThinkingDropdown)
  aiConfigStore.setAgentThinkingLevel(level)
}

/**
 * 落到**这条对话**上，顺便记成「下次新对话的起步档位」。
 *
 * 没有 chatSid 时只记后者 —— 那种情况下没有对话可挂，而什么都不存
 * 等于这个下拉点了没反应。
 */
function applyPermissionMode(mode: AgentPermissionMode): void {
  localAskMode.value = mode === 'read-only'
  emit('toggle-ask-mode', mode === 'read-only')

  if (props.chatSid) {
    setPermissionMode(props.chatSid, mode)
    return
  }
  aiConfigStore.setAgentPermissionMode(mode)
}

function selectApproval(mode: AgentPermissionMode, event: Event): void {
  dismissModeDropdown(event, closeApprovalDropdown)
  // 放开全部权限之前再确认一次。不是走流程 —— 这一档意味着删除资产、
  // 执行 Python、改工程都不再问，用户得真的看清自己放开的是什么
  if (mode === 'yolo' && permissionMode.value !== 'yolo') {
    showFullAccessConfirm.value = true
    return
  }
  applyPermissionMode(mode)
}

function confirmFullAccess(): void {
  showFullAccessConfirm.value = false
  applyPermissionMode('yolo')
}

// v-click-outside 自定义指令
type ClickOutsideEl = HTMLElement & { _clickOutside: (e: Event) => void }
const vClickOutside = {
  mounted(el: HTMLElement, binding: { value: () => void }): void {
    const handler = (e: Event): void => {
      if (!el.contains(e.target as Node)) {
        binding.value()
      }
    }
    ;(el as ClickOutsideEl)._clickOutside = handler
    document.addEventListener('click', handler)
  },
  unmounted(el: HTMLElement): void {
    document.removeEventListener('click', (el as ClickOutsideEl)._clickOutside)
  }
}

// ==================== Token 估算 ====================
/**
 * 真实上下文用量。
 *
 * 取代原来那个渲染层估算：它只数屏幕上的消息，算不到系统提示词、77 个工具的
 * 定义、工具返回值和压缩后的摘要 —— 和模型真正看到的差着数量级。
 * 这里的数由内核在每轮组装上下文时算出来推给界面。
 *
 * 第一轮跑起来之前没有数据，那时**不显示**而不是显示一个估的数：
 * 宁可空着，也不要给一个会误导判断的数字。
 */
const contextUsage = computed(() =>
  props.chatSid ? chatSessionsStore.getContextUsage(props.chatSid) : undefined
)

const contextUsagePercent = computed(() => {
  const usage = contextUsage.value
  if (!usage || usage.contextWindow <= 0) return 0
  return Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100))
})

/**
 * 12345 → 12.3k，1000000 → 1M。
 *
 * 上下文动辄几万 token，原样铺开一排数字读不出量级；而百万窗口写成
 * 「1000k」既啰嗦又容易看错位数，厂商自己也都写 1M。
 *
 * 实现搬去了 `composables/tokenUsageFormat.ts` —— 回复下面的本轮用量要用同一套
 * 口径，两处各写一份的话早晚会一个显示 12.3k、另一个显示 12345。
 */
const formatTokens = formatTokenCount

/**
 * 芯片上那一小段文字。
 *
 * 百分比不足 1 时显示 `<1%` 而不是 `0%` —— 大窗口模型（Gemini 1M）聊上
 * 十几轮也才百分之几，一直显示 0% 会让人以为这个指示器坏了。
 */
const contextUsageLabel = computed(() => {
  const usage = contextUsage.value
  if (!usage) return ''
  if (contextUsagePercent.value < 1) return '<1%'
  return `${contextUsagePercent.value}%`
})

/** 记在 store 里按对话分开，切走标签页再回来还能看到「正在压」，见 `setCompacting` */
const compacting = computed(() =>
  props.chatSid ? chatSessionsStore.isCompacting(props.chatSid) : false
)

/** 圆环半径 8 的周长（2πr）。dasharray/dashoffset 都按它算 */
const RING_CIRCUMFERENCE = Number((2 * Math.PI * 8).toFixed(2))

/**
 * 圆环留白长度。
 *
 * 百分比很小时也留一小段可见的弧（下限 4%），否则 1% 的时候环上什么都看不到，
 * 用户分不清「刚开始」和「指示器坏了」。
 */
const ringOffset = computed(() => {
  const shown = Math.max(contextUsagePercent.value, 4)
  return ((100 - shown) / 100) * RING_CIRCUMFERENCE
})

/**
 * 手动压缩。
 *
 * 自动压缩只在快撑满时才动手，但用户常常**提前**就想压：一段探索跑完了、
 * 接下来换个方向，早期那堆试错留着只是占地方还让模型分心。
 */
async function handleCompact(): Promise<void> {
  // 先把对话定下来：压缩期间用户可能切到别的对话，await 回来再读 props.chatSid
  // 就会把新用量写到别人头上
  const chatSid = props.chatSid
  if (!chatSid || compacting.value) return
  const sessionId = chatSessionsStore.getAgentSessionId(chatSid)
  if (!sessionId) {
    message.warning(t('assistantInputComposer.compactNoSession'))
    return
  }

  chatSessionsStore.setCompacting(chatSid, true)
  try {
    const result = await window.api.agentV3.compact({ sessionId })
    if (!result.success) {
      // 主进程只回「哪一种情况」，措辞在这里。它写的是实现语言
      //（「最近这几轮本来就要完整保留」是在解释保留额度，不是在告诉用户
      // 该怎么办），而且绕过 i18n，英文界面会蹦出中文。
      const key = result.reason && result.reason !== 'error' ? result.reason : ''
      message.warning(
        key
          ? t(`assistantInputComposer.compactReason.${key}`)
          : result.error || t('assistantInputComposer.compactFailed')
      )
      return
    }

    // 压完立刻把指示器刷新到新值 —— 否则用户点了「压缩」，数字纹丝不动，
    // 只能怀疑是不是没生效（下一轮对话才会重新上报）
    if (result.tokensAfter !== undefined && result.contextWindow) {
      chatSessionsStore.setContextUsage(chatSid, {
        tokens: result.tokensAfter,
        contextWindow: result.contextWindow
      })
    }
    message.success(
      t('assistantInputComposer.compactDone', {
        before: formatTokens(result.tokensBefore ?? 0),
        after: formatTokens(result.tokensAfter ?? 0)
      })
    )
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    chatSessionsStore.setCompacting(chatSid, false)
  }
}

const contextUsageText = computed(() => {
  const usage = contextUsage.value
  if (!usage) return ''
  return t('assistantInputComposer.contextUsage', {
    used: formatTokens(usage.tokens),
    total: formatTokens(usage.contextWindow),
    percent: contextUsageLabel.value
  })
})

// ==================== 右键菜单 ====================
function handleContextMenu(): void {
  if (window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.send('app:show-input-context-menu', {
      cut: t('common.cut') || '剪切',
      copy: t('common.copy') || '复制',
      paste: t('common.paste') || '粘贴',
      selectAll: t('common.selectAll') || '全选'
    })
  }
}

// ==================== @ 提及相关状态 ====================
/** 当前选中的来源（多选） */
const mentionedSources = ref<NotebookSourceItem[]>([])
/** 是否显示来源选择弹出层 */
const showMentionPopover = ref(false)
/**
 * `@` 后面已经打了什么。null = 当前光标不在一次 @ 提及里。
 *
 * 知识库来源是「按下 @ 就推荐」，笔记不是 —— 笔记可能成百上千，
 * 一按 @ 就糊一屏没有意义，得等用户打出关键词再搜。
 */
const mentionQuery = ref<string | null>(null)
const noteMatches = ref<NotebookSourceItem[]>([])
const searchingNotes = ref(false)
const showWikiPopover = ref(false)
const loadingWikiOptions = ref(false)
const wikiOptions = ref<NotebookOption[]>([])
const skillCommandMenuRef = ref<SkillCommandMenuExposed | null>(null)
const installedSkills = ref<AgentV3SkillSummary[]>([])
const loadingSkills = ref(false)
const skillLoadError = ref('')
const showSkillMenu = ref(false)
/** 从「+」按钮打开的面板。输入框里不用有 `/`，所以不能跟着 skillQuery 走 */
const plusMenuOpen = ref(false)
const skillMenuVisible = computed(
  () => (showSkillMenu.value && skillQuery.value !== null) || plusMenuOpen.value
)

const skillCommandsEnabled = computed(
  () => !isImageGenerationMode.value && !props.disabled && !props.isGenerating
)
const skillQuery = computed(() =>
  skillCommandsEnabled.value ? parseSkillSlashQuery(content.value) : null
)

const wikiCommandQuery = computed(() => {
  const trimmed = content.value.trim()
  if (!trimmed.startsWith('/wiki')) {
    return ''
  }

  return trimmed.slice('/wiki'.length).trim()
})

const filteredWikiOptions = computed(() => {
  const query = wikiCommandQuery.value
  if (!query || query === 'clear') {
    return wikiOptions.value
  }

  const normalizedQuery = query.toLowerCase()
  return wikiOptions.value.filter((item) => item.title.toLowerCase().includes(normalizedQuery))
})

/**
 * 可供选择的知识库来源（过滤掉加载中和错误的）。
 *
 * 只有知识库的对话栏会把 sources 传进来，所以这一组在外面的助手页天然是空的 ——
 * 那正是想要的：知识库来源只属于那个知识库，不该在外面被推荐。
 */
const availableNotebookSources = computed(() => {
  const sources = (props.notebookSources || []).filter((s) => !s.loading && !s.error)
  const query = (mentionQuery.value || '').trim().toLowerCase()
  if (!query) return sources
  return sources.filter((s) => s.title.toLowerCase().includes(query))
})

/** 笔记要打了字才出现，所以空 query 时这一组一定是空的 */
const hasMentionCandidates = computed(
  () => availableNotebookSources.value.length > 0 || noteMatches.value.length > 0
)

/**
 * 一次 @ 提及至少要打几个字才去搜。
 * 一个字的候选面太大，搜出来也是噪声。
 */
const MIN_NOTE_QUERY_LENGTH = 1
const NOTE_SEARCH_DEBOUNCE_MS = 200
const NOTE_SEARCH_LIMIT = 8

let noteSearchTimer: ReturnType<typeof setTimeout> | null = null
let noteSearchRequestId = 0

function clearNoteSearch(): void {
  if (noteSearchTimer) {
    clearTimeout(noteSearchTimer)
    noteSearchTimer = null
  }
  noteSearchRequestId++
  noteMatches.value = []
  searchingNotes.value = false
}

function scheduleNoteSearch(query: string): void {
  if (noteSearchTimer) clearTimeout(noteSearchTimer)

  const keyword = query.trim()
  if (keyword.length < MIN_NOTE_QUERY_LENGTH) {
    clearNoteSearch()
    return
  }

  searchingNotes.value = true
  noteSearchTimer = setTimeout(async () => {
    const requestId = ++noteSearchRequestId
    try {
      const found = await assetNoteAPI.search(keyword, { limit: NOTE_SEARCH_LIMIT })
      // 用户还在打字，迟到的结果不该盖掉新的
      if (requestId !== noteSearchRequestId) return
      noteMatches.value = found.map((note) => noteToMentionSource(note, t('noteEditor.newNote')))
    } catch (error) {
      if (requestId !== noteSearchRequestId) return
      console.error('[InputComposer] 搜索笔记失败:', error)
      noteMatches.value = []
    } finally {
      if (requestId === noteSearchRequestId) searchingNotes.value = false
    }
  }, NOTE_SEARCH_DEBOUNCE_MS)
}

/**
 * 获取来源类型图标
 */
function getSourceIcon(type: string): Component {
  switch (type) {
    case 'link':
      return PhLink
    case 'youtube':
      return PhYoutubeLogo
    case 'bilibili':
      return PhGlobe
    case 'text':
      return PhFileText
    case 'file':
      return PhFile
    default:
      return PhGlobe
  }
}

/**
 * 获取来源类型标签
 */
function getSourceTypeLabel(type: string): string {
  switch (type) {
    case 'link':
      return t('assistantInputComposer.sourceType.link')
    case 'youtube':
      return 'YouTube'
    case 'bilibili':
      return t('assistantInputComposer.sourceType.bilibili')
    case 'text':
      return t('assistantInputComposer.sourceType.text')
    case 'file':
      return t('assistantInputComposer.sourceType.file')
    case 'ue-project':
      return t('assistantInputComposer.sourceType.ueProject')
    default:
      return type
  }
}

/**
 * 打开 @ 来源选择器
 */
function handleAtClick(): void {
  if (availableNotebookSources.value.length === 0) return
  showWikiPopover.value = false
  showMentionPopover.value = !showMentionPopover.value
}

/**
 * 选中来源（多选模式）
 */
function handleSourceSelect(source: NotebookSourceItem): void {
  // 检查是否已选中
  const isSelected = mentionedSources.value.some((s) => s.id === source.id)
  if (isSelected) {
    // 已选中则取消选中
    mentionedSources.value = mentionedSources.value.filter((s) => s.id !== source.id)
  } else {
    // 未选中则添加
    mentionedSources.value = [...mentionedSources.value, source]
  }
  showMentionPopover.value = false
  clearNoteSearch()
  content.value = stripMentionQuery(content.value)
  mentionQuery.value = null
}

async function ensureWikiOptionsLoaded(): Promise<void> {
  if (loadingWikiOptions.value || wikiOptions.value.length > 0) {
    return
  }

  loadingWikiOptions.value = true
  try {
    const notebooks = await window.api.notebook.list()
    wikiOptions.value = notebooks.map((item) => ({
      notebookId: item.notebookId,
      title: item.title,
      sourceCount: item.sourceCount || 0
    }))
  } catch (error) {
    console.error('[InputComposer] Failed to load notebooks for /wiki:', error)
    message.error(t('assistantInputComposer.toast.loadWikiFailed'))
  } finally {
    loadingWikiOptions.value = false
  }
}

async function openWikiPopover(): Promise<void> {
  await ensureWikiOptionsLoaded()
  showMentionPopover.value = false
  showWikiPopover.value = true
}

function handleSelectWiki(option: NotebookOption): void {
  emit('bind-wiki', {
    notebookId: option.notebookId,
    title: option.title
  })
  content.value = ''
  showWikiPopover.value = false
}

function handleClearBoundWiki(): void {
  if (notebookMode.value) return
  emit('clear-bound-wiki')
}

/**
 * `/wiki` 在知识库里没有意义 —— 它是「给这条对话绑一个知识库」，
 * 而知识库模式下当前这个库就是答案，再绑一个别的只会自相矛盾。
 *
 * 这是**场景差异**，不是能力阉割：附件、审批档位、思考程度、斜杠命令
 * 那些以前一并关掉的，现在都开着。
 */
function isWikiCommand(value: string): boolean {
  if (notebookMode.value) return false
  return value.trim().startsWith('/wiki')
}

/**
 * 检查来源是否已选中
 */
function isSourceSelected(sourceId: string): boolean {
  return mentionedSources.value.some((s) => s.id === sourceId)
}

/**
 * 移除选中的来源
 */
function handleRemoveMention(sourceId: string): void {
  mentionedSources.value = mentionedSources.value.filter((s) => s.id !== sourceId)
}

/**
 * 点击输入框：关闭弹层，但内容仍是 `/关键词` 时要恢复技能菜单。
 * 菜单只靠 watch(skillQuery) 打开，内容不变就不会再触发，
 * 不在这里补一次的话，点击重新聚焦后菜单就再也弹不出来。
 */
function handleTextareaClick(): void {
  plusMenuOpen.value = false
  showMentionPopover.value = false
  showWikiPopover.value = false
  showSkillMenu.value = skillQuery.value !== null
}

/**
 * 监听输入，驱动 @ 提及。
 *
 * 不再限定知识库模式 —— 外面的助手页也要能 @ 到自己写的笔记。两边的区别在
 * 「推荐什么」而不是「能不能用」：知识库来源由知识库的对话栏传进来，按下 @
 * 就列出来；笔记要打了关键词才搜。
 */
watch(content, (newVal) => {
  const query = parseMentionQuery(newVal)
  mentionQuery.value = query

  if (query === null) {
    showMentionPopover.value = false
    clearNoteSearch()
    return
  }

  showMentionPopover.value = true
  scheduleNoteSearch(query)
})

watch(content, (newVal) => {
  if (isWikiCommand(newVal)) {
    if (wikiCommandQuery.value !== 'clear') {
      void openWikiPopover()
    } else {
      showWikiPopover.value = false
    }
    return
  }

  if (showWikiPopover.value) {
    showWikiPopover.value = false
  }
})

async function loadSkills(): Promise<void> {
  if (loadingSkills.value) return

  loadingSkills.value = true
  skillLoadError.value = ''
  try {
    const result = await agentV3API.listSkills()
    // 用户在设置里关掉的不进这个菜单：选了它，agent 那边根本不会加载 ——
    // 菜单里摆着一条选了没用的技能，比不摆更糟
    installedSkills.value = result.skills.filter((skill) => skill.enabled)
  } catch (error) {
    console.error('[InputComposer] Failed to load skills for / menu:', error)
    skillLoadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loadingSkills.value = false
  }
}

function closeSkillMenu(): void {
  showSkillMenu.value = false
  plusMenuOpen.value = false
}

/**
 * 「+」面板里能不能挑技能。
 *
 * 比 `skillCommandsEnabled` 宽一档：正在生成时也能挑。技能就是插进草稿里的
 * 一个 `$名字`，跟着插话一起送进正在跑的那一轮照样管用；命令不行，
 * `/goal`、`/team` 这些只在开一轮新对话时才认，所以生成中面板里不列命令。
 */
const plusMenuSkillsEnabled = computed(() => !isImageGenerationMode.value && !props.disabled)

/**
 * 「+」打开面板。生成图片模式下技能和命令都用不上，面板里只剩「添加文件」
 * 一条，那就不必多弹一层，直接开文件选择器。
 */
function togglePlusMenu(): void {
  if (plusMenuOpen.value) {
    plusMenuOpen.value = false
    return
  }
  if (!plusMenuSkillsEnabled.value) {
    triggerFileInput()
    return
  }

  showMentionPopover.value = false
  showWikiPopover.value = false
  plusMenuOpen.value = true
  void loadSkills()
  focus()
}

function handleMenuAttach(): void {
  closeSkillMenu()
  triggerFileInput()
}

/**
 * 从「+」选的时候输入框里是用户已经写好的草稿，不能像 `/关键词` 那样整个换掉：
 * 前缀插到草稿前面。打 `/` 选的时候草稿就是那串 `/关键词`，丢掉正好。
 */
function draftAfterPick(): string {
  return plusMenuOpen.value ? content.value.trimStart() : ''
}

function handleSelectSkill(skill: AgentV3SkillSummary): void {
  content.value = skillMention(skill.name) + draftAfterPick()
  closeSkillMenu()

  focus()
}

/**
 * 选中一条内置命令。
 *
 * 带参数的（`/goal <目标>`）会保留 `/name ` 作为真实草稿，界面上折叠成模式标签；
 * 选中即执行会把「我在挑命令」和「我写完了」搅成一件事。
 * `/wiki` 属于这一档，它会顺势弹出自己的知识库选择层，那是 content 的 watcher 干的。
 *
 * 不带参数的（当前菜单里是 `/image`）当场执行：填进去再让用户按一次回车
 * 是白让他多按一下。
 */
function handleSelectCommand(command: SlashCommand): void {
  const draft = draftAfterPick()
  closeSkillMenu()

  if (command.kind === 'run') {
    content.value = draft
    emit('run-command', command.name)
    focus()
    return
  }

  content.value = slashCommandInsertion(command.name) + draft
  focus()
}

// 面板开着又接着打字：打的是 `/` 就交给下面那个 watcher 换成筛选，打别的就收起
watch(content, () => {
  plusMenuOpen.value = false
})

watch(skillQuery, (query, previousQuery) => {
  if (query === null) {
    showSkillMenu.value = false
    return
  }

  showMentionPopover.value = false
  showWikiPopover.value = false
  showSkillMenu.value = true
  if (previousQuery === null) void loadSkills()
})

// 图片草稿和文字一样按对话留在运行内存中；退出应用后自然释放，不写入持久层。
const localPendingImages = ref<PendingImage[]>([])
const pendingImages = computed<PendingImage[]>(() =>
  props.chatSid ? chatSessionsStore.getImageDraft(props.chatSid) : localPendingImages.value
)

function replacePendingImages(images: PendingImage[]): boolean {
  if (!props.chatSid) {
    localPendingImages.value = images
    return true
  }
  return chatSessionsStore.trySetImageDraft(props.chatSid, images)
}

const isDragging = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
// Ant Design 的 textarea 组件实例
const textareaRef = ref<{ $el?: HTMLElement } | null>(null)

// Excel 文件相关状态
interface PendingExcelFile {
  file: File
  fileName: string
  content?: string
  rowCount?: number
  parsing: boolean
  error?: string
}
const pendingExcelFiles = ref<PendingExcelFile[]>([])

/**
 * 对话里能直接拖进来的文档格式。
 *
 * 与主进程 documentLoader 的 ANYDOC_EXTENSIONS 同源 —— 那边解析得了、这边却
 * 默默忽略，用户只会以为拖拽坏了。xlsx/xls 不在此列：它们另有 Excel 分支。
 */
const CHAT_DOC_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'docm',
  'ppt',
  'pps',
  'pot',
  'pptx',
  'pptm',
  'ppsx',
  'ppsm',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  // 纯文本与表格：主进程 documentLoader 的 TEXT_EXTENSIONS 也认，
  // 拖进来却不收只会让人以为坏了
  'txt',
  'md',
  'markdown',
  'csv',
  'json'
])

/**
 * 能拖进对话的视频格式。与主进程 `videoFileAnalysis` 的 VIDEO_EXTENSION 同源。
 *
 * 它们不会被直接发给模型 —— 主进程先让视频模型看一遍，看不了就抽帧，
 * 进对话的是描述文字或联系表。见 `services/attachmentIngest.ts`。
 */
const CHAT_VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'])

/**
 * 音频。和视频走同一批模型 —— 能看视频的多模态模型基本都能听音频，
 * 厂商那边是同一套接口，只是请求分片不同（见 `configuredVideoAnalysis`）。
 * 所以用户勾一次「视频」能力，音视频都能用，不用再单勾一次。
 */
const CHAT_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'aiff'])

// 文档与视频的待处理状态。两者共用一条链路：都是「本地先解释成文本（或帧），再进对话」
interface PendingDocFile {
  file: File
  fileName: string
  /** 扩展名。模板据此选图标，`pdf` 用 PDF 图标，视频用胶片图标 */
  fileType: string
  /**
   * 磁盘上的绝对路径，用来认领主进程报上来的进度。
   *
   * 不能用文件名认：同名不同目录的两份（D:/a/clip.mp4 与 D:/b/clip.mp4）
   * 会互相串台 —— 第一条一直顶着第二条的进度，第二条一动不动。
   * 网页里拖来的 File 没有路径，那条本来也走不到进度回调。
   */
  filePath?: string
  /** 解析出的文本：文档是 Markdown，视频是模型写的描述或抽帧说明 */
  content?: string
  /** 视频抽帧兜底时产出的联系表（data URL），发送时并进图片列表 */
  extraImages?: string[]
  /** 正在做什么。视频那条要跑一阵，界面上得说清此刻卡在哪一步 */
  statusNote?: string
  /**
   * 音视频：拖进来只登记路径，不预先分析。路径随消息交给 agent，
   * 它会带着用户的问题自己去看（见 `turnAttachments.ts`）
   */
  deferredMedia?: 'video' | 'audio'
  /**
   * 正在传对象存储（配了才有）。不挡发送：发送时主进程会接上同一次上传
   */
  uploading?: boolean
  parsing: boolean
  error?: string
}
const pendingDocFiles = ref<PendingDocFile[]>([])

// 图片限制常量
const MAX_IMAGES = 5
const MAX_TOTAL_SIZE = 100 * 1024 * 1024 // 100MB - Gemini 3 Flash 支持大图片内嵌
const MAX_EXCEL_FILES = 3
const MAX_DOC_FILES = 3

/**
 * 监听图片列表变化，通知父组件调整布局高度
 */
watch(
  () => pendingImages.value.length,
  (newLen, oldLen = 0) => {
    // 仅在有无图片状态切换时触发
    if (newLen > 0 !== oldLen > 0) {
      emit('images-change', newLen > 0)
    }
  },
  { immediate: true }
)

// 计算属性
const isUploading = computed(() => pendingImages.value.some((img) => img.uploading))
const isParsingExcel = computed(() => pendingExcelFiles.value.some((f) => f.parsing))
const isSendDisabled = computed(() => {
  // 禁用条件：外部禁用、正在上传/解析、或者没有内容和附件
  if (props.disabled) return true
  if (isUploading.value || isParsingExcel.value) return true
  // 文档还在解析时发出去，那份会被悄悄漏掉 —— 等它好了再发
  if (pendingDocFiles.value.some((f) => f.parsing)) return true
  const hasContent = composerContent.value.trim().length > 0
  const hasImages = pendingImages.value.length > 0
  const hasExcel = pendingExcelFiles.value.some((f) => f.content && !f.error)
  const hasDocs = pendingDocFiles.value.some((f) => !f.error && (f.content || f.deferredMedia))
  return !hasContent && !hasImages && !hasExcel && !hasDocs
})

const placeholderText = computed(() => {
  // 生成中且能插话时换提示语：不换的话输入框看起来只是"还不能发"，
  // 用户不会想到这时候打的字会被送进正在跑的那一轮
  if (props.isGenerating && isAgentMode.value) {
    // 已经排着一条、又是排队档：再发的也是排在后面，照实说
    if (queuedFollowUps.value.length > 0 && followUpBehavior.value === 'queue') {
      return t('assistantInputComposer.placeholderQueued')
    }
    return t('assistant.composer.placeholderSteer')
  }
  if (isImageGenerationMode.value) {
    return t('assistant.composer.placeholderImage')
  }
  if (isAgentMode.value) {
    return t('assistant.composer.placeholderAgent')
  }
  if (pendingImages.value.length > 0) {
    return t('assistant.composer.placeholderImageChat')
  }
  return t('assistant.composer.placeholderDefault')
})

/**
 * 触发文件选择器
 */
function triggerFileInput(): void {
  fileInputRef.value?.click()
}

/**
 * 处理文件选择
 */
async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return

  await routeFiles(Array.from(files))

  // 清空 input 以便再次选择同一文件
  input.value = ''
}

/**
 * 按类型分派文件。选择器、拖拽、粘贴三条入口共用。
 *
 * **认不出的格式要出声**。这里从前是静默丢弃：用户拖一个 mp4 进来，
 * 没有提示、没有气泡，只看见什么都没发生，于是转头去问 AI「你为什么读不了」，
 * 而 AI 也不知道有文件来过。宁可弹一句「这个格式收不了」，也不要装作无事发生。
 *
 * 白名单外的格式也收：拿得到本地路径就只把路径交给模型，读不读得了是它的事
 * （见 `addDocFiles` 的「只给路径」那一支）。真正收不了的只剩网页里拖来、没有路径的。
 */
async function routeFiles(files: File[]): Promise<void> {
  const imageFiles: File[] = []
  const excelFiles: File[] = []
  const docFiles: File[] = []
  const rejected: string[] = []

  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'xlsx' || ext === 'xls') {
      excelFiles.push(file)
    } else if (
      CHAT_DOC_EXTENSIONS.has(ext) ||
      CHAT_VIDEO_EXTENSIONS.has(ext) ||
      CHAT_AUDIO_EXTENSIONS.has(ext)
    ) {
      docFiles.push(file)
    } else if (file.type.startsWith('image/')) {
      imageFiles.push(file)
    } else if (window.api.getPathForFile(file)) {
      docFiles.push(file)
    } else {
      rejected.push(file.name)
    }
  }

  if (rejected.length > 0) {
    message.warning(
      t('assistantInputComposer.toast.unsupportedFile', { name: rejected.join('、') })
    )
  }

  if (imageFiles.length > 0) await addImages(imageFiles)
  if (excelFiles.length > 0) await addExcelFiles(excelFiles)
  if (docFiles.length > 0) await addDocFiles(docFiles)
}

/**
 * 添加图片到待上传列表
 */
async function addImages(files: File[]): Promise<void> {
  const currentCount = pendingImages.value.length
  const remaining = MAX_IMAGES - currentCount

  if (remaining <= 0) {
    message.warning(t('assistant.composer.maxImagesWarning'))
    return
  }

  // 计算当前已添加图片的总大小
  const currentTotalSize = pendingImages.value.reduce((sum, img) => sum + img.file.size, 0)

  // 过滤并处理文件
  const filesToProcess: File[] = []
  let newTotalSize = currentTotalSize

  for (let file of files) {
    // 检查数量限制
    if (filesToProcess.length >= remaining) {
      message.warning(t('assistant.composer.maxImagesWarning'))
      break
    }

    // 检查文件类型
    if (!isImageFile(file)) {
      message.warning(t('assistant.composer.notImageFile', { name: file.name }))
      continue
    }

    // 🔴 极致压缩图片（下压到 300KB 左右），避免 base64 内联导致大请求引发 API 400
    try {
      file = await compressImageToTarget(file, 300)
    } catch (err) {
      console.warn('图片压缩失败，使用原图:', err)
    }

    // 检查单张文件大小（通用限制）
    if (!isFileSizeValid(file)) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2)
      message.warning(
        t('assistant.composer.fileSizeExceeded', {
          name: file.name,
          size: sizeMB,
          limit: getMaxImageSizeText()
        })
      )
      continue
    }

    // 如果仍然需要一个极致宽容的边界检查（防止不可预期的绕过）
    if (newTotalSize + file.size > MAX_TOTAL_SIZE) {
      const currentTotalMB = (newTotalSize / 1024 / 1024).toFixed(2)
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(2)
      const maxTotalMB = (MAX_TOTAL_SIZE / 1024 / 1024).toFixed(0)
      message.warning(
        t('assistant.composer.totalSizeExceeded', {
          name: file.name,
          current: currentTotalMB,
          fileSize: fileSizeMB,
          limit: maxTotalMB
        })
      )
      continue
    }

    filesToProcess.push(file)
    newTotalSize += file.size
  }

  // 处理通过检查的文件：先生成本地预览，再异步上传到对象存储
  for (const file of filesToProcess) {
    const pendingImageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      const base64Data = await fileToBase64(file)
      const pendingImage: PendingImage = {
        id: pendingImageId,
        file,
        preview: base64Data,
        url: base64Data, // 直接使用 base64 作为 URL
        uploading: true
      }
      if (!replacePendingImages([...pendingImages.value, pendingImage])) {
        const bytesPerMB = 1024 * 1024
        message.warning(
          t('assistant.composer.totalSizeExceeded', {
            name: file.name,
            current: (chatSessionsStore.getImageDraftBytes() / bytesPerMB).toFixed(2),
            fileSize: (file.size / bytesPerMB).toFixed(2),
            limit: MAX_IMAGE_DRAFT_BYTES / bytesPerMB
          })
        )
        continue
      }

      const uploadResult = await uploadImage(file)
      const currentImage = pendingImages.value.find((img) => img.id === pendingImageId)
      if (!currentImage) {
        continue
      }

      if (uploadResult.success && uploadResult.url) {
        currentImage.url = uploadResult.url
        currentImage.uploading = false
        currentImage.error = undefined
      } else {
        currentImage.uploading = false
        currentImage.error = uploadResult.error || t('assistant.composer.uploadFailed')
        message.error(currentImage.error)
      }
    } catch (error) {
      console.error('创建图片预览失败:', error)
      const currentImage = pendingImages.value.find((img) => img.id === pendingImageId)
      if (currentImage) {
        currentImage.uploading = false
        currentImage.error =
          error instanceof Error
            ? error.message
            : t('assistant.composer.previewFailed', { name: file.name })
      }
      message.error(t('assistant.composer.previewFailed', { name: file.name }))
    }
  }
}

/**
 * 添加 Excel 文件到待处理列表
 * 通过 IPC 调用主进程解析 Excel 内容
 */
async function addExcelFiles(files: File[]): Promise<void> {
  const remaining = MAX_EXCEL_FILES - pendingExcelFiles.value.length
  if (remaining <= 0) {
    message.warning(t('assistantInputComposer.toast.maxExcelFiles', { max: MAX_EXCEL_FILES }))
    return
  }

  for (const file of files.slice(0, remaining)) {
    // 检查文件大小（5MB 限制）
    if (file.size > 5 * 1024 * 1024) {
      const sizeMB = (file.size / 1024 / 1024).toFixed(2)
      message.warning(
        t('assistantInputComposer.toast.excelTooLarge', { name: file.name, size: sizeMB })
      )
      continue
    }

    // 添加到待处理列表
    const pending: PendingExcelFile = {
      file,
      fileName: file.name,
      parsing: true
    }
    pendingExcelFiles.value.push(pending)
    // 解析是异步的，这期间列表可能被插话、删除改掉 —— 按文件认回自己那一格，不按下标
    const setPending = (next: PendingExcelFile): void => {
      const index = pendingExcelFiles.value.findIndex((item) => toRaw(item.file) === file)
      if (index >= 0) pendingExcelFiles.value[index] = next
    }

    // 异步解析
    try {
      // 将文件读取为 ArrayBuffer 并传递给主进程
      const arrayBuffer = await file.arrayBuffer()

      const result = await window.electron.ipcRenderer.invoke('file:execute', {
        toolName: 'parseExcel',
        params: { buffer: arrayBuffer, fileName: file.name }
      })

      if (result.success) {
        setPending({
          ...pending,
          content: result.content,
          rowCount: result.rowCount,
          parsing: false
        })
        // message.success(`已解析 ${file.name}（${result.rowCount} 行）`)
      } else {
        setPending({
          ...pending,
          parsing: false,
          error: result.error || '解析失败'
        })
        message.error(
          result.error || t('assistantInputComposer.toast.parseFailed', { name: file.name })
        )
      }
    } catch (error) {
      console.error('[InputComposer] Excel 解析失败:', error)
      setPending({
        ...pending,
        parsing: false,
        error: error instanceof Error ? error.message : '解析失败'
      })
      message.error(t('assistantInputComposer.toast.parseFailed', { name: file.name }))
    }
  }
}

/**
 * 添加文档或视频到待解析列表。
 *
 * 统一走主进程的 `attachment:ingest`：文档复用知识库那一套解析器
 * （同一个 PDF，知识库读得出、对话里读不出，是最难解释的那种不一致），
 * 视频先让配好的视频模型看，看不了再抽帧当图片发。
 *
 * PDF 从前是转 base64 走 `inlineDocuments` 的 —— 那条是条死路：
 * `useChatFlow` 的载荷类型里根本没这个字段，主进程也从没构造过 document block，
 * 于是界面上挂着 PDF、模型那边一个字节都收不到。现在和别的文档一样解析成文本。
 */
async function addDocFiles(files: File[]): Promise<void> {
  const remaining = MAX_DOC_FILES - pendingDocFiles.value.length
  if (remaining <= 0) {
    message.warning(t('assistantInputComposer.toast.maxDocFiles', { max: MAX_DOC_FILES }))
    return
  }

  const toProcess = files.slice(0, remaining)

  for (const file of toProcess) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

    // 先添加一个"处理中"状态的占位
    const pending: PendingDocFile = {
      file,
      fileName: file.name,
      fileType: ext,
      parsing: true
    }
    pendingDocFiles.value.push(pending)
    // 解析是异步的，这期间列表可能被插话、删除改掉 —— 按文件认回自己那一格，不按下标
    const setPending = (next: PendingDocFile): void => {
      const index = pendingDocFiles.value.findIndex((item) => toRaw(item.file) === file)
      if (index >= 0) pendingDocFiles.value[index] = next
    }

    try {
      // 优先走绝对路径：视频要交给 ffmpeg，一段 100MB 的片子没必要先塞进
      // ArrayBuffer 再序列化过 IPC。网页里拖来的 File 拿不到路径，才退回 buffer
      const filePath = window.api.getPathForFile(file) || ''

      const mediaKind = CHAT_VIDEO_EXTENSIONS.has(ext)
        ? 'video'
        : CHAT_AUDIO_EXTENSIONS.has(ext)
          ? 'audio'
          : undefined

      if (filePath && mediaKind) {
        // 音视频不在这里看：路径随消息交给 agent，它带着用户的问题自己去看
        setPending({
          ...pending,
          filePath,
          parsing: false,
          deferredMedia: mediaKind
        })
        void startMediaUpload(filePath, file.name)
      } else if (filePath && !CHAT_DOC_EXTENSIONS.has(ext)) {
        // 白名单外的格式不预解析，只给路径：agent 有读文件的工具，读不读得了由它判断
        setPending({
          ...pending,
          filePath,
          parsing: false,
          content: t('assistantInputComposer.pathOnlyAttachment', {
            name: file.name,
            path: filePath
          })
        })
      } else if (filePath) {
        // 进度回调按这条路径认领对应的那一格，所以要先记下来再发起解析
        setPending({ ...pending, filePath })
        const result = await window.api.attachment.ingest(filePath)

        if (result.success) {
          setPending({
            ...pending,
            parsing: false,
            ...(result.text ? { content: result.text } : {}),
            ...(result.images ? { extraImages: result.images } : {})
          })
          if (result.framesFallback) {
            message.info(t('assistantInputComposer.toast.videoFramesFallback', { name: file.name }))
          }
        } else {
          setPending({
            ...pending,
            parsing: false,
            error: result.error || '解析失败'
          })
          message.error(
            result.error || t('assistantInputComposer.toast.parseFailed', { name: file.name })
          )
        }
      } else if (CHAT_VIDEO_EXTENSIONS.has(ext) || CHAT_AUDIO_EXTENSIONS.has(ext)) {
        // 没有路径的视频没法交给 ffmpeg。与其把几十 MB 搬过 IPC 再失败，
        // 不如直接说清楚：请从本地文件选择，而不是从网页里拖
        setPending({
          ...pending,
          parsing: false,
          error: t('assistantInputComposer.toast.videoNeedsLocalFile')
        })
        message.error(t('assistantInputComposer.toast.videoNeedsLocalFile'))
      } else {
        const arrayBuffer = await file.arrayBuffer()
        const buffer = new Uint8Array(arrayBuffer)
        const result = await window.electron.ipcRenderer.invoke('file:execute', {
          toolName: 'parseDocument',
          params: { buffer: Array.from(buffer), fileName: file.name }
        })

        if (result.success) {
          setPending({
            ...pending,
            content: `### 文件：${file.name}\n\n${result.content}`,
            parsing: false
          })
        } else {
          setPending({
            ...pending,
            parsing: false,
            error: result.error || '解析失败'
          })
          message.error(
            result.error || t('assistantInputComposer.toast.parseFailed', { name: file.name })
          )
        }
      }
    } catch (error) {
      console.error('[InputComposer] 文档处理失败:', error)
      setPending({
        ...pending,
        parsing: false,
        error: error instanceof Error ? error.message : '处理失败'
      })
      message.error(t('assistantInputComposer.toast.processFailed', { name: file.name }))
    }
  }
}

/** 卡片选图标和颜色用。音视频那一格不该顶着一个 Word 图标 */
function docKind(doc: PendingDocFile): AttachmentKind {
  if (CHAT_VIDEO_EXTENSIONS.has(doc.fileType)) return 'video'
  if (CHAT_AUDIO_EXTENSIONS.has(doc.fileType)) return 'audio'
  return 'document'
}

/**
 * 跟进主进程的解释进度。
 *
 * 视频那条要压缩、上传、等模型，几十秒起步；只转一个菊花的话，用户分不清
 * 「在跑」和「卡死了」。按路径匹配到对应的那一条，把主进程报上来的话直接显示。
 */
onMounted(() => {
  // 可选链不是防御性编程：单测里挂载这个组件时 window.api 只有被测到的那几块，
  // 缺一个进度订阅不该让整个输入框起不来
  const off = window.api.attachment?.onProgress(({ filePath, note }) => {
    const target = pendingDocFiles.value.find((f) => f.parsing && f.filePath === filePath)
    if (target) target.statusNote = note
  })
  if (off) onUnmounted(off)
})

/**
 * 配了对象存储就趁用户打字的工夫先传。
 *
 * 失败了不挂在卡片上当错误：发送时主进程会再试一次，再不行就只给路径，
 * 这条消息照样发得出去。这里只提一句，免得用户以为已经传好了。
 */
async function startMediaUpload(filePath: string, fileName: string): Promise<void> {
  if (!(await objectStorageAPI.ready())) return
  const find = (): PendingDocFile | undefined =>
    pendingDocFiles.value.find((f) => f.filePath === filePath && f.deferredMedia)
  const target = find()
  if (!target) return
  target.uploading = true
  target.statusNote = t('assistantInputComposer.mediaUploading', { percent: 0 })
  const result = await objectStorageAPI.upload(filePath)
  const current = find()
  if (!current) return
  current.uploading = false
  current.statusNote = undefined
  if (!result.success) {
    message.warning(
      t('assistantInputComposer.toast.mediaUploadFailed', { name: fileName, error: result.error })
    )
  }
}

onMounted(() => {
  const off = objectStorageAPI.onUploadProgress(({ filePath, percent }) => {
    const target = pendingDocFiles.value.find((f) => f.uploading && f.filePath === filePath)
    if (target) target.statusNote = t('assistantInputComposer.mediaUploading', { percent })
  })
  if (off) onUnmounted(off)
})

/**
 * 移除待上传的文档文件
 */
function removeDocFile(index: number): void {
  pendingDocFiles.value.splice(index, 1)
}

/**
 * 移除图片
 */
function removeImage(index: number): void {
  replacePendingImages(pendingImages.value.filter((_, imageIndex) => imageIndex !== index))
}

/**
 * 移除 Excel 文件
 */
function removeExcelFile(index: number): void {
  pendingExcelFiles.value.splice(index, 1)
}

/**
 * 处理粘贴事件
 */
async function handlePaste(event: ClipboardEvent): Promise<void> {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length > 0) {
    event.preventDefault()
    await routeFiles(files)
    return
  }

  const images = extractImagesFromPaste(event)
  if (images.length > 0) {
    event.preventDefault()
    await addImages(images)
  }
}

/**
 * 处理拖拽进入
 */
function handleDragOver(event: DragEvent): void {
  // 任何文件都亮高亮，不再只认图片 —— 高亮是「这里收得下」的唯一提示，
  // 拖着 PDF 过来却毫无反应，用户根本不会松手
  const items = event.dataTransfer?.items
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        isDragging.value = true
        return
      }
    }
  }
}

/**
 * 处理拖拽离开
 */
function handleDragLeave(event: DragEvent): void {
  const composer = event.currentTarget as HTMLElement | null
  if (
    composer &&
    pointerStillInside(composer.getBoundingClientRect(), event.clientX, event.clientY)
  ) {
    return
  }
  isDragging.value = false
}

/**
 * 处理拖拽放下
 */
async function handleDrop(event: DragEvent): Promise<void> {
  isDragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length > 0) {
    await routeFiles(files)
    return
  }

  // dataTransfer.files 为空时才回退到 items 扫描：从网页里直接拖图片属于这种
  const images = extractImagesFromDrop(event)
  if (images.length > 0) {
    await addImages(images)
  }
}

/**
 * 打开图片预览
 */
function openImagePreview(img: PendingImage): void {
  const items = pendingImages.value
    .map((it) => ({
      src: it.url || it.preview,
      alt: it.file?.name || 'image'
    }))
    .filter((it) => !!it.src)
  const index = Math.max(0, pendingImages.value.indexOf(img))
  void openImageViewer({ items, index })
}

/**
 * 处理发送
 */
function handleSend(event?: Event): void {
  if (isSendDisabled.value) return

  const trimmedContent = content.value.trim()

  /*
   * 用户完全可以不碰面板，直接把 `/compact` 敲全然后回车。
   * 不在这儿拦下来，那句话就当正文发给模型了 —— 模型会礼貌地回一句
   * 「好的我来压缩」然后什么也没发生，正是这轮要消灭的那种假生效。
   */
  const runCommand = matchRunCommand(trimmedContent)
  if (runCommand) {
    content.value = ''
    showSkillMenu.value = false
    emit('run-command', runCommand.name)
    return
  }

  if (isWikiCommand(trimmedContent)) {
    if (trimmedContent === '/wiki clear') {
      if (props.boundNotebook) {
        emit('clear-bound-wiki')
      } else {
        message.info(t('assistantInputComposer.toast.noWikiBound'))
      }
      content.value = ''
      showWikiPopover.value = false
      return
    }

    void openWikiPopover()
    return
  }

  // 未配置模型时保留草稿和附件，让用户在当前入口完成设置再发送。
  // 本地命令和生图不依赖 Agent 模型，因此在它们各自的路径之后判断。
  if (!isImageGenerationMode.value && !props.isGenerating && !agentModelCatalog.value?.selected) {
    // 原生点击的冒泡可能晚于 nextTick，直接阻止本次点击关闭刚打开的设置入口。
    event?.stopPropagation()
    showAgentModelDropdown.value = true
    syncAgentModelDropdownHeight()
    message.info(t('assistantInputComposer.model.required'))
    void loadAgentModels()
    return
  }

  // 收集已上传成功的图片 URL
  const uploadedImages = pendingImages.value
    .filter((img) => img.url && !img.uploading && !img.error)
    .map((img) => img.url!)

  // 在图片生成模式下，如果有图片，传递 File 对象用于图生图
  const imageFiles: File[] | undefined = isImageGenerationMode.value
    ? pendingImages.value
        .filter((img) => img.file && !img.uploading && !img.error)
        .map((img) => img.file!)
    : undefined

  // 收集已解析的 Excel 内容
  const excelContents = pendingExcelFiles.value
    .filter((f) => f.content && !f.parsing && !f.error)
    .map((f) => `### 文件：${f.fileName}\n\n${f.content}`)

  // 收集已解析的文档/视频文本。文件名那一行在解析时已经加好了（见 attachmentIngest）
  const docContents = pendingDocFiles.value
    .filter((f) => f.content && !f.parsing && !f.error)
    .map((f) => f.content!)

  // 视频抽帧兜底产出的联系表，和用户自己带的图片走同一条通道
  const frameImages = pendingDocFiles.value
    .filter((f) => !f.parsing && !f.error)
    .flatMap((f) => f.extraImages ?? [])

  // 合并所有文档上下文（Excel + 文档 + 视频描述）
  const allDocContents = [...excelContents, ...docContents]
  const excelContext = allDocContents.length > 0 ? allDocContents.join('\n\n---\n\n') : undefined

  // 收集 Excel 文件元数据（用于 UserBubble 显示）
  const excelFiles = pendingExcelFiles.value
    .filter((f) => f.content && !f.parsing && !f.error)
    .map((f) => ({ fileName: f.fileName, rowCount: f.rowCount }))

  // 音视频只带路径
  const mediaFiles: ChatMediaFile[] = pendingDocFiles.value
    .filter((f) => f.deferredMedia && f.filePath && !f.error)
    .map((f) => ({ filePath: f.filePath!, fileName: f.fileName, kind: f.deferredMedia! }))

  // 收集文档与音视频的元数据（用于 UserBubble 显示）
  const docFiles = pendingDocFiles.value
    .filter((f) => !f.parsing && !f.error && (f.content || f.deferredMedia))
    .map((f) => ({ fileName: f.fileName, kind: f.deferredMedia ?? ('document' as const) }))

  // 发送消息（包含可能的强制来源列表）
  emit('send', {
    content: trimmedContent,
    images: [...uploadedImages, ...frameImages],
    imageFiles,
    forcedSources: mentionedSources.value.length > 0 ? [...mentionedSources.value] : undefined,
    excelContext,
    excelFiles: excelFiles.length > 0 ? excelFiles : undefined,
    docFiles: docFiles.length > 0 ? docFiles : undefined,
    mediaFiles: mediaFiles.length > 0 ? mediaFiles : undefined
  })

  // 清空状态
  content.value = ''
  replacePendingImages([])
  pendingExcelFiles.value = []
  pendingDocFiles.value = []
  mentionedSources.value = []
  showMentionPopover.value = false
  showWikiPopover.value = false
  showSkillMenu.value = false
}

/**
 * 触发停止生成事件
 */
function handleStop(): void {
  emit('stop')
}

/**
 * 能不能插话。
 *
 * 只在 **Agent 模式跑着的时候**才成立：插话是 agent 循环的能力（消息注入
 * 当前轮次），普通对话的流式输出里没有这个东西，摆一个点了没反应的按钮
 * 比不摆更糟。
 */
/** 现在处于"可以插话"的状态（不管有没有打字）。状态条和按钮的显隐都看它 */
const canSteerNow = computed(() => !!props.isGenerating && isAgentMode.value)

/**
 * 有字，或者有一件已经处理好的附件，就能插话 —— 只拖了个视频、一个字没打也行。
 * 不看 `isSendDisabled`：别的图还在传时，打好的字和备好的附件照样先插进去，
 * 没好的留在原地（见 `handleSteer`）。
 */
const canSteer = computed(
  () =>
    canSteerNow.value &&
    (content.value.trim().length > 0 ||
      pendingImages.value.some((img) => img.url && !img.uploading && !img.error) ||
      pendingExcelFiles.value.some((f) => f.content && !f.parsing && !f.error) ||
      pendingDocFiles.value.some(
        (f) => !f.parsing && !f.error && (f.content || (f.deferredMedia && f.filePath))
      ))
)

/**
 * 跑着的时候，这次回车默认走排队还是插话。
 *
 * 直接读 store 而不是让页面传 prop：这是一条用户级偏好，和「这条对话」无关，
 * 多传一层只会多一个能对不上的地方。
 */
const followUpBehavior = computed(() => aiConfigStore.followUpBehavior)

/** 哪个键算发送。同样直接读 store —— 用户级偏好，和「这条对话」无关 */
const sendShortcut = computed(() => aiConfigStore.sendShortcut)

/**
 * 运行中那颗按钮对读屏软件报的名字。
 *
 * 界面上不写字了（发送箭头就是发送箭头，多一颗带标签的按钮只是占地方），
 * 但点下去实际发生的是排队还是插话，读屏的人有权先知道。
 */
const followUpActionLabel = computed(() =>
  followUpBehavior.value === 'queue'
    ? t('assistantInputComposer.queueAction')
    : t('assistantInputComposer.steerAction')
)

/**
 * 跑着的时候，输入框里已经有能发的东西。
 *
 * 只在 Agent 模式成立：普通对话的流式输出里没有队列这回事，这时候换成发送按钮
 * 点下去只会被主进程以 `SESSION_BUSY` 顶回来，那还不如留着停止按钮。
 */
const canSendFollowUp = computed(() => canSteerNow.value && !isSendDisabled.value)

/**
 * 插话。图、表格、文档、音视频都跟着走 —— 挑的是和 `handleSend` 同一批
 * 「处理完了、没出错」的，处理办法也一样，只是塞进正在跑的这一轮。
 *
 * @ 来源这条通道带不走（它是检索范围，不是这一轮的内容），**留在输入框里不清空**：
 * 用户看得见它还在，下一次普通发送会带上它。
 */
function handleSteer(): void {
  const typed = content.value.trim()
  const ready = pendingImages.value.filter((img) => img.url && !img.uploading && !img.error)
  const readyExcel = pendingExcelFiles.value.filter((f) => f.content && !f.parsing && !f.error)
  const readyDocs = pendingDocFiles.value.filter(
    (f) => !f.parsing && !f.error && (f.content || (f.deferredMedia && f.filePath))
  )

  const images = [...ready.map((img) => img.url!), ...readyDocs.flatMap((f) => f.extraImages ?? [])]
  const contextText = [
    ...readyExcel.map((f) => `### 文件：${f.fileName}\n\n${f.content}`),
    ...readyDocs.filter((f) => f.content).map((f) => f.content!)
  ].join('\n\n---\n\n')
  const mediaFiles: ChatMediaFile[] = readyDocs
    .filter((f) => f.deferredMedia && f.filePath)
    .map((f) => ({ filePath: f.filePath!, fileName: f.fileName, kind: f.deferredMedia! }))
  const files: ExcelFileInfo[] = [
    ...readyExcel.map((f) => ({
      fileName: f.fileName,
      rowCount: f.rowCount,
      kind: 'excel' as const
    })),
    ...readyDocs.map((f) => ({
      fileName: f.fileName,
      kind: f.deferredMedia ?? ('document' as const)
    }))
  ]
  // 只带附件没打字也照发，那句说明由 `steerAgent` 补
  if (!typed && images.length === 0 && files.length === 0) return

  /*
   * 为了不卡手，发出去这一刻先把它们从输入框摘掉；插话没成（这一轮刚好收尾、
   * 工程对不上……）或者用户事后撤回了这条时，由接收方调这个放回来 ——
   * 不然用户打的字和拖进来的附件就没了。
   * 放回的是**这次摘走的那几样**：这期间用户又打了字、又拖了东西的，一样不动，
   * 放回的字接在它前面。
   */
  const restore = (): void => {
    const current = content.value.trim()
    if (typed) content.value = current ? `${typed}\n\n${content.value}` : typed
    if (ready.length > 0) replacePendingImages([...ready, ...pendingImages.value])
    if (readyExcel.length > 0) pendingExcelFiles.value = [...readyExcel, ...pendingExcelFiles.value]
    if (readyDocs.length > 0) pendingDocFiles.value = [...readyDocs, ...pendingDocFiles.value]
  }

  emit('steer', {
    text: typed,
    images,
    restore,
    ...(files.length > 0
      ? {
          attachments: {
            ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
            ...(contextText ? { contextText } : {}),
            files
          }
        }
      : {})
  })
  content.value = ''
  // 只摘走真的发出去的那些。还在传的、还在解析的、坏了的留在原地 ——
  // 一起清掉的话用户会以为它们也跟着这句话进去了
  if (ready.length > 0) {
    replacePendingImages(pendingImages.value.filter((img) => !ready.includes(img)))
  }
  if (readyExcel.length > 0) {
    pendingExcelFiles.value = pendingExcelFiles.value.filter((f) => !readyExcel.includes(f))
  }
  if (readyDocs.length > 0) {
    pendingDocFiles.value = pendingDocFiles.value.filter((f) => !readyDocs.includes(f))
  }
}

/**
 * 运行中那颗按钮：按设置走排队或插话。
 *
 * 排队走的是普通 `send` —— 页面看见「跑着的时候来了一条 send」就把它排进队列。
 * 不为排队单开一条事件：那样页面要维护两条几乎一样的发送路径，而附件、@提及、
 * 草稿清空这些事在两条路上都得做一遍。
 */
function handleFollowUpAction(): void {
  if (followUpBehavior.value === 'steer') {
    handleSteer()
    return
  }
  if (isSendDisabled.value) return
  handleSend()
}

/**
 * 右下角那颗按钮：闲着就是普通发送，跑着就按设置排队 / 插话。
 *
 * 原生事件要一路传给 `handleSend` —— 没配模型那条分支要靠它 `stopPropagation`，
 * 否则这一下点击会顺手把刚弹出来的模型设置入口又关掉。
 */
function handlePrimaryAction(event?: Event): void {
  if (canSendFollowUp.value) {
    handleFollowUpAction()
    return
  }
  handleSend(event)
}

function handleCancelQueued(id: string): void {
  emit('cancel-queued', id)
}

function handleSteerQueued(id: string): void {
  emit('steer-queued', id)
}

/**
 * 排着的这条退回输入框重新改：字放回去（接在用户正在打的字前面），队里那条摘掉。
 * 只给纯文字的那条，所以标签上的正文就是原话，不用回页面要 payload。
 */
function handleEditQueued(id: string, text: string): void {
  const current = content.value.trim()
  content.value = current
    ? `${text}

${content.value}`
    : text
  emit('cancel-queued', id)
  focus()
}

/** 排着的消息。父组件没传就是空 —— 模板里不用到处判空 */
const queuedFollowUps = computed(() => props.queuedFollowUps ?? [])

/** 多条时默认只露队头（下一条就发它），其余收起来 */
const queuedExpanded = ref(false)
const visibleQueued = computed(() =>
  queuedExpanded.value ? queuedFollowUps.value : queuedFollowUps.value.slice(0, 1)
)
watch(
  () => queuedFollowUps.value.length,
  (n) => {
    if (n <= 1) queuedExpanded.value = false
  }
)

/**
 * 键盘处理
 */
function handleKeydown(e: KeyboardEvent): void {
  if (props.disabled) return

  if (skillMenuVisible.value && skillCommandMenuRef.value?.onKeydown(e)) return

  // 修复在输入框中无法使用快捷键全选的问题
  const isSelectAll = (e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a'
  if (isSelectAll) {
    const target = e.target as HTMLTextAreaElement | null
    if (target && typeof target.select === 'function') {
      e.preventDefault()
      e.stopPropagation()
      target.select()
      return
    }
  }

  /*
   * 哪个键算发送由设置定（回车 / Ctrl+回车），换行交给输入框默认行为。
   * 两段判定都是纯函数，各自有测试：判错的表现是「我的话发不出去」或者
   * 「我还没写完就发出去了」，两种都不报错，只会在真机上被用户撞见。
   */
  const keyAction = resolveComposerKeyAction(e, sendShortcut.value)
  if (keyAction === null || keyAction === 'newline') return

  e.preventDefault()

  /*
   * 跑着的时候这一下有两种处置，用户在设置里选默认那种，加一个修饰键
   * 对**这一条**反着来。
   *
   * 两种都不能退化成「什么也不做」：这时候开新一轮会被主进程以
   * `SESSION_BUSY` 顶回来，用户敲下的那段话就白打了。
   */
  const action = resolveFollowUpAction(
    followUpBehavior.value,
    keyAction === 'submit-opposite',
    canSteerNow.value
  )
  if (action === 'steer') {
    if (canSteer.value) handleSteer()
    return
  }
  // 普通对话的流式输出里没有队列这回事（那是 agent 循环的能力），
  // 生成中照旧什么都不做 —— 发出去只会被拒
  if (action === 'send' && props.isGenerating) return
  if (isSendDisabled.value) return
  handleSend()
}

/**
 * 组件挂载后，确保 textarea 有正确的高度，避免初始化时的高度闪烁
 * 注意：只设置初始高度，不阻止 auto-size 的正常工作
 */
onMounted(() => {
  nextTick(() => {
    if (textareaRef.value) {
      // Ant Design 的 textarea 组件，需要访问内部的 textarea 元素
      const textareaEl = textareaRef.value.$el?.querySelector(
        'textarea'
      ) as HTMLTextAreaElement | null
      if (textareaEl) {
        // 只在初始化时设置一次高度，之后让 auto-size 接管
        // 移除可能存在的固定高度样式，让 auto-size 正常工作
        textareaEl.style.height = 'auto'
        // 触发一次重新计算，确保初始高度正确
        const scrollHeight = textareaEl.scrollHeight
        if (scrollHeight > 0) {
          // 使用 requestAnimationFrame 确保在下一帧设置，避免与 auto-size 冲突
          requestAnimationFrame(() => {
            if (textareaEl && textareaEl.scrollHeight === scrollHeight) {
              // 只在高度没有变化时才设置，避免干扰 auto-size
              textareaEl.style.height = `${scrollHeight}px`
            }
          })
        }
      }
    }
  })
})
</script>

<style scoped lang="less">
.input-composer {
  position: relative;
  // 这排控件收不收由**它自己这块地方**有多宽决定，不是窗口宽度 ——
  // 同一个组件既铺在整页助手里，也嵌在库详情页那块四百来宽的面板里
  container: composer / inline-size;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 20px;
  background: var(--color-bg-surface-hover);
  box-shadow:
    inset 0 0 0 1px var(--shadow-highlight),
    0 12px 24px var(--shadow-color);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);

  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  /* 聚焦态：输入内容时微妙边框亮起 */
  &:focus-within {
    box-shadow:
      inset 0 0 0 1px var(--shadow-highlight),
      0 12px 28px var(--shadow-color-strong);
  }

  &.drag-over {
    box-shadow:
      inset 0 0 0 2px var(--color-accent-border),
      0 12px 24px var(--shadow-color);
  }

  .ant-input {
    font-size: 14px !important;
  }
}

.image-preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.image-preview-item {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;

  .preview-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: opacity 0.2s ease;
  }

  .upload-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-scrim);
    color: var(--color-text-primary);
    font-size: 20px;
  }

  .remove-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 18px;
    color: var(--color-text-on-solid);
    background: var(--color-bg-overlay);
    border-radius: 50%;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease;

    &:hover {
      color: var(--color-danger-text);
    }
  }

  &:hover .remove-btn {
    opacity: 1;
  }

  &:hover .preview-img {
    opacity: 0.9;
  }
}

.attachment-preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
}

.placeholder-row {
  display: flex;
  align-items: flex-start; /* Align to top for multi-line input */
  gap: 8px;
}

.tool-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  padding: 3.5px 8px;
  border-radius: 6px;
  white-space: nowrap;
  user-select: none;
}

.tool-indicator.image-mode,
.tool-indicator.goal-mode {
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  border: 1px solid var(--color-accent-border);
  font-family: inherit;
  line-height: inherit;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.tool-indicator.model-mode {
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  border: 1px solid var(--color-accent-border);
}

.tool-indicator.agent-mode {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  border: 1px solid var(--color-warning-border);
}

.placeholder-row :deep(.ant-input) {
  color: var(--color-text-primary);
  font-size: 16px;
  background: transparent;
  padding: 4px 0; /* Adjust padding to align with indicator */
}

.placeholder-row :deep(.ant-input::placeholder) {
  color: var(--color-text-disabled);
}

/* 确保 textarea 在初始化时就有正确的高度，避免闪烁，但不阻止 auto-size 正常工作 */
.placeholder-row :deep(textarea.ant-input) {
  /* 设置行高，确保单行时的高度正确 */
  line-height: 24px;
}

.tools-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
}

/* 三列都要能被压缩。不写这条，grid 子项的 min-width:auto 会按内容撑开，
   窄容器下右边那组直接溢出到面板外面 */
.tools-row > * {
  min-width: 0;
}

/*
 * 窄容器下把这排控件的文字折成图标。
 *
 * ## 为什么是容器查询，不是媒体查询
 *
 * 这个组件既出现在整页的助手里，也嵌在蓝图库 / 材质库详情页那块四百来宽的
 * 面板里（`LibraryAIPanel.vue`）。决定挤不挤的是**它自己这块地方有多宽**，
 * 和窗口多宽没关系 —— 用户把窗口拉到 2560 宽，那块面板还是 420。
 *
 * ## 这些数字是**内容盒**的宽度
 *
 * 容器查询量的是容器内容盒，`.input-composer` 自己左右各 18px 内边距
 * 已经被扣掉了，外面面板的内边距也不在内。所以这里的 480 对应的面板宽度
 * 大约是 520–540。**这组数字是估的，真机上按实际观感再调**。
 *
 * ## 折的顺序
 *
 * 先折审批档和思考档（它们的图标本身就说明问题：盾牌/灯泡），
 * 最后才折模型名 —— 「现在跑在哪个模型上」是这排里用户最常看的一条。
 * 折掉的文字都进了 title 和 aria-label，鼠标停一下还看得到。
 */
@container composer (max-width: 480px) {
  .approval-selector .mode-trigger-label,
  .thinking-selector .mode-trigger-label {
    display: none;
  }
}

@container composer (max-width: 380px) {
  .agent-model-trigger-label {
    display: none;
  }
}

.left-tools {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding-left: 8px;
}

/* Ask 模式切换按钮 */
.ask-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.2s ease;
  user-select: none;

  &:hover {
    color: var(--color-text-secondary);
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
  }

  &.active {
    color: var(--color-text-selected);
    background: var(--color-bg-selected);
  }

  .ask-icon {
    font-size: 14px;
  }

  .ask-label {
    font-weight: 500;
    line-height: 1;
  }
}

/* ==================== 模式选择器下拉框 ==================== */
.mode-selector {
  position: relative;
}

/* 圆环要贴着按钮转，所以按钮得有个定位锚点 */
.voice-slot {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.voice-btn {
  position: relative;
  /* 环画在按钮底下，图标压在最上面 */
  z-index: 1;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  transition:
    color var(--motion-fast) var(--easing-standard),
    background-color var(--motion-normal) var(--easing-standard),
    transform var(--motion-fast) var(--easing-decelerate);
}

.voice-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  transform: scale(1.06);
}

/* 按下去要有回应，且回应必须比松手快 —— 这是「按钮活着」的全部来源 */
.voice-btn:active:not(:disabled) {
  transform: scale(0.92);
  transition-duration: 90ms;
}

/* 连接中：图标不换、不转，只是暗下去。转圈那件事交给外面的环 */
.voice-btn:disabled {
  color: var(--color-text-disabled);
  background: transparent;
}

/*
 * 通话开着必须一眼看得出来 —— 麦克风一直开着而用户以为没开，
 * 是这类功能最要命的状态（既是隐私问题，也在持续计费）。
 *
 * 以前这里是整个按钮的透明度脉冲。它有两个毛病：只改透明度的状态提示
 * 在浅色主题下几乎读不出来，而且它和外圈的呼吸抢节奏。现在常态由**颜色**
 * 扛（不依赖动画，减少动态效果时照样成立），进入这个状态时图标弹一下作为交接。
 */
.voice-btn.live {
  /* 红底上用 on-solid（两套主题都是白），text-inverse 在深色主题下是近黑，压在红上读不清 */
  color: var(--color-text-on-solid);
  background: var(--color-danger-solid);
}

.voice-btn.live:hover:not(:disabled) {
  color: var(--color-text-on-solid);
  background: color-mix(in srgb, var(--color-danger-solid) 86%, var(--color-text-on-solid));
}

.voice-btn.live :deep(svg) {
  animation: voice-icon-engage 260ms var(--easing-bounce) 1;
}

/* 一次性的状态交接：图标顶一下再落回，告诉用户"从现在开始在录" */
@keyframes voice-icon-engage {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.18);
  }
  100% {
    transform: scale(1);
  }
}

/* 尊重「减少动态效果」：颜色那一重仍然在 */
@media (prefers-reduced-motion: reduce) {
  .voice-btn,
  .voice-btn:hover:not(:disabled),
  .voice-btn:active:not(:disabled) {
    transform: none;
    transition: none;
  }

  .voice-btn.live :deep(svg) {
    animation: none;
  }
}

.mode-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 4px 9px;
  border-radius: 16px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text-primary);
  // background: var(--color-bg-surface);
  // backdrop-filter: blur(12px);
  // -webkit-backdrop-filter: blur(12px);
  // border: 1px solid rgba(255, 255, 255, 0.1);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
  overflow: hidden;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
    color: var(--color-text-primary);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px var(--shadow-color-weak);

    .mode-trigger-glow {
      opacity: 1;
    }
  }

  &:active {
    transform: translateY(0) scale(0.97);
    transition-duration: 0.1s;
  }
}

.mode-trigger-glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(109, 195, 255, 0.06), transparent 60%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.mode-trigger-icon {
  font-size: 13px;
  color: var(--color-accent-text);
  filter: drop-shadow(0 0 3px var(--color-accent-border));
}

.mode-trigger-label {
  font-weight: 600;
  letter-spacing: 0.03em;
}

/* 审批策略与思考程度。挨着模式选择器，但视觉上退一档 —— 它们是模式的
   从属选项，不该和「Chat / Agent」抢注意力。
   两个选择器共用同一套样式：它们在同一行里并排，各写一份迟早会漂移 */
/* 没有这个锚点，弹窗的 bottom: 100% 会贴到整个输入框上沿，欢迎页直接顶出窗口 */
.agent-model-selector {
  position: relative;
}

.approval-selector .mode-trigger,
.thinking-selector .mode-trigger,
.agent-model-selector .mode-trigger {
  color: var(--color-text-primary);
}

.approval-selector .mode-trigger-label,
.thinking-selector .mode-trigger-label,
.agent-model-selector .mode-trigger-label {
  font-weight: 500;
}

.approval-trigger-icon,
.thinking-trigger-icon,
.agent-model-trigger-icon {
  font-size: 12px;
  color: var(--color-text-primary);
}

/* 全放行是有代价的选择，得看得出来 —— 用户可能几周后才想起自己开过 */
.approval-selector.is-yolo .mode-trigger,
.approval-selector.is-yolo .approval-trigger-icon {
  color: var(--color-warning-text);
}

.approval-dropdown,
.thinking-dropdown,
.agent-model-dropdown {
  min-width: 252px;
}

/* 开启完全访问权限的确认弹窗 */
.full-access {
  color: var(--color-text-primary);
}

.full-access-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-warning-text);
}

.full-access-intro {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-primary);
}

.full-access-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
}

.full-access-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
}

.full-access-icon {
  margin-top: 2px;
  font-size: 15px;
  color: var(--color-accent-text);
  flex: none;
}

.full-access-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.full-access-item-title {
  font-size: 13px;
  font-weight: 600;
}

.full-access-item-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-primary);
}

.full-access-risk {
  margin: 14px 0 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-primary);
}

.full-access-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.mode-trigger-arrow {
  font-size: 9px;
  color: var(--color-text-primary);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  margin-left: 1px;

  &.open {
    transform: rotate(180deg);
    color: var(--color-accent-text);
  }
}

.mode-dropdown {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  min-width: 232px;
  padding: 6px;
  border-radius: 14px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  box-shadow:
    0 12px 40px var(--shadow-color),
    0 4px 12px var(--shadow-color-weak),
    inset 0 0.5px 0 var(--shadow-highlight);
  z-index: 100;

  /* 顶部微光线 */
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 16px;
    right: 16px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(109, 195, 255, 0.15), transparent);
    border-radius: 1px;
  }
}

/* 下拉菜单动画 */
.mode-dropdown-enter-active {
  transition: all 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.mode-dropdown-leave-active {
  transition: all 0.18s cubic-bezier(0.4, 0, 1, 1);
}

.mode-dropdown-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.94);
}

.mode-dropdown-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.97);
}

.mode-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 12px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover {
    background: var(--color-bg-surface-hover);
    transform: translateX(2px);
  }

  &.active {
    background: var(--color-bg-selected);

    /* 左侧渐变指示条 */
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 18px;
      border-radius: 0 3px 3px 0;
      background: var(--color-accent-solid);
    }
  }

  & + .mode-option {
    margin-top: 2px;
  }
}

.mode-option-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);
  font-size: 14px;
  flex-shrink: 0;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);

  &.active {
    background: var(--color-accent-solid);
    border-color: var(--color-accent-solid);
    color: var(--color-text-on-solid);
    box-shadow: var(--shadow-xs);
  }
}

.mode-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.mode-option-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  line-height: 1.2;
  letter-spacing: 0.01em;
}

.mode-option-desc,
.mode-dropdown-note {
  font-size: 11px;
  color: var(--color-text-primary);
  line-height: 1.3;
}

/* 下拉底部那句说明（档位属于哪个模型 / 被夹到了哪一档）。挂在选项下面
   而不是做成 tooltip：下拉是往上弹的，浮层会压住选项把点击吃掉（审批那边踩过） */
.mode-dropdown-section {
  padding: 8px 12px 4px;
  border-top: 1px solid var(--color-border-subtle);
  margin-top: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mode-dropdown-note {
  padding: 6px 12px 2px;
  border-top: 1px solid var(--color-border-subtle);
  margin-top: 4px;
}

/* 档位这一档是**单行**的：档位名 + 右侧说明 + 勾。
   与 Chat / Agent 那种「标题 + 副标题」的两行卡片不同 —— 档位名本身就是
   一个词（low / xhigh），堆成两行反而更难扫，也和 pi 那边的排布对得上 */
.thinking-level-name {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.thinking-dropdown .mode-option-desc {
  margin-left: 12px;
  white-space: nowrap;
}

/* 厂商别名后面跟的档位原名 */
.fast-mode-option {
  border-top: 1px solid var(--color-border-subtle);
  margin-top: 4px;
}

.fast-mode-icon {
  width: 12px;
  height: 12px;
  margin-right: 4px;
  vertical-align: -1px;
  color: var(--color-warning-text);
}

.thinking-alias {
  margin-left: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--color-text-muted);
}

.mode-option-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
  font-size: 10px;
  flex-shrink: 0;
  animation: check-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes check-pop {
  0% {
    transform: scale(0);
    opacity: 0;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

.right-tools {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  justify-self: end;
}

.agent-model-trigger {
  max-inline-size: 24ch;
  color: var(--color-text-secondary);
}

.agent-model-trigger :deep(.app-button__label) {
  gap: inherit;
  min-width: 0;
}

.agent-model-trigger-label {
  max-inline-size: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-model-dropdown {
  right: 0;
  left: auto;
  max-block-size: 50vh;
  overflow-y: auto;
}

.agent-model-group + .agent-model-group {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--color-border-subtle);
}

.agent-model-group-title {
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.agent-model-option,
.agent-model-retry,
.agent-model-settings,
.approval-dropdown > button,
.thinking-dropdown > button {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.agent-model-option-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-weight: 500;
}

/* 有标签时标签紧跟名字，空白让给标签后面 */
.agent-model-option-name:has(+ .agent-model-option-badge) {
  flex: 0 1 auto;
}

/* 套餐清单给的标签（如「Beta」），样式同侧栏的 beta-tag */
.agent-model-option-badge {
  flex: none;
  margin-right: auto;
  margin-left: var(--space-2);
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-strong);
  border-radius: 4px;
}

.agent-model-option-id {
  max-inline-size: 20ch;
  margin-left: var(--space-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs);
}

.agent-model-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 0;
  padding: var(--space-3);
  border-top: 0;
}

/* 和右边的审批档、思考档同一套：24 高、无底无边、悬停才给表面色。
   单独描一圈边的话，整排只有它是个「按钮」，别的都是文字，看着不在一条线上 */
.plus-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--color-text-primary);
  font-size: 16px;
  background: transparent;
  border: none;
  border-radius: 16px;
  cursor: pointer;
  transition: background var(--motion-fast) var(--easing-standard);

  svg {
    transition: transform var(--motion-fast) var(--easing-standard);
  }

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  // 开着的时候转成 ×，告诉用户再点一下是收起
  &.active svg {
    transform: rotate(45deg);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.chips {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 隐藏 chips 时的占位元素，保持 grid 布局 */
.chips-placeholder {
  display: block; /* 占位元素，仅用于保持三列 grid 结构 */
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  color: var(--color-text-primary);
}

.preset-popover {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.popover-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preset-label {
  color: var(--color-text-primary);
  font-size: 12px;
}

.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.slider-value {
  color: var(--color-text-primary);
  font-size: 12px;
}

.price-section {
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.price-info {
  color: var(--color-text-primary);
  font-size: 12px;
  text-align: center;
}

.send-btn {
  --send-button-bg: var(--color-bg-inverse);
  --send-button-color: var(--color-text-inverse);

  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  padding: 0;
  font-size: 1.2em;
  color: var(--send-button-color) !important;
  background: var(--send-button-bg) !important;
  box-shadow: var(--shadow-soft);
  transition: transform 0.1s ease;

  &:hover:not(:disabled),
  &:focus:not(:disabled) {
    color: var(--send-button-color) !important;
    background: var(--send-button-bg) !important;
    border-color: transparent !important;
    box-shadow: var(--shadow-soft);
    transform: none;
  }

  &:focus-visible:not(:disabled) {
    box-shadow: 0 0 0 2px var(--color-border-focus);
  }

  &:active:not(:disabled) {
    transform: scale(0.95);
    transition-duration: 0.1s;
  }
}

// disabled
.send-btn:disabled {
  color: var(--color-text-disabled);
  background: var(--color-bg-surface-hover) !important;
  box-shadow: none;
  transition: transform 0.1s ease;
}

.stop-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  padding: 0;
  font-size: 1.2em;
  box-shadow: none;
  border: none;
  transition: all 0.2s ease;

  &:hover {
    transform: scale(1.06);
  }
}

/* 上下文用量指示器。纯展示 —— V3 会自动压缩，没有需要用户点的动作 */
/* 用量指示器：外面只有一个圆环，悬停看详情，点一下直接压缩 */
.context-ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 50%;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-right: 4px;

  &:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &:active:not(:disabled) {
    transform: scale(0.92);
  }

  &:disabled {
    cursor: not-allowed;
  }
}

.context-ring-track {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 2.5;
}

.context-ring-fill {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.35s ease;
}

/* 快满了要看得见 —— 再往后就会触发压缩，早期结论可能被摘要掉 */
.context-ring.high {
  color: var(--color-warning-text);
}

/* 压缩中：整个环转起来，比换个图标更能说明"正在处理这件事" */
.context-ring.busy svg {
  animation: context-ring-spin 1s linear infinite;
}

@keyframes context-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

.byok-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: var(--color-text-muted);
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
  margin-right: -2px;

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--color-bg-surface);
  border-radius: 20px;
  border: 2px dashed var(--color-accent-border);
  color: var(--color-accent-text);
  font-size: 14px;
  pointer-events: none;

  .drag-icon {
    font-size: 32px;
  }
}

.agent-mode-tooltip {
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.tooltip-link {
  color: var(--color-accent-text);
  text-decoration: none;
  margin-left: 4px;
  cursor: pointer;
  transition: color 0.2s ease;

  &:hover {
    color: var(--color-accent-text);
    text-decoration: underline;
  }
}

// ==================== 知识库 @ 提及样式 ====================
.mentioned-source-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.bound-wiki-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 8px;
}

/*
 * 排队条：贴在输入框顶边，比输入框两边各缩进一点，底边不画 —— 看起来像
 * 从输入框背后探出来的一张便签，而不是框里又套了个框。
 */
.queued-tray {
  display: flex;
  flex-direction: column;
  margin: 0 16px;
  padding: 4px 6px 4px 12px;
  border-radius: 12px 12px 0 0;
  background: var(--color-bg-surface);
  box-shadow: inset 0 0 0 1px var(--shadow-highlight);
}

.queued-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  font-size: 12px;
}

/* 「本轮结束后发」：说清这条是什么状态，替掉原来那个看不懂的列表图标 */
.queued-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* 正文吃掉整行剩下的宽度，按钮被推到最右边 */
.queued-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-primary);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/*
 * 「现在插话」。用强调色描边，因为它是这一行里唯一会**当场改变 agent 行为**的
 * 按钮 —— 旁边的改和删只是动一条还没发生的事。
 */
.queued-steer {
  flex-shrink: 0;
  padding: 2px 8px;
  border: 1px solid var(--color-accent-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-accent-text);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover {
    background: var(--color-accent-bg);
  }
}

.queued-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.queued-more {
  align-self: flex-start;
  padding: 2px 0 4px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    color: var(--color-text-secondary);
  }
}

.source-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 6px;
  background: var(--color-accent-bg);
  border-radius: 6px;
  max-width: 200px;
  transition: all 0.15s ease;

  &:hover {
    background: var(--color-accent-bg);

    .pill-remove {
      opacity: 1;
    }
  }
}

.wiki-pill {
  background: var(--color-accent-bg);
  border-color: var(--color-accent-border);

  .pill-icon {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
  }

  .pill-title {
    color: var(--color-accent-text);
  }

  .pill-remove {
    color: var(--color-accent-text);

    &:hover {
      background: var(--color-accent-bg);
      color: var(--color-text-primary);
    }
  }
}

.pill-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
}

.pill-title {
  font-size: 12px;
  color: var(--color-accent-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.pill-remove {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: var(--color-accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.15s ease;
  padding: 0;
  flex-shrink: 0;

  &:hover {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
    opacity: 1;
  }
}

.at-btn {
  width: 28px !important;
  height: 28px !important;
  min-width: 28px !important;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all 0.2s ease;
  flex-shrink: 0;
  margin-right: 8px;

  &:hover:not(.disabled) {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
    color: var(--color-accent-text);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-selected);
  }

  &.disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }

  .at-symbol {
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
  }
}

.source-mention-popover {
  position: absolute;
  bottom: 100%;
  left: 16px;
  width: 360px;
  margin-bottom: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  box-shadow:
    0 4px 16px var(--shadow-color),
    0 0 1px var(--shadow-highlight),
    inset 0 0 0 0.5px var(--shadow-highlight);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  max-height: 200px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.popover-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;

  .header-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-primary);
    letter-spacing: 0.02em;
  }

  .header-hint {
    font-size: 12px;
    color: var(--color-text-primary);
  }
}

.empty-state {
  padding: 16px 12px;
  text-align: center;
  color: var(--color-text-primary);
  font-size: 12px;
}

// 分组标题：一个列表里混着「知识库来源」和「我的笔记」两种东西，
// 不分组用户分不出哪条是哪种
.source-group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);

  .icon-spin {
    font-size: 11px;
  }
}

.source-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;

  /* 自定义滚动条 */
  &::-webkit-scrollbar {
    width: 4px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 2px;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

.source-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s ease;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &:active {
    background: var(--color-bg-surface-hover);
    transform: scale(0.98);
  }

  &.selected {
    background: var(--color-bg-selected);

    .source-icon {
      background: var(--color-bg-selected);
    }
  }

  & + .source-item {
    margin-top: 2px;
  }
}

.check-mark {
  font-size: 12px;
  color: var(--color-accent-text);
  font-weight: 600;
  flex-shrink: 0;
}

.source-icon {
  width: 26px;
  height: 26px;
  border-radius: 5px;
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  flex-shrink: 0;
}

.source-info {
  flex: 1;
  min-width: 0;
}

.source-title {
  font-size: 12px;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.source-type {
  font-size: 12px;
  color: var(--color-text-primary);
  margin-top: 1px;
}

/* Transition */
.popover-fade-enter-active,
.popover-fade-leave-active {
  transition: all 0.2s ease;
}

.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>

<style lang="less">
/* 悬停卡片 teleport 到 body，scoped 样式够不着，这一段必须是全局的。
   只放宽最小宽度 —— 里面是个两栏的用量表，太窄会折行。
   颜色、留白、圆角、投影一律走全局的提示气泡外观（antd-override.css）。 */
.context-usage-tip .app-tooltip {
  min-width: 220px;
}

.context-tip-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--color-text-primary);
}

.context-tip-value {
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.context-tip-track {
  height: 5px;
  border-radius: 999px;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.context-tip-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent-solid);
  transition: width 0.3s ease;
}

.context-tip-fill.high {
  background: var(--color-warning-solid);
}
</style>
