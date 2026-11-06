<template>
  <div class="asset-management">
    <div class="asset-layout">
      <!-- 左侧树形菜单 -->
      <div class="tree-panel" :style="{ width: treePanelWidth + 'px' }">
        <AssetTree
          ref="assetTreeRef"
          :tree-data="treeData"
          :selected-keys="selectedKeys"
          :expanded-keys="expandedKeys"
          :loading="loading"
          @select="enhancedHandleTreeSelect"
          @expand="handleTreeExpand"
          @manage-vaults="handleManageVaults"
          @vault-changed="handleVaultChanged"
          @baiduyun-drag-enter="handleBaiduyunDragEnter"
          @baiduyun-drag-leave="handleBaiduyunDragLeave"
          @download-task-add="addImportTask"
          @download-task-update="updateImportTask"
          @download-task-complete="completeImportTask"
        />
      </div>

      <!-- 拖拽分隔条 -->
      <div class="resize-handle" @mousedown="handleResizeStart"></div>

      <!-- 右侧文件列表 -->
      <div
        class="content-area"
        @dragenter="handleDragEnter"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
        @drop="handleDrop"
      >
        <!-- 网络库主机离线提示 -->
        <AppAlert
          v-if="needsNetworkUpgrade"
          type="info"
          show-icon
          :closable="false"
          banner
          style="flex-shrink: 0"
        >
          <template #message>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>{{ legacyNetworkUpgradeNotice }}</span>
              <AppButton
                size="small"
                variant="link"
                :disabled="upgradeReadinessLoading"
                :loading="retryingNetwork"
                @click="handleNetworkAction"
              >
                {{ legacyNetworkUpgradeAction }}
              </AppButton>
            </div>
          </template>
        </AppAlert>

        <AppAlert
          v-if="isNetworkVault && currentVault?.syncStatus === 'offline' && !needsNetworkUpgrade"
          type="warning"
          show-icon
          :closable="false"
          banner
          style="flex-shrink: 0"
        >
          <template #message>
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span>{{ t('assetManagement.hostOffline') }}</span>
              <AppButton
                size="small"
                variant="link"
                :loading="retryingNetwork"
                @click="handleNetworkAction"
              >
                {{ t('assetManagement.retryConnect') }}
              </AppButton>
            </div>
          </template>
        </AppAlert>

        <AppAlert
          v-if="
            libraryStore.isServer &&
            (libraryStore.signedOut ||
              (libraryStore.activeStatus?.online === false && !libraryCaps.team))
          "
          type="warning"
          show-icon
          :closable="false"
          banner
          class="server-library-banner"
        >
          <template #message>
            <div class="server-library-banner-row">
              <span>{{
                libraryCaps.team
                  ? t('teamProject.state.signedOut')
                  : libraryStore.signedOut
                    ? t('catalogLibrary.view.signedOut')
                    : t('catalogLibrary.view.offlineBanner')
              }}</span>
              <AppButton
                size="small"
                variant="link"
                @click="libraryStore.signedOut ? (serverSignInOpen = true) : handleServerRetry()"
              >
                {{
                  libraryStore.signedOut
                    ? t('catalogLibrary.add.signIn')
                    : t('assetManagement.retryConnect')
                }}
              </AppButton>
            </div>
          </template>
        </AppAlert>

        <!-- 团队工程的横幅：一次一条（连不上 > 在看旧版 > 冻结中 > 工程不在本机），方案 2.11 -->
        <TeamBanner v-if="libraryCaps.team && !libraryStore.signedOut" />

        <AppAlert
          v-if="pendingImportRecoveryNotice"
          type="warning"
          show-icon
          :closable="false"
          banner
          style="flex-shrink: 0"
        >
          <template #message>
            <div
              style="display: flex; align-items: center; justify-content: space-between; gap: 12px"
            >
              <span>{{ t('assetManagement.pendingImportNotice') }}</span>
              <span style="display: inline-flex; align-items: center; gap: 8px">
                <AppButton size="small" variant="link" @click="handleResumePendingImportRecovery">
                  {{ t('assetManagement.processPendingImport') }}
                </AppButton>
                <AppButton
                  size="small"
                  variant="link"
                  @click="handleDismissPendingImportRecoveryNotice"
                >
                  {{ t('assetManagement.ignorePendingImport') }}
                </AppButton>
              </span>
            </div>
          </template>
        </AppAlert>

        <template v-if="assetViewStore.mode === 'assets'">
          <!-- 顶部导航区域 -->
          <div class="navigation-section">
            <div class="nav-controls">
              <div class="nav-button-group">
                <AppButton :disabled="!canGoBack" @click="handleGoBack">
                  <template #icon>
                    <PhCaretLeft />
                  </template>
                </AppButton>
                <AppButton :disabled="!canGoForward" @click="handleGoForward">
                  <template #icon>
                    <PhCaretRight />
                  </template>
                </AppButton>
              </div>
            </div>

            <!-- 面包屑作为地址栏 - Windows 风格折叠 -->
            <div ref="breadcrumbBarRef" class="breadcrumb-bar">
              <div v-if="assetViewStore.mode === 'assets'" class="breadcrumb-nav">
                <!-- 首项：保管库名称 -->
                <template v-if="displayBreadcrumbItems.first">
                  <span class="breadcrumb-item vault">{{ displayBreadcrumbItems.first.name }}</span>
                  <span
                    v-if="
                      displayBreadcrumbItems.collapsed.length > 0 ||
                      displayBreadcrumbItems.visible.length > 0 ||
                      displayBreadcrumbItems.last
                    "
                    class="breadcrumb-separator"
                    >/</span
                  >
                </template>

                <!-- 折叠的中间项：显示为 ... 下拉菜单 -->
                <template v-if="displayBreadcrumbItems.collapsed.length > 0">
                  <AppDropdown placement="bottomLeft">
                    <span class="breadcrumb-item ellipsis">...</span>
                    <template #overlay>
                      <AppMenu @click="handleCollapsedMenuClick">
                        <AppMenuItem
                          v-for="(item, idx) in displayBreadcrumbItems.collapsed"
                          :key="idx"
                          :item-key="idx"
                          :data-path="item.path"
                        >
                          {{ item.name }}
                        </AppMenuItem>
                      </AppMenu>
                    </template>
                  </AppDropdown>
                  <span class="breadcrumb-separator">/</span>
                </template>

                <!-- 可见的中间项 -->
                <template
                  v-for="(item, idx) in displayBreadcrumbItems.visible"
                  :key="'visible-' + idx"
                >
                  <a class="breadcrumb-item" @click="handleBreadcrumbClick(item)">{{
                    item.name
                  }}</a>
                  <span class="breadcrumb-separator">/</span>
                </template>

                <!-- 最后一项：当前目录（不可点击） -->
                <span v-if="displayBreadcrumbItems.last" class="breadcrumb-item current">{{
                  displayBreadcrumbItems.last.name
                }}</span>
              </div>
              <!-- 团队工程：面包屑右端按需出现「主线 ▾」「最新 ▾」（方案 4.5） -->
              <TeamVersionPill v-if="libraryCaps.team" />
            </div>

            <!--
              窄的时候搜索框收成一个放大镜，点开再展开 —— 280px 的输入框和
              面包屑抢的是同一条行，面包屑被挤成「... / Materia」的时候，
              一个常驻的空输入框不值这个位置。
            -->
            <!-- 有关键词就一直摊开：正在生效的筛选不能藏在图标后面 -->
            <div
              class="search-controls"
              :class="{ expanded: searchExpanded || !!filterForm.keyword || teamPageActive }"
            >
              <button
                class="search-icon-btn"
                :title="t('assetLib.search.placeholder')"
                @click="expandSearch"
              >
                <PhMagnifyingGlass />
              </button>
              <div v-if="teamPageActive" class="search-field">
                <a-input
                  v-model:value="teamStore.query"
                  :placeholder="t('teamProject.activity.searchPlaceholder')"
                  class="search-input"
                  allow-clear
                  data-testid="team-search"
                >
                  <template #prefix>
                    <PhMagnifyingGlass />
                  </template>
                </a-input>
              </div>
              <div v-else-if="canQueryCurrentList" class="search-field">
                <a-input
                  ref="searchInputRef"
                  v-model:value="filterForm.keyword"
                  :placeholder="t('assetLib.search.placeholder')"
                  class="search-input"
                  allow-clear
                  @input="handleSearchDebounced"
                  @press-enter="handleSearchImmediate"
                  @blur="handleSearchBlur"
                >
                  <template #prefix>
                    <PhMagnifyingGlass />
                  </template>
                </a-input>
              </div>
            </div>
          </div>

          <!-- 工具栏区域 -->
          <div class="command-bar">
            <!-- 团队工程的几页（动态、对比……）里排序、筛选、标签管理按钮隐藏（方案 4.8） -->
            <div v-show="!teamPageActive" class="left-actions">
              <AppDropdown
                v-if="canQueryCurrentList"
                v-model:open="sortDropdownVisible"
                placement="bottomLeft"
              >
                <button
                  class="action-btn"
                  :class="{ active: sortDropdownVisible }"
                  :title="t('assetLib.actions.sort')"
                >
                  <PhSortAscending />
                  <span class="btn-label">{{ t('assetLib.actions.sort') }}</span>
                </button>
                <template #overlay>
                  <AppMenu @click="handleSortMenuClick">
                    <AppMenuItem key="name-asc" item-key="name-asc">
                      <PhCheck
                        v-if="sortConfig.sortBy === 'assetName' && sortConfig.sortOrder === 'asc'"
                      />
                      {{ t('assetLib.sort.nameAsc') }}
                    </AppMenuItem>
                    <AppMenuItem key="name-desc" item-key="name-desc">
                      <PhCheck
                        v-if="sortConfig.sortBy === 'assetName' && sortConfig.sortOrder === 'desc'"
                      />
                      {{ t('assetLib.sort.nameDesc') }}
                    </AppMenuItem>
                    <AppMenuDivider />
                    <AppMenuItem key="date-asc" item-key="date-asc">
                      <PhCheck
                        v-if="
                          sortConfig.sortBy === 'modifiedTime' && sortConfig.sortOrder === 'asc'
                        "
                      />
                      {{
                        isShowingDeleted
                          ? t('assetLib.sort.deletedAtAsc')
                          : t('assetLib.sort.dateAsc')
                      }}
                    </AppMenuItem>
                    <AppMenuItem key="date-desc" item-key="date-desc">
                      <PhCheck
                        v-if="
                          sortConfig.sortBy === 'modifiedTime' && sortConfig.sortOrder === 'desc'
                        "
                      />
                      <!-- 回收站里这一档排的是删除时间，标签要跟着说实话 -->
                      {{
                        isShowingDeleted
                          ? t('assetLib.sort.deletedAtDesc')
                          : t('assetLib.sort.dateDesc')
                      }}
                    </AppMenuItem>
                    <AppMenuDivider />
                    <AppMenuItem key="size-asc" item-key="size-asc">
                      <PhCheck
                        v-if="sortConfig.sortBy === 'fileSize' && sortConfig.sortOrder === 'asc'"
                      />
                      {{ t('assetLib.sort.sizeAsc') }}
                    </AppMenuItem>
                    <AppMenuItem key="size-desc" item-key="size-desc">
                      <PhCheck
                        v-if="sortConfig.sortBy === 'fileSize' && sortConfig.sortOrder === 'desc'"
                      />
                      {{ t('assetLib.sort.sizeDesc') }}
                    </AppMenuItem>
                    <AppMenuDivider />
                    <AppMenuItem
                      key="type-asc"
                      item-key="type-asc"
                      :disabled="!libraryCaps.sortByType"
                      :title="libraryCaps.sortByType ? undefined : capabilityReason('sortByType')"
                    >
                      <PhCheck
                        v-if="sortConfig.sortBy === 'assetType' && sortConfig.sortOrder === 'asc'"
                      />
                      {{ t('assetLib.sort.typeAsc') }}
                    </AppMenuItem>
                    <AppMenuItem
                      key="type-desc"
                      item-key="type-desc"
                      :disabled="!libraryCaps.sortByType"
                      :title="libraryCaps.sortByType ? undefined : capabilityReason('sortByType')"
                    >
                      <PhCheck
                        v-if="sortConfig.sortBy === 'assetType' && sortConfig.sortOrder === 'desc'"
                      />
                      {{ t('assetLib.sort.typeDesc') }}
                    </AppMenuItem>
                  </AppMenu>
                </template>
              </AppDropdown>

              <button
                v-if="canQueryCurrentList"
                class="action-btn"
                :class="{ active: filterPanelExpanded || hasActiveFilters }"
                :title="t('assetLib.actions.filter')"
                @click="filterPanelExpanded = !filterPanelExpanded"
              >
                <PhFunnel />
                <span class="btn-label">{{ t('assetLib.actions.filter') }}</span>
                <span v-if="activeFilterCount > 0" class="badge">({{ activeFilterCount }})</span>
              </button>

              <!--
                标签管理：低频的维护动作，开在弹窗里。
                原来它是左侧「快捷」区的一项，会占掉整个右侧页面，而内容只有一行半。
              -->
              <button
                class="action-btn"
                :class="{ active: tagManagementOpen }"
                :title="
                  libraryCaps.tagManagement
                    ? t('assetLib.shortcuts.tagManagement')
                    : capabilityReason('tagManagement')
                "
                :disabled="!libraryCaps.tagManagement"
                @click="tagManagementOpen = true"
              >
                <PhTag />
                <span class="btn-label">{{ t('assetLib.shortcuts.tagManagement') }}</span>
              </button>

              <!-- 网络库按钮：只读用户显示拉取同步，可写用户显示扫描变更 -->
              <AppTooltip
                v-if="isNetworkVault"
                :title="
                  isNetworkVaultReadOnly
                    ? t('assetManagement.pullSyncTip')
                    : t('assetManagement.scanChangesTip')
                "
              >
                <button
                  class="action-btn scan-btn"
                  :class="{ active: isScanning }"
                  :disabled="isScanning"
                  @click="isNetworkVaultReadOnly ? handlePullSync() : handleIncrementalScan()"
                >
                  <PhArrowsClockwise v-if="isNetworkVaultReadOnly && !isScanning" />
                  <PhFolderOpen v-else-if="!isScanning" />
                  <PhCircleNotch v-else class="icon-spin" />
                  <span class="btn-label">{{
                    isScanning
                      ? t('assetManagement.syncing')
                      : isNetworkVaultReadOnly
                        ? t('assetManagement.pullSync')
                        : t('assetManagement.scanChanges')
                  }}</span>
                </button>
              </AppTooltip>
            </div>
            <div class="right-actions">
              <div class="size-control">
                <a-slider
                  v-model:value="displaySize"
                  :min="80"
                  :max="200"
                  :step="10"
                  :tooltip-formatter="(value) => `${value}px`"
                  class="size-slider"
                />
              </div>
              <button
                v-if="isShowingDeleted && !libraryCaps.team"
                class="action-btn danger"
                :title="
                  isHttpNetworkVault
                    ? t('assetManagement.recent.clearNotSupported')
                    : t('assetLib.ui.clearRecent')
                "
                :disabled="isHttpNetworkVault"
                @click="handleClearDeleted"
              >
                <PhTrash />
                <span class="btn-label">{{ t('assetLib.ui.clear') }}</span>
              </button>
              <button
                class="action-btn"
                :class="{ active: detailsPanelVisible }"
                :title="t('assetLib.ui.toggleDetails')"
                @click="detailsPanelVisible = !detailsPanelVisible"
              >
                <PhFileText />
                <span class="btn-label">{{ t('assetLib.actions.details') }}</span>
              </button>
            </div>
          </div>

          <AssetFilterBar
            v-if="canQueryCurrentList && !teamPageActive"
            v-model:file-category="filterForm.fileCategory"
            v-model:asset-types="filterForm.assetTypes"
            v-model:size-range="filterForm.sizeRange"
            v-model:date-range="filterForm.dateRange"
            v-model:tags="filterForm.tags"
            v-model:include-tags="filterForm.includeTags"
            v-model:exclude-tags="filterForm.excludeTags"
            v-model:tag-match-mode="filterForm.tagMatchMode"
            v-model:has-no-tags="filterForm.hasNoTags"
            v-model:favorite-status="filterForm.favoriteStatus"
            v-model:show-dependencies="showDependencies"
            v-model:engine-versions="filterForm.engineVersions"
            v-model:keyword="filterForm.keyword"
            :folder-key="selectedKeys[0]"
            :expanded="filterPanelExpanded"
            @apply-filter="handleFilter"
            @reset-filter="handleResetFilter"
            @close="filterPanelExpanded = false"
          />

          <!-- 拖拽覆盖层 -->
          <DragDropOverlay :visible="isDragOver" />

          <TeamCenter v-if="teamPageActive" @open-path="handleTeamOpenPath" />
          <TeamEmptyProject v-else-if="libraryCaps.team && teamStore.isEmpty" />
          <div v-else class="file-list-section">
            <AssetFileList
              ref="assetFileListRef"
              :current-path="currentPath"
              :files="currentFiles"
              :loading="fileListLoading"
              :selected-folder-key="selectedKeys.length > 0 ? selectedKeys[0] : undefined"
              :display-size="displaySize"
              :import-tasks="importTasks"
              :has-more="isSearching ? searchPagination.hasMore : hasMore"
              :is-loading-more="isLoadingMore"
              :list-generation="listGeneration"
              :ensure-files-loaded="ensureFilesLoaded"
              :selection-scope="selectionScope"
              @file-click="handleFileClick"
              @file-open="handleFileOpen"
              @folder-click="handleFolderClick"
              @folder-select="handleFolderSelect"
              @empty-click="handleEmptyClick"
              @drag-overlay-start="onDragOverlayStart"
              @drag-overlay-end="onDragOverlayEnd"
              @load-more="handleLoadMore"
              @locate-in-folder="handleLocateInFolder"
            />
            <!-- 悬浮上传按钮（回收站视图时隐藏） -->
            <div
              v-if="selectionStore.selectedShortcut !== 'recent'"
              class="floating-upload-btn"
              :class="{ 'is-open': importMenuOpen }"
              @keydown.esc="importMenuOpen = false"
            >
              <AppButton
                variant="primary"
                shape="circle"
                size="large"
                class="upload-fab"
                :aria-label="t('assetManagement.importMenu')"
                :aria-expanded="importMenuOpen"
                aria-controls="asset-import-actions"
                @click="handleFabClick"
              >
                <template #icon><PhCloudArrowUp /></template>
              </AppButton>
              <!-- 次级动作：统一圆形图标 + 左侧 tooltip，主按钮才是 primary -->
              <div id="asset-import-actions" class="sub-actions">
                <AppTooltip
                  v-if="libraryCaps.canEditStructure"
                  :title="t('assetManagement.batchThumbnails')"
                  placement="left"
                >
                  <AppButton
                    variant="soft"
                    shape="circle"
                    size="large"
                    class="sub-btn"
                    :aria-label="t('assetManagement.batchThumbnails')"
                    @click="batchThumbnailModalOpen = true"
                  >
                    <template #icon><PhImages /></template>
                  </AppButton>
                </AppTooltip>
                <AppTooltip
                  v-if="isHttpServerVault"
                  :title="t('assetManagement.resumeImportTip')"
                  placement="left"
                >
                  <AppButton
                    variant="soft"
                    shape="circle"
                    size="large"
                    class="sub-btn resume-report-btn"
                    :aria-label="t('assetManagement.resumeImportTip')"
                    :loading="importRecoveryLoading"
                    @click="handleSelectImportRecoveryReport"
                    @dragover.stop.prevent
                    @drop.stop.prevent="handleResumeReportButtonDrop"
                  >
                    <template #icon><PhArrowsClockwise /></template>
                  </AppButton>
                </AppTooltip>
                <AppTooltip
                  v-if="isHttpServerVault"
                  :title="t('assetManagement.importProjectArchive')"
                  placement="left"
                >
                  <AppButton
                    variant="soft"
                    shape="circle"
                    size="large"
                    class="sub-btn"
                    :aria-label="t('assetManagement.importProjectArchive')"
                    @click="handleUploadProjectArchive"
                  >
                    <template #icon><PhFileZip /></template>
                  </AppButton>
                </AppTooltip>
                <AppTooltip
                  :title="
                    libraryCaps.canImport
                      ? t('assetManagement.importFolder')
                      : capabilityReason('canImport')
                  "
                  placement="left"
                >
                  <AppButton
                    variant="soft"
                    shape="circle"
                    size="large"
                    class="sub-btn"
                    :aria-label="t('assetManagement.importFolder')"
                    :disabled="!libraryCaps.canImport"
                    @click="handleUploadFolder"
                  >
                    <template #icon><PhFolderPlus /></template>
                  </AppButton>
                </AppTooltip>
                <AppTooltip
                  :title="
                    libraryCaps.canImport
                      ? t('assetManagement.importFile')
                      : capabilityReason('canImport')
                  "
                  placement="left"
                >
                  <AppButton
                    variant="soft"
                    shape="circle"
                    size="large"
                    class="sub-btn"
                    :aria-label="t('assetManagement.importFile')"
                    :disabled="!libraryCaps.canImport"
                    @click="handleUploadFiles"
                  >
                    <template #icon><PhFilePlus /></template>
                  </AppButton>
                </AppTooltip>
              </div>
            </div>
          </div>
          <DragOverlay :visible="dragOverlayVisible" :text="dragOverlayText" />
        </template>
        <template v-else-if="assetViewStore.mode === 'baiduyun'">
          <Baiduyun />
        </template>
        <template v-else-if="assetViewStore.mode === 'webdav'">
          <Webdav />
        </template>
        <!-- 扫描进度条 - 仅在此页面显示 -->
        <StatusBar />
        <!-- 服务器库：导入前确认仓库和提交说明；登录失效时重新登录 -->
        <CatalogImportModal
          v-if="libraryStore.isServer && libraryStore.activeServerKey"
          :open="serverImportOpen"
          :library-key="libraryStore.activeServerKey"
          :folder="serverImportFolder"
          :initial-files="serverImportFiles"
          @close="serverImportOpen = false"
        />
        <CatalogSignInModal
          :open="serverSignInOpen && !libraryCaps.team"
          :server="libraryStore.activeServer?.server ?? null"
          @close="serverSignInOpen = false"
          @signed-in="handleServerSignedIn"
        />
        <!-- 团队工程：重新登录就是「加入团队」那个框，账号已填好（方案 4.2） -->
        <TeamJoinModal
          :open="serverSignInOpen && Boolean(libraryCaps.team)"
          :relogin="libraryStore.activeServer?.server ?? null"
          @close="serverSignInOpen = false"
          @signed-in="handleServerSignedIn"
        />
        <TeamDialogs v-if="libraryCaps.team" />
        <TeamDeliverModal
          :open="teamDeliverFiles.length > 0"
          :files="teamDeliverFiles"
          @close="teamDeliverFiles = []"
        />
      </div>

      <!-- 详情面板的拖拽分隔条 -->
      <div
        v-show="detailsPanelVisible && assetViewStore.mode === 'assets'"
        class="resize-handle"
        @mousedown="handleDetailsResizeStart"
      ></div>

      <!-- 右侧详情面板（仅在本地资产模式下显示，百度网盘/WebDAV有各自的详情面板） -->
      <div
        v-show="detailsPanelVisible && assetViewStore.mode === 'assets'"
        class="details-panel"
        :style="{ width: detailsPanelWidth + 'px' }"
      >
        <AssetDetailsPanel
          :visible="detailsPanelVisible"
          :asset="selectedAsset"
          :folder="selectedListFolder || selectedFolderDetail"
          @close="handleDetailsClose"
          @folder-updated="handleFolderUpdated"
          @locate-in-folder="handleLocateInFolder"
        />
      </div>

      <!-- 文件预览弹窗 -->
      <FilePreviewModal
        v-if="filePreviewVisible"
        v-model:visible="filePreviewVisible"
        :file="previewFile"
        @close="handlePreviewClose"
      />

      <!-- 标签管理弹窗 -->
      <AppModal
        v-model:open="tagManagementOpen"
        :title="t('assetLib.shortcuts.tagManagement')"
        :width="1160"
        hide-footer
        destroy-on-close
        centered
        class="tag-management-modal"
      >
        <TagManagement />
      </AppModal>
    </div>

    <!-- 导入错误处理弹窗 -->
    <AppModal
      v-model:open="importErrorModalVisible"
      :title="t('assetLib.import.errorTitle')"
      :mask-closable="false"
      :closable="false"
      :keyboard="false"
      width="500px"
    >
      <div v-if="currentImportError" class="import-error-content">
        <p>
          {{ t('assetLib.import.importingFile') }}
          <strong>{{ currentImportError.fileName }}</strong>
          {{ t('assetLib.import.errorOccurred') }}
        </p>
        <div class="error-detail">
          <p>{{ t('assetLib.import.errorInfo') }}{{ currentImportError.error }}</p>
          <p class="path-info">{{ t('assetLib.import.path') }}{{ currentImportError.path }}</p>
        </div>
        <p class="action-tip">{{ t('assetLib.import.waitingDecision') }}</p>
      </div>

      <template #footer>
        <div class="import-error-footer">
          <AppButton danger @click="handleResolveImportError('cancel')">{{
            t('assetLib.import.cancelImport')
          }}</AppButton>
          <div class="right-btns">
            <AppButton @click="handleResolveImportError('ignore')">{{
              t('assetLib.import.ignoreOnce')
            }}</AppButton>
            <AppButton variant="primary" @click="handleResolveImportError('ignore_all')">{{
              t('assetLib.import.ignoreAll')
            }}</AppButton>
          </div>
        </div>
      </template>
    </AppModal>

    <!-- 导入结果弹窗 -->
    <AppModal
      v-model:open="importResultModalVisible"
      :title="
        importResultData?.isCancelled
          ? t('assetLib.import.importCancelled')
          : importResultData?.severity !== 'success'
            ? t('assetLib.import.importIncomplete')
            : t('assetLib.import.importCompleted')
      "
      hide-footer
      width="600px"
    >
      <div v-if="importResultData" class="import-result-content">
        <div class="result-summary">
          <p v-if="!importResultData.isCancelled">
            {{ t('assetLib.import.importSummary', { total: importResultData.total }) }}
            <br />
            <span class="success-text">{{
              t('assetLib.import.successCount', { count: importResultData.successCount })
            }}</span>
            <span class="separator">|</span>
            <span class="error-text">{{
              t('assetLib.import.failedCount', { count: importResultData.failedCount })
            }}</span>
            <span class="separator">|</span>
            <span class="warning-text">{{
              t('assetLib.import.skippedCount', { count: importResultData.skippedCount })
            }}</span>
            <template v-if="importResultData.unconfirmedCount">
              <br />{{
                t('assetLib.import.unconfirmedCount', { count: importResultData.unconfirmedCount })
              }}
            </template>
            <template v-if="importResultData.scanIssueCount">
              <br />{{
                t('assetLib.import.scanIssueCount', { count: importResultData.scanIssueCount })
              }}
            </template>
            <template v-if="importResultData.readFailedCount">
              <br />
              <span class="warning-text">{{
                t('assetLib.import.readFailedCount', { count: importResultData.readFailedCount })
              }}</span>
            </template>
            <template v-if="importResultData.issueCount">
              <br />
              <span class="error-text">{{
                t('assetLib.import.issueCountText', { count: importResultData.issueCount })
              }}</span>
            </template>
          </p>
          <p v-else>
            {{ t('assetLib.import.cancelledMessage') }}
            <br />
            <span class="error-text">{{
              t('assetLib.import.successCount', { count: importResultData.successCount })
            }}</span>
          </p>
        </div>

        <!-- 没进库的文件：这才是这次修复的重点 -->
        <div v-if="importResultData.failures.length > 0" class="failed-list-section">
          <AppButton variant="link" @click="showFailedDetails = !showFailedDetails">
            {{
              showFailedDetails
                ? t('assetLib.import.hideFailedDetails')
                : t('assetLib.import.viewFailedDetails')
            }}
          </AppButton>

          <div v-if="showFailedDetails" class="failed-list">
            <div
              v-for="(item, index) in importResultData.failures"
              :key="`failure-${index}`"
              class="failed-item"
            >
              <div class="file-name">{{ item.fileName }}</div>
              <div class="file-path" :title="item.path">{{ item.path }}</div>
              <div class="file-error">
                <span v-if="item.code" class="error-code">{{ item.code }}</span>
                {{
                  item.error === 'prompt_timeout' || item.error === 'prompt_unavailable'
                    ? skipReasonLabel(item.error)
                    : item.error
                }}
                <span class="retry-hint">
                  {{
                    item.retriable
                      ? t('assetLib.import.failureRetriable')
                      : t('assetLib.import.failureNotRetriable')
                  }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 预处理读取失败（旧口径，单独列出） -->
        <div v-if="importResultData.failedFiles.length > 0" class="failed-list-section">
          <div class="failed-list">
            <div
              v-for="(file, index) in importResultData.failedFiles"
              :key="`read-${index}`"
              class="failed-item"
            >
              <div class="file-name">{{ file.fileName }}</div>
              <div class="file-path" :title="file.path">{{ file.path }}</div>
              <div class="file-error">{{ file.error }}</div>
            </div>
          </div>
        </div>

        <!-- 被跳过的文件：跳过 ≠ 成功 -->
        <div v-if="importResultData.skips.length > 0" class="failed-list-section">
          <AppButton variant="link" @click="showSkippedDetails = !showSkippedDetails">
            {{
              showSkippedDetails
                ? t('assetLib.import.hideSkippedDetails')
                : t('assetLib.import.viewSkippedDetails')
            }}
          </AppButton>

          <div v-if="showSkippedDetails" class="failed-list">
            <div
              v-for="(item, index) in importResultData.skips"
              :key="`skip-${index}`"
              class="failed-item"
            >
              <div class="file-name">{{ item.fileName }}</div>
              <div class="file-path" :title="item.path">{{ item.path }}</div>
              <div class="file-error">{{ skipReasonLabel(item.reason) }}</div>
            </div>
          </div>
        </div>

        <div v-if="importResultData.errorReportPath" class="failed-list-section">
          <div class="file-error">
            {{ t('assetLib.import.errorReportNote') }}
          </div>
          <div class="file-path" :title="importResultData.errorReportPath">
            {{ importResultData.errorReportPath }}
          </div>
          <AppButton
            variant="link"
            @click="revealImportIssueReport(importResultData.errorReportPath)"
          >
            {{ t('assetLib.import.openErrorReport') }}
          </AppButton>
        </div>

        <div class="result-footer">
          <AppButton
            v-if="importResultData.retriableCount > 0"
            type="primary"
            :loading="importRetryLoading"
            @click="retryFailedImportFiles"
          >
            {{ t('assetLib.import.retryFailedFiles', { count: importResultData.retriableCount }) }}
          </AppButton>
          <AppButton @click="importResultModalVisible = false">{{ t('common.close') }}</AppButton>
        </div>
      </div>
    </AppModal>

    <!-- 覆盖确认对话框 -->
    <AppModal
      v-model:open="overwriteConfirmVisible"
      :title="t('assetLib.import.overwriteConfirm')"
      :mask-closable="false"
      :closable="false"
      :keyboard="false"
      width="450px"
    >
      <div v-if="overwriteConfirmData" class="overwrite-confirm-content">
        <p>
          {{ t('assetLib.import.overwriteMessage', { fileName: overwriteConfirmData.fileName }) }}
        </p>
        <p class="overwrite-timeout-tip">
          {{ t('assetLib.import.overwriteAutoSkipTip', { seconds: overwriteCountdown }) }}
        </p>
      </div>

      <template #footer>
        <div class="overwrite-confirm-footer">
          <div class="left-btns">
            <AppButton @click="handleOverwriteConfirm('skipAll')">
              {{ t('assetLib.import.skipAll') }}
            </AppButton>
            <AppButton @click="handleOverwriteConfirm('skip')">
              {{ t('common.skip') }}
            </AppButton>
          </div>
          <div class="right-btns">
            <AppButton variant="primary" @click="handleOverwriteConfirm('overwrite')">
              {{ t('common.confirm') }}
            </AppButton>
            <AppButton variant="primary" @click="handleOverwriteConfirm('overwriteAll')">
              {{ t('assetLib.import.overwriteAll') }}
            </AppButton>
          </div>
        </div>
      </template>
    </AppModal>
    <!-- 批量缩略图上传弹窗(连击 upload-fab 5次触发) -->
    <BatchThumbnailUploadModal
      v-model:open="batchThumbnailModalOpen"
      @done="handleBatchThumbnailDone"
    />
  </div>
</template>

<script setup lang="ts">
import AppAlert from '@renderer/components/AppAlert.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { useAssetSideButtons } from './composables/useAssetSideButtons'
import type { Ref } from 'vue'
import {
  ref,
  onMounted,
  onUnmounted,
  onActivated,
  provide,
  computed,
  nextTick,
  reactive,
  watch,
  defineAsyncComponent,
  h
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog, warningDialog } from '@renderer/utils/dialog'
import { describeShellOpenFailure } from '@renderer/utils/shellOpen'
import {
  PhArrowsClockwise,
  PhCaretLeft,
  PhCaretRight,
  PhCheck,
  PhCircleNotch,
  PhCloudArrowUp,
  PhFilePlus,
  PhFileText,
  PhFileZip,
  PhFolderOpen,
  PhFolderPlus,
  PhFunnel,
  PhImages,
  PhMagnifyingGlass,
  PhSortAscending,
  PhTag,
  PhTrash
} from '@phosphor-icons/vue'
import AssetTree from './components/AssetTree.vue'
import AssetFileList from './components/AssetFileList.vue'
import DragOverlay from '@renderer/components/DragOverlay.vue'
import DragDropOverlay from '@renderer/components/DragDropOverlay.vue'
import StatusBar from '@renderer/components/StatusBar.vue'
import { ASSET_CATEGORIES } from '@renderer/constants/assetCategories'

// 异步加载非关键组件，减少初始bundle大小
const AssetDetailsPanel = defineAsyncComponent(() => import('./components/AssetDetailsPanel.vue'))
const AssetFilterBar = defineAsyncComponent(() => import('./components/AssetFilterBar.vue'))
const Baiduyun = defineAsyncComponent(() => import('./Baiduyun.vue'))
const Webdav = defineAsyncComponent(() => import('./Webdav.vue'))
const TagManagement = defineAsyncComponent(() => import('./TagManagement/index.vue'))
const FilePreviewModal = defineAsyncComponent(() => import('./components/FilePreviewModal.vue'))
const BatchThumbnailUploadModal = defineAsyncComponent(
  () => import('./components/modals/BatchThumbnailUploadModal.vue')
)
import { openImageViewer } from '@renderer/services/imageViewer'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import { useWebdavStore } from '@renderer/store/modules/webdav'
import { useAssetViewStore } from '../../store/modules/assetViewStore'
import { useImportTasksStore, type ImportTask } from '@renderer/store/modules/importTasks'
import { useAssetSelectionStore } from '../../store/modules/assetSelectionStore'
import { useAssetTree } from './hooks/useAssetTree'
import assetDataAPI from '@renderer/api/assetData'
import { formatFileSize } from '@renderer/utils/tool'
import { assetFolderAPI } from '@renderer/api/assetFolder'
import { runWithConcurrency } from '@renderer/common/utils'
import { saveDroppedImageFileAsAsset } from '@renderer/services/assetOperationService'
import { describeRejectedDrops, filterDroppedPaths } from '@renderer/utils/droppedPathGuard'

// 定义组件名称以支持 keep-alive 缓存
defineOptions({
  name: 'AssetManagement'
})
import { AssetContextKey, type AssetContext } from './context'
import { useVaultStore, VaultType } from '../../store/modules/vaultStore'
import { useAssetLibraryStore } from '../../store/modules/assetLibraryStore'
import { getActiveLibrarySource } from './data/activeLibrarySource'
import CatalogImportModal from './catalog/CatalogImportModal.vue'
import CatalogSignInModal from './catalog/CatalogSignInModal.vue'
import TeamBanner from './team/TeamBanner.vue'
import TeamCenter from './team/TeamCenter.vue'
import TeamDialogs from './team/TeamDialogs.vue'
import TeamDeliverModal from './team/TeamDeliverModal.vue'
import TeamEmptyProject from './team/TeamEmptyProject.vue'
import TeamJoinModal from './team/TeamJoinModal.vue'
import TeamVersionPill from './team/TeamVersionPill.vue'
import { assetRowByPath } from './team/teamAssets'
import { useTeamStore } from '../../store/modules/teamStore'
import {
  buildDirectFileUrl,
  buildThumbnailUrl,
  resolveAssetFilePath
} from '@renderer/utils/thumbnails'
import { resolveAssetAccess, resolveAssetUrlWithFallback } from '@renderer/utils/assetAccess'
import { useAssetNavigationStore } from '../../store/modules/assetNavigationStore'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import {
  buildImportResultView,
  type FolderImportCompletedPayload,
  type ImportResultView
} from './utils/importResultView'
import { filterRetriableFailures, type ImportSkipEntry } from '@core/shared/assetImport'
import { describeImportError } from './importErrorText'
import type { ImportErrorDetails } from '@core/shared/importErrorKey'
import {
  isHttpNetworkVault as isHttpNetworkVaultKind,
  resolveErrorText
} from './utils/assetVaultHelpers'

const {
  treeData,
  selectedKeys,
  expandedKeys,
  currentPath,
  loading,
  handleTreeSelect,
  handleTreeExpand,
  loadRootFolders,
  addFolder,
  deleteFolder,
  renameFolder,
  loadAssetsByFolder,
  getSubFolders,
  navigateToFolder,
  resetTreeState,
  findNodeByKey,
  ensureNodeExists,
  hydrateExpandedNodes,
  updateNodeColor,
  refreshNodeChildren
} = useAssetTree()

const isSwitchingVault = ref(false)

const { t } = useI18n()

const navStore = useAssetNavigationStore()
const baiduyunStore = useBaiduyunStore()
const webdavStore = useWebdavStore()
const assetViewStore = useAssetViewStore()
const selectionStore = useAssetSelectionStore()
/**
 * 当前数据源（本地库 / 服务器库）和它能做什么。界面按能力显示、禁用（并给一句原因），
 * 不判断库的种类。服务器库不走主进程的切换保管库，vaultStore.currentVault 仍是本地库。
 */
const libraryStore = useAssetLibraryStore()
const libraryCaps = computed(() => libraryStore.capabilities)
/** 树的标签页状态按数据源分开存：本地库和服务器库的文件夹键互不相认 */
const treeStateKey = (tabId: string): string =>
  libraryStore.source.kind === 'local' ? tabId : `${tabId}@${libraryStore.source.id}`
const capabilityReason = (name: string): string => {
  const key = libraryCaps.value.reasons[name]
  return key ? t(key) : ''
}
const route = useRoute()
const isAssetPageActive = useAssetSideButtons(
  (event) => handleSideMouseButtons(event),
  () => {
    navStore.setTabId((route.query._tab_id as string) || 'default')
  },
  () => navStore.cancelNavigation()
)

const batchThumbnailModalOpen = ref(false)
const tagManagementOpen = ref(false)
const importMenuOpen = ref(false)

// ---- 服务器库：导入确认、重新登录、实时刷新
const serverImportOpen = ref(false)
const serverImportFiles = ref<string[]>([])
const serverSignInOpen = ref(false)

// ---- 团队工程：中间区域在看哪一页、外包的交付
const teamStore = useTeamStore()
/** 动态、对比、签出中……这几页顶替网格（点左栏文件夹就回到网格） */
const teamPageActive = computed(() => Boolean(libraryCaps.value.team) && teamStore.view !== 'grid')
/** 外包把文件拖进「交付」：先出「交付给 星海」确认窗 */
const teamDeliverFiles = ref<string[]>([])

/** 动态 / 签出中 / 对比里点了一个资产：右边详情打开它 */
const handleTeamOpenPath = async (path: string): Promise<void> => {
  const key = libraryStore.activeServerKey
  if (!key) return
  const row = await assetRowByPath(key, path)
  if (!row) return
  detailsPanelVisible.value = true
  handleFileClick(row)
}
const serverImportFolder = ref<{
  dirId: number
  path: string
  name: string
  nDirect: number
  nSubtree: number
  bytes: number
  nDirs: number
}>({
  dirId: 0,
  path: '',
  name: '',
  nDirect: 0,
  nSubtree: 0,
  bytes: 0,
  nDirs: 0
})
watch(serverImportOpen, async (open) => {
  if (!open) return
  const key = selectedKeys.value[0] || ALL_FOLDER
  const record = (await getActiveLibrarySource()
    .folders.getByKey(key)
    .catch(() => undefined)) as
    | (AssetFolder & { catalogDirId?: number; catalogPath?: string })
    | undefined
  serverImportFolder.value = {
    ...serverImportFolder.value,
    dirId: record?.catalogDirId ?? 0,
    path: record?.catalogPath ?? '',
    name: record?.folderName ?? ''
  }
})

const handleServerRetry = async (): Promise<void> => {
  await libraryStore.refreshStatus()
  await loadCurrentFolderAssets()
}

const handleServerSignedIn = async (): Promise<void> => {
  await libraryStore.loadServerLibraries()
  if (libraryStore.activeServerKey) await libraryStore.activateServer(libraryStore.activeServerKey)
  await refreshFolderTreePreservingExpansion()
  // 搜索框里还有词：登录失效前那次搜索没搜成，重新搜一遍，而不是退回浏览
  if (filterForm.keyword?.trim()) await performRecursiveSearch(filterForm.keyword)
  else await loadCurrentFolderAssets()
}

/**
 * 服务器库内容变了：把已经加载的那几页按原样重取一遍（没受影响的页主进程直接命中缓存），
 * 展开过的树节点重载子文件夹。不回到顶部、不收起树。
 */
watch(
  () => libraryStore.invalidationCount,
  async () => {
    if (!libraryStore.isServer || assetViewStore.mode !== 'assets') return
    const pages = Math.max(1, currentPage.value)
    const folderKey = selectedKeys.value[0]
    if (isSearching.value || !folderKey) {
      await loadCurrentFolderAssets()
    } else {
      const token = beginListRequest()
      try {
        await loadBrowsePage(folderKey, 1, false, token)
        for (let page = 2; page <= pages && hasMore.value; page += 1) {
          await loadBrowsePage(folderKey, page, true, token)
        }
      } catch (error) {
        console.warn('[服务器库] 刷新可见页失败:', error)
      }
    }
    // 父节点先刷：子节点的刷新要挂在新的父节点上
    const depth = (key: string): number => findNodeByKey(key)?.path.split('/').length ?? 99
    for (const key of [...expandedKeys.value].sort((a, b) => depth(a) - depth(b))) {
      await refreshNodeChildren(key).catch(() => undefined)
    }
  }
)

const handleFabClick = (): void => {
  importMenuOpen.value = !importMenuOpen.value
}

const refreshFolderTreePreservingExpansion = async (): Promise<void> => {
  await loadRootFolders()
  if (expandedKeys.value.length > 0) {
    await hydrateExpandedNodes()
  }
}

const handleBatchThumbnailDone = async (): Promise<void> => {
  await loadCurrentFolderAssets()
  await refreshFolderTreePreservingExpansion()
}

// 获取当前保管库信息
const vaultStore = useVaultStore()
const currentVault = computed(() => vaultStore.currentVault)
const isHttpNetworkVault = computed(
  () => libraryCaps.value.vaultFeatures && isHttpNetworkVaultKind(currentVault.value)
)
const getNetworkSyncMessageKey = (vaultId?: string): string =>
  `network-sync-progress:${vaultId || 'unknown'}`
let networkSyncProgressHandler: ((...args: unknown[]) => void) | null = null
let networkSyncCompleteHandler: ((...args: unknown[]) => void) | null = null
let networkSyncStatusHandler: ((...args: unknown[]) => void) | null = null
const needsNetworkUpgrade = computed(
  () =>
    libraryCaps.value.vaultFeatures &&
    currentVault.value?.vaultType === VaultType.NETWORK &&
    currentVault.value?.networkMigrationState === 'legacy_pending'
)

// 网络库检测和扫描
const isNetworkVault = computed(
  () => libraryCaps.value.vaultFeatures && currentVault.value?.vaultType === VaultType.NETWORK
)

/**
 * 传给主进程 `importFolderStructureWithMetadata` 的拷贝并发数。
 *
 * **只在局域网（SMB）库那一档给值**，其余一律 undefined。主进程那个参数落在两个地方：
 * SMB 的 copyFile 循环，以及远端 HTTP 库的 `runWithRemoteImportPermit`。后者是
 * **每个库一个、进程内长期存活**的会话信号量，传值等于 setLimit —— 改完不还原，
 * 另一个传 undefined 的调用又会把它顶回默认值并立刻放行一个排队者，于是「有效上限」
 * 取决于调用顺序。HTTP 库和本地库压根走不到 copyFile 那段，对它们传值只有副作用。
 *
 * 提成函数是因为有三条导入入口（整文件夹拖入、单文件拖入、失败重试），
 * 而这个值以前只在整文件夹那一条里算。另外两条传 undefined，主进程于是回落到 3 ——
 * 正是删掉用户可调项时给的理由（「别拿 3 路去压 SMB」）所要避免的。
 * 重试那条最要命：它紧跟在同一个共享上的一次拷贝失败之后跑，还带着 forceOverwrite。
 */
const copyConcurrencyForMain = (): number | undefined => {
  const path = currentVault.value?.networkPath
  const isRemoteHttp =
    currentVault.value?.vaultType === VaultType.NETWORK && !!path && /^https?:\/\//i.test(path)
  return isNetworkVault.value && !isRemoteHttp ? 1 : undefined
}
const isScanning = ref(false)
const isNetworkVaultReadOnly = ref(false)
const retryingNetwork = ref(false)
const upgradeReadinessLoading = ref(false)
const upgradeReadinessReady = ref(false)
const legacyNetworkUpgradeNotice = ref(t('assetManagement.upgrade.checking'))
const legacyNetworkUpgradeAction = computed(() =>
  upgradeReadinessLoading.value
    ? t('assetManagement.upgrade.checkingStatus')
    : upgradeReadinessReady.value
      ? t('assetManagement.upgrade.startButton')
      : t('assetManagement.upgrade.recheckButton')
)

const checkNetworkUpgradeReadiness = async (): Promise<boolean> => {
  if (!currentVault.value?.id || !needsNetworkUpgrade.value) return false

  upgradeReadinessLoading.value = true
  try {
    const result = await window.electron.ipcRenderer.invoke(
      'vault:checkUpgradeReadiness',
      currentVault.value.id
    )

    if (!result.success || !result.data) {
      upgradeReadinessReady.value = false
      legacyNetworkUpgradeNotice.value = t('assetManagement.upgrade.cannotUpgrade', {
        error: result.error || t('assetManagement.upgrade.checkFailed')
      })
      return false
    }

    if (!result.data.ready) {
      upgradeReadinessReady.value = false
      legacyNetworkUpgradeNotice.value = t('assetManagement.upgrade.cannotUpgrade', {
        error: result.data.error || t('assetManagement.upgrade.serverUnavailable')
      })
      return false
    }

    upgradeReadinessReady.value = true
    legacyNetworkUpgradeNotice.value = t('assetManagement.upgrade.ready', {
      assets: result.data.assetCount,
      folders: result.data.folderCount
    })
    return true
  } catch (error) {
    upgradeReadinessReady.value = false
    legacyNetworkUpgradeNotice.value = t('assetManagement.upgrade.cannotUpgrade', {
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  } finally {
    upgradeReadinessLoading.value = false
  }
}

watch(
  [needsNetworkUpgrade, () => currentVault.value?.id],
  async ([upgradeNeeded, vaultId]) => {
    if (!upgradeNeeded || !vaultId) {
      upgradeReadinessReady.value = false
      upgradeReadinessLoading.value = false
      legacyNetworkUpgradeNotice.value = t('assetManagement.upgrade.afterUpgradeNote')
      return
    }

    await checkNetworkUpgradeReadiness()
  },
  { immediate: true }
)

const handleNetworkAction = async (): Promise<void> => {
  if (!currentVault.value?.id || retryingNetwork.value) return

  if (needsNetworkUpgrade.value && !(await checkNetworkUpgradeReadiness())) {
    return
  }

  retryingNetwork.value = true
  try {
    const result = await window.electron.ipcRenderer.invoke(
      'vault:retryNetwork',
      currentVault.value.id
    )

    if (result.success) {
      if (needsNetworkUpgrade.value) {
        if (result.audit?.hasDrift) {
          warningDialog({
            title: t('assetManagement.upgrade.metadataChangedTitle'),
            content: t('assetManagement.upgrade.metadataChangedContent', {
              beforeAssets: result.audit.beforeAssetCount,
              beforeFolders: result.audit.beforeFolderCount,
              afterAssets: result.audit.afterAssetCount,
              afterFolders: result.audit.afterFolderCount,
              backupPath: result.audit.backupPath
            }),
            width: 640
          })
        } else {
          message.success(t('assetManagement.upgrade.done'))
        }
      } else {
        message.success(t('assetManagement.upgrade.networkRestored'))
      }

      await vaultStore.refreshVaults()
      await loadRootFolders()
      await hydrateExpandedNodes()
      return
    }

    message.warning(
      result.error ||
        (needsNetworkUpgrade.value
          ? t('assetManagement.upgrade.failedServerCheck')
          : t('assetManagement.upgrade.networkUnreachable'))
    )
  } catch (error) {
    console.error('[AssetManagement] network action failed:', error)
    message.error(
      needsNetworkUpgrade.value
        ? t('assetManagement.upgrade.failedRetry')
        : t('assetManagement.upgrade.retryFailed')
    )
  } finally {
    retryingNetwork.value = false
  }
}

/**
 * 重试网络保管库连接
 */
const handleRetryNetworkConnection = async (): Promise<void> => {
  if (!currentVault.value?.id || retryingNetwork.value) return

  if (needsNetworkUpgrade.value && !(await checkNetworkUpgradeReadiness())) {
    return
  }

  retryingNetwork.value = true
  try {
    const result = await window.electron.ipcRenderer.invoke(
      'vault:retryNetwork',
      currentVault.value.id
    )
    if (result.success) {
      message.success(t('assetManagement.upgrade.networkRestored'))
      if (needsNetworkUpgrade.value && result.audit?.hasDrift) {
        warningDialog({
          title: t('assetManagement.upgrade.metadataChangedTitle'),
          content: t('assetManagement.upgrade.metadataChangedContent', {
            beforeAssets: result.audit.beforeAssetCount,
            beforeFolders: result.audit.beforeFolderCount,
            afterAssets: result.audit.afterAssetCount,
            afterFolders: result.audit.afterFolderCount,
            backupPath: result.audit.backupPath
          }),
          width: 640
        })
      }
      await vaultStore.refreshVaults()
      await loadRootFolders()
      await hydrateExpandedNodes()
    } else {
      message.warning(result.error || t('assetManagement.upgrade.networkUnreachable'))
    }
  } catch (error) {
    console.error('[AssetManagement] 重试网络连接失败:', error)
    message.error(t('assetManagement.upgrade.retryFailed'))
  } finally {
    retryingNetwork.value = false
  }
}

/**
 * 检测网络库写入权限（V2）
 * Server 模式 = 可写，Client 模式 = 根据连接状态判断
 */
const checkNetworkVaultWritePermission = async (): Promise<void> => {
  if (!isNetworkVault.value || !currentVault.value?.id) {
    isNetworkVaultReadOnly.value = false
    return
  }
  try {
    const result = await window.api.invoke(
      'networkVaultV2:getConnectionStatus',
      currentVault.value.id
    )
    if (result.success && result.data) {
      // Fix #4: 优先使用服务端返回的 permission 判断权限
      if (result.data.permission) {
        isNetworkVaultReadOnly.value = result.data.permission === 'readonly'
      } else {
        // 向后兼容：无 permission 字段时 fallback 到 role 判断
        isNetworkVaultReadOnly.value = result.data.role === 'client'
      }
      console.log(
        '[AssetManagement] V2 网络库角色:',
        result.data.role,
        '权限:',
        result.data.permission || '(未提供)',
        result.data.connected ? '已连接' : '未连接'
      )
    } else {
      isNetworkVaultReadOnly.value = true
    }
  } catch (error) {
    console.error('[AssetManagement] V2 权限检测失败:', error)
    isNetworkVaultReadOnly.value = true
  }
}

// 🔧 监听局域网协作库状态变化，自动检测权限（包括首次加载）
watch(
  isNetworkVault,
  async (isNetwork) => {
    if (isNetwork) {
      await checkNetworkVaultWritePermission()
    } else {
      isNetworkVaultReadOnly.value = false
    }
  },
  { immediate: true }
)

/**
 * 拉取同步 — V2 版本
 * 先通过 IPC 触发 SyncClient 从 Server 拉取最新数据（含缩略图路径等更新），
 * 然后刷新 UI
 */
const handlePullSync = async (): Promise<void> => {
  if (!currentVault.value?.id) {
    message.warning(t('assetManagement.sync.vaultInfoFailed'))
    return
  }

  isScanning.value = true
  try {
    // 先触发后端 SyncClient 从 Server 拉取最新变更
    const pullResult = await window.api.invoke('networkVaultV2:pullSync', currentVault.value.id)
    if (!pullResult.success) {
      console.warn('[AssetManagement] 拉取同步警告:', pullResult.error)
      message.warning(pullResult.error || t('assetManagement.sync.pullFailed'))
    }

    // 然后刷新 UI（即使拉取失败也刷新本地缓存数据）
    await vaultStore.refreshVaults()
    await loadCurrentFolderAssets()
    await loadRootFolders()
    await hydrateExpandedNodes()
    if (pullResult.success) {
      message.success(t('assetManagement.sync.done'))
    }
  } catch (error) {
    console.error('[AssetManagement] 同步失败:', error)
    message.error(t('assetManagement.sync.failed'))
  } finally {
    isScanning.value = false
  }
}

/**
 * 增量扫描网络库 — V2 版本
 * 触发 Server 端文件系统扫描
 */
const handleIncrementalScan = async (): Promise<void> => {
  if (!currentVault.value?.id) {
    message.warning(t('assetLib.scan.networkPathError'))
    return
  }

  isScanning.value = true
  try {
    const result = await window.api.invoke('networkVaultV2:scan', currentVault.value.id)

    if (result.success) {
      await vaultStore.refreshVaults()
      await loadRootFolders()
      await hydrateExpandedNodes()
      await loadCurrentFolderAssets()
      // 主进程把读不到的目录数算在 failedDirs 里，partial 为真就不是一次完整的扫描。
      // 本机主机和远程可写客户端两条路径都带这两个字段（远程那条经 POST /scan 的
      // data 原样回传），报「扫描完成」会把半个库读不到说成成功。
      if (result.data?.partial) {
        message.warning(t('assetManagement.scan.partial', { count: result.data.failedDirs ?? 0 }))
      } else {
        message.success(t('assetManagement.scan.done'))
      }
    } else {
      message.error(t('assetLib.scan.scanFailed', { error: result.error }))
    }
  } catch (error) {
    console.error('[AssetManagement] V2 扫描失败:', error)
    message.error(t('assetLib.scan.incrementalScanFailed', { error: 'Unknown' }))
  } finally {
    isScanning.value = false
  }
}

const handleAutoNetworkSyncOnSwitch = async (): Promise<void> => {
  if (!isNetworkVault.value || !currentVault.value?.id) return

  try {
    const statusResult = await window.api.invoke(
      'networkVaultV2:getConnectionStatus',
      currentVault.value.id
    )

    if (!statusResult.success || !statusResult.data) {
      console.warn('[AssetManagement] 自动网络同步跳过: 无法获取连接状态', statusResult.error)
      return
    }

    if (statusResult.data.role === 'client') {
      console.log('[AssetManagement] 切换到远程网络库，先执行拉取同步')
      await handlePullSync()
      return
    }

    await handleIncrementalScan()
  } catch (error) {
    console.warn('[AssetManagement] 自动网络同步失败，已跳过自动扫描:', error)
  }
}

let stopImportErrorSettled: (() => void) | undefined
let stopOverwriteSettled: (() => void) | undefined

// 导入错误处理状态
const importErrorModalVisible = ref(false)
const currentImportError = ref<{
  taskId: string
  fileName: string
  path: string
  error: string
  failedCount: number
} | null>(null)

// 处理导入错误的操作
const handleResolveImportError = async (
  action: 'ignore' | 'ignore_all' | 'cancel'
): Promise<void> => {
  const prompt = currentImportError.value
  if (!prompt) return

  try {
    await assetDataAPI.resolveImportError(prompt.taskId, action)
    if (currentImportError.value === prompt) {
      importErrorModalVisible.value = false
      currentImportError.value = null
    }
  } catch (e) {
    console.error('Failed to resolve import error:', e)
    message.error(t('assetLib.import.resolveErrorFailed'))
  }
}

// 导入结果汇总状态
const importResultModalVisible = ref(false)
const importResultData = ref<ImportResultView | null>(null)
const showFailedDetails = ref(false)
const showSkippedDetails = ref(false)
const importRetryLoading = ref(false)
const overwriteCountdown = ref(0)
let overwriteCountdownTimer: ReturnType<typeof setInterval> | null = null

const clearOverwriteCountdown = (): void => {
  if (overwriteCountdownTimer) {
    clearInterval(overwriteCountdownTimer)
    overwriteCountdownTimer = null
  }
}

/**
 * 结果弹窗只有一个，而导入可以并发。
 *
 * 以前后完成的那次导入直接把 importResultData 顶掉：A 有 37 个失败、B 全成功且
 * 后完成 → A 的失败清单和「重试」按钮凭空消失，只剩控制台和异常报告 JSON。
 * 现在排队，一个一个给用户看完。
 */
const pendingImportResults: ImportResultView[] = []

const showImportResult = (view: ImportResultView): void => {
  if (!view.open) return
  if (importResultModalVisible.value) {
    pendingImportResults.push(view)
    return
  }
  importResultData.value = view
  // 有文件没进库时默认把清单展开 —— 这正是用户需要看的东西
  showFailedDetails.value = view.failures.length > 0
  showSkippedDetails.value = false
  importResultModalVisible.value = true
}

watch(importResultModalVisible, (open) => {
  if (open) return
  const next = pendingImportResults.shift()
  if (next) void nextTick(() => showImportResult(next))
})

const skipReasonLabel = (reason: ImportSkipEntry['reason']): string =>
  t(`assetLib.import.skipReason.${reason}`)

/**
 * 只重试失败的那些文件。
 *
 * 为什么不整包重导：网络库模式每次都会新建 `folder_${Date.now()}_xxx` 根节点，
 * 整包重导等于在库里造出第二棵同名目录树。这里只重发失败子集，并让主进程
 * 复用已有目录树（reuseExistingFolders）、对半截目标文件直接覆盖（forceOverwrite）。
 *
 * 必须带上 folder 条目：写库循环的 folderKey 来自 pathToKeyMap，
 * 只发 file 条目会让所有重试文件塌到根目录。
 */
const retryFailedImportFiles = async (): Promise<void> => {
  const data = importResultData.value
  const context = data?.retryContext
  const retriable = data ? filterRetriableFailures(data.failures) : []
  if (!context || retriable.length === 0) return

  if (!context.vaultId || context.vaultId !== currentVault.value?.id) {
    message.warning(t('assetLib.import.retryOriginalVault'))
    return
  }
  const retryTaskId = createImportTaskId(context.taskId)
  importRetryLoading.value = true
  try {
    addImportTask({
      id: retryTaskId,
      type: 'folder',
      name: t('assetLib.import.retryTaskName', { count: retriable.length }),
      progress: 0,
      stageText: t('assetLib.import.retryStage'),
      status: 'running',
      folderKey: context.targetFolderKey || undefined,
      taskType: 'vault-import',
      vaultId: context.vaultId,
      cancellable: true
    })
    const failedPaths = new Set(retriable.map((item) => item.path))
    let contents: Array<Record<string, unknown>>
    let scanIssues: Array<{ path: string; reason: string }> = []

    if (context.rootFolderPath === ALL_FOLDER) {
      // 散文件导入没有目录结构，直接按失败清单构造
      contents = retriable.map((item) => ({
        name: item.fileName,
        path: item.path,
        type: 'file',
        size: null,
        modifiedTime: new Date().toISOString(),
        depth: 0,
        relativePath: item.fileName
      }))
    } else {
      const scan = await window.api.fs.readFolderContentsRecursive(context.rootFolderPath, {
        taskId: retryTaskId
      })
      if (!scan?.success) {
        throw new Error(scan?.error || t('assetLib.import.retryNoFilesLeft'))
      }
      scanIssues = scan.diagnostics?.skippedItems ?? []
      contents = (scan.data ?? []).filter(
        (entry: { type: string; path: string }) =>
          entry.type === 'folder' ||
          [...failedPaths].some(
            (path) =>
              entry.path === path ||
              entry.path
                .replace(/\\/g, '/')
                .startsWith(path.replace(/\\/g, '/').replace(/\/$/, '') + '/')
          )
      )
    }

    if (!contents.some((entry) => entry.type === 'file')) {
      completeImportTask(retryTaskId)
      message.warning(t('assetLib.import.retryNoFilesLeft'))
      return
    }

    if (cancelledVaultImports.has(retryTaskId))
      throw new Error(t('assetManagement.import.cancelled'))
    importResultModalVisible.value = false

    await assetDataAPI.importFolderStructureWithMetadata(
      contents,
      context.rootFolderPath,
      context.targetFolderKey || undefined,
      copyConcurrencyForMain(),
      retryTaskId,
      { retryOfTaskId: context.taskId, vaultId: context.vaultId, forceOverwrite: false, scanIssues }
    )
  } catch (error) {
    if (data)
      updateImportTask(retryTaskId, {
        progress: 100,
        status: 'error',
        vaultResult: data,
        stageText: String(error)
      })
    message.error(
      t('assetLib.import.retryFailed', {
        error: error instanceof Error ? error.message : String(error)
      })
    )
  } finally {
    importRetryLoading.value = false
  }
}

const revealImportIssueReport = async (reportPath?: string): Promise<void> => {
  if (!reportPath) return
  try {
    // 返回值必须看：这批 shell:* 失败时是 return {success:false}，不抛 —— 只 catch 等于静默
    const failure = describeShellOpenFailure(
      await window.api.shell.showItemInFolder(reportPath),
      reportPath
    )
    if (failure) {
      message[failure.level](
        t('assetLib.contextMenu.openLocalPathFailedAt', {
          path: failure.target,
          error: failure.error
        }),
        8
      )
    }
  } catch (error) {
    console.error('打开导入异常报告位置失败:', error)
    message.error(t('assetManagement.import.openReportFailed'))
  }
}

// 覆盖确认对话框状态
const overwriteConfirmVisible = ref(false)
const overwriteConfirmData = ref<{
  confirmId: string
  fileName: string
  targetPath: string
} | null>(null)

/**
 * 处理覆盖确认对话框的操作
 * @param action - 操作类型: 'skip' 跳过, 'overwrite' 覆盖, 'skipAll' 全部跳过, 'overwriteAll' 全部覆盖
 */
const handleOverwriteConfirm = (
  action: 'skip' | 'overwrite' | 'skipAll' | 'overwriteAll'
): void => {
  if (!overwriteConfirmData.value) return
  clearOverwriteCountdown()

  window.electron.ipcRenderer.send('asset:confirmOverwriteResponse', {
    confirmId: overwriteConfirmData.value.confirmId,
    confirmed: action === 'overwrite' || action === 'overwriteAll',
    applyToAll: action === 'skipAll' || action === 'overwriteAll'
  })

  overwriteConfirmVisible.value = false
  overwriteConfirmData.value = null
}

/**
 * 监听路由参数 folderKey
 * 用于从其他页面（如 AIGC Studio）跳转过来时自动导航到指定文件夹
 */
watch(
  () => route.query.folderKey,
  async (folderKey) => {
    if (folderKey && typeof folderKey === 'string') {
      console.log('[AssetManagement] 收到路由参数 folderKey:', folderKey)
      // 确保切换到资产视图
      assetViewStore.ensureAssets()
      // 导航到指定文件夹
      const success = await navigateToFolder(folderKey)
      if (success) {
        await loadCurrentFolderAssets()
        navStore.push(currentPath.value || '/', selectedKeys.value[0] || null)
      } else {
        console.warn('[AssetManagement] 导航到文件夹失败:', folderKey)
      }
    }
  }
)

/**
 * 监听保管库切换（包括切换和删除后自动切换的情况）
 * 切换保管库后自动重置树状态并选择 ALL 文件夹
 */
let lastVaultId: string | null = null

watch(
  () => vaultStore.currentVault?.id ?? null,
  (vaultId) => navStore.setVaultId(vaultId),
  { immediate: true, flush: 'sync' }
)

watch(
  () => vaultStore.currentVault?.id,
  async (newVaultId, oldVaultId) => {
    // 初次加载时不触发（由 onMounted 处理）
    if (!oldVaultId && !lastVaultId) {
      lastVaultId = newVaultId || null
      return
    }

    // 如果 vaultId 没有变化，不执行
    if (newVaultId === lastVaultId) {
      return
    }

    console.log('[AssetManagement] 保管库已切换:', oldVaultId, '->', newVaultId)
    lastVaultId = newVaultId || null

    // 标记正在切换保管库，避免触发筛选逻辑
    isSwitchingVault.value = true

    try {
      if (oldVaultId) {
        message.destroy(getNetworkSyncMessageKey(oldVaultId))
      }

      // 立即清除当前文件列表，避免详情面板闪动显示旧数据
      currentFiles.value = []

      // 🔧 切换保管库时重置筛选条件和搜索关键词
      filterForm.fileCategory = undefined
      filterForm.assetTypes = []
      filterForm.sizeRange = undefined
      filterForm.dateRange = undefined
      filterForm.tags = []
      filterForm.includeTags = []
      filterForm.excludeTags = []
      filterForm.tagMatchMode = 'any'
      filterForm.hasNoTags = false
      filterForm.favoriteStatus = 'all'
      filterForm.keyword = ''
      isSearching.value = false
      filterPanelExpanded.value = false

      // 重置树状态并加载新保管库的根文件夹
      await resetTreeState()

      // 等待树数据加载完成后，自动选择 ALL 文件夹
      await nextTick()

      // 查找 ALL 文件夹并选中
      const allFolder = treeData.value.find((node) => node.title === 'ALL')
      if (allFolder) {
        selectedKeys.value = [allFolder.key]
        currentPath.value = allFolder.path
        navStore.push(allFolder.path, allFolder.key)
        // 清除快捷区域选中状态
        selectionStore.setTreeKey(allFolder.key)
        // 加载 ALL 文件夹的资产
        await loadCurrentFolderAssets()
        console.log('[AssetManagement] 已自动选择 ALL 文件夹:', allFolder.key)
      } else {
        // 如果没有 ALL 文件夹，清空选中状态
        selectedKeys.value = []
        currentPath.value = '/'
        console.warn('[AssetManagement] 未找到 ALL 文件夹')
      }

      // 🔧 检测网络库的写入权限
      await checkNetworkVaultWritePermission()
    } finally {
      // 延迟重置标志位，确保所有副作用都已处理
      setTimeout(() => {
        isSwitchingVault.value = false
      }, 300)
    }
  },
  { immediate: false }
)

// 判断是否正在显示删除资产
const isShowingDeleted = computed(() => {
  return (
    selectionStore.selectedShortcut === 'recent' || selectionStore.selectedShortcut === 'deleted'
  )
})

const isShowingFavorites = computed(() => selectionStore.selectedShortcut === 'favorites')

/** 收藏 / 回收站这类不属于任何文件夹的视图 */
const isShowingShortcutView = computed(() => isShowingDeleted.value || isShowingFavorites.value)

/**
 * 眼前这个列表接不接受筛选 / 排序 / 关键字。
 *
 * 只有一种情况不接受：**网络保管库的回收站**。它的内容来自远端那个
 * getDeletedAssets 接口，那边不收任何查询条件，本地库里也没有这些行可查。
 * 这时候把筛选栏、排序、搜索框整个藏掉 —— 摆着一排点了不动的控件，
 * 比没有更糟：用户会以为是自己的库出了问题。
 */
const canQueryCurrentList = computed(() => !(isShowingDeleted.value && isHttpNetworkVault.value))

// 任务本身存在应用级 store 里 —— 资产库页面失活时 DOM 会被卸载，
// 进度挂件跟着一起消失，而三十个 G 的导入还在后台跑（见 store 里的说明）
const importTasksStore = useImportTasksStore()
const importTasksMap = computed(() => importTasksStore.tasks)

// 导出数组供模板使用
const importTasks = computed(() => importTasksStore.allTasks)

/**
 * 添加导入任务
 *
 * 文件夹名在这里就算好存进任务里：挂件挂在全局，那边拿不到资产库的文件夹树。
 */
const addImportTask = (task: ImportTask): void => {
  const key = task.folderKey
  let folderName = task.folderName
  if (!folderName) {
    if (!key || key === 'ALL') {
      folderName = t('assetManagement.folder.allAssets')
    } else {
      const node = findNodeByKey(key)
      folderName = node ? node.title : key
    }
  }

  // 🚀 自动附加当前保管库 ID，实现进度隔离
  importTasksStore.addTask({
    ...task,
    folderName,
    vaultId: task.vaultId || vaultStore.currentVault?.id
  })
}

/**
 * 更新导入任务（直接 Map.get，O(1) 复杂度）
 */
const updateImportTask = (id: string, updates: Partial<ImportTask>): void => {
  importTasksStore.updateTask(id, updates)
}

/**
 * 完成导入任务
 */
const completeImportTask = (id: string): void => {
  pendingProgressMap.delete(id)
  scanBatchBuffers.delete(id)
  if (importTasksStore.tasks.get(id)?.status !== 'error') importTasksStore.removeTask(id)
}

const cancelledVaultImports = new Set<string>()
const handleVaultImportCancel = (event: Event): void => {
  const id = (event as CustomEvent<{ id: string }>).detail?.id
  if (!id) return
  cancelledVaultImports.add(id)
  updateImportTask(id, { stageText: t('assetLib.import.stopping') })
  void assetDataAPI.cancelImport(id).catch((error) => message.error(String(error)))
}
const handleVaultImportInspect = (event: Event): void => {
  const view = importTasksStore.tasks.get(
    (event as CustomEvent<{ id: string }>).detail?.id
  )?.vaultResult
  if (view) showImportResult(view)
}
const retainVaultImportResult = (taskId: string, view: ImportResultView): void => {
  pendingProgressMap.delete(taskId)
  if (view.open)
    updateImportTask(taskId, {
      progress: 100,
      status: 'error',
      vaultResult: view,
      stageText: t(
        view.isCancelled ? 'assetManagement.import.cancelled' : 'assetLib.import.importIncomplete'
      )
    })
  else completeImportTask(taskId)
  showImportResult(view)
}

const createImportTaskId = (sourcePath: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `import:${crypto.randomUUID()}`
  }
  return `import:${Date.now()}:${Math.random().toString(36).slice(2)}:${sourcePath}`
}

// 4.2 优化：进度批处理逻辑
const pendingProgressMap = new Map<string, { percent: number; total?: number; done?: number }>()
let progressFlushScheduled = false

/**
 * 刷新待处理的进度更新到响应式状态
 * 使用 requestAnimationFrame 合并同一帧内的多次更新
 */
const flushPendingProgress = (): void => {
  progressFlushScheduled = false
  if (pendingProgressMap.size === 0) return

  for (const [taskId, data] of pendingProgressMap) {
    const task = importTasksMap.value.get(taskId)
    if (task && task.status !== 'error' && task.status !== 'completed') {
      // 1% 阈值过滤：变化小于 1% 不更新（除非接近完成），或者有 total/done 数据更新
      if (
        Math.abs(data.percent - task.progress) >= 1 ||
        data.percent >= 99 ||
        data.total !== undefined ||
        data.done !== undefined
      ) {
        task.progress = data.percent
        if (data.total !== undefined) task.total = data.total
        if (data.done !== undefined) task.done = data.done
      }
    }
  }
  pendingProgressMap.clear()
  progressFlushScheduled = false
}

/**
 * 🚀 流式扫描批次缓冲区：存储来自主进程的分批扫描数据
 * key: taskId (通常是 folderPath)，value: 累积的文件项数组
 */
const scanBatchBuffers = new Map<string, unknown[]>()
const suppressFolderImportErrorTasks = new Set<string>()
const activeRecoveryPromptTasks = new Set<string>()
const pendingImportRecoveryChecked = ref(false)
const pendingImportRecoveryNotice = ref<ImportRecoverySummary | null>(null)
const importRecoveryLoading = ref(false)

/**
 * 批量进度更新：收集进度变化，延迟合并更新
 */
const batchUpdateProgress = (
  taskId: string,
  data: { percent: number; total?: number; done?: number }
): void => {
  const task = importTasksMap.value.get(taskId)
  if (!task || task.status === 'error' || task.status === 'completed') return
  pendingProgressMap.set(taskId, data)

  if (!progressFlushScheduled) {
    progressFlushScheduled = true
    requestAnimationFrame(flushPendingProgress)
  }
}

const removeIpcListener = (channel: string, listener: (...args: any[]) => void): void => {
  try {
    const ipcRenderer = window.electron.ipcRenderer as any
    if (typeof ipcRenderer.off === 'function') {
      ipcRenderer.off(channel, listener)
      return
    }
    if (typeof ipcRenderer.removeListener === 'function') {
      ipcRenderer.removeListener(channel, listener)
      return
    }
    if (typeof ipcRenderer.removeAllListeners === 'function') {
      ipcRenderer.removeAllListeners(channel)
    }
  } catch (err) {
    console.warn(`[AssetManagement] remove listener failed: ${channel}`, err)
  }
}

const refreshCurrentImportView = async (
  targetFolderKey = selectedKeys.value[0] || 'ALL'
): Promise<void> => {
  await refreshNodeChildren(targetFolderKey)
  await loadCurrentFolderAssets()
}

const handleFolderImportProgress = (
  _event: any,
  payload: { taskId: string; percent: number; total?: number; done?: number }
) => {
  batchUpdateProgress(payload.taskId, {
    percent: payload.percent,
    total: payload.total,
    done: payload.done
  })
}

const handleFolderImportStage = (
  _event: any,
  payload: {
    taskId: string
    stage: string
    mode?: string
    sessionId?: string
    stageProgress?: number
    stageTotal?: number
    rootFolderKey?: string
  }
) => {
  const stageLabels: Record<string, string> = {
    preflight: t('assetManagement.import.stages.preflight'),
    create_session: t('assetManagement.import.stages.createSession'),
    upload_metadata: t('assetManagement.import.stages.uploadMetadata'),
    upload_files: t('assetManagement.import.stages.uploadFiles'),
    upload_thumbnails: t('assetManagement.import.stages.uploadThumbnails'),
    commit: t('assetManagement.import.stages.commit'),
    poll_status: t('assetManagement.import.stages.pollStatus'),
    fallback_to_v1: t('assetManagement.import.stages.fallbackToV1'),
    v1_batch_push: t('assetManagement.import.stages.v1BatchPush'),
    v1_upload_files: t('assetManagement.import.stages.uploadFiles'),
    v1_upload_thumbnails: t('assetManagement.import.stages.uploadThumbnails'),
    writing: t('assetManagement.import.stages.writing'),
    uploading: t('assetManagement.import.stages.uploading'),
    detecting: t('assetManagement.import.stages.detecting'),
    scan: t('assetManagement.import.stages.scanProject'),
    pack_upload: t('assetManagement.import.stages.packUpload'),
    download: t('assetManagement.import.stages.downloadArchive'),
    extract: t('assetManagement.import.stages.extractArchive')
  }
  const label = stageLabels[payload.stage] || payload.stage

  let detail = ''
  if (
    payload.stageProgress !== undefined &&
    payload.stageTotal !== undefined &&
    payload.stageTotal > 1
  ) {
    detail = ` (${payload.stageProgress}/${payload.stageTotal})`
  }

  const updates: Partial<ImportTask> = {
    stage: payload.stage,
    stageText: `${label}${detail}`,
    importMode: (payload.mode as ImportTask['importMode']) || undefined,
    sessionId: payload.sessionId || undefined,
    stageProgress: payload.stageProgress,
    stageTotal: payload.stageTotal
  }
  if (payload.rootFolderKey) {
    updates.rootFolderKey = payload.rootFolderKey
  }
  updateImportTask(payload.taskId, updates)
}

const handleFolderImportCompleted = async (
  _event: any,
  payload: {
    taskId: string
    total: number
    done: number
    failedCount?: number
    failedFiles?: any[]
    issueCount?: number
    errorReportPath?: string
    remoteSyncStatus?: 'committed' | 'failed' | 'partial' | 'skipped'
    remoteSyncError?: string
    remoteSyncFailureDetails?: {
      failedCount: number
      firstFailedIndex: number
      requestId: string
      failedItems: any[]
    }
    mode?: 'v2-session' | 'v1-batch'
    sessionId?: string
  }
) => {
  void refreshCurrentImportView().catch((err) => {
    console.error('[AssetManagement] refresh after folder import completed failed:', err)
  })

  const modeLabel =
    payload.mode === 'v2-session'
      ? t('assetManagement.import.modeV2')
      : payload.mode === 'v1-batch'
        ? t('assetManagement.import.modeV1')
        : ''
  const sessionTag = payload.sessionId ? ` [${payload.sessionId.substring(0, 8)}]` : ''
  if (payload.remoteSyncStatus === 'failed') {
    const detail = payload.remoteSyncFailureDetails
    const summary = detail
      ? t('assetManagement.import.remoteSyncFailedDetail', {
          count: detail.failedCount,
          requestId: detail.requestId
        })
      : payload.remoteSyncError || t('assetManagement.import.unknownError')
    message.error(
      t('assetManagement.import.remoteSyncFailed', {
        mode: modeLabel ? t('assetManagement.import.modeSuffix', { mode: modeLabel }) : '',
        summary
      }),
      8
    )
  } else if (payload.remoteSyncStatus === 'partial') {
    message.warning(
      t('assetManagement.import.remoteSyncPartial', {
        mode: modeLabel ? t('assetManagement.import.modeSuffix', { mode: modeLabel }) : ''
      }),
      6
    )
  } else if (payload.remoteSyncStatus === 'committed' && payload.mode) {
    if (payload.mode === 'v1-batch') {
      message.info(t('assetManagement.import.doneFallbackV1'), 4)
    } else {
      message.success(
        t('assetManagement.import.doneWithMode', { mode: modeLabel, session: sessionTag }),
        4
      )
    }
  }

  if (payload.errorReportPath) {
    message.warning(t('assetManagement.import.issueDetailGenerated'), 6)
  }

  // successCount 只能来自主进程的 outcome.succeeded。
  // 旧写法是 done - failedCount，而 done 把「复制失败被跳过」的文件也数了进去、
  // failedCount 又只统计预处理失败 —— 于是丢了文件也显示「全部成功」，
  // 而且因为 failedCount === 0 连结果弹窗都不弹。
  const view = buildImportResultView(payload as FolderImportCompletedPayload)
  if (view.failedCount > 0) {
    message.error(t('assetLib.import.copyFailedSummary', { count: view.failedCount }), 8)
  } else if (view.skippedCount > 0) {
    message.warning(t('assetLib.import.skippedSummary', { count: view.skippedCount }), 6)
  }

  retainVaultImportResult(payload.taskId, view)
}

type ImportRecoveryPayload = {
  taskId: string
  diagnosticId?: string
  sessionId?: string
  errorCode?: string
  remoteSyncStatus?: 'failed' | 'partial'
  remoteSyncError?: string
  remoteSyncFailureDetails?: Record<string, unknown>
  expectedFiles?: number
  uploadedFiles?: number
  expectedThumbnails?: number
  uploadedThumbnails?: number
  canResume?: boolean
  errorReportPath?: string
  rootFolderPath?: string
  lastError?: string | null
}

type ImportRecoverySummary = {
  taskId: string
  diagnosticId?: string | null
  sessionId: string
  status: string
  lastError?: string | null
  rootFolderPath?: string
  expectedFiles?: number
  expectedThumbnails?: number
  canResume?: boolean
}

type ImportRecoveryReportRef = {
  taskId?: string
  diagnosticId?: string
  vaultId?: string
  localVaultId?: string
  serverUrl?: string
  remoteVaultId?: string
  sessionId?: string
  rootFolderPath?: string
  targetFolderKey?: string | null
  files?: Array<{ path: string; name?: string; remotePath: string }>
  remoteSyncError?: string
}

const formatRecoveryCount = (done?: number, expected?: number): string => {
  if (expected === undefined && done === undefined) return '-'
  return `${done ?? '-'}/${expected ?? '-'}`
}

const formatResumeResultMessage = (result: {
  committed?: boolean
  uploadedFiles?: number
  uploadedThumbnails?: number
}): string => {
  const uploadedFiles = result.uploadedFiles || 0
  const uploadedThumbnails = result.uploadedThumbnails || 0
  if (result.committed && uploadedFiles === 0 && uploadedThumbnails === 0) {
    return t('assetManagement.import.continueSummaryDone')
  }
  return t('assetManagement.import.continueSummary', {
    files: uploadedFiles,
    thumbnails: uploadedThumbnails
  })
}

const toOptionalNumber = (value: unknown): number | undefined => {
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

const toRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const copyDiagnosticId = async (diagnosticId?: string): Promise<void> => {
  if (!diagnosticId) {
    message.warning(t('assetManagement.import.diagnosticGenerating'))
    return
  }
  try {
    await navigator.clipboard.writeText(diagnosticId)
    message.success(t('assetManagement.import.diagnosticCopied'))
  } catch {
    message.error(t('assetManagement.import.diagnosticCopyFailed'))
  }
}

const dismissImportRecovery = async (
  taskId?: string,
  diagnosticId?: string | null
): Promise<void> => {
  if (!taskId && !diagnosticId) return
  try {
    await window.electron.ipcRenderer.invoke('diagnostics:dismiss-import-recovery', {
      taskId,
      diagnosticId: diagnosticId || undefined
    })
  } catch (err) {
    console.warn('[AssetManagement] dismiss import recovery failed:', err)
  }
}

/**
 * 放弃一次卡住的导入：让服务器取消会话并清掉暂存区。
 *
 * 服务器那步没清掉就如实说没清掉 —— 本地提示可以消掉，但不能让用户以为 NAS 上
 * 那几十 G 也跟着没了。返回 true 表示可以把弹窗关掉。
 */
const abandonImportSession = async (payload: ImportRecoveryPayload): Promise<boolean> => {
  const confirmed = await new Promise<boolean>((resolve) => {
    confirmDialog({
      title: t('assetManagement.import.abandonConfirmTitle'),
      content: t('assetManagement.import.abandonConfirmContent'),
      okText: t('assetManagement.import.abandon'),
      cancelText: t('assetManagement.recent.cancelText'),
      danger: true,
      onOk: () => resolve(true),
      onCancel: () => resolve(false)
    })
  })
  if (!confirmed) return false

  try {
    const result = (await window.electron.ipcRenderer.invoke('diagnostics:abandon-import', {
      taskId: payload.taskId,
      diagnosticId: payload.diagnosticId
    })) as {
      success: boolean
      stagingCleared?: boolean
      locallyDismissed?: boolean
    } & ImportErrorDetails

    if (!result?.success) {
      message.error(
        t('assetManagement.import.abandonFailed', {
          error: describeImportError(result, t, t('assetManagement.import.unknownError'))
        }),
        8
      )
      return false
    }

    if (result.stagingCleared) {
      message.success(t('assetManagement.import.abandonDone'), 6)
    } else {
      message.warning(
        t('assetManagement.import.abandonStagingLeft', {
          error: describeImportError(result, t, t('assetManagement.import.unknownError'))
        }),
        10
      )
    }
    // 本地那条记录没标掉的话，下次开机还会再问一遍 —— 先说清楚，别让人以为已经完了
    if (result.locallyDismissed === false) {
      message.warning(t('assetManagement.import.abandonLocalRecordLeft'), 10)
    }
    return true
  } catch (err) {
    console.error('[AssetManagement] abandon import failed:', err)
    message.error(
      t('assetManagement.import.abandonFailed', {
        error: err instanceof Error ? err.message : String(err)
      }),
      8
    )
    return false
  }
}

const getStringField = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const extractImportRecoveryReportRef = (report: unknown): ImportRecoveryReportRef | null => {
  const data = toRecord(report)
  const diagnosticPackage = toRecord(data.diagnosticPackage)
  const firstIssue = Array.isArray(data.issues) ? toRecord(data.issues[0]) : {}
  const files: Array<{ path: string; name?: string; remotePath: string }> = []
  for (const issue of Array.isArray(data.issues) ? data.issues : []) {
    const item = toRecord(issue)
    if (item.stage !== 'remote_file_upload') continue
    const path = getStringField(item.path)
    const remotePath = getStringField(item.remotePath)
    if (!path || !remotePath) continue
    files.push({
      path,
      name: getStringField(item.fileName),
      remotePath
    })
  }
  const ref: ImportRecoveryReportRef = {
    taskId: getStringField(data.taskId),
    diagnosticId:
      getStringField(diagnosticPackage.diagnosticId) || getStringField(data.diagnosticId),
    vaultId: getStringField(data.vaultId),
    localVaultId: getStringField(data.localVaultId),
    serverUrl: getStringField(data.serverUrl),
    remoteVaultId: getStringField(data.remoteVaultId),
    sessionId: getStringField(data.sessionId) || getStringField(firstIssue.sessionId),
    rootFolderPath: getStringField(data.rootFolderPath),
    targetFolderKey: getStringField(data.targetFolderKey) || null,
    files,
    remoteSyncError: getStringField(toRecord(data.summary).remoteSyncError)
  }
  return ref.taskId || ref.diagnosticId || ref.sessionId ? ref : null
}

const readImportRecoveryReportRef = async (
  reportPath: string
): Promise<ImportRecoveryReportRef> => {
  const result = await window.api.fs.readFile(reportPath, {
    encoding: 'utf-8',
    maxLines: 0,
    maxBytes: 10 * 1024 * 1024
  })
  if (!result?.success || typeof result.content !== 'string') {
    throw new Error(result?.error || '读取 JSON 文件失败')
  }
  if (result.truncated) {
    throw new Error('JSON 文件过大或被截断，无法作为续传报告读取')
  }

  let report: unknown
  try {
    report = JSON.parse(result.content)
  } catch {
    throw new Error('该文件不是有效的 JSON 报告')
  }

  const ref = extractImportRecoveryReportRef(report)
  if (!ref) {
    throw new Error('该 JSON 中未找到可用于续传的 taskId 或 diagnosticId')
  }
  return ref
}

const resumeImportByReportRef = async (ref: ImportRecoveryReportRef): Promise<void> => {
  importRecoveryLoading.value = true
  const messageKey = `import-recovery-${ref.taskId || ref.diagnosticId || ref.sessionId || Date.now()}`
  message.loading({
    content: t('assetManagement.import.checkingUnfinished'),
    key: messageKey,
    duration: 0
  })
  try {
    const result = (await window.electron.ipcRenderer.invoke('diagnostics:resume-import', {
      taskId: ref.taskId,
      diagnosticId: ref.diagnosticId,
      report: ref
    })) as {
      success: boolean
      uploadedFiles?: number
      uploadedThumbnails?: number
      committed?: boolean
    } & ImportErrorDetails

    if (!result?.success) {
      const error = describeImportError(result, t, t('assetManagement.import.unknownError'))
      message.destroy(messageKey)
      if (/未找到可续传|没有找到这份 JSON 对应/.test(result?.error ?? '')) {
        warningDialog({
          title: t('assetManagement.import.resumeNotFoundTitle'),
          content: t('assetManagement.import.resumeNotFoundContent', { error })
        })
      } else {
        message.error(t('assetManagement.import.resumeFailed', { error }), 8)
      }
      return
    }

    message.success({
      content: formatResumeResultMessage(result),
      key: messageKey,
      duration: 6
    })
    await refreshCurrentImportView()
  } finally {
    importRecoveryLoading.value = false
  }
}

const handleImportRecoveryReportPath = async (
  reportPath: string,
  options: { strict: boolean }
): Promise<boolean> => {
  if (!/\.json$/i.test(reportPath)) {
    if (options.strict) message.warning(t('assetManagement.import.selectErrorJson'))
    return false
  }

  try {
    const ref = await readImportRecoveryReportRef(reportPath)
    await resumeImportByReportRef(ref)
    return true
  } catch (error) {
    if (options.strict) {
      message.error(error instanceof Error ? error.message : String(error), 8)
      return true
    }
    return false
  }
}

const handleImportRecoveryReportPaths = async (
  filePaths: string[],
  options: { strict: boolean }
): Promise<boolean> => {
  if (filePaths.length !== 1) {
    if (options.strict) message.warning(t('assetManagement.import.singleErrorJson'))
    return false
  }
  return handleImportRecoveryReportPath(filePaths[0], options)
}

const handleFolderImportNeedsRecovery = (_event: unknown, payload: ImportRecoveryPayload): void => {
  if (!payload?.taskId || activeRecoveryPromptTasks.has(payload.taskId)) return
  activeRecoveryPromptTasks.add(payload.taskId)

  const diagnosticId = payload.diagnosticId || t('assetManagement.import.diagnosticGeneratingShort')
  const sessionId = payload.sessionId || '-'
  const errorCode = payload.errorCode || 'REMOTE_IMPORT_FAILED'
  const details = toRecord(payload.remoteSyncFailureDetails)
  const reconcile = toRecord(details.reconcile)
  const expectedFiles = payload.expectedFiles ?? toOptionalNumber(details.expectedFiles)
  const uploadedFiles =
    payload.uploadedFiles ??
    toOptionalNumber(details.uploadedFiles) ??
    toOptionalNumber(details.committedFiles)
  const expectedThumbnails =
    payload.expectedThumbnails ?? toOptionalNumber(details.expectedThumbnails)
  const uploadedThumbnails =
    payload.uploadedThumbnails ??
    toOptionalNumber(details.uploadedThumbnails) ??
    toOptionalNumber(details.committedThumbnails)
  const missingFiles =
    toOptionalNumber(reconcile.missingFiles) ??
    (expectedFiles !== undefined && uploadedFiles !== undefined
      ? Math.max(0, expectedFiles - uploadedFiles)
      : undefined)
  const missingThumbnails =
    toOptionalNumber(reconcile.missingThumbnails) ??
    (expectedThumbnails !== undefined && uploadedThumbnails !== undefined
      ? Math.max(0, expectedThumbnails - uploadedThumbnails)
      : undefined)
  const filesText = formatRecoveryCount(uploadedFiles, expectedFiles)
  const thumbnailsText = formatRecoveryCount(uploadedThumbnails, expectedThumbnails)
  const recoverableText = payload.canResume
    ? t('assetManagement.import.canResume')
    : t('assetManagement.import.cannotResume')
  const errorText = payload.remoteSyncError || t('assetManagement.import.remoteSyncErrorDefault')
  const rootFolderText = payload.rootFolderPath || ''
  const recoveryActions = [
    h(
      AppButton,
      {
        size: 'small',
        onClick: () => void copyDiagnosticId(payload.diagnosticId)
      },
      { default: () => t('assetManagement.import.copyDiagnosticId') }
    )
  ]

  if (payload.errorReportPath) {
    recoveryActions.push(
      h(
        AppButton,
        {
          size: 'small',
          onClick: () => void revealImportIssueReport(payload.errorReportPath)
        },
        { default: () => t('assetManagement.import.openErrorReport') }
      )
    )
  }

  // 「放弃这次导入」：这一单的暂存文件在服务器上占着一整个目录，一次大导入就是几十 G。
  // 没有这个入口的时候，用户只能在「永远失败的继续完成」和「什么也不清的稍后处理」
  // 之间二选一，那坨文件就永远留在别人的 NAS 上了。
  //
  // 只在 canResume 时给：后端要靠那份本地恢复上下文才找得到服务端会话，而 canResume
  // 报的就是「那份上下文在不在」。没有它就点不动，别摆一个按下去必然报错的危险按钮。
  if (payload.canResume) {
    recoveryActions.push(
      h(
        AppButton,
        {
          size: 'small',
          danger: true,
          onClick: () => {
            void abandonImportSession(payload).then((abandoned) => {
              if (abandoned) recoveryDialog.destroy()
            })
          }
        },
        { default: () => t('assetManagement.import.abandon') }
      )
    )
  }

  const recoveryDialog = confirmDialog({
    title: t('assetManagement.import.incompleteTitle'),
    okText: payload.canResume
      ? t('assetManagement.import.continue')
      : t('assetManagement.import.gotIt'),
    cancelText: t('assetManagement.import.later'),
    danger: !payload.canResume,
    width: 620,
    content: h('div', { class: 'import-recovery-content' }, [
      h('p', t('assetManagement.import.incompleteContent')),
      h('div', { class: 'import-recovery-grid' }, [
        ...(rootFolderText
          ? [h('span', t('assetManagement.import.sourceDirLabel')), h('code', rootFolderText)]
          : []),
        h('span', t('assetManagement.import.canResumeLabel')),
        h('strong', recoverableText),
        h('span', t('assetManagement.import.uploadedFilesLabel')),
        h('strong', filesText),
        h('span', t('assetManagement.import.missingFilesLabel')),
        h(
          'strong',
          missingFiles === undefined
            ? '-'
            : t('assetManagement.import.missingFilesCount', { count: missingFiles })
        ),
        h('span', t('assetManagement.import.diagnosticIdLabel')),
        h('code', diagnosticId)
      ]),
      h(
        'p',
        { class: 'import-recovery-note' },
        t('assetManagement.import.thumbnailUploadText', {
          thumbnails: thumbnailsText,
          missing:
            missingThumbnails === undefined
              ? '-'
              : t('assetManagement.import.missingFilesCount', { count: missingThumbnails })
        })
      ),
      h('div', { class: 'import-recovery-actions' }, recoveryActions),
      h('details', { class: 'import-recovery-details' }, [
        h('summary', t('assetManagement.import.supportInfoSummary')),
        h('div', { class: 'import-recovery-grid' }, [
          h('span', 'Session'),
          h('code', sessionId),
          h('span', t('assetManagement.import.errorCodeLabel')),
          h('code', errorCode),
          h('span', t('assetManagement.import.errorMessageLabel')),
          h('code', errorText)
        ])
      ])
    ]),
    async onOk() {
      if (!payload.canResume) return
      const result = (await window.electron.ipcRenderer.invoke('diagnostics:resume-import', {
        taskId: payload.taskId,
        diagnosticId: payload.diagnosticId
      })) as {
        success: boolean
        status?: string
        uploadedFiles?: number
        uploadedThumbnails?: number
        committed?: boolean
      } & ImportErrorDetails
      if (!result?.success) {
        const error =
          result?.status === 'expired'
            ? t('assetManagement.import.importGone')
            : describeImportError(result, t, t('assetManagement.import.unknownError'))
        message.error(t('assetManagement.import.continueFailed', { error }), 8)
        throw new Error(result?.error || 'resume import failed')
      }
      message.success(formatResumeResultMessage(result), 6)
      void refreshCurrentImportView().catch((err) => {
        console.error('[AssetManagement] refresh after import recovery failed:', err)
      })
    },
    onCancel() {
      void dismissImportRecovery(payload.taskId, payload.diagnosticId)
    },
    afterClose() {
      activeRecoveryPromptTasks.delete(payload.taskId)
    }
  })
}

const checkPendingImportRecoveries = async (): Promise<void> => {
  if (pendingImportRecoveryChecked.value) return
  pendingImportRecoveryChecked.value = true

  try {
    const recoveries = (await window.electron.ipcRenderer.invoke(
      'diagnostics:list-import-recovery',
      {
        limit: 5
      }
    )) as ImportRecoverySummary[]
    const candidates = (Array.isArray(recoveries) ? recoveries : []).filter(
      (item) => item?.taskId && item.canResume
    )
    if (candidates.length === 0) return

    const latest = candidates[0]
    if (candidates.length > 1) {
      message.info(t('assetManagement.import.foundUnfinished', { count: candidates.length }), 6)
    }
    pendingImportRecoveryNotice.value = latest
  } catch (err) {
    console.warn('[AssetManagement] check pending import recoveries failed:', err)
  }
}

const handleResumePendingImportRecovery = (): void => {
  const latest = pendingImportRecoveryNotice.value
  if (!latest) return
  pendingImportRecoveryNotice.value = null
  handleFolderImportNeedsRecovery(null, {
    taskId: latest.taskId,
    diagnosticId: latest.diagnosticId || undefined,
    sessionId: latest.sessionId,
    remoteSyncStatus: 'failed',
    remoteSyncError: latest.lastError || t('assetManagement.import.pendingNoticeDefault'),
    canResume: true,
    rootFolderPath: latest.rootFolderPath,
    expectedFiles: latest.expectedFiles,
    expectedThumbnails: latest.expectedThumbnails
  })
}

const handleDismissPendingImportRecoveryNotice = (): void => {
  const latest = pendingImportRecoveryNotice.value
  pendingImportRecoveryNotice.value = null
  if (!latest) return
  void dismissImportRecovery(latest.taskId, latest.diagnosticId)
}

const handleImportErrorOccurred = (_event: any, payload: any) => {
  currentImportError.value = payload
  importErrorModalVisible.value = true
}

const handleFolderImportCancelled = (
  _event: any,
  payload: { taskId: string; failedCount: number; failedFiles: any[] }
) => {
  completeImportTask(payload.taskId)
  if (payload.failedCount > 0) {
    showImportResult(
      buildImportResultView({
        taskId: payload.taskId,
        total: 0,
        done: 0,
        failedCount: payload.failedCount || 0,
        failedFiles: payload.failedFiles || [],
        isCancelled: true
      })
    )
  } else {
    message.info(t('assetManagement.import.cancelled'))
  }
}

const handleFolderImportError = (
  _event: unknown,
  payload: {
    taskId: string
    message: string
    errorReportPath?: string
    rootFolderPath?: string
    vaultId?: string
    targetFolderKey?: string
  } & ImportErrorDetails
) => {
  if (suppressFolderImportErrorTasks.has(payload.taskId)) {
    console.warn('[DragImport] Folder import error captured for managed retry:', payload)
    return
  }
  // 普通文件夹导入的 payload 没有 errorKey，describeImportError 原样走回 message
  const errorText = describeImportError(
    { error: payload.message, errorKey: payload.errorKey, errorParams: payload.errorParams },
    t,
    t('assetManagement.import.unknownError')
  )
  message.error(t('assetLib.import.failed', { message: errorText }))
  const view = buildImportResultView({
    ...payload,
    total: 0,
    done: 0,
    failures: [
      {
        stage: 'scan',
        fileName: payload.rootFolderPath || payload.taskId,
        path: payload.rootFolderPath || '',
        error: errorText,
        retriable: Boolean(payload.rootFolderPath)
      }
    ]
  })
  retainVaultImportResult(payload.taskId, view)
}

const handleBaiduDownloadProgress = (
  _event: unknown,
  payload: { downloadId: string; loaded: number; total?: number; percent: number }
) => {
  batchUpdateProgress(payload.downloadId, {
    percent: payload.percent,
    total: payload.total,
    done: payload.loaded
  })
}

const handleFsScanProgress = (
  _event: unknown,
  payload: { taskId: string; scannedCount: number; stage: string }
) => {
  updateImportTask(payload.taskId, {
    stageText: t('assetManagement.import.scanningStage', { count: payload.scannedCount })
  })
}

const handleFsScanBatch = (
  _event: unknown,
  payload: { taskId: string; batchIndex: number; items: unknown[]; isComplete: boolean }
) => {
  void _event
  void payload
}

const handleAssetTreeRefresh = async (
  _event: unknown,
  payload: { parentKey: string; createdCount: number }
) => {
  console.log('[AssetManagement] Agent 创建了文件夹，刷新树:', payload)
  if (!payload.parentKey || payload.parentKey === 'ALL') {
    await loadRootFolders()
  } else {
    await refreshNodeChildren(payload.parentKey)
    if (!expandedKeys.value.includes(payload.parentKey)) {
      expandedKeys.value.push(payload.parentKey)
    }
  }
  await loadCurrentFolderAssets()
  message.success(t('assetManagement.import.unrealImportDone', { count: payload.createdCount }))
  // 已经就地刷新过了，清掉 MainLayout 同时记下的待刷新标记，
  // 否则下次切回本页会再刷一次树、再弹一次同样的提示
  assetViewStore.clearTreeRefresh()
}

const handleConfirmOverwrite = (
  _event: unknown,
  payload: { confirmId: string; fileName: string; targetPath: string; timeoutMs?: number }
) => {
  overwriteConfirmData.value = payload
  overwriteConfirmVisible.value = true
  // 超时会按「跳过」处理且该文件不会被导入 —— 这个后果必须让用户看见，
  // 而不是等他回过神来发现文件少了
  overwriteCountdown.value = Math.round((payload.timeoutMs ?? 120_000) / 1000)
  clearOverwriteCountdown()
  overwriteCountdownTimer = setInterval(() => {
    overwriteCountdown.value -= 1
    if (overwriteCountdown.value <= 0) clearOverwriteCountdown()
  }, 1000)
}

const handleOverwriteSettled = (payload: { confirmId: string }): void => {
  if (overwriteConfirmData.value?.confirmId !== payload.confirmId) return
  clearOverwriteCountdown()
  overwriteConfirmVisible.value = false
  overwriteConfirmData.value = null
}

const handleProjectImportStart = (event: Event): void => {
  const detail = (event as CustomEvent).detail
  if (!detail?.id) return
  addImportTask({
    id: detail.id,
    type: 'folder',
    name: detail.name,
    progress: 0,
    stageText: detail.stageText || t('assetManagement.import.stagePreparing'),
    status: 'running',
    taskType: 'project-import',
    projectName: detail.projectName,
    sourceFolderKeys: detail.sourceFolderKeys || [],
    cancellable: Boolean(detail.cancellable)
  })
}

const handleProjectImportProgress = (event: Event): void => {
  const detail = (event as CustomEvent).detail
  if (!detail?.id) return
  batchUpdateProgress(detail.id, { percent: detail.progress })
  updateImportTask(detail.id, {
    stageText: detail.stageText,
    status: detail.status
  })
}

const handleProjectImportComplete = (event: Event): void => {
  const detail = (event as CustomEvent).detail
  if (!detail?.id) return

  // 这里原来硬写 `status: 'completed'`，于是**失败的导入显示成绿色的「已完成」**，
  // 3 秒后自己消失 —— 用户唯一能看到的是一句一闪而过的 toast。
  // 失败的任务留在挂件上，带着「查看详情」，等用户自己关掉。
  const failed = detail.status === 'error'
  pendingProgressMap.delete(detail.id)
  updateImportTask(detail.id, {
    progress: 100,
    stageText: detail.stageText,
    status: failed ? 'error' : 'completed',
    report: detail.report,
    retry: detail.retry,
    retryCoversAll: detail.retryCoversAll
  })
  if (!failed) setTimeout(() => completeImportTask(detail.id), 3000)
}

onMounted(() => {
  try {
    window.electron.ipcRenderer.on('asset:folderImportProgress', handleFolderImportProgress)
    window.electron.ipcRenderer.on('asset:folderImportStage', handleFolderImportStage)
    window.electron.ipcRenderer.on('asset:folderImportCompleted', handleFolderImportCompleted)
    window.electron.ipcRenderer.on(
      'asset:folderImportNeedsRecovery',
      handleFolderImportNeedsRecovery
    )
    window.electron.ipcRenderer.on('asset:importErrorOccurred', handleImportErrorOccurred)
    window.electron.ipcRenderer.on('asset:folderImportCancelled', handleFolderImportCancelled)
    window.electron.ipcRenderer.on('asset:folderImportError', handleFolderImportError)
    window.electron.ipcRenderer.on('baiduyun:download-progress', handleBaiduDownloadProgress)
    window.electron.ipcRenderer.on('fs:scanProgress', handleFsScanProgress)
    window.electron.ipcRenderer.on('fs:scanBatch', handleFsScanBatch)
    window.electron.ipcRenderer.on('asset-tree:refresh', handleAssetTreeRefresh)
    window.electron.ipcRenderer.on('asset:confirmOverwrite', handleConfirmOverwrite)
    window.addEventListener('project-import:start', handleProjectImportStart)
    window.addEventListener('project-import:progress', handleProjectImportProgress)
    window.addEventListener('project-import:complete', handleProjectImportComplete)
    window.addEventListener('vault-import:cancel', handleVaultImportCancel)
    window.addEventListener('vault-import:inspect', handleVaultImportInspect)
    stopOverwriteSettled = window.api.fs.onOverwriteSettled(handleOverwriteSettled)
    stopImportErrorSettled = window.api.fs.onImportErrorSettled(({ taskId }) => {
      if (currentImportError.value?.taskId === taskId) {
        currentImportError.value = null
        importErrorModalVisible.value = false
      }
    })
    void checkPendingImportRecoveries()
  } catch (err) {
    console.error('注册文件夹导入进度监听失败:', err)
  }
})

/**
 * keep-alive 缓存组件被重新激活时触发
 * 检查是否有待处理的树刷新请求（由 Agent 在其他页面创建文件夹时设置）
 */
onActivated(async () => {
  if (assetViewStore.pendingTreeRefresh && assetViewStore.pendingRefreshPayload) {
    const payload = assetViewStore.pendingRefreshPayload
    console.log('[AssetManagement] onActivated: 检测到待刷新标记，执行刷新:', payload)

    // 🔧 修复：根据 parentKey 智能刷新对应层级的子节点
    // 如果是根级别（ALL 或空），刷新整个根文件夹列表
    // 否则只刷新特定父文件夹的子节点，避免丢失已加载的树结构
    if (!payload.parentKey || payload.parentKey === 'ALL') {
      await loadRootFolders()
    } else {
      // 刷新特定父文件夹的子节点
      await refreshNodeChildren(payload.parentKey)
      // 确保父文件夹已展开
      if (!expandedKeys.value.includes(payload.parentKey)) {
        expandedKeys.value.push(payload.parentKey)
      }
    }

    // 刷新当前文件夹的资产列表
    await loadCurrentFolderAssets()

    // 显示成功消息
    message.success(t('assetManagement.import.unrealImportDone', { count: payload.createdCount }))

    // 清除刷新标记
    assetViewStore.clearTreeRefresh()
  }
})

onUnmounted(() => {
  clearOverwriteCountdown()
  try {
    removeIpcListener('asset:folderImportProgress', handleFolderImportProgress)
    removeIpcListener('asset:folderImportStage', handleFolderImportStage)
    removeIpcListener('asset:folderImportCompleted', handleFolderImportCompleted)
    removeIpcListener('asset:folderImportNeedsRecovery', handleFolderImportNeedsRecovery)
    removeIpcListener('asset:folderImportError', handleFolderImportError)
    removeIpcListener('asset:importErrorOccurred', handleImportErrorOccurred)
    removeIpcListener('asset:folderImportCancelled', handleFolderImportCancelled)
    removeIpcListener('baiduyun:download-progress', handleBaiduDownloadProgress)
    removeIpcListener('fs:scanProgress', handleFsScanProgress)
    removeIpcListener('fs:scanBatch', handleFsScanBatch)
    removeIpcListener('asset-tree:refresh', handleAssetTreeRefresh)
    removeIpcListener('asset:confirmOverwrite', handleConfirmOverwrite)
    window.removeEventListener('project-import:start', handleProjectImportStart)
    window.removeEventListener('project-import:progress', handleProjectImportProgress)
    window.removeEventListener('project-import:complete', handleProjectImportComplete)
    window.removeEventListener('vault-import:cancel', handleVaultImportCancel)
    window.removeEventListener('vault-import:inspect', handleVaultImportInspect)
    stopImportErrorSettled?.()
    stopOverwriteSettled?.()
  } catch (err) {
    // ignore
  }
})

// 面板宽度控制：左侧目录树、右侧详情面板都可拖拽，各自持久化
interface PanelWidthRange {
  min: number
  max: number
  fallback: number
}
const TREE_PANEL_WIDTH_STORAGE_KEY = 'assetManagement.treePanelWidth'
const DETAILS_PANEL_WIDTH_STORAGE_KEY = 'assetManagement.detailsPanelWidth'
const TREE_PANEL_WIDTH_RANGE: PanelWidthRange = { min: 250, max: 800, fallback: 300 }
const DETAILS_PANEL_WIDTH_RANGE: PanelWidthRange = { min: 280, max: 640, fallback: 316 }

/**
 * 参数名别叫 `key`：localStorage 门禁会去本文件里找 `key = '...'` 的字面量定义，
 * 而模板里遍地都是 `:key="idx"` —— 它会把 `idx` 当成一个未登记的存储键报出来。
 */
const readStoredPanelWidth = (panelWidthStorageKey: string, range: PanelWidthRange): number => {
  try {
    const stored = localStorage.getItem(panelWidthStorageKey)
    if (stored === null) return range.fallback
    const parsed = Number.parseInt(stored, 10)
    return Number.isNaN(parsed) ? range.fallback : Math.max(range.min, Math.min(range.max, parsed))
  } catch (error) {
    console.error('读取面板宽度失败:', error)
    return range.fallback
  }
}

const persistPanelWidth = (panelWidthStorageKey: string, value: number): void => {
  try {
    localStorage.setItem(panelWidthStorageKey, String(value))
  } catch (error) {
    console.error('保存面板宽度失败:', error)
  }
}

const treePanelWidth = ref(
  readStoredPanelWidth(TREE_PANEL_WIDTH_STORAGE_KEY, TREE_PANEL_WIDTH_RANGE)
)
const detailsPanelWidth = ref(
  readStoredPanelWidth(DETAILS_PANEL_WIDTH_STORAGE_KEY, DETAILS_PANEL_WIDTH_RANGE)
)

watch(treePanelWidth, (value) => persistPanelWidth(TREE_PANEL_WIDTH_STORAGE_KEY, value), {
  immediate: true
})
watch(detailsPanelWidth, (value) => persistPanelWidth(DETAILS_PANEL_WIDTH_STORAGE_KEY, value), {
  immediate: true
})

// 拖拽调整宽度：左侧面板往右拖变宽（+1），右侧面板往右拖变窄（-1）
const isResizing = ref(false)
let activeResize: {
  width: Ref<number>
  range: PanelWidthRange
  direction: 1 | -1
  startX: number
  startWidth: number
} | null = null

const handleResizeMove = (e: MouseEvent): void => {
  if (!activeResize) return
  const delta = (e.clientX - activeResize.startX) * activeResize.direction
  const { min, max } = activeResize.range
  activeResize.width.value = Math.max(min, Math.min(max, activeResize.startWidth + delta))
}

const handleResizeEnd = (): void => {
  isResizing.value = false
  activeResize = null
  document.removeEventListener('mousemove', handleResizeMove)
  document.removeEventListener('mouseup', handleResizeEnd)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

const startPanelResize = (
  e: MouseEvent,
  width: Ref<number>,
  range: PanelWidthRange,
  direction: 1 | -1
): void => {
  e.preventDefault()
  e.stopPropagation()
  isResizing.value = true
  activeResize = { width, range, direction, startX: e.clientX, startWidth: width.value }
  document.addEventListener('mousemove', handleResizeMove)
  document.addEventListener('mouseup', handleResizeEnd)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleResizeStart = (e: MouseEvent): void =>
  startPanelResize(e, treePanelWidth, TREE_PANEL_WIDTH_RANGE, 1)

const handleDetailsResizeStart = (e: MouseEvent): void =>
  startPanelResize(e, detailsPanelWidth, DETAILS_PANEL_WIDTH_RANGE, -1)

// 取消收藏 Store 依赖，直接通过 API 获取收藏数据

// 缩略图路径由组件内部处理，移除未使用的本地构造函数

// 导航历史（由 Pinia Store 管理）
const canGoBack = computed(() => navStore.canGoBack)
const canGoForward = computed(() => navStore.canGoForward)

// 显示大小控制（持久化）
const DISPLAY_SIZE_STORAGE_KEY = 'assetManagement.displaySize'

/**
 * 从 localStorage 读取图标大小设置
 * @returns 保存的图标大小或默认值
 */
const getStoredDisplaySize = (): number => {
  try {
    const stored = localStorage.getItem(DISPLAY_SIZE_STORAGE_KEY)
    if (stored !== null) {
      const parsed = Number.parseInt(stored, 10)
      // 验证范围有效性（与滑块 min/max 保持一致：80-200）
      return Number.isNaN(parsed) ? 120 : Math.max(80, Math.min(200, parsed))
    }
    return 120
  } catch (error) {
    console.error('读取图标大小设置失败:', error)
    return 120
  }
}

const displaySize = ref(getStoredDisplaySize())

// 监听图标大小变化并持久化
watch(
  displaySize,
  (newValue) => {
    try {
      localStorage.setItem(DISPLAY_SIZE_STORAGE_KEY, String(newValue))
    } catch (error) {
      console.error('保存图标大小设置失败:', error)
    }
  },
  { immediate: false }
)

// 排序配置持久化
const SORT_CONFIG_STORAGE_KEY = 'assetManagement.sortConfig'

/**
 * 从 localStorage 读取排序配置
 * @returns 保存的排序配置或默认值
 */
const getStoredSortConfig = (): {
  sortBy: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType'
  sortOrder: 'asc' | 'desc'
} => {
  try {
    const stored = localStorage.getItem(SORT_CONFIG_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      // 验证字段值的有效性
      const validSortBy = ['assetName', 'modifiedTime', 'fileSize', 'assetType']
      const validSortOrder = ['asc', 'desc']
      if (validSortBy.includes(parsed.sortBy) && validSortOrder.includes(parsed.sortOrder)) {
        return parsed
      }
    }
  } catch (error) {
    console.error('读取排序配置失败:', error)
  }
  return { sortBy: 'modifiedTime', sortOrder: 'desc' }
}

// 排序配置（从 localStorage 恢复）
const storedSort = getStoredSortConfig()
const sortConfig = reactive<{
  sortBy: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType'
  sortOrder: 'asc' | 'desc'
}>({
  sortBy: storedSort.sortBy,
  sortOrder: storedSort.sortOrder
})

// 监听排序配置变化并持久化
watch(
  () => ({ sortBy: sortConfig.sortBy, sortOrder: sortConfig.sortOrder }),
  (newValue) => {
    try {
      localStorage.setItem(SORT_CONFIG_STORAGE_KEY, JSON.stringify(newValue))
    } catch (error) {
      console.error('保存排序配置失败:', error)
    }
  },
  { deep: true }
)

// 排序下拉菜单显示状态
const sortDropdownVisible = ref(false)

// 排序菜单点击处理
const handleSortMenuClick = ({ key }: { key: string }): void => {
  const [field, order] = key.split('-')
  const sortByMap: Record<string, 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType'> = {
    name: 'assetName',
    date: 'modifiedTime',
    size: 'fileSize',
    type: 'assetType'
  }
  sortConfig.sortBy = sortByMap[field] || 'assetName'
  sortConfig.sortOrder = (order as 'asc' | 'desc') || 'asc'
  sortDropdownVisible.value = false
  // 重新加载数据
  loadCurrentFolderAssets()
}

// 筛选面板展开状态
const filterPanelExpanded = ref(false)

/**
 * 显不显示依赖资产（导入时自动带进来的那些，isDependency = 1）。
 *
 * 这个开关原来在「偏好设置 → 资产」里。它是个**筛选器**，被当成全局偏好放在了
 * 另一个页面：想临时看一眼附带资产，得离开资产库、翻到偏好设置、改完再翻回来，
 * 而且改完这边也不刷新（这一页从来没监听过那个 localStorage 事件）。
 *
 * 现在跟其余筛选条件放在一起。存储键和语义保持原样（缺省 / 非 'false' 都算显示），
 * 老用户之前关过的状态照旧生效。
 */
const SHOW_DEPENDENCIES_KEY = 'assetManagement.showDependencies'
const showDependencies = ref(localStorage.getItem(SHOW_DEPENDENCIES_KEY) !== 'false')

/** 「重置筛选」里改这个值时置位：那条路后面自己会重新加载一次，不必在这儿再来一次 */
let suppressShowDependenciesReload = false

watch(showDependencies, (val) => {
  if (val) localStorage.removeItem(SHOW_DEPENDENCIES_KEY)
  else localStorage.setItem(SHOW_DEPENDENCIES_KEY, 'false')
  if (suppressShowDependenciesReload) {
    // 一次性的：watch 是异步（flush: 'pre'）回调，置位方没法在下一行把它复位，
    // 只能由被挡掉的这一次自己收尾
    suppressShowDependenciesReload = false
    return
  }

  // 改完立刻重算：这是筛选，不是等下次进页面才生效的偏好。
  //
  // 但要**沿着当前那条路**重算。正在搜的时候（有关键字、或者别的筛选把列表带进了
  // 搜索态）走 loadCurrentFolderAssets 会掉进浏览分支，把搜索结果换成整个文件夹，
  // 而搜索框里那个词还在 —— 用户看到的是「我只是勾了个筛选，结果搜索没了」
  // 收藏 / 回收站有自己的加载路径，它认这个条件；走搜索那条会因为没有树选中而空跑
  if (isShowingShortcutView.value) {
    loadCurrentFolderAssets()
    return
  }

  if (isSearching.value || filterForm.keyword.trim()) {
    // isSearching 得跟着置位，别只改分页。它是「列表里装的是搜索结果还是文件夹内容」
    // 这件事的唯一标记，翻页（loadNextPage）、:has-more、ensureFilesLoaded 全看它。
    // 漏了这一句就会出现：搜「rock」→ 点另一个文件夹（loadCurrentFolderAssets 把
    // isSearching 置回 false，而关键字还在）→ 勾「只看主资产」→ 列表换成搜索结果，
    // 可 isSearching 还是 false，于是往下滚一屏，loadBrowsePage 把那个文件夹的
    // 第二页原样接在搜索结果后面
    isSearching.value = true
    searchPagination.current = 1
    void performSearchWithPagination(false)
    return
  }
  loadCurrentFolderAssets()
})

/**
 * 决定走搜索还是走浏览的那个数。
 *
 * 「只看主资产」**不算**在这里面 —— 它一算进来，hasActiveFilters 就为真，
 * loadCurrentFolderAssets 于是永远走搜索那条路，而搜索和浏览在两件事上不等价：
 *
 *   1. ALL 这个虚拟根上，浏览是 `folderKey = 'ALL'`（只要根层），搜索直接把文件夹
 *      条件整个丢掉（buildAssetQueryParts）—— 于是点一下「只看主资产」，
 *      子文件夹列表变成了整库平铺。handleFilter / handleResetFilter 都有 isAllFolder
 *      这道闸，performSearchWithPagination 没有。
 *   2. 关键字不算在这个数里，所以「只搜了关键字」时 hasActiveFilters 是假：
 *      搜「rock」→ 开「只看主资产」（走搜索，关键字还在）→ 再关掉 → 回到浏览分支，
 *      列表被整个文件夹替换，而搜索框里还写着 rock。
 *
 * 两条路各自都认这个条件（浏览走 loadBrowsePage 的 showDependencies 参数，
 * 搜索走 criteria.showDependencies），所以不用靠它去改路由。
 */
const routingFilterCount = computed((): number => {
  let count = 0
  if (filterForm.fileCategory) count++
  if (filterForm.assetTypes && filterForm.assetTypes.length > 0)
    count += filterForm.assetTypes.length
  if (filterForm.sizeRange) count++
  if (filterForm.dateRange && filterForm.dateRange.length > 0) count++
  if (filterForm.tags && filterForm.tags.length > 0) count++
  if (filterForm.includeTags && filterForm.includeTags.length > 0) count++
  if (filterForm.excludeTags && filterForm.excludeTags.length > 0) count++
  if (filterForm.hasNoTags) count++
  if (filterForm.favoriteStatus && filterForm.favoriteStatus !== 'all') count++
  if (filterForm.engineVersions.length > 0) count += filterForm.engineVersions.length
  return count
})

const hasActiveFilters = computed((): boolean => routingFilterCount.value > 0)

/**
 * 徽标上显示的筛选条件数。**和路由那个数分开算。**
 *
 * 「只看主资产」不能进 routingFilterCount（理由在上面），但它必须进徽标：
 * 这个开关记在 localStorage 里、跨重启还在，而筛选面板收起来的时候界面上一点痕迹都没有。
 * 两个数共用一个 computed 的话，用户点过一次就得到一个永久变短的资产库
 * 加一个写着「没有筛选」的徽标，而唯一能解释它的那个开关被折叠着。
 */
const activeFilterCount = computed(
  (): number => routingFilterCount.value + (showDependencies.value ? 0 : 1)
)

// 本地筛选类型定义，保持组件内的类型明确
type FavoriteStatus = 'all' | 'favorite' | 'unfavorite'
type SizeRangeCategory = 'small' | 'medium' | 'large' | 'xlarge'

// 筛选表单数据
const filterForm = reactive<{
  fileCategory?: string
  assetTypes: string[]
  sizeRange?: SizeRangeCategory
  dateRange?: any[]
  tags: string[]
  includeTags: string[]
  excludeTags: string[]
  tagMatchMode: 'any' | 'all'
  hasNoTags: boolean
  keyword: string
  favoriteStatus?: FavoriteStatus
  includeSubfolders: boolean // 是否搜索子文件夹（性能优化：默认 false）
  /** 引擎版本（只有服务器库的筛选里有这一组） */
  engineVersions: string[]
}>({
  engineVersions: [],
  fileCategory: undefined,
  assetTypes: [],
  sizeRange: undefined,
  dateRange: undefined,
  tags: [],
  includeTags: [],
  excludeTags: [],
  tagMatchMode: 'any',
  hasNoTags: false,
  keyword: '',
  favoriteStatus: 'all',
  includeSubfolders: false // 默认不搜索子文件夹，提升首屏加载性能
})

/** 换了数据源：新库不支持的筛选（例如本地库没有引擎分面）清掉，免得看不见的条件还在起作用 */
watch(
  () => libraryStore.source,
  () => {
    if (!libraryCaps.value.filters.engine && filterForm.engineVersions.length > 0)
      filterForm.engineVersions = []
  }
)

/**
 * 写收藏时用的用户 id。
 *
 * 社区版没有多用户，收藏表里的 userId 是个预留字段，收藏按钮一路写死 1。
 * 读的那一侧必须用同一个值 —— 不然 JOIN 对不上，收藏读出来是空的。
 */
const FAVORITE_USER_ID = 1

// 文件列表相关
const fileListLoading = ref(false)
const currentFiles = ref<any[]>([])
const isSearching = ref(false)

/** 后端 assetSearch 认识的查询条件里，这一页会用到的那些 */
interface ListCriteria {
  folderKey?: string
  includeSubfolders: boolean
  keyword: string
  /** 服务器库按名字筛标签 */
  tagNames?: string[]
  tagFilter: { includeTagIds: number[]; excludeTagIds: number[]; matchMode: 'any' | 'all' }
  favoriteStatus?: string
  /** 只看回收站里的 */
  deletedOnly?: boolean
  /** 回收站视图：跟着文件夹一起删掉的资产不单独列 */
  excludeInsideDeletedFolders?: boolean
  userId: number
  vaultId: string | null
  hasNoTags?: boolean
  showDependencies: boolean
  sortBy: string
  sortOrder: 'asc' | 'desc'
  limit?: number
  offset?: number
  classNameCnFilters?: string[]
  fileExtensions?: string[]
  /** 引擎版本（前缀匹配：5.3 也命中 5.3.x） */
  engineVersions?: string[]
  sizeRange?: { min?: number; max?: number }
  dateRange?: { start: string; end: string }
}

/** 统一查询回来的资产行。字段是历史堆出来的，取值时到处都要兜底 */
interface SearchedAssetRow {
  assetKey?: string
  assetName?: string
  softPath?: string
  path?: string
  ext?: string
  fileExtension?: string
  [key: string]: unknown
}

/**
 * 把筛选栏、排序、关键字拼成后端认识的一组查询条件。
 *
 * 抽出来是因为**三个视图要用同一组条件**：普通文件夹的搜索、我的收藏、最近删除。
 * 原来只有搜索那一条路拼过它，另外两个视图各自走自己的接口（favoriteAPI /
 * getDeleted），一个条件都不认 —— 于是在收藏和回收站里改筛选、改排序，
 * 列表纹丝不动，筛选栏只是摆在那里骗人。
 *
 * `scope` 圈定这一批的范围：收藏 = 只要收藏的，回收站 = 只要删掉的。
 */
const buildListCriteria = (options: {
  folderKey?: string
  scope?: 'favorites' | 'deleted'
  includeSubfolders?: boolean
  limit?: number
  offset?: number
}): ListCriteria => {
  const { folderKey, scope, includeSubfolders, limit, offset } = options

  const criteria: ListCriteria = {
    folderKey,
    includeSubfolders: includeSubfolders ?? false,
    keyword: filterForm.keyword,
    // 服务器库的标签按名字筛（只能「带其中任一」）；本地库按 id，走下面的 tagFilter
    tagNames:
      libraryCaps.value.filters.tagMode === 'include-any' ? [...filterForm.includeTags] : [],
    tagFilter: {
      includeTagIds: filterForm.includeTags.map(Number).filter((n) => !isNaN(n)),
      excludeTagIds: filterForm.excludeTags.map(Number).filter((n) => !isNaN(n)),
      matchMode: filterForm.tagMatchMode || 'any'
    },
    // 「我的收藏」整个视图就是「已收藏」，筛选栏里那个收藏状态在这儿没有意义
    favoriteStatus: scope === 'favorites' ? 'favorite' : filterForm.favoriteStatus,
    deletedOnly: scope === 'deleted' || undefined,
    /**
     * 跟着文件夹一起进回收站的资产不单独列 —— 列的是文件夹那一条，和系统回收站
     * 一样。删一个包会带走几百个资产，全铺出来的话文件夹条目会被淹掉，
     * 而它们本来就跟着文件夹一起恢复。
     */
    excludeInsideDeletedFolders: scope === 'deleted' || undefined,
    /**
     * 收藏那张表的行是带 userId / vaultId 写进去的（收藏按钮传的是 1 + 当前保管库 id），
     * 而这里原来一个都不传 —— JOIN 条件于是退化成「只认 userId IS NULL 的收藏」，
     * 一条都对不上：筛选栏里的「只看收藏」永远是空列表，「只看未收藏」则是全库。
     */
    userId: FAVORITE_USER_ID,
    vaultId: currentVault.value?.id ?? null,
    hasNoTags: filterForm.hasNoTags || undefined,
    // 「只看主资产」也要跟着走搜索这条路。它一旦生效 hasActiveFilters 就是真，
    // 列表必然从浏览转到搜索，而搜索原来不认识这个条件 —— 筛选开着却一行没少
    showDependencies: showDependencies.value,
    /**
     * 回收站里「按时间排」= 按**删除时间**排。
     *
     * 这个视图叫「最近删除」，可它排的一直是文件的修改时间 —— 刚删掉的东西
     * 可能排在第 300 条，跟「最近」没有半点关系。修改时间在回收站里也没什么
     * 可看的：东西已经不在库里了。用户显式挑了名字 / 大小 / 类型的话照挑的来。
     */
    sortBy:
      scope === 'deleted' && sortConfig.sortBy === 'modifiedTime' ? 'deletedAt' : sortConfig.sortBy,
    sortOrder: sortConfig.sortOrder
  }

  if (limit !== undefined) criteria.limit = limit
  if (offset !== undefined) criteria.offset = offset

  if (filterForm.assetTypes && filterForm.assetTypes.length > 0) {
    // 前端传递的是中文类名（classNameCn），需要使用 classNameCnFilters 进行筛选
    // 使用展开运算符将响应式 Proxy 转换为普通数组，避免 IPC 序列化错误
    criteria.classNameCnFilters = [...filterForm.assetTypes]
  }

  // 库支持版本分面才带（本地库、服务器库都有）
  if (libraryCaps.value.filters.engine && filterForm.engineVersions.length > 0) {
    criteria.engineVersions = [...filterForm.engineVersions]
  }

  if (filterForm.fileCategory) {
    const category = ASSET_CATEGORIES.find((c) => c.key === filterForm.fileCategory)
    if (category) {
      criteria.fileExtensions = [...category.extensions]
    }
  }

  if (filterForm.sizeRange) {
    const sizeMap: Record<string, { min?: number; max?: number }> = {
      small: { max: 10 * 1024 * 1024 },
      medium: { min: 10 * 1024 * 1024, max: 100 * 1024 * 1024 },
      large: { min: 100 * 1024 * 1024, max: 1024 * 1024 * 1024 },
      xlarge: { min: 1024 * 1024 * 1024 }
    }
    criteria.sizeRange = sizeMap[filterForm.sizeRange]
  }

  if (filterForm.dateRange && filterForm.dateRange.length === 2) {
    const start = filterForm.dateRange[0]
    const end = filterForm.dateRange[1]
    criteria.dateRange = {
      start: typeof start?.toISOString === 'function' ? start.toISOString() : start,
      end: typeof end?.toISOString === 'function' ? end.toISOString() : end
    }
  }

  return criteria
}

/** 跑一次统一查询，并把行转成文件列表认识的形状 */
/**
 * 查询被取消（同一列表的新查询把它顶掉了，或者保管库正在切换）—— 不是失败，别弹「搜索失败」。
 * 主进程那边按 queryGroup 作废排着还没开始的旧查询，见 services/assetQueryRunner。
 */
const isCancelledQuery = (error: unknown): boolean =>
  Boolean((error as { cancelled?: boolean } | null)?.cancelled)

const searchAssetsWithCriteria = async (criteria: ListCriteria): Promise<SearchedAssetRow[]> => {
  const rows = (await getActiveLibrarySource().search.assets({
    ...criteria,
    // 搜索、收藏、回收站三个视图是同一个列表：新查询来了，排着的旧查询作废
    queryGroup: 'asset-list'
  } as never)) as unknown as SearchedAssetRow[]
  return rows.map((asset) => ({
    ...asset,
    id: asset.assetKey,
    name: asset.assetName,
    type: 'file',
    path: asset.softPath || asset.path || '',
    extension: asset.ext || asset.fileExtension || ''
  }))
}

/**
 * 快捷视图（我的收藏 / 最近删除）里，用户有没有提出过「只看某一类」的要求。
 *
 * 用来决定还要不要把收藏的**文件夹**摆出来：筛的是格式、类型、大小、标签这些
 * 资产才有的属性，文件夹一个都没有，继续混在里面就是「筛完了还剩一堆无关的」。
 */
const hasAssetLevelQuery = computed((): boolean =>
  Boolean(
    filterForm.keyword?.trim() ||
      filterForm.fileCategory ||
      filterForm.assetTypes?.length ||
      filterForm.sizeRange ||
      filterForm.includeTags?.length ||
      filterForm.excludeTags?.length ||
      filterForm.hasNoTags ||
      (filterForm.favoriteStatus && filterForm.favoriteStatus !== 'all') ||
      !showDependencies.value
  )
)

// 核心搜索逻辑（支持分页）
const performSearchWithPagination = async (isLoadMore = false): Promise<void> => {
  console.log('[performSearchWithPagination] Start. isLoadMore:', isLoadMore)

  if (!selectedKeys.value.length) {
    return
  }
  const currentFolderKey = selectedKeys.value[0]
  // 搜索这条路以前完全没有序号守卫：转入搜索时序号不变，之前那个慢速浏览请求
  // 返回后校验照样通过，把未过滤的整页数据盖到搜索结果上。
  // 加载更多沿用当前序号，新搜索则作废在途的一切。
  const requestToken = isLoadMore ? browseListRequestToken : beginListRequest()

  // 构造搜索条件
  // 性能优化：智能判断是否需要递归搜索子文件夹
  // 1. 用户手动开启 includeSubfolders
  // 2. 有关键词搜索时自动递归（用户预期搜索整个目录树）
  // 3. 有筛选条件时自动递归（按类型/标签筛选通常期望搜索全部）
  const hasActiveSearch = !!filterForm.keyword?.trim()
  const hasActiveFilters = !!(
    filterForm.fileCategory ||
    filterForm.assetTypes?.length ||
    filterForm.includeTags?.length ||
    filterForm.excludeTags?.length ||
    filterForm.sizeRange ||
    filterForm.hasNoTags ||
    filterForm.engineVersions.length > 0
  )
  const shouldIncludeSubfolders =
    filterForm.includeSubfolders || hasActiveSearch || hasActiveFilters

  const criteria = buildListCriteria({
    folderKey: currentFolderKey,
    includeSubfolders: shouldIncludeSubfolders,
    limit: searchPagination.pageSize,
    offset: (searchPagination.current - 1) * searchPagination.pageSize
  })

  console.log('[performSearchWithPagination] Sending criteria:', JSON.stringify(criteria, null, 2))
  console.log(
    `[performSearchWithPagination] Request params - limit: ${
      criteria.limit
    } (type: ${typeof criteria.limit}), offset: ${
      criteria.offset
    } (type: ${typeof criteria.offset})`
  )

  if (!isLoadMore) {
    fileListLoading.value = true
  }

  try {
    // 仅在第一页且不是"加载更多"时搜索文件夹
    // 注意：当有资产类型、文件格式或文件大小筛选时，不搜索文件夹，只显示资产
    const shouldSearchFolders =
      !isLoadMore &&
      !criteria.classNameCnFilters?.length &&
      !criteria.fileExtensions?.length &&
      !criteria.sizeRange

    const folderSearch =
      shouldSearchFolders && libraryCaps.value.folderSearch
        ? getActiveLibrarySource()
            .search.folders({
              folderKey: criteria.folderKey,
              // 注意：文件夹搜索不使用 includeSubfolders，只搜索当前文件夹的直接子文件夹
              includeSubfolders: false,
              keyword: criteria.keyword,
              limit: 1000 // 文件夹不分页，设置一个较大上限
            })
            .then((data) => ({ success: true, data }))
        : undefined

    // 并行请求：如果是第一页，同时搜索文件夹（不分页，上限1000）和文件（分页）
    const [fileItems, folderResponse] = await Promise.all([
      searchAssetsWithCriteria(criteria),
      folderSearch
    ])

    // 慢查询在途时用户可能已经清了关键词、点去别的文件夹或切了视图
    if (isStaleListRequest(requestToken)) return

    console.log(
      `[performSearchWithPagination] Received ${fileItems.length} assets. hasMore check: ${fileItems.length} >= pageSize (${searchPagination.pageSize})`
    )

    // 处理文件夹结果（仅在第一页）
    let folderItems: any[] = []
    if (!isLoadMore && folderResponse && folderResponse.success && folderResponse.data) {
      folderItems = folderResponse.data.map((folder: any) => ({
        id: folder.folderKey || folder.id,
        name: folder.folderName || folder.name,
        type: 'folder',
        path: folder.path || '',
        folderKey: folder.folderKey,
        isFavoriteFolder: false // 搜索结果中的文件夹暂时不标记为收藏
      }))
      console.log(`[performSearchWithPagination] Received ${folderItems.length} folders`)
    }

    if (isLoadMore) {
      currentFiles.value = [...currentFiles.value, ...fileItems]
    } else {
      // 第一页：文件夹 + 文件
      currentFiles.value = [...folderItems, ...fileItems]
    }

    searchPagination.hasMore = fileItems.length >= searchPagination.pageSize
    console.log('[performSearchWithPagination] hasMore:', searchPagination.hasMore)
  } catch (error) {
    console.error('搜索请求失败:', error)
    if (isStaleListRequest(requestToken)) return
    const cancelled = isCancelledQuery(error)
    if (!cancelled) message.error(t('assetManagement.search.failed'))
    if (isLoadMore) {
      // 页码不回滚的话，下次「加载更多」会直接跳过一页 —— 中间那 50 条永远看不到
      searchPagination.current = Math.max(1, searchPagination.current - 1)
    } else if (!cancelled) {
      currentFiles.value = []
    }
  } finally {
    if (!isStaleListRequest(requestToken)) fileListLoading.value = false
  }
}

// 输入搜索：递归查询当前文件夹及其子文件夹的文件
const performRecursiveSearch = async (keyword: string) => {
  const kw = (keyword || '').trim()

  // 收藏 / 回收站里搜索：走它们自己那条加载路径，关键字已经在 criteria 里。
  // 原来这两个视图的树选中是空的，会撞上下面那句「请先选择文件夹」直接返回
  if (isShowingShortcutView.value) {
    await loadCurrentFolderAssets()
    return
  }

  if (!selectedKeys.value.length) {
    message.warning(t('assetLib.search.selectFolderFirst'))
    return
  }

  if (!kw) {
    // 检查是否有其他筛选条件
    const hasFilters =
      filterForm.fileCategory ||
      (filterForm.assetTypes && filterForm.assetTypes.length > 0) ||
      filterForm.sizeRange ||
      filterForm.dateRange ||
      (filterForm.includeTags && filterForm.includeTags.length > 0) ||
      (filterForm.excludeTags && filterForm.excludeTags.length > 0) ||
      filterForm.hasNoTags ||
      (filterForm.favoriteStatus && filterForm.favoriteStatus !== 'all')

    if (hasFilters) {
      isSearching.value = true
      searchPagination.current = 1
      await performSearchWithPagination(false)
    } else {
      isSearching.value = false
      await loadCurrentFolderAssets()
    }
    return
  }

  // 有关键词，执行搜索
  isSearching.value = true
  searchPagination.current = 1
  await performSearchWithPagination(false)
}

let searchTimer: any = null

const handleSearchDebounced = async () => {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
  searchTimer = setTimeout(async () => {
    await performRecursiveSearch(filterForm.keyword)
  }, 300)
}

/**
 * 监听路由参数 search。
 *
 * 导入失败弹窗的「在资产库里找它」靠它落地：原来那个按钮只是
 * `push({ query: { search } })`，而这一页从来没读过这个参数 ——
 * 点了之后弹窗关掉、页面原地不动，比什么都不做更糟。
 *
 * 放在这儿而不是文件上半部那一排 watch 里：`immediate` 会在 `watch()` 那一行
 * 就同步跑一次，而 `filterForm` / `performRecursiveSearch` 都声明在下面 ——
 * 放上面直接踩 TDZ。路由是 keepAlive 的，`immediate` 是为了让「已经停在这一页」
 * 的情况也生效。
 */
watch(
  () => route.query.search,
  async (keyword) => {
    if (!keyword || typeof keyword !== 'string') return
    assetViewStore.ensureAssets()
    filterForm.keyword = keyword
    await performRecursiveSearch(keyword)
  },
  { immediate: true }
)

const handleSearchImmediate = async () => {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  await performRecursiveSearch(filterForm.keyword)
}

/**
 * 窄屏下搜索框的展开态。
 *
 * 「现在够不够宽」由容器查询判断，这里不重复算一遍尺寸：宽的时候输入框本来就常驻，
 * 这个 class 命不中任何规则，等于不存在。所以窗口变宽变窄都不用同步它。
 */
const searchExpanded = ref(false)
const searchInputRef = ref<{ focus?: () => void } | null>(null)

const expandSearch = async (): Promise<void> => {
  searchExpanded.value = true
  await nextTick()
  searchInputRef.value?.focus?.()
}

/** 关键词还在就不收回去，否则用户看不见自己正在搜什么 */
const handleSearchBlur = (): void => {
  if (!filterForm.keyword?.trim()) {
    searchExpanded.value = false
  }
}

watch(
  () => filterForm.keyword,
  async (val) => {
    if (!val || !val.trim()) {
      isSearching.value = false
      await loadCurrentFolderAssets()
    }
  }
)

// 右侧详情面板状态：从 localStorage 恢复，默认显示
// 右侧详情面板状态：从 localStorage 恢复，默认显示
// 使用新 key 以重置用户的默认状态为打开
const STORAGE_KEY = 'assetManagement.detailsPanel.visible'
const getStoredPanelState = (): boolean => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) {
      const parsed = JSON.parse(stored)
      return typeof parsed === 'boolean' ? parsed : true
    }
    return true
  } catch (error) {
    console.error('读取详情面板状态失败:', error)
    return true
  }
}

const detailsPanelVisible = ref(getStoredPanelState())

// 保存切换到云存储视图前的面板状态，用于切换回本地资产时恢复
let savedPanelStateBeforeCloudView: boolean | null = null

// 监听视图模式变化，自动处理面板状态
watch(
  () => assetViewStore.mode,
  (newMode, oldMode) => {
    const cloudModes = ['baiduyun', 'webdav', 'tagManagement']
    const isEnteringCloud = cloudModes.includes(newMode) && !cloudModes.includes(oldMode || '')
    const isLeavingCloud = !cloudModes.includes(newMode) && cloudModes.includes(oldMode || '')

    if (isEnteringCloud) {
      // 进入云存储视图：保存当前状态并隐藏面板
      savedPanelStateBeforeCloudView = detailsPanelVisible.value
      detailsPanelVisible.value = false
    } else if (isLeavingCloud && savedPanelStateBeforeCloudView !== null) {
      // 离开云存储视图：恢复之前的状态
      detailsPanelVisible.value = savedPanelStateBeforeCloudView
      savedPanelStateBeforeCloudView = null
    }
  }
)

// 监听状态变化并持久化（仅在非云存储视图时保存）
watch(
  detailsPanelVisible,
  (newValue) => {
    // 如果是因为切换到云存储视图而关闭面板，不保存到 localStorage
    if (savedPanelStateBeforeCloudView !== null) {
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newValue))
    } catch (error) {
      console.error('保存详情面板状态失败:', error)
    }
  },
  { immediate: true }
)
const selectedAsset = ref<any | null>(null)
// 向子组件提供选中资产
provide('selectedAsset', selectedAsset)

