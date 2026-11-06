<template>
  <div class="asset-file-list">
    <div
      ref="containerRef"
      class="file-content"
      @click="handleEmptyAreaClick"
      @contextmenu="handleEmptyAreaRightClick"
      @pointerdown="onContainerPointerDown"
      @pointerup="onContainerPointerUp"
    >
      <!-- 虚拟滚动容器引用 -->
      <div ref="scrollContainerRef" class="virtual-scroll-container">
        <AssetLoadingContent
          v-if="initialLoading && files.length === 0 && effectiveImportTasks.length === 0"
          :style="{ '--asset-loading-size': `${gridItemSize}px` }"
        />
        <AppSpin v-else :spinning="initialLoading">
          <div
            v-if="
              files.length === 0 &&
              !loading &&
              effectiveImportTasks.filter((t) => t.type === 'folder').length === 0 &&
              effectiveImportTasks.filter((t) => t.type === 'file').length === 0
            "
            class="empty-state"
          >
            <div class="empty-icon">📄</div>
            <div class="empty-text">{{ t('assetLib.fileList.empty') }}</div>
            <div class="empty-desc">
              <span v-if="!selectedFolderKey">{{ t('assetLib.fileList.selectFolder') }}</span>
              <span v-else>{{ t('assetLib.fileList.addAsset') }}</span>
            </div>
          </div>
          <div v-else class="file-content-wrapper">
            <!-- 文件夹区域 -->
            <div
              v-if="
                folderFiles.length > 0 ||
                effectiveImportTasks.filter((t) => t.type === 'folder').length > 0
              "
              class="folder-section"
            >
              <div
                class="section-header"
                @click="isFolderSectionExpanded = !isFolderSectionExpanded"
              >
                <span class="section-title">
                  <span class="expand-icon">
                    <PhCaretDown v-if="isFolderSectionExpanded" />
                    <PhCaretRight v-else />
                  </span>
                  {{ t('assetLib.fileList.folders') }} ({{ folderFiles.length }})
                </span>
                <div class="header-line"></div>
              </div>
              <div v-show="isFolderSectionExpanded" class="file-grid" :style="gridStyle">
                <div
                  v-for="task in effectiveImportTasks.filter((t) => t.type === 'folder')"
                  :key="task.id"
                  class="file-item import-item"
                >
                  <div class="file-icon">
                    <div class="task-icon-wrapper">
                      <div
                        class="task-fill"
                        :style="{
                          height: `${Math.max(0, Math.min(100, Math.round(task.progress || 0)))}%`
                        }"
                      ></div>
                      <div class="task-percent">{{ Math.round(task.progress || 0) }}%</div>
                    </div>
                  </div>
                  <div class="file-info">
                    <div
                      class="file-name"
                      :title="task.name || t('assetManagementFileList.importTaskFallbackName')"
                    >
                      {{ task.name || t('assetManagementFileList.importTaskFallbackName') }}
                    </div>
                    <div class="file-meta">
                      <span v-if="task.total" style="margin-right: 4px">
                        {{ task.done || 0 }}/{{ task.total }}
                      </span>
                      <span>
                        {{
                          task.stageText ||
                          (task.status === 'paused'
                            ? t('assetLib.fileList.paused')
                            : getTaskStageText(task))
                        }}
                      </span>
                    </div>
                  </div>
                </div>

                <div
                  v-for="file in folderFiles"
                  :key="file.id"
                  class="file-item folder-item"
                  :class="{
                    'file-item-selected': isSelected(file.id)
                  }"
                  :data-file-id="file.id"
                  :data-folder-type="file.folderType"
                  draggable="true"
                  @click="handleItemClick(file, $event)"
                  @dblclick="handleItemDoubleClick(file)"
                  @contextmenu="handleRightClick($event, file)"
                  @dragstart="handleAssetDragStart($event, file)"
                  @drag="handleAssetDrag"
                  @dragend="handleAssetDragEnd"
                  @mouseenter="handleAssetMouseEnter(file)"
                  @mouseleave="handleAssetMouseLeave"
                >
                  <div class="file-icon">
                    <div
                      class="folder-icon-wrapper"
                      :class="{ 'has-custom-color': file.color }"
                      :style="file.color ? { '--custom-folder-color': file.color } : undefined"
                    >
                      <!-- 插件类型使用插件自带图标，其他类型使用文件夹图标 -->
                      <!-- 调试: file.img = {{ file.img }} -->
                      <template v-if="getFolderCoverUrl(file)">
                        <!-- 视频封面 (preload=metadata 只加载第一帧，不自动播放) -->
                        <video
                          v-if="isFolderCoverVideo(file)"
                          :src="getFolderCoverUrl(file)"
                          class="custom-folder-cover"
                          preload="metadata"
                          muted
                          playsinline
                          @error="handleThumbImgError($event, file)"
                        ></video>
                        <!-- GIF 封面 (hover 时播放) -->
                        <img
                          v-else-if="isFolderCoverGif(file)"
                          :src="getFolderCoverUrl(file)"
                          alt="cover"
                          class="custom-folder-cover gif-cover"
                          loading="lazy"
                          @mouseenter="handleGifEnter"
                          @mouseleave="handleGifLeave"
                          @error="handleThumbImgError($event, file)"
                        />
                        <!-- 图片封面 -->
                        <img
                          v-else
                          :src="getFolderCoverUrl(file)"
                          alt="cover"
                          class="custom-folder-cover"
                          loading="lazy"
                          @error="handleThumbImgError($event, file)"
                        />
                        <!-- 颜色圆点：有自定义封面时始终显示，无颜色则用默认黄色 -->
                        <div
                          class="folder-color-dot"
                          :style="{ backgroundColor: file.color || 'var(--color-folder)' }"
                        ></div>
                      </template>
                      <img
                        v-else-if="
                          file.folderType === 'plugin' &&
                          file.img &&
                          !failedPluginIcons.has(file.img)
                        "
                        :src="toLocalResourceUrl(file.img)"
                        alt="plugin"
                        class="plugin-folder-icon"
                        @error="handlePluginIconError(file.img)"
                      />
                      <span
                        v-else-if="file.folderType === 'plugin'"
                        class="mono-icon plugin-folder-icon"
                        role="img"
                        aria-label="plugin"
                        :style="{ '--mono-icon': `url(${icPluginsIcon})` }"
                      />
                      <PhFolder v-else weight="fill" class="folder-icon" />
                    </div>
                    <PhStar
                      v-if="getFolderFavoriteStatus(file.id)"
                      weight="fill"
                      class="favorite-icon"
                    />
                    <!-- 文件夹上传状态遮罩（百度网盘或WebDAV） -->
                    <div
                      v-if="getFolderUploadTask(file.id) || getWebdavFolderUploadTask(file.id)"
                      class="folder-upload-overlay"
                    >
                      <div class="upload-backdrop"></div>
                      <div class="upload-content">
                        <PhCloudArrowUp class="upload-icon-small" />
                        <span class="upload-percent"
                          >{{
                            (getFolderUploadTask(file.id) || getWebdavFolderUploadTask(file.id))
                              ?.progress
                          }}%</span
                        >
                      </div>
                      <div class="upload-progress-bar-bottom">
                        <div
                          class="upload-progress-fill"
                          :style="{
                            width:
                              ((getFolderUploadTask(file.id) || getWebdavFolderUploadTask(file.id))
                                ?.progress || 0) + '%'
                          }"
                        ></div>
                      </div>
                    </div>
                    <!-- 工程导入进度覆盖层（黑灰主题） -->
                    <div
                      v-if="getProjectImportTask(file.id)"
                      class="folder-upload-overlay project-import-overlay"
                      :class="{ 'is-completed': getProjectImportTask(file.id)?.isCompleted }"
                    >
                      <div class="upload-backdrop project-import-backdrop"></div>
                      <div class="upload-content">
                        <!-- 完成时显示勾选图标 -->
                        <PhCheckCircle
                          v-if="getProjectImportTask(file.id)?.isCompleted"
                          weight="fill"
                          class="upload-icon-small project-import-check"
                        />
                        <!-- 进行中显示百分比 -->
                        <template v-else>
                          <PhExport class="upload-icon-small project-import-icon" />
                          <span class="upload-percent project-import-percent"
                            >{{ getProjectImportTask(file.id)?.progress || 0 }}%</span
                          >
                        </template>
                      </div>
                      <div class="upload-progress-bar-bottom project-import-bar">
                        <div
                          class="upload-progress-fill project-import-fill"
                          :style="{
                            width: (getProjectImportTask(file.id)?.progress || 0) + '%'
                          }"
                        ></div>
                      </div>
                    </div>
                    <!-- vault-import 导入进度覆盖层（复用 project-import 样式） -->
                    <div
                      v-if="getVaultImportTask(file.id)"
                      class="folder-upload-overlay project-import-overlay"
                    >
                      <div class="upload-backdrop project-import-backdrop"></div>
                      <div class="upload-content">
                        <PhExport class="upload-icon-small project-import-icon" />
                        <span class="upload-percent project-import-percent"
                          >{{ getVaultImportTask(file.id)?.progress || 0 }}%</span
                        >
                      </div>
                      <div class="upload-progress-bar-bottom project-import-bar">
                        <div
                          class="upload-progress-fill project-import-fill"
                          :style="{
                            width: (getVaultImportTask(file.id)?.progress || 0) + '%'
                          }"
                        ></div>
                      </div>
                    </div>
                  </div>
                  <div class="file-info">
                    <div v-if="inlineEditId !== file.id" class="file-name" :title="file.name">
                      {{ file.name }}
                    </div>
                    <a-input
                      v-else
                      ref="inlineInputRef"
                      v-model:value="inlineEditValue"
                      class="inline-rename-input"
                      size="small"
                      :maxlength="128"
                      spellcheck="false"
                      @press-enter="confirmInlineRename"
                      @blur="confirmInlineRename"
                      @keydown.esc="cancelInlineRename"
                      @keydown.stop
                      @click.stop
                      @mousedown.stop
                      @dblclick.stop
                    />
                    <div class="file-meta">
                      <!-- 回收站里要看的是「哪天删的」，修改时间在这儿没什么可看的 -->
                      <span
                        class="file-date"
                        :title="
                          isTrashView
                            ? t('assetFileList.restore.deletedTime', { time: trashTimeOf(file) })
                            : t('assetFileList.modifiedTime', { time: file.modifiedTime ?? '' })
                        "
                        >{{
                          isTrashView
                            ? formatDate(trashTimeOf(file))
                            : formatDate(file.modifiedTime ?? '')
                        }}</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 文件区域 -->
            <div
              v-if="
                assetFiles.length > 0 ||
                effectiveImportTasks.filter((t) => t.type === 'file').length > 0
              "
              class="asset-section"
            >
              <div class="section-header" @click="isFileSectionExpanded = !isFileSectionExpanded">
                <span class="section-title">
                  <span class="expand-icon">
                    <PhCaretDown v-if="isFileSectionExpanded" />
                    <PhCaretRight v-else />
                  </span>
                  {{ t('assetLib.fileList.files') }} ({{ assetFiles.length }})
                </span>
                <div class="header-line"></div>
              </div>
              <div
                v-show="isFileSectionExpanded"
                ref="assetGridRef"
                class="file-grid"
                :style="gridStyle"
              >
                <div
                  v-for="task in effectiveImportTasks.filter((t) => t.type === 'file')"
                  :key="task.id"
                  class="file-item import-item"
                >
                  <div class="file-icon">
                    <div class="task-icon-wrapper">
                      <div
                        class="task-fill"
                        :style="{
                          height: `${Math.max(0, Math.min(100, Math.round(task.progress || 0)))}%`
                        }"
                      ></div>
                      <div class="task-percent">{{ Math.round(task.progress || 0) }}%</div>
                    </div>
                  </div>
                  <div class="file-info">
                    <div
                      class="file-name"
                      :title="task.name || t('assetManagementFileList.importTaskFallbackName')"
                    >
                      {{ task.name || t('assetManagementFileList.importTaskFallbackName') }}
                    </div>
                    <div class="file-meta">
                      <span v-if="task.total" style="margin-right: 4px">
                        {{ task.done || 0 }}/{{ task.total }}
                      </span>
                      <span>
                        {{
                          task.stageText ||
                          (task.status === 'paused'
                            ? t('assetLib.fileList.paused')
                            : getTaskStageText(task))
                        }}
                      </span>
                    </div>
                  </div>
                </div>
                <!-- 虚拟滚动顶部占位 -->
                <div
                  v-if="assetPaddingTop > 0"
                  class="virtual-scroll-padding"
                  :style="{ height: Math.max(0, assetPaddingTop - gridGapSize) + 'px' }"
                ></div>
                <div
                  v-for="file in visibleAssetFiles"
                  :key="file.assetKey"
                  class="file-item asset-item"
                  :class="{
                    'file-item-selected': isSelected(getItemId(file)),
                    'favorite-item': getFavoriteStatus(file.assetKey)
                  }"
                  :data-file-id="getItemId(file)"
                  :title="
                    libraryCaps.team
                      ? teamAsset.cardTitle(t('assetFileList.externalDragHint'), pathOfFile(file))
                      : t('assetFileList.externalDragHint')
                  "
                  draggable="true"
                  @click="handleItemClick(file, $event)"
                  @dblclick="handleItemDoubleClick(file)"
                  @contextmenu="handleRightClick($event, file)"
                  @dragstart="handleAssetDragStart($event, file)"
                  @drag="handleAssetDrag"
                  @dragend="handleAssetDragEnd"
                  @mouseenter="handleAssetCardEnter(file)"
                  @mouseleave="handleAssetMouseLeave"
                >
                  <div class="file-icon">
                    <template v-if="getThumbnailUrl(file)">
                      <div class="thumbnail-container">
                        <!-- 视频缩略图：使用 video 标签 + preload=metadata 只加载第一帧 -->
                        <video
                          v-if="isThumbnailVideo(file)"
                          :src="getThumbnailUrl(file)"
                          class="thumbnail-img"
                          preload="metadata"
                          muted
                          playsinline
                          @error="handleThumbImgError($event, file)"
                        ></video>
                        <!-- GIF 缩略图 (hover 时播放) -->
                        <img
                          v-else-if="isThumbnailGif(file)"
                          :src="getThumbnailUrl(file)"
                          alt=""
                          class="thumbnail-img gif-thumbnail"
                          loading="lazy"
                          @mouseenter="handleGifEnter"
                          @mouseleave="handleGifLeave"
                          @error="handleThumbImgError($event, file)"
                        />
                        <!-- 图片缩略图 -->
                        <img
                          v-else
                          :src="getThumbnailUrl(file)"
                          alt=""
                          class="thumbnail-img"
                          loading="lazy"
                          @error="handleThumbImgError($event, file)"
                        />
                        <!-- Hover 时显示的文件后缀标签 -->
                        <div v-if="getFileExtLabel(file)" class="thumbnail-hover-ext">
                          {{ getFileExtLabel(file) }}
                        </div>
                        <!-- 内嵌式底部边框 (ID Line) -->
                        <div
                          class="thumbnail-id-line"
                          :style="{ backgroundColor: getAssetTypeColorForFile(file) }"
                        ></div>
                      </div>
                    </template>
                    <template v-else>
                      <!-- 实心图标：根据资产类型着色 -->
                      <div class="solid-icon-wrapper">
                        <SolidFileIcon
                          :size="Math.max(32, Math.min(190, gridItemSize * 1))"
                          :color="getIconColor(file)"
                        />
                        <!-- 文件后缀标签：用于区分不同类型文件（无缩略图时） -->
                        <div v-if="getFileExtLabel(file)" class="file-ext-label">
                          {{ getFileExtLabel(file) }}
                        </div>
                      </div>
                    </template>

                    <PhStar
                      v-if="getFavoriteStatus(file.assetKey)"
                      weight="fill"
                      class="favorite-icon"
                    />
                    <!-- 团队工程：左上角签出角标（方案 2.2），外包参考的红点 -->
                    <TeamCardBadge v-if="libraryCaps.team" :path="pathOfFile(file)" />
                    <!-- 🔌 插件引擎版本标签 -->
                    <div
                      v-if="file.fileExtension === 'uplugin' && file.engineVersion"
                      class="engine-version-tag"
                      :title="t('assetFileList.engineVersion', { version: file.engineVersion })"
                    >
                      {{ file.engineVersion }}
                    </div>
                    <!-- 资产引擎版本角标（设置里开）。插件右上角已经常驻一个，不重复 -->
                    <div
                      v-else-if="showAssetVersion && file.engineVersion"
                      class="asset-version-tag"
                      :title="t('assetFileList.engineVersion', { version: file.engineVersion })"
                    >
                      {{ file.engineVersion }}
                    </div>
                  </div>
                  <div class="file-info">
                    <div
                      v-if="inlineEditId !== getItemId(file)"
                      class="file-name"
                      :title="file.assetName"
                    >
                      {{ file.assetName }}
                    </div>
                    <a-input
                      v-else
                      ref="inlineInputRef"
                      v-model:value="inlineEditValue"
                      class="inline-rename-input"
                      size="small"
                      :maxlength="256"
                      spellcheck="false"
                      @press-enter="confirmInlineRename"
                      @blur="confirmInlineRename"
                      @keydown.esc="cancelInlineRename"
                      @keydown.stop
                      @click.stop
                      @mousedown.stop
                      @dblclick.stop
                    />
                    <div class="file-meta">
                      <!-- 回收站里这一行改成删除时间：东西已经不在库里了，资产类型
                           不如「哪天删的」有用，而那是这个视图唯一排得上用场的时间 -->
                      <span
                        v-if="isTrashView"
                        class="file-date"
                        :title="t('assetFileList.restore.deletedTime', { time: trashTimeOf(file) })"
                        >{{ formatDate(trashTimeOf(file)) }}</span
                      >
                      <span
                        v-else
                        class="file-date"
                        :title="`${t('assetLib.fileList.modifiedTime')}: ${file.updated_at}\n${t(
                          'assetLib.fileList.fileSize'
                        )}: ${file.fileSize || 0}`"
                        >{{ file.classNameCn }}</span
                      >
                    </div>
                  </div>
                </div>
                <!-- 虚拟滚动底部占位 -->
                <div
                  v-if="assetPaddingBottom > 0"
                  class="virtual-scroll-padding"
                  :style="{ height: Math.max(0, assetPaddingBottom - gridGapSize) + 'px' }"
                ></div>
              </div>
              <!-- 加载更多指示器 -->
              <div v-if="isLoadingMore" class="loading-more-indicator">
                <AppSpin size="small" />
                <span>{{ t('assetFileList.loading') }}</span>
              </div>
            </div>
          </div>
        </AppSpin>
      </div>
      <!-- 闭合 scrollContainerRef -->
      <!-- 拖拽预览提示已抽取为全局组件 DragOverlay，由父级 AssetManagement 统一渲染与控制 -->
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      ref="contextMenuRef"
      :menu-items="currentContextMenuItems"
      @click="handleContextMenuClick"
    />

    <!-- 添加文件夹对话框 -->
    <AddFolderModal
      v-model:open="addFolderModalVisible"
      :folder-key="selectedFolderKey"
      @confirm="handleAddFolderConfirm"
    />

    <!-- 重命名资产对话框 -->
    <RenameAssetModal
      v-model:open="renameAssetModalVisible"
      :asset-key="renameAssetForm.assetKey"
      :asset-name="renameAssetForm.name"
      @confirm="handleRenameAssetConfirm"
    />

    <!-- 重命名文件夹对话框 -->
    <RenameFolderModal
      v-model:open="renameFolderModalVisible"
      :folder-key="renameFolderForm.folderKey"
      :folder-name="renameFolderForm.name"
      @confirm="handleRenameFolderConfirm"
    />

    <!-- 添加标签选择对话框 -->
    <TagSelectorModal
      v-model:open="tagSelectorVisible"
      :initial-selected-tag-ids="currentAssetTagIds"
      @confirm="handleAddTagsConfirm"
    />

    <!-- 文件夹标签选择对话框 -->
    <TagSelectorModal
      v-model:open="folderTagSelectorVisible"
      :initial-selected-tag-ids="currentFolderTagIds"
      @confirm="handleAddFolderTagsConfirm"
    />

    <!-- 选择导入工程对话框 -->
    <ImportToProjectModal
      v-model:open="importProjectModalVisible"
      :source="importProjectSource || currentRightClickAsset"
    />

    <!-- 颜色选择器对话框 -->
    <ColorPickerModal
      v-model:open="colorPickerVisible"
      :current-color="colorPickerTarget?.currentColor"
      @confirm="handleColorPickerConfirm"
    />

    <!-- 3D 模型缩略图生成器 -->
    <AssetThumbnailGenerator
      :queue="thumbnailQueue"
      @generated="handleThumbnailGenerated"
      @error="handleThumbnailError"
    />

    <!-- 批量删除确认对话框 -->
    <AppModal
      v-model:open="deleteConfirmVisible"
      :title="
        isNetworkVaultDelete
          ? t('assetFileList.deleteConfirm.network.title')
          : t('assetFileList.deleteConfirm.title')
      "
      :ok-text="t('assetFileList.deleteConfirm.okText')"
      :cancel-text="t('assetFileList.deleteConfirm.cancelText')"
      ok-danger
      :confirm-loading="deleteBatchLoading"
      @ok="handleDeleteConfirmOk"
    >
      <div class="delete-confirm-content">
        <p>
          {{
            t(
              isNetworkVaultDelete
                ? 'assetFileList.deleteConfirm.network.content'
                : 'assetFileList.deleteConfirm.content',
              {
                filesCount: deleteConfirmData.filesCount,
                foldersCount: deleteConfirmData.foldersCount
              }
            )
          }}
        </p>
        <!-- 共享库删掉就没了，本地库进「最近删除」还能恢复 —— 这两句不能说反 -->
        <p v-if="isNetworkVaultDelete" style="color: var(--color-danger-text)">
          {{ t('assetFileList.deleteConfirm.network.irreversible') }}
        </p>
        <p v-else style="color: var(--color-text-secondary)">
          {{ t('assetFileList.deleteConfirm.recoverable') }}
        </p>
        <!-- 「不再提示」只对可恢复的本地删除开放 -->
        <div v-if="!isNetworkVaultDelete" style="margin-top: 16px">
          <AppCheckbox v-model:checked="deleteDontAskAgain">{{
            t('assetFileList.deleteConfirm.dontAskAgain')
          }}</AppCheckbox>
        </div>
      </div>
    </AppModal>

    <!-- 拖拽跟随 - 自定义样式 -->
    <Teleport to="body">
      <div
        v-if="dragOverlayState.visible"
        class="asset-drag-overlay"
        :style="{ left: dragOverlayState.x + 'px', top: dragOverlayState.y + 'px' }"
      >
        <div class="drag-icon">
          <!-- 不写死白色：这块浮层的底是 --color-bg-surface，浅色主题下是纯白 -->
          <PhFileText style="font-size: 16px" />
        </div>
        <span class="drag-text">{{ dragOverlayState.text }}</span>
      </div>
    </Teleport>

    <!-- 空格键全屏预览缩略图 -->
    <Teleport to="body">
      <div
        v-if="thumbnailPreviewVisible && thumbnailPreviewUrl"
        class="thumbnail-fullscreen-preview"
        @click="thumbnailPreviewVisible = false"
      >
        <div class="preview-backdrop"></div>
        <div class="preview-content">
          <!-- 视频预览 -->
          <video
            v-if="thumbnailPreviewIsVideo"
            :src="thumbnailPreviewUrl"
            class="preview-media"
            autoplay
            loop
            playsinline
          ></video>
          <!-- 图片预览 -->
          <img
            v-else
            :src="thumbnailPreviewUrl"
            alt="Preview"
            class="preview-media"
            @error="handlePreviewImageError"
          />
        </div>
      </div>
    </Teleport>

    <!-- 重新剪裁缩略图弹窗 -->
    <ImageCropperModal
      v-model:open="recropModalOpen"
      :image="recropImage"
      @confirm="onRecropConfirm"
    />
    <CatalogDownloadModal
      v-if="libraryStore.activeServerKey"
      :open="serverDownloadOpen"
      :library-key="libraryStore.activeServerKey"
      :items="serverDownloadItems"
      @close="serverDownloadOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AssetLoadingContent from './AssetLoadingContent.vue'
import { confirmDialog } from '@renderer/utils/dialog'
import AppModal from '@renderer/components/AppModal.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import { computed, ref, reactive, onMounted, onUnmounted, watch, nextTick, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInitialLoading } from '@renderer/composables/useInitialLoading'
import { useRouter } from 'vue-router'
import { message } from '@renderer/utils/messageManager'
import {
  PhArrowClockwise,
  PhArrowUUpLeft,
  PhArrowsClockwise,
  PhCamera,
  PhCaretDown,
  PhCaretRight,
  PhCheckCircle,
  PhCloudArrowUp,
  PhDownloadSimple,
  PhFileZip,
  PhFileText,
  PhFolder,
  PhFolderOpen,
  PhFolderPlus,
  PhImage,
  PhPalette,
  PhPencilSimple,
  PhStar,
  PhTag,
  PhTrash,
  PhTrashSimple,
  PhExport
} from '@phosphor-icons/vue'
import defaultBlueprintThumb from '@renderer/assets/imgs/ue/ue-item-blueprint.png'
import icPluginsIcon from '@renderer/assets/icon/ic_plugins.svg'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import AddFolderModal from './modals/AddFolderModal.vue'
import RenameAssetModal from './modals/RenameAssetModal.vue'
import RenameFolderModal from './modals/RenameFolderModal.vue'
import ImportToProjectModal from './modals/ImportToProjectModal.vue'
import ColorPickerModal from './modals/ColorPickerModal.vue'
import ImageCropperModal from './modals/ImageCropperModal.vue'
import SolidFileIcon from '@renderer/components/SolidFileIcon.vue'
import AssetThumbnailGenerator from './AssetThumbnailGenerator.vue'
import { useAssetContext } from '../composables/useAssetContext'
import { useFileSelection } from '../composables/useFileSelection'
import { useVirtualScroll } from '../composables/useVirtualScroll'
import { getActiveLibrarySource } from '../data/activeLibrarySource'
import type { LibraryFavoritesApi } from '../data/AssetLibrarySource'
import { useFavoriteStore } from '@renderer/store/modules/favoriteStore'
import TagSelectorModal from '@renderer/components/TagSelector/TagSelectorModal.vue'
import { useVaultStore, VaultType } from '@renderer/store/modules/vaultStore'
import {
  buildThumbnailUrl,
  buildCompressedThumbnailUrl,
  buildDirectFileUrl
} from '@renderer/utils/thumbnails'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { listThumbnailUrl } from '@renderer/utils/listThumbnail'
import { resolveAssetUrl } from '@renderer/utils/assetAccess'
import { getAssetTypeColor } from '@renderer/utils/tool'
import assetDataAPI from '@renderer/api/assetData'
import { dashScopeAPI } from '@renderer/api/dashScope'
import { NO_VISION_MODEL_ERROR_KEY } from '@core/shared/aiNamingErrorKey'
import { startNativeFileDrag } from '@renderer/api/nativeFileDrag'
import { handleExternalAssetDrag } from '../utils/externalAssetDrag'
import { useImportTasksStore } from '@renderer/store/modules/importTasks'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'
import CatalogDownloadModal from '../catalog/CatalogDownloadModal.vue'
import TeamCardBadge from '../team/TeamCardBadge.vue'
import { useShowAssetVersion } from '../utils/assetVersionBadge'
import { pathOfFile, useTeamAsset } from '../team/useTeamAsset'
import type { CatalogAssetSummary } from '@core/shared/catalogLibrary'
import { assetFolderAPI } from '@renderer/api/assetFolder'
import assetTagAPI from '@renderer/api/assetTag'
import folderTagAPI from '@renderer/api/folderTag'
import { useBaiduyunStore } from '@renderer/store/modules/baiduyun'
import { useWebdavStore } from '@renderer/store/modules/webdav'
import {
  handleVideoAssetImported,
  checkFFmpegAvailable,
  batchHandleVideoAssets
} from '@renderer/hooks/useVideoThumbnail'
import { isVideoFile } from '@renderer/utils/videoThumbnail'
import { aigcEventBus, AIGC_EVENTS } from '@renderer/views/AIGCStudio/aigcEventBus'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { useAssetSelectionStore } from '@renderer/store/modules/assetSelectionStore'
import {
  buildBrowsePath,
  getNetworkBrowseBasePath,
  isHttpUrl,
  normalizeVaultRelativePath,
  openBrowsePath,
  pathStartsWithBase
} from '../utils/networkBrowsePath'
import { resolveErrorText } from '../utils/assetVaultHelpers'

type AssetDataRow = {
  assetKey: string
  folderKey?: string
  assetName: string
  updated_at?: string
  imgLocalPath?: string
  originPath?: string
  filePath?: string
  [key: string]: any
}

type FolderItem = {
  id: string
  name: string
  type: 'folder'
  folderType?: string
  path?: string
  originPath?: string
  modifiedTime?: string
  [key: string]: any
}

interface Props {
  currentPath: string
  files: Array<AssetDataRow | FolderItem>
  loading: boolean
  selectedFolderKey?: string
  displaySize?: number
  importTasks?: Array<{
    id: string
    type: 'file' | 'folder'
    name?: string
    progress?: number
    total?: number
    done?: number
    stageText?: string
    stage?: string
    status?: string
    /** 下载任务所属的目标文件夹 key，用于按目录过滤显示 */
    folderKey?: string
    /** 任务所属的保管库 ID，用于隔离不同保管库的进度显示 */
    vaultId?: string
    /** 任务类型：导入到资产库 或 导入到工程 */
    taskType?: 'vault-import' | 'project-import'
    /** 目标工程名称（仅 project-import 类型使用） */
    projectName?: string
    /** 源文件夹 keys（工程导入时记录来源文件夹，用于在对应文件夹上显示进度覆盖层） */
    sourceFolderKeys?: string[]
    /** 导入创建的根文件夹 key（folderInit 完成后回传，用于 vault-import overlay） */
    rootFolderKey?: string
  }>
  /** 是否还有更多数据可加载 */
  hasMore?: boolean
  /** 是否正在加载更多 */
  isLoadingMore?: boolean
  /**
   * 换了一批列表内容的计数（排序 / 筛选 / 搜索 / 换文件夹时加一，翻页不加）。
   * 变了就把两个分区的折叠状态摊开 —— 详见下面那个 watch
   */
  listGeneration?: number
  ensureFilesLoaded?: (assetKey?: string) => Promise<boolean>
  selectionScope?: string
}

interface Emits {
  (e: 'file-click', file: AssetDataRow): void
  (e: 'file-open', file: AssetDataRow): void
  (e: 'folder-click', file: FolderItem): void
  (e: 'folder-select', file: FolderItem): void
  (e: 'drag-overlay-start', payload: DragOverlayStartPayload): void
  (e: 'drag-overlay-end'): void
  (e: 'empty-click'): void
  /** 滚动到底部触发加载更多 */
  (e: 'load-more'): void
  /**
   * 在文件夹视图中显示（Ctrl+B / 右键菜单）。
   * 给了 assetKey 就会在跳过去之后把那个资产选中。
   */
  (e: 'locate-in-folder', folderKey?: string, assetKey?: string): void
}
const emit = defineEmits<Emits>()

interface DragOverlayStartPayload {
  text: string
  counts?: { files: number; folders: number }
  items?: Array<{ id: string; type: 'file' | 'folder' }>
}

// emit 事件类型已统一到上方的 Emits 接口

const props = defineProps<Props>()
const initialLoading = useInitialLoading(
  () => props.loading,
  () => props.files.length > 0
)

// 折叠状态
const isFolderSectionExpanded = ref(true)
const isFileSectionExpanded = ref(true)

/**
 * 换一批内容就把折叠摊开。
 *
 * 折叠是「我现在不想看这一堆」，说的是眼前这一批结果。排序、筛选、搜索、换文件夹
 * 之后内容整个换掉了，再让上一批的折叠继续生效，用户看到的就是一个空列表 ——
 * 排序完像是排没了，搜完像是没搜到，而唯一能解释它的那个箭头缩在标题行里。
 *
 * 翻页（加载更多）不算换批，listGeneration 不动，折叠原样保留。
 */
watch(
  () => props.listGeneration,
  () => {
    isFolderSectionExpanded.value = true
    isFileSectionExpanded.value = true
  }
)

// 延迟显示导入任务逻辑，避免快速完成的任务导致列表跳动
const visibleTaskIds = reactive(new Set<string>())
const delayedVisibilityTimers = new Map<string, NodeJS.Timeout>()

// 计算当前应该显示的导入任务（只显示属于当前文件夹且属于当前保管库的任务）
// 注意：project-import 类型任务使用文件夹覆盖层显示，不需要占位卡片
const effectiveImportTasks = computed(() => {
  const currentFolderKey = props.selectedFolderKey || 'ALL'
  const currentVaultId = vaultStore.currentVault?.id
  // 🔧 收集当前文件列表中已存在的真实文件夹 ID，用于去重
  const realFolderIds = new Set(
    props.files.filter((f) => f.type === 'folder').map((f) => ('id' in f ? f.id : ''))
  )
  return (props.importTasks || []).filter((t) => {
    // 任务必须可见
    if (!visibleTaskIds.has(t.id)) return false
    // 🟢 project-import 任务使用文件夹覆盖层，不显示占位卡片
    if (t.taskType === 'project-import') return false
    // 已结束但有问题的任务留在右下角进度挂件里等用户查看/关掉，网格里不再占一张 100% 的卡
    if (t.status === 'error') return false
    // 🔒 保管库隔离检查：如果任务属于其他保管库，则不显示
    if (t.vaultId && currentVaultId && t.vaultId !== currentVaultId) return false
    // 如果任务没有指定 folderKey，默认显示在 ALL 文件夹
    const taskFolderKey = t.folderKey || 'ALL'
    // 只显示属于当前文件夹的任务
    if (taskFolderKey !== currentFolderKey) return false
    // 🔧 vault-import 任务：如果已有 rootFolderKey 且真实文件夹已出现，
    //    则不显示占位卡片（改为在真实文件夹卡片上显示 overlay）
    if (t.type === 'folder' && t.rootFolderKey && realFolderIds.has(t.rootFolderKey)) {
      return false
    }
    return true
  })
})

/**
 * 计算任务 id 集合字符串，用于 watch 监听任务新增/移除
 * 避免 progress 变化触发 watch，显著降低渲染开销
 */
const importTaskIdsKey = computed(() => {
  return (props.importTasks || [])
    .map((t) => t.id)
    .sort()
    .join(',')
})

watch(
  importTaskIdsKey,
  () => {
    const newTasks = props.importTasks || []
    const newTaskIds = new Set(newTasks.map((t) => t.id))

    // 1. 处理新增任务
    newTasks.forEach((task) => {
      // 如果任务不可见且没有在等待显示，则开启计时器
      if (!visibleTaskIds.has(task.id) && !delayedVisibilityTimers.has(task.id)) {
        const timer = setTimeout(() => {
          // 再次检查任务是否存在于最新的 props 中
          const currentTaskIds = new Set((props.importTasks || []).map((t) => t.id))
          if (currentTaskIds.has(task.id)) {
            visibleTaskIds.add(task.id)
          }
          delayedVisibilityTimers.delete(task.id)
        }, 100) // 100ms 延迟，过滤掉瞬间完成的任务
        delayedVisibilityTimers.set(task.id, timer)
      }
    })

    // 2. 处理移除的任务（立即移除）
    for (const id of visibleTaskIds) {
      if (!newTaskIds.has(id)) {
        visibleTaskIds.delete(id)
      }
    }

    // 3. 清理已移除任务的未触发计时器
    for (const [id, timer] of delayedVisibilityTimers) {
      if (!newTaskIds.has(id)) {
        clearTimeout(timer)
        delayedVisibilityTimers.delete(id)
      }
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  delayedVisibilityTimers.forEach((timer) => clearTimeout(timer))
  delayedVisibilityTimers.clear()
})

// 路由
const router = useRouter()

// 获取上下文
const assetContext = useAssetContext()

// 注入选中资产（父级 provide 的 ref）
const selectedAsset = inject('selectedAsset', null) as any

// 本地收藏状态映射（直接接口校验，无 Pinia 依赖）
const favoriteStatusMap = ref<Record<string, boolean>>({})
const getFavoriteStatus = (assetKey: string): boolean => {
  return !!favoriteStatusMap.value[assetKey]
}
const setFavoriteStatus = (assetKey: string, isFav: boolean) => {
  favoriteStatusMap.value[assetKey] = !!isFav
}

// 本地文件夹收藏状态映射
const folderFavoriteStatusMap = ref<Record<string, boolean>>({})
const getFolderFavoriteStatus = (folderKey: string): boolean => {
  return !!folderFavoriteStatusMap.value[folderKey]
}
const setFolderFavoriteStatus = (folderKey: string, isFav: boolean) => {
  folderFavoriteStatusMap.value[folderKey] = !!isFav
}

// ==================== 空格键全屏预览缩略图 ====================
/**
 * 当前 hover 的资产（用于空格键快速预览）
 */
const hoveredAsset = ref<AssetDataRow | FolderItem | null>(null)
const hoveredAssetThumbnailUrl = ref<string | undefined>(undefined)
// 原图 URL（用于空格键预览，不使用 _thumb 压缩版）
const hoveredAssetOriginalUrl = ref<string | undefined>(undefined)

/**
 * 全屏预览状态
 */
const thumbnailPreviewVisible = ref(false)
const thumbnailPreviewUrl = ref<string | undefined>(undefined)
const thumbnailPreviewIsVideo = ref(false)

// Vault 用于缩略图构造
const vaultStore = useVaultStore()
const importTasksStore = useImportTasksStore()

// ==================== 工程整包取回（HTTP 服务器库） ====================
// 整包上传的工程在服务器上是一个 zip / rar / 7z；取回就是下到用户选的目录，zip 自动解开。
const isHttpServerVault = computed(() =>
  /^https?:\/\//.test(vaultStore.currentVault?.networkPath || '')
)
const ARCHIVE_ASSET_EXTENSIONS = ['zip', 'rar', '7z']
const isArchiveAsset = (asset: unknown): boolean => {
  const record = asset as { fileExtension?: string; ext?: string } | null | undefined
  const raw = String(record?.fileExtension || record?.ext || '')
  return ARCHIVE_ASSET_EXTENSIONS.includes(raw.toLowerCase().replace(/^\./, ''))
}

const handlePullProjectArchive = async (): Promise<void> => {
  const asset = currentRightClickAsset.value as
    | { assetName?: string; filePath?: string; fileExtension?: string }
    | null
    | undefined
  if (!asset?.filePath) {
    message.error(t('assetManagement.import.unknownError'))
    return
  }
  const ret = await window.api.dialog.showOpenDialog({
    title: t('assetManagement.import.selectPullDestTitle'),
    properties: ['openDirectory']
  })
  if (ret.canceled || !ret.filePaths || ret.filePaths.length === 0) return
  const destDir = ret.filePaths[0]
  const fileName =
    String(asset.filePath).replace(/\\/g, '/').split('/').pop() ||
    `${asset.assetName || 'project'}.${asset.fileExtension || 'zip'}`
  const taskId = `archive-pull:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  importTasksStore.addTask({
    id: taskId,
    type: 'file',
    name: fileName,
    progress: 0,
    stageText: t('assetManagement.import.projectArchivePulling'),
    status: 'running',
    folderName: destDir.split(/[\\/]/).pop() || destDir,
    vaultId: vaultStore.currentVault?.id
  })
  try {
    const result = await assetDataAPI.pullProjectArchive({
      remotePath: asset.filePath,
      fileName,
      destDir,
      taskId
    })
    message.success(
      t(
        result.extracted
          ? 'assetManagement.import.projectArchivePulled'
          : 'assetManagement.import.projectArchiveDownloadedOnly',
        { name: fileName, path: result.localPath, files: result.fileCount, rate: result.mbPerSec }
      ),
      8
    )
    // 打不开就说一声：东西已经在盘上了，但用户等的是资源管理器弹出来
    try {
      const opened = await window.api.shell.showItemInFolder(result.localPath)
      if (!opened.success) {
        message.warning(t('assetLib.contextMenu.openLocalPathFailed', '打开本地路径失败'))
      }
    } catch (openErr) {
      message.warning(t('assetLib.contextMenu.openLocalPathFailed', '打开本地路径失败'))
      console.error('[ProjectArchive] show in folder failed:', openErr)
    }
  } catch (error) {
    // 失败提示由 asset:folderImportError 事件统一弹出
    console.error('[ProjectArchive] pull failed:', error)
  }
}
const currentVault = computed(() => vaultStore.currentVault)
const isHttpNetworkVault = computed(
  () =>
    currentVault.value?.vaultType === VaultType.NETWORK &&
    isHttpUrl(currentVault.value?.networkPath || '')
)

