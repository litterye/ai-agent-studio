<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NLayout,
  NLayoutSider,
  NMenu,
  NSelect,
  NButton,
  NScrollbar,
  darkTheme,
  type MenuOption,
  type GlobalThemeOverrides
} from 'naive-ui'
import { computed } from 'vue'
import { useSettingsStore } from './stores/settings'
import { useAgentStore } from './stores/agents'
import { useSessionStore } from './stores/sessions'
import { useConversationStore } from './stores/conversation'
import { useModelStore } from './stores/models'
import AgentDialog from './components/AgentDialog.vue'

const router = useRouter()
const route = useRoute()
const settings = useSettingsStore()
const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const convo = useConversationStore()
const modelStore = useModelStore()

// Theme derived from app settings
const currentTheme = computed(() => {
  if (settings.appSettings.theme === 'dark') return darkTheme
  return null // light and eye-care both use light base
})

const themeOverrides = computed<GlobalThemeOverrides | undefined>(() => {
  if (settings.appSettings.theme === 'eye-care') {
    return {
      common: {
        bodyColor: '#f5f0e8',
        baseColor: '#faf5ec',
        cardColor: '#fffaf2',
        textColor1: '#3e3232',
        textColor2: '#5c4e4e',
        primaryColor: '#8b6914',
        primaryColorHover: '#a67c1e',
        primaryColorSuppl: '#8b6914'
      }
    }
  }
  return undefined
})

const showAgentDialog = ref(false)
const editingAgentId = ref<string | null>(null)

const menuOptions: MenuOption[] = [
  { label: '对话', key: 'chat' },
  { label: '技能', key: 'skills' },
  { label: '定时任务', key: 'cron' },
  { label: '内置工具', key: 'tools' },
  { label: 'MCP', key: 'mcp' },
  { label: '设置', key: 'settings' }
]

const activeKey = computed(() => route.name as string)

function handleMenu(key: string): void {
  void router.push({ name: key })
}

async function selectAgent(id: string): Promise<void> {
  agentStore.select(id)
  // Persist last active agent
  settings.setAppSettings({ lastAgentId: id }).catch(() => {})
  await sessionStore.load(id)
  // Auto-select first session or create one
  if (sessionStore.sessions.length > 0) {
    const first = sessionStore.sessions[0]
    await selectSession(first.id)
  } else {
    const s = await sessionStore.create({
      agentId: id,
      model: agentStore.activeAgent?.defaultModel ?? modelStore.defaultModelId,
      protocol: agentStore.activeAgent?.defaultProtocol ?? modelStore.defaultProtocol,
      baseUrl: modelStore.getByModelId(agentStore.activeAgent?.defaultModel ?? modelStore.defaultModelId)?.baseUrl || ''
    })
    await selectSession(s.id)
  }
}

async function selectSession(id: string): Promise<void> {
  sessionStore.select(id)
  // Persist last active session
  settings.setAppSettings({ lastSessionId: id }).catch(() => {})
  await convo.loadSession(id)
  void router.push({ name: 'chat' })
}

async function newSession(): Promise<void> {
  if (!agentStore.activeAgentId) return
  const agent = agentStore.activeAgent
  const modelId = agent?.defaultModel ?? modelStore.defaultModelId
  const s = await sessionStore.create({
    agentId: agentStore.activeAgentId,
    model: modelId,
    protocol: agent?.defaultProtocol ?? modelStore.defaultProtocol,
    baseUrl: modelStore.getByModelId(modelId)?.baseUrl || ''
  })
  await selectSession(s.id)
}

async function openNewAgent(): Promise<void> {
  editingAgentId.value = null
  showAgentDialog.value = true
}

async function openEditAgent(): Promise<void> {
  editingAgentId.value = agentStore.activeAgentId
  showAgentDialog.value = true
}

async function onAgentSaved(agentId: string): Promise<void> {
  showAgentDialog.value = false
  await agentStore.load()
  await selectAgent(agentId)
}

onMounted(async () => {
  await settings.load()
  await modelStore.load()
  await agentStore.load()
  if (agentStore.agents.length === 0) {
    // Will trigger auto-create via getDefault in main process, then reload
    await agentStore.load()
  }

  // Restore last active agent/session from persisted settings
  const lastAgentId = settings.appSettings.lastAgentId
  const lastSessionId = settings.appSettings.lastSessionId

  // Check that saved IDs still exist
  const agentExists = lastAgentId && agentStore.agents.some(a => a.id === lastAgentId)
  let sessionExists = false
  if (agentExists && lastSessionId) {
    await sessionStore.load(lastAgentId!)
    sessionExists = sessionStore.sessions.some(s => s.id === lastSessionId)
  }

  if (agentExists) {
    if (sessionExists) {
      await selectAgent(lastAgentId!)
      // selectAgent already calls selectSession for the first session — override with the saved one
      if (lastSessionId !== sessionStore.activeSessionId) {
        await selectSession(lastSessionId!)
      }
    } else {
      await selectAgent(lastAgentId!)
    }
  } else if (agentStore.agents.length > 0) {
    await selectAgent(agentStore.agents[0].id)
  }
})