// 文件预览状态
const filePreviewVisible = ref(false)
const previewFile = ref<any>(null)

const handlePreviewClose = () => {
  filePreviewVisible.value = false
  previewFile.value = null
}

const resolveAssetRemoteFallbackUrl = async (
  file: any,
  ext?: string
): Promise<string | undefined> => {
  return await resolveAssetUrlWithFallback({
    vaultType: currentVault.value?.vaultType,
    vaultPath: currentVault.value?.path,
    networkPath: currentVault.value?.networkPath,
    originPath: file?.originPath,
    filePath: file?.filePath,
    assetKey: String(file?.assetKey || ''),
    assetName: String(file?.name || file?.assetName || ''),
    fileExtension: ext || file?.fileExtension || file?.ext,
    folderKey: String(file?.folderKey || ''),
    resolveAssetByKey: async (assetKey: string) => {
      try {
        return await assetDataAPI.getById(assetKey)
      } catch (error) {
        console.warn('[AssetManagement] 获取资产详情失败，回退为当前列表数据:', error)
        return undefined
      }
    },
    resolveFolderRelativePath: async (folderKey: string) => {
      try {
        const folder = await assetFolderAPI.getByKey(folderKey)
        return folder?.fullPath
      } catch (error) {
        console.warn('[AssetManagement] 获取文件夹路径失败，回退为文件名:', error)
        return undefined
      }
    }
  })
}