/**
 * 这次删除会不会落到共享库上。
 *
 * 共享库和本地库的删除是两件事：本地是软删除（进「最近删除」，还能恢复），
 * 共享库是硬删除，连 NAS 上的目录一起删，团队里所有人都会失去它，没有回收站。
 * 后果差这么远，确认文案和「不再提示」的适用范围都不能共用一套。
 */
const isNetworkVaultDelete = computed(() => currentVault.value?.vaultType === VaultType.NETWORK)

/**
 * 判断当前保管库是否为引用类型
 * 引用类型保管库的文件保留在原始位置，因此可以打开本地路径
 */
const isReferenceVault = computed(() => {
  return currentVault.value?.vaultType === VaultType.REFERENCE
})
// 收藏数量 store（用于通知刷新）
const favoriteStore = useFavoriteStore()
const tabsStore = useTabsStore()
const selectionStore = useAssetSelectionStore()
const { t, locale } = useI18n()

// ---- 当前数据源能做什么（服务器库时，本地库的改动类操作不出现）
const libraryStore = useAssetLibraryStore()
const libraryCaps = computed(() => libraryStore.capabilities)
/** 设置里「显示资产版本」开关 */
const showAssetVersion = useShowAssetVersion()
// 团队工程的那几件事（签出角标、悬停两行、右键三项）都在 useTeamAsset 里
const teamAsset = useTeamAsset()
/** 多选时右键「发给外包」「收回」作用于选中的那几个（工程内路径） */
/** 悬停卡片：原来的悬停处理 + 团队工程取「谁最后改的」（悬停两行，方案 4.5） */
const handleAssetCardEnter = (file: AssetDataRow): void => {
  handleAssetMouseEnter(file)
  if (libraryCaps.value.team) void teamAsset.prefetch(pathOfFile(file))
}
const selectedAssetRowsForTeam = (): string[] =>
  props.files
    .filter((file) => isSelected(getItemId(file)))
    .map((file) => pathOfFile(file))
    .filter((path): path is string => Boolean(path))
const capabilityReason = (name: string): string => {
  const key = libraryCaps.value.reasons[name]
  return key ? t(key) : ''
}
/**
 * 收藏走当前数据源：本地库存在保管库里（和原来一样，用户 1 + 当前保管库），
 * 服务器库存在本机、按库和资产 id 记。调用点不用分辨是哪一种。
 */
const favorites = (): LibraryFavoritesApi => getActiveLibrarySource().favorites
const checkFavorites = (ids: string[]): Promise<Record<string, boolean>> =>
  libraryCaps.value.canFavorite ? favorites().batchCheck(ids) : Promise.resolve({})
const checkFolderFavorite = (id: string): Promise<boolean> =>
  libraryCaps.value.canFavorite ? favorites().isFolderFavorite(id) : Promise.resolve(false)

/** 服务器库的"导入到工程"：选中的（或右键的那一个）资产交给下载对话框（lore 取文件再复制进工程） */
const serverDownloadOpen = ref(false)
const serverDownloadItems = ref<CatalogAssetSummary[]>([])
/** 服务器库的行（ServerLibrarySource.mapAsset）里给下载用的那几个字段 */
interface ServerRow {
  type?: string
  assetKey?: string
  id?: string
  catalogId?: number
  catalogPath?: string
  catalogDirId?: number
  catalogRepository?: string
  name?: string
  assetName?: string
  ext?: string
  className?: string | null
  engineVersion?: string | null
  fileSize?: number
}
const toCatalogItem = (row: ServerRow): CatalogAssetSummary => ({
  id: Number(row.catalogId),
  path: String(row.catalogPath ?? ''),
  name: String(row.name ?? row.assetName ?? ''),
  dirId: Number(row.catalogDirId ?? 0),
  repository: String(row.catalogRepository ?? ''),
  ext: String(row.ext ?? ''),
  class: row.className ?? null,
  engine: row.engineVersion ?? null,
  size: Number(row.fileSize ?? 0),
  modifiedMs: 0,
  tags: []
})
const openServerDownload = (): void => {
  const clicked = currentRightClickAsset.value as ServerRow | null
  const rows = (selectedItems.value as ServerRow[]).filter(
    (item) => item.type !== 'folder' && item.catalogId !== undefined
  )
  const chosen =
    clicked && rows.some((row) => getItemId(row) === getItemId(clicked))
      ? rows
      : clicked
        ? [clicked]
        : rows
  serverDownloadItems.value = chosen.filter((row) => row.catalogId !== undefined).map(toCatalogItem)
  if (serverDownloadItems.value.length > 0) serverDownloadOpen.value = true
}

/**
 * 判断当前是否处于回收站（最近删除）视图
 */
const isTrashView = computed(() => {
  return selectionStore.selectedShortcut === 'recent'
})

/**
 * 回收站条目的「删除时间」。
 *
 * deletedAt 是后加的列，在那之前删掉的行是空的 —— 退回 updated_at（软删除那一刻
 * 也写了它），至少不会显示成一片空白。
 */
const trashTimeOf = (file: {
  deletedAt?: unknown
  updated_at?: unknown
  modifiedTime?: unknown
}): string => String(file?.deletedAt || file?.updated_at || file?.modifiedTime || '')

const getTaskStageText = (task: any) => {
  const stage = task.stage
  if (stage === 'parsing') return t('assetLib.import.parsing')
  if (stage === 'preprocessing') return t('assetLib.import.preprocessing')
  if (stage === 'backing_up') return t('assetLib.import.backing_up')
  if (stage === 'writing') return t('assetLib.import.writing')
  if (stage === 'uploading') return t('assetLib.import.uploading')
  if (stage === 'syncing_manifest') return t('assetLib.import.syncing_manifest')
  return t('assetLib.fileList.importing')
}

/**
 * 自定义插件图标加载失败过的地址。
 *
 * 记下来而不是就地改 img.src —— 内置的兜底图标是白色单色字形，
 * 得走 mask 才能跟着主题变色，而 mask 改不了 <img> 里的颜色。
 * 记在这里，模板就能退回到那个 <span class="mono-icon">。
 */
const failedPluginIcons = ref(new Set<string>())

const handlePluginIconError = (src?: string): void => {
  if (src) failedPluginIcons.value = new Set(failedPluginIcons.value).add(src)
}

/**
 * 缩略图 _thumb 压缩版加载失败时，自动回退到原图
 * 旧资产没有 _thumb.jpg 文件，需要回退到原始缩略图
 */
const handleThumbImgError = (event: Event, file: any) => {
  const el = event.target as HTMLImageElement | HTMLVideoElement
  if (!el || !el.src) return
  // 服务器库的缩略图取不到（没有图、签名过期、离线）：记下来，改画图标，不再重试
  if (el.src.startsWith('uebox-preview:')) {
    failedListThumbnails.value = new Set(failedListThumbnails.value).add(el.src)
    return
  }
  if (
    el.src.includes('listThumbnail=400') &&
    (!el.src.includes('_thumb') ||
      (el as HTMLImageElement & { __thumbFallback?: boolean }).__thumbFallback)
  ) {
    failedListThumbnails.value = new Set(failedListThumbnails.value).add(
      getThumbnailSourceUrl(file)
    )
    return
  }
  // 只处理 _thumb 版本的回退
  if (!el.src.includes('_thumb')) return
  // 防止无限循环
  if ((el as any).__thumbFallback) return
  ;(el as any).__thumbFallback = true

  const isFolder = file?.type === 'folder'
  let originalUrl: string | undefined
  if (isFolder) {
    originalUrl = getOriginalFolderCoverUrl(file as FolderItem)
  } else {
    originalUrl = getOriginalThumbnailUrl(file)
  }
  if (originalUrl) {
    el.src = file?.type === 'folder' ? originalUrl : listThumbnailUrl(originalUrl) || originalUrl
  }
}

/**
 * 全屏原图预览加载失败时，回退到列表里已经可显示的缩略图 URL
 * 典型场景：NAS V2 上只有 _thumb 或原图丢失
 */
const handlePreviewImageError = (event: Event) => {
  const el = event.target as HTMLImageElement
  if (!el || !thumbnailPreviewUrl.value) return

  const fallbackUrl = hoveredAssetThumbnailUrl.value
  if (!fallbackUrl || fallbackUrl === thumbnailPreviewUrl.value) return
  if ((el as any).__previewFallback) return
  ;(el as any).__previewFallback = true
  thumbnailPreviewUrl.value = fallbackUrl
  el.src = fallbackUrl
}

// 云端上传 store
const baiduyunStore = useBaiduyunStore()
const webdavStore = useWebdavStore()

// 使用 baiduyunStore 中的全局上传任务状态（切换页面不会丢失）
// FolderUploadTask 类型从 store 导出

/**
 * 获取资产/文件夹的本地文件路径
 * - 引用模式：返回文件的原始路径（originPath）
 * - 备份模式：返回保管库路径拼接相对路径（备份后的路径）
 * - 网络库模式：返回网络路径（networkPath + 相对路径）
 * @param item 资产或文件夹对象
 */
const getLocalFilePath = (item: AssetDataRow | FolderItem): string | null => {
  const vaultPath = currentVault.value?.path
  const isBackup = currentVault.value?.vaultType === VaultType.BACKUP
  const isNetwork = currentVault.value?.vaultType === VaultType.NETWORK
  const networkPath = currentVault.value?.networkPath

  if ((item as FolderItem).type === 'folder') {
    const folder = item as FolderItem

    // 网络库模式：使用 networkPath + 相对路径
    if (isNetwork && networkPath && folder.path) {
      // folder.path 对于网络库存储的可能是：
      // 1. 网络路径内的相对路径 -> 需要拼接 networkPath
      // 2. 已经是绝对本地路径 (C:/...) -> 直接使用
      // 3. 已经是 UNC 路径 (\\...) -> 直接使用
      if (/^[a-zA-Z]:/.test(folder.path)) {
        // 已经是绝对本地路径，直接使用
        return folder.path
      }
      if (folder.path.startsWith('\\\\') || folder.path.startsWith('//')) {
        // 已经是 UNC 路径，直接使用
        return folder.path
      }
      // 相对路径，需要拼接 networkPath
      // 移除 folder.path 中的 'ALL/' 或 'ALL\' 前缀（ALL 是虚拟根目录，不应出现在实际路径中）
      let cleanFolderPath = folder.path
      // 移除开头的斜杠
      cleanFolderPath = cleanFolderPath.replace(/^[/\\]+/, '')
      // 移除 ALL 前缀
      if (cleanFolderPath.startsWith('ALL/') || cleanFolderPath.startsWith('ALL\\')) {
        cleanFolderPath = cleanFolderPath.substring(4)
      } else if (cleanFolderPath === 'ALL') {
        cleanFolderPath = ''
      }
      // 再次清理开头斜杠
      cleanFolderPath = cleanFolderPath.replace(/^[/\\]+/, '')

      // 构建完整路径，保留 UNC 前缀
      // networkPath 格式: \\192.168.31.88\网络资产库 或 //192.168.31.88/网络资产库
      let fullPath: string
      if (!cleanFolderPath) {
        // 如果路径为空（ALL根目录），直接返回 networkPath
        fullPath = networkPath
      } else {
        // 移除 networkPath 末尾的斜杠
        const trimmedNetworkPath = networkPath.replace(/[/\\]+$/, '')
        fullPath = `${trimmedNetworkPath}/${cleanFolderPath}`
      }

      // 标准化路径：将所有反斜杠转为正斜杠，但保留 UNC 前缀
      // 检测 UNC 前缀
      const isUNC = fullPath.startsWith('\\\\') || fullPath.startsWith('//')
      // 转换所有反斜杠为正斜杠
      fullPath = fullPath.split('\\').join('/')
      // 如果是 UNC 路径，确保开头是 //
      if (isUNC && !fullPath.startsWith('//')) {
        fullPath = '/' + fullPath // 补充缺失的斜杠
      }
      return fullPath
    }

    // 备份模式：优先使用保管库路径拼接文件夹的相对路径
    if (isBackup && vaultPath && folder.path) {
      // 如果 path 是相对路径（不以盘符开头），拼接保管库路径
      if (!/^[a-zA-Z]:/.test(folder.path)) {
        return `${vaultPath}/${folder.path}`.replace(/\\/g, '/')
      }
      // 如果 path 已经是绝对路径（备份失败或旧数据），直接使用
      return folder.path
    }

    // 引用模式：使用 originPath
    if (folder.originPath) {
      return folder.originPath
    }
    return folder.path || null
  }

  // 资产文件
  const asset = item as AssetDataRow

  // 网络库模式：优先使用 originPath（同步时已存储完整网络路径）
  if (isNetwork && networkPath) {
    // 优先使用 originPath - 它存储的是完整的网络路径
    // (在 networkVault:syncToLocalSQLite 中设置为 `${networkPath}\\${asset.path}`)
    if (asset.originPath) {
      // 检查 originPath 是否是有效的网络路径（UNC 格式）
      if (asset.originPath.startsWith('\\\\') || asset.originPath.startsWith('//')) {
        return asset.originPath
      }
      // 检查 originPath 是否已包含 networkPath
      const normalizedOrigin = asset.originPath.replace(/\\/g, '/')
      const normalizedNetwork = networkPath.replace(/\\/g, '/')
      if (normalizedOrigin.startsWith(normalizedNetwork)) {
        return asset.originPath
      }
    }

    // 回退：使用 filePath 拼接
    if (asset.filePath) {
      // filePath 对于网络库存储的可能是：
      // 1. 网络路径内的相对路径 -> 需要拼接 networkPath
      // 2. 已经是绝对本地路径 (C:/...) -> 这是错误的，应该拼接 networkPath 和文件名
      // 3. 已经是 UNC 路径 (\\...) -> 直接使用
      if (asset.filePath.startsWith('\\\\') || asset.filePath.startsWith('//')) {
        // 已经是 UNC 路径，直接使用
        return asset.filePath
      }
      if (/^[a-zA-Z]:/.test(asset.filePath)) {
        // 是本地绝对路径（错误情况），尝试提取文件名并拼接到网络路径
        // 这种情况通常发生在旧数据或导入时路径处理不当
        console.warn('[getLocalFilePath] 网络库资产存储了本地绝对路径，尝试修正:', asset.filePath)
        const fileName = asset.filePath.split(/[/\\]/).pop() || asset.assetName
        return `${networkPath}/${fileName}`.replace(/\\/g, '/')
      }
      // 相对路径，需要拼接 networkPath
      // 移除 networkPath 末尾和 filePath 开头的斜杠，避免双斜杠
      const cleanNetworkPath = networkPath.replace(/[\\/\\\\]+$/, '')
      // 移除 filePath 中的 'ALL/' 或 'ALL\\' 前缀（ALL 是虚拟根目录，不应出现在实际路径中）
      let cleanFilePath = asset.filePath.replace(/^[\\/\\\\]+/, '')
      if (cleanFilePath.startsWith('ALL/') || cleanFilePath.startsWith('ALL\\\\')) {
        cleanFilePath = cleanFilePath.substring(4)
      }
      // 再次清理开头斜杠
      cleanFilePath = cleanFilePath.replace(/^[\\/\\\\]+/, '')
      return `${cleanNetworkPath}/${cleanFilePath}`.replace(/\\\\/g, '/')
    }
  }

  // 备份模式：优先使用保管库路径拼接 filePath
  if (isBackup && vaultPath && asset.filePath) {
    // 如果 filePath 是相对路径（不以盘符开头），拼接保管库路径
    if (!/^[a-zA-Z]:/.test(asset.filePath)) {
      return `${vaultPath}/${asset.filePath}`.replace(/\\/g, '/')
    }
    // 如果 filePath 已经是绝对路径（备份失败或旧数据），直接使用
    return asset.filePath
  }

  // 引用模式：使用 originPath
  if (asset.originPath) {
    return asset.originPath
  }

  // 引用模式下的库内文件（如 assetData/...）：拼接保管库路径
  if (vaultPath && asset.filePath && !/^[a-zA-Z]:/.test(asset.filePath)) {
    return `${vaultPath}/${asset.filePath}`.replace(/\\/g, '/')
  }

  return asset.filePath || null
}

const getNetworkBrowseUnavailableMessage = (): string => {
  if (
    currentVault.value?.vaultType === VaultType.NETWORK &&
    isHttpUrl(currentVault.value?.networkPath || '') &&
    !currentVault.value?.browsePath
  ) {
    return t('assetFileList.browsePathUnavailable')
  }

  return t('assetLib.contextMenu.noFilePath', '无法获取文件路径')
}

const getAssetBrowseFileName = (asset: AssetDataRow): string => {
  const ext = String(asset.fileExtension || asset.ext || '')
    .trim()
    .replace(/^\./, '')
  const assetName = String(asset.assetName || '').trim()

  if (assetName) {
    if (ext && !assetName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      return `${assetName}.${ext}`
    }
    return assetName
  }

  const sourcePath = String(asset.originPath || asset.filePath || '').trim()
  return sourcePath ? (sourcePath.split(/[\\/]/).pop() ?? '') : ''
}

const getAssetBrowsePath = async (asset: AssetDataRow): Promise<string | null> => {
  const vault = currentVault.value
  if (!vault) return null

  if (vault.vaultType !== VaultType.NETWORK) {
    return getLocalFilePath(asset)
  }

  const browseRoot = getNetworkBrowseBasePath(vault)
  if (!browseRoot) return null

  const fileName = getAssetBrowseFileName(asset)
  if (!fileName) return null

  if (asset.folderKey && asset.folderKey !== 'ALL') {
    const folder = await assetFolderAPI.getByKey(asset.folderKey)
    const folderRelativePath = normalizeVaultRelativePath(folder?.fullPath)
    return buildBrowsePath(
      browseRoot,
      folderRelativePath ? `${folderRelativePath}/${fileName}` : fileName
    )
  }

  if (asset.originPath && pathStartsWithBase(asset.originPath, browseRoot)) {
    return buildBrowsePath(asset.originPath)
  }

  if (asset.filePath && !/^[a-zA-Z]:/.test(asset.filePath)) {
    return buildBrowsePath(browseRoot, asset.filePath)
  }

  return buildBrowsePath(browseRoot, fileName)
}

const buildFolderBrowsePath = async (folderKey: string): Promise<string | null> => {
  const browseRoot = getNetworkBrowseBasePath(currentVault.value)
  if (!browseRoot) return null

  if (folderKey === 'ALL') {
    return buildBrowsePath(browseRoot)
  }

  const folder = await assetFolderAPI.getByKey(folderKey)
  const relativePath = normalizeVaultRelativePath(folder?.fullPath)
  return buildBrowsePath(browseRoot, relativePath)
}

/**
 * 获取文件夹封面 URL
 * @param file 文件夹对象
 */
const getFolderCoverUrl = (file: FolderItem): string | undefined => {
  if (!file.img) return undefined
  if (/^(http|file)/i.test(file.img)) {
    return toLocalResourceUrl(file.img)
  }

  const vault = currentVault.value
  if (!vault) return undefined

  // 网络库使用 networkPath，本地库使用 path
  let basePath = vault.path
  if (vault.vaultType === VaultType.NETWORK && vault.networkPath) {
    basePath = vault.networkPath
  }

  const isNetwork = vault.vaultType === VaultType.NETWORK
  // 列表优先使用 _thumb 压缩版
  return (
    buildCompressedThumbnailUrl(basePath, file.img, isNetwork) ??
    buildThumbnailUrl(basePath, file.img, isNetwork) ??
    undefined
  )
}

/** 获取文件夹封面原图 URL（用于空格预览，不使用 _thumb 版） */
const getOriginalFolderCoverUrl = (file: FolderItem): string | undefined => {
  if (!file.img) return undefined
  if (/^(http|file)/i.test(file.img)) return toLocalResourceUrl(file.img)
  const vault = currentVault.value
  if (!vault) return undefined
  let basePath = vault.path
  if (vault.vaultType === VaultType.NETWORK && vault.networkPath) {
    basePath = vault.networkPath
  }
  return buildThumbnailUrl(basePath, file.img, vault.vaultType === VaultType.NETWORK) ?? undefined
}

/** 判断文件夹封面是否为视频文件 */
const VIDEO_COVER_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov']
const isFolderCoverVideo = (file: FolderItem): boolean => {
  if (!file.img) return false
  const ext = file.img.split('.').pop()?.toLowerCase()
  return !!ext && VIDEO_COVER_EXTENSIONS.includes(ext)
}

/** 判断文件夹封面是否为 GIF 文件 */
const isFolderCoverGif = (file: FolderItem): boolean => {
  if (!file.img) return false
  const ext = file.img.split('.').pop()?.toLowerCase()
  return ext === 'gif'
}

/** GIF 悬停开始播放：通过重新加载 src 来重启动画 */
const handleGifEnter = (event: Event): void => {
  const img = event.target as HTMLImageElement
  if (!img.src) return
  // 添加时间戳参数强制重新加载 GIF 开始播放
  const url = new URL(img.src)
  url.searchParams.set('_t', Date.now().toString())
  img.src = url.toString()
}

