import { RouteRecordRaw } from 'vue-router'
import MainLayout from '../../layout/MainLayout.vue'

/**
 * 蓝图库 / 材质库的数据在公共数据库里，读它要走异步 IPC，而两个库的组件（编辑器恢复
 * 缩放位置、标签页回填标题）都假设「一挂载数据就在」。所以在进入这两个库之前先把
 * store 读完 —— 这样异步只存在于路由这一层，视图代码完全不用改。
 *
 * store 用 import() 懒加载，避免首屏就把这两个库拖进主包。
 */
async function waitForBlueprintLibrary(): Promise<void> {
  const { useBlueprintLibraryStore } = await import('../../store/modules/blueprintLibraryStore')
  await useBlueprintLibraryStore().ready
}

async function waitForMaterialLibrary(): Promise<void> {
  const { useMaterialLibraryStore } = await import('../../store/modules/materialLibraryStore')
  await useMaterialLibraryStore().ready
}

// 主布局相关路由
const mainRoutes: RouteRecordRaw = {
  path: '/',
  component: MainLayout,
  children: [
    /**
     * 项目库（原「首页」）。
     *
     * 它就是一个普通标签页：能关、能拖、能取消固定。
     * 唯一的特殊之处是「没有任何标签页时落到这里」，那条兜底在
     * `store/modules/tabs.ts` 的 DEFAULT_TAB_KEY，不靠 fixed 锁死。
     */
    {
      path: '',
      name: 'Home',
      component: () => import('../../views/Home/Home.vue'),
      meta: {
        title: 'menu.projectLib',
        isShowInTab: true,
        fixed: false,
        // 侧边栏里排在资产库（9）上面
        sort: 8,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true
      }
    },

    {
      path: '/asset-management',
      name: 'AssetManagement',
      component: () => import('../../views/AssetManagement/index.vue'),
      meta: {
        title: 'menu.assetLib',
        isShowInTab: true,
        fixed: false,
        sort: 9,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        keepAlive: true // 启用 keep-alive 缓存
      }
    },
    {
      path: '/asset-management/dependency-graph',
      name: 'AssetDependencyGraph',
      component: () => import('../../views/AssetManagement/AssetDependencyGraph.vue'),
      meta: {
        title: 'menu.assetDependency',
        isShowInTab: true,
        fixed: false,
        sort: 9.5,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: false,
        keepAlive: false
      }
    },

    /**
     * 蓝图库 v2
     * 基于 UE 蓝图编辑器结构设计
     * 包含列表页（Gallery）和详情页（Editor），共享同一个 Tab
     */
    {
      path: '/blueprint-library',
      name: 'BlueprintLibrary',
      component: () => import('../../views/BlueprintLibrary/BlueprintLibraryLayout.vue'),
      redirect: { name: 'BlueprintGallery' },
      beforeEnter: waitForBlueprintLibrary,
      meta: {
        title: 'menu.blueprintLib',
        isShowInTab: true,
        fixed: false,
        sort: 9.5,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        keepAlive: true
      },
      children: [
        {
          path: '',
          name: 'BlueprintGallery',
          component: () => import('../../views/BlueprintLibrary/BlueprintGallery.vue'),
          meta: {
            title: 'menu.blueprintLib',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true
          }
        },
        {
          path: ':id',
          name: 'BlueprintEditor',
          component: () => import('../../views/BlueprintLibrary/BlueprintEditor.vue'),
          meta: {
            title: 'menu.blueprintDetail',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true,
            activeMenu: 'BlueprintGallery'
          }
        }
      ]
    },

    /**
     * 材质库
     * 复用蓝图库的产品骨架，承载材质预览、参数、依赖、实例关系和编译诊断。
     */
    {
      path: '/material-library',
      name: 'MaterialLibrary',
      component: () => import('../../views/MaterialLibrary/MaterialLibraryLayout.vue'),
      redirect: { name: 'MaterialGallery' },
      beforeEnter: waitForMaterialLibrary,
      meta: {
        title: 'menu.materialLib',
        isShowInTab: true,
        fixed: false,
        sort: 9.7,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        keepAlive: true
      },
      children: [
        {
          path: '',
          name: 'MaterialGallery',
          component: () => import('../../views/MaterialLibrary/MaterialGallery.vue'),
          meta: {
            title: 'menu.materialLib',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true
          }
        },
        {
          path: ':id',
          name: 'MaterialEditor',
          component: () => import('../../views/MaterialLibrary/MaterialEditor.vue'),
          meta: {
            title: 'menu.materialDetail',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true,
            activeMenu: 'MaterialGallery'
          }
        }
      ]
    },

    /**
     * 3D 模型查看器
     * 用于预览和查看 FBX, OBJ, GLB, GLTF 等 3D 模型文件
     */
    {
      path: '/model-3d-viewer',
      name: 'Model3DViewer',
      component: () => import('../../views/Model3DViewer/index.vue'),
      meta: {
        title: 'menu.modelViewer',
        isShowInTab: true,
        fixed: false,
        sort: 14,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: false,
        keepAlive: true
      }
    },

    /**
     * AI 创作
     * AI驱动的内容生成平台：图片/视频/音乐/3D
     */
    {
      path: '/aigc-studio',
      name: 'AIGCStudio',
      component: () => import('../../views/AIGCStudio/index.vue'),
      meta: {
        title: 'menu.aigcStudio',
        isShowInTab: true,
        fixed: false,
        sort: 14.7,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        keepAlive: true
      }
    },

    /**
     * 笔记编辑器
     * Markdown 笔记编辑与管理工具
     */
    {
      path: '/note-editor',
      name: 'NoteEditor',
      component: () => import('../../views/NoteEditor.vue'),
      // 资产/文件夹的「详细说明」是带着 noteId 跳过来的。编辑器本来就收
      // noteId 这个 prop，只是路由没往下传，补上即可
      props: (route) => {
        const noteId = Number(route.query.noteId)
        return Number.isFinite(noteId) && noteId > 0 ? { noteId } : {}
      },
      meta: {
        title: 'menu.notes',
        isShowInTab: true,
        fixed: false,
        sort: 14.5,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: false,
        keepAlive: true
      }
    },
    /**
     * 知识库
     * Notebook LLM 风格的知识库管理
     * 包含列表页和详情页，共享同一个 Tab
     */
    {
      path: '/notebooks',
      name: 'Notebooks',
      component: () => import('../../views/Notebook/NotebookLayout.vue'),
      redirect: { name: 'NotebookList' },

      meta: {
        title: 'menu.notebooks',
        isShowInTab: true,
        fixed: false,
        sort: 14.5,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        keepAlive: true
      },
      children: [
        {
          path: '',
          name: 'NotebookList',
          component: () => import('../../views/Notebook/NotebookList.vue'),
          /**
           * 路由守卫：在进入列表页之前检查是否需要恢复到详情页
           * 这样可以避免列表页先渲染再跳转的闪烁问题
           */
          beforeEnter: async (_to, _from, next) => {
            // 如果携带 importToken 参数（分享导入），必须停留在列表页处理导入
            if (_to.query.importToken) {
              next()
              return
            }

            // 动态导入 store 以避免循环依赖
            const { useNotebookStore } = await import('../../store/modules/notebookStore')
            const { getTabIdFromQuery } = await import('../../common/tabRoute')
            const notebookStore = useNotebookStore()
            const notebookTabId = getTabIdFromQuery(_to.query)
            const activeNotebookId = notebookStore.getActiveNotebookIdForTab(notebookTabId)

            // 如果有缓存的详情页 ID，直接重定向到详情页
            if (activeNotebookId) {
              next({
                name: 'NotebookDetail',
                params: { id: activeNotebookId },
                query: notebookTabId === 'default' ? {} : { _tab_id: notebookTabId },
                replace: true
              })
            } else {
              next()
            }
          },
          meta: {
            title: 'menu.notebooks',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true
          }
        },
        {
          path: ':id',
          name: 'NotebookDetail',
          component: () => import('../../views/Notebook/NotebookDetail.vue'),
          meta: {
            title: 'menu.notebookDetail',
            isShowInTab: false,
            fixed: false,
            isCanDelete: true,
            showMenu: true,
            showTab: true,
            isShowInMenu: false,
            keepAlive: true,
            activeMenu: 'NotebookList'
          }
        }
      ]
    },

    /**
     * 服务器管理（TODO，入口已隐藏）
     * standalone 节点统一管理页面（连接配置、Vault 管理、平台治理）。
     *
     * 目前只有客户端这一半：服务端不在本仓库，社区版没有可连的对象，
     * 所以设置里的入口先注释掉（见 ProfileAsset.vue）。路由留着，方便手动输地址调试。
     * 放出来之前要补：服务端开源、API Key 不再明文存 localStorage、这页的测试。
     */
    {
      path: '/server-management',
      name: 'ServerManagement',
      component: () => import('../../views/ServerManagement/index.vue'),
      meta: {
        title: 'menu.serverManagement',
        isShowInTab: true,
        fixed: false,
        sort: 14.9,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: false,
        keepAlive: true
      }
    },

    {
      path: '/preferences',
      name: 'Preferences',
      component: () => import('../../views/System/Preferences/index.vue'),
      meta: {
        title: 'common.preferences',
        isShowInTab: true,
        fixed: false,
        sort: 15.05,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: true,
        // 保留偏好设置内部当前页；切到其他应用 Tab 再回来时，不要重建并退回“常规”。
        keepAlive: true
      }
    },

    // 兼容旧标签/链接；外部团队现在从项目对话列表打开，不再是独立模块。
    {
      path: '/external-teams',
      name: 'ExternalTeams',
      redirect: (to) => ({ name: 'AssistantWelcome', query: to.query }),
      meta: { isShowInMenu: false, isShowInTab: false }
    },

    {
      path: '/dev-assistant',
      name: 'AssistantWelcome',
      component: () => import('../../views/Assistant/ChatEntry.vue'),
      alias: ['/dev-assistant/chat'],
      meta: {
        title: 'menu.aiAssistant',
        isShowInTab: true,
        fixed: false,
        sort: 16,
        isCanDelete: true,
        showMenu: true,
        showTab: true,
        isShowInMenu: false,
        showTopInfo: true
      }
    }
  ]
}

export default mainRoutes