/**
 * 打开文件时显示详情面板，并设置当前选中资产
 * @param file 当前打开的资产对象
 */
const handleFileOpen = async (file: any) => {
  // 优先使用 fileExtension 字段判断文件类型
  let ext = file.fileExtension || file.ext
  if (!ext) {
    // 否则从文件名后缀获取
    const name = file.name || file.assetName || ''
    ext = name.split('.').pop()?.toLowerCase() || ''
  }
  ext = ext.toLowerCase().replace(/^\./, '')

  // 检查是否有设置默认应用
  try {
    const saved = localStorage.getItem('assetManagement.defaultApps')
    if (saved) {
      const defaultApps = JSON.parse(saved)
      const category = ASSET_CATEGORIES.find((c) => c.extensions.includes(ext))
      if (category && defaultApps[category.key]) {
        const access = resolveAssetAccess({
          vaultType: currentVault.value?.vaultType,
          vaultPath: currentVault.value?.path,
          networkPath: currentVault.value?.networkPath,
          originPath: file?.originPath,
          filePath: file?.filePath
        })
        if (access.localPath) {
          // 使用设置的默认应用打开
          void (window as any).api.shell.openWith(access.localPath, defaultApps[category.key])
          return
        }
      }
    }
  } catch (e) {
    console.error('Failed to checking default app:', e)
  }

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds']
  if (ext && imageExts.includes(ext)) {
    // 图片：统一走全局 PhotoSwipe 查看器
    const buildImagePreviewSrc = (target: any): string | undefined => {
      const isNetworkVault = currentVault.value?.vaultType === 'network'
      const basePath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
      const rawPath = target?.filePath || target?.originPath

      // 图片大图优先走真实文件地址，而不是 .thumbnails
      if (rawPath) {
        const rawStr = String(rawPath)
        if (
          /^[a-zA-Z]:[\\/]/.test(rawStr) ||
          rawStr.startsWith('/') ||
          rawStr.startsWith('file:') ||
          rawStr.startsWith('http')
        ) {
          return rawStr
        }

        const directUrl = buildDirectFileUrl(basePath, rawStr, isNetworkVault)
        if (directUrl) {
          return directUrl
        }
      }

      // 回退到缩略图/自定义封面
      const posterOrThumb = target?.customPoster || target?.imgLocalPath
      if (!posterOrThumb) return undefined

      const relativeThumb = String(posterOrThumb)
      if (relativeThumb.startsWith('http') || relativeThumb.startsWith('file:')) {
        return relativeThumb
      }

      return buildThumbnailUrl(basePath, relativeThumb, isNetworkVault)
    }

    const imageSrc = buildImagePreviewSrc(file)

    if (imageSrc) {
      console.log('[AssetManagement] Opening image with src:', imageSrc)

      // 收集当前目录所有图片，支持左右切换
      const allImages: { src: string; alt: string }[] = []
      let clickedIndex = 0

      for (const f of currentFiles.value) {
        // 跳过文件夹
        if (f.type === 'folder') continue

        // 判断是否为图片
        let fileExt = f.fileExtension || f.ext
        if (!fileExt) {
          const name = f.name || f.assetName || ''
          fileExt = name.split('.').pop()?.toLowerCase() || ''
        }
        fileExt = fileExt.toLowerCase().replace(/^\./, '')

        if (!imageExts.includes(fileExt)) continue

        // 如果是当前点击的文件，直接使用前面计算好的 imageSrc (它是绝对路径)
        // 这样可以复用 AssetFileList 中传递过来的修正后的 filePath
        if (
          (f.assetKey && file.assetKey && f.assetKey === file.assetKey) ||
          (f.id && file.id && f.id === file.id) ||
          (f.filePath && file.filePath && f.filePath === file.filePath)
        ) {
          clickedIndex = allImages.length
          allImages.push({
            src: imageSrc,
            alt: String(f.name || f.assetName || '')
          })
          continue
        }

        // 构建图片源 URL
        const src = buildImagePreviewSrc(f)

        if (src) {
          // 记录被点击图片的索引
          if (
            (f.id && file.id && f.id === file.id) ||
            (f.filePath && f.filePath === file.filePath)
          ) {
            clickedIndex = allImages.length
          }
          allImages.push({
            src,
            alt: String(f.name || f.assetName || '')
          })
        }
      }

      // 如果收集到多张图片，使用列表模式；否则使用单张模式
      if (allImages.length > 0) {
        void openImageViewer({
          items: allImages,
          index: clickedIndex
        })
      } else {
        void openImageViewer({
          items: [{ src: imageSrc, alt: String(file?.name || file?.assetName || '') }],
          index: 0
        })
      }
      return
    } else {
      console.warn('[AssetManagement] No image source found for file:', file)
    }
  }

  // 3D 模型：跳转到 Model3DViewer 页面
  const modelExts = ['fbx', 'obj', 'glb', 'gltf']
  if (ext && modelExts.includes(ext)) {
    const access = resolveAssetAccess({
      vaultType: currentVault.value?.vaultType,
      vaultPath: currentVault.value?.path,
      networkPath: currentVault.value?.networkPath,
      originPath: file?.originPath,
      filePath: file?.filePath
    })
    const fallbackUrl = access.fileUrl ? undefined : await resolveAssetRemoteFallbackUrl(file, ext)
    if (access.localPath || access.fileUrl || fallbackUrl) {
      await router.push({
        name: 'Model3DViewer',
        query: {
          filePath: access.localPath,
          fileUrl: access.isRemoteHttp ? access.fileUrl || fallbackUrl : undefined,
          fileName: String(file?.name || file?.assetName || ''),
          // 带上资产 key，查看器里的「截图更新缩略图」才知道要更新谁
          assetKey: String(file?.assetKey || '') || undefined
        }
      })
      return
    }
  }

  // 视频/PDF/文本/代码：使用 FilePreviewModal
  const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv']
  const textExts = ['txt', 'log']
  const codeExts = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'vue',
    'css',
    'less',
    'scss',
    'sass',
    'html',
    'xml', // svg handled by image viewer
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
    'conf',
    'md',
    'markdown',
    'py',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'go',
    'rs',
    'php',
    'sh',
    'bash',
    'bat',
    'ps1',
    'cmd',
    'sql',
    'uproject',
    'uplugin',
    'lock',
    'gitignore'
  ]
  const otherPreviewExts = ['pdf', ...textExts, ...codeExts]

  if (ext && (videoExts.includes(ext) || otherPreviewExts.includes(ext))) {
    previewFile.value = file
    filePreviewVisible.value = true
    return
  }

  // 音频：使用全局播放器
  const audioExts = ['mp3', 'wav', 'aac', 'flac', 'm4a']
  if (ext && audioExts.includes(ext)) {
    const access = resolveAssetAccess({
      vaultType: currentVault.value?.vaultType,
      vaultPath: currentVault.value?.path,
      networkPath: currentVault.value?.networkPath,
      originPath: file?.originPath,
      filePath: file?.filePath
    })
    const src = access.fileUrl || (await resolveAssetRemoteFallbackUrl(file, ext)) || ''

    if (src) {
      const title = file.name || file.assetName || t('assetManagement.player.untitledAudio')

      const audioStore = useGlobalAudioStore()
      audioStore.playAudio({
        src,
        title
      })
      return
    }
  }

  selectedAsset.value = file
  detailsPanelVisible.value = true
}
/**
 * 用户手动关闭详情面板，同时清空当前选中资产
 */