/** GIF 悬停离开：通过 canvas 提取第一帧显示静态图 */
const handleGifLeave = (event: Event): void => {
  const img = event.target as HTMLImageElement
  if (!img.src) return
  // 重新加载 GIF 但通过 CSS 暂停动画
  // 注意：由于浏览器会缓存 GIF，这里使用另一个时间戳重置
  const url = new URL(img.src)
  url.searchParams.delete('_t')
  img.src = url.toString()
}

/**
 * 上传文件到百度网盘
 * 固定目录：/apps/unreal-agent/
 * @param item 资产或文件夹对象
 */
const handleUploadToBaiduyun = async (item: AssetDataRow | FolderItem): Promise<void> => {
  const accessToken = baiduyunStore.token?.accessToken
  if (!accessToken) {
    message.warning(t('assetLib.contextMenu.baiduyunNotAuth', '请先授权百度网盘'))
    return
  }

  const localPath = getLocalFilePath(item)
  if (!localPath) {
    message.error(t('assetLib.contextMenu.noFilePath', '无法获取文件路径'))
    return
  }

  const isFolder = (item as FolderItem).type === 'folder'
  const fileName = isFolder
    ? (item as FolderItem).name
    : (item as AssetDataRow).assetName || localPath.split(/[/\\]/).pop() || 'unknown'

  // 智能生成目标路径（UE资产按软路径，非UE按类型分类）
  const targetPath = generateSmartUploadPath(item, fileName)

  message.loading({
    content: t('assetLib.contextMenu.uploading', '上传中...'),
    key: 'upload-baiduyun',
    duration: 0
  })

  try {
    if (isFolder) {
      // 文件夹上传：调用专门的文件夹上传方法
      message.destroy('upload-baiduyun')
      await handleUploadFolderToBaiduyun(item as FolderItem, accessToken)
      return
    }

    // 单文件上传：复用 uploadSingleFileToBaiduyun（已迁移到IPC）
    await uploadSingleFileToBaiduyun(accessToken, localPath, targetPath)

    // 更新资产的云端路径到数据库
    try {
      const assetKey = (item as AssetDataRow).assetKey
      if (assetKey) {
        await (window as any).api.database.assetData.update(assetKey, {
          baiduyunPath: targetPath
        })
        // 同时更新当前资产对象，让详情面板立即显示
        ;(item as any).baiduyunPath = targetPath
      }
    } catch (e) {
      console.warn('更新云端路径失败:', e)
    }

    message.success({
      content: `${t('assetLib.contextMenu.uploadSuccess', '上传成功：{name}').replace('{name}', fileName)}\n${targetPath}`,
      key: 'upload-baiduyun',
      duration: 5
    })
  } catch (err) {
    console.error('上传到百度网盘失败:', err)
    message.error({
      content: t('assetLib.contextMenu.uploadFailed', '上传失败：{error}').replace(
        '{error}',
        (err as Error).message
      ),
      key: 'upload-baiduyun'
    })
  }
}

/**
 * 净化远程路径，移除百度网盘不支持的特殊字符
 * @param path 原始路径
 */
const sanitizeBaiduPath = (path: string): string => {
  // 替换 Windows 和百度网盘不支持的字符
  let cleanPath = path.replace(/[<>:"|?*]/g, '_')

  // 百度网盘路径长度限制（约1000字符，保守使用900）
  const MAX_PATH_LENGTH = 900
  if (cleanPath.length > MAX_PATH_LENGTH) {
    console.warn(`路径过长，已截断: ${cleanPath.length} -> ${MAX_PATH_LENGTH}`)
    // 保留前缀和文件名，截断中间部分
    const lastSlash = cleanPath.lastIndexOf('/')
    const fileName = cleanPath.substring(lastSlash + 1)
    const dirPath = cleanPath.substring(0, lastSlash)
    const availableLen = MAX_PATH_LENGTH - fileName.length - 1
    cleanPath = dirPath.substring(0, availableLen) + '/' + fileName
  }

  return cleanPath
}

/**
 * 非UE资产文件扩展名到分类目录的映射
 */
const FILE_TYPE_CATEGORIES: Record<string, string> = {
  // 音频
  mp3: 'Audio',
  wav: 'Audio',
  ogg: 'Audio',
  flac: 'Audio',
  aac: 'Audio',
  m4a: 'Audio',
  // 视频
  mp4: 'Video',
  avi: 'Video',
  mov: 'Video',
  mkv: 'Video',
  webm: 'Video',
  wmv: 'Video',
  // 图片
  png: 'Images',
  jpg: 'Images',
  jpeg: 'Images',
  gif: 'Images',
  bmp: 'Images',
  webp: 'Images',
  tga: 'Images',
  psd: 'Images',
  svg: 'Images',
  // 文档
  pdf: 'Documents',
  doc: 'Documents',
  docx: 'Documents',
  txt: 'Documents',
  md: 'Documents',
  rtf: 'Documents',
  xls: 'Documents',
  xlsx: 'Documents',
  ppt: 'Documents',
  pptx: 'Documents',
  // 3D模型（非UE）
  fbx: '3DModels',
  obj: '3DModels',
  gltf: '3DModels',
  glb: '3DModels',
  blend: '3DModels',
  max: '3DModels',
  ma: '3DModels',
  mb: '3DModels',
  // 压缩包
  zip: 'Archives',
  rar: 'Archives',
  '7z': 'Archives',
  tar: 'Archives',
  gz: 'Archives'
}

/**
 * UE资产类型到目录的映射
 */
const UE_ASSET_TYPE_DIRS: Record<string, string> = {
  StaticMesh: 'Meshes/Static',
  SkeletalMesh: 'Meshes/Skeletal',
  Texture: 'Textures',
  Texture2D: 'Textures',
  Material: 'Materials',
  MaterialInstance: 'Materials/Instances',
  MaterialInstanceConstant: 'Materials/Instances',
  Blueprint: 'Blueprints',
  WidgetBlueprint: 'Blueprints/Widgets',
  AnimSequence: 'Animations',
  AnimMontage: 'Animations/Montages',
  AnimBlueprint: 'Animations/Blueprints',
  SoundWave: 'Audio',
  SoundCue: 'Audio/Cues',
  ParticleSystem: 'Effects',
  NiagaraSystem: 'Effects/Niagara',
  NiagaraEmitter: 'Effects/Niagara',
  World: 'Maps',
  Level: 'Maps',
  DataTable: 'Data',
  CurveTable: 'Data',
  Enum: 'Data',
  Struct: 'Data'
}

/**
 * 生成智能上传路径
 * - UE资产：使用 softPath（软路径）保持唯一性，如 /Game/Characters/Hero/SKM_Hero
 * - 非UE资产：按文件类型分类
 * @param item 资产或文件夹对象
 * @param fileName 文件名
 * @returns 智能生成的云端路径
 */
const generateSmartUploadPath = (item: AssetDataRow | FolderItem, fileName: string): string => {
  const basePath = '/apps/unreal-agent'

  // 文件夹直接使用名称
  if ((item as FolderItem).type === 'folder') {
    return `${basePath}/${fileName}`
  }

  const asset = item as AssetDataRow
  const softPath = (asset as any).softPath as string | undefined
  // 优先使用资产的 fileExtension 字段，否则从文件名解析
  const fileExt = (asset as any).fileExtension || (asset as any).ext || ''
  const ext =
    fileExt.toLowerCase().replace(/^\./, '') || fileName.split('.').pop()?.toLowerCase() || ''

  // 检测是否为UE资产且有软路径
  const isUEAsset = ext === 'uasset' || ext === 'umap'

  if (isUEAsset && softPath) {
    // UE资产：直接使用软路径作为云端目录结构
    // softPath 格式如: /Game/Characters/Hero/SKM_Hero 或 /Game/Materials/M_Metal
    // 转换为: /apps/unreal-agent/Game/Characters/Hero/SKM_Hero.uasset
    const cleanSoftPath = softPath.replace(/^\//, '') // 移除开头斜杠
    const result = sanitizeBaiduPath(`${basePath}/${cleanSoftPath}.${ext}`)
    console.log('[generateSmartUploadPath] UE asset result:', result)
    return result
  }

  // 非UE资产（或无软路径的UE资产）：按文件扩展名分类
  const category = FILE_TYPE_CATEGORIES[ext] || 'Others'
  return sanitizeBaiduPath(`${basePath}/${category}/${fileName}`)
}

/**
 * 上传单个文件到百度网盘（内部使用）
 * 通过主进程IPC完成所有网络请求，前端只传递文件路径
 * @param accessToken 访问令牌
 * @param localPath 本地文件路径
 * @param remotePath 百度网盘目标路径
 * @param onProgress 进度回调
 */
const uploadSingleFileToBaiduyun = async (
  accessToken: string,
  localPath: string,
  remotePath: string,
  onProgress?: (percent: number) => void
): Promise<void> => {
  const SparkMD5 = (await import('spark-md5')).default

  // 读取文件获取大小和计算MD5（MD5计算仍需在前端完成，因为主进程不便暴露此细节）
  const fileBufferResult = await window.api.fs.readFileBuffer(localPath)
  if (!fileBufferResult?.success || !fileBufferResult.data) {
    throw new Error(fileBufferResult?.error || '读取文件失败')
  }
  const fileBuffer = fileBufferResult.data
  const fileSize = fileBuffer.byteLength

  // 计算分片MD5
  const chunkSize = 4 * 1024 * 1024
  const blockList: string[] = []
  let offset = 0
  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize, fileSize)
    const chunk = fileBuffer.slice(offset, end)
    const md5 = SparkMD5.ArrayBuffer.hash(chunk)
    blockList.push(md5)
    offset = end
  }

  // 1. 预上传（通过IPC）
  const preRes = await window.api.baiduYun.precreate({
    accessToken,
    path: remotePath,
    size: fileSize,
    isdir: 0,
    blockList,
    rtype: 3
  })
  if (!preRes?.success || !preRes.data) {
    throw new Error(preRes?.error || '预上传失败')
  }
  const pre = preRes.data

  // 2. 定位上传服务器（通过IPC）
  const locateRes = await window.api.baiduYun.locateUpload({
    accessToken,
    path: remotePath,
    uploadid: pre.uploadid
  })
  if (!locateRes?.success || !locateRes.data) {
    throw new Error(locateRes?.error || '获取上传域名失败')
  }
  const locate = locateRes.data

  // 获取上传域名（类型安全处理）
  const locateData = locate as {
    host?: string
    servers?: Array<{ server?: string }>
    server?: string[]
  }
  const httpsDomains: string[] = [
    ...(Array.isArray(locateData.servers)
      ? locateData.servers.map((e) => e.server || '').filter(Boolean)
      : []),
    ...(Array.isArray(locateData.server) ? locateData.server : [])
  ].filter((d: string) => typeof d === 'string' && d.startsWith('https://'))
  const host = httpsDomains[0] || locateData.host || ''

  if (!host) throw new Error('未获取到有效上传域名')

  // 3. 上传文件（通过IPC，主进程读取文件并分片上传）
  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`

  // 设置进度监听（如果提供了回调）
  let unsubscribe: (() => void) | undefined
  if (onProgress) {
    unsubscribe = window.api.baiduYun.onUploadProgress((event) => {
      if (event.uploadId === uploadId) {
        onProgress(event.percent)
      }
    })
  }

  try {
    const uploadRes = await window.api.baiduYun.uploadFile({
      accessToken,
      localPath,
      remotePath,
      uploadid: pre.uploadid,
      host,
      uploadId,
      blockSize: chunkSize
    })
    if (!uploadRes?.success) {
      throw new Error(uploadRes?.error || '分片上传失败')
    }
  } finally {
    unsubscribe?.()
  }

  // 4. 创建文件（通过IPC）
  const createRes = await window.api.baiduYun.create({
    accessToken,
    path: remotePath,
    size: fileSize,
    isdir: 0,
    blockList,
    uploadid: pre.uploadid,
    rtype: 3
  })
  if (!createRes?.success) {
    throw new Error(createRes?.error || '创建文件失败')
  }
}

/**
 * 上传文件夹到百度网盘
 * 通过主进程IPC完成所有网络请求，前端只传递文件路径
 * @param folder 文件夹对象
 * @param accessToken 访问令牌
 */
const handleUploadFolderToBaiduyun = async (
  folder: FolderItem,
  accessToken: string
): Promise<void> => {
  const folderId = folder.id
  const vaultPath = currentVault.value?.path
  const isBackup = currentVault.value?.vaultType === VaultType.BACKUP
  const localPath = getLocalFilePath(folder)

  // 防止重复上传
  if (baiduyunStore.hasUploadingTask(folderId)) {
    message.warning(t('assetFileList.folderUploading'))
    return
  }

  // 验证路径：跳过备份模式，检查本地路径或网络路径（UNC格式）
  console.log('[handleUploadFolderToBaiduyun] 路径验证:', {
    localPath,
    isBackup,
    folderPath: folder.path,
    vaultType: currentVault.value?.vaultType,
    networkPath: currentVault.value?.networkPath
  })
  const isValidBaiduPath =
    localPath &&
    (/^[a-zA-Z]:[\/\\]/.test(localPath) || // 本地盘符路径
      /^(\\\\|\/\/)/.test(localPath)) // UNC 网络路径
  console.log('[handleUploadFolderToBaiduyun] 验证结果:', { isValidBaiduPath, localPath })
  if (!isBackup && !isValidBaiduPath) {
    console.error('[handleUploadFolderToBaiduyun] 路径验证失败:', { localPath, isBackup })
    message.error(t('assetFileList.invalidLocalPath'))
    return
  }

  // 创建上传任务（使用 store）
  const task = {
    folderId,
    folderName: folder.name,
    progress: 0,
    totalFiles: 0,
    uploadedFiles: 0,
    status: 'uploading' as const
  }
  baiduyunStore.setUploadTask(task)

  try {
    let filesToUpload: Array<{ localPath: string; remotePath: string }> = []
    const remoteRoot = `/apps/unreal-agent/${folder.name}`

    if (isBackup && vaultPath) {
      // 备份模式：从数据库获取文件夹下所有资产
      const resp = await (window as any).api.database.assetData.getByFolderKeyRecursive(folderId)
      if (!resp?.success || !resp.data) {
        throw new Error(resp?.error || '获取资产列表失败')
      }

      const assets = resp.data as Array<{ assetName: string; filePath: string }>

      for (const asset of assets) {
        if (asset.filePath) {
          // 拼接保管库路径 + filePath
          const assetLocalPath = `${vaultPath}/${asset.filePath}`.replace(/\\/g, '/')
          const remotePath = sanitizeBaiduPath(`${remoteRoot}/${asset.assetName}`)
          filesToUpload.push({ localPath: assetLocalPath, remotePath })
        }
      }
    } else {
      // 引用模式：使用文件系统遍历
      const result = await window.api.fs.readFolderContentsRecursive(localPath!)
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '读取文件夹内容失败')
      }

      const contents = result.data as Array<{
        name: string
        path: string
        type: 'file' | 'folder'
        relativePath: string
      }>

      // 创建子目录（通过IPC）
      const folders = contents.filter((item) => item.type === 'folder')
      for (const subFolder of folders) {
        const remoteFolderPath = `${remoteRoot}/${subFolder.relativePath}`
        const folderRes = await window.api.baiduYun.createFolder({
          accessToken,
          path: remoteFolderPath,
          rtype: 3
        })
        if (!folderRes?.success) {
          console.warn(`创建子目录失败: ${remoteFolderPath}`, folderRes?.error)
        }
      }

      // 收集文件
      const files = contents.filter((item) => item.type === 'file')
      for (const file of files) {
        filesToUpload.push({
          localPath: file.path,
          remotePath: sanitizeBaiduPath(`${remoteRoot}/${file.relativePath}`)
        })
      }
    }

    task.totalFiles = filesToUpload.length

    // 空文件夹处理
    if (filesToUpload.length === 0) {
      message.info(t('assetFileList.folderEmpty'))
      return
    }

    // 创建云端根目录（通过IPC）
    const rootFolderRes = await window.api.baiduYun.createFolder({
      accessToken,
      path: remoteRoot,
      rtype: 1
    })
    if (!rootFolderRes?.success) {
      console.warn(`创建根目录失败: ${remoteRoot}`, rootFolderRes?.error)
    }

    // 逐个上传文件（单个失败不中断整体）
    let failedCount = 0
    for (const file of filesToUpload) {
      try {
        await uploadSingleFileToBaiduyun(accessToken, file.localPath, file.remotePath)
        task.uploadedFiles++
      } catch (fileErr) {
        console.warn(`文件上传失败: ${file.localPath}`, fileErr)
        failedCount++
      }
      baiduyunStore.updateUploadTask(folderId, {
        progress:
          task.totalFiles > 0
            ? Math.round(((task.uploadedFiles + failedCount) / task.totalFiles) * 100)
            : 100,
        uploadedFiles: task.uploadedFiles
      })
    }

    // 上传完成，根据结果显示不同消息
    if (failedCount === 0) {
      baiduyunStore.updateUploadTask(folderId, { status: 'success' })
      message.success(t('assetFileList.folderUploadDone', { name: folder.name }))
    } else if (task.uploadedFiles > 0) {
      baiduyunStore.updateUploadTask(folderId, { status: 'success' })
      message.warning(
        t('assetFileList.folderUploadDoneWithFailures', { name: folder.name, failed: failedCount })
      )
    } else {
      throw new Error('所有文件上传失败')
    }

    // 3秒后移除任务
    setTimeout(() => {
      baiduyunStore.removeUploadTask(folderId)
    }, 3000)
  } catch (err) {
    console.error('上传文件夹到百度网盘失败:', err)
    baiduyunStore.updateUploadTask(folderId, { status: 'error' })

    // 检测Token过期
    const errMsg = (err as Error).message || ''
    const isTokenExpired =
      errMsg.includes('111') || errMsg.includes('token') || errMsg.includes('授权')

    if (isTokenExpired) {
      message.error(t('assetFileList.baiduyunAuthExpired'))
    } else {
      message.error(t('assetFileList.uploadFailedWithError', { error: errMsg }))
    }

    // 5秒后移除任务
    setTimeout(() => {
      baiduyunStore.removeUploadTask(folderId)
    }, 5000)
  }
}

/**
 * 获取文件夹的上传任务（响应式，使用全局store）
 */
const getFolderUploadTask = (folderId: string) => {
  return baiduyunStore.getUploadTask(folderId)
}

/**
 * 获取WebDAV文件夹的上传任务（响应式，使用全局store）
 */
const getWebdavFolderUploadTask = (folderId: string) => {
  return webdavStore.getUploadTask(folderId)
}

// 🔔 追踪刚完成的工程导入任务（用于显示 1.5 秒的完成动画）
const completedProjectImportFolders = reactive(new Map<string, ReturnType<typeof setTimeout>>())

// 监听任务完成，添加到 completedProjectImportFolders
watch(
  () => props.importTasks,
  (tasks) => {
    if (!tasks) return
    tasks.forEach((task) => {
      if (task.taskType !== 'project-import') return
      if (task.status === 'completed') {
        // 对每个 sourceFolderKey 添加完成状态
        task.sourceFolderKeys?.forEach((folderId) => {
          if (!completedProjectImportFolders.has(folderId)) {
            // 添加到完成列表，1.5 秒后移除
            const timer = setTimeout(() => {
              completedProjectImportFolders.delete(folderId)
            }, 1500)
            completedProjectImportFolders.set(folderId, timer)
          }
        })
      }
    })
  },
  { deep: true }
)

/**
 * 获取文件夹对应的工程导入任务（用于在文件夹上显示进度覆盖层）
 * @param folderId 当前文件夹的 ID
 * @returns 返回对象包含 progress 和 isCompleted 状态，若无任务返回 undefined
 */
const getProjectImportTask = (
  folderId: string
): { progress: number; isCompleted: boolean } | undefined => {
  // 优先检查是否刚完成（显示完成动画）
  if (completedProjectImportFolders.has(folderId)) {
    return { progress: 100, isCompleted: true }
  }
  // 查找正在进行的任务
  const task = (props.importTasks || []).find((t) => {
    if (t.taskType !== 'project-import') return false
    if (t.status !== 'running') return false
    return t.sourceFolderKeys?.includes(folderId) || false
  })
  if (task) {
    return { progress: task.progress || 0, isCompleted: false }
  }
  return undefined
}

/**
 * 获取文件夹对应的 vault-import 导入任务（用于在真实文件夹卡片上显示进度覆盖层）
 * 通过 rootFolderKey（稳定主键）关联，不依赖名称匹配
 * @param folderId 当前文件夹的 folderKey
 * @returns 返回对象包含 progress、stageText 和 isCompleted 状态，若无任务返回 undefined
 */
const getVaultImportTask = (
  folderId: string
): { progress: number; stageText: string; isCompleted: boolean } | undefined => {
  const task = (props.importTasks || []).find((t) => {
    if (t.taskType === 'project-import') return false
    if (t.type !== 'folder') return false
    if (t.status === 'completed' || t.progress === 100) return false
    return t.rootFolderKey === folderId
  })
  if (task) {
    return {
      progress: task.progress || 0,
      stageText: task.stageText || '',
      isCompleted: false
    }
  }
  return undefined
}

/**
 * 上传单个文件到WebDAV（内部使用）
 * @param localPath 本地文件路径
 * @param remotePath WebDAV目标路径
 */
const uploadSingleFileToWebdav = async (localPath: string, remotePath: string): Promise<void> => {
  const connection = webdavStore.connection
  if (!connection) throw new Error('WebDAV 未连接')

  const fileBufferResult = await window.api.fs.readFileBuffer(localPath)
  if (!fileBufferResult?.success || !fileBufferResult.data) {
    throw new Error(fileBufferResult?.error || '读取文件失败')
  }

  const result = await window.api.webdav.uploadFile({
    serverUrl: connection.serverUrl,
    username: connection.username,
    password: connection.password,
    remotePath,
    fileBuffer: fileBufferResult.data
  })

  if (!result?.success) {
    throw new Error(result?.error || '上传失败')
  }
}

/**
 * 上传文件夹到 WebDAV
 * @param folder 文件夹对象
 */
const handleUploadFolderToWebdav = async (folder: FolderItem): Promise<void> => {
  const connection = webdavStore.connection
  if (!connection) return

  const folderId = folder.id
  const vaultPath = currentVault.value?.path
  const isBackup = currentVault.value?.vaultType === VaultType.BACKUP
  const localPath = getLocalFilePath(folder)

  // 防止重复上传
  if (webdavStore.hasUploadingTask(folderId)) {
    message.warning(t('assetFileList.folderUploading'))
    return
  }

  // 验证路径：跳过备份模式，检查本地路径或网络路径（UNC格式）
  const isValidWebdavPath =
    localPath &&
    (/^[a-zA-Z]:[\/\\]/.test(localPath) || // 本地盘符路径
      /^(\\\\|\/\/)/.test(localPath)) // UNC 网络路径
  if (!isBackup && !isValidWebdavPath) {
    message.error(t('assetFileList.invalidLocalPath'))
    return
  }

  // 创建上传任务（使用 store）
  const task = {
    folderId,
    folderName: folder.name,
    progress: 0,
    totalFiles: 0,
    uploadedFiles: 0,
    status: 'uploading' as const
  }
  webdavStore.setUploadTask(task)

  try {
    let filesToUpload: Array<{ localPath: string; remotePath: string }> = []
    const remoteRoot = `/unreal-agent/${folder.name}`

    if (isBackup && vaultPath) {
      // 备份模式：从数据库获取文件夹下所有资产
      const resp = await (window as any).api.database.assetData.getByFolderKeyRecursive(folderId)
      if (!resp?.success || !resp.data) {
        throw new Error(resp?.error || '获取资产列表失败')
      }
      const assets = resp.data as Array<{ assetName: string; filePath: string }>
      for (const asset of assets) {
        if (asset.filePath) {
          const assetLocalPath = `${vaultPath}/${asset.filePath}`.replace(/\\/g, '/')
          filesToUpload.push({
            localPath: assetLocalPath,
            remotePath: `${remoteRoot}/${asset.assetName}`
          })
        }
      }
    } else {
      // 引用模式：使用文件系统遍历
      const result = await window.api.fs.readFolderContentsRecursive(localPath!)
      if (!result?.success || !result.data) {
        throw new Error(result?.error || '读取文件夹内容失败')
      }
      const contents = result.data as Array<{
        name: string
        path: string
        type: 'file' | 'folder'
        relativePath: string
      }>

      // 创建子目录
      for (const subFolder of contents.filter((i) => i.type === 'folder')) {
        try {
          await window.api.webdav.createDirectory({
            serverUrl: connection.serverUrl,
            username: connection.username,
            password: connection.password,
            path: `${remoteRoot}/${subFolder.relativePath}`
          })
        } catch {
          /* 目录可能已存在 */
        }
      }

      // 收集文件
      for (const file of contents.filter((i) => i.type === 'file')) {
        filesToUpload.push({
          localPath: file.path,
          remotePath: `${remoteRoot}/${file.relativePath}`
        })
      }
    }

    task.totalFiles = filesToUpload.length
    if (filesToUpload.length === 0) {
      message.info(t('assetFileList.folderEmpty'))
      webdavStore.removeUploadTask(folderId)
      return
    }

    // 创建云端根目录
    try {
      await window.api.webdav.createDirectory({
        serverUrl: connection.serverUrl,
        username: connection.username,
        password: connection.password,
        path: remoteRoot
      })
    } catch {
      /* 目录可能已存在 */
    }

    // 逐个上传文件
    let failedCount = 0
    for (const file of filesToUpload) {
      try {
        await uploadSingleFileToWebdav(file.localPath, file.remotePath)
        task.uploadedFiles++
      } catch (err) {
        console.warn(`文件上传失败: ${file.localPath}`, err)
        failedCount++
      }
      webdavStore.updateUploadTask(folderId, {
        progress: Math.round(((task.uploadedFiles + failedCount) / task.totalFiles) * 100),
        uploadedFiles: task.uploadedFiles
      })
    }

    if (failedCount === 0) {
      webdavStore.updateUploadTask(folderId, { status: 'success' })
      message.success(t('assetFileList.folderUploadDone', { name: folder.name }))
    } else if (task.uploadedFiles > 0) {
      webdavStore.updateUploadTask(folderId, { status: 'success' })
      message.warning(
        t('assetFileList.folderUploadDoneWithFailures', { name: folder.name, failed: failedCount })
      )
    } else {
      throw new Error('所有文件上传失败')
    }

    setTimeout(() => webdavStore.removeUploadTask(folderId), 3000)
  } catch (err) {
    console.error('上传文件夹到 WebDAV 失败:', err)
    webdavStore.updateUploadTask(folderId, { status: 'error' })
    message.error(t('assetFileList.uploadFailedWithError', { error: (err as Error).message }))
    setTimeout(() => webdavStore.removeUploadTask(folderId), 5000)
  }
}

/**
 * 上传文件到 WebDAV
 * 固定目录：/unreal-agent/
 * @param item 资产或文件夹对象
 */
const handleUploadToWebdav = async (item: AssetDataRow | FolderItem): Promise<void> => {
  const connection = webdavStore.connection
  if (!connection?.serverUrl) {
    message.warning(t('assetLib.contextMenu.webdavNotConnected', '请先连接 WebDAV 服务器'))
    return
  }

  const localPath = getLocalFilePath(item)
  if (!localPath) {
    message.error(t('assetLib.contextMenu.noFilePath', '无法获取文件路径'))
    return
  }

  const isFolder = (item as FolderItem).type === 'folder'
  const fileName = isFolder
    ? (item as FolderItem).name
    : (item as AssetDataRow).assetName || localPath.split(/[/\\]/).pop() || 'unknown'

  // 智能生成目标路径（UE资产按软路径，非UE按类型分类）
  // WebDAV使用 /unreal-agent 前缀，替换百度的 /apps/unreal-agent
  const remotePath = generateSmartUploadPath(item, fileName).replace(
    '/apps/unreal-agent',
    '/unreal-agent'
  )

  message.loading({
    content: t('assetLib.contextMenu.uploading', '上传中...'),
    key: 'upload-webdav',
    duration: 0
  })

  try {
    if (isFolder) {
      // 文件夹上传：调用专门的文件夹上传方法
      message.destroy('upload-webdav')
      await handleUploadFolderToWebdav(item as FolderItem)
      return
    }

    // 读取文件内容
    const fileBufferResult = await window.api.fs.readFileBuffer(localPath)
    if (!fileBufferResult?.success || !fileBufferResult.data) {
      throw new Error(fileBufferResult?.error || '读取文件失败')
    }
    const fileBuffer = fileBufferResult.data

    // 先尝试创建目录（如果不存在）
    try {
      await window.api.webdav.createDirectory({
        serverUrl: connection.serverUrl,
        username: connection.username,
        password: connection.password,
        path: '/unreal-agent'
      })
    } catch {
      // 目录可能已存在，忽略错误
    }

    // 上传文件
    const result = await window.api.webdav.uploadFile({
      serverUrl: connection.serverUrl,
      username: connection.username,
      password: connection.password,
      remotePath,
      fileBuffer: fileBuffer
    })

    if (result?.success) {
      // 更新资产的云端路径到数据库
      try {
        const assetKey = (item as AssetDataRow).assetKey
        if (assetKey) {
          await (window as any).api.database.assetData.update(assetKey, {
            webdavPath: remotePath
          })
          // 同时更新当前资产对象，让详情面板立即显示
          ;(item as any).webdavPath = remotePath
        }
      } catch (e) {
        console.warn('更新云端路径失败:', e)
      }

      message.success({
        content: `${t('assetLib.contextMenu.uploadSuccess', '上传成功：{name}').replace('{name}', fileName)}\n${remotePath}`,
        key: 'upload-webdav',
        duration: 5
      })
    } else {
      throw new Error(result?.error || '上传失败')
    }
  } catch (err) {
    console.error('上传到 WebDAV 失败:', err)
    message.error({
      content: t('assetLib.contextMenu.uploadFailed', '上传失败：{error}').replace(
        '{error}',
        (err as Error).message
      ),
      key: 'upload-webdav'
    })
  }
}

// 监听 files 变化，重新加载文件夹收藏状态
watch(
  () => props.files,
  async (newFiles) => {
    if (!newFiles || newFiles.length === 0) return
    // 服务器库的行在本机没有文件，不做视频封面处理
    if (!libraryCaps.value.canEditStructure) return

    const folderIds = newFiles
      .filter((file: any) => file.type === 'folder')
      .map((file: any) => file.id)
      .filter(Boolean)

    if (folderIds.length > 0) {
      try {
        const statusMap: Record<string, boolean> = {}
        for (const folderId of folderIds) {
          try {
            const isFav = await checkFolderFavorite(folderId)
            statusMap[folderId] = isFav
          } catch {
            statusMap[folderId] = false
          }
        }
        folderFavoriteStatusMap.value = statusMap
      } catch {
        // 忽略错误
      }
    }
  },
  { deep: false }
)

const getItemId = (file: any) => (file?.type === 'folder' ? file.id : file.assetKey || file.id)

// 视频缩略图生成失败记忆：记录已尝试但失败的 assetKey，避免无限重试
const failedVideoThumbnailKeys = new Set<string>()

// 自动检测并生成视频缩略图
watch(
  () => props.files,
  async (newFiles) => {
    if (!newFiles || newFiles.length === 0) return

    // 筛选出没有设置 customPoster 的视频文件，且不在失败集合中
    const videoFilesToProcess = newFiles.reduce((acc: any[], file: any) => {
      if (file.type === 'folder') return acc

      // 使用 getLocalFilePath 正确处理备份/引用模式
      const filePath = getLocalFilePath(file as AssetDataRow)
      // 如果没有缩略图，是视频文件，且未曾失败过
      if (
        !file.customPoster &&
        filePath &&
        isVideoFile(filePath) &&
        !failedVideoThumbnailKeys.has(file.assetKey)
      ) {
        acc.push({
          assetKey: file.assetKey,
          filePath: filePath
        })
      }
      return acc
    }, [])

    if (videoFilesToProcess.length > 0) {
      console.log(`[AssetFileList] 检测到 ${videoFilesToProcess.length} 个视频文件需要生成缩略图`)

      try {
        const results = await batchHandleVideoAssets(videoFilesToProcess)
        // 将失败的 assetKey 添加到失败集合，避免下次重试
        for (const result of results) {
          if (!result.success) {
            failedVideoThumbnailKeys.add(result.assetKey)
            console.warn(
              `[AssetFileList] 视频缩略图生成失败，已标记跳过: ${result.assetKey}`,
              result.error
            )
          }
        }
        // 完成后刷新一次列表以显示新图片
        await assetContext.refreshCurrentFolder()
      } catch (e) {
        console.error('[AssetFileList] 自动生成视频缩略图失败:', e)
        // 整体失败时，将所有尝试的 assetKey 都标记为失败
        for (const item of videoFilesToProcess) {
          failedVideoThumbnailKeys.add(item.assetKey)
        }
      }
    }
  },
  { deep: false, immediate: true }
)

const failedListThumbnails = ref(new Set<string | undefined>())
const thumbnailRevision = ref(0)
watch([() => props.files, () => props.selectedFolderKey, () => currentVault.value?.id], () => {
  failedListThumbnails.value = new Set()
  thumbnailRevision.value++
})
const getThumbnailUrl = (file: Parameters<typeof getThumbnailSourceUrl>[0]): string | undefined => {
  const source = getThumbnailSourceUrl(file)
  return failedListThumbnails.value.has(source)
    ? undefined
    : listThumbnailUrl(source, thumbnailRevision.value)
}

const getThumbnailSourceUrl = (file: Record<string, string | undefined>): string | undefined => {
  if (file?.type === 'folder') return undefined
  // 数据源直接给了缩略图地址（服务器库：uebox-preview://，主进程按内容哈希缓存）
  if (file?.thumbnailUrl) return file.thumbnailUrl

  const fileName = file?.assetName || ''
  const fileNameLower = fileName.toLowerCase()

  // 代码文件不应显示图片封面，应该显示图标
  const codeFileExts = [
    '.ts',
    '.js',
    '.vue',
    '.jsx',
    '.tsx',
    '.d.ts',
    '.cpp',
    '.h',
    '.cs',
    '.py',
    '.java',
    '.json',
    '.xml',
    '.html',
    '.css',
    '.md',
    '.txt'
  ]
  const isCodeFile = codeFileExts.some((ext) => fileNameLower.endsWith(ext))

  // uasset 文件自带缩略图，即使不是图片文件也应该显示
  const isUassetFile = fileNameLower.endsWith('.uasset')

  // 如果是代码文件且不是 uasset，不显示缩略图
  if (isCodeFile && !isUassetFile) return undefined

  // 优先使用 customPoster（列表显示 _thumb 压缩版）
  if (file.customPoster) {
    if (file.customPoster.startsWith('http') || file.customPoster.startsWith('file:')) {
      return toLocalResourceUrl(file.customPoster)
    }
    // 🔧 修复：网络库使用 networkPath/.thumbnails，本地库使用 path/thumbnails
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const vaultPath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
    // 列表优先使用 _thumb 压缩版，提升加载速度
    return (
      buildCompressedThumbnailUrl(vaultPath, file.customPoster, isNetworkVault) ??
      buildThumbnailUrl(vaultPath, file.customPoster, isNetworkVault)
    )
  }

  // 若是当前选中资产且已有覆盖的 customPoster，则优先展示（压缩版）
  const sel = (selectedAsset as any)?.value
  if (sel && sel.assetKey === file.assetKey && sel.customPoster) {
    if (sel.customPoster.startsWith('http') || sel.customPoster.startsWith('file:')) {
      return toLocalResourceUrl(sel.customPoster)
    }
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const vaultPath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
    return (
      buildCompressedThumbnailUrl(vaultPath, sel.customPoster, isNetworkVault) ??
      buildThumbnailUrl(vaultPath, sel.customPoster, isNetworkVault)
    )
  }

  // Referenced images may change outside the app: cache against the actual source file.
  if (
    currentVault.value?.vaultType === VaultType.REFERENCE &&
    isImageFile(fileName, file?.fileExtension || file?.ext)
  ) {
    return resolveAssetUrl({
      vaultType: currentVault.value.vaultType,
      vaultPath: currentVault.value.path,
      originPath: file.originPath,
      filePath: file.filePath
    })
  }

  // 如果有 imgLocalPath(如 uasset 的 thumbnail-xxxx),构建缩略图 URL
  if (file?.imgLocalPath) {
    // 🔧 统一使用 buildThumbnailUrl，传入 isNetworkVault 以使用正确目录
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const basePath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
    return buildThumbnailUrl(basePath, file.imgLocalPath, isNetworkVault)
  }

  // 📝 如果是蓝图资产且没有缩略图，使用默认占位图
  // 注意：C++ 端已针对 Blueprint 类型跳过缩略图生成
  // 包含所有蓝图类型：Blueprint、WidgetBlueprint、AnimBlueprint、BlueprintFunctionLibrary 等
  if (file?.className?.includes('Blueprint') || fileName.startsWith('BP_')) {
    return defaultBlueprintThumb
  }

  // 图片文件:如果没有 imgLocalPath,则使用原始文件路径作为缩略图
  // 🔧 使用 buildDirectFileUrl：图片文件本身就是预览资源，不在 .thumbnails 目录下
  if (isImageFile(fileName, file?.fileExtension || file?.ext)) {
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    // 网络库优先用 filePath（相对路径），本地库优先用 originPath（绝对路径）
    const filePath = isNetworkVault
      ? file?.filePath || file?.originPath
      : file?.originPath || file?.filePath
    if (filePath) {
      const vaultPath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
      return buildDirectFileUrl(vaultPath, filePath, isNetworkVault)
    }
    return undefined
  }

  return undefined
}

/** 判断资产缩略图是否为视频文件 */
const isThumbnailVideo = (file: any): boolean => {
  if (file?.type === 'folder') return false

  // 检查 customPoster 是否为视频
  const posterPath = file?.customPoster
  if (posterPath) {
    const ext = posterPath.split('.').pop()?.toLowerCase()
    return !!ext && VIDEO_COVER_EXTENSIONS.includes(ext)
  }

  return false
}

/** 判断资产缩略图是否为 GIF 文件 */
const isThumbnailGif = (file: any): boolean => {
  if (file?.type === 'folder') return false

  // 检查 customPoster 是否为 GIF
  const posterPath = file?.customPoster
  if (posterPath) {
    const ext = posterPath.split('.').pop()?.toLowerCase()
    return ext === 'gif'
  }

  return false
}

// 移除未使用的扩展名解析函数以避免无用变量警告

/**
 * 获取用于展示的文件后缀标签（居中显示）
 * - 优先使用数据库字段 fileExtension/ext
 * - 其次尝试从 originPath/filePath 中解析
 * - 再其次从 assetName/name 中解析
 */
const getFileExtLabel = (file: any): string => {
  if (!file || file?.type === 'folder') return ''

  // 针对 Unreal 资产 (.uasset, .umap) 显示其类名（支持中英文转换）
  const extLower = getFileExtLower(file)
  if (extLower === 'uasset' || extLower === 'umap') {
    const isCn = locale.value.startsWith('zh')
    if (isCn && file.classNameCn) return file.classNameCn
    if (file.className) return file.className
    // 如果没有类名，则回退到后缀名显示
  }

  const normalize = (extRaw: string): string => {
    const ext = String(extRaw || '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '')
    if (!ext) return ''
    // 控制长度，避免太长撑爆布局
    const upper = ext.toUpperCase()
    return upper.length > 10 ? upper.slice(0, 10) : upper
  }

  // 1) 优先字段
  const extFromField = normalize(String(file.fileExtension || file.ext || ''))
  if (extFromField) return extFromField

  // 2) 尝试从路径解析
  const path = String(file.originPath || file.filePath || file.path || '')
  if (path) {
    const base = path.split(/[\\/]/).pop() || ''
    const idx = base.lastIndexOf('.')
    if (idx > 0 && idx < base.length - 1) {
      const extFromPath = normalize(base.slice(idx + 1))
      if (extFromPath) return extFromPath
    }
  }

  // 3) 从名称解析
  const name = String(file.assetName || file.name || '')
  const idx = name.lastIndexOf('.')
  if (idx > 0 && idx < name.length - 1) {
    const extFromName = normalize(name.slice(idx + 1))
    if (extFromName) return extFromName
  }

  // 没有后缀时不显示
  return ''
}

// 分离文件夹和文件的计算属性
const folderFiles = computed(() => {
  return props.files.filter((file): file is FolderItem => file.type === 'folder')
})

const assetFiles = computed(() => {
  return props.files.filter((file: any) => file.type !== 'folder') as AssetDataRow[]
})

// 动态网格大小计算属性
const gridItemSize = computed(() => {
  const size = props.displaySize || 120
  return Math.max(80, Math.min(300, size))
})

const gridStyle = computed(() => {
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${gridItemSize.value}px, 1fr))`
  }
})