// When active route is chat, ensure a session is selected
watch(activeKey, (key) => {
  if (key === 'chat' && !sessionStore.activeSessionId && agentStore.activeAgentId) {
    void selectAgent(agentStore.activeAgentId)
  }
})
</script>

<template>
  <NConfigProvider :theme="currentTheme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <NLayout has-sider style="height: 100vh">
          <NLayoutSider
            bordered
            :width="220"
            content-style="padding: 8px; display:flex; flex-direction:column; height:100vh;"
          >
            <div class="brand">AI Agent Studio</div>

            <!-- Agent selector -->
            <div class="sider-section">
              <div class="sider-label">智能体</div>
              <div class="agent-row">
                <NSelect
                  v-if="agentStore.agents.length > 0"
                  :value="agentStore.activeAgentId"
                  :options="agentStore.agents.map(a => ({ label: a.name, value: a.id }))"
                  size="small"
                  @update:value="(v) => selectAgent(v)"
                />
                <NButton size="tiny" @click="openNewAgent" title="新建智能体">
                  +
                </NButton>
                <NButton
                  v-if="agentStore.activeAgentId"
                  size="tiny"
                  @click="openEditAgent"
                  title="编辑智能体"
                >
                  ⚙
                </NButton>
              </div>
            </div>

            <!-- Session list -->
            <div class="sider-section sessions">
              <div class="sider-label">
                会话
                <NButton
                  v-if="agentStore.activeAgentId"
                  size="tiny"
                  text
                  @click="newSession"
                  style="float:right; font-size:14px; padding:0 4px;"
                >
                  + 新建
                </NButton>
              </div>
              <NScrollbar style="max-height: 240px">
                <div
                  v-for="s in sessionStore.sessions"
                  :key="s.id"
                  class="session-item"
                  :class="{ active: s.id === sessionStore.activeSessionId }"
                  @click="selectSession(s.id)"
                >
                  <span class="session-title">{{ s.title }}</span>
                  <span class="session-model">{{ s.model }}</span>
                </div>
                <div
                  v-if="sessionStore.sessions.length === 0"
                  class="session-empty"
                >
                  暂无会话
                </div>
              </NScrollbar>
            </div>

            <div class="sider-divider"></div>

            <!-- Nav menu -->
            <NMenu
              :value="activeKey"
              :options="menuOptions"
              @update:value="handleMenu"
            />
          </NLayoutSider>
          <NLayout content-style="height:100vh; overflow:hidden;">
            <RouterView />
          </NLayout>
        </NLayout>

        <!-- Agent create/edit dialog -->
        <AgentDialog
          v-if="showAgentDialog"
          :agent-id="editingAgentId"
          @saved="(id) => onAgentSaved(id)"
          @cancel="showAgentDialog = false"
        />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
* {
  box-sizing: border-box;
}
html,
body,
#app {
  margin: 0;
  height: 100%;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* ── Unified scrollbar (Chromium-native, no deps) ──────────────────────── */
::-webkit-scrollbar {
  width:  6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.25);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.50);
}
::-webkit-scrollbar-corner {
  background: transparent;
}
.brand {
  font-weight: 700;
  font-size: 15px;
  padding: 4px 8px 8px;
  opacity: 0.9;
  flex-shrink: 0;
}
.sider-section {
  margin-bottom: 8px;
  flex-shrink: 0;
}
.sider-section.sessions {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sider-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  opacity: 0.5;
  padding: 4px 4px 2px;
  margin-bottom: 2px;
}
.agent-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.agent-row :deep(.n-base-selection) {
  flex: 1;
  min-width: 0;
}
.session-item {
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transition: background 0.1s;
}
.session-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.session-item.active {
  background: rgba(42, 108, 240, 0.2);
}
.session-title {
  font-size: 13px;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-model {
  font-size: 10px;
  opacity: 0.45;
}
.session-empty {
  font-size: 12px;
  opacity: 0.4;
  padding: 6px 8px;
  text-align: center;
}
.sider-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 4px 0 8px;
  flex-shrink: 0;
}
</style>