const handleDetailsClose = () => {
  detailsPanelVisible.value = false
  selectedAsset.value = null
}

/**
 * 处理文件夹封面更新
 */
const handleFolderUpdated = async (payload: { key: string; img: string }) => {
  // 更新 selectedListFolder
  if (selectedListFolder.value && selectedListFolder.value.key === payload.key) {
    selectedListFolder.value = { ...selectedListFolder.value, img: payload.img }
  }
  // 更新文件列表中的对应项
  const target = currentFiles.value.find((f) => f.id === payload.key)
  if (target) {
    target.img = payload.img
  }

  // 更新树节点（左侧菜单）
  const treeNode = findNodeByKey(payload.key)
  if (treeNode) {
    treeNode.img = payload.img
  }
}

/**
 * 单击文件时：设置当前选中文件
 * 详情面板的显示/隐藏由按钮开关控制
 * @param file 单击的文件对象
 */
const handleFileClick = (file: any) => {
  folderSelectionRequestToken++
  selectedAsset.value = file
  selectedListFolder.value = null // 选中文件时清空文件夹选择
}

/**
 * 单击文件夹时：设置当前选中文件夹，用于详情面板显示
 * @param folder 单击的文件夹对象
 */
const selectedListFolder = ref<{
  key: string
  name: string
  path: string
  foldersCount: number
  filesCount: number
  img?: string
} | null>(null)
let folderSelectionRequestToken = 0