// ========== 虚拟滚动配置 ==========

/**
 * 内层包裹元素。
 *
 * ⚠️ 它**不是**滚动容器 —— `.virtual-scroll-container` 全仓没有任何 CSS，
 * 永远不滚动。虚拟滚动以前就绑在它身上：scrollTop 恒为 0、clientHeight 等于
 * 全部内容高度，于是 startIndex 恒 0、endIndex 恒为末尾，**几千条资产全量进 DOM**，
 * 虚拟滚动整体失效。真正带 overflow 的是外层的 `.file-content`（= containerRef）。
 */
const scrollContainerRef = ref<HTMLElement | null>(null)

/** 资产网格本身，用来量它在滚动容器里的起始偏移和真实列数 */
const assetGridRef = ref<HTMLElement | null>(null)

/**
 * 每行文件项的高度（包含 margin/gap）
 * 文件项高度 = gridItemSize + 文件信息区域高度 + gap
 */
// 挂载后以实际卡片高度为准，包含内边距、边框、文件名和行间距。
const itemRowHeight = ref(gridItemSize.value + 90)

/**
 * 每行可显示的列数（响应式 ref，在 resize 时自动更新）
 */
const columnsPerRow = ref(4)

/**
 * 每行几列。
 *
 * 优先直接量真实的网格 —— `repeat(auto-fill, minmax(size, 1fr))` 配上 gap 之后，
 * 「宽度除以最小宽度」算出来的列数会比实际多一列，虚拟滚动的行切片就跟真实换行
 * 错位，超出 overscan 之后中段会出现空行。量出来的永远不会跟 CSS 打架。
 */
const calculateColumnsPerRow = (width: number): number => {
  const grid = assetGridRef.value
  if (grid) {
    const columns = getComputedStyle(grid).gridTemplateColumns
    const measured = columns ? columns.split(' ').filter(Boolean).length : 0
    if (measured > 0) return measured
  }
  // 量不到时的兜底：把 gap 算进去，auto-fill 的列数 = floor((W + gap) / (min + gap))
  if (width === 0) return 4 // 默认 4 列
  const effectiveWidth = width - 32 // 减去 padding
  const gap = gridGapSize.value
  return Math.max(1, Math.floor((effectiveWidth + gap) / (gridItemSize.value + gap)))
}

/** 网格 gap 的实际像素值（来自 CSS 变量，量不到时按 8px 估） */
const gridGapSize = ref(8)

const refreshGridLayout = (): void => {
  const grid = assetGridRef.value
  if (!grid) return
  const card = grid.querySelector<HTMLElement>('.asset-item')
  if (!card || card.getBoundingClientRect().height === 0) return
  const gap = parseFloat(getComputedStyle(grid).rowGap)
  gridGapSize.value = Number.isFinite(gap) ? gap : 0
  itemRowHeight.value = card.getBoundingClientRect().height + gridGapSize.value
  columnsPerRow.value = calculateColumnsPerRow(grid.clientWidth)
}

let gridResizeObserver: ResizeObserver | null = null
onMounted(() => {
  gridResizeObserver = new ResizeObserver(() => {
    refreshGridLayout()
    updateScrollPosition()
  })
  if (assetGridRef.value) gridResizeObserver.observe(assetGridRef.value)
})
watch(
  assetGridRef,
  (grid, previous) => {
    if (previous) gridResizeObserver?.unobserve(previous)
    if (grid) gridResizeObserver?.observe(grid)
  },
  { flush: 'post' }
)
onUnmounted(() => gridResizeObserver?.disconnect())

/**
 * 资产文件虚拟滚动
 */
const {
  startIndex: assetStartIndex,
  endIndex: assetEndIndex,
  paddingTop: assetPaddingTop,
  paddingBottom: assetPaddingBottom,
  isNearBottom,
  containerWidth: virtualScrollContainerWidth,
  updateScrollPosition,
  scrollToTop
} = useVirtualScroll({
  // 必须是真正带 overflow 的那个元素，见 scrollContainerRef 的注释。
  // 用 computed 惰性取：containerRef 来自下面的 useFileSelection()，
  // 这里直接引用会撞 TDZ；而 useVirtualScroll 只在 onMounted 之后才读它。
  containerRef: computed(() => containerRef.value),
  gridRef: assetGridRef,
  itemCount: computed(() => assetFiles.value.length),
  columnsPerRow,
  itemHeight: itemRowHeight,
  overscan: 3,
  loadMoreThreshold: 300
})

/**
 * 监听容器宽度变化，更新列数
 * 使用 useVirtualScroll 返回的响应式 containerWidth 确保 resize 时同步更新
 */
watch(
  [virtualScrollContainerWidth, gridItemSize],
  () => {
    refreshGridLayout()
  },
  { flush: 'post' }
)

/**
 * 可见的资产文件列表（虚拟滚动切片）
 */
const visibleAssetFiles = computed(() => {
  const start = assetStartIndex.value
  const end = assetEndIndex.value + 1
  return assetFiles.value.slice(start, end)
})

/**
 * 当选中文件夹变化时，滚动到顶部
 */
watch(
  () => props.selectedFolderKey,
  () => {
    scrollToTop()
  }
)
// 文件选择功能
const {
  containerRef,
  initDragSelect,
  updateSelectables,
  isSelected,
  handleItemClick: handleSelectionClick,
  handleMouseDown,
  handleMouseUp,
  setDeleteCallback,
  clearSelection,
  getSelectedIds,
  getIsMouseOnSelectedFile,
  setSelected,
  setFavoriteToggleCallback,
  setInlineRenameCallback,
  setLocateInFolderCallback,
  pauseDragSelect,
  resumeDragSelect
} = useFileSelection({
  getItems: () =>
    [...folderFiles.value, ...assetFiles.value].map((file) => ({
      id: getItemId(file),
      type: file.type === 'folder' ? 'folder' : 'file'
    })),
  loadAll: async () => {
    const close = message.loading(t('common.loading'), 0)
    const scope = props.selectionScope
    try {
      const complete = (await props.ensureFilesLoaded?.()) ?? !props.hasMore
      await nextTick()
      if (!complete && scope === props.selectionScope) message.warning(t('common.loadFailed'))
      return complete && scope === props.selectionScope
    } catch (error) {
      message.error(resolveErrorText(error, t('common.loadFailed')))
      return false
    } finally {
      close()
    }
  }
})

watch(
  () => props.selectionScope,
  () => {
    clearSelection()
    scrollToTop()
  },
  { flush: 'sync' }
)
watch(
  visibleAssetFiles,
  () => {
    void updateSelectables()
  },
  { flush: 'post' }
)

const getActiveScrollContainer = (): HTMLElement | null => {
  return containerRef.value || scrollContainerRef.value
}

const maybeEmitLoadMore = () => {
  if (!props.hasMore || props.isLoadingMore || props.loading) return

  const container = getActiveScrollContainer()
  if (!container) return

  const threshold = 300
  const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  const contentUnderfilled = container.scrollHeight <= container.clientHeight + threshold

  if (contentUnderfilled || distanceToBottom <= threshold) {
    emit('load-more')
  }
}

/**
 * Trigger loading when the virtual scroll state reaches the bottom.
 */
watch(isNearBottom, () => {
  maybeEmitLoadMore()
})

/**
 * Refresh the virtual scroll metrics after the file list changes.
 */
watch(
  () => props.files,
  () => {
    nextTick(() => {
      updateScrollPosition()
      maybeEmitLoadMore()
    })
  },
  { deep: false }
)

watch(
  () => [props.hasMore, props.isLoadingMore, props.loading, isFileSectionExpanded.value],
  () => {
    nextTick(() => {
      updateScrollPosition()
      maybeEmitLoadMore()
    })
  },
  { immediate: true }
)

// 拖拽相关状态
const isDraggingSelection = ref(false)
const maybeDrag = ref(false)
const dragStartPos = ref<{ x: number; y: number } | null>(null)
const dragOverlayPos = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const dragThreshold = 4

// 选中项与数量
const selectedIds = computed(() => getSelectedIds())
const selectedItems = computed(() => {
  const map = new Map(props.files.map((f: any) => [getItemId(f), f]))
  return selectedIds.value.map((id) => map.get(id)).filter(Boolean) as Array<
    AssetDataRow | FolderItem
  >
})

// 容器鼠标事件：按下、移动、松开
const onContainerPointerDown = (event: PointerEvent) => {
  const wasOnSelectedItem = getIsMouseOnSelectedFile(event.target as HTMLElement)

  // 保留选择逻辑
  handleMouseDown(event)

  // Only start drag-prep when the pointer was already on a selected item
  // before the current pointerdown updates selection state.
  maybeDrag.value = wasOnSelectedItem && !event.altKey && libraryCaps.value.canEditStructure
  if (maybeDrag.value) {
    // 捕获指针，确保移动事件持续触发
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    dragStartPos.value = { x: event.clientX, y: event.clientY }
    dragOverlayPos.value = { x: event.clientX + 12, y: event.clientY + 12 }
  } else {
    isDraggingSelection.value = false
    dragStartPos.value = null
  }
}

const onContainerPointerUp = async (event: PointerEvent) => {
  // 释放指针捕获
  if (maybeDrag.value) {
    try {
      ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
    } catch (e) {
      // 忽略可能的释放错误
    }
  }

  // 保留选择逻辑
  handleMouseUp(event)

  if (isDraggingSelection.value) {
    // 基于鼠标位置解析落点
    const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    const dropItem = el?.closest('.file-item') as HTMLElement | null
    if (dropItem && dropItem.classList.contains('folder-item')) {
      const dropId = dropItem.getAttribute('data-file-id') || ''
      // 仅当落点是未选中的文件夹时执行移动
      if (dropId && !isSelected(dropId)) {
        const plainItems = selectedItems.value.map((it) => ({
          id: getItemId(it),
          type: ((it as any).type === 'folder' ? 'folder' : 'file') as 'folder' | 'file'
        }))
        try {
          const resp = await (window as any).api.dragMove.moveItems(plainItems, dropId)
          if (resp?.success && resp.data?.success) {
            message.success(
              t('assetLib.fileList.moveSuccess', {
                folders: resp.data.movedItems.folders,
                files: resp.data.movedItems.files
              })
            )
            // 刷新左侧树的源与目标节点
            await assetContext.refreshTreeForMove(props.selectedFolderKey, dropId, plainItems)
            // 刷新当前文件夹数据
            await assetContext.refreshCurrentFolder()
            // 成功后清空选中数据
            clearSelection()
          } else {
            const msg = resp?.data?.message || resp?.error || t('assetLib.fileList.moveFailed')
            message.error(resolveErrorText(msg, t('assetLib.fileList.moveFailed')))
          }
        } catch (err) {
          message.error(
            resolveErrorText(err, t('assetLib.fileList.moveError', { error: String(err) }))
          )
        }
      }
    }
  }

  // 重置拖拽状态
  isDraggingSelection.value = false
  maybeDrag.value = false
  dragStartPos.value = null
  emit('drag-overlay-end')
}

/**
 * 处理文件/文件夹项的单击事件
 * - 调用选择逻辑（支持 Ctrl/Shift 多选）
 * - 同时触发 file-click 或 folder-select 事件更新详情面板
 * @param file 点击的文件或文件夹对象
 * @param event 鼠标事件
 */
let lastOpenedFolderId = ''
let lastOpenedFolderAt = 0

const emitFolderOpen = (file: FolderItem): void => {
  // 回收站里的文件夹进不去（它还在删除态，树上没有它），这里一并挡住
  // ——「第二次单击当双击」那条兜底路径也会走到这儿
  if (isTrashView.value) {
    message.info(t('assetFileList.restore.openDeletedFolder'))
    return
  }

  const folderId = getItemId(file)
  const now = Date.now()

  // Deduplicate folder-open triggers from click.detail and native dblclick.
  if (folderId && folderId === lastOpenedFolderId && now - lastOpenedFolderAt < 400) {
    return
  }

  lastOpenedFolderId = folderId
  lastOpenedFolderAt = now
  emit('folder-click', file)
}

const handleItemClick = (file: AssetDataRow | FolderItem, event: MouseEvent): void => {
  // 关闭右键菜单（如果打开的话）
  contextMenuRef.value?.hide()

  // 获取文件/文件夹的 ID
  const fileId = getItemId(file)

  // 调用选择逻辑（处理多选等）
  handleSelectionClick(fileId, event)

  // 根据类型触发不同事件更新详情面板
  if ((file as FolderItem).type === 'folder') {
    // Some drag/selection flows swallow native dblclick on folder cards.
    // Use the second click as a reliable enter-folder fallback.
    if (event.detail >= 2) {
      emitFolderOpen(file as FolderItem)
      return
    }
    emit('folder-select', file as FolderItem)
  } else {
    emit('file-click', file as AssetDataRow)
  }
}

// 右键菜单相关
const contextMenuRef = ref()
const currentRightClickAsset = ref<any | null>(null)

// 资产相关菜单项
const assetMenuItems = computed<MenuItem[]>(() => [
  {
    key: 'import-to-project',
    label: t('assetLib.contextMenu.importToProject'),
    icon: PhDownloadSimple
  },
  {
    key: 'divider-asset-0',
    label: '',
    type: 'divider'
  },
  {
    key: 'rename',
    label: t('assetLib.contextMenu.rename'),
    icon: PhPencilSimple,
    shortcut: 'F2'
  },
  {
    key: 'add-tags',
    label: t('assetLib.contextMenu.addTags'),
    icon: PhTag
  },
  {
    key: 'favorite',
    label: t('assetLib.contextMenu.addToFav'),
    icon: PhStar,
    shortcut: 'CommandOrControl+D'
  },
  {
    key: 'reimport',
    label: t('assetLib.contextMenu.reimport', '修复资产依赖'),
    icon: PhArrowsClockwise
  },
  {
    key: 'locate-in-folder',
    label: t('assetLib.contextMenu.locateInFolder', '跳转到所在目录'),
    icon: PhFolderOpen,
    shortcut: 'CommandOrControl+B'
  },
  {
    key: 'recrop-thumbnail',
    label: t('assetFileList.contextMenu.recropThumbnail'),
    icon: PhImage
  },
  {
    key: 'divider-asset-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'upload-baiduyun',
    label: t('assetLib.contextMenu.uploadToBaiduyun', '上传到百度网盘'),
    icon: PhCloudArrowUp
  },
  {
    key: 'upload-webdav',
    label: t('assetLib.contextMenu.uploadToWebdav', '上传到 WebDAV'),
    icon: PhCloudArrowUp
  },

  {
    key: 'divider-asset-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'delete',
    label: t('assetLib.contextMenu.delete'),
    icon: PhTrash,
    danger: true,
    shortcut: 'Delete'
  }
])

// 已收藏资产的菜单项
const favoriteAssetMenuItems = computed<MenuItem[]>(() => [
  {
    key: 'import-to-project',
    label: t('assetLib.contextMenu.importToProject'),
    icon: PhDownloadSimple
  },
  {
    key: 'divider-fav-0',
    label: '',
    type: 'divider'
  },
  {
    key: 'rename',
    label: t('assetLib.contextMenu.rename'),
    icon: PhPencilSimple,
    shortcut: 'F2'
  },
  {
    key: 'add-tags',
    label: t('assetLib.contextMenu.addTags'),
    icon: PhTag
  },
  {
    key: 'unfavorite',
    label: t('assetLib.contextMenu.removeFromFav'),
    icon: PhStar,
    shortcut: 'CommandOrControl+D'
  },
  {
    key: 'upload-baiduyun',
    label: t('assetLib.contextMenu.uploadToBaiduyun', '上传到百度网盘'),
    icon: PhCloudArrowUp
  },
  {
    key: 'upload-webdav',
    label: t('assetLib.contextMenu.uploadToWebdav', '上传到 WebDAV'),
    icon: PhCloudArrowUp
  },
  {
    key: 'reimport',
    label: t('assetLib.contextMenu.reimport', '修复资产'),
    icon: PhArrowsClockwise
  },
  {
    key: 'locate-in-folder',
    label: t('assetLib.contextMenu.locateInFolder', '在文件夹视图中显示'),
    icon: PhFolderOpen,
    shortcut: 'CommandOrControl+B'
  },
  {
    key: 'recrop-thumbnail',
    label: t('assetFileList.contextMenu.recropThumbnail'),
    icon: PhImage
  },
  {
    key: 'divider-asset-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'delete',
    label: t('assetLib.contextMenu.delete'),
    icon: PhTrash,
    danger: true,
    shortcut: 'Delete'
  }
])

// 文件夹相关菜单项（未收藏）
const folderMenuItems = computed<MenuItem[]>(() => [
  {
    key: 'import-to-project',
    label: t('assetLib.contextMenu.importToProject'),
    icon: PhDownloadSimple
  },
  {
    key: 'divider-folder-0',
    label: '',
    type: 'divider'
  },
  {
    key: 'rename-folder',
    label: t('assetLib.contextMenu.rename'),
    icon: PhPencilSimple,
    shortcut: 'F2'
  },
  {
    key: 'add-tags-folder',
    label: t('assetLib.contextMenu.addTags'),
    icon: PhTag
  },
  {
    key: 'set-color-folder',
    label: t('assetLib.contextMenu.setColor', '修改颜色'),
    icon: PhPalette
  },
  {
    key: 'favorite-folder',
    label: t('assetLib.contextMenu.addToFav'),
    icon: PhStar,
    shortcut: 'CommandOrControl+D'
  },
  {
    key: 'upload-baiduyun',
    label: t('assetLib.contextMenu.uploadToBaiduyun', '上传到百度网盘'),
    icon: PhCloudArrowUp
  },
  {
    key: 'upload-webdav',
    label: t('assetLib.contextMenu.uploadToWebdav', '上传到 WebDAV'),
    icon: PhCloudArrowUp
  },
  {
    key: 'reimport-folder',
    label: t('assetLib.contextMenu.reimport', '修复资产'),
    icon: PhArrowsClockwise
  },
  {
    key: 'divider-folder-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'delete-folder',
    label: t('assetLib.contextMenu.delete'),
    icon: PhTrash,
    danger: true,
    shortcut: 'Delete'
  }
])

// 文件夹相关菜单项（已收藏）
const favoriteFolderMenuItems = computed<MenuItem[]>(() => [
  {
    key: 'import-to-project',
    label: t('assetLib.contextMenu.importToProject'),
    icon: PhDownloadSimple
  },
  {
    key: 'divider-folder-0',
    label: '',
    type: 'divider'
  },
  {
    key: 'rename-folder',
    label: t('assetLib.contextMenu.rename'),
    icon: PhPencilSimple,
    shortcut: 'F2'
  },
  {
    key: 'add-tags-folder',
    label: t('assetLib.contextMenu.addTags'),
    icon: PhTag
  },
  {
    key: 'unfavorite-folder',
    label: t('assetLib.contextMenu.removeFromFav'),
    icon: PhStar,
    shortcut: 'CommandOrControl+D'
  },
  {
    key: 'upload-baiduyun',
    label: t('assetLib.contextMenu.uploadToBaiduyun', '上传到百度网盘'),
    icon: PhCloudArrowUp
  },
  {
    key: 'upload-webdav',
    label: t('assetLib.contextMenu.uploadToWebdav', '上传到 WebDAV'),
    icon: PhCloudArrowUp
  },
  {
    key: 'reimport-folder',
    label: t('assetLib.contextMenu.reimport', '修复资产'),
    icon: PhArrowsClockwise
  },
  {
    key: 'divider-folder-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'delete-folder',
    label: t('assetLib.contextMenu.delete'),
    icon: PhTrash,
    danger: true,
    shortcut: 'Delete'
  }
])

// 空白区域菜单项
const emptyAreaMenuItems = computed<MenuItem[]>(() => [
  {
    key: 'add-folder',
    label: t('assetLib.contextMenu.newFolder'),
    icon: PhFolderPlus,
    shortcut: 'Ctrl+Shift+N'
  },
  {
    key: 'divider-empty-1',
    label: '',
    type: 'divider'
  },
  {
    key: 'refresh',
    label: t('assetLib.contextMenu.refresh'),
    icon: PhArrowClockwise,
    shortcut: 'F5'
  }
])