const handleFolderSelect = async (folder: any) => {
  const requestToken = ++folderSelectionRequestToken
  const folderKey = String(folder.folderKey || folder.key || folder.id || '')

  if (!folderKey) {
    return
  }

  // 清空资产选择，设置文件夹选择
  selectedAsset.value = null

  // Load lightweight counts instead of full folder contents.
  try {
    const showDependencies = localStorage.getItem('assetManagement.showDependencies') !== 'false'
    const librarySource = getActiveLibrarySource()
    const [filesCount, foldersCount] = await Promise.all([
      librarySource.assets.getCountByFolderKey(folderKey, showDependencies),
      librarySource.folders.getChildCount(folderKey)
    ])

    if (requestToken !== folderSelectionRequestToken) {
      return
    }

    selectedListFolder.value = {
      key: folderKey,
      name: folder.name,
      path: folder.path || currentPath.value + '/' + folder.name,
      foldersCount,
      filesCount,
      img: folder.img
    }
  } catch (error) {
    console.error('获取文件夹详情失败:', error)

    if (requestToken !== folderSelectionRequestToken) {
      return
    }

    // 即使获取详情失败，也设置基本信息
    selectedListFolder.value = {
      key: folderKey,
      name: folder.name,
      path: folder.path || currentPath.value + '/' + folder.name,
      foldersCount: 0,
      filesCount: 0,
      img: folder.img
    }
  }
}

/**
 * 点击空白区域时：清空当前选中文件
 * 详情面板的显示/隐藏由按钮开关控制
 */
const handleEmptyClick = () => {
  folderSelectionRequestToken++
  selectedAsset.value = null
  selectedListFolder.value = null // 同时清空文件夹选择
}

/**
 * 监听保管库切换状态，立即清除详情面板的选中数据
 * 这样可以避免保管库切换时详情面板显示旧数据造成闪动
 */
watch(
  () => vaultStore.switching,
  (isSwitching) => {
    if (isSwitching) {
      folderSelectionRequestToken++
      selectedAsset.value = null
      selectedListFolder.value = null
    }
  }
)

/**
 * 计算当前选中文件夹的详情信息
 * 包含文件夹名称、路径、子文件夹与文件数量等
 */
const selectedFolderDetail = computed(() => {
  const key = selectedKeys.value[0]
  const path = currentPath.value || '/'
  // 查找树节点名称
  const findNodeByKey = (nodes: any[], tgt: string): any | null => {
    for (const n of nodes) {
      if (n.key === tgt) return n
      if (Array.isArray(n.children)) {
        const found = findNodeByKey(n.children, tgt)
        if (found) return found
      }
    }
    return null
  }
  const node = key ? findNodeByKey(treeData.value || [], key) : null
  const name = node?.title || t('assetManagement.folder.currentFolder')
  const loadedFoldersCount = (currentFiles.value || []).filter(
    (f: any) => f.type === 'folder'
  ).length
  const loadedFilesCount = (currentFiles.value || []).filter((f: any) => f.type !== 'folder').length
  const useBrowseTotals =
    assetViewStore.mode === 'assets' &&
    !selectionStore.selectedShortcut &&
    !isSearching.value &&
    !isShowingDeleted.value
  const foldersCount = useBrowseTotals ? currentFolderCounts.folders : loadedFoldersCount
  const filesCount = useBrowseTotals ? currentFolderCounts.files : loadedFilesCount
  return key ? { key, name, path, foldersCount, filesCount, img: node?.img } : null
})

// AssetTree 组件引用
const assetTreeRef = ref()
// 全局视图模式由 Pinia 管理

// 处理添加文件夹
const handleAddFolder = async (parentKey: string | null, folderName: string) => {
  console.log(parentKey, folderName)

  try {
    // 创建文件夹
    const newFolderKey = await addFolder(parentKey, folderName)
    message.success(t('assetLib.folder.createSuccess'))

    // 刷新当前文件夹数据，让新创建的文件夹显示出来
    await loadCurrentFolderAssets()

    return newFolderKey
  } catch (error) {
    console.error('创建文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.folder.createFailed')))
    throw error
  }
}

// 处理删除文件夹
const handleDeleteFolder = async (folderKey: string) => {
  try {
    // 记录是否删除的是当前选中节点
    const wasSelected = selectedKeys.value.includes(folderKey)

    // 网络库走 V2 IPC（递归删除子树 + 同步传播）
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    if (isNetworkVault && currentVault.value?.id) {
      const result = await window.api.invoke(
        'networkVaultV2:deleteFolder',
        currentVault.value.id,
        folderKey
      )
      if (!result.success) {
        throw new Error(result.error || '删除网络文件夹失败')
      }
      // 复用 assetContext 的树移除逻辑（含 isLeaf 更新 + 响应式触发）
      assetContext.removeTreeNodes([folderKey])
      // 乐观更新右侧列表：移除该文件夹项
      if (wasSelected) {
        selectedKeys.value = []
        currentPath.value = '/'
        currentFiles.value = []
      } else {
        currentFiles.value = currentFiles.value.filter(
          (f: any) => !(f.type === 'folder' && (f.folderKey === folderKey || f.id === folderKey))
        )
      }
    } else {
      // 本地库走原逻辑
      await deleteFolder(folderKey)
      if (wasSelected) {
        selectedKeys.value = []
        currentPath.value = '/'
        currentFiles.value = []
      } else {
        await loadCurrentFolderAssets()
      }
    }
  } catch (error) {
    console.error('删除文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.folder.deleteFailed')))
    throw error
  }
}

// 处理重命名文件夹
const handleRenameFolder = async (folderKey: string, newName: string) => {
  try {
    await renameFolder(folderKey, newName)
    // message.success('文件夹重命名成功')
  } catch (error) {
    console.error('重命名文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.folder.renameFailed')))
    throw error
  }
}

// 已在上方实现 handleFileClick：单击显示详情

// 添加一个公共的导航方法，供外部调用
const navigateToFolderById = async (
  folderKey: string,
  isCurrent: () => boolean = () => true
): Promise<boolean> => {
  try {
    console.log('开始导航到文件夹:', folderKey)

    // 使用智能导航方法
    const success = await navigateToFolder(folderKey, isCurrent)
    if (!isCurrent()) return false

    if (success) {
      console.log('导航成功，强制刷新文件夹内容')

      // 确保选中状态正确
      if (!selectedKeys.value.includes(folderKey)) {
        selectedKeys.value = [folderKey]
      }

      selectionStore.setTreeKey(folderKey)

      // 强制重新加载文件夹内容，确保右侧显示最新数据
      await loadCurrentFolderAssets()

      if (!isCurrent()) return false

      // 推入历史
      navStore.push(currentPath.value || '/', selectedKeys.value[0] || null)

      console.log('右侧内容已更新完成')
      return true
    } else {
      console.warn('导航失败')
      message.error(t('assetManagement.folder.navigateFailed'))
      return false
    }
  } catch (error) {
    console.error('导航过程中发生错误:', error)
    message.error(t('assetManagement.folder.navigateFailedRetry'))
    return false
  }
}

// 解析路径为 folderKey（逐级查询数据库）
const resolveFolderKeyByPath = async (path: string): Promise<string | null> => {
  try {
    if (!path || path === '/') return null
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return null

    // 查询根文件夹，匹配第一级名称
    const rootResp = await (window as any).api.database.assetFolder.getRootFolders()
    if (!rootResp?.success || !Array.isArray(rootResp.data)) {
      return null
    }
    const firstName = parts[0]
    const first = (rootResp.data as any[]).find((f) => f.folderName === firstName)
    if (!first) {
      return null
    }
    let currentKey: string = first.folderKey

    // 逐级向下查找子文件夹
    for (let i = 1; i < parts.length; i++) {
      const name = parts[i]
      const childResp = await (window as any).api.database.assetFolder.getByFatherKey(currentKey)
      const child =
        childResp?.success && Array.isArray(childResp.data)
          ? (childResp.data as any[]).find((f) => f.folderName === name)
          : null
      if (!child) {
        return null
      }
      currentKey = child.folderKey
    }

    return currentKey
  } catch (err) {
    console.error('解析路径为 folderKey 失败:', err)
    return null
  }
}

// 面包屑导航点击处理：支持根目录与路径解析
const handleBreadcrumbClick = async (item: {
  path: string
  name: string
  key?: string
  isVault?: boolean
}) => {
  // 点击资产库不导航
  if (item.isVault) return

  // 优先使用唯一的 folderKey 导航（解决同名文件夹问题）
  if (item.key) {
    await navigateToFolderById(item.key)
    return
  }

  // 根目录：清空选中与文件列表
  if (item.path === '/') {
    selectedKeys.value = []
    currentPath.value = '/'
    currentFiles.value = []
    resetPagination()
    navStore.push('/')
    return
  }

  // 优先在已加载的树结构中查找节点（通过路径匹配）
  // 面包屑的路径一定来自已加载的树节点，所以应该能找到
  const findNodeByPath = (
    nodes: typeof treeData.value,
    targetPath: string
  ): (typeof treeData.value)[0] | null => {
    for (const node of nodes) {
      if (node.path === targetPath) {
        return node
      }
      if (node.children) {
        const found = findNodeByPath(node.children, targetPath)
        if (found) return found
      }
    }
    return null
  }

  const node = findNodeByPath(treeData.value, item.path)
  if (node) {
    // 直接使用节点的 key 导航
    await navigateToFolderById(node.key)
    return
  }

  // 回退：如果树中没找到，尝试通过数据库查询
  const folderKey = await resolveFolderKeyByPath(item.path)
  if (folderKey) {
    await navigateToFolderById(folderKey)
  } else {
    message.error(t('assetManagement.folder.locateFailed'))
  }
}

// 处理保管库管理
const handleManageVaults = () => {
  message.info(t('assetManagement.vault.devFeature'))
  // TODO: 实现保管库管理功能，可以打开保管库管理对话框
}

// 处理保管库切换
const handleVaultChanged = async (vault: any) => {
  console.log('保管库已切换:', vault)

  try {
    // 重置树状态并重新加载数据
    await resetTreeState()

    // 清空当前文件列表
    currentFiles.value = []
    resetPagination()

    // message.success('数据已刷新')
  } catch (error) {
    console.error('刷新数据失败:', error)
    message.error(t('assetManagement.refresh.failed'))
  }
}

const enterFolderFromCurrentList = async (folder: {
  id?: string
  key?: string
  folderKey?: string
  name?: string
  path?: string
}): Promise<boolean> => {
  folderSelectionRequestToken++
  const folderKey = String(folder.folderKey || folder.key || folder.id || '')
  const parentKey = selectedKeys.value[0]

  if (!folderKey || !parentKey) {
    return false
  }

  try {
    // Fast path for direct child navigation from the current list:
    // keep the tree in sync without rebuilding the whole ancestor chain.
    if (!expandedKeys.value.includes(parentKey)) {
      expandedKeys.value = [...expandedKeys.value, parentKey]
    }

    await ensureNodeExists(folderKey, parentKey)

    selectedKeys.value = [folderKey]
    currentPath.value =
      folder.path ||
      `${currentPath.value.replace(/\/$/, '')}/${folder.name || folderKey}`.replace(/\/{2,}/g, '/')

    selectedListFolder.value = null
    selectedAsset.value = null
    selectionStore.setTreeKey(folderKey)

    await loadCurrentFolderAssets()
    navStore.push(currentPath.value || '/', selectedKeys.value[0] || null)
    return true
  } catch (error) {
    console.error('Fast folder enter failed, fallback to smart navigation:', error)
    return false
  }
}

// 处理文件夹点击 - 双击进入子文件夹
const handleFolderClick = async (folder: any): Promise<void> => {
  console.log('Folder clicked:', folder)

  // 如果是双击事件，进入子文件夹
  if (folder.type === 'folder') {
    const entered = await enterFolderFromCurrentList(folder)
    if (!entered) {
      await navigateToFolderById(String(folder.folderKey || folder.key || folder.id || ''))
    }
  }
}

// 分页状态管理
const pageSize = ref(100) // 默认每页 100 条
const currentPage = ref(1)
const hasMore = ref(false)
const isLoadingMore = ref(false)
const allAssetsCache = ref<any[]>([]) // 缓存当前视图的全量数据
const currentFolderCounts = reactive({
  folders: 0,
  files: 0
})
/**
 * 列表请求序号 —— **所有**会写 currentFiles 的加载路径共用这一个。
 *
 * 以前只有「无筛选浏览」这条路会递增它：一旦转入搜索，序号不变，
 * 之前那个慢速浏览请求返回时校验照样通过，把未过滤的整页数据盖到搜索结果上。
 * 收藏 / 回收站两条路更是完全没有守卫 —— 点回收站（网络库慢查询在途）后
 * 立刻点某个文件夹，文件夹加载完又会被迟到的回收站数据整体替换。
 */
let browseListRequestToken = 0

/**
 * 换了一批列表内容的次数。**只在开新请求时加一，翻页（加载更多）不加。**
 *
 * 给文件列表用来复位「文件夹 / 文件」两个分区的折叠状态：排序、筛选、搜索、
 * 换文件夹都会换掉整批内容，这时候还让上一批留下的折叠生效，用户看到的就是
 * 一个「排序完/搜完什么都没有」的空列表 —— 而唯一能解释它的那个箭头缩在标题里。
 * 折叠只在同一批结果里有效，换一批就重新摊开。
 */
const listGeneration = ref(0)

/** 开一次新的列表请求，之前在途的一律作废 */
const beginListRequest = (): number => {
  listGeneration.value++
  return ++browseListRequestToken
}

/** 结果回来时先问一句：这还是用户现在要看的那个列表吗 */
const isStaleListRequest = (token: number): boolean => token !== browseListRequestToken

// 搜索分页状态
const searchPagination = reactive({
  current: 1,
  pageSize: 50,
  hasMore: false
})

// 重置分页状态
const resetPagination = () => {
  currentPage.value = 1
  hasMore.value = false
  isLoadingMore.value = false
  allAssetsCache.value = []
  currentFolderCounts.folders = 0
  currentFolderCounts.files = 0

  // 重置搜索分页
  searchPagination.current = 1
  searchPagination.hasMore = false
}

// 更新文件列表（包含分页初始化逻辑）
const updateFileList = (items: any[]) => {
  allAssetsCache.value = items
  currentPage.value = 1
  // 初次只加载第一页
  currentFiles.value = items.slice(0, pageSize.value)
  hasMore.value = currentFiles.value.length < items.length
}

const mapSubFolderToListItem = (folder: any) => ({
  id: folder.folderKey || folder.id,
  key: folder.folderKey || folder.id,
  folderKey: folder.folderKey || folder.id,
  name: folder.name,
  type: 'folder' as const,
  folderType: folder.folderType,
  fatherKey: folder.fatherKey,
  path: folder.path,
  size: 0,
  modifiedTime: folder.modifiedTime || new Date().toISOString(),
  extension: '',
  color: folder.color,
  img: folder.img
})

const loadBrowsePage = async (
  selectedFolderKey: string,
  page: number,
  append: boolean,
  requestToken: number
): Promise<void> => {
  const showDependencies = localStorage.getItem('assetManagement.showDependencies') !== 'false'
  const pageLimit = pageSize.value
  const offset = (page - 1) * pageLimit

  const librarySource = getActiveLibrarySource()
  const [folderCount, assetCount] = await Promise.all([
    librarySource.folders.getChildCount(selectedFolderKey),
    librarySource.assets.getCountByFolderKey(selectedFolderKey, showDependencies)
  ])

  if (requestToken !== browseListRequestToken) {
    return
  }

  const totalCount = folderCount + assetCount
  currentFolderCounts.folders = folderCount
  currentFolderCounts.files = assetCount
  const folderOffset = Math.min(offset, folderCount)
  const folderLimit = Math.max(0, Math.min(pageLimit, folderCount - folderOffset))
  const assetOffset = Math.max(0, offset - folderCount)
  const assetLimit = Math.max(0, pageLimit - folderLimit)

  const [subFolders, assets] = await Promise.all([
    folderLimit > 0
      ? getSubFolders(
          selectedFolderKey,
          sortConfig.sortBy,
          sortConfig.sortOrder,
          folderLimit,
          folderOffset
        )
      : Promise.resolve([]),
    assetLimit > 0
      ? loadAssetsByFolder(
          selectedFolderKey,
          sortConfig.sortBy,
          sortConfig.sortOrder,
          showDependencies,
          assetLimit,
          assetOffset
        )
      : Promise.resolve([])
  ])

  if (requestToken !== browseListRequestToken) {
    return
  }

  const pageItems = [...subFolders.map(mapSubFolderToListItem), ...assets]
  currentPage.value = page
  currentFiles.value = append ? [...currentFiles.value, ...pageItems] : pageItems
  hasMore.value = currentFiles.value.length < totalCount
}

// 加载更多数据
const loadNextPage = async (): Promise<void> => {
  if (isLoadingMore.value) return

  // 如果正在显示回收站，使用后端分页
  if (isShowingDeleted.value) {
    if (!hasMore.value) return
    await handleDeletedShortcut(true)
    return
  }

  // 收藏列表一次性取回、前端分页。以前这里没有分支，会掉进下面的「普通浏览」，
  // 拿残留的 selectedKeys[0] 去查那个文件夹的第 2 页；清了树选中之后则是
  // 直接 return —— 第 100 条之后的收藏永远看不到
  if (isShowingFavorites.value) {
    if (!hasMore.value) return
    const next = allAssetsCache.value.slice(0, currentFiles.value.length + pageSize.value)
    currentFiles.value = next
    currentPage.value += 1
    hasMore.value = next.length < allAssetsCache.value.length
    return
  }

  // 如果处于搜索状态，使用后端分页加载
  if (isSearching.value) {
    if (!searchPagination.hasMore) return
    isLoadingMore.value = true
    try {
      searchPagination.current++
      await performSearchWithPagination(true)
    } finally {
      isLoadingMore.value = false
    }
    return
  }

  // 普通浏览模式，使用前端分页
  if (!hasMore.value) return

  isLoadingMore.value = true
  try {
    const selectedFolderKey = selectedKeys.value[0]
    if (!selectedFolderKey) return

    const requestToken = browseListRequestToken
    const nextPage = currentPage.value + 1
    await loadBrowsePage(selectedFolderKey, nextPage, true, requestToken)
  } finally {
    isLoadingMore.value = false
  }
}

// 全选和定位复用现有分页，不额外加载缩略图，也不并发请求同一页。
let loadMorePromise: Promise<void> | null = null
const handleLoadMore = (): Promise<void> => {
  if (!loadMorePromise) {
    loadMorePromise = loadNextPage().finally(() => {
      loadMorePromise = null
    })
  }
  return loadMorePromise
}
const selectionScope = computed(() =>
  JSON.stringify([
    currentVault.value?.id,
    selectedKeys.value,
    selectionStore.selectedShortcut,
    filterForm,
    showDependencies.value
  ])
)
const ensureFilesLoaded = async (assetKey?: string): Promise<boolean> => {
  const scope = selectionScope.value
  if (fileListLoading.value) {
    // 这个 watch 是在子组件的事件回调里建的，那时候没有活跃的 effect scope，
    // Vue 不会把它挂到本组件的卸载上。所以停它这件事只能自己保证：`stop` 提到
    // 外面、用 finally 收尾 —— 光在回调里 stop 的话，只要 fileListLoading 有一次
    // 没翻回 false（卸载时某条路抛了），这个 watch 就一直挂着，连带整个 setup
    // 闭包（含 currentFiles）都回收不掉，而那个 await 永远不会返回
    let stop: (() => void) | undefined
    try {
      await new Promise<void>((resolve) => {
        stop = watch(fileListLoading, (loading) => {
          if (!loading) resolve()
        })
      })
    } finally {
      stop?.()
    }
  }
  const token = browseListRequestToken
  while (scope === selectionScope.value && token === browseListRequestToken) {
    if (assetKey && currentFiles.value.some((file) => (file.assetKey || file.id) === assetKey))
      return true
    if (!(isSearching.value ? searchPagination.hasMore : hasMore.value)) return !assetKey
    const count = currentFiles.value.length
    await handleLoadMore()
    if (
      currentFiles.value.length <= count &&
      (isSearching.value ? searchPagination.hasMore : hasMore.value)
    )
      return false
  }
  return false
}

// 当选中文件夹时，加载对应的资产数据和子文件夹
const loadCurrentFolderAssets = async () => {
  // 当前看的是收藏 / 回收站时，别拿文件夹内容去替换它。
  // 三十多处后台刷新（导入完成、同步推送、标签变更……）都无条件调这个函数，
  // 于是用户停在收藏页时，列表会被某个文件夹的内容整个换掉。
  // 选中树节点与选中快捷项在 store 里是互斥的，所以这里不会把用户困在快捷视图里。
  if (isShowingShortcutView.value) {
    if (isShowingFavorites.value) await handleFavoritesShortcut()
    else await handleDeletedShortcut()
    return
  }

  if (selectedKeys.value.length === 0) {
    beginListRequest()
    isSearching.value = false
    fileListLoading.value = false
    currentFiles.value = []
    resetPagination()
    return
  }

  // 如果有筛选条件，使用搜索接口来加载数据（保持筛选生效）
  if (hasActiveFilters.value) {
    isSearching.value = true
    searchPagination.current = 1
    await performSearchWithPagination(false)
    return
  }

  const selectedFolderKey = selectedKeys.value[0]
  const requestToken = beginListRequest()
  fileListLoading.value = true

  // 走浏览这条路时把搜索态清掉。不清的话：上一次带筛选进来置了 true，这次筛选清空了
  // 却没人复位，loadMore 会一直走搜索分支，而 resetPagination 刚把 hasMore 设成 false
  // —— 于是第二页往后静默加载不出来
  isSearching.value = false

  // 重置分页，避免旧数据闪烁
  resetPagination()

  console.log('加载资产，排序:', sortConfig.sortBy, sortConfig.sortOrder)
  try {
    await loadBrowsePage(selectedFolderKey, 1, false, requestToken)
  } catch (error) {
    if (isStaleListRequest(requestToken)) return
    console.error('加载资产数据失败:', error)
    message.error(t('assetManagement.load.assetsFailed'))
    currentFiles.value = []
    resetPagination()
  } finally {
    if (!isStaleListRequest(requestToken)) fileListLoading.value = false
  }
}

// 监听选中文件夹变化，加载对应资产
const originalHandleTreeSelect = handleTreeSelect
const enhancedHandleTreeSelect = async (selectedKeys: string[], info: any) => {
  // 处理百度云快捷方式：切换右侧视图为 Baiduyun
  if (info?.shortcut === 'baiduyun') {
    // 清空树形选中状态与当前路径
    originalHandleTreeSelect([], info)
    selectionStore.setShortcut('baiduyun')
    assetViewStore.setMode('baiduyun')
    return
  }

  // 处理 WebDAV 快捷方式：切换右侧视图为 Webdav
  if (info?.shortcut === 'webdav') {
    originalHandleTreeSelect([], info)
    selectionStore.setShortcut('webdav')
    assetViewStore.setMode('webdav')
    selectedAsset.value = null
    return
  }

  // 其他情况恢复为资产库视图
  assetViewStore.setMode('assets')

  // 处理收藏快捷方式
  if (info?.shortcut === 'favorites') {
    // 必须清空树选中：收藏不属于任何文件夹，留着上一个 folderKey 的话，
    // 「加载更多」会拿它去查那个文件夹的第 2 页，把别人的内容混进收藏列表
    originalHandleTreeSelect([], info)
    selectionStore.setShortcut('favorites')
    await handleFavoritesShortcut()
    return
  }

  // 处理最近删除快捷方式
  if (info?.shortcut === 'recent' || info?.shortcut === 'deleted') {
    originalHandleTreeSelect([], info)
    // 持久化快捷选择（统一使用 'recent' 作为键）
    selectionStore.setShortcut('recent')
    await handleDeletedShortcut()
    return
  }

  const selectedFolderKey = selectedKeys?.[0]
  if (info?.globalFolderSearch && selectedFolderKey) {
    selectedListFolder.value = null
    selectedAsset.value = null
    const success = await navigateToFolder(selectedFolderKey)
    if (!success) {
      await originalHandleTreeSelect(selectedKeys, info)
    }
    selectionStore.setTreeKey(selectedFolderKey)
    await loadCurrentFolderAssets()
    navStore.push(currentPath.value || '/', selectedKeys?.[0] || null)
    return
  }

  // 清空列表中的选择状态，确保详情面板显示当前树形选中的文件夹
  selectedListFolder.value = null
  selectedAsset.value = null

  // 先调用原始的选择处理逻辑
  originalHandleTreeSelect(selectedKeys, info)
  // 持久化树选择
  selectionStore.setTreeKey(selectedKeys?.[0] || null)

  // 然后加载对应的资产数据
  await loadCurrentFolderAssets()

  // 推入历史
  navStore.push(currentPath.value || '/', selectedKeys?.[0] || null)
}