// 当前右键菜单项
// 当前右键菜单项
const currentContextMenuItems = computed(() => {
  // 不能改结构的库（服务器库）：只留"导入到工程"（经 lore 下载）和"跳转到所在目录"
  if (!libraryCaps.value.canEditStructure) {
    const clicked = currentRightClickAsset.value as {
      type?: string
      id?: string
      folderKey?: string
      assetKey?: string
    } | null
    if (!clicked) return []
    // 收藏：服务器库的收藏记在本机，和本地库一样的菜单项
    if (clicked.type === 'folder') {
      const folderKey = String(clicked.id || clicked.folderKey || '')
      const items: MenuItem[] = []
      if (libraryCaps.value.folderColor)
        items.push({
          key: 'set-color-folder',
          label: t('assetLib.contextMenu.setColor', '修改颜色'),
          icon: PhPalette
        })
      if (libraryCaps.value.canFavorite)
        items.push(
          getFolderFavoriteStatus(folderKey)
            ? {
                key: 'unfavorite-folder',
                label: t('assetLib.contextMenu.removeFromFav'),
                icon: PhStar
              }
            : { key: 'favorite-folder', label: t('assetLib.contextMenu.addToFav'), icon: PhStar }
        )
      return items
    }
    const items: MenuItem[] = [
      {
        key: 'import-to-project',
        // 不可用时把原因写在菜单项里（菜单项没有悬浮提示）
        label: libraryCaps.value.canSendToProject
          ? t('assetLib.contextMenu.importToProject')
          : `${t('assetLib.contextMenu.importToProject')}（${capabilityReason('canSendToProject')}）`,
        icon: PhDownloadSimple,
        disabled: !libraryCaps.value.canSendToProject
      },
      {
        key: 'locate-in-folder',
        label: t('assetLib.contextMenu.locateInFolder'),
        icon: PhFolderOpen
      }
    ]
    if (libraryCaps.value.canFavorite) {
      const assetKey = String(clicked.assetKey || clicked.id || '')
      items.push(
        getFavoriteStatus(assetKey)
          ? { key: 'unfavorite', label: t('assetLib.contextMenu.removeFromFav'), icon: PhStar }
          : { key: 'favorite', label: t('assetLib.contextMenu.addToFav'), icon: PhStar }
      )
    }
    // 团队工程：问他改完没 / 收回 / 发给外包 ▸（方案 4.5，按需出现）
    if (libraryCaps.value.team) items.push(...teamAsset.menuItems(pathOfFile(clicked)))
    return items
  }
  // 回收站视图：显示专用菜单（恢复、彻底删除）
  if (isTrashView.value) {
    if (!currentRightClickAsset.value) {
      // 回收站空白区域菜单
      return [
        {
          key: 'refresh',
          label: t('assetLib.contextMenu.refresh'),
          icon: PhArrowClockwise,
          shortcut: 'F5'
        }
      ]
    }
    // 回收站资产/文件夹菜单
    return [
      {
        key: 'restore',
        label: t('assetLib.contextMenu.restore', '恢复'),
        icon: PhArrowUUpLeft
      },
      {
        key: 'divider-trash-1',
        label: '',
        type: 'divider' as const
      },
      {
        key: 'permanent-delete',
        label: t('assetLib.contextMenu.permanentDelete', '彻底删除'),
        icon: PhTrashSimple,
        danger: true
      }
    ]
  }

  if (!currentRightClickAsset.value) {
    return emptyAreaMenuItems.value
  }

  if ((currentRightClickAsset.value as any).type === 'folder') {
    // 检查文件夹是否已收藏
    const folderKey = (currentRightClickAsset.value as any).id
    let isFolderFav = getFolderFavoriteStatus(folderKey)

    // 批量模式：检查所有选中的文件夹
    const selectedIds = getSelectedIds()
    const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
    if (selectedIds.length > 1 && isClickedInSelection) {
      // 如果选中项中有任何一个已收藏，则整体视为已收藏（优先显示取消收藏）
      const selectedFolders = selectedItems.value.filter((item) => (item as any).type === 'folder')
      const hasAnyFav = selectedFolders.some((f) => getFolderFavoriteStatus((f as any).id))
      if (hasAnyFav) {
        isFolderFav = true
      }
    }

    const baseFolderMenu = isFolderFav
      ? [...favoriteFolderMenuItems.value]
      : [...folderMenuItems.value]

    // 如果是插件文件夹，修改"导入项目"为"导入插件到项目"
    const folderType = (currentRightClickAsset.value as any).folderType
    if (folderType === 'plugin') {
      const importItem = baseFolderMenu.find((item) => item.key === 'import-to-project')
      if (importItem) {
        importItem.label = t('assetLib.contextMenu.importPluginToProject')
      }
    }

    if (currentVault.value?.vaultType === 'network') {
      baseFolderMenu.splice(1, 0, {
        key: 'open-local-path-folder',
        label: t('assetLib.contextMenu.openLocalPath', '打开本地路径'),
        icon: PhFolderOpen
      })
    }

    return baseFolderMenu
  }

  const assetKey = (currentRightClickAsset.value as any).assetKey
  let isFavorite = getFavoriteStatus(assetKey)

  // 批量模式：检查所有选中的资产
  const selectedIds = getSelectedIds()
  const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
  if (selectedIds.length > 1 && isClickedInSelection) {
    // 如果选中项中有任何一个已收藏，则整体视为已收藏（优先显示取消收藏）
    const selectedAssets = selectedItems.value.filter((item) => (item as any).type !== 'folder')
    const hasAnyFav = selectedAssets.some((f) => getFavoriteStatus((f as any).assetKey))
    if (hasAnyFav) {
      isFavorite = true
    }
  }

  // 复制基础菜单
  const menuItems = isFavorite ? [...favoriteAssetMenuItems.value] : [...assetMenuItems.value]

  menuItems.splice(1, 0, {
    key: 'open-local-path',
    label: t('assetLib.contextMenu.openLocalPath', '打开本地路径'),
    icon: PhFolderOpen
  })

  // 服务器库里的压缩包资产：整包取回
  if (isHttpServerVault.value && isArchiveAsset(currentRightClickAsset.value)) {
    menuItems.splice(1, 0, {
      key: 'pull-project-archive',
      label: t('assetLib.contextMenu.pullProjectArchive', '取回工程整包…'),
      icon: PhFileZip
    })
  }

  // 如果是图片文件，添加"用作参考图生成"选项
  if (
    isImageFile(
      currentRightClickAsset.value?.assetName,
      currentRightClickAsset.value?.fileExtension
    )
  ) {
    menuItems.splice(2, 0, {
      key: 'use-as-reference-image',
      label: t('assetLib.contextMenu.useAsReference', '用作参考图生成'),
      icon: PhImage
    })
  }

  // 如果是 3D 模型，添加捕获缩略图选项
  if (is3DModel(currentRightClickAsset.value)) {
    // 动态计算插入位置（"打开本地路径"在网络模式下不存在，索引需减1）
    const hasOpenLocalPath = menuItems.some((item) => item.key === 'open-local-path')
    const insertIndex = hasOpenLocalPath ? 6 : 5
    if (!menuItems.find((item) => item.key === 'capture-thumbnail')) {
      menuItems.splice(insertIndex, 0, {
        key: 'capture-thumbnail',
        label: t('assetLib.contextMenu.captureThumbnail', '捕获缩略图'),
        icon: PhCamera
      })
    }
  }

  // 如果是 .uplugin 文件，修改"导入项目"为"导入插件到项目"
  const fileExtension = (currentRightClickAsset.value as any)?.fileExtension?.toLowerCase()
  if (fileExtension === 'uplugin') {
    const importItem = menuItems.find((item) => item.key === 'import-to-project')
    if (importItem) {
      importItem.label = t('assetLib.contextMenu.importPluginToProject')
    }
  }

  return menuItems
})

// 模态框状态
const addFolderModalVisible = ref(false)

// 重命名资产对话框
const renameAssetModalVisible = ref(false)
const renameAssetForm = reactive({
  name: '',
  assetKey: ''
})

// 重命名文件夹对话框
const renameFolderModalVisible = ref(false)
const renameFolderForm = reactive({
  name: '',
  folderKey: ''
})

const tagSelectorVisible = ref(false)
const tagSelectorAssetKey = ref('')
const tagSelectorAssetKeys = ref<string[]>([])
const currentAssetTagIds = ref<number[]>([])

// 标签选择确认：为当前资产设置标签集合
const handleAddTagsConfirm = async (tagIds: number[]) => {
  // 优先使用批量列表，如果为空则回退到单个Key
  const targetKeys =
    tagSelectorAssetKeys.value.length > 0
      ? tagSelectorAssetKeys.value
      : tagSelectorAssetKey.value
        ? [tagSelectorAssetKey.value]
        : []

  if (targetKeys.length === 0) {
    message.error(t('assetFileList.tags.noAssetSelected'))
    return
  }
  try {
    const cleanTagIds = Array.isArray(tagIds)
      ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []

    // 批量更新所有目标资产
    const promises = targetKeys.map((key) =>
      (window as any).api.database.assetTag.setTagsForAsset(String(key), cleanTagIds)
    )

    await Promise.all(promises)

    // 这里简化处理，默认全部成功
    currentAssetTagIds.value = cleanTagIds
    const count = targetKeys.length
    message.success(
      count > 1 ? t('assetFileList.tags.assetsUpdated', { count }) : t('assetFileList.tags.updated')
    )

    // 关闭选择器并刷新列表
    tagSelectorVisible.value = false
    await assetContext.refreshCurrentFolder()
  } catch (err) {
    console.error('更新标签异常', err)
    message.error(t('assetFileList.tags.updateFailed'))
  }
}

// ==================== 重新剪裁缩略图 ====================
const recropModalOpen = ref(false)
const recropImage = ref<string>('')
const recropOriginalFileName = ref<string>('')
const recropTargetAsset = ref<AssetDataRow | null>(null)

/**
 * 重新剪裁确认：只覆盖 _thumb 压缩版，原图和 DB 保持不变
 */
const onRecropConfirm = async (croppedDataUrl: string): Promise<void> => {
  const posterName = recropOriginalFileName.value
  if (!posterName) {
    recropModalOpen.value = false
    return
  }

  try {
    const result = await (window as any).api.asset.overwriteThumb(
      posterName,
      croppedDataUrl,
      recropTargetAsset.value?.assetKey
    )
    if (result?.success) {
      message.success(t('assetFileList.recrop.updated'))
      // 刷新列表（缓存已在主进程侧清除）
      await assetContext.refreshCurrentFolder()
    } else {
      message.error(result?.error || t('assetFileList.recrop.saveFailed'))
    }
  } catch (err) {
    console.error('重新剪裁失败:', err)
    message.error(t('assetFileList.recrop.failed'))
  } finally {
    recropModalOpen.value = false
    recropImage.value = ''
    recropOriginalFileName.value = ''
    recropTargetAsset.value = null
  }
}

// ==================== 颜色选择器相关 ====================
/**
 * 颜色选择器状态
 */
const colorPickerVisible = ref(false)
const colorPickerTarget = ref<{
  type: 'asset' | 'folder'
  key: string
  keys?: string[]
  currentColor?: string
} | null>(null)

/**
 * 颜色选择确认：更新资产或文件夹的颜色
 * @param color 选择的颜色值（十六进制格式），null 表示清除颜色
 */
const handleColorPickerConfirm = async (color: string | null): Promise<void> => {
  if (!colorPickerTarget.value) return

  const { type, key, keys } = colorPickerTarget.value
  // 确定目标 Key 列表
  const targetKeys = keys && keys.length > 0 ? keys : [key]
  try {
    if (type === 'asset') {
      // 批量更新资产颜色
      const promises = targetKeys.map((k) =>
        (window as any).api.database.assetData.update(k, { color })
      )
      const results = await Promise.all(promises)

      // 统计成功数量
      const successCount = results.filter((r) => r?.success === true || r?.updated === true).length

      if (successCount > 0) {
        // 批量更新本地数据
        targetKeys.forEach((k) => {
          const file = props.files.find((f) => f.assetKey === k || (f as any).id === k)
          if (file) {
            ;(file as any).color = color || undefined
          }
        })
        message.success(
          successCount > 1
            ? t('assetFileList.colors.filesUpdated', { count: successCount })
            : color
              ? t('assetLib.contextMenu.colorUpdated', '颜色已更新')
              : t('assetLib.contextMenu.colorCleared', '颜色已清除')
        )
      } else {
        console.error('[AssetFileList] 更新资产颜色失败')
        message.error(t('assetLib.contextMenu.colorUpdateFailed', '颜色更新失败'))
      }
    } else {
      // 批量更新文件夹颜色
      // 走数据源：本地库改保管库里的文件夹记录，服务器库写注释（folderPath + color）
      const promises = targetKeys.map((k) => getActiveLibrarySource().folders.setColor(k, color))
      const results = await Promise.all(promises)

      const successCount = results.filter((r) => r.ok).length

      if (successCount > 0) {
        // 批量更新本地数据
        targetKeys.forEach((k) => {
          // 实时更新树节点颜色
          assetContext.updateTreeNodeColor(k, color)

          const folder = props.files.find(
            (f) =>
              (f as any).type === 'folder' && ((f as any).id === k || (f as any).folderKey === k)
          )
          if (folder) {
            ;(folder as any).color = color || undefined
          }
        })
        message.success(
          successCount > 1
            ? t('assetFileList.colors.foldersUpdated', { count: successCount })
            : color
              ? t('assetLib.contextMenu.colorUpdated', '颜色已更新')
              : t('assetLib.contextMenu.colorCleared', '颜色已清除')
        )
      } else {
        console.error('[AssetFileList] 更新文件夹颜色失败')
        message.error(t('assetLib.contextMenu.colorUpdateFailed', '颜色更新失败'))
      }
    }
  } catch (err) {
    console.error('[AssetFileList] 更新颜色失败:', err)
    message.error(t('assetLib.contextMenu.colorUpdateFailed', '颜色更新失败'))
  } finally {
    colorPickerVisible.value = false
    colorPickerTarget.value = null
  }
}

// ==================== 文件夹标签选择器相关 ====================
/**
 * 文件夹标签选择器状态
 */
const folderTagSelectorVisible = ref(false)
const folderTagSelectorKey = ref('')
const folderTagSelectorKeys = ref<string[]>([])
const currentFolderTagIds = ref<number[]>([])

/**
 * 文件夹标签选择确认：为当前文件夹设置标签集合
 * @param tagIds 选中的标签ID数组
 */
const handleAddFolderTagsConfirm = async (tagIds: number[]): Promise<void> => {
  // 优先使用批量列表，如果为空则回退到单个Key
  const targetKeys =
    folderTagSelectorKeys.value.length > 0
      ? folderTagSelectorKeys.value
      : folderTagSelectorKey.value
        ? [folderTagSelectorKey.value]
        : []

  if (targetKeys.length === 0) {
    message.error(t('assetFileList.tags.noFolderSelected'))
    return
  }
  try {
    const cleanTagIds = Array.isArray(tagIds)
      ? tagIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : []

    // 批量更新所有目标文件夹
    const promises = targetKeys.map((key) =>
      folderTagAPI.setTagsForFolder(String(key), cleanTagIds)
    )

    await Promise.all(promises)

    currentFolderTagIds.value = cleanTagIds
    const count = targetKeys.length
    message.success(
      count > 1
        ? t('assetFileList.tags.foldersUpdated', { count })
        : t('assetFileList.tags.folderUpdated')
    )

    // 关闭选择器并刷新列表
    folderTagSelectorVisible.value = false
    await assetContext.refreshCurrentFolder()
  } catch (err) {
    console.error('更新文件夹标签异常', err)
    message.error(t('assetFileList.tags.folderUpdateFailed'))
  }
}

// 导入到工程：弹窗状态与回调
const importProjectModalVisible = ref(false)
const importProjectSource = ref<any | null>(null)

// 文件类型判断：支持通过文件名后缀或 fileExtension 字段判断
const isImageFile = (filename: string, fileExtension?: string) => {
  const imageExts = [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'bmp',
    'svg',
    'webp',
    'tga',
    'dds',
    'tif',
    'tiff',
    'avif'
  ]

  // 优先使用 fileExtension 字段判断
  if (fileExtension) {
    const ext = fileExtension.toLowerCase().replace(/^\./, '')
    if (imageExts.includes(ext)) {
      return true
    }
  }

  // 否则使用文件名后缀判断
  return imageExts.some((ext) => filename.toLowerCase().endsWith('.' + ext))
}

// 已移除未使用的文本文件判断函数，避免类型检查警告

// 获取资产类型颜色（用于颜色条和ID Line）
const getAssetTypeColorForFile = (file: any): string => {
  return getAssetTypeColor(file.className, file.assetName)
}

/**
 * 从资产对象提取扩展名（小写、无点）
 */
const getFileExtLower = (file: any): string => {
  if (!file || file?.type === 'folder') return ''
  const norm = (s: string): string =>
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '')

  const fromField = norm(file.fileExtension || file.ext || '')
  if (fromField) return fromField

  const path = String(file.originPath || file.filePath || file.path || '')
  if (path) {
    const base = path.split(/[\\/]/).pop() || ''
    const idx = base.lastIndexOf('.')
    if (idx > 0 && idx < base.length - 1) {
      const fromPath = norm(base.slice(idx + 1))
      if (fromPath) return fromPath
    }
  }

  const name = String(file.assetName || file.name || '')
  const idx = name.lastIndexOf('.')
  if (idx > 0 && idx < name.length - 1) {
    const fromName = norm(name.slice(idx + 1))
    if (fromName) return fromName
  }

  return ''
}

// 获取图标颜色（用于实心图标）
const getIconColor = (file: any): string => {
  // 如果是UE资产（有className），使用资产类型对应的颜色
  if (file.className) {
    return getAssetTypeColorForFile(file)
  }

  // 没有 className 的通用文件：根据扩展名按“大类型”配色
  const ext = getFileExtLower(file)
  if (!ext) return 'var(--color-filetype-unknown)'

  // UE 资产文件（有时 className 缺失）：仍按 UE 颜色逻辑走
  if (ext === 'uasset' || ext === 'umap') {
    return getAssetTypeColor(undefined, String(file.assetName || file.name || '') || `.${ext}`)
  }

  const inSet = (v: string, set: string[]): boolean => set.includes(v)

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tga', 'dds', 'psd', 'exr']
  const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'webm', 'm4v']
  const audioExts = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg']
  const modelExts = ['fbx', 'obj', 'gltf', 'glb', 'stl', 'blend']
  const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']
  const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown']
  const codeExts = [
    'ts',
    'js',
    'jsx',
    'tsx',
    'vue',
    'd.ts',
    'cpp',
    'h',
    'hpp',
    'c',
    'cs',
    'py',
    'java',
    'json',
    'xml',
    'html',
    'css',
    'less',
    'scss',
    'sass',
    'yml',
    'yaml',
    'toml',
    'ini',
    'conf',
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

  // 分类色走语义变量，深浅两套各有一份值（见 gen-palette.mjs 的 FILETYPE_HUES）。
  // 以前这里是写死的 rgba(...)，只按深色底调过 —— 亮色模式下兜底是半透明白，
  // 白底白图标，等于没有图标。
  if (inSet(ext, imageExts)) return 'var(--color-filetype-image)'
  if (inSet(ext, videoExts)) return 'var(--color-filetype-video)'
  if (inSet(ext, audioExts)) return 'var(--color-filetype-audio)'
  if (inSet(ext, modelExts)) return 'var(--color-filetype-model)'
  if (inSet(ext, archiveExts)) return 'var(--color-filetype-archive)'
  if (inSet(ext, docExts)) return 'var(--color-filetype-doc)'
  if (inSet(ext, codeExts)) return 'var(--color-filetype-code)'

  // 兜底
  return 'var(--color-filetype-unknown)'
}

// 日期格式化
const formatDate = (date: string) => {
  return new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 处理右键点击
const handleRightClick = (event: MouseEvent, file: any) => {
  event.preventDefault()
  event.stopPropagation()

  currentRightClickAsset.value = file
  // 服务器库在空白处 / 文件夹上没有可做的事：不弹一个空菜单
  if (currentContextMenuItems.value.length === 0) return
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

// 处理空白区域右键点击
const handleEmptyAreaRightClick = (event: MouseEvent) => {
  // 检查是否点击在文件项上
  const target = event.target as HTMLElement
  if (target.closest('.file-item')) {
    return // 如果点击在文件项上，不处理空白区域右键
  }

  event.preventDefault()
  event.stopPropagation()

  currentRightClickAsset.value = null // 清空当前选中的资产
  // 服务器库在空白处 / 文件夹上没有可做的事：不弹一个空菜单
  if (currentContextMenuItems.value.length === 0) return
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

/**
 * 空白区域左键点击：回退到显示当前文件夹详情
 * 仅当点击不在任何 .file-item 上时触发
 * @param event 鼠标点击事件
 */
const handleEmptyAreaClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement
  if (target.closest('.file-item')) {
    return
  }
  emit('empty-click')
}

const handleReimportAsset = async (assetKey: string) => {
  try {
    const loadingMessage = message.loading(t('assetFileList.repair.repairing'), 0)
    const res = await assetDataAPI.reimportAsset(assetKey)
    loadingMessage()
    if (res.success) {
      message.success(t('assetFileList.repair.success'))
      // 刷新当前文件夹
      assetContext.refreshCurrentFolder()
    } else {
      message.error(t('assetFileList.repair.failed', { error: res.error }))
    }
  } catch (error) {
    message.error(t('assetFileList.repair.failed', { error }))
  }
}

const handleReimportFolder = async (folderKey: string) => {
  try {
    const loadingMessage = message.loading(t('assetFileList.repair.repairing'), 0)
    const res = await assetDataAPI.reimportFolder(folderKey)
    loadingMessage()
    if (res.success) {
      message.success(
        t('assetFileList.repair.done', { success: res.successCount, failed: res.failed })
      )
      // 刷新当前文件夹
      assetContext.refreshCurrentFolder()
    } else {
      message.error(t('assetFileList.repair.failed', { error: res.error }))
    }
  } catch (error) {
    message.error(t('assetFileList.repair.failed', { error }))
  }
}

// 处理右键菜单点击
const handleContextMenuClick = async (key: string, _item: MenuItem) => {
  if (key.startsWith('team-') && libraryCaps.value.team) {
    const path = pathOfFile(currentRightClickAsset.value)
    const selected = (selectedAssetRowsForTeam() ?? []).filter(Boolean)
    const paths =
      selected.length > 1 && path && selected.includes(path) ? selected : path ? [path] : []
    if (paths.length > 0) await teamAsset.handleMenu(key, paths)
    return
  }
  switch (key) {
    case 'favorite':
      if (currentRightClickAsset.value) {
        handleToggleFavorite(true)
      }
      break
    case 'unfavorite':
      if (currentRightClickAsset.value) {
        handleToggleFavorite(false)
      }
      break
    case 'rename':
      if (currentRightClickAsset.value) {
        const id = getItemId(currentRightClickAsset.value)
        startInlineRename(id)
      }
      break
    case 'add-tags':
      if (currentRightClickAsset.value && (currentRightClickAsset.value as any).type !== 'folder') {
        const clickedId = (currentRightClickAsset.value as any).assetKey
        // 检查是否多选
        const selectedIds = getSelectedIds()
        const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))

        if (selectedIds.length > 1 && isClickedInSelection) {
          // 批量模式：收集所有选中的资产ID
          const selectedAssets = selectedItems.value.filter(
            (item) => (item as any).type !== 'folder'
          )
          tagSelectorAssetKeys.value = selectedAssets.map((item) => (item as any).assetKey)
          // 初始标签：使用右键点击项的标签作为参考
          tagSelectorAssetKey.value = clickedId
        } else {
          // 单选模式
          tagSelectorAssetKeys.value = []
          tagSelectorAssetKey.value = clickedId
        }

        try {
          // 获取初始标签显示（以右键点击的项为准）
          const tagIds = await assetTagAPI.getTagIdsByAssetKey(tagSelectorAssetKey.value)
          currentAssetTagIds.value = tagIds || []
        } catch (err) {
          currentAssetTagIds.value = []
        }
        tagSelectorVisible.value = true
      }
      break
    case 'set-color':
      // 修改资产颜色
      if (currentRightClickAsset.value && (currentRightClickAsset.value as any).type !== 'folder') {
        const assetKey = (currentRightClickAsset.value as any).assetKey
        const currentColor = (currentRightClickAsset.value as any).color || undefined

        // 检查是否多选
        const selectedIds = getSelectedIds()
        const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
        let targetKeys: string[] = []

        if (selectedIds.length > 1 && isClickedInSelection) {
          // 批量模式：收集所有选中的资产Key
          const selectedAssets = selectedItems.value.filter(
            (item) => (item as any).type !== 'folder'
          )
          targetKeys = selectedAssets.map((item) => (item as any).assetKey)
        }

        colorPickerTarget.value = { type: 'asset', key: assetKey, keys: targetKeys, currentColor }
        colorPickerVisible.value = true
      }
      break
    case 'set-color-folder':
      // 修改文件夹颜色
      if (currentRightClickAsset.value && (currentRightClickAsset.value as any).type === 'folder') {
        const folderKey = String(
          (currentRightClickAsset.value as any).id ||
            (currentRightClickAsset.value as any).folderKey ||
            ''
        )
        const currentColor = (currentRightClickAsset.value as any).color || undefined

        // 检查是否多选
        const selectedIds = getSelectedIds()
        const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
        let targetKeys: string[] = []

        if (selectedIds.length > 1 && isClickedInSelection) {
          // 批量模式：收集所有选中的文件夹Key
          const selectedFolders = selectedItems.value.filter(
            (item) => (item as any).type === 'folder'
          )
          targetKeys = selectedFolders.map((item) =>
            String((item as any).id || (item as any).folderKey)
          )
        }

        colorPickerTarget.value = { type: 'folder', key: folderKey, keys: targetKeys, currentColor }
        colorPickerVisible.value = true
      }
      break
    case 'import-to-project':
      if (!libraryCaps.value.canEditStructure) {
        openServerDownload()
        break
      }
      // 检查是否有多个选中项，且右键点击的文件在选中范围内
      if (currentRightClickAsset.value) {
        const clickedId = getItemId(currentRightClickAsset.value)
        const isClickedInSelection = selectedItems.value.some(
          (item) => getItemId(item) === clickedId
        )

        if (selectedItems.value.length > 1 && isClickedInSelection) {
          // 多选导入：创建虚拟批量结构，包含所有选中项作为 children
          importProjectSource.value = {
            type: 'batch',
            children: selectedItems.value
          }
        } else {
          // 单选导入：保持原有行为
          importProjectSource.value = currentRightClickAsset.value
        }
      } else {
        importProjectSource.value = null
      }
      importProjectModalVisible.value = true
      break
    case 'delete':
      handleBatchDeleteSelected()
      break
    case 'rename-folder':
      if (currentRightClickAsset.value) {
        const id = getItemId(currentRightClickAsset.value)
        startInlineRename(id)
      }
      break
    case 'delete-folder':
      handleBatchDeleteSelected()
      break
    case 'favorite-folder':
      if (currentRightClickAsset.value) {
        handleToggleFolderFavorite(true)
      }
      break
    case 'unfavorite-folder':
      if (currentRightClickAsset.value) {
        handleToggleFolderFavorite(false)
      }
      break
    case 'add-tags-folder':
      if (currentRightClickAsset.value && (currentRightClickAsset.value as any).type === 'folder') {
        const folderKey = String(
          (currentRightClickAsset.value as any).id ||
            (currentRightClickAsset.value as any).folderKey ||
            ''
        )

        // 检查是否多选
        const selectedIds = getSelectedIds()
        const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))

        if (selectedIds.length > 1 && isClickedInSelection) {
          // 批量模式：收集所有选中的文件夹ID
          const selectedFolders = selectedItems.value.filter(
            (item) => (item as any).type === 'folder'
          )
          folderTagSelectorKeys.value = selectedFolders.map((item) => (item as any).id)
          // 初始标签：使用右键点击项的标签作为参考
          folderTagSelectorKey.value = folderKey
        } else {
          // 单选模式
          folderTagSelectorKeys.value = []
          folderTagSelectorKey.value = folderKey
        }

        try {
          const resp = await folderTagAPI.getTagIdsByFolderKey(folderKey)
          currentFolderTagIds.value = resp || []
        } catch {
          currentFolderTagIds.value = []
        }
        folderTagSelectorVisible.value = true
      }
      break
    case 'add-folder':
      handleAddFolder()
      break
    case 'refresh':
      handleRefresh()
      break
    case 'capture-thumbnail':
      if (currentRightClickAsset.value) {
        const file = currentRightClickAsset.value
        // 使用 getLocalFilePath 获取正确的本地路径（处理备份模式和引用模式的差异）
        const localPath = getLocalFilePath(file as AssetDataRow)
        if (!localPath) {
          message.warning(t('assetFileList.thumbnail.pathFailed'))
          break
        }
        // 添加到队列头部优先处理
        thumbnailQueue.value.unshift({
          assetKey: file.assetKey,
          filePath: localPath,
          fileType: 'model'
        })
        message.success(t('assetFileList.thumbnail.queueAdded'))
      }
      break
    case 'recrop-thumbnail':
      if (currentRightClickAsset.value) {
        const asset = currentRightClickAsset.value
        const posterName = asset.customPoster
        if (!posterName) {
          message.warning(t('assetFileList.recrop.noCustomThumbnail'))
          break
        }
        // 构建原图 URL（VueCropper 支持加载 URL）
        const vault = currentVault.value
        if (!vault) break
        const isNetwork = vault.vaultType === VaultType.NETWORK
        let basePath = vault.path
        if (isNetwork && vault.networkPath) {
          basePath = vault.networkPath
        }
        const originalUrl = buildThumbnailUrl(basePath, posterName, isNetwork)
        if (!originalUrl) {
          message.error(t('assetFileList.recrop.originalPathFailed'))
          break
        }
        // 打开剪裁器
        recropOriginalFileName.value = posterName
        recropTargetAsset.value = asset as AssetDataRow
        recropImage.value = originalUrl
        recropModalOpen.value = true
      }
      break
    case 'upload-baiduyun':
      if (currentRightClickAsset.value) {
        await handleUploadToBaiduyun(currentRightClickAsset.value)
      }
      break
    case 'upload-webdav':
      if (currentRightClickAsset.value) {
        await handleUploadToWebdav(currentRightClickAsset.value)
      }
      break
    case 'reimport':
      if (currentRightClickAsset.value) {
        handleReimportAsset(currentRightClickAsset.value.assetKey)
      }
      break
    case 'reimport-folder':
      if (currentRightClickAsset.value) {
        handleReimportFolder(
          currentRightClickAsset.value.id || currentRightClickAsset.value.folderKey
        )
      }
      break

    case 'open-local-path':
      // 打开资产文件的本地路径
      if (currentRightClickAsset.value) {
        const localPath = await getAssetBrowsePath(currentRightClickAsset.value as AssetDataRow)
        if (localPath) {
          try {
            const result = (await window.api.invoke('shell:showItemInFolder', localPath)) as {
              success: boolean
              error?: string
              pathNotFound?: boolean
            }
            if (!result.success && result.pathNotFound) {
              message.warning(
                t('assetLib.contextMenu.pathNotExists', '文件路径不存在，可能尚未备份或已被移动')
              )
            } else if (!result.success) {
              message.error(t('assetLib.contextMenu.openLocalPathFailed', '打开本地路径失败'))
            }
          } catch (err) {
            message.error(t('assetLib.contextMenu.openLocalPathFailed', '打开本地路径失败'))
            console.error('[AssetFileList] 打开本地路径失败:', err)
          }
        } else {
          message.warning(getNetworkBrowseUnavailableMessage())
        }
      }
      break
    case 'open-local-path-folder':
      // 打开网络保管库文件夹的本地路径
      if (currentRightClickAsset.value && currentVault.value?.networkPath) {
        try {
          const folder = currentRightClickAsset.value as any
          const folderKey = folder.id || folder.folderKey || folder.key || ''

          const browsePhysicalPath = await buildFolderBrowsePath(folderKey)
          if (!browsePhysicalPath) {
            message.warning(getNetworkBrowseUnavailableMessage())
            break
          }

          console.log('[AssetFileList] 打开文件夹物理路径:', browsePhysicalPath)
          await openBrowsePath(browsePhysicalPath, {
            openPath: (p) => window.api.shell.openPath(p),
            onNotFound: (p) =>
              message.warning(t('assetLib.contextMenu.openLocalPathNotFound', { path: p }), 8),
            onFailed: (p, err) =>
              message.error(
                t('assetLib.contextMenu.openLocalPathFailedAt', { path: p, error: err }),
                8
              )
          })
        } catch (err) {
          console.error('[AssetFileList] 打开文件夹本地路径失败:', err)
          message.error(t('assetLib.contextMenu.openLocalPathFailed', '打开本地路径失败'))
        }
      } else {
        message.warning(getNetworkBrowseUnavailableMessage())
      }
      break
    case 'use-as-reference-image':
      // 用作参考图生成：支持多选批量处理
      if (currentRightClickAsset.value) {
        let assetsToProcess: (AssetDataRow | FolderItem)[] = []
        const currentId =
          (currentRightClickAsset.value as any).assetKey || (currentRightClickAsset.value as any).id
        const selectedIds = getSelectedIds()

        // 检查右键点击的项是否在选中列表中
        if (selectedIds.includes(currentId)) {
          // 如果在，处理所有选中项
          assetsToProcess = props.files.filter((f) => {
            const id = (f as any).assetKey || (f as any).id
            return selectedIds.includes(id)
          })
        } else {
          // 如果不在，只处理当前右键项
          assetsToProcess = [currentRightClickAsset.value]
        }

        // 过滤非图片文件
        const imageAssets = assetsToProcess.filter((asset) => {
          if ((asset as any).type === 'folder') return false
          const assetName = (asset as any).assetName || (asset as any).name
          const ext = (asset as any).fileExtension || (asset as any).ext
          return isImageFile(assetName, ext)
        })

        if (imageAssets.length === 0) {
          message.warning(t('assetFileList.poster.noImagesSelected'))
          break
        }

        const processAssets = async () => {
          const dataUrls: string[] = []
          let successCount = 0
          let failCount = 0

          // 显示加载提示
          const hideLoading = message.loading(
            t('assetFileList.poster.readingImages', { count: imageAssets.length }),
            0
          )

          try {
            for (const asset of imageAssets) {
              const localPath = getLocalFilePath(asset)
              if (!localPath) {
                failCount++
                continue
              }

              try {
                const base64Result = await window.api.asset.readFileAsBase64(localPath)
                if (base64Result?.success && base64Result.data) {
                  const ext = ((asset as AssetDataRow).fileExtension || 'png').toLowerCase()
                  const mimeType = ['jpg', 'jpeg'].includes(ext) ? 'image/jpeg' : `image/${ext}`
                  dataUrls.push(`data:${mimeType};base64,${base64Result.data}`)
                  successCount++
                } else {
                  failCount++
                }
              } catch (e) {
                console.error(e)
                failCount++
              }
            }

            if (dataUrls.length > 0) {
              const timestamp = Date.now()
              const newTabPath = `/aigc-studio?_tab_id=${timestamp}`
              await router.push(newTabPath)

              setTimeout(() => {
                aigcEventBus.emit(AIGC_EVENTS.SWITCH_TO_IMAGE_AND_SET_REFERENCE, dataUrls)
              }, 300)

              message.success(
                t('assetLib.contextMenu.useAsReferenceSuccess', '已添加为 AI 创作参考图') +
                  (failCount > 0 ? t('assetFileList.poster.failedCount', { count: failCount }) : '')
              )
            } else {
              message.error(t('assetLib.contextMenu.readFileFailed', '读取文件失败'))
            }
          } finally {
            hideLoading()
          }
        }

        await processAssets()
      }
      break
    // ==================== 回收站操作 ====================
    case 'restore': {
      const { assetKeys, folderKeys } = collectTrashTargets()
      await performRestoreInTrash(assetKeys, folderKeys)
      break
    }
    case 'permanent-delete': {
      const { assetKeys, folderKeys } = collectTrashTargets()
      requestPermanentDelete(assetKeys, folderKeys)
      break
    }

    case 'pull-project-archive':
      void handlePullProjectArchive()
      break
    case 'locate-in-folder': {
      // 右键菜单触发时，连 assetKey 一起给出去，跳过去之后那个资产是选中的
      const rightClicked = currentRightClickAsset.value as any
      emit('locate-in-folder', rightClicked?.folderKey, rightClicked?.assetKey)
      break
    }
  }

  // 清空当前右键选中的资产
  currentRightClickAsset.value = null
}