// 恢复持久化的选择状态
const restoreSelectionFromStore = async (): Promise<boolean> => {
  try {
    // 快捷项优先恢复
    if (selectionStore.selectedShortcut) {
      const key = selectionStore.selectedShortcut
      if (assetTreeRef.value) {
        assetTreeRef.value.handleShortcutClick(key)
      }
      // 统一通过 enhancedHandleTreeSelect 处理，确保逻辑一致
      await enhancedHandleTreeSelect([], { selected: false, shortcut: key })
      return true
    }

    // 恢复树选中
    if (selectionStore.selectedTreeKey) {
      assetViewStore.ensureAssets()
      // 使用 navigateToFolder 确保完整路径链被正确展开和加载
      // 这会逐级加载父文件夹到 treeData，确保 currentPath 能正确解析
      const success = await navigateToFolder(selectionStore.selectedTreeKey)
      if (!success) {
        console.warn('[恢复选择] 无法导航到文件夹:', selectionStore.selectedTreeKey)
        // 导航失败时清空选择状态，避免状态不一致
        selectionStore.clear()
        return false
      }
      await loadCurrentFolderAssets()
      navStore.push(currentPath.value || '/', selectedKeys.value[0] || null)
      return true
    }
    return false
  } catch (e) {
    console.error('恢复选择状态失败:', e)
    return false
  }
}

// 处理收藏快捷方式点击
const handleFavoritesShortcut = async () => {
  const requestToken = beginListRequest()
  try {
    // 获取当前保管库信息
    if (!currentVault.value) {
      console.error('当前没有活跃的保管库')
      currentFiles.value = []
      return
    }

    fileListLoading.value = true

    /**
     * 资产走统一查询路径（criteria 里带 favoriteStatus: 'favorite'），筛选、排序、
     * 关键字这才在收藏里真的生效 —— 原来这里调的是 favoriteAPI，它只认「谁收藏了」，
     * 筛选栏改成什么样它都原样返回同一批。
     *
     * 文件夹仍走收藏接口：收藏的是文件夹，没有格式 / 大小 / 标签这些属性可筛。
     * 一旦用户提了资产级的要求，文件夹整批不显示，否则就是「筛完了还剩一堆无关的」。
     */
    const foldersRequest = hasAssetLevelQuery.value
      ? undefined
      : // 走数据源：服务器库的收藏记在本机，本地库的在保管库里
        getActiveLibrarySource().favorites.folders()

    const [favoriteAssets, favoriteFolders = []] = await Promise.all([
      searchAssetsWithCriteria(buildListCriteria({ scope: 'favorites' })),
      foldersRequest
    ])

    // 等待期间用户可能已经点去别的地方了
    if (isStaleListRequest(requestToken)) return

    // 转换收藏的文件夹为列表可识别的格式
    const folderItems = favoriteFolders.map((folder: any) => ({
      id: folder.folderKey || folder.id,
      name: folder.folderName || folder.name,
      type: 'folder' as const,
      path: folder.fullPath || folder.path || '',
      folderKey: folder.folderKey || folder.id,
      folderName: folder.folderName || folder.name,
      fatherKey: folder.fatherKey,
      size: 0,
      modifiedTime: folder.favorited_at || folder.modifiedTime || new Date().toISOString(),
      extension: '',
      // 标记为收藏文件夹，用于特殊处理（如独立显示）
      isFavoriteFolder: true
    }))

    // 合并：收藏文件夹排在前面，然后是收藏的资产
    const allFavorites = [...folderItems, ...favoriteAssets]

    updateFileList(allFavorites)
  } catch (error) {
    console.error('处理收藏快捷方式失败:', error)
    if (!isStaleListRequest(requestToken) && !isCancelledQuery(error)) {
      currentFiles.value = []
      resetPagination()
    }
  } finally {
    if (!isStaleListRequest(requestToken)) fileListLoading.value = false
  }
}

/** 回收站每页取多少条 */
const DELETED_PAGE_SIZE = 100

/** 网络库回收站接口的返回：新接口是 { list, total }，老接口直接给数组 */
interface DeletedAssetsPage {
  list: SearchedAssetRow[]
  total: number
}
interface DeletedAssetsEnvelope {
  success?: boolean
  error?: string
  data?: DeletedAssetsPage | SearchedAssetRow[]
}

/** 回收站里一次最多列多少个已删除文件夹（模型层本身也有 2000 条的兜底） */
const DELETED_FOLDER_LIMIT = 500

/**
 * 回收站里的文件夹条目。
 *
 * 形状跟着收藏视图里的收藏文件夹走 —— 右侧列表认的是 `type: 'folder'` 加
 * `folderKey`，认不出来就会当成资产渲染。`deletedAt` 是给界面显示「哪天删的」用的。
 */
const loadDeletedFolders = async (): Promise<Record<string, unknown>[]> => {
  try {
    const result = await assetFolderAPI.getDeleted(1, DELETED_FOLDER_LIMIT)
    const list = Array.isArray(result) ? result : (result?.list ?? [])
    return list.map((folder) => ({
      id: folder.folderKey,
      key: folder.folderKey,
      folderKey: folder.folderKey,
      name: folder.folderName,
      folderName: folder.folderName,
      type: 'folder' as const,
      path: folder.fullPath || '',
      fatherKey: folder.fatherKey,
      size: 0,
      extension: '',
      color: folder.color,
      img: folder.img,
      deletedAt: folder.deletedAt || folder.updated_at,
      modifiedTime: folder.deletedAt || folder.updated_at,
      isTrashFolder: true
    }))
  } catch (error) {
    console.error('读取回收站文件夹失败:', error)
    // 文件夹读不出来不该让整个回收站变成空白，资产那半边照常显示
    message.warning(t('assetManagement.recent.foldersLoadFailed'))
    return []
  }
}

// 处理最近删除快捷方式点击
const handleDeletedShortcut = async (isLoadMore = false) => {
  // 加载更多沿用当前请求的序号，首次进入才开新的
  const requestToken = isLoadMore ? browseListRequestToken : beginListRequest()
  try {
    if (!isLoadMore) {
      fileListLoading.value = true
      resetPagination()
      currentFiles.value = []
    } else {
      isLoadingMore.value = true
    }

    let newItems: SearchedAssetRow[] = []
    /** 本地库按「这一页装满了没有」判断还有没有下一页；网络库拿得到总数，按总数判断 */
    let morePages = false

    if (isHttpNetworkVault.value && currentVault.value?.id) {
      // 网络库的回收站在远端，那个接口不接收筛选条件 —— 筛选栏在这种库里是藏起来的
      const result = (await window.api.invoke(
        'networkVaultV2:getDeletedAssets',
        currentVault.value.id,
        currentPage.value,
        DELETED_PAGE_SIZE
      )) as DeletedAssetsEnvelope | DeletedAssetsPage | SearchedAssetRow[]

      let payload: DeletedAssetsPage | SearchedAssetRow[] | undefined
      if (!Array.isArray(result) && 'success' in result) {
        if (!result.success) throw new Error(result.error || '获取网络回收站失败')
        payload = result.data
      } else {
        payload = result as DeletedAssetsPage | SearchedAssetRow[]
      }

      let totalCount = 0
      if (Array.isArray(payload)) {
        // 兼容旧接口返回数组的情况
        newItems = payload
        totalCount = payload.length
      } else if (payload && Array.isArray(payload.list)) {
        newItems = payload.list
        totalCount = payload.total || 0
      }
      morePages = currentFiles.value.length + newItems.length < totalCount
    } else {
      /**
       * 本地库走统一查询（criteria 里带 deletedOnly），筛选、排序、关键字这才在
       * 回收站里真的生效 —— 原来这里调的是 getDeleted，它只认「删没删」，
       * 筛选栏改成什么样它都原样返回同一批。
       */
      newItems = await searchAssetsWithCriteria(
        buildListCriteria({
          scope: 'deleted',
          limit: DELETED_PAGE_SIZE,
          offset: (currentPage.value - 1) * DELETED_PAGE_SIZE
        })
      )
      morePages = newItems.length >= DELETED_PAGE_SIZE

      /**
       * 删掉的**文件夹**也要摆出来，而且摆在最前面。
       *
       * 以前这个视图只查资产：删一个文件夹，确认框写着「之后可以恢复」，
       * 回收站里却连它的影子都没有 —— 底层的 getDeleted / restore 一直都在，
       * 只是界面上没有任何地方调过它们。资产那边也只能一条条捞回来，
       * 捞回来还没有原来的目录。
       *
       * 文件夹不分页：模型层只返回「这一次删除的根」，数量是几十这个量级，
       * 和收藏视图里的收藏文件夹同一个处理方式。资产照旧翻页接在后面。
       */
      if (!isLoadMore && !hasAssetLevelQuery.value) {
        const deletedFolders = await loadDeletedFolders()
        if (deletedFolders.length > 0) {
          newItems = [...deletedFolders, ...newItems] as SearchedAssetRow[]
        }
      }
    }

    // 过滤7天内的删除资产 (可选，根据业务需求是否需要前端再次过滤)
    // 注意：如果后端已经做了分页，前端再过滤会导致每页数量不一致，甚至某些页为空
    // 建议后端 SQL 直接处理时间过滤，或者前端移除此过滤以展示所有回收站内容
    // 这里暂时移除前端过滤，以展示所有回收站内容，避免分页错乱

    // 按删除时间倒序排列 (后端通常已经排好序了，这里保险起见再排一次或者直接信任后端)
    // newItems.sort((a, b) => {
    //   const dateA = a.updated_at ? new Date(a.updated_at).getTime() : 0
    //   const dateB = b.updated_at ? new Date(b.updated_at).getTime() : 0
    //   return dateB - dateA
    // })

    // 慢查询在途时用户已经点去别处了 —— 这份结果不能再往界面上写
    if (isStaleListRequest(requestToken)) return

    if (isLoadMore) {
      currentFiles.value = [...currentFiles.value, ...newItems]
    } else {
      currentFiles.value = newItems
    }

    // 更新分页状态
    hasMore.value = morePages
    if (hasMore.value) {
      currentPage.value++
    }
  } catch (error) {
    console.error('处理最近删除快捷方式失败:', error)
    if (isStaleListRequest(requestToken) || isCancelledQuery(error)) return
    message.error(t('assetManagement.load.recentDeletedFailed'))
    if (!isLoadMore) {
      currentFiles.value = []
      resetPagination()
    }
  } finally {
    if (!isStaleListRequest(requestToken)) {
      fileListLoading.value = false
      isLoadingMore.value = false
    }
  }
}

// 清空最近删除的资产
const handleClearDeleted = async () => {
  try {
    if (isHttpNetworkVault.value) {
      message.warning(t('assetManagement.recent.clearNotSupported'))
      return
    }

    confirmDialog({
      title: t('assetManagement.recent.clearTitle'),
      content: t('assetManagement.recent.clearContent'),
      okText: t('assetManagement.recent.okText'),
      cancelText: t('assetManagement.recent.cancelText'),
      danger: true,
      async onOk() {
        try {
          fileListLoading.value = true
          /**
           * 先清文件夹再清资产。
           *
           * 文件夹那一趟会把整棵子树连同里面的资产一起物理清除（folderPurge：
           * 幸存者先改挂，再清连接表和磁盘文件）；剩下的才是「单独删掉的资产」，
           * 交给第二趟。以前这里只有第二趟 —— assetFolder 里 isDelete = 1 的行
           * 一条不动，永远堆在库里，磁盘上的目录也留着。
           */
          await assetFolderAPI.clearDeleted()
          await assetDataAPI.clearDeleted()
          message.success(t('assetManagement.recent.cleared'))
          // 清空之后文件夹树里可能少了东西，重新拉一遍
          await refreshFolderTreePreservingExpansion()
          // 重新加载删除列表
          await handleDeletedShortcut()
        } catch (error) {
          console.error('清空最近删除资产失败:', error)
          message.error(t('assetManagement.recent.clearFailed'))
        } finally {
          fileListLoading.value = false
        }
      }
    })
  } catch (error) {
    console.error('清空最近删除资产失败:', error)
  }
}

// 导入树状态管理器
import { saveTreeState, restoreTreeState } from './utils/tabStateManager'
import { createAssetChangeDebouncer } from './utils/assetChangeDebouncer'
import { log } from 'console'

// 获取路由实例（已在文件开头声明）
const router = useRouter()

// 监听路由变化，更新标签页 ID 并恢复/保存树状态
watch(
  () => route.query._tab_id,
  async (newTabId, oldTabId) => {
    if (route.name !== 'AssetManagement') return
    const currentTabId = (newTabId as string) || 'default'
    const previousTabId = (oldTabId as string) || 'default'

    // 保存旧标签页的树状态
    if (previousTabId !== currentTabId) {
      saveTreeState(treeStateKey(previousTabId), {
        selectedKeys: selectedKeys.value,
        expandedKeys: expandedKeys.value,
        currentPath: currentPath.value,
        treeData: treeData.value
      })
    }

    // 切换 store 状态
    assetViewStore.setTabId(currentTabId)
    if (isAssetPageActive.value) navStore.setTabId(currentTabId)
    selectionStore.setTabId?.(currentTabId)

    // 恢复新标签页的树状态
    const savedState = restoreTreeState(treeStateKey(currentTabId))
    if (savedState) {
      selectedKeys.value = savedState.selectedKeys
      expandedKeys.value = savedState.expandedKeys
      currentPath.value = savedState.currentPath

      // 🔧 修复：清理根级孤儿节点（同 onMounted 逻辑）
      const restoredTree = savedState.treeData || []
      const allNode = restoredTree.find((n: any) => n.key === 'ALL' || n.title === 'ALL')
      const orphans = restoredTree.filter((n: any) => n.key !== 'ALL' && n.title !== 'ALL')
      if (allNode && orphans.length > 0) {
        if (!allNode.children) allNode.children = []
        for (const orphan of orphans) {
          if (!allNode.children.some((c: any) => c.key === orphan.key)) {
            allNode.children.push(orphan)
          }
        }
        allNode.isLeaf = false
        treeData.value = [allNode]
      } else {
        treeData.value = restoredTree
      }
    } else {
      // 如果没有保存的状态，重置为默认值
      selectedKeys.value = []
      expandedKeys.value = []
      currentPath.value = '/'
      // treeData 保持当前值（因为可能需要重新加载）
    }
  },
  { immediate: true }
)

// 监听路由参数 folderKey，实现跳转
watch(
  () => route.query.folderKey,
  async (newFolderKey) => {
    if (newFolderKey && typeof newFolderKey === 'string') {
      console.log('检测到 folderKey 参数跳转:', newFolderKey)
      // 延迟一点执行，确保组件已挂载且数据已初始化
      await nextTick()
      const success = await navigateToFolder(newFolderKey)
      if (success) {
        // 清除 query 参数，避免刷新页面时重复跳转
        // router.replace({ query: { ...route.query, folderKey: undefined } })
        // 不清除也可以，保留状态
      } else {
        message.warning(t('assetManagement.folder.targetNotFound'))
      }
    }
  },
  { immediate: true }
)

// 监听刷新参数
watch(
  () => route.query.refresh,
  async (shouldRefresh) => {
    if (shouldRefresh === 'true') {
      console.log('[AssetManagement] 收到刷新请求，正在刷新数据...')
      // 刷新资产列表
      await loadCurrentFolderAssets()
      // 刷新文件夹树
      await loadRootFolders()
      await hydrateExpandedNodes()

      // 清除 URL 中的 refresh 参数，避免刷新页面时重复触发
      const query = { ...route.query }
      delete query.refresh
      delete query.t
      router.replace({ name: 'AssetManagement', query })
    }
  },
  { immediate: true }
)

// 监听树状态变化，自动保存
watch(
  [selectedKeys, expandedKeys, currentPath],
  () => {
    const tabId = (route.query._tab_id as string) || 'default'
    saveTreeState(treeStateKey(tabId), {
      selectedKeys: selectedKeys.value,
      expandedKeys: expandedKeys.value,
      currentPath: currentPath.value,
      treeData: treeData.value
    })
  },
  { deep: true }
)

// 侧键事件处理函数，按下侧边键时触发
// button === 3 表示"后退"键，button === 4 表示"前进"键
const handleSideMouseButtons = (e: MouseEvent) => {
  if (!isAssetPageActive.value || route.name !== 'AssetManagement') return
  if (isSwitchingVault.value || (e.button !== 3 && e.button !== 4)) return

  // 阻止默认行为，避免浏览器/标签切换
  e.preventDefault()
  e.stopPropagation()

  if (assetViewStore.isAssets) {
    if (e.button === 3) {
      void handleGoBack()
    } else {
      void handleGoForward()
    }
    return
  }

  // Baiduyun：侧键后退返回上级目录，前进键暂不处理
  if (assetViewStore.isBaiduyun) {
    if (e.button === 3) {
      const parts = (baiduyunStore.currentDir || '/').split('/').filter(Boolean)
      if (parts.length > 0) {
        parts.pop()
        const newPath = '/' + parts.join('/')
        baiduyunStore.setCurrentDir(newPath || '/')
      }
    }
    return
  }

  // WebDAV：侧键后退返回上级目录，前进键暂不处理
  if (assetViewStore.isWebdav) {
    if (e.button === 3) {
      const parts = (webdavStore.currentDir || '/').split('/').filter(Boolean)
      if (parts.length > 0) {
        parts.pop()
        const newPath = '/' + parts.join('/')
        webdavStore.setCurrentDir(newPath || '/')
      }
    }
    return
  }

  // 其他视图下忽略
}

/**
 * 处理 Spotlight 等全局入口触发的文件夹切换事件
 * 强制导航到指定文件夹并刷新文件列表
 *
 * 🔧 修复：新建文件夹后树形菜单未更新的问题
 * 导航前先刷新目标文件夹的父节点的子文件夹列表，确保新建的文件夹能正确显示在树中
 */
const handleAssetFolderChanged = async (event: Event): Promise<void> => {
  const customEvent = event as CustomEvent<{ folderKey: string | null }>
  const { folderKey } = customEvent.detail
  console.log('[AssetManagement] 收到文件夹切换事件:', folderKey)

  if (!folderKey) {
    return
  }

  try {
    // 🔧 修复：在导航前，先刷新目标文件夹父节点的子文件夹列表
    // 这样可以确保新建的文件夹能正确显示在树形菜单中
    const folderData = await assetFolderAPI.getByKey(folderKey)
    if (folderData?.fatherKey) {
      const parentNode = findNodeByKey(folderData.fatherKey)
      // 只有当父节点已经在树中时才刷新（可能已经展开过）
      if (parentNode) {
        console.log('[AssetManagement] 刷新父节点的子文件夹:', folderData.fatherKey)
        await refreshNodeChildren(folderData.fatherKey)
      }
    }
  } catch (err) {
    console.warn('[AssetManagement] 刷新父节点失败，继续导航:', err)
  }

  // 强制导航到指定文件夹
  const success = await navigateToFolderById(folderKey)
  if (success) {
    console.log('[AssetManagement] Spotlight 导航成功，文件列表已刷新')
  } else {
    console.warn('[AssetManagement] Spotlight 导航失败:', folderKey)
  }
}

const handleNetworkVaultAssetsSynced = async (): Promise<void> => {
  console.log('[AssetManagement] 收到局域网协作库同步完成事件，刷新树形菜单和资产列表')
  await vaultStore.refreshVaults()
  await refreshFolderTreePreservingExpansion()
  await loadCurrentFolderAssets()
}

// 防抖 500ms：批量变更时合并为一次刷新；文件夹变更跨窗口累计，见 assetChangeDebouncer
const assetChangeDebouncer = createAssetChangeDebouncer(async ({ touchedFolders }) => {
  console.log('[AssetManagement] 收到实时变更推送，刷新 UI，含文件夹变更:', touchedFolders)
  if (touchedFolders) {
    // 文件夹变更：刷新树
    await refreshFolderTreePreservingExpansion()
  }
  // 所有变更都刷新当前文件列表
  await loadCurrentFolderAssets()
})
const handleAssetChanged = (
  _event: any,
  payload: { source?: string; vaultId?: string; op?: string; tableName?: string }
): void => {
  // 只认这两个来源：V2 网络同步，和 agent 在主进程里直接改库（例如它删掉重复登记）。
  // 界面自己发起的操作不在其列 —— 那些就地刷新过了，再走一遍是重复刷新。
  if (payload?.source !== 'networkV2' && payload?.source !== 'agent') return
  // 仅处理当前 vault 的变更
  if (payload.vaultId && currentVault.value?.id && payload.vaultId !== currentVault.value.id) return

  assetChangeDebouncer.push(payload.tableName)
}

const handleTriggerNetworkVaultPullSync = async (): Promise<void> => {
  console.log('[AssetManagement] 收到自动拉取同步事件')
  if (isNetworkVault.value) {
    await handlePullSync()
  }
}

const handleTriggerNetworkSync = async (): Promise<void> => {
  console.log('[AssetManagement] 收到切换网络库自动同步事件')
  if (isNetworkVault.value) {
    await handleAutoNetworkSyncOnSwitch()
  }
}

const handleNavigateToAllFolder = async (): Promise<void> => {
  console.log('[AssetManagement] 收到导航到 ALL 文件夹事件')
  // 确保树数据已加载
  if (treeData.value.length === 0) {
    await loadRootFolders()
    await nextTick()
  }
  // 查找 ALL 文件夹并选中
  const allFolder = treeData.value.find((node) => node.title === 'ALL')
  if (allFolder) {
    selectedKeys.value = [allFolder.key]
    currentPath.value = allFolder.path
    // 清除快捷区域选中状态
    selectionStore.setTreeKey(allFolder.key)
    // 加载 ALL 文件夹的资产
    await loadCurrentFolderAssets()
    console.log('[AssetManagement] 已自动选择 ALL 文件夹:', allFolder.key)
  }
}

// 添加全局鼠标侧键监听器，实现资产库页面的历史导航控制
onMounted(async () => {
  // 先定下数据源：上次看的是服务器库，树和列表就从服务器库取
  await libraryStore.init()
  // 设置当前标签页 ID，用于状态隔离
  const tabId = (route.query._tab_id as string) || 'default'
  assetViewStore.setTabId(tabId)
  navStore.setTabId?.(tabId)
  selectionStore.setTabId?.(tabId)
  // 恢复树状态
  const savedState = restoreTreeState(treeStateKey(tabId))
  if (savedState) {
    selectedKeys.value = savedState.selectedKeys
    expandedKeys.value = savedState.expandedKeys
    currentPath.value = savedState.currentPath

    // 🔧 修复：清理旧 bug 导致的根级孤儿节点
    // 只有 ALL 应该出现在根级，非 ALL 节点应该是 ALL 的子级
    const restoredTree = savedState.treeData || []
    const allNode = restoredTree.find((n: any) => n.key === 'ALL' || n.title === 'ALL')
    const orphans = restoredTree.filter((n: any) => n.key !== 'ALL' && n.title !== 'ALL')
    if (allNode && orphans.length > 0) {
      // 将孤儿节点移到 ALL 下面
      if (!allNode.children) allNode.children = []
      for (const orphan of orphans) {
        const alreadyExists = allNode.children.some((c: any) => c.key === orphan.key)
        if (!alreadyExists) {
          allNode.children.push(orphan)
        }
      }
      allNode.isLeaf = false
      treeData.value = [allNode]
    } else {
      treeData.value = restoredTree
    }
  }

  // 监听 Spotlight 等全局入口触发的文件夹切换事件
  window.addEventListener('asset-folder:changed', handleAssetFolderChanged)

  // 监听局域网协作库同步完成事件，刷新资产列表和树形菜单
  window.addEventListener('network-vault-assets-synced', handleNetworkVaultAssetsSynced)

  // 监听 V2 网络库同步进度（分批同步时实时显示）
  networkSyncProgressHandler = window.api.on('networkVaultV2:syncProgress', ((payload: {
    vaultId: string
    phase: string
    /** 阶段代号，按它取双语文案；没有（老版本主进程）就退回 phase 原文 */
    phaseKey?: string
    current: number
    total: number
  }) => {
    if (payload.vaultId && currentVault.value?.id && payload.vaultId !== currentVault.value.id)
      return
    if (currentVault.value?.id && payload.total > 0) {
      const percent = Math.round((payload.current / payload.total) * 100)
      const phaseText = payload.phaseKey
        ? t(`assetManagement.sync.phase.${payload.phaseKey}`, {
            current: payload.current,
            total: payload.total
          })
        : payload.phase
      message.loading({
        content: `${phaseText}  ${percent}%`,
        key: getNetworkSyncMessageKey(payload.vaultId),
        duration: percent >= 100 ? 1.5 : 0
      })
    }
  }) as (...args: unknown[]) => void)

  // 监听 V2 网络库同步完成
  networkSyncCompleteHandler = window.api.on('networkVaultV2:syncComplete', (async (payload: {
    vaultId: string
    type: string
    assets?: number
    folders?: number
  }) => {
    message.destroy(getNetworkSyncMessageKey(payload.vaultId))
    if (payload.vaultId && currentVault.value?.id && payload.vaultId !== currentVault.value.id)
      return
    if (payload.type === 'full') {
      message.success({
        content: t('assetManagement.sync.doneContent', {
          assets: payload.assets ?? 0,
          folders: payload.folders ?? 0
        }),
        key: 'network-sync-done',
        duration: 3
      })
    }
    // 刷新 UI
    await vaultStore.refreshVaults()
    await refreshFolderTreePreservingExpansion()
    await loadCurrentFolderAssets()
  }) as (...args: unknown[]) => void)

  // 🔧 监听 V2 网络库状态变化 — 在 error / disconnected 时兜底清理进度通知
  // 场景：fullSync 最后一页 progress 100% 发出后，事务写入失败 → emit('status', 'error')
  //        此时 full-sync-done 不会被触发，loading 会永久挂住
  networkSyncStatusHandler = window.api.on('networkVaultV2:statusChange', ((payload: {
    vaultId: string
    status: string
  }) => {
    message.destroy(getNetworkSyncMessageKey(payload.vaultId))
    if (payload.vaultId && currentVault.value?.id && payload.vaultId !== currentVault.value.id)
      return
    console.log(`[AssetManagement] V2 状态变化: ${payload.status} (vault: ${payload.vaultId})`)
    if (payload.status === 'permissionChanged') {
      void checkNetworkVaultWritePermission()
      return
    }
    // 访问码缺失/不对：说清楚该干什么。落到下面的「同步失败」里，
    // 用户只会看到一句猜不出所以然的话，然后对着退避重试干等
    if (payload.status === 'authRequired' || payload.status === 'authInvalid') {
      message.error({
        content: t(`networkVaultAccess.${payload.status}`),
        key: 'network-sync-auth',
        duration: 8
      })
      return
    }
    if (payload.status === 'error' || payload.status === 'disconnected') {
      if (payload.status === 'error') {
        message.error({
          content: t('assetManagement.sync.failedContent'),
          key: 'network-sync-error',
          duration: 5
        })
      }
    }
  }) as (...args: unknown[]) => void)

  // 🔧 监听 V2 网络库实时变更事件（WebSocket 推送）
  // 当其他用户创建/修改/删除文件夹或资产时，SyncClient 已写入本地 DB，
  // 此处刷新 UI 使变更对当前用户立即可见，无需手动"拉取同步"
  window.electron.ipcRenderer.on('asset:changed', handleAssetChanged)

  // 🔧 监听创建网络库后自动触发拉取同步的事件
  window.addEventListener('trigger-network-vault-pull-sync', handleTriggerNetworkVaultPullSync)

  // 🔧 监听切换网络库时触发增量扫描的事件
  window.addEventListener('trigger-network-sync', handleTriggerNetworkSync)

  // 监听创建资产库后导航到 ALL 文件夹的事件
  window.addEventListener('navigate-to-all-folder', handleNavigateToAllFolder)

  // 使用 requestIdleCallback 在浏览器空闲时加载，提升首屏加载速度
  if (!treeData.value || treeData.value.length === 0) {
    // 定义加载并水合的函数
    const loadAndHydrate = async (): Promise<void> => {
      await loadRootFolders()
      // 水合已展开节点的子数据（刷新页面后 expandedKeys 可能被恢复，但子节点数据未加载）
      if (expandedKeys.value.length > 0) {
        await hydrateExpandedNodes()
      }
    }

    // 使用 requestIdleCallback 或 setTimeout 延迟加载
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(
        () => {
          void loadAndHydrate()
        },
        { timeout: 100 }
      )
    } else {
      // 降级方案：使用 setTimeout
      setTimeout(() => {
        void loadAndHydrate()
      }, 50)
    }
  } else if (expandedKeys.value.length > 0) {
    // 如果 treeData 已存在但有展开的节点，确保子数据已加载
    void hydrateExpandedNodes()
  }

  // 检查路由参数中是否有 folderKey，如果有则导航到该文件夹
  if (route.query.folderKey && typeof route.query.folderKey === 'string') {
    const folderKey = route.query.folderKey
    const assetKey =
      route.query.assetKey && typeof route.query.assetKey === 'string'
        ? route.query.assetKey
        : undefined
    console.log('[资产定位] 从路由参数获取到 folderKey:', folderKey)
    if (assetKey) {
      console.log('[资产定位] 同时获取到 assetKey，导航后将选中资产:', assetKey)
    }
    const success = await navigateToFolderById(folderKey)
    if (success) {
      console.log('[资产定位] 导航成功')
      // 原来这里是 setTimeout(…, 200) 猜一个「DOM 应该渲染完了」的延时，
      // 机器慢一点就选不中。revealAsset 本身会等文件加载完再滚再点亮，
      // 直接 await 它，和右键「跳转到所在目录」走同一条路
      if (assetKey) {
        await nextTick()
        await selectAssetInCurrentFolder(assetKey)
      }
      // 不再清除路由参数，避免创建新的tab
      // 保留query参数不会影响功能，且方便用户刷新页面时保持状态
      // router.replace({ name: 'AssetManagement' })
      return
    } else {
      console.warn('[资产定位] 导航到指定文件夹失败，继续正常初始化流程')
    }
  }

  // 检查路由参数中是否有 path，如果有则解析为 folderKey 并导航
  if (route.query.path && typeof route.query.path === 'string') {
    const path = route.query.path
    console.log('从路由参数获取到 path，准备导航:', path)
    const folderKey = await resolveFolderKeyByPath(path)
    if (folderKey) {
      const success = await navigateToFolderById(folderKey)
      if (success) {
        router.replace({ name: 'AssetManagement' })
        return
      }
    } else {
      console.warn('无法解析路径为 folderKey:', path)
      message.error(t('assetManagement.folder.locateFailed'))
    }
  }

  // 优先恢复持久化选择；若无则自动选中顶级菜单
  const restored = await restoreSelectionFromStore()
  if (!restored) {
    await autoSelectTopMenu()
  }
})

// 组件卸载时移除监听，防止内存泄漏或影响其他页面
onUnmounted(() => {
  if (currentVault.value?.id) {
    message.destroy(getNetworkSyncMessageKey(currentVault.value.id))
  }
  if (networkSyncProgressHandler) {
    window.api.off('networkVaultV2:syncProgress', networkSyncProgressHandler)
    networkSyncProgressHandler = null
  }
  if (networkSyncCompleteHandler) {
    window.api.off('networkVaultV2:syncComplete', networkSyncCompleteHandler)
    networkSyncCompleteHandler = null
  }
  if (networkSyncStatusHandler) {
    window.api.off('networkVaultV2:statusChange', networkSyncStatusHandler)
    networkSyncStatusHandler = null
  }
  // 保存当前标签页的树状态
  const tabId = (route.query._tab_id as string) || 'default'
  saveTreeState(treeStateKey(tabId), {
    selectedKeys: selectedKeys.value,
    expandedKeys: expandedKeys.value,
    currentPath: currentPath.value,
    treeData: treeData.value
  })

  // 移除 Spotlight 文件夹切换事件监听
  window.removeEventListener('asset-folder:changed', handleAssetFolderChanged)
  window.removeEventListener('network-vault-assets-synced', handleNetworkVaultAssetsSynced)
  window.removeEventListener('trigger-network-vault-pull-sync', handleTriggerNetworkVaultPullSync)
  window.removeEventListener('trigger-network-sync', handleTriggerNetworkSync)
  window.removeEventListener('navigate-to-all-folder', handleNavigateToAllFolder)
  removeIpcListener('asset:changed', handleAssetChanged)
  assetChangeDebouncer.cancel()

  // 清理拖拽监听器
  if (isResizing.value) {
    document.removeEventListener('mousemove', handleResizeMove)
    document.removeEventListener('mouseup', handleResizeEnd)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
})

/**
 * 自动选中顶级菜单的逻辑
 * 如果没有持久化的选择状态，默认选中 ALL 文件夹
 */
const autoSelectTopMenu = async () => {
  // 如果已经有选中的文件夹或快捷目录，则不进行自动选中
  if (selectedKeys.value.length > 0) {
    return
  }

  // 如果树形数据还未加载，先等待加载完成
  if (!treeData.value || treeData.value.length === 0) {
    await loadRootFolders()
  }

  // 等待树形数据加载完成后选中第一个顶级文件夹（通常是 ALL）
  if (treeData.value.length > 0) {
    // 选中第一个顶级文件夹
    const firstFolder = treeData.value[0]
    if (firstFolder) {
      // 使用 originalHandleTreeSelect 来正确设置 selectedKeys 和 currentPath
      // 这样面包屑会正确显示路径（如"默认保管库 / ALL"）
      await originalHandleTreeSelect([firstFolder.key], {})

      // 展开第一个文件夹
      if (!expandedKeys.value.includes(firstFolder.key)) {
        expandedKeys.value.push(firstFolder.key)
      }

      // 触发展开事件，加载子文件夹数据
      await nextTick()
      const expandInfo = {
        expanded: true,
        node: {
          key: firstFolder.key,
          title: firstFolder.title
        }
      }
      await handleTreeExpand(expandedKeys.value, expandInfo)

      // 加载对应的资产数据
      await loadCurrentFolderAssets()

      // 推入历史
      navStore.push(currentPath.value || '/', selectedKeys.value[0] || null)
      return
    }
  }

  // 如果没有文件夹可选中，则选中第一个快捷目录
  if (assetTreeRef.value) {
    // 选中"最近使用"快捷目录
    assetTreeRef.value.handleShortcutClick('recent')
  }
}

// 处理添加资产
const handleAddAsset = async (folderKey: string, assetName: string) => {
  try {
    // 生成唯一的assetKey
    const assetKey = `${folderKey}_${assetName}_${Date.now()}`
    await assetDataAPI.create({
      assetKey,
      folderKey,
      assetName
    })
    message.success(t('assetLib.import.addSuccess'))
    await loadCurrentFolderAssets()
  } catch (error) {
    console.error('添加资产失败:', error)
    message.error(resolveErrorText(error, t('assetLib.import.addFailed')))
    throw error
  }
}

// 处理删除资产
const handleDeleteAsset = async (assetKey: string) => {
  try {
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    if (isNetworkVault && currentVault.value?.id) {
      const result = await window.api.invoke(
        'networkVaultV2:deleteAsset',
        currentVault.value.id,
        assetKey
      )
      if (!result.success) {
        throw new Error(result.error || '删除网络资产失败')
      }
      // 乐观更新：立即从当前列表移除，避免 client 角色本地 DB 未同步时 reload 出脏数据
      currentFiles.value = currentFiles.value.filter(
        (f: any) => !(f.type !== 'folder' && (f.assetKey === assetKey || f.id === assetKey))
      )
    } else {
      await assetDataAPI.delete(assetKey)
      // 本地库直接 reload（DB 已同步更新）
      await loadCurrentFolderAssets()
    }
    message.success(t('assetManagement.delete.assetSuccess'))
  } catch (error) {
    console.error('删除资产失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.delete.assetFailed')))
    throw error
  }
}