// 缩略图生成队列
const thumbnailQueue = ref<any[]>([])

/**
 * 处理缩略图生成成功事件
 * @param payload 包含 assetKey 和 base64 图片数据
 */
const handleThumbnailGenerated = async (payload: { assetKey: string; base64: string }) => {
  // 从队列中获取当前项（可能包含folderKey）
  const queueItem = thumbnailQueue.value.find((item) => item.assetKey === payload.assetKey)
  const folderKey = queueItem?.folderKey

  try {
    // 保存缩略图到本地
    const result = await (window as any).api.asset.saveThumbnail(payload.base64, payload.assetKey)
    if (result.success && result.data) {
      // 更新数据库中的 imgLocalPath
      await (window as any).api.database.assetData.update(payload.assetKey, {
        imgLocalPath: result.data
      })
      // 刷新文件列表
      await assetContext.refreshCurrentFolder()

      // 如果是AIGC模型（有folderKey），触发AI命名
      if (folderKey) {
        // 异步调用，不阻塞主流程
        handleAigcThumbnailComplete({
          assetKey: payload.assetKey,
          base64: payload.base64,
          folderKey
        }).catch((err) => console.error('[AssetFileList] AI命名失败:', err))
      }
    }
  } catch (error) {
    console.error('[AssetFileList] 保存缩略图失败:', error)
  } finally {
    // 从队列中移除已处理的项
    thumbnailQueue.value = thumbnailQueue.value.filter((item) => item.assetKey !== payload.assetKey)
  }
}

/**
 * 处理缩略图生成失败事件
 * @param payload 包含 assetKey 和 error 信息
 */
const handleThumbnailError = (payload: { assetKey: string; error: unknown }) => {
  console.error('[AssetFileList] 缩略图生成失败:', payload.assetKey, payload.error)
  const item = thumbnailQueue.value.find((entry) => entry.assetKey === payload.assetKey)
  // AIGC 自动生成的静默失败即可；用户手动点的要告诉他没成
  if (item && !item.folderKey) {
    const name = props.files.find((file) => file.assetKey === payload.assetKey)?.assetName
    message.error(t('assetFileList.thumbnail.captureFailed', { name: name ?? payload.assetKey }))
  }
  // 从队列中移除失败的项
  thumbnailQueue.value = thumbnailQueue.value.filter((item) => item.assetKey !== payload.assetKey)
}

/**
 * 监听 AIGC 模型导入完成事件，自动触发缩略图生成
 * 事件由 Model3DStudio 或 Assistant 模块在资产保存完成后触发
 */
const handleAigcThumbnailRequest = async (evt: Event) => {
  // 类型转换：将通用 Event 转换为 CustomEvent 以访问 detail 属性
  const event = evt as CustomEvent<{
    assetKey: string
    filePath: string
    folderKey?: string // 用于AI命名后更新文件夹
  }>
  const { assetKey, filePath, folderKey } = event.detail
  if (!assetKey || !filePath) return

  console.log(
    '[AssetFileList] 收到 AIGC 缩略图生成请求:',
    assetKey,
    folderKey ? `文件夹: ${folderKey}` : ''
  )

  // 检查是否已在队列中
  const exists = thumbnailQueue.value.some((item) => item.assetKey === assetKey)
  if (exists) {
    console.log('[AssetFileList] 缩略图已在队列中，跳过:', assetKey)
    return
  }

  // 添加到队列（包含folderKey用于后续AI命名）
  thumbnailQueue.value.push({
    assetKey,
    filePath,
    fileType: 'model',
    folderKey // 新增：传递folderKey
  })
  console.log('[AssetFileList] 已添加到缩略图生成队列:', assetKey)
}

/**
 * 处理 AIGC 模型缩略图生成完成，触发视觉模型命名
 * @param payload.assetKey - 资产Key
 * @param payload.base64 - 缩略图Base64
 * @param payload.folderKey - 文件夹Key（可选，用于AI命名）
 */
const handleAigcThumbnailComplete = async (payload: {
  assetKey: string
  base64: string
  folderKey?: string
}) => {
  const { assetKey, base64, folderKey } = payload

  // 如果有 folderKey，尝试使用视觉模型为文件夹命名
  if (folderKey && base64) {
    try {
      console.log('[AssetFileList] 开始使用视觉模型为AIGC模型命名:', folderKey)
      const nameResult = await dashScopeAPI.generate3DModelName(base64)

      if (nameResult.success && nameResult.name) {
        // 添加日期后缀
        const now = new Date()
        const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        const newName = `${nameResult.name}_${dateStr}`

        // 更新数据库中的文件夹名称
        await (window as any).api.database.assetFolder.rename(folderKey, newName)
        console.log('[AssetFileList] AI命名成功:', folderKey, '->', newName)

        // 刷新文件列表
        await assetContext.refreshCurrentFolder()
      } else {
        console.warn('[AssetFileList] AI命名失败:', nameResult.error)
        /*
          只有「没绑看得懂图的模型」这一种才说出来：用户不去设置里绑一个，
          这个功能永远不会好。原先这一路只落一行日志，用户看到的是文件夹
          拿不到中文名、也不知道为什么。

          网络抖动、余额不够、密钥解不开那几种不弹 —— 主进程不给 errorKey，
          那些是一次性的失败，弹出来只会把用户赶去一个已经填好的页面。
        */
        if (nameResult.errorKey === NO_VISION_MODEL_ERROR_KEY) {
          message.warning(t('assetManagement.aiNaming.noVisionModel'))
        }
      }
    } catch (error) {
      console.error('[AssetFileList] AI命名异常:', error)
    }
  }
}

/**
 * 获取资产的原图 URL（用于空格键预览，不使用 _thumb 压缩版）
 * 与 getThumbnailUrl 逻辑一致，但始终返回原图路径
 */
const getOriginalThumbnailUrl = (file: any): string | undefined => {
  if (file?.type === 'folder') return undefined
  // customPoster → 原图 URL
  const selected = selectedAsset?.value
  const poster =
    file?.customPoster ||
    (selected?.assetKey === file?.assetKey ? selected?.customPoster : undefined)
  if (poster) {
    if (poster.startsWith('http') || poster.startsWith('file:')) return toLocalResourceUrl(poster)
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const vaultPath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
    return buildThumbnailUrl(vaultPath, poster, isNetworkVault)
  }
  // Image assets preview their actual file, never the list cache or imported thumbnail.
  if (isImageFile(file?.assetName || '', file?.fileExtension || file?.ext)) {
    const original = resolveAssetUrl({
      vaultType: currentVault.value?.vaultType,
      vaultPath: currentVault.value?.path,
      networkPath: currentVault.value?.networkPath,
      originPath: file?.originPath,
      filePath: file?.filePath
    })
    if (original) return original
  }
  // imgLocalPath → 原图
  if (file?.imgLocalPath) {
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const basePath = isNetworkVault ? currentVault.value?.networkPath : currentVault.value?.path
    return buildThumbnailUrl(basePath, file.imgLocalPath, isNetworkVault)
  }
  // 回退到 getThumbnailUrl
  return getThumbnailSourceUrl(file)
}

/**
 * 空格键按下：显示全屏预览（使用原图而非压缩缩略图）
 */
const handleSpaceKeyDown = (e: KeyboardEvent) => {
  // 只处理空格键
  if (e.code !== 'Space') return
  // 如果焦点在输入框等元素，不触发
  const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return

  // 如果预览已经在显示，始终阻止默认滚动行为
  if (thumbnailPreviewVisible.value) {
    e.preventDefault()
    e.stopPropagation()
    return
  }

  // 如果没有 hover 资产或没有缩略图，不触发预览
  if (!hoveredAsset.value || !hoveredAssetThumbnailUrl.value) return

  e.preventDefault()
  e.stopPropagation()
  // 空格预览使用原图 URL，而非列表用的压缩缩略图
  thumbnailPreviewUrl.value = hoveredAssetOriginalUrl.value || hoveredAssetThumbnailUrl.value
  // 根据类型使用正确的判断函数：文件夹使用 isFolderCoverVideo，资产使用 isThumbnailVideo
  const isFolder = (hoveredAsset.value as any).type === 'folder'
  thumbnailPreviewIsVideo.value = isFolder
    ? isFolderCoverVideo(hoveredAsset.value as FolderItem)
    : isThumbnailVideo(hoveredAsset.value)
  thumbnailPreviewVisible.value = true
}

/**
 * 空格键松开：隐藏全屏预览
 */
const handleSpaceKeyUp = (e: KeyboardEvent) => {
  if (e.code !== 'Space') return
  // 如果预览正在显示，阻止默认行为（防止滚动）并关闭预览
  if (thumbnailPreviewVisible.value) {
    e.preventDefault()
    e.stopPropagation()
    thumbnailPreviewVisible.value = false
  }
}

/**
 * 资产项 mouseenter：记录当前 hover 的资产及其缩略图URL
 * 同时记录原图 URL 用于空格预览
 * 如果预览正在显示，同步更新预览内容
 */
const handleAssetMouseEnter = (file: AssetDataRow | FolderItem) => {
  const isFolder = (file as any).type === 'folder'
  const url = isFolder ? getFolderCoverUrl(file as FolderItem) : getThumbnailUrl(file)
  // 只有有缩略图的资产才记录
  if (url) {
    hoveredAsset.value = file
    hoveredAssetThumbnailUrl.value = url
    // 记录原图 URL（用于空格预览）
    hoveredAssetOriginalUrl.value = isFolder
      ? getOriginalFolderCoverUrl(file as FolderItem) || url
      : getOriginalThumbnailUrl(file) || url
    // 如果预览正在显示，实时更新预览内容（使用原图）
    if (thumbnailPreviewVisible.value) {
      thumbnailPreviewUrl.value = hoveredAssetOriginalUrl.value
      // 根据类型使用正确的判断函数
      thumbnailPreviewIsVideo.value = isFolder
        ? isFolderCoverVideo(file as FolderItem)
        : isThumbnailVideo(file)
    }
  } else {
    hoveredAsset.value = null
    hoveredAssetThumbnailUrl.value = undefined
    hoveredAssetOriginalUrl.value = undefined
  }
}

/**
 * 资产项 mouseleave：清除 hover 状态
 * 注意：如果预览正在显示，不关闭预览（防止闪烁）
 */
const handleAssetMouseLeave = () => {
  hoveredAsset.value = null
  hoveredAssetThumbnailUrl.value = undefined
  // 不在这里关闭预览，预览只通过松开空格键关闭
}

/**
 * 3D 查看器里更新了某个资产的缩略图。
 * 库已经写好了，但这份列表是进页面时读的，不重新拉一次还是显示旧图。
 */
const handleThumbnailUpdatedElsewhere = (): void => {
  void assetContext.refreshCurrentFolder()
}

onMounted(() => {
  window.addEventListener('aigc:generate-thumbnail', handleAigcThumbnailRequest)
  window.addEventListener('asset-thumbnail:updated', handleThumbnailUpdatedElsewhere)
  window.addEventListener('keydown', handleSpaceKeyDown)
  window.addEventListener('keyup', handleSpaceKeyUp)
})

onUnmounted(() => {
  window.removeEventListener('aigc:generate-thumbnail', handleAigcThumbnailRequest)
  window.removeEventListener('asset-thumbnail:updated', handleThumbnailUpdatedElsewhere)
  window.removeEventListener('keydown', handleSpaceKeyDown)
  window.removeEventListener('keyup', handleSpaceKeyUp)
})

// 判断是否为 3D 模型文件
// 改良版是否为 3D 模型判断，支持从扩展名判断
const is3DModel = (file: any) => {
  const validExtensions = ['fbx', 'obj', 'glb', 'gltf']

  // 1. 优先检查 fileExtension 字段
  if (file.fileExtension || file.ext) {
    const ext = String(file.fileExtension || file.ext || '')
      .toLowerCase()
      .trim()
      .replace(/^\./, '')
    if (validExtensions.includes(ext)) {
      return true
    }
  }

  // 2. 检查文件名后缀
  const name = String(file.assetName || file.name || '')
    .toLowerCase()
    .trim()
  return validExtensions.some((ext) => name.endsWith('.' + ext))
}

// 移除is3DModelFile，统一使用is3DModel
// const is3DModelFile ... (removed)

/**
 * 获取资产文件的完整路径
 * 正确处理备份模式和引用模式的路径差异
 */
const getAssetFilePath = async (file: AssetDataRow): Promise<string | null> => {
  // 直接使用 getLocalFilePath 函数，它已经正确处理了备份/引用模式
  const path = getLocalFilePath(file)
  if (path) {
    return path
  }

  // 如果都没有，尝试通过 assetKey 从数据库获取
  try {
    const assetData = await assetDataAPI.getById(file.assetKey)
    if (assetData) {
      // 使用 getLocalFilePath 处理数据库返回的数据
      return getLocalFilePath(assetData as AssetDataRow)
    }
  } catch (error) {
    console.error('获取资产文件路径失败:', error)
  }

  return null
}

const handleItemDoubleClick = async (file: any) => {
  // 双击时关闭右键菜单（修复菜单残留 BUG）
  contextMenuRef.value?.hide()

  // 双击：文件夹进入（回收站里的进不去，见 emitFolderOpen）；
  // 文件打开详情面板或跳转到3D查看器
  if ((file as any).type === 'folder') {
    emitFolderOpen(file as FolderItem)
  } else {
    const assetFile = file as AssetDataRow
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _fileName = assetFile.assetName || ''

    // 检查是否为3D模型文件
    if (is3DModel(assetFile)) {
      // 获取文件路径并在详情面板中查看（不再跳转到新Tab）
      const filePath = await getAssetFilePath(assetFile)

      if (filePath) {
        // 直接在详情面板中打开，附带文件路径
        const fileWithRealPath = {
          ...assetFile,
          filePath: filePath
        }
        emit('file-open', fileWithRealPath)
      } else {
        // 如果无法获取路径，仍然尝试打开详情面板
        emit('file-open', assetFile)
      }
    } else if (isImageFile(assetFile.assetName, assetFile.fileExtension)) {
      // 获取文件路径
      let filePath: string | null = null

      // 特殊逻辑：如果 filePath 是 assetData 开头的相对路径，强制还原真实地址
      // 这修复了引用模式下无法打开库内存储图片的问题
      const vaultPath = currentVault.value?.path
      if (
        vaultPath &&
        assetFile.filePath &&
        !/^[a-zA-Z]:/.test(assetFile.filePath) &&
        (assetFile.filePath.startsWith('assetData') || assetFile.filePath.startsWith('thumbnails'))
      ) {
        filePath = `${vaultPath}/${assetFile.filePath}`.replace(/\\/g, '/')
      } else {
        filePath = await getAssetFilePath(assetFile)
      }

      console.log('打开图片路径:', filePath)

      // 如果是图片，调用图片预览
      if (filePath) {
        // 使用新对象，保留原始信息并附加 filePath
        const fileWithRealPath = {
          ...assetFile,
          filePath: filePath // 确保 filePath 存在
        }
        emit('file-open', fileWithRealPath)
      } else {
        emit('file-open', assetFile)
      }
    } else {
      // 非3D模型文件，打开详情面板
      emit('file-open', assetFile)
    }
  }
}

const handleRefresh = () => {
  assetContext.refreshCurrentFolder()
}

// 添加文件夹
const handleAddFolder = async () => {
  if (!props.selectedFolderKey) {
    message.warning(t('assetFileList.folder.selectFirst'))
    return
  }

  // 生成唯一名称
  let folderName = t('assetFileList.folder.newFolderName')
  const existingNames = new Set(
    props.files.filter((f: any) => f.type === 'folder').map((f: any) => f.name)
  )

  // 如果已存在默认名称，则尝试 "新建文件夹 (2)", "新建文件夹 (3)" 等
  if (existingNames.has(folderName)) {
    let counter = 2
    while (existingNames.has(`${folderName} (${counter})`)) {
      counter++
    }
    folderName = `${folderName} (${counter})`
  }

  try {
    const parentKey = props.selectedFolderKey
    const newFolderKey = await assetContext.addFolder(parentKey, folderName)

    if (newFolderKey) {
      // 刷新当前文件夹以确保列表更新
      await assetContext.refreshCurrentFolder()

      // 轮询等待新文件夹出现在列表中，然后开始重命名
      let attempts = 0
      const maxAttempts = 20 // 约2秒超时

      const checkAndRename = () => {
        const found = props.files.find((f: any) => getItemId(f) === newFolderKey)
        if (found) {
          nextTick(() => {
            // 滚动到可见区域
            const element = containerRef.value?.querySelector(`[data-file-id="${newFolderKey}"]`)
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
            // 触发进入重命名状态
            startInlineRename(newFolderKey)
          })
        } else if (attempts < maxAttempts) {
          attempts++
          setTimeout(checkAndRename, 100)
        }
      }

      checkAndRename()
    }
  } catch (error) {
    console.error('添加文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetFileList.folder.createFailed')))
  }
}

const handleAddFolderConfirm = async (folderKey: string, folderName: string) => {
  if (!folderKey) return

  try {
    await assetContext.addFolder(folderKey, folderName)
    addFolderModalVisible.value = false
  } catch (error) {
    // 弹窗会留在原地（上面那行没跑到），但不说一句的话用户只看到「点了没反应」
    console.error('添加文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetFileList.folder.createFailed')))
  }
}

// 重命名资产
const handleRenameAssetConfirm = async (assetKey: string, newName: string) => {
  try {
    await assetContext.renameAsset(assetKey, newName)
    renameAssetModalVisible.value = false
  } catch (error) {
    console.error('重命名资产失败:', error)
  }
}

// 重命名文件夹
const handleRenameFolderConfirm = async (folderKey: string, newName: string) => {
  try {
    await assetContext.renameFolder(folderKey, newName)
    renameFolderModalVisible.value = false
  } catch (error) {
    /*
     * 共享库上改名可能只改了一半（库里改了、NAS 上的目录没改动），主进程现在会把
     * 这种情况报成 NETWORK_DIR_RENAME_FAILED。不说出来的话，用户看到输入框收回去、
     * 名字没变，以为是自己点错了
     */
    console.error('重命名文件夹失败:', error)
    message.error(resolveErrorText(error, t('assetFileList.folder.renameFailed')))
  }
}

// 执行混合批量删除（文件与文件夹）
const performMixedDelete = async (assetKeys: string[], folderKeys: string[]) => {
  try {
    // 局域网协作库使用硬删除，避免 UNIQUE 约束冲突
    const isNetworkVault = currentVault.value?.vaultType === VaultType.NETWORK
    const vaultId = currentVault.value?.id

    // 🔧 局域网协作库提前检查写入权限
    if (isNetworkVault && currentVault.value?.networkPath && !isHttpNetworkVault.value) {
      const permResult = await window.api.networkVault.checkWritePermission(
        currentVault.value.networkPath
      )
      if (!permResult.canWrite) {
        message.warning(t('assetFileList.delete.noWritePermission'))
        return
      }
    }

    // 批量删除文件
    if (assetKeys.length > 0) {
      try {
        if (isHttpNetworkVault.value && vaultId) {
          const results = await Promise.all(
            assetKeys.map(async (key) => ({
              key,
              result: await window.api.invoke('networkVaultV2:deleteAsset', vaultId, key)
            }))
          )
          const successKeys = results.filter((item) => item.result?.success).map((item) => item.key)
          if (successKeys.length > 0) {
            if (successKeys.length === assetKeys.length) {
              message.success(t('assetFileList.delete.filesDeleted', { count: successKeys.length }))
            } else {
              message.warning(
                t('assetFileList.delete.filesDeletedPartial', {
                  count: successKeys.length,
                  total: assetKeys.length
                })
              )
            }
            assetContext.removeFiles(successKeys)
          } else {
            message.error(
              resolveErrorText(results[0]?.result?.error, t('assetFileList.delete.batchFailed'))
            )
          }
        } else if (isNetworkVault && vaultId) {
          // 非 HTTP 网络库保持原有 batch 行为
          const ops = assetKeys.map((key) => ({
            type: 'delete' as const,
            table: 'assetData' as const,
            data: { assetKey: key }
          }))
          const result = await window.api.invoke('networkVaultV2:batch', vaultId, ops)
          if (result.success) {
            const applied = result.data?.applied ?? assetKeys.length
            if (applied === assetKeys.length) {
              message.success(t('assetFileList.delete.filesDeleted', { count: applied }))
            } else {
              message.warning(
                t('assetFileList.delete.filesDeletedPartialMissing', {
                  count: applied,
                  total: assetKeys.length
                })
              )
            }
            assetContext.removeFiles(assetKeys)
          } else {
            message.error(result.error || t('assetFileList.delete.batchFailed'))
          }
        } else {
          // 其他资产库：批量软删除
          const result = await assetDataAPI.batchDelete(assetKeys)
          const deletedCount = (result as any)?.deleted ?? assetKeys.length
          message.success(t('assetFileList.delete.filesDeleted', { count: deletedCount }))
        }
      } catch (err) {
        console.error('批量删除文件失败:', err)
        message.error(resolveErrorText(err, t('assetFileList.delete.batchFailed')))
      }
    }

    // 🚀 批量删除文件夹
    if (folderKeys.length > 0) {
      try {
        if (isNetworkVault && vaultId) {
          // 网络库：逐个调用 V2 递归删除
          // 先做根节点去重：如果选了父文件夹和子文件夹，只删父文件夹
          const roleResult = await window.api.invoke('networkVaultV2:getRole', vaultId)
          const shouldPullAfterBatch = roleResult?.success ? roleResult.data === 'client' : true
          const folderKeySet = new Set(folderKeys.map(String))
          const rootKeys: string[] = []
          for (const fk of folderKeySet) {
            // 查询该文件夹的祖先链
            try {
              const folderInfo = await assetFolderAPI.getByKey(fk)
              const ancestors: string[] = folderInfo?.ancestorKeys
                ? JSON.parse(folderInfo.ancestorKeys)
                : []
              // 如果祖先链中有任何 key 也在选中集合里，跳过该 key（它会被父级递归删除）
              const hasSelectedAncestor = ancestors.some((ak) => folderKeySet.has(ak))
              if (!hasSelectedAncestor) {
                rootKeys.push(fk)
              }
            } catch {
              // 查询失败时保守处理，仍然删除
              rootKeys.push(fk)
            }
          }

          // 逐个删除，跟踪成功的 key
          const successfullyDeletedKeys: string[] = []
          let failedKey: string | null = null
          for (const fk of rootKeys) {
            const result = await window.api.invoke('networkVaultV2:deleteFolder', vaultId, fk, {
              syncAfter: false
            })
            if (!result.success) {
              failedKey = fk
              message.error(
                resolveErrorText(
                  result.error,
                  t('assetFileList.delete.folderDeleteFailed', { name: fk })
                )
              )
              break
            }
            successfullyDeletedKeys.push(fk)
          }

          if (successfullyDeletedKeys.length > 0 && shouldPullAfterBatch) {
            const syncResult = await window.api.invoke('networkVaultV2:pullSync', vaultId)
            if (!syncResult?.success) {
              message.warning(
                resolveErrorText(syncResult?.error, t('assetFileList.delete.syncRefreshFailed'))
              )
            }
          }

          // 只移除成功删除的文件夹节点
          if (successfullyDeletedKeys.length > 0) {
            assetContext.removeTreeNodes(successfullyDeletedKeys)
            // 乐观移除右侧列表中的文件夹条目
            assetContext.removeFiles(successfullyDeletedKeys)
          }
          if (failedKey) {
            message.warning(
              t('assetFileList.delete.foldersDeletedWithFailure', {
                count: successfullyDeletedKeys.length,
                total: rootKeys.length,
                name: failedKey
              })
            )
          }
        } else {
          await assetFolderAPI.batchDelete(folderKeys.map(String))
          // 本地库：全部成功才走到这里，移除所有选中的文件夹
          assetContext.removeTreeNodes(folderKeys.map(String))
        }
      } catch (err) {
        console.error('批量删除文件夹失败:', err)
        message.error(resolveErrorText(err, t('assetFileList.delete.batchFolderFailed')))
      }
    }

    // 本地库需要 reload（DB 已同步更新）；网络库已做乐观更新，无需 reload
    if (!isNetworkVault) {
      await assetContext.refreshCurrentFolder()
    }
  } finally {
    clearSelection()
  }
}

const requestPermanentDelete = (assetKeys: string[], folderKeys: string[] = []): void => {
  if (assetKeys.length === 0 && folderKeys.length === 0) return
  const keys = [...assetKeys]
  const folders = [...folderKeys]
  const vaultId = currentVault.value?.id
  const count = keys.length + folders.length
  confirmDialog({
    title: t('assetFileList.delete.permanentConfirm.title', { count }),
    content: `${t('assetFileList.delete.permanentConfirm.content', { count })}${
      folders.length > 0 ? t('assetFileList.delete.permanentConfirm.foldersIncluded') : ''
    } ${t('assetFileList.delete.permanentConfirm.irreversible')}`,
    okText: t('assetFileList.delete.permanentConfirm.okText'),
    cancelText: t('assetFileList.deleteConfirm.cancelText'),
    danger: true,
    onOk: async () => {
      if (currentVault.value?.id !== vaultId) return
      await performPermanentDeleteInTrash(keys, folders)
    }
  })
}

/**
 * 回收站里的「恢复」。
 *
 * 资产走批量接口，文件夹一个一个来（每个都是递归恢复整棵树）。原来这里只认
 * 右键点中的那一个 —— 而同一个视图里的「彻底删除」早就是整批的。选中两百个
 * 误删的资产，破坏性的那一半一键完成，可撤销的那一半要点两百次右键。
 */
const performRestoreInTrash = async (assetKeys: string[], folderKeys: string[]): Promise<void> => {
  if (assetKeys.length === 0 && folderKeys.length === 0) return

  const vaultId = currentVault.value?.id
  const restoredKeys: string[] = []
  let failedCount = 0

  try {
    if (assetKeys.length > 0) {
      if (isHttpNetworkVault.value && vaultId) {
        for (const assetKey of assetKeys) {
          const result = await window.api.invoke('networkVaultV2:restoreAsset', vaultId, assetKey)
          if (result?.success) restoredKeys.push(assetKey)
          else failedCount++
        }
      } else {
        const { restored, failed } = await assetDataAPI.restoreMany(assetKeys)
        restoredKeys.push(...restored)
        failedCount += failed.length
      }
    }

    for (const folderKey of folderKeys) {
      try {
        const { restored } = await assetFolderAPI.restore(folderKey)
        if (restored) restoredKeys.push(folderKey)
        else failedCount++
      } catch (err) {
        console.error('[AssetFileList] 恢复文件夹失败:', err)
        failedCount++
      }
    }

    if (restoredKeys.length > 0) {
      assetContext.removeFiles(restoredKeys)
      // 文件夹回来了，树上得看得见
      if (folderKeys.length > 0) await assetContext.refreshTree()
    }

    if (failedCount === 0) {
      message.success(t('assetFileList.restore.done', { count: restoredKeys.length }))
    } else if (restoredKeys.length > 0) {
      message.warning(
        t('assetFileList.restore.partial', {
          count: restoredKeys.length,
          total: restoredKeys.length + failedCount
        })
      )
    } else {
      message.error(t('assetLib.contextMenu.restoreFailed', '恢复资产失败'))
    }
  } catch (err) {
    console.error('[AssetFileList] 恢复失败:', err)
    message.error(resolveErrorText(err, t('assetLib.contextMenu.restoreFailed', '恢复资产失败')))
  }
}

const performPermanentDeleteInTrash = async (
  assetKeys: string[],
  folderKeys: string[] = []
): Promise<void> => {
  if (assetKeys.length === 0 && folderKeys.length === 0) return

  try {
    const vaultId = currentVault.value?.id

    if (isHttpNetworkVault.value && vaultId) {
      const results = await Promise.all(
        assetKeys.map(async (key) => ({
          key,
          result: await window.api.invoke('networkVaultV2:purgeAsset', vaultId, key)
        }))
      )

      const successKeys = results.filter((item) => item.result?.success).map((item) => item.key)
      if (successKeys.length > 0) {
        if (successKeys.length === assetKeys.length) {
          message.success(
            t('assetFileList.delete.permanentlyDeleted', { count: successKeys.length })
          )
        } else {
          message.warning(
            t('assetFileList.delete.permanentlyDeletedPartial', {
              count: successKeys.length,
              total: assetKeys.length
            })
          )
        }
        assetContext.removeFiles(successKeys)
      } else {
        message.error(
          resolveErrorText(
            results[0]?.result?.error,
            t('assetFileList.delete.permanentDeleteFailed')
          )
        )
      }
      return
    }

    // 一次交给后端整批删：每条都要算一遍「这个文件 / 这张封面还有没有别人用」，
    // 而那是一次全库扫描。逐条调等于把几百次扫描压在主进程上
    const successKeys: string[] = []
    if (assetKeys.length > 0) {
      const { deleted } = await assetDataAPI.hardDeleteMany(assetKeys)
      successKeys.push(...deleted)
    }

    // 文件夹是递归清除（连同子孙和里面的资产），一个一个来
    for (const folderKey of folderKeys) {
      try {
        const { deleted } = await assetFolderAPI.hardDelete(folderKey)
        if (deleted) successKeys.push(folderKey)
      } catch (err) {
        console.error('彻底删除文件夹失败:', err)
      }
    }

    const total = assetKeys.length + folderKeys.length
    if (successKeys.length > 0) {
      if (successKeys.length === total) {
        message.success(t('assetFileList.delete.permanentlyDeleted', { count: successKeys.length }))
      } else {
        message.warning(
          t('assetFileList.delete.permanentlyDeletedPartial', {
            count: successKeys.length,
            total
          })
        )
      }
      assetContext.removeFiles(successKeys)
      if (folderKeys.length > 0) await assetContext.refreshTree()
    } else {
      message.error(t('assetFileList.delete.permanentDeleteFailed'))
    }
  } catch (err) {
    console.error('批量彻底删除文件失败:', err)
    message.error(resolveErrorText(err, t('assetFileList.delete.permanentDeleteFailed')))
  }
}

// 批量删除相关的状态
const deleteConfirmVisible = ref(false)
const deleteBatchLoading = ref(false)
const deleteDontAskAgain = ref(false)
const deleteConfirmData = reactive({
  assetKeys: [] as string[],
  folderKeys: [] as string[],
  filesCount: 0,
  foldersCount: 0
})

const handleDeleteConfirmOk = async () => {
  if (deleteDontAskAgain.value) {
    localStorage.setItem('assetManagement.skipDeleteConfirm', 'true')
    window.dispatchEvent(
      new CustomEvent('local-storage-change', {
        detail: { key: 'assetManagement.skipDeleteConfirm', value: 'true' }
      })
    )
  }

  deleteBatchLoading.value = true
  try {
    // 必须解构 reactive 数组为普通数组，否则传给 IPC 可能导致序列化问题
    await performMixedDelete([...deleteConfirmData.assetKeys], [...deleteConfirmData.folderKeys])
    deleteConfirmVisible.value = false
  } finally {
    deleteBatchLoading.value = false
  }
}

/**
 * 处理删除请求：检查配置决定是否跳过确认
 * @param assetKeys 文件Key列表
 * @param folderKeys 文件夹Key列表
 */
const processDeleteRequest = (assetKeys: string[], folderKeys: string[]) => {
  if (assetKeys.length === 0 && folderKeys.length === 0) return

  if (isTrashView.value) {
    requestPermanentDelete(assetKeys, folderKeys)
    return
  }

  // 「不再提示」只管得着可恢复的那一档。
  //
  // 共享库是硬删除，删的是 NAS 上团队共用的目录，没有「最近删除」这一层。
  // 一个几个月前随手勾上的复选框，不该让人在这种删除上一路无提示地按下去。
  const SKIP_KEY = 'assetManagement.skipDeleteConfirm'
  if (!isNetworkVaultDelete.value && localStorage.getItem(SKIP_KEY) === 'true') {
    performMixedDelete(assetKeys, folderKeys)
    return
  }

  // 显示确认弹窗
  deleteConfirmData.assetKeys = assetKeys
  deleteConfirmData.folderKeys = folderKeys
  deleteConfirmData.filesCount = assetKeys.length
  deleteConfirmData.foldersCount = folderKeys.length
  deleteDontAskAgain.value = false
  deleteConfirmVisible.value = true
}

/**
 * 回收站里这一次动作的对象：优先整个选择集合，没选中才是右键那一项。
 *
 * 和右键删除（handleBatchDeleteSelected）用同一条规矩 —— 原来「恢复」只认
 * 右键那一个，选了两百个也只恢复一个，而同一个菜单里的「彻底删除」是整批的。
 */
const collectTrashTargets = (): { assetKeys: string[]; folderKeys: string[] } => {
  type TrashItem = { type?: string; assetKey?: string; id?: string; folderKey?: string }
  const sources: TrashItem[] =
    selectedItems.value && selectedItems.value.length > 0
      ? (selectedItems.value as TrashItem[])
      : currentRightClickAsset.value
        ? [currentRightClickAsset.value as TrashItem]
        : []

  const assetKeys = sources
    .filter((item) => item?.type !== 'folder')
    .map((item) => item?.assetKey || item?.id)
    .filter(Boolean)
    .map((key) => String(key))

  const folderKeys = sources
    .filter((item) => item?.type === 'folder')
    .map((item) => item?.folderKey || item?.id)
    .filter(Boolean)
    .map((key) => String(key))

  return { assetKeys, folderKeys }
}

// 右键删除：优先删除当前选择集合，若无选择则删除右键项
const handleBatchDeleteSelected = () => {
  // 组装删除来源：优先选中项，其次右键项
  const sources: any[] =
    selectedItems.value && selectedItems.value.length > 0
      ? (selectedItems.value as any[])
      : currentRightClickAsset.value
        ? [currentRightClickAsset.value as any]
        : []

  if (!sources.length) return

  const assetKeys = sources
    .filter((item) => (item as any).type !== 'folder')
    .map((item) => (item as any).assetKey || (item as any).id)
    .filter(Boolean)
    .map((k) => String(k))

  const folderKeys = sources
    .filter((item) => (item as any).type === 'folder')
    .map((item) => (item as any).id)
    .filter(Boolean)
    .map((k) => String(k))

  processDeleteRequest(assetKeys, folderKeys)
}

// 处理收藏切换（直接调用接口）
const handleToggleFavorite = async (isFavorite: boolean) => {
  if (!currentRightClickAsset.value) return

  // 检查是否多选
  const selectedIds = getSelectedIds()
  const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
  let targetAssets: AssetDataRow[] = []

  if (selectedIds.length > 1 && isClickedInSelection) {
    // 批量模式
    targetAssets = selectedItems.value.filter(
      (item) => (item as any).type !== 'folder'
    ) as AssetDataRow[]
  } else {
    // 单选模式
    targetAssets = [currentRightClickAsset.value as AssetDataRow]
  }

  if (targetAssets.length === 0) return

  // 优化逻辑：根据目标操作（添加/移除），只处理符合条件的项
  // 如果是添加收藏 (isFavorite=true)，则只处理未收藏的项
  // 如果是移除收藏 (isFavorite=false)，则只处理已收藏的项
  const assetsToProcess = targetAssets.filter((asset) => {
    const isFav = getFavoriteStatus(asset.assetKey)
    return isFavorite ? !isFav : isFav
  })

  if (assetsToProcess.length === 0) {
    // 如果没有需要处理的项（例如全部都已经收藏了，但用户还是点击了添加），
    // 理论上菜单逻辑已经处理了显示“移除”，但为了健壮性，这里直接返回或提示
    // message.info('没有需要变更的项目')
    return
  }

  const userId = 1
  const vaultId = currentVault.value?.id
  const action = isFavorite ? t('assetFileList.favorite.add') : t('assetFileList.favorite.remove')

  try {
    // 并行处理请求
    const promises = assetsToProcess.map((asset) => {
      const assetId = asset.assetKey
      if (isFavorite) {
        return favorites()
          .add(assetId)
          .then(() => ({ id: assetId, success: true }))
      } else {
        return favorites()
          .remove(assetId)
          .then(() => ({ id: assetId, success: true }))
      }
    })

    const results = await Promise.all(promises)
    const successCount = results.filter((r) => r.success).length

    // 更新本地状态
    results.forEach((r) => {
      if (r.success) {
        setFavoriteStatus(r.id, isFavorite)
      }
    })

    if (successCount > 0) {
      if (assetsToProcess.length > 1) {
        message.success(t('assetFileList.favorite.batchUpdated', { action, count: successCount }))
      } else {
        message.success(
          t('assetFileList.favorite.updated', { action, name: assetsToProcess[0].assetName })
        )
      }

      // 通知收藏 store 刷新数量
      await favoriteStore.notifyChanged(userId, vaultId)
      // 刷新当前文件夹以获取最新数据
      await assetContext.refreshCurrentFolder()
    } else {
      message.error(t('assetFileList.favorite.operationFailed'))
    }
  } catch (error) {
    console.error('更新收藏状态失败:', error)
    message.error(t('assetFileList.favorite.operationFailed'))
  }
}

/**
 * 处理文件夹收藏切换
 * @param isFavorite 是否添加到收藏
 */
const handleToggleFolderFavorite = async (isFavorite: boolean) => {
  if (!currentRightClickAsset.value) return

  // 检查是否多选
  const selectedIds = getSelectedIds()
  const isClickedInSelection = selectedIds.includes(getItemId(currentRightClickAsset.value))
  let targetFolders: FolderItem[] = []

  if (selectedIds.length > 1 && isClickedInSelection) {
    // 批量模式
    targetFolders = selectedItems.value.filter(
      (item) => (item as any).type === 'folder'
    ) as FolderItem[]
  } else {
    // 单选模式
    targetFolders = [currentRightClickAsset.value as FolderItem]
  }

  if (targetFolders.length === 0) return

  // 优化逻辑：根据目标操作，只处理符合条件的项
  const foldersToProcess = targetFolders.filter((folder) => {
    const isFav = getFolderFavoriteStatus(folder.id)
    return isFavorite ? !isFav : isFav
  })

  if (foldersToProcess.length === 0) return

  const userId = 1
  const vaultId = currentVault.value?.id
  const action = isFavorite ? t('assetFileList.favorite.add') : t('assetFileList.favorite.remove')

  try {
    // 并行处理请求
    const promises = foldersToProcess.map((folder) => {
      const folderKey = folder.id
      if (isFavorite) {
        return favorites()
          .addFolder(folderKey)
          .then(() => ({ id: folderKey, success: true }))
      } else {
        return favorites()
          .removeFolder(folderKey)
          .then(() => ({ id: folderKey, success: true }))
      }
    })

    const results = await Promise.all(promises)
    const successCount = results.filter((r) => r.success).length

    // 更新本地状态
    results.forEach((r) => {
      if (r.success) {
        setFolderFavoriteStatus(r.id, isFavorite)
      }
    })

    if (successCount > 0) {
      if (foldersToProcess.length > 1) {
        message.success(
          t('assetFileList.favorite.folderBatchUpdated', { action, count: successCount })
        )
      } else {
        const name = foldersToProcess[0].name || foldersToProcess[0].folderName
        message.success(t('assetFileList.favorite.folderUpdated', { action, name }))
      }

      // 通知收藏 store 刷新数量
      await favoriteStore.notifyChanged(userId, vaultId)
      // 刷新当前文件夹以获取最新数据
      await assetContext.refreshCurrentFolder()
    } else {
      message.error(t('assetFileList.favorite.operationFailed'))
    }
  } catch (error) {
    console.error('更新文件夹收藏状态失败:', error)
    message.error(t('assetFileList.favorite.operationFailed'))
  }
}

// 滚动事件处理
const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement
  if (!target) return

  // 简单的触底检测：滚动距离 + 容器高度 >= 内容高度 - 阈值
  const threshold = 100 // 距离底部 100px 时触发
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - threshold) {
    maybeEmitLoadMore()
  }
}

// 生命周期钩子
onMounted(async () => {
  if (containerRef.value) {
    await initDragSelect(containerRef.value)
    // 绑定滚动监听到外层容器
    containerRef.value.addEventListener('scroll', handleScroll)
  }

  // 如果内部容器也产生滚动，也绑定（双重保险）
  if (scrollContainerRef.value) {
    scrollContainerRef.value.addEventListener('scroll', handleScroll)
  }

  nextTick(() => {
    updateScrollPosition()
    maybeEmitLoadMore()
  })

  const schedule = (fn: () => void) => {
    const ri = (window as any).requestIdleCallback
    if (typeof ri === 'function') {
      ri(fn)
    } else {
      setTimeout(fn, 0)
    }
  }
  schedule(async () => {
    const assetIds = props.files
      .filter((file: any) => file.type !== 'folder')
      .map((file: any) => file.assetKey || file.id)
      .filter(Boolean)
    if (assetIds.length > 0) {
      try {
        const statusMap = await checkFavorites(assetIds)
        favoriteStatusMap.value = statusMap || {}
      } catch {
        favoriteStatusMap.value = {}
      }
    }
  })

  // 加载文件夹收藏状态
  schedule(async () => {
    const folderIds = props.files
      .filter((file: any) => file.type === 'folder')
      .map((file: any) => file.id)
      .filter(Boolean)
    if (folderIds.length > 0) {
      try {
        // 逐个检查文件夹收藏状态（目前没有批量接口）
        const statusMap: Record<string, boolean> = {}
        for (const folderId of folderIds) {
          try {
            const isFav = await checkFolderFavorite(folderId)
            statusMap[folderId] = isFav
          } catch {
            statusMap[folderId] = false
          }
        }
        folderFavoriteStatusMap.value = statusMap
      } catch {
        folderFavoriteStatusMap.value = {}
      }
    }
  })

  // 设置删除回调（批量软删除：文件走批量接口，文件夹逐个删除）
  // 设置删除回调（批量软删除：文件走批量接口，文件夹逐个删除）
  setDeleteCallback(async (fileIds: string[]) => {
    const selectedItemsFromIds = fileIds
      .map((id) => props.files.find((f: any) => getItemId(f) === id))
      .filter(Boolean) as any[]

    const assetKeys = selectedItemsFromIds
      .filter((item) => (item as any).type !== 'folder')
      .map((item) => (item as any).assetKey || (item as any).id)
      .filter(Boolean)
      .map((k) => String(k))

    const folderKeys = selectedItemsFromIds
      .filter((item) => (item as any).type === 'folder')
      .map((item) => (item as any).id)
      .filter(Boolean)
      .map((k) => String(k))

    processDeleteRequest(assetKeys, folderKeys)
  })

  // 设置收藏切换回调（Ctrl + D）
  setFavoriteToggleCallback(async (fileIds: string[]) => {
    await toggleFavoritesForSelectedIds(fileIds)
  })

  // 设置行内重命名回调（F2）
  setInlineRenameCallback((fileId: string) => {
    startInlineRename(fileId)
  })

  // 设置在文件夹视图中显示回调（Ctrl+B）
  setLocateInFolderCallback(() => {
    emit('locate-in-folder')
  })

  // 监听 Spotlight 资产选中事件
  ;(window as any).addEventListener('spotlight:select-asset', handleSpotlightSelectAsset)

  // 确保拖拽结束后恢复框选（处理 dragend 丢失的情况）
  window.addEventListener('dragend', handleGlobalDragEnd)
  window.addEventListener('drop', handleGlobalDragEnd)
})

/**
 * 处理 Spotlight 资产选中事件
 */
let locateRequest = 0

async function handleSpotlightSelectAsset(event: CustomEvent<{ assetKey: string }>): Promise<void> {
  if (event.detail.assetKey) await trySelectAsset(event.detail.assetKey)
}

async function trySelectAsset(assetKey: string): Promise<boolean> {
  const request = ++locateRequest
  const scope = props.selectionScope
  const close = message.loading(t('common.loading'), 0)
  try {
    if (props.ensureFilesLoaded && !(await props.ensureFilesLoaded(assetKey))) {
      if (scope === props.selectionScope) message.warning(t('assetFileList.locateFailed'))
      return false
    }
    await nextTick()
    if (request !== locateRequest || scope !== props.selectionScope) return false
    const index = assetFiles.value.findIndex((file) => getItemId(file) === assetKey)
    const container = containerRef.value
    const grid = assetGridRef.value
    if (index < 0 || !container || !grid) {
      message.warning(t('assetFileList.locateFailed'))
      return false
    }
    isFileSectionExpanded.value = true
    await nextTick()
    refreshGridLayout()
    const top =
      grid.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    container.scrollTop = Math.max(
      0,
      top +
        Math.floor(index / columnsPerRow.value) * itemRowHeight.value -
        container.clientHeight / 2
    )
    updateScrollPosition()
    await nextTick()
    const element = container.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(assetKey)}"]`)
    if (!element) {
      message.warning(t('assetFileList.locateFailed'))
      return false
    }
    element.scrollIntoView({ block: 'center' })
    updateScrollPosition()
    clearSelection()
    setSelected(assetKey)
    return true
  } catch (error) {
    message.error(resolveErrorText(error, t('assetFileList.locateFailed')))
    return false
  } finally {
    close()
  }
}

onUnmounted(() => {
  // 移除滚动监听
  if (containerRef.value) {
    containerRef.value.removeEventListener('scroll', handleScroll)
  }
  if (scrollContainerRef.value) {
    scrollContainerRef.value.removeEventListener('scroll', handleScroll)
  }

  // 移除 Spotlight 资产选中事件监听
  ;(window as any).removeEventListener('spotlight:select-asset', handleSpotlightSelectAsset)
  window.removeEventListener('dragend', handleGlobalDragEnd)
  window.removeEventListener('drop', handleGlobalDragEnd)
})

// 暴露方法给父组件
defineExpose({
  clearSelection,
  setSelected,
  revealAsset: trySelectAsset
})

// 监听文件列表变化，更新可选择元素

// 当文件列表变化时更新选择器
watch(
  () => props.files,
  async () => {
    await nextTick()
    await updateSelectables()
    const schedule = (fn: () => void) => {
      const ri = (window as any).requestIdleCallback
      if (typeof ri === 'function') {
        ri(fn)
      } else {
        setTimeout(fn, 0)
      }
    }
    schedule(async () => {
      const assetIds = props.files
        .filter((file: any) => file.type !== 'folder')
        .map((file: any) => file.assetKey || file.id)
        .filter(Boolean)
      if (assetIds.length > 0) {
        try {
          const statusMap = await checkFavorites(assetIds)
          favoriteStatusMap.value = statusMap || {}
        } catch {
          favoriteStatusMap.value = {}
        }
      }
    })
  },
  { deep: true }
)

// 行内重命名状态
const inlineEditId = ref<string | null>(null)
const inlineEditValue = ref<string>('')
const inlineInputRef = ref<HTMLInputElement | null>(null)

/**
 * 开始行内重命名：根据文件ID进入编辑态并聚焦输入框
 */
const startInlineRename = async (fileId: string) => {
  const file = props.files.find((f: any) => getItemId(f) === fileId) as any
  if (!file) return
  inlineEditId.value = fileId
  inlineEditValue.value =
    file.type === 'folder' ? String(file.name || '') : String(file.assetName || '')

  // 暂停框选，防止点击输入框或外部区域时触发框选
  pauseDragSelect()

  await nextTick()
  // 延迟聚焦以确保 DOM 渲染完成
  setTimeout(() => {
    try {
      // inlineInputRef 在 v-for 中会被收集为数组
      const inputRefs = inlineInputRef.value as any

      // 找到当前渲染的那个 input（因为同一时间只有一个在编辑，数组中应该只有一个有效的，或者我们需要遍历）
      let inputComp: any = null

      if (Array.isArray(inputRefs)) {
        // 过滤掉 null 或 undefined
        const validRefs = inputRefs.filter((r) => r)
        if (validRefs.length > 0) {
          inputComp = validRefs[0]
        }
      } else {
        inputComp = inputRefs
      }

      if (inputComp) {
        // 优先调用组件 focus
        inputComp.focus?.()

        // 尝试选中内容
        if (typeof inputComp.select === 'function') {
          inputComp.select()
        } else if (inputComp.$el) {
          // 尝试查找原生 input 元素
          const nativeInput =
            inputComp.$el.tagName === 'INPUT' ? inputComp.$el : inputComp.$el.querySelector('input')
          if (nativeInput && typeof nativeInput.select === 'function') {
            nativeInput.select()
          }
        }
      }
    } catch (err) {
      console.warn('Failed to focus input:', err)
    }
  }, 50)
}

/**
 * 取消行内重命名：退出编辑态并清理输入值
 */
const cancelInlineRename = () => {
  inlineEditId.value = null
  inlineEditValue.value = ''
  // 清除可能存在的文本选择，防止干扰 DragSelect
  if (window.getSelection) {
    window.getSelection()?.removeAllRanges()
  }
  // 恢复框选功能
  resumeDragSelect()
}

/**
 * 确认行内重命名：根据编辑对象类型调用对应重命名逻辑
 */