// 处理重命名资产
const handleRenameAsset = async (assetKey: string, newName: string) => {
  try {
    await assetDataAPI.update(assetKey, { assetName: newName })
    // message.success('资产重命名成功')
    await loadCurrentFolderAssets()
  } catch (error) {
    console.error('重命名资产失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.rename.assetFailed')))
    throw error
  }
}

// 辅助函数：查找节点的完整路径（包含节点对象）
const findPathToNode = (nodes: any[], targetKey: string, currentPath: any[] = []): any[] | null => {
  for (const node of nodes) {
    const newPath = [...currentPath, node]
    if (node.key === targetKey) {
      return newPath
    }
    if (node.children) {
      const found = findPathToNode(node.children, targetKey, newPath)
      if (found) return found
    }
  }
  return null
}

// 面包屑导航
const breadcrumbItems = computed(() => {
  const items: Array<{ name: string; path: string; key?: string; isVault?: boolean }> = []

  // 首先添加当前资产库（服务器库时是服务器库的名字）
  if (libraryStore.activeServer) {
    items.push({ name: libraryStore.activeServer.name, path: 'vault', isVault: true })
  } else if (currentVault.value) {
    items.push({
      name:
        currentVault.value.isSystem && currentVault.value.systemKey === 'default'
          ? t('assetLib.vault.default')
          : currentVault.value.name || t('assetLib.vault.unnamed'),
      path: 'vault',
      isVault: true
    })
  }

  // 尝试从树结构中构建精确的面包屑（包含 key，解决同名文件夹问题）
  let builtFromTree = false
  if (selectedKeys.value.length > 0) {
    const nodePath = findPathToNode(treeData.value, selectedKeys.value[0])
    if (nodePath) {
      nodePath.forEach((node) => {
        items.push({
          name: node.title,
          path: node.path,
          key: node.key // 关键：携带唯一标识符
        })
      })
      builtFromTree = true
    }
  }

  // 如果树中未找到（例如未加载或搜索视图），回退到路径解析
  if (!builtFromTree) {
    if (!currentPath.value || currentPath.value === '/') {
      // items.push({ name: '根目录', path: '/' })
    } else {
      const paths = currentPath.value.split('/').filter(Boolean)
      // items.push({ name: '根目录', path: '/' })

      let currentPathStr = ''
      paths.forEach((path) => {
        currentPathStr += `/${path}`
        items.push({ name: path, path: currentPathStr })
      })
    }
  }

  return items
})

/**
 * 面包屑容器 ref，用于 ResizeObserver 监测宽度变化
 */
const breadcrumbBarRef = ref<HTMLDivElement | null>(null)

/**
 * 面包屑容器当前可用宽度
 */
const breadcrumbBarWidth = ref(0)

/**
 * Windows 风格的折叠面包屑显示数据
 * - first: 首项（资产库名称，始终显示）
 * - collapsed: 被折叠到 ... 下拉菜单的中间项
 * - visible: 可见的中间项
 * - last: 最后一项（当前目录，始终显示）
 */
const displayBreadcrumbItems = computed(() => {
  const items = breadcrumbItems.value
  const result: {
    first: { name: string; path: string; key?: string; isVault?: boolean } | null
    collapsed: Array<{ name: string; path: string; key?: string }>
    visible: Array<{ name: string; path: string; key?: string }>
    last: { name: string; path: string; key?: string } | null
  } = {
    first: null,
    collapsed: [],
    visible: [],
    last: null
  }

  if (items.length === 0) return result

  // 第一项：资产库（isVault）
  if (items[0]?.isVault) {
    result.first = items[0]
  }

  // 分离其余项目
  const pathItems = items.filter((item) => !item.isVault)
  if (pathItems.length === 0) return result

  // 最后一项：当前目录
  result.last = pathItems[pathItems.length - 1]

  // 中间项
  const middleItems = pathItems.slice(0, -1)
  if (middleItems.length === 0) return result

  // 根据容器宽度决定折叠策略
  // 估算每个路径项大约占用的像素（中文约 14px/字，分隔符约 20px）
  const containerWidth = breadcrumbBarWidth.value || 400
  // 预留首项、末项、搜索框等占用的空间
  const reservedWidth = 180 // 首项约60px + 末项约80px + ... 按钮约40px
  const availableWidth = Math.max(containerWidth - reservedWidth, 100)

  // 计算每个中间项大约需要的宽度
  const itemWidths = middleItems.map((item) => item.name.length * 14 + 20)
  const totalWidth = itemWidths.reduce((sum, w) => sum + w, 0)

  if (totalWidth <= availableWidth) {
    // 空间足够，全部显示
    result.visible = middleItems
  } else {
    // 空间不足，折叠中间部分
    // 策略：保留最后一个中间项可见，其余折叠
    // 如果只有一个中间项，则显示 ... 让用户可以点击
    if (middleItems.length === 1) {
      result.collapsed = middleItems
    } else {
      // 从前向后折叠，只保留最后一个中间项可见
      result.collapsed = middleItems.slice(0, -1)
      result.visible = middleItems.slice(-1)
    }
  }

  return result
})

/**
 * 处理折叠菜单项点击
 */
const handleCollapsedMenuClick = ({ key }: { key: string | number }) => {
  const items = displayBreadcrumbItems.value.collapsed
  const item = items[Number(key)]
  if (item) {
    handleBreadcrumbClick(item)
  }
}

/**
 * ResizeObserver 实例
 */
let breadcrumbResizeObserver: ResizeObserver | null = null

/**
 * 初始化面包屑容器宽度监听
 */
const initBreadcrumbResizeObserver = () => {
  if (!breadcrumbBarRef.value) return

  breadcrumbResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      breadcrumbBarWidth.value = entry.contentRect.width
    }
  })
  breadcrumbResizeObserver.observe(breadcrumbBarRef.value)
  // 立即读取一次初始宽度
  breadcrumbBarWidth.value = breadcrumbBarRef.value.offsetWidth
}

/**
 * 清理面包屑容器宽度监听
 */
const cleanupBreadcrumbResizeObserver = () => {
  if (breadcrumbResizeObserver) {
    breadcrumbResizeObserver.disconnect()
    breadcrumbResizeObserver = null
  }
}

// 在 onMounted 中初始化 ResizeObserver
watch(
  () => breadcrumbBarRef.value,
  (newRef) => {
    if (newRef) {
      initBreadcrumbResizeObserver()
    } else {
      cleanupBreadcrumbResizeObserver()
    }
  },
  { immediate: true }
)

// 提供上下文
const assetContext: AssetContext = {
  addFolder: handleAddFolder,
  deleteFolder: handleDeleteFolder,
  renameFolder: handleRenameFolder,
  addAsset: handleAddAsset,
  deleteAsset: handleDeleteAsset,
  renameAsset: handleRenameAsset,
  navigateToFolder: navigateToFolderById,
  refreshCurrentFolder: async () => {
    // 🔧 修复：如果当前是搜索状态，重新执行搜索而不是加载文件夹
    if (isSearching.value) {
      searchPagination.current = 1
      await performSearchWithPagination(false)
    } else {
      await loadCurrentFolderAssets()
    }
  },
  refreshTree: async () => {
    await refreshFolderTreePreservingExpansion()
  },
  refreshTreeForMove: async (sourceFolderKey, targetFolderKey, movedItems) => {
    try {
      // 仅处理文件夹项的树变更
      const movedFolderKeys = (movedItems || [])
        .filter((it) => it.type === 'folder')
        .map((it) => it.id)

      // 文件移动不影响树结构，避免刷新以保留已加载的子数据
      if (movedFolderKeys.length === 0) {
        return
      }

      // 同父级移动无需处理
      if (sourceFolderKey && sourceFolderKey === targetFolderKey) {
        return
      }

      // 确保目标节点存在于树中
      let targetNode = findNodeByKey(targetFolderKey)
      if (!targetNode) {
        await ensureNodeExists(targetFolderKey, null)
        targetNode = findNodeByKey(targetFolderKey)
      }
      if (!targetNode) {
        console.warn('目标文件夹在树中不存在，跳过刷新:', targetFolderKey)
        return
      }

      for (const movedKey of movedFolderKeys) {
        // 1) 在 out.children 中删除被移动的文件夹，并保存节点对象以便插入到 in
        let movedNode: any = null
        if (sourceFolderKey) {
          const outNode = findNodeByKey(sourceFolderKey)
          if (outNode && outNode.children && outNode.children.length > 0) {
            const idx = outNode.children.findIndex((c: any) => c.key === movedKey)
            if (idx >= 0) {
              movedNode = outNode.children.splice(idx, 1)[0]
            }
          }
        }

        // 若未能从 out 中找到节点，则尝试在树里全局查找（可能此前未加载到父节点children）
        if (!movedNode) {
          const globalNode = findNodeByKey(movedKey)
          if (globalNode) {
            movedNode = { ...globalNode }
          } else {
            // 回退：确保节点存在并添加到目标父级
            await ensureNodeExists(movedKey, targetFolderKey)
            continue
          }
        }

        // 更新 movedNode 的 path 指向新父级
        const targetPath = targetNode.path || '/'
        const title = movedNode.title || ''
        movedNode.path = `${targetPath}/${title}`.replace(/\/+/, '/')

        // 直接追加到目标 children，避免任何重新加载以保留现有子数据
        if (!targetNode.children) targetNode.children = []
        const exists = targetNode.children.some((c: any) => c.key === movedKey)
        if (!exists) {
          targetNode.children.push(movedNode)
        }
      }

      // 更新源文件夹的 isLeaf 状态
      if (sourceFolderKey) {
        const outNode = findNodeByKey(sourceFolderKey)
        if (outNode) {
          // 只有当 children 为空数组时才标记为叶子节点
          // 注意：如果 children 为 undefined/null，可能是未加载，不应强制设为叶子
          if (outNode.children && outNode.children.length === 0) {
            outNode.isLeaf = true
          }
        }
      }

      // 更新目标文件夹的 isLeaf 状态
      if (targetNode) {
        targetNode.isLeaf = false
      }
    } catch (error) {
      console.error('刷新树节点失败:', error)
    }
  },
  updateTreeNodeColor: (nodeKey: string, color: string | null) => {
    return updateNodeColor(nodeKey, color)
  },
  removeTreeNodes: (folderKeys: string[]) => {
    // 从树中递归移除指定节点，并返回其父节点key
    const removeNodeByKey = (
      nodes: typeof treeData.value,
      key: string
    ): { removed: boolean; parentKey?: string } => {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].key === key) {
          nodes.splice(i, 1)
          return { removed: true }
        }
        if (nodes[i].children && nodes[i].children!.length > 0) {
          const res = removeNodeByKey(nodes[i].children!, key)
          if (res.removed) {
            return { removed: true, parentKey: nodes[i].key }
          }
        }
      }
      return { removed: false }
    }

    for (const key of folderKeys) {
      const { parentKey } = removeNodeByKey(treeData.value, key)
      // 如果删除后父节点没有子文件夹了，更新 isLeaf 状态
      if (parentKey) {
        const parentNode = findNodeByKey(parentKey)
        if (parentNode && (!parentNode.children || parentNode.children.length === 0)) {
          parentNode.isLeaf = true
        }
      }
    }

    // 强制触发响应式更新
    treeData.value = [...treeData.value]
  },
  removeFiles: (keys: string[]) => {
    const keySet = new Set(keys)
    currentFiles.value = currentFiles.value.filter(
      (f: any) => !keySet.has(f.assetKey) && !keySet.has(f.id) && !keySet.has(f.folderKey)
    )
  }
}

provide(AssetContextKey, assetContext)

// 全局拖拽提示覆盖层状态
const dragOverlayVisible = ref(false)
const dragOverlayText = ref('')
const dragOverlayCounts = ref<{ files: number; folders: number }>({ files: 0, folders: 0 })
const baseDragOverlayText = ref('')
// 当前左侧树的高亮目标元素（用于移入效果）
const currentDropTargetEl = ref<HTMLElement | null>(null)

// 获取当前鼠标下的目标文件夹名称（左侧树或右侧文件夹）
type HoverTarget = { name: string; key: string; isTree: boolean } | null

const getHoverTarget = (x: number, y: number): HoverTarget => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return null
  // 右侧文件列表的文件夹项
  const rightFolderItem = el.closest('.file-item.folder-item') as HTMLElement | null
  if (rightFolderItem) {
    const nameEl = rightFolderItem.querySelector('.file-name') as HTMLElement | null
    const key = rightFolderItem.getAttribute('data-file-id') || ''
    const name = (nameEl?.textContent || '').trim()
    if (key) return { name, key, isTree: false }
  }
  // 左侧树节点
  const treeNodeWrapper = el.closest('.ant-tree-node-content-wrapper') as HTMLElement | null
  const treeNode = treeNodeWrapper || (el.closest('.ant-tree-treenode') as HTMLElement | null)
  if (treeNode) {
    const titleEl = treeNode.querySelector('.tree-node-title') as HTMLElement | null
    const textEl = treeNode.querySelector('.tree-node-title .tree-node-text') as HTMLElement | null
    const key = titleEl?.getAttribute('data-folder-key') || ''
    const name = (textEl?.textContent || '').trim()
    if (key) return { name, key, isTree: true }
  }
  return null
}

// 当覆盖层显示时，监听全局 mouseup/mousemove 以动态更新与关闭
const handleGlobalMouseUp = async (e: MouseEvent) => {
  if (!dragOverlayVisible.value) return
  const target = getHoverTarget(e.clientX, e.clientY)
  // 仅在左侧树上执行跨面板移动；右侧列表的移动由子组件处理
  if (target && target.isTree) {
    const dropId = target.key
    // 禁止移入自身
    if (dragOverlayItems.value.some((it) => it.id === dropId)) {
      message.warning(t('assetManagement.move.cannotMoveIntoSelf'))
      // 清理左树高亮
      if (currentDropTargetEl.value) {
        currentDropTargetEl.value.classList.remove('drop-target')
        currentDropTargetEl.value = null
      }
      dragOverlayVisible.value = false
      return
    }
    try {
      // 通过新数组确保传入 IPC 的数据可被结构化克隆
      const ipcItems = dragOverlayItems.value.map((it) => ({ id: String(it.id), type: it.type }))
      const resp = await (window as any).api.dragMove.moveItems(ipcItems, dropId)
      if (resp?.success && resp.data?.success) {
        message.success(
          t('assetManagement.move.success', {
            folders: resp.data.movedItems.folders,
            files: resp.data.movedItems.files
          })
        )
        const sourceKey = selectedKeys.value.length > 0 ? selectedKeys.value[0] : undefined
        await assetContext.refreshTreeForMove(sourceKey, dropId, ipcItems)
        await assetContext.refreshCurrentFolder()
        assetFileListRef.value?.clearSelection?.()
      } else {
        const msg = resp?.data?.message || resp?.error || t('assetManagement.move.failed')
        message.error(msg)
      }
    } catch (err) {
      message.error(t('assetManagement.move.exception', { error: String(err) }))
    }
  }
  // 清理左树高亮
  if (currentDropTargetEl.value) {
    currentDropTargetEl.value.classList.remove('drop-target')
    currentDropTargetEl.value = null
  }
  dragOverlayVisible.value = false
}
const handleGlobalMouseMove = (e: MouseEvent) => {
  if (!dragOverlayVisible.value) return
  const target = getHoverTarget(e.clientX, e.clientY)
  if (target) {
    // 动态提示文案（优化为移动到「目标文件夹」并统一数量格式）
    dragOverlayText.value = t('assetManagement.move.overlayText', {
      name: target.name,
      files: dragOverlayCounts.value.files,
      folders: dragOverlayCounts.value.folders
    })
  } else {
    // 未悬浮到文件夹时恢复基础文案（统一为斜杠分隔）
    dragOverlayText.value =
      baseDragOverlayText.value ||
      t('assetManagement.move.dragOverlayText', {
        files: dragOverlayCounts.value.files,
        folders: dragOverlayCounts.value.folders
      })
  }
  // 左侧树移入高亮效果：给命中节点的内容包装器添加 drop-target 类
  const elUnder = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const wrapper = elUnder?.closest('.ant-tree-node-content-wrapper') as HTMLElement | null
  if (target && target.isTree && wrapper) {
    if (currentDropTargetEl.value && currentDropTargetEl.value !== wrapper) {
      currentDropTargetEl.value.classList.remove('drop-target')
    }
    wrapper.classList.add('drop-target')
    currentDropTargetEl.value = wrapper
  } else {
    if (currentDropTargetEl.value) {
      currentDropTargetEl.value.classList.remove('drop-target')
      currentDropTargetEl.value = null
    }
  }
}

watch(dragOverlayVisible, (v) => {
  if (v) {
    window.addEventListener('mouseup', handleGlobalMouseUp)
    window.addEventListener('mousemove', handleGlobalMouseMove)
  } else {
    window.removeEventListener('mouseup', handleGlobalMouseUp)
    window.removeEventListener('mousemove', handleGlobalMouseMove)
  }
})

// 提示开始/结束事件处理（来自 AssetFileList）
const dragOverlayItems = ref<Array<{ id: string; type: 'file' | 'folder' }>>([])
const assetFileListRef = ref<any | null>(null)

const onDragOverlayStart = (payload: {
  text: string
  counts?: { files: number; folders: number }
  items?: Array<{ id: string; type: 'file' | 'folder' }>
}) => {
  baseDragOverlayText.value = payload?.text || ''
  dragOverlayText.value = baseDragOverlayText.value
  if (payload?.counts) {
    dragOverlayCounts.value = { files: payload.counts.files, folders: payload.counts.folders }
  }
  dragOverlayItems.value = payload?.items || []
  dragOverlayVisible.value = true
}
const onDragOverlayEnd = (): void => {
  dragOverlayVisible.value = false
}

// ========== 百度网盘拖拽到资产树节点时显示 DragOverlay ==========

/**
 * 百度网盘文件拖拽进入资产树节点时的处理
 * @param payload 包含目标节点信息
 */
const handleBaiduyunDragEnter = (payload: {
  targetKey: string
  targetTitle: string
  itemCount: number
}): void => {
  dragOverlayText.value = t('assetManagement.download.overlayText', { name: payload.targetTitle })
  dragOverlayVisible.value = true
}

/**
 * 百度网盘文件拖拽离开资产树节点时的处理
 */
const handleBaiduyunDragLeave = (): void => {
  dragOverlayVisible.value = false
}

const isDragOver = ref(false)
const dragLeaveTimer = ref<NodeJS.Timeout | null>(null)

// 拖拽事件处理
const handleDragEnter = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()

  // 仅在本地资产模式下显示拖拽遮罩
  if (assetViewStore.mode !== 'assets') {
    return
  }

  // 清除之前的离开定时器
  if (dragLeaveTimer.value) {
    clearTimeout(dragLeaveTimer.value)
    dragLeaveTimer.value = null
  }

  // 检查是否有文件被拖拽
  if (e.dataTransfer?.types.includes('Files')) {
    isDragOver.value = true
  }
}

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()

  // 仅在本地资产模式下处理拖拽
  if (assetViewStore.mode !== 'assets') {
    return
  }

  // 确保拖拽效果正确
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }

  // 确保遮罩保持显示状态
  if (e.dataTransfer?.types.includes('Files') && !isDragOver.value) {
    isDragOver.value = true
  }
}

const handleDragLeave = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()

  // 检查是否真的离开了容器区域
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY

  // 如果鼠标还在容器内，不关闭遮罩
  if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
    return
  }

  // 使用定时器延迟关闭遮罩，避免在子元素间移动时频繁触发
  if (dragLeaveTimer.value) {
    clearTimeout(dragLeaveTimer.value)
  }

  dragLeaveTimer.value = setTimeout(() => {
    isDragOver.value = false
    dragLeaveTimer.value = null
  }, 150) // 增加延迟时间到150ms
}

const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()

  // 清除定时器并立即关闭遮罩
  if (dragLeaveTimer.value) {
    clearTimeout(dragLeaveTimer.value)
    dragLeaveTimer.value = null
  }
  isDragOver.value = false

  // 仅在本地资产模式下处理拖拽导入，百度网盘/WebDAV等模式不处理
  if (assetViewStore.mode !== 'assets') {
    return
  }

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) {
    // message.warning('没有检测到有效的文件或文件夹')
    return
  }

  try {
    const filePaths: string[] = []
    // 拿不到本地路径、但自带真实字节数据的图片文件（典型来源：从网页拖拽图片）
    const pathlessImageFiles: File[] = []

    // 使用 webUtils.getPathForFile 获取真实文件路径
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const filePath = await window.api.getPathForFile(file)
        if (filePath) {
          filePaths.push(filePath)
        } else if (file.type.startsWith('image/') && file.size > 0) {
          pathlessImageFiles.push(file)
        }
      } catch (error) {
        console.error('获取文件路径失败:', error)
        if (file.type.startsWith('image/') && file.size > 0) {
          pathlessImageFiles.push(file)
        }
      }
    }

    if (filePaths.length === 0 && pathlessImageFiles.length === 0) {
      message.error(t('assetManagement.download.pathFailed'))
      return
    }

    if (pathlessImageFiles.length > 0) {
      await handleWebImageCapture(pathlessImageFiles)
    }

    if (filePaths.length === 0) {
      return
    }

    // 压缩包里拖出来的东西不是磁盘上的文件，必须在这里挡掉：
    // 要么是包内的相对名（stat 会拿它去拼进程工作目录，报一条谁也看不懂的 ENOENT），
    // 要么是解压软件的临时目录（能导进来，然后随临时目录一起消失，留一批死条目）。
    const { accepted, rejected } = await filterDroppedPaths(filePaths)
    for (const line of describeRejectedDrops(rejected)) {
      message.warning(t(line.key, line.params))
    }
    if (accepted.length === 0) {
      return
    }
    filePaths.length = 0
    filePaths.push(...accepted)

    console.log('拖拽的文件路径:', filePaths)

    if (
      isHttpServerVault.value &&
      (await handleImportRecoveryReportPaths(filePaths, { strict: false }))
    ) {
      return
    }

    // 处理拖拽导入
    await handleDragImport(filePaths)
  } catch (error) {
    console.error('处理拖拽文件失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.download.dragProcessFailed')))
  }
}

// ALL文件夹常量
const ALL_FOLDER = 'ALL'

// 处理网页快速采集：拖拽自网页、拿不到本地路径但自带字节数据的图片文件
const handleWebImageCapture = async (files: File[]): Promise<void> => {
  const targetFolderKey = selectedKeys.value.length > 0 ? selectedKeys.value[0] : ALL_FOLDER

  let successCount = 0
  let failCount = 0

  for (const file of files) {
    const result = await saveDroppedImageFileAsAsset({ file, folderKey: targetFolderKey })
    if (result.success) {
      successCount++
    } else {
      failCount++
      console.error('网页图片采集失败:', result.error)
    }
  }

  if (successCount > 0 && failCount === 0) {
    message.success(t('assetManagement.download.webCaptureSuccess', { count: successCount }))
  } else if (successCount > 0 && failCount > 0) {
    message.warning(
      t('assetManagement.download.webCapturePartial', { success: successCount, fail: failCount })
    )
  } else {
    message.error(t('assetManagement.download.webCaptureFailed'))
  }
}