const confirmInlineRename = async () => {
  const newName = (inlineEditValue.value || '').trim()
  const editingId = inlineEditId.value
  if (!editingId) return

  if (!newName) {
    message.warning(t('assetFileList.folder.nameRequired'))
    return
  }

  const file = props.files.find((f: any) => getItemId(f) === editingId) as any
  if (!file) {
    cancelInlineRename()
    return
  }

  // 文件夹重命名校验规则：与原有弹窗一致
  if (file.type === 'folder') {
    if (newName.toUpperCase() === 'ALL') {
      message.error(t('assetFileList.folder.invalidNameAll'))
      return
    }
    const invalidChars = /[<>:"/\\|?*]/
    if (invalidChars.test(newName)) {
      message.error(t('assetFileList.folder.invalidChars'))
      return
    }
  }

  try {
    if (file.type === 'folder') {
      await assetContext.renameFolder(String(file.id), newName)
    } else {
      const assetKey = String(file.assetKey || file.id)
      await assetContext.renameAsset(assetKey, newName)
    }
    // message.success('重命名成功')
    await assetContext.refreshCurrentFolder()
    cancelInlineRename()
  } catch (err) {
    console.error('行内重命名失败:', err)
    message.error(resolveErrorText(err, t('assetFileList.rename.failed')))
  }
}

/**
 * 切换选中资产/文件夹的收藏状态（Ctrl + D）
 * 若全部已收藏则移除收藏，否则对未收藏项执行收藏
 */
const toggleFavoritesForSelectedIds = async (fileIds: string[]): Promise<void> => {
  try {
    const userId = 1
    const vaultId = currentVault.value?.id

    // 获取所有选中的项（包括文件和文件夹）
    const selectedItems = fileIds
      .map((id) => props.files.find((f: any) => getItemId(f) === id))
      .filter(Boolean) as Array<AssetDataRow | FolderItem>

    if (selectedItems.length === 0) return

    // 分类处理
    const assets = selectedItems.filter((item) => (item as any).type !== 'folder') as AssetDataRow[]
    const folders = selectedItems.filter((item) => (item as any).type === 'folder') as FolderItem[]

    // 检查是否全部已收藏
    const allAssetsFav = assets.every((f) => getFavoriteStatus(String(f.assetKey || f.id)))
    const allFoldersFav = folders.every((f) => getFolderFavoriteStatus(String(f.id)))
    const allFav =
      (assets.length > 0 || folders.length > 0) &&
      (assets.length === 0 || allAssetsFav) &&
      (folders.length === 0 || allFoldersFav)

    if (allFav) {
      // 全部移除
      const promises: Promise<any>[] = []

      // 移除资产收藏
      if (assets.length > 0) {
        promises.push(
          ...assets.map(async (f) => {
            const k = String(f.assetKey || f.id)
            await favorites().remove(k)
            setFavoriteStatus(k, false)
          })
        )
      }

      // 移除文件夹收藏
      if (folders.length > 0) {
        promises.push(
          ...folders.map(async (f) => {
            const k = String(f.id)
            await favorites().removeFolder(k)
            setFolderFavoriteStatus(k, false)
          })
        )
      }

      await Promise.all(promises)
      message.success(t('assetFileList.favorite.removedProjects', { count: selectedItems.length }))
    } else {
      // 添加未收藏的项
      const promises: Promise<any>[] = []

      // 添加资产收藏
      if (assets.length > 0) {
        promises.push(
          ...assets.map(async (f) => {
            const k = String(f.assetKey || f.id)
            if (!getFavoriteStatus(k)) {
              await favorites().add(k)
              setFavoriteStatus(k, true)
            }
          })
        )
      }

      // 添加文件夹收藏
      if (folders.length > 0) {
        promises.push(
          ...folders.map(async (f) => {
            const k = String(f.id)
            if (!getFolderFavoriteStatus(k)) {
              await favorites().addFolder(k)
              setFolderFavoriteStatus(k, true)
            }
          })
        )
      }

      await Promise.all(promises)
      message.success(t('assetFileList.favorite.movedToFavorite', { count: selectedItems.length }))
    }

    // 通知收藏 store 刷新数量
    await favoriteStore.notifyChanged(userId, vaultId)

    // 刷新当前文件夹以获取最新数据
    await assetContext.refreshCurrentFolder()
  } catch (error) {
    console.error('批量收藏切换失败:', error)
    message.error(t('assetFileList.favorite.operationFailed'))
  }
}

// ========== 资产拖拽到外部（如百度网盘）的处理 ==========

/**
 * 资产项拖拽开始处理
 * 将资产信息存储到 dataTransfer 中，供百度网盘等目标接收
 * @param event 拖拽事件
 * @param file 被拖拽的资产
 */
// 预加载透明 Canvas 用于隐藏默认拖拽虚影
const emptyCanvas = document.createElement('canvas')
emptyCanvas.width = 1
emptyCanvas.height = 1

// 拖拽覆盖层状态
const dragOverlayState = reactive({
  visible: false,
  text: '',
  x: 0,
  y: 0
})

const isHtml5Dragging = ref(false)
let isExternalAssetDrag = false

// 记录拖拽过程中最后有效的鼠标位置（用于 dragend 时检测落点）
const lastDragPos = reactive({ x: 0, y: 0 })

const handleGlobalDragEnd = (): void => {
  console.log('[AssetFileList] handleGlobalDragEnd 触发', {
    isHtml5Dragging: isHtml5Dragging.value
  })
  if (!isHtml5Dragging.value) return
  isHtml5Dragging.value = false
  dragOverlayState.visible = false
  console.log('[AssetFileList] handleGlobalDragEnd 调用 resumeDragSelect')
  resumeDragSelect()
}

// ========== WebDav文件拖放到本地资产库的处理 ==========

let webdavDragCounter = 0

/**
 * 处理WebDav文件拖拽进入
 */
function handleWebdavDragEnter(event: DragEvent): void {
  webdavDragCounter++
  // 简单检查是否可能是WebDav文件
  if (event.dataTransfer?.types.includes('application/json')) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 处理WebDav文件拖拽悬停
 */
function handleWebdavDragOver(event: DragEvent): void {
  // 简单检查是否可能是WebDav文件
  if (event.dataTransfer?.types.includes('application/json')) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 处理WebDav文件拖拽离开
 */
function handleWebdavDragLeave(): void {
  webdavDragCounter--
}

/**
 * 处理WebDav文件拖放
 */
async function handleWebdavDrop(event: DragEvent): Promise<void> {
  webdavDragCounter = 0

  try {
    const jsonData = event.dataTransfer?.getData('application/json')
    if (!jsonData) return

    const webdavFileData = JSON.parse(jsonData)

    // 验证是否为WebDav文件
    if (webdavFileData.type !== 'webdav-file') return

    console.log('[AssetFileList] 接收到WebDav文件拖放:', webdavFileData)

    // 显示下载提示
    // message.loading({ content: '准备下载...', key: 'webdav-download' })

    // 获取目标目录（复用现有逻辑）
    const vaultResult = await (window as any).api.invoke('vault:getCurrentPath')
    if (!vaultResult?.success || !vaultResult.path) {
      throw new Error('未选择本地资产库，请先在资产库页选择一个保管库')
    }

    const vaultPath: string = vaultResult.path
    const sep = vaultPath.includes('\\') ? '\\' : '/'

    // 确定目标文件夹
    let folderKey = props.selectedFolderKey || 'ALL'
    let relative = 'assetData'

    if (folderKey && folderKey !== 'ALL') {
      try {
        const folder = await (window as any).api.database.assetFolder.getByKey(folderKey)
        const folderFullPath = folder?.data?.fullPath || ''
        if (folderFullPath) {
          const normalized = folderFullPath.replace(/^[/\\]+/, '').replace(/[\\/]+/g, sep)
          relative = `assetData${sep}${normalized}`
        }
      } catch (error) {
        console.warn('获取文件夹路径失败，使用默认路径', error)
      }
    }

    const targetDir = `${vaultPath}${sep}${relative}`

    // 确保目录存在
    await (window as any).api.invoke('fs:ensureDir', targetDir)

    // 构建唯一文件名
    const fileName = webdavFileData.basename || 'download'
    let finalPath = `${targetDir}${sep}${fileName}`

    // 检查文件是否存在，如果存在则添加数字后缀
    for (let i = 0; i < 50; i++) {
      const extIndex = fileName.lastIndexOf('.')
      const base = extIndex > 0 ? fileName.slice(0, extIndex) : fileName
      const ext = extIndex > 0 ? fileName.slice(extIndex) : ''
      const testName = i === 0 ? fileName : `${base} (${i})${ext}`
      const testPath = `${targetDir}${sep}${testName}`

      const existsRes = await (window as any).api.invoke('fs:exists', testPath)
      const exists = existsRes?.exists ?? existsRes === true

      if (!exists) {
        finalPath = testPath
        break
      }
    }

    // 调用WebDav下载
    const result = await (window as any).api.webdav.downloadFile({
      serverUrl: webdavFileData.serverUrl,
      username: webdavFileData.username,
      password: webdavFileData.password,
      remotePath: webdavFileData.remotePath,
      savePath: finalPath
    })

    if (result.success) {
      // 将文件导入到资产数据库
      try {
        const stats = await (window as any).api.getFileStats(finalPath)
        const name = finalPath.split(/[/\\]/).pop() || fileName
        const fileInfo = {
          name,
          path: finalPath,
          type: 'file' as const,
          size: stats?.size ?? null,
          modifiedTime: stats?.mtime ?? new Date().toISOString(),
          depth: 0,
          relativePath: name
        }
        await assetDataAPI.importFolderStructureWithMetadata([fileInfo], 'ALL', folderKey)

        // 刷新文件列表
        await assetContext.refreshCurrentFolder()

        // message.success({ content: `已下载到资产库：${name}`, key: 'webdav-download' })
      } catch (error) {
        console.warn('写入资产索引失败（可稍后手动导入）:', error)
        message.success({
          content: t('assetFileList.webdav.downloadedRefreshManually')
        })
      }
    } else {
      message.error({
        content: result.error || t('assetFileList.webdav.downloadFailed')
      })
    }
  } catch (error) {
    console.error('[AssetFileList] WebDav文件拖放处理失败:', error)
    const msg = error instanceof Error ? error.message : t('assetFileList.webdav.downloadFailed')
    message.error({ content: msg })
  }
}

function handleAssetDragStart(event: DragEvent, file: AssetDataRow | FolderItem): void {
  if (!libraryCaps.value.canEditStructure) {
    event.preventDefault()
    if (event.altKey && !libraryCaps.value.nativeDrag) message.info(capabilityReason('nativeDrag'))
    return
  }
  isExternalAssetDrag = handleExternalAssetDrag(
    event,
    () => {
      if ((file as FolderItem).type === 'folder') return null
      if (isSelected(getItemId(file)) && selectedItems.value.length !== 1) return null
      return getLocalFilePath(file)
    },
    startNativeFileDrag,
    () => message.error(t('assetFileList.externalDragFailed'))
  )
  if (isExternalAssetDrag) return

  // 库内拖动（拖进某个文件夹）在回收站里不成立：东西还在删除态，搬过去也看不见，
  // 而且会让「删了」和「搬了」这两件事同时发生。要动它先恢复。
  // Alt 拖到系统外面另说 —— 那是把文件捞出来备份，上面那一段已经处理完了
  if (isTrashView.value) {
    event.preventDefault()
    return
  }

  console.log('[AssetFileList] handleAssetDragStart 触发', {
    file: getItemId(file),
    isHtml5DraggingBefore: isHtml5Dragging.value
  })
  if (!event.dataTransfer) return

  // 标记 HTML5 拖拽状态，暂停框选功能，避免拖拽和框选冲突
  isHtml5Dragging.value = true
  console.log('[AssetFileList] handleAssetDragStart 调用 pauseDragSelect')
  pauseDragSelect()

  // 获取选中的项目（如果当前项已选中则拖拽所有选中项，否则只拖拽当前项）
  const fileId = getItemId(file)
  const dragItems = isSelected(fileId) ? selectedItems.value : [file]
  const fileItems = dragItems.filter(
    (item) => (item as FolderItem).type !== 'folder'
  ) as AssetDataRow[]

  const dragLabels = dragItems
    .map((item) =>
      (item as FolderItem).type === 'folder'
        ? (item as FolderItem).name
        : (item as AssetDataRow).assetName
    )
    .filter(Boolean) as string[]

  // 设置拖拽数据类型和内容（仅文件用于外部接收）
  if (fileItems.length > 0) {
    const transferData = {
      source: 'assetlib',
      items: fileItems.map((f) => ({
        id: f.assetKey,
        name: f.assetName,
        // 使用 getLocalFilePath 获取正确的本地路径（处理备份模式和引用模式的差异）
        path: getLocalFilePath(f) || f.originPath || f.filePath || '',
        type: 'file',
        assetType: (f as AssetDataRow & { className?: string }).className || 'Unknown'
      }))
    }
    event.dataTransfer.setData('application/x-asset-items', JSON.stringify(transferData))
  }
  event.dataTransfer.setData('text/plain', dragLabels.join(', '))
  event.dataTransfer.effectAllowed = 'copy'

  // 隐藏默认拖拽虚影
  event.dataTransfer.setDragImage(emptyCanvas, 0, 0)

  // 显示自定义 DragOverlay
  const count = dragItems.length
  dragOverlayState.text = count === 1 ? dragLabels[0] || 'Unknown Item' : `${count} items`
  dragOverlayState.x = event.clientX + 12
  dragOverlayState.y = event.clientY + 12
  dragOverlayState.visible = true

  // 添加拖拽状态样式
  const target = event.target as HTMLElement
  target.classList.add('dragging')
}

/**
 * 拖拽过程更新覆盖层位置
 */
function handleAssetDrag(event: DragEvent) {
  if (isExternalAssetDrag) return
  // 拖拽结束时可能会触发一次 (0,0) 的事件，需要过滤
  if (event.clientX === 0 && event.clientY === 0) return

  // 记录最后有效位置（用于 dragend 时检测落点）
  lastDragPos.x = event.clientX
  lastDragPos.y = event.clientY

  if (dragOverlayState.visible) {
    dragOverlayState.x = event.clientX + 12
    dragOverlayState.y = event.clientY + 12
  }
}

/**
 * 资产项拖拽结束处理
 * 支持拖拽到左侧树节点或右侧文件夹进行移动
 * @param event 拖拽事件
 */
async function handleAssetDragEnd(event: DragEvent): Promise<void> {
  if (isExternalAssetDrag) return
  // 移除拖拽状态样式
  const target = event.target as HTMLElement
  target.classList.remove('dragging')

  // 关闭 DragOverlay
  dragOverlayState.visible = false

  const draggedItems = selectedItems.value.map((item) => ({
    id: getItemId(item),
    type: ((item as FolderItem).type === 'folder' ? 'folder' : 'file') as 'file' | 'folder'
  }))

  // 检测落点目标，支持拖拽到左侧树节点或右侧文件夹
  // 使用 drag 事件中记录的最后有效位置（因为 dragend 的坐标可能为 0,0）
  const dropX = lastDragPos.x
  const dropY = lastDragPos.y

  // 只在有效坐标时检测
  if (dropX !== 0 || dropY !== 0) {
    const el = document.elementFromPoint(dropX, dropY) as HTMLElement | null

    // 检测是否拖拽到右侧文件夹
    const rightFolderItem = el?.closest('.file-item.folder-item') as HTMLElement | null
    if (rightFolderItem) {
      const dropId = rightFolderItem.getAttribute('data-file-id') || ''
      // 获取当前拖拽的资产项
      if (dropId && draggedItems.length > 0 && !isSelected(dropId)) {
        try {
          const resp = await (window as any).api.dragMove.moveItems(draggedItems, dropId)
          if (resp?.success && resp.data?.success) {
            message.success(
              t('assetLib.fileList.moveSuccess', {
                folders: resp.data.movedItems.folders,
                files: resp.data.movedItems.files
              })
            )
            await assetContext.refreshTreeForMove(props.selectedFolderKey, dropId, draggedItems)
            await assetContext.refreshCurrentFolder()
            clearSelection()
          } else {
            const msg = resp?.data?.message || resp?.error || t('assetLib.fileList.moveFailed')
            message.error(resolveErrorText(msg, t('assetLib.fileList.moveFailed')))
          }
        } catch (err) {
          message.error(
            resolveErrorText(err, t('assetLib.fileList.moveError', { error: String(err) }))
          )
        }
      }
    } else {
      // 检测是否拖拽到左侧树节点
      const treeNodeWrapper = el?.closest('.ant-tree-node-content-wrapper') as HTMLElement | null
      const treeNode = treeNodeWrapper || (el?.closest('.ant-tree-treenode') as HTMLElement | null)

      if (treeNode) {
        const titleEl = treeNode.querySelector('.tree-node-title') as HTMLElement | null
        const dropId = titleEl?.getAttribute('data-folder-key') || ''

        // 获取当前拖拽的资产项
        if (dropId && draggedItems.length > 0) {
          try {
            const resp = await (window as any).api.dragMove.moveItems(draggedItems, dropId)
            if (resp?.success && resp.data?.success) {
              message.success(
                t('assetLib.fileList.moveSuccess', {
                  folders: resp.data.movedItems.folders,
                  files: resp.data.movedItems.files
                })
              )
              await assetContext.refreshTreeForMove(props.selectedFolderKey, dropId, draggedItems)
              await assetContext.refreshCurrentFolder()
              clearSelection()
            } else {
              const msg = resp?.data?.message || resp?.error || t('assetLib.fileList.moveFailed')
              message.error(resolveErrorText(msg, t('assetLib.fileList.moveFailed')))
            }
          } catch (err) {
            message.error(
              resolveErrorText(err, t('assetLib.fileList.moveError', { error: String(err) }))
            )
          }
        }
      }
    }
  }

  // 重置 HTML5 拖拽状态，恢复框选功能
  console.log('[AssetFileList] handleAssetDragEnd 准备恢复框选', {
    isHtml5DraggingBefore: isHtml5Dragging.value
  })
  isHtml5Dragging.value = false
  // 延迟恢复框选，确保拖拽事件完全结束
  setTimeout(() => {
    console.log('[AssetFileList] handleAssetDragEnd setTimeout 执行', {
      isHtml5Dragging: isHtml5Dragging.value
    })
    if (!isHtml5Dragging.value) {
      console.log('[AssetFileList] handleAssetDragEnd 调用 resumeDragSelect')
      resumeDragSelect()
    }
  }, 100)
}
</script>

<style lang="less" scoped>
.asset-file-list {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;

  /* 自定义文件夹封面样式 */
  .custom-folder-cover {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 6px;
    box-shadow: 0 2px 6px var(--shadow-color-weak);
    transition: transform 0.2s ease;

    &:hover {
      transform: scale(1.05);
    }
  }

  /* 文件夹封面上的颜色圆点 */
  .folder-color-dot {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid var(--color-border-strong);
    box-shadow: 0 1px 3px var(--shadow-color);
    z-index: 10;
  }

  .file-content {
    flex: 1;
    min-width: 0;
    padding: var(--space-4);
    overflow-y: auto;
    overflow-x: hidden;
    // 虚拟列表自行维护占位；浏览器锚定补偿会反过来触发下一轮切片。
    overflow-anchor: none;

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--color-text-muted);

      .empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.6;
      }

      .empty-text {
        font-size: 16px;
        font-weight: 500;
        margin-bottom: 8px;
      }

      .empty-desc {
        font-size: 14px;
        opacity: 0.8;
      }
    }

    .file-content-wrapper {
      .folder-section,
      .asset-section {
        margin-bottom: var(--space-6);

        &:last-child {
          margin-bottom: 0;
        }

        .section-header {
          padding: var(--space-2) 0;
          margin-bottom: var(--space-1);
          margin-top: 8px;
          border-bottom: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          user-select: none;

          &:hover {
            .section-title {
              color: var(--color-text-primary);
            }
            .header-line {
              background-color: var(--color-bg-surface-hover);
            }
          }

          .section-title {
            font-size: 11px;
            font-weight: 700;
            color: var(--color-text-muted);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
            transition: color 0.2s;

            .expand-icon {
              font-size: 12px;
              width: 14px;
              height: 14px;
              display: flex;
              align-items: center;
              justify-content: center;
            }
          }

          .header-line {
            flex: 1;
            height: 1px;
            background-color: var(--color-border);
            transition: background-color 0.2s;
          }
        }
      }
    }

    .file-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--space-3);

      // 虚拟滚动的上下占位：必须跨整行。
      // 没有这一行时它只是网格里的一个普通格子，一旦有高度就把首行撑成上千像素，
      // 后面所有项还会整体错位一格。
      .virtual-scroll-padding {
        grid-column: 1 / -1;
      }

      .file-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--space-2);
        border: 1px solid transparent; // 边框透明占位
        border-radius: 8px;
        cursor: pointer;
        transition:
          background-color 0.15s ease-out,
          border-color 0.15s ease-out,
          box-shadow 0.15s ease-out;
        background-color: transparent; // 平时背景透明
        position: relative;
        -webkit-user-drag: element;

        &:hover {
          background-color: var(--color-bg-surface-hover);
          border-color: var(--color-border-strong);
          box-shadow: var(--shadow-soft);
        }

        // 收藏状态指示器
        &.favorite-item {
          // 收藏项的特殊边框效果
          // border-color: var(--color-warning-border);
          // box-shadow: 0 0 0 1px var(--color-warning-border);
        }

        .file-icon {
          font-size: v-bind('`${Math.max(24, Math.min(160, gridItemSize * 0.8))}px`');
          margin-bottom: var(--space-3);

          // 文件夹图标包装器 - 确保与资产项高度一致
          .folder-icon-wrapper {
            position: relative;
            width: 100%;
            height: v-bind('`${Math.max(60, Math.min(220, gridItemSize))}px`');
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .folder-icon {
            color: var(--color-folder); // Amber-400: 温暖的黄色实心文件夹
            filter: drop-shadow(0 2px 4px var(--shadow-color)); // 给图标一点立体投影
          }

          // 插件文件夹图标
          .plugin-folder-icon {
            width: 60%;
            height: auto;
            max-width: 256px;
            filter: drop-shadow(0 2px 4px var(--shadow-color));
          }

          // 文件夹类型徽章（右下角小图标）
          .folder-type-badge {
            position: absolute;
            right: -2px;
            bottom: 4px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            box-shadow: 0 1px 3px var(--shadow-color);
            z-index: 1;

            svg {
              font-size: 12px;
            }
          }

          .project-badge {
            background: var(--color-accent-solid);
            color: var(--color-text-on-solid);
          }

          .plugin-badge {
            background: var(--color-bg-surface-hover);
            color: var(--color-text-primary);
          }

          // 自定义颜色文件夹 - 使用 CSS 变量覆盖默认颜色
          .folder-icon-wrapper.has-custom-color {
            .folder-icon {
              color: var(--custom-folder-color) !important;
            }
          }

          // 实心图标包装器
          .solid-icon-wrapper {
            width: 100%;
            height: v-bind('`${Math.max(60, Math.min(220, gridItemSize))}px`');
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: var(--radius-xs);
            position: relative;
            overflow: hidden;
            background: transparent; // 无背景，图标本身就是实心的

            .file-ext-label {
              position: absolute;
              left: 50%;
              top: 50%;
              transform: translate(-50%, -50%);
              max-width: 60%;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
              pointer-events: none;
              user-select: none;
              z-index: 2;

              // 好看的字体：Windows 上优先 Segoe UI Variable / Cascadia Mono
              font-family:
                ui-monospace, 'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas,
                monospace;
              font-weight: 700;
              letter-spacing: 0.6px;
              line-height: 1;
              font-size: v-bind('`${Math.max(11, Math.min(20, gridItemSize * 0.16))}px`');

              color: var(--color-text-primary);
              background: transparent;
              border: none;
              box-shadow: none;
              backdrop-filter: none;
              /* 仅保留文字阴影，保证在浅色/白色图标上也可读 */
              text-shadow:
                0 2px 8px var(--shadow-color),
                0 1px 2px var(--shadow-color);
            }
          }

          // 🔌 插件引擎版本标签
          .engine-version-tag {
            position: absolute;
            top: 4px;
            right: 4px;
            padding: 2px 6px;
            background: var(--color-accent-solid);
            color: var(--color-text-on-solid);
            font-size: 10px;
            font-weight: 600;
            border-radius: 4px;
            z-index: 3;
            white-space: nowrap;
            box-shadow: 0 1px 3px var(--shadow-color);
            backdrop-filter: blur(4px);
            letter-spacing: 0.3px;
          }

          // 资产引擎版本角标：样子跟 hover 的类型标签一套，放左上角，同样 hover 才出现
          .asset-version-tag {
            position: absolute;
            left: 6px;
            top: 6px;
            z-index: 5;
            opacity: 0;
            transform: scale(0.9);
            transform-origin: top left;
            max-width: 60%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            pointer-events: none;
            user-select: none;
            font-family:
              ui-monospace, 'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas,
              monospace;
            font-weight: 700;
            letter-spacing: 0.5px;
            line-height: 1;
            font-size: v-bind('`${Math.max(9, Math.min(12, gridItemSize * 0.08))}px`');
            color: var(--color-text-on-solid);
            padding: 2px 5px;
            background: var(--color-bg-overlay);
            backdrop-filter: blur(4px);
            border-radius: 4px;
            transition:
              opacity 0.2s ease,
              transform 0.2s ease;
          }

          &:hover .asset-version-tag {
            opacity: 1;
            transform: scale(1);
          }

          // 缩略图容器
          .thumbnail-container {
            position: relative;
            width: 100%;
            height: v-bind('`${Math.max(60, Math.min(220, gridItemSize))}px`');
            border-radius: var(--radius-xs);
            overflow: hidden;
            background: var(--color-bg-page);

            .thumbnail-img {
              width: 100%;
              height: 100%;
              object-fit: cover;
              display: block;
              transition:
                transform 0.25s ease,
                filter 0.25s ease;
            }

            // Hover 时显示的文件后缀标签
            .thumbnail-hover-ext {
              position: absolute;
              left: 50%;
              bottom: 8px; // 移动到偏底部
              transform: translateX(-50%) scale(0.9); // 初始缩放
              opacity: 0;
              pointer-events: none;
              user-select: none;
              z-index: 5;
              white-space: nowrap; // 强制单行显示

              // 字体样式
              font-family:
                ui-monospace, 'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas,
                monospace;
              font-weight: 700;
              letter-spacing: 0.5px;
              line-height: 1;
              // 进一步减小文字大小 (0.12 -> 0.09)
              font-size: v-bind('`${Math.max(9, Math.min(13, gridItemSize * 0.09))}px`');
              color: var(--color-text-on-solid);

              // 胶囊状背景
              padding: 2px 6px;
              background: var(--color-bg-overlay); // 稍微加深一点背景
              backdrop-filter: blur(4px);
              border-radius: 4px;
              max-width: 90%; // 防止文字过长超出容器
              overflow: hidden;
              text-overflow: ellipsis;

              // 动画过渡
              transition:
                opacity 0.2s ease,
                transform 0.2s ease;
            }

            // Hover 状态
            &:hover {
              .thumbnail-hover-ext {
                opacity: 1;
                transform: translateX(-50%) scale(1);
              }
            }

            // 内嵌式底部边框 (ID Line) - 看起来像是图片边框的一部分
            .thumbnail-id-line {
              position: absolute;
              bottom: 0;
              left: 0;
              right: 0;
              height: 3px;
              z-index: 2;
              opacity: 0.8;
            }
          }
        }

        .file-info {
          width: 100%;
          text-align: center;
          min-height: 48px; // 保持重命名态与展示态高度一致，避免卡片跳动

          .file-name {
            font-size: 14px;
            font-weight: 500;
            color: var(--color-text-secondary);
            margin-bottom: var(--space-1);
            // AI 生成的资产名前缀大量重合，单行截断会让一整屏文件名长得一模一样。
            // 放到两行，多出来的信息量足够区分
            display: -webkit-box;
            -webkit-line-clamp: 2;
            line-clamp: 2;
            -webkit-box-orient: vertical;
            min-height: 40px;
            line-height: 20px;
            overflow: hidden;
            overflow-wrap: anywhere;
            text-align: center;
            transition: none; // 禁用过渡，避免字体粗细变化时的闪烁
          }

          :deep(.inline-rename-input) {
            width: 100%;
            height: 24px;
            line-height: 24px;
            padding: 0 8px;
            text-align: center;
            box-sizing: border-box;
          }

          .file-meta {
            display: none;
          }
        }

        // 文件夹样式区分 - 简化，主要靠图标颜色区分
        &.folder-item {
          // 文件夹卡片基础样式，不设置特殊背景色
          .file-name {
            color: var(--color-text-primary);
            font-weight: 500;
          }

          // 文件夹上传状态样式
          .folder-upload-overlay {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            /* 适配 file-icon 的 padding/border */
            border-radius: var(--radius-xs);
            overflow: hidden;
            z-index: 5;
            pointer-events: none;

            .upload-backdrop {
              position: absolute;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: var(--color-bg-surface-hover);
              backdrop-filter: blur(2px);
            }

            .upload-content {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              color: var(--color-text-primary);
              gap: 2px;
              width: 100%;

              .upload-icon-small {
                font-size: v-bind('`${Math.max(16, Math.min(28, gridItemSize * 0.25))}px`');
                filter: drop-shadow(0 2px 4px var(--shadow-color-strong));
                opacity: 0.9;
              }

              .upload-percent {
                font-size: v-bind('`${Math.max(10, Math.min(14, gridItemSize * 0.12))}px`');
                font-weight: 700;
                text-shadow: 0 1px 2px var(--shadow-color-strong);
                font-family: ui-monospace, 'Cascadia Mono', 'SF Mono', monospace;
                letter-spacing: 0.5px;
              }
            }

            .upload-progress-bar-bottom {
              position: absolute;
              bottom: 0;
              left: 0;
              width: 100%;
              height: 4px;
              background: var(--color-bg-surface-hover);

              .upload-progress-fill {
                height: 100%;
                background: linear-gradient(
                  90deg,
                  var(--color-accent-bg-hover),
                  var(--color-accent-solid)
                );
                transition: width 0.3s ease;
                box-shadow: 0 0 8px var(--color-accent-border);
              }
            }
          }

          // ⚫ 工程导入覆盖层 - 黑灰品牌主题
          .folder-upload-overlay.project-import-overlay {
            .upload-backdrop.project-import-backdrop {
              background: linear-gradient(135deg, var(--color-bg-surface), var(--color-bg-surface));
              backdrop-filter: blur(3px) saturate(1.1);
            }

            .upload-content {
              .upload-icon-small.project-import-icon {
                color: var(--color-text-primary);
                filter: drop-shadow(0 2px 4px var(--shadow-color-strong));
              }

              .upload-percent.project-import-percent {
                color: var(--color-text-primary);
                text-shadow: 0 1px 3px var(--shadow-color-strong);
              }

              // ✓ 完成勾选图标 - 白色主题动画
              .upload-icon-small.project-import-check {
                color: var(--color-text-primary);
                font-size: v-bind('`${Math.max(24, Math.min(36, gridItemSize * 0.35))}px`');
                filter: drop-shadow(0 2px 8px var(--shadow-highlight));
                animation: checkmark-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
              }
            }

            .upload-progress-bar-bottom.project-import-bar {
              background: var(--color-bg-surface-hover);
              .upload-progress-fill.project-import-fill {
                background: linear-gradient(90deg, var(--color-bg-raised), var(--color-bg-raised));
                box-shadow: 0 0 6px var(--shadow-color);
              }
            }

            // 完成状态 - 保持深色并淡出
            &.is-completed {
              .upload-backdrop.project-import-backdrop {
                animation: fade-out 1.5s ease forwards;
              }

              .upload-progress-bar-bottom.project-import-bar {
                .upload-progress-fill.project-import-fill {
                  // 完成后整条淡出，起点用中性灰跟进行中的状态区分开
                  background: linear-gradient(
                    90deg,
                    var(--color-border-strong),
                    var(--color-bg-raised)
                  );
                  box-shadow: 0 0 8px var(--shadow-color-strong);
                }
              }
            }
          }

          // 勾选弹出动画
          @keyframes checkmark-pop {
            0% {
              transform: scale(0);
              opacity: 0;
            }
            50% {
              transform: scale(1.2);
            }
            100% {
              transform: scale(1);
              opacity: 1;
            }
          }

          // 淡出动画
          @keyframes fade-out {
            0% {
              opacity: 1;
            }
            70% {
              opacity: 1;
            }
            100% {
              opacity: 0;
            }
          }
        }

        // 资产文件样式
        &.asset-item {
          position: relative;

          &:hover {
            box-shadow: var(--shadow-soft);
          }

          // 已删除 asset-color-strip，改为内嵌式底部边框
        }

        // 选中状态样式 - Win11 Fluent Design
        &.file-item-selected {
          // 背景：Win11 选中状态
          background-color: var(--color-bg-selected) !important;
          // 边框：Win11 标准边框
          border-color: var(--color-border) !important;
          // 关键：给整个卡片加个发光阴影
          box-shadow:
            0 0 0 1px var(--color-accent-border),
            var(--shadow-pop) !important;

          .file-name {
            color: var(--color-text-primary);
            // font-weight: 600;
          }

          .file-icon {
            // 关键：选中时，图标保持原色！不要变品牌色
            .folder-icon {
              color: var(--color-folder) !important; // 保持本色
            }

            .project-folder-icon {
              color: var(--color-accent-text) !important; // 项目文件夹保持 Win11 标准蓝
            }

            .plugin-folder-icon {
              color: var(--color-text-muted) !important; // 插件文件夹保持青色
            }

            // 文件图标：选中时保持原色，不改变
            .solid-icon-wrapper {
              .solid-file-icon {
                // 保持原来的颜色，不改变
                opacity: 1;
              }
            }

            // 缩略图：选中时内嵌边框稍微加粗
            .thumbnail-container {
              .thumbnail-id-line {
                height: 4px;
                opacity: 1;
              }
            }
          }

          &:hover {
            background-color: var(--color-bg-surface-hover) !important;
            border-color: var(--color-border-strong) !important;
            box-shadow:
              0 0 0 1px var(--color-accent-border),
              var(--shadow-pop) !important;

            .thumbnail-container {
              .thumbnail-id-line {
                height: 4px;
                opacity: 1;
              }
            }
          }
        }

        // // 收藏相关样式
        // &.favorite-item {
        //   position: relative;

        //   &::after {
        //     content: '';
        //     position: absolute;
        //     top: 4px;
        //     right: 4px;
        //     width: 8px;
        //     height: 8px;
        //     background: var(--color-warning-bg);
        //     border-radius: 50%;
        //     z-index: 2;
        //   }
        // }

        .file-icon {
          position: relative;
          width: 100%;
          .favorite-icon {
            position: absolute;
            top: 4px;
            right: 4px;
            font-size: 12px;
            color: var(--color-warning-text);
            z-index: 3;
            background: var(--color-bg-page);
            border-radius: 50%;
            padding: 1px;
          }
        }

        // DragSelect 框选区域样式
        &.file-item-selectable {
          user-select: none;
          cursor: pointer;
          // 确保整个区域都可以被选中
          position: relative;

          &::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 1;
            pointer-events: none;
          }
        }

        &.file-item-hover {
          border-color: var(--color-border-strong);
          background: var(--color-bg-surface-hover);
        }
      }

      .import-item {
        .task-icon-wrapper {
          width: 100%;
          height: v-bind('`${Math.max(60, Math.min(220, gridItemSize))}px`');
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          border-radius: var(--radius-xs);
          background: var(--color-bg-page);
          overflow: hidden;
          border: 1px solid var(--color-border);
        }
        .task-fill {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 0;
          background: linear-gradient(
            180deg,
            var(--color-accent-bg-hover),
            var(--color-accent-solid)
          );
          z-index: 1;
        }
        .task-percent {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: var(--color-text-primary);
          font-weight: 600;
          font-size: v-bind('`${Math.max(12, Math.min(24, gridItemSize * 0.22))}px`');
          letter-spacing: 0.5px;
          z-index: 2;
          text-shadow: 0 1px 2px var(--shadow-color);
        }

        // 百度网盘上传任务特定样式
        .upload-task {
          .task-fill {
            background: var(--gradient-accent);
          }
          .upload-icon-overlay {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: v-bind('`${Math.max(24, Math.min(48, gridItemSize * 0.35))}px`');
            color: var(--color-text-muted);
            z-index: 1;
          }
        }

        .file-info {
          .file-meta {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            color: var(--color-text-secondary);
            font-size: 12px;
            margin-bottom: 8px;
          }
          .import-actions {
            display: flex;
            gap: 8px;
            justify-content: center;
          }
        }
      }
    }
  }

  // DragSelect 框选区域样式
  :deep(.ds-selector) {
    background: var(--color-accent-bg);
    border: 1px solid var(--color-accent-border);
    border-radius: var(--radius-card);
  }

  // 右键菜单样式
  .file-content {
    position: relative;
  }
}

/* 拖拽预览提示样式已迁移至全局组件 DragOverlay */
</style>

<style>
/* 拖拽跟随 - 全局样式 */
.asset-drag-overlay {
  position: fixed;
  z-index: 10000;
  pointer-events: none;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-primary);
  background: linear-gradient(180deg, var(--color-bg-surface), var(--color-bg-surface));
  border: 1px solid var(--color-border-subtle);
  box-shadow: 0 8px 24px var(--shadow-color);
  white-space: nowrap;
  backdrop-filter: saturate(120%) blur(6px);
  transform: translateZ(0); /* 开启 GPU 加速 */
}

.asset-drag-overlay .drag-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.asset-drag-overlay .drag-text {
  font-weight: 500;
  letter-spacing: 0.3px;
}

/* 空格键全屏预览缩略图样式 */
.thumbnail-fullscreen-preview {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.thumbnail-fullscreen-preview .preview-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--color-bg-scrim);
  backdrop-filter: blur(8px);
}

.thumbnail-fullscreen-preview .preview-content {
  position: relative;
  z-index: 1;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.thumbnail-fullscreen-preview .preview-media {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 16px 48px var(--shadow-color-strong);
}
</style>