// 处理拖拽导入逻辑
const handleDragImport = async (filePaths: string[]) => {
  // 外包成员：拖进「交付」就是交一批（方案 4.12）；别处照旧（置灰，说为什么）
  if (libraryCaps.value.team?.role === 'outsourcer') {
    const folder = (await getActiveLibrarySource()
      .folders.getByKey(selectedKeys.value[0] || ALL_FOLDER)
      .catch(() => undefined)) as { catalogPath?: string } | undefined
    if ((folder?.catalogPath ?? '').split('/')[0] === 'delivery') {
      teamDeliverFiles.value = filePaths
      return
    }
  }
  // 服务器库：同一个导入入口，走 lore 以本人身份提交（先确认仓库和提交说明）
  if (libraryStore.isServer) {
    importMenuOpen.value = false
    if (!libraryCaps.value.canImport) {
      message.warning(capabilityReason('canImport'))
      return
    }
    serverImportFiles.value = filePaths
    serverImportOpen.value = true
    return
  }
  const importVaultId = currentVault.value?.id
  if (!importVaultId) return
  importMenuOpen.value = false
  console.log('拖拽导入文件:', filePaths)
  console.log('[DragImport] 当前 selectedKeys:', selectedKeys.value)

  const folders: string[] = []
  const files: string[] = []
  const folderTaskIds = new Map<string, string>()
  const filesTaskId = createImportTaskId('files')
  const getFolderTaskId = (folderPath: string): string =>
    folderTaskIds.get(folderPath) || folderPath
  const getFileTaskId = (): string => filesTaskId
  const targetFolderKey = selectedKeys.value[0] || ALL_FOLDER

  try {
    // 分别处理文件夹和文件

    // 先分类文件和文件夹
    for (const filePath of filePaths) {
      const stats = await window.api.getFileStats(filePath)
      if (stats.isDirectory) {
        folders.push(filePath)
      } else {
        files.push(filePath)
      }
    }

    let processedItems = 0

    // 🚀 导入前检查硬盘剩余空间
    try {
      // 计算所有待导入文件的总大小（预估）
      let totalImportSize = 0
      for (const filePath of files) {
        const stats = await window.api.getFileStats(filePath)
        totalImportSize += stats.size || 0
      }
      // 对于文件夹，暂时预估为文件数量 * 10MB（后续可优化为精确计算）
      // 或者在扫描时再二次确认
      const estimatedFolderSize = folders.length * 50 * 1024 * 1024 // 50MB 每个文件夹预估

      const requiredSpace = totalImportSize + estimatedFolderSize
      const safetyMargin = 500 * 1024 * 1024 // 500MB 安全余量

      // 获取目标路径所在磁盘的剩余空间
      // 优先使用当前 vault 路径，否则退回到第一个导入路径所在磁盘
      const vaultPathResult = await (window as any).api.invoke('vault:getCurrentPath')
      const checkPath =
        vaultPathResult?.success && vaultPathResult.path ? vaultPathResult.path : filePaths[0]
      const checkTargetLabel =
        vaultPathResult?.success && vaultPathResult.path
          ? t('assetManagement.diskCheck.vaultDrive')
          : t('assetManagement.diskCheck.sourceDrive')
      const driveMatch = typeof checkPath === 'string' ? checkPath.match(/^[A-Za-z]:/) : null
      const driveLabel = driveMatch?.[0] || checkPath
      const diskSpaceResult = await window.api.fs.getDiskSpace(checkPath)

      if (diskSpaceResult.success && diskSpaceResult.free !== undefined) {
        const freeSpace = diskSpaceResult.free
        const requiredWithMargin = requiredSpace + safetyMargin

        if (freeSpace < requiredWithMargin) {
          const freeGB = (freeSpace / (1024 * 1024 * 1024)).toFixed(2)
          const requiredGB = (requiredWithMargin / (1024 * 1024 * 1024)).toFixed(2)
          message.error(
            t('assetManagement.diskCheck.insufficientSpace', {
              label: checkTargetLabel,
              drive: driveLabel,
              free: freeGB,
              required: requiredGB
            })
          )
          return
        }
        console.log(
          `[DiskCheck] ${checkTargetLabel}空间充足 (${driveLabel})：剩余 ${(freeSpace / (1024 * 1024 * 1024)).toFixed(2)} GB，预计需要 ${(requiredSpace / (1024 * 1024 * 1024)).toFixed(2)} GB`
        )
      } else {
        // 磁盘空间检查失败，仅记录警告，不阻止导入
        console.warn(
          `[DiskCheck] 无法检查${checkTargetLabel} (${driveLabel}) 空间:`,
          diskSpaceResult.error
        )
      }
    } catch (diskCheckError) {
      console.warn('[DiskCheck] 磁盘空间检查异常，继续导入:', diskCheckError)
    }

    for (const folderPath of folders) {
      const taskId = createImportTaskId(folderPath)
      folderTaskIds.set(folderPath, taskId)
      const name = folderPath.split('\\').pop() || folderPath.split('/').pop() || folderPath
      addImportTask({
        id: taskId,
        type: 'folder',
        name,
        progress: 0,
        stageText: t('assetManagement.import.scanFolderStage'),
        status: 'running',
        folderKey: targetFolderKey,
        taskType: 'vault-import',
        vaultId: importVaultId,
        cancellable: true
      })
    }
    for (const filePath of files) {
      const taskId = filesTaskId
      const name = filePath.split('\\').pop() || filePath.split('/').pop() || filePath
      addImportTask({
        id: taskId,
        type: 'file',
        name: files.length > 1 ? t('assetLib.import.fileBatch', { count: files.length }) : name,
        progress: 0,
        stageText: t('assetManagement.import.scanFileStage'),
        status: 'running',
        folderKey: targetFolderKey,
        taskType: 'vault-import',
        vaultId: importVaultId,
        cancellable: true
      })
    }

    // 记录导入前的所有文件ID（用于diff找出新增项）
    const getItemId = (f: any) => f.assetKey || f.id
    const preImportIds = new Set(currentFiles.value.map(getItemId))

    // 并发处理文件夹（扫描 + 写入），写入由主进程单写者队列串行
    type FolderImportRunResult = {
      folderPath: string
      success: boolean
      error?: string
    }

    // 读取用户设置的导入并发数（与设置页保持一致）
    const isRemoteHttpNetworkVault =
      currentVault.value?.vaultType === VaultType.NETWORK &&
      !!currentVault.value?.networkPath &&
      /^https?:\/\//i.test(currentVault.value.networkPath)
    const configuredConcurrency = isRemoteHttpNetworkVault ? 2 : isNetworkVault.value ? 1 : 3

    const effectiveFolderImportConcurrency = isRemoteHttpNetworkVault
      ? Math.max(1, Math.min(configuredConcurrency, 10))
      : configuredConcurrency
    // HTTP NAS V2 上传链路内部已有文件级重试和续传；整包重跑会重复写本地目录/资产。
    const remoteFolderImportMaxAttempts = 1
    const folderImportRetryBaseDelayMs = 1500

    const folderProducers = folders.map(
      (folderPath) => async (): Promise<FolderImportRunResult> => {
        console.log('开始处理文件夹:', folderPath)
        const taskId = getFolderTaskId(folderPath)
        if (cancelledVaultImports.has(taskId)) {
          completeImportTask(taskId)
          return { folderPath, success: false }
        }

        try {
          const result = await window.api.fs.readFolderContentsRecursive(folderPath, { taskId })
          if (!result.success) {
            const view = buildImportResultView({
              taskId,
              vaultId: importVaultId,
              rootFolderPath: folderPath,
              targetFolderKey,
              total: 0,
              done: 0,
              isCancelled: Boolean(result.cancelled),
              failures: [
                {
                  stage: 'scan',
                  path: folderPath,
                  fileName: folderPath,
                  error: String(result.error),
                  retriable: true
                }
              ]
            })
            retainVaultImportResult(taskId, view)
            return { folderPath, success: false, error: String(result.error) }
          }

          const folderContents = result.data ?? []
          const scanIssues = result.diagnostics?.skippedItems ?? []
          if (cancelledVaultImports.has(taskId)) {
            completeImportTask(taskId)
            return { folderPath, success: false }
          }
          if (!folderContents.some((item: { type: string }) => item.type === 'file')) {
            const view = buildImportResultView({
              taskId,
              vaultId: importVaultId,
              rootFolderPath: folderPath,
              targetFolderKey,
              total: 0,
              done: 0,
              failures: scanIssues.map((issue: { path: string; reason: string }) => ({
                stage: 'scan' as const,
                path: issue.path,
                fileName: issue.path,
                error: issue.reason,
                retriable: true
              }))
            })
            retainVaultImportResult(taskId, view)
            return { folderPath, success: scanIssues.length === 0 }
          }

          const serializedContents = JSON.parse(JSON.stringify(folderContents))
          const totalInFolder = Array.isArray(folderContents) ? folderContents.length : 0
          let lastErrorMessage = ''

          if (remoteFolderImportMaxAttempts > 1) {
            suppressFolderImportErrorTasks.add(folderPath)
          }

          try {
            for (let attempt = 1; attempt <= remoteFolderImportMaxAttempts; attempt++) {
              if (attempt > 1) {
                updateImportTask(getFolderTaskId(folderPath), {
                  stageText: t('assetManagement.import.retryingStage', {
                    attempt,
                    total: remoteFolderImportMaxAttempts
                  })
                })
              } else {
                updateImportTask(getFolderTaskId(folderPath), {
                  stageText: t('assetManagement.import.parsingStage', { count: totalInFolder })
                })
              }

              try {
                const importRes = await assetDataAPI.importFolderStructureWithMetadata(
                  serializedContents,
                  folderPath,
                  targetFolderKey,
                  copyConcurrencyForMain(),
                  getFolderTaskId(folderPath),
                  { vaultId: importVaultId, scanIssues }
                )
                console.log('文件夹智能导入完成:', folderPath)
                processedItems += 1

                const importSummary = (() => {
                  try {
                    const parsed = JSON.parse(String(importRes?.data || '{}'))
                    void parsed
                    const foldersCreated = importRes.data?.foldersCreated ?? undefined
                    const filesCreated = importRes.data?.filesCreated ?? undefined
                    if (typeof foldersCreated === 'number' && typeof filesCreated === 'number') {
                      return t('assetManagement.import.writeDoneWithCounts', {
                        folders: foldersCreated,
                        files: filesCreated
                      })
                    }
                  } catch {}
                  return t('assetManagement.import.writeDone')
                })()
                if (importTasksStore.tasks.get(taskId)?.status !== 'error')
                  updateImportTask(taskId, { stageText: importSummary })
                completeImportTask(getFolderTaskId(folderPath))
                return { folderPath, success: true }
              } catch (error) {
                lastErrorMessage = error instanceof Error ? error.message : String(error)
                console.warn(
                  `[DragImport] 文件夹导入失败（attempt ${attempt}/${remoteFolderImportMaxAttempts}）: ${folderPath}`,
                  error
                )
                if (attempt < remoteFolderImportMaxAttempts) {
                  updateImportTask(getFolderTaskId(folderPath), {
                    stageText: t('assetManagement.import.exceptionRetryStage', {
                      attempt,
                      total: remoteFolderImportMaxAttempts
                    })
                  })
                  await new Promise((resolve) =>
                    setTimeout(resolve, folderImportRetryBaseDelayMs * attempt)
                  )
                  continue
                }
              }
            }
          } finally {
            suppressFolderImportErrorTasks.delete(folderPath)
          }

          updateImportTask(getFolderTaskId(folderPath), {
            stageText: t('assetManagement.import.failedStageWithError', {
              error: lastErrorMessage || t('assetManagement.import.unknownError')
            })
          })
          completeImportTask(getFolderTaskId(folderPath))
          return {
            folderPath,
            success: false,
            error: lastErrorMessage || t('assetManagement.import.unknownError')
          }
        } finally {
          scanBatchBuffers.delete(taskId)
        }
      }
    )
    if (isRemoteHttpNetworkVault && folders.length > 1) {
      console.log(
        `[DragImport] V2 远端资产库多根目录导入：允许受控并发 ${effectiveFolderImportConcurrency}，远端回拉将延迟到最后一条导入完成后统一执行 (configured=${configuredConcurrency})`
      )
    }
    const folderImportResults = await runWithConcurrency(
      folderProducers,
      effectiveFolderImportConcurrency
    )
    const failedFolderImports = folderImportResults.filter((result) => !result.success)
    if (failedFolderImports.length > 0) {
      const failedNames = failedFolderImports
        .slice(0, 3)
        .map((result) => {
          const normalized = result.folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
          const segments = normalized.split('/').filter(Boolean)
          return segments[segments.length - 1] || result.folderPath
        })
        .join('、')
      message.warning(
        failedNames
          ? t('assetManagement.import.folderDoneWithFailures', {
              count: failedFolderImports.length,
              names: failedNames
            })
          : t('assetManagement.import.folderDoneWithFailuresShort', {
              count: failedFolderImports.length
            })
      )
    }

    // 处理单个文件（参考 TestAssetImport.vue 的 handleProcessSelectedFiles）
    if (files.length > 0 && !cancelledVaultImports.has(filesTaskId)) {
      console.log('开始处理文件:', files)
      files.forEach(() => {
        updateImportTask(getFileTaskId(), {
          progress: 30,
          stageText: t('assetManagement.import.stagePreparingShort')
        })
      })

      const processedFiles: Array<{
        name: string
        path: string
        type: 'file'
        size: number | null
        modifiedTime: any
        depth: number
        relativePath: string
      }> = []

      for (const filePath of files) {
        try {
          // 获取文件统计信息
          const stats = await window.api.getFileStats(filePath)

          const fileInfo = {
            name: filePath.split('\\').pop() || filePath.split('/').pop() || filePath,
            path: filePath,
            type: 'file' as const,
            size: stats.size,
            modifiedTime: stats.mtime,
            depth: 0,
            relativePath: filePath.split('\\').pop() || filePath.split('/').pop() || filePath
          }

          processedFiles.push(fileInfo)
        } catch (error) {
          console.warn(`无法获取文件信息: ${filePath}`, error)
          // 即使无法获取统计信息，也添加基本信息
          const fileInfo = {
            name: filePath.split('\\').pop() || filePath.split('/').pop() || filePath,
            path: filePath,
            type: 'file' as const,
            size: null,
            modifiedTime: new Date().toISOString(),
            depth: 0,
            relativePath: filePath.split('\\').pop() || filePath.split('/').pop() || filePath
          }
          processedFiles.push(fileInfo)
        }
      }

      // 使用智能导入处理文件
      // 文件导入时，使用 ALL_FOLDER 作为根路径，表示导入到 ALL 文件夹
      const importRes = await assetDataAPI.importFolderStructureWithMetadata(
        processedFiles,
        ALL_FOLDER,
        targetFolderKey,
        copyConcurrencyForMain(),
        filesTaskId,
        { vaultId: importVaultId }
      )
      void importRes

      // (移除旧的 key 收集逻辑)

      console.log('文件智能导入完成，文件数量:', files.length)
      processedItems += files.length > 0 ? 1 : 0
      for (let i = 0; i < files.length; i++) {
        if (importTasksStore.tasks.get(filesTaskId)?.status === 'error') continue
        updateImportTask(getFileTaskId(), {
          progress: 100,
          stageText: t('assetManagement.import.writeDone'),
          status: 'completed'
        })
        completeImportTask(getFileTaskId())
      }
    }

    // --- 增量更新逻辑 ---
    // 同步刷新导入目标的目录树和当前列表，导入期间切换目录也不会漏掉目标分支。
    await refreshCurrentImportView(targetFolderKey)

    // 找出新增项并选中
    // 注意：loadCurrentFolderAssets 会更新 currentFiles.value
    // 我们在这里对比 preImportIds 来找出新增的 ID
    const addedItems = currentFiles.value.filter((f) => !preImportIds.has(getItemId(f)))

    if (addedItems.length > 0) {
      console.log(`[DragImport] 识别到 ${addedItems.length} 个新增项`, addedItems)
      const addedIds = addedItems.map((f) => getItemId(f))

      // 自动选中
      nextTick(() => {
        if (assetFileListRef.value && assetFileListRef.value.setSelected) {
          // 清除已有选中
          if (assetFileListRef.value.clearSelection) {
            assetFileListRef.value.clearSelection()
          }
          assetFileListRef.value.setSelected(addedIds)
          // 滚动到第一个选中项 (可选，如果列表很长)
          // assetFileListRef.value.scrollToItem(addedIds[0])
        }
      })

      message.success(t('assetManagement.import.successItems', { count: addedItems.length }))

      // 🔧 修复：网络保管库导入后同步写入 manifest journal
      // 拖拽导入只写 SQLite，不写 manifest，导致切换保管库后自动扫描时
      // Phase 4 清理会软删除所有不在 manifest 中的资产
      if (isNetworkVault.value && currentVault.value?.networkPath) {
        try {
          const networkPath = currentVault.value.networkPath
          const networkPathNormalized = networkPath.replace(/[\\/]+$/, '').replace(/\//g, '\\')

          // 获取主机名（用于 manifest 的 createdBy 字段）
          let hostnameStr = 'local'
          try {
            hostnameStr = (await window.api.invoke('app:getHostname')) || 'local'
          } catch {
            // 忽略：使用默认值
          }

          // 将 SQLite 中的 AssetData 转换为 NetworkVaultAsset 格式
          const networkAssets = addedItems
            .map((item: any) => {
              // 计算相对路径：从 filePath 中去掉 networkPath 前缀
              let relativePath = ''
              const filePath = (item.filePath || item.originPath || '').replace(/\//g, '\\')
              if (filePath.toLowerCase().startsWith(networkPathNormalized.toLowerCase())) {
                relativePath = filePath.substring(networkPathNormalized.length)
                // 去掉开头的反斜杠，并统一为正斜杠（manifest 使用正斜杠）
                relativePath = relativePath.replace(/^[\\/]+/, '').replace(/\\/g, '/')
              } else {
                // 如果 filePath 不包含 networkPath 前缀，尝试用文件名作为 relativePath
                const name = item.assetName || item.name || ''
                const ext = item.fileExtension || item.ext || ''
                relativePath = ext ? `${name}${ext}` : name
              }

              return {
                key: item.assetKey || item.id,
                folder: item.folderKey || 'ALL',
                name: item.assetName || item.name || '',
                path: relativePath,
                className: item.className || item.assetClass || 'Unknown',
                size: item.fileSize || 0,
                thumbnail: item.imgLocalPath || item.customPoster || undefined,
                createdAt: new Date().toISOString(),
                createdBy: hostnameStr
              }
            })
            .filter((a: any) => a.path && a.key) // 过滤掉缺少必要字段的

          // V2: 资产已直接写入 SQLite，ChangeTracker 自动记录变更
          // 无需再手动同步到 manifest
          if (networkAssets.length > 0) {
            console.log(
              `[DragImport] V2 模式：${networkAssets.length} 个资产已通过 SQLite 直接入库，ChangeTracker 自动跟踪`
            )
          }
        } catch (syncError) {
          // 网络同步失败不阻断导入流程，仅记录警告
          console.warn('[DragImport] ⚠️ 网络 manifest 同步异常:', syncError)
        }
      }

      // 检查导入的文件中是否有视频文件，如果有则自动生成缩略图
      const { handleVideoAssetImported } = await import('@renderer/hooks/useVideoThumbnail')
      const { isVideoFile } = await import('@renderer/utils/videoThumbnail')

      // 筛选出视频文件
      const videoAssets = addedItems.filter((item: any) => {
        const fileName = item.assetName || item.name || ''
        return isVideoFile(fileName) && item.assetKey
      })

      if (videoAssets.length > 0) {
        console.log(`[VideoThumbnail] 检测到 ${videoAssets.length} 个视频文件，开始生成缩略图`)

        // 异步处理视频缩略图生成（不阻塞用户操作）
        Promise.all(
          videoAssets.map(async (asset: any) => {
            try {
              // 使用通用路径解析函数处理备份/引用模式
              const filePath = resolveAssetFilePath(
                currentVault.value?.path,
                currentVault.value?.vaultType === VaultType.BACKUP,
                asset.originPath,
                asset.filePath
              )
              if (filePath) {
                await handleVideoAssetImported(asset.assetKey, filePath)
                console.log(`[VideoThumbnail] 视频缩略图生成成功: ${asset.assetKey}`)
              }
            } catch (error) {
              console.error(`[VideoThumbnail] 视频缩略图生成失败: ${asset.assetKey}`, error)
            }
          })
        ).then(() => {
          // 缩略图生成完成后，刷新文件列表以显示缩略图
          loadCurrentFolderAssets()
          console.log(`[VideoThumbnail] 所有视频缩略图生成完成`)
        })
      }
    }
  } catch (error) {
    console.error('导入失败:', error)
    message.error(t('assetManagement.import.failedMessage', { error: (error as Error).message }))
    folders.forEach((folderPath) => completeImportTask(getFolderTaskId(folderPath)))
    if (files.length) completeImportTask(filesTaskId)
    // 出错时尝试刷新兜底
    await refreshCurrentImportView(targetFolderKey)
  }
}

// 导航相关方法
const navigateRoot = async () => {
  beginListRequest()
  selectionStore.clear()
  resetPagination()
  isSearching.value = false
  fileListLoading.value = false
  selectedKeys.value = []
  currentPath.value = '/'
  currentFiles.value = []
}

const navigateHistory = async (direction: 'back' | 'forward'): Promise<void> => {
  if (!isAssetPageActive.value || isSwitchingVault.value) return
  try {
    await navStore.navigate(direction, {
      navigateToFolderById,
      navigateRoot,
      isCurrent: () => isAssetPageActive.value && !isSwitchingVault.value
    })
  } catch (error) {
    console.error('History navigation failed:', error)
    message.error(t('assetManagement.folder.navigateFailedRetry'))
  }
}

const handleGoBack = (): Promise<void> => navigateHistory('back')
const handleGoForward = (): Promise<void> => navigateHistory('forward')

// 筛选相关方法（递归遍历当前文件夹及所有子文件夹）
const handleFilter = async () => {
  // 如果正在切换保管库，忽略筛选请求
  if (isSwitchingVault.value) return

  // 收藏 / 回收站不属于任何文件夹，它们自己那条加载路径认筛选条件。
  // 原来这里会撞上下面那句「请先选择文件夹」然后返回 —— 于是在这两个视图里
  // 动筛选只会弹个提示，列表纹丝不动
  if (isShowingShortcutView.value) {
    await loadCurrentFolderAssets()
    return
  }

  if (!selectedKeys.value.length) {
    message.warning(t('assetManagement.folder.selectFirst'))
    return
  }

  // 如果没有激活的筛选条件，直接加载当前文件夹的原始数据
  // 不触发搜索接口，避免 apply-filter 事件在重置时触发不必要的搜索
  if (!hasActiveFilters.value) {
    await loadCurrentFolderAssets()
    return
  }

  isSearching.value = true
  searchPagination.current = 1
  await performSearchWithPagination(false)
}

// 根据收藏状态筛选函数未被使用，移除以保持代码整洁

const handleResetFilter = async () => {
  try {
    // 清空所有筛选与关键字
    filterForm.fileCategory = undefined
    filterForm.assetTypes = []
    filterForm.sizeRange = undefined
    filterForm.dateRange = undefined
    filterForm.tags = []
    filterForm.includeTags = []
    filterForm.excludeTags = []
    filterForm.tagMatchMode = 'any'
    filterForm.hasNoTags = false
    filterForm.favoriteStatus = 'all'
    filterForm.keyword = ''
    filterForm.engineVersions = []

    // 「只看主资产」也是筛选条件，「重置」得连它一起清掉，
    // 否则重置完列表还是短的、chip 还挂着。它自己的 watch 会重新加载一次，
    // 这里下面还要再加载一次 —— 置位挡掉那次重复请求
    if (!showDependencies.value) {
      suppressShowDependenciesReload = true
      showDependencies.value = true
    }

    await loadCurrentFolderAssets()
  } catch (error) {
    console.error('重置筛选条件失败:', error)
    message.error(t('assetManagement.filter.resetFailed'))
    fileListLoading.value = false
  }
}

/**
 * 在文件夹视图中显示（Ctrl+B / 右键菜单）
 * 清除所有筛选条件并跳转到选中资产的真实所在文件夹
 */
/**
 * 导航完成后在文件列表里选中某个资产。
 *
 * revealAsset 自己会等文件加载完、把虚拟列表滚到位、点亮那一格，所以这里
 * 不用再猜一个延时。但它只管列表里的选中态 —— 详情面板读的是 selectedAsset，
 * 得另外从当前文件里把对象捞出来对上，否则「跳过去了但没选中」。
 */
const selectAssetInCurrentFolder = async (assetKey: string): Promise<void> => {
  const revealed = await assetFileListRef.value?.revealAsset?.(assetKey)
  if (!revealed) return

  const targetAsset = currentFiles.value.find((file: any) =>
    file.assetKey ? file.assetKey === assetKey : file.id === assetKey
  )
  if (targetAsset) selectedAsset.value = targetAsset
}

const handleLocateInFolder = async (folderKey?: string, assetKey?: string) => {
  // 优先使用右键菜单传入的 folderKey，其次使用当前选中资产的 folderKey
  const targetFolderKey = folderKey || selectedAsset.value?.folderKey
  if (!targetFolderKey) {
    message.warning(t('assetManagement.poster.selectAssetFirst'))
    return
  }

  // 清除所有筛选条件
  filterForm.fileCategory = undefined
  filterForm.assetTypes = []
  filterForm.sizeRange = undefined
  filterForm.dateRange = undefined
  filterForm.tags = []
  filterForm.includeTags = []
  filterForm.excludeTags = []
  filterForm.tagMatchMode = 'any'
  filterForm.favoriteStatus = 'all'
  filterForm.keyword = ''
  isSearching.value = false
  filterPanelExpanded.value = false

  // 导航到资产所在文件夹
  await navigateToFolderById(targetFolderKey)
  selectionStore.setTreeKey(targetFolderKey)

  // 指名了是哪个资产就把它选中。只跳到目录、让用户自己在一屏文件里找，
  // 等于没跳
  if (assetKey) await selectAssetInCurrentFolder(assetKey)
}

const handleSelectImportRecoveryReport = async () => {
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('assetManagement.dialog.apiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetManagement.import.selectErrorJsonTitle'),
      properties: ['openFile'],
      filters: [{ name: t('assetManagement.import.errorJsonFilterName'), extensions: ['json'] }]
    })
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      await handleImportRecoveryReportPaths(ret.filePaths, { strict: true })
    }
  } catch (error) {
    console.error('选择续传报告失败:', error)
    message.error(
      error instanceof Error ? error.message : t('assetManagement.import.selectResumeReportFailed')
    )
  }
}

const handleResumeReportButtonDrop = async (e: DragEvent) => {
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  const filePaths: string[] = []
  for (let i = 0; i < files.length; i++) {
    const filePath = await window.api.getPathForFile(files[i])
    if (filePath) filePaths.push(filePath)
  }
  await handleImportRecoveryReportPaths(filePaths, { strict: true })
}

const handleUploadFiles = async () => {
  console.log('点击上传文件按钮')
  try {
    if (!window.api || !window.api.dialog) {
      console.error('window.api.dialog 未定义')
      message.error(t('assetManagement.dialog.apiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetManagement.import.selectFilesTitle'),
      properties: ['openFile', 'multiSelections']
    })
    console.log('选择文件结果:', ret)
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      await handleDragImport(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.dialog.openDialogFailed')))
  }
}

const handleUploadFolder = async () => {
  console.log('点击上传文件夹按钮')
  try {
    if (!window.api || !window.api.dialog) {
      console.error('window.api.dialog 未定义')
      message.error(t('assetManagement.dialog.apiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetManagement.import.selectFolderTitle'),
      properties: ['openDirectory', 'multiSelections']
    })
    console.log('选择文件夹结果:', ret)
    if (!ret.canceled && ret.filePaths && ret.filePaths.length > 0) {
      await handleDragImport(ret.filePaths)
    }
  } catch (error) {
    console.error('选择文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.dialog.openFolderDialogFailed')))
  }
}

/** 整包上传只对 HTTP 资产服务器库有意义：本地库和 SMB 库直接复制文件就是最快的 */
const isHttpServerVault = computed(() => {
  if (!libraryCaps.value.vaultFeatures) return false
  const networkPath = vaultStore.currentVault?.networkPath || ''
  return networkPath.startsWith('http://') || networkPath.startsWith('https://')
})

/**
 * 工程整包上传：选中的每个目录打成一个 zip、当一个文件送到服务器。
 * 逐个排队而不是并发 —— 服务端按文件个数收固定开销，整包只有一个文件，
 * 并发拿不到更多带宽，只会让每个工程都变慢；排队至少能让第一个尽快传完。
 */
const handleUploadProjectArchive = async (): Promise<void> => {
  try {
    if (!window.api || !window.api.dialog) {
      message.error(t('assetManagement.dialog.apiUnavailable'))
      return
    }
    const ret = await window.api.dialog.showOpenDialog({
      title: t('assetManagement.import.selectProjectArchiveTitle'),
      properties: ['openDirectory', 'multiSelections']
    })
    if (ret.canceled || !ret.filePaths || ret.filePaths.length === 0) return

    const targetFolderKey = selectedKeys.value.length > 0 ? selectedKeys.value[0] : undefined
    const queue = ret.filePaths.map((sourcePath) => {
      const taskId = createImportTaskId(sourcePath)
      const name = sourcePath.split('\\').pop() || sourcePath.split('/').pop() || sourcePath
      addImportTask({
        id: taskId,
        type: 'folder',
        name: `${name}.zip`,
        progress: 0,
        stageText: t('assetManagement.import.projectArchiveQueued'),
        status: 'running',
        folderKey: targetFolderKey
      })
      return { sourcePath, taskId, name }
    })

    for (const item of queue) {
      try {
        const result = await assetDataAPI.uploadProjectArchive(
          item.sourcePath,
          targetFolderKey,
          item.taskId
        )
        message.success(
          t('assetManagement.import.projectArchiveDone', {
            name: result.archiveName,
            files: result.fileCount,
            size: formatFileSize(result.archiveBytes),
            rate: result.mbPerSec
          }),
          6
        )
      } catch (error) {
        // 失败提示由 asset:folderImportError 事件统一弹出，这里只记日志
        console.error('[ProjectArchive] upload failed:', item.sourcePath, error)
      }
    }
  } catch (error) {
    console.error('选择工程目录失败:', error)
    message.error(resolveErrorText(error, t('assetManagement.dialog.openFolderDialogFailed')))
  }
}
</script>

<style lang="less" scoped>
.asset-management {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 防止子元素动画撑开容器导致出现滚动条 */

  .asset-layout {
    display: flex;
    // 不留 gap：面板之间只靠 1px 分隔线，留了 gap 就会变成
    // 「间隙 + 线 + 间隙」的双缝
    gap: 0;
    flex: 1;
    min-height: 0;

    .tree-panel {
      width: 300px;
      min-width: 250px;
      max-width: 800px;
      border: none;
      overflow: hidden;
      flex-shrink: 0;
      transition: width 0s; // 拖拽时不需要过渡动画
    }

    .resize-handle {
      // 分隔条本身就是那条线，1px，和右侧详情面板的 border-left 一样粗
      width: 1px;
      flex-shrink: 0;
      cursor: col-resize;
      background: var(--color-border-subtle);
      position: relative;
      z-index: 10;
      transition: background-color 0.2s;

      // 1px 的线鼠标抓不住，用透明伪元素把可拖拽区域撑到 9px
      &::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -4px;
        right: -4px;
      }

      &:hover {
        background: var(--color-accent-solid);
      }
    }

    .details-panel {
      // 宽度由拖拽控制（min/max 见 DETAILS_PANEL_WIDTH_RANGE），分隔线归 .resize-handle 管
      flex-shrink: 0;
      background-color: var(--color-bg-surface-hover); // 最深，与左侧呼应
      border: none;
      overflow: hidden;
      transition: width 0s; // 拖拽时不需要过渡动画
    }

    .content-area {
      flex: 1;
      overflow: hidden;

      position: relative;
      display: flex;
      flex-direction: column;
      // min-height: 0; // 确保flex子项可以收缩

      // 导入是这个页面的主动作：主按钮走 primary（反相底），次级动作走 soft，
      // 靠明度差分主次，而不是把两档都压成和页面同色
      .floating-upload-btn {
        position: absolute;
        bottom: 24px;
        right: 24px;
        z-index: 100;
        display: flex;
        // DOM 顺序是「触发按钮 → 它控制的菜单」（aria-controls 和 Tab 顺序要的），
        // 视觉上要主按钮钉在右下角、子项往上长，所以这里翻一次
        flex-direction: column-reverse;
        align-items: center;
        gap: 12px;

        &.is-open .sub-actions {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto;
          visibility: visible;
        }

        &.is-open .upload-fab {
          transform: rotate(45deg);
        }

        .sub-actions {
          display: flex;
          flex-direction: column;
          gap: 12px;
          opacity: 0;
          transform: translateY(20px);
          pointer-events: none;
          visibility: hidden;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          padding-bottom: 8px;

          .sub-btn {
            width: 40px;
            height: 40px;
            font-size: 18px;
            box-shadow: 0 4px 12px var(--shadow-color-weak);
            transition: all 0.2s;

            &:hover {
              transform: scale(1.1);
            }
          }
        }

        .upload-fab {
          width: 48px;
          height: 48px;
          font-size: 20px;
          box-shadow: 0 6px 16px var(--shadow-color);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 2;

          &:active {
            transform: scale(0.95);
          }
        }
      }

      .navigation-section {
        padding: 0 16px;
        background: var(--color-bg-page);
        border-bottom: 1px solid var(--color-border-subtle);
        display: flex;
        align-items: center;
        gap: 16px;
        height: 56px; // 与右侧详情面板 .panel-header 等高
        flex-shrink: 0;
        // 搜索框收不收由这一行自己的宽度决定，不是窗口宽度 ——
        // 把它挤窄的是右边展开的详情面板，窗口一动没动
        position: relative;
        container: asset-nav-bar / inline-size;

        .nav-controls {
          flex-shrink: 0;
          // 原来是 antd 的 a-button-group，但下面这些规则把它的边框、底色、圆角
          // 全抹平了 —— 它在这儿只是个容器，换成普通 div 一点也不少
          .nav-button-group {
            display: inline-flex;

            .app-button {
              border-radius: var(--radius-xs);
              border-color: transparent;
              background: transparent;
              color: var(--color-text-secondary);
              box-shadow: none;
              // 与地址栏、搜索框同为 32px，一行控件一个高度
              height: 32px;

              &:hover {
                background: var(--color-bg-surface-hover);
                color: var(--color-text-primary);
              }

              &:disabled {
                color: var(--color-text-disabled);
                background: transparent;
                cursor: not-allowed;
              }
            }
          }
        }

        // 面包屑区域作为地址栏 - Windows 风格
        .breadcrumb-bar {
          flex: 1;
          display: flex;
          align-items: center;
          // 常驻透明：它是一条路径，不是输入框。填底色会和右边的搜索框长得一模一样，
          // 用户分不出哪个能打字
          background: transparent;
          border: 1px solid transparent;
          border-radius: 4px;
          padding: 0 12px;
          height: 32px;
          min-width: 0; // 防止溢出
          transition: all 0.2s;
          overflow: hidden;

          &:hover {
            background: var(--color-bg-surface-hover);
          }

          &:focus-within {
            background: var(--color-bg-page);
            border-color: var(--color-border);
            box-shadow: 0 0 0 2px var(--color-accent-border);
          }

          // Windows 风格面包屑导航
          .breadcrumb-nav {
            display: flex;
            align-items: center;
            white-space: nowrap;
            overflow: hidden;
            width: 100%;

            .breadcrumb-separator {
              margin: 0 6px;
              color: var(--color-text-muted);
              font-size: 13px;
              flex-shrink: 0;
            }

            .breadcrumb-item {
              font-size: 13px;
              color: var(--color-text-primary);
              cursor: pointer;
              transition: color 0.2s;
              flex-shrink: 0;

              &:hover {
                color: var(--color-accent-text);
              }

              // 保管库名称（首项）
              &.vault {
                color: var(--color-text-secondary);
                cursor: default;
                font-weight: 500;
              }

              // 折叠项（...）
              &.ellipsis {
                padding: 2px 6px;
                border-radius: 3px;
                background: var(--color-bg-surface-hover);

                &:hover {
                  background: var(--color-bg-surface-hover);
                  color: var(--color-accent-text);
                }
              }

              // 当前目录（最后一项）
              &.current {
                color: var(--color-text-primary);
                cursor: default;
                font-weight: 500;
                overflow: hidden;
                text-overflow: ellipsis;
              }
            }
          }
        }

        .search-controls {
          width: 280px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: flex-end;

          .search-field {
            width: 100%;
          }

          // 收起态的入口，宽屏下不出现
          .search-icon-btn {
            display: none;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border: none;
            border-radius: 4px;
            background: var(--color-bg-surface);
            color: var(--color-text-muted);
            cursor: pointer;
            transition: all 0.2s;

            svg {
              font-size: 16px;
            }

            &:hover {
              background: var(--color-bg-surface-hover);
              color: var(--color-text-primary);
            }
          }

          .search-input {
            width: 100%;

            // 常驻填底：和左边透明的面包屑地址栏区分开，一眼看出这个能打字
            :deep(.ant-input-affix-wrapper) {
              height: 32px;
              padding: 0 12px;
              border-radius: 4px;
              border: none;
              background: var(--color-bg-surface);
              transition: all 0.2s;

              &:hover {
                background: var(--color-bg-surface-hover);
              }

              // 焦点环画在外层，画在里层的 input 上会被外层裁掉
              &:focus-within {
                background: var(--color-bg-surface-hover);
                box-shadow: 0 0 0 2px var(--color-accent-border);
              }

              .ant-input-prefix {
                color: var(--color-text-muted);
              }
            }

            :deep(.ant-input) {
              height: 100%;
              border: none;
              box-shadow: none;
              background: transparent;
              color: var(--color-text-secondary);

              &:focus {
                box-shadow: none;
                color: var(--color-text-primary);
              }
            }
          }
        }

        // 这一行放不下 280px 的输入框 + 一条还读得懂的面包屑，就把搜索收成图标
        @container asset-nav-bar (max-width: 560px) {
          .search-controls {
            width: auto;

            .search-icon-btn {
              display: flex;
            }

            .search-field {
              display: none;
            }

            // 展开时浮在整行之上，而不是把面包屑再挤掉一截
            &.expanded {
              position: absolute;
              top: 12px; // (56 - 32) / 2
              right: 16px;
              z-index: 1;
              width: min(280px, calc(100% - 32px));

              .search-icon-btn {
                display: none;
              }

              .search-field {
                display: block;
              }
            }
          }
        }
      }

      .command-bar {
        // 44px 高里塞不下 8px 上下内边距 + 32px 按钮，纵向内边距交给 align-items
        padding: 0 16px;
        background: var(--color-bg-surface);
        // 不画底边：地址栏那条线已经是「框架到此为止」的分界，
        // 再画一条只会让两条几乎一样的横栏读成双层标题
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        height: 44px;
        flex-shrink: 0;
        // 详情面板一展开，这一栏能窄到 490px。按容器宽度决定标签文字收不收，
        // 而不是按窗口宽度 —— 窗口没变，是右边的面板把它挤窄的
        container: asset-command-bar / inline-size;

        .left-actions {
          display: flex;
          gap: 8px;
          min-width: 0;
          // 收完标签还是挤（网络库多一个扫描按钮）就整颗裁掉，
          // 不许溢出去压右边的详情开关
          overflow: hidden;

          .action-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            flex-shrink: 0;
            white-space: nowrap;
            padding: 0 12px;
            border-radius: 4px;
            border: 1px solid transparent;
            background: transparent;
            color: var(--color-text-primary);
            cursor: pointer;
            transition: all 0.2s;
            font-size: 13px;

            &:hover {
              background: var(--color-bg-surface-hover);
            }

            &.active {
              background: var(--color-bg-selected);
              color: var(--color-text-selected);
            }

            // 当前库做不到的动作（例如服务器库的标签管理）：看得出点不了，原因在悬浮提示里
            &:disabled,
            &:disabled:hover {
              background: transparent;
              color: var(--color-text-disabled);
              cursor: not-allowed;
            }

            svg {
              font-size: 14px;
            }

            .badge {
              font-size: 12px;
              color: var(--color-accent-text);
              font-weight: 600;
            }
          }
        }

        .right-actions {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-shrink: 0;

          .size-control {
            display: flex;
            align-items: center;
            width: 120px;
            flex-shrink: 0;
            padding: 0 8px;

            .size-slider {
              width: 100%;
              margin: 0;

              :deep(.ant-slider-rail) {
                background-color: var(--color-bg-surface-hover);
              }

              :deep(.ant-slider-track) {
                background-color: var(--color-bg-raised);
              }

              :deep(.ant-slider-handle) {
                border-color: var(--color-border);
                background-color: var(--color-bg-raised);

                &:hover,
                &:focus {
                  border-color: var(--color-border);
                  box-shadow: 0 0 0 5px var(--color-accent-border);
                }
              }

              :deep(.ant-slider-step) {
                background: var(--color-bg-surface-hover);
              }

              :deep(.ant-slider-dot) {
                border-color: var(--color-border-subtle);
              }

              :deep(.ant-slider-dot-active) {
                border-color: var(--color-border);
              }
            }
          }

          .action-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            flex-shrink: 0;
            white-space: nowrap;
            padding: 0 12px;
            border-radius: 4px;
            border: 1px solid transparent;
            background: transparent;
            color: var(--color-text-muted);
            cursor: pointer;
            transition: all 0.2s;
            font-size: 13px;

            &.danger {
              color: var(--color-danger-text);

              &:hover {
                background: var(--color-danger-bg);
                color: var(--color-danger-text);
              }
            }

            &:hover {
              background: var(--color-bg-surface-hover);
            }

            &.active {
              color: var(--color-text-primary);
            }

            svg {
              font-size: 14px;
            }
          }
        }

        // 挤不下就先收标签文字，只留图标（title 已经补上，悬停还看得到名字）。
        // 中文标签没有空格，不收的话会被逐字折成竖排
        @container asset-command-bar (max-width: 640px) {
          .action-btn .btn-label {
            display: none;
          }

          .action-btn {
            padding: 0 8px;
          }
        }

        // 再窄就连缩略图尺寸滑块也让位，它是调节项，不是入口
        @container asset-command-bar (max-width: 380px) {
          .right-actions .size-control {
            display: none;
          }
        }
      }
    }
  }

  .content-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0; // 确保flex子项可以收缩
    overflow: hidden; // 防止内容溢出
  }

  // 使文件列表区域在 content-area 内自动填充剩余空间
  .file-list-section {
    flex: 1;
    min-height: 0;
    overflow: hidden; // 由内部的 AssetFileList 自己滚动
    display: flex; // 让子组件的 100% 高度生效
  }

  .drag-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--color-accent-bg);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed var(--color-accent-border);
    border-radius: var(--radius-sm);

    .drag-content {
      text-align: center;
      color: var(--color-accent-text);

      .drag-icon {
        margin-bottom: 16px;

        svg {
          color: var(--color-accent-text);
          opacity: 0.8;
        }
      }

      .drag-text {
        h3 {
          margin: 0 0 8px 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--color-accent-text);
        }

        p {
          margin: 0;
          font-size: 14px;
          color: var(--color-accent-text);
          opacity: 0.8;
        }
      }
    }
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeInDownSmall {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.import-error-content {
  padding: 12px 0;

  strong {
    color: var(--color-danger-text);
    word-break: break-all;
  }

  .error-detail {
    margin: 16px 0;
    padding: 12px;
    background: var(--color-bg-surface-hover);
    border-radius: 4px;
    border-left: 3px solid var(--color-danger-border);

    p {
      margin-bottom: 4px;
      &:last-child {
        margin-bottom: 0;
      }
    }

    .path-info {
      font-size: 12px;
      color: var(--color-text-muted);
      word-break: break-all;
    }
  }

  .action-tip {
    margin-top: 16px;
    color: var(--color-text-primary);
  }
}

.import-error-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .right-btns {
    display: flex;
    gap: 8px;
  }
}

.import-result-content {
  .result-summary {
    font-size: 14px;
    margin-bottom: 16px;
    line-height: 1.8;

    .success-text {
      color: var(--color-success-text);
    }
    .error-text {
      color: var(--color-danger-text);
    }
    .separator {
      margin: 0 8px;
      color: var(--color-border);
    }
  }

  .failed-list-section {
    margin-bottom: 16px;

    .failed-list {
      margin-top: 8px;
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--color-border);
      border-radius: 4px;
      padding: 8px;
      background: var(--color-bg-surface);

      .failed-item {
        padding: 8px;
        border-bottom: 1px solid var(--color-border-subtle);

        &:last-child {
          border-bottom: none;
        }

        .file-name {
          font-weight: 500;
          color: var(--color-text-primary);
        }
        .file-path {
          font-size: 12px;
          color: var(--color-text-secondary);
          margin: 2px 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .file-error {
          font-size: 12px;
          color: var(--color-danger-text);
        }
      }
    }
  }

  .result-footer {
    text-align: right;
  }
}

.import-recovery-content {
  color: var(--color-text-primary);

  p {
    margin: 0 0 12px;
    line-height: 1.6;
  }

  .import-recovery-grid {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 8px 12px;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-surface);

    span {
      color: var(--color-text-secondary);
    }

    code,
    strong {
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--color-text-primary);
    }
  }

  .import-recovery-note {
    margin-top: 12px;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  .import-recovery-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .import-recovery-details {
    margin-top: 12px;
    color: var(--color-text-secondary);

    summary {
      cursor: pointer;
      user-select: none;
    }

    .import-recovery-grid {
      margin-top: 8px;
    }
  }
}

.overwrite-confirm-content {
  padding: 8px 0;

  p {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--color-text-primary);
  }
}

.overwrite-confirm-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .left-btns,
  .right-btns {
    display: flex;
    gap: 8px;
  }
}

.server-library-banner {
  flex-shrink: 0;
}

.server-library-banner-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
</style>
