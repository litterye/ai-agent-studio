<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { NInput, NButton, NModal, NSelect, NSpace, useMessage } from 'naive-ui'
import { useConversationStore } from '../stores/conversation'
import { useSessionStore } from '../stores/sessions'
import { useModelStore } from '../stores/models'
import MessageBubble from '../components/MessageBubble.vue'
import ApprovalDialog from '../components/ApprovalDialog.vue'
import ModelDialog from '../components/ModelDialog.vue'
import SaveSkillDialog from '../components/SaveSkillDialog.vue'
import type { ToolConfirmRequest, AttachmentMeta } from '@shared/ipc'

const convo = useConversationStore()
const sessionStore = useSessionStore()
const modelStore = useModelStore()
const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const chatEl = ref<HTMLElement | null>(null)
const msg = useMessage()
let unsubConfirm: (() => void) | null = null

const pendingConfirm = ref<ToolConfirmRequest | null>(null)

const editingTitle = ref(false)
const titleDraft = ref('')

const sessionTitle = computed(() => sessionStore.activeSession?.title ?? '（无会话）')
const sessionModelId = computed(() => sessionStore.activeSession?.model ?? '')

// Whether any models have been configured in settings
const hasModels = computed(() => modelStore.items.length > 0)

// Derive model options from the models store
const modelOptions = computed(() => modelStore.options)

const showModelDialog = ref(false)
const showSaveSkillDialog = ref(false)

// Attachments
const attachments = ref<AttachmentMeta[]>([])
const dragOver = ref(false)
const MAX_ATTACHMENTS = 9
const MAX_FILE_BYTES = 200 * 1024 * 1024 // 200 MB

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.xml': 'application/xml', '.csv': 'text/csv', '.log': 'text/plain',
    '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.js': 'text/javascript', '.ts': 'text/typescript',
    '.py': 'text/x-python', '.go': 'text/x-go',
    '.html': 'text/html', '.css': 'text/css',
  }
  return map[ext] ?? 'application/octet-stream'
}

async function pickFiles(): Promise<void> {
  const files = await window.api.dialog.openFiles()
  if (!files || files.length === 0) return
  addFileAttachments(files)
}

function addFileAttachments(files: AttachmentMeta[]): void {
  const available = MAX_ATTACHMENTS - attachments.value.length
  if (available <= 0) {
    msg.error(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
    return
  }
  if (files.length > available) {
    msg.warning(`最多还能添加 ${available} 个附件，将只添加前 ${available} 个`)
  }
  const toAdd = files.slice(0, available)
  const fresh: AttachmentMeta[] = []
  for (const f of toAdd) {
    if (f.size > MAX_FILE_BYTES) {
      msg.error(`文件 "${f.name}" 大小为 ${fmtSize(f.size)}，超过单文件上限 ${fmtSize(MAX_FILE_BYTES)}`)
      continue
    }
    if (attachments.value.some(a => a.path === f.path)) continue
    fresh.push(f)
  }
  if (fresh.length > 0) attachments.value = [...attachments.value, ...fresh]
}

// ── Paste: clipboard images & files ──────────────────────────────────

function onComposerPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items || items.length === 0) return

  // Collect: files with valid paths + blobs without paths
  const pathFiles: AttachmentMeta[] = []
  const orphanBlobs: { blob: File; name: string }[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const blob = item.getAsFile()
    if (!blob) continue
    const diskPath = (blob as any).path as string | undefined
    if (diskPath) {
      if (blob.size > MAX_FILE_BYTES) {
        msg.error(`文件 "${blob.name}" 大小 ${fmtSize(blob.size)} 超过上限 ${fmtSize(MAX_FILE_BYTES)}`)
        continue
      }
      pathFiles.push({
        name: blob.name,
        path: diskPath,
        mimeType: blob.type || mimeFromName(blob.name),
        size: blob.size
      })
    } else {
      // No disk path — save to workspace via FileSaveClipboard (supports all file types)
      if (blob.size > MAX_FILE_BYTES) {
        msg.error(`文件 "${blob.name}" 大小 ${fmtSize(blob.size)} 超过上限 ${fmtSize(MAX_FILE_BYTES)}`)
        continue
      }
      orphanBlobs.push({ blob, name: blob.name })
    }
  }

  if (pathFiles.length === 0 && orphanBlobs.length === 0) return

  e.preventDefault()

  // Also insert any plain text into the draft
  const plainText = e.clipboardData?.getData('text/plain')
  if (plainText) draft.value += plainText

  // Add files that already have disk paths immediately
  if (pathFiles.length > 0) addFileAttachments(pathFiles)

  // Save blobs without paths to workspace disk — use Promise.all for batch appearance
  if (orphanBlobs.length > 0) {
    saveBlobAttachments(orphanBlobs)
  }
}

/** Read blobs as data URLs, save to workspace, and add to attachments in one batch. */
async function saveBlobAttachments(blobs: { blob: File; name: string }[]): Promise<void> {
  const available = MAX_ATTACHMENTS - attachments.value.length
  if (available <= 0) {
    msg.error(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
    return
  }
  const toProcess = blobs.slice(0, available)

  // Read all blobs → data URLs in parallel
  const dataUrls = await Promise.all(
    toProcess.map(
      (b) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => resolve('')
          reader.readAsDataURL(b.blob)
        })
    )
  )

  // Save all to disk in parallel
  const metas = await Promise.all(
    dataUrls.filter(Boolean).map((url) => window.api.files.saveClipboard(url))
  )

  const fresh = metas.filter((m): m is AttachmentMeta => m !== null)
  if (fresh.length > 0) {
    attachments.value = [...attachments.value, ...fresh]
  }
  if (fresh.length < toProcess.length) {
    const failed = toProcess.length - fresh.length
    if (failed > 0) msg.error(`${failed} 个文件保存失败`)
  }
}

// ── Drag & drop ──────────────────────────────────────────────────────

function onComposerDragOver(e: DragEvent): void {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragOver.value = true
}

function onComposerDragLeave(): void {
  dragOver.value = false
}

function onComposerDrop(e: DragEvent): void {
  e.preventDefault()
  dragOver.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  const pathMetas: AttachmentMeta[] = []
  const blobFiles: { blob: File; name: string }[] = []
  const seen = new Set(attachments.value.map(a => a.path))

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const diskPath = (f as any).path as string | undefined

    if (diskPath) {
      // File dropped from local filesystem (Explorer/Finder)
      if (seen.has(diskPath)) continue
      if (f.size > MAX_FILE_BYTES) {
        msg.error(`文件 "${f.name}" 大小 ${fmtSize(f.size)} 超过上限 ${fmtSize(MAX_FILE_BYTES)}`)
        continue
      }
      seen.add(diskPath)
      pathMetas.push({
        name: f.name,
        path: diskPath,
        mimeType: f.type || mimeFromName(f.name),
        size: f.size
      })
    } else {
      // Dropped from browser — no disk path, save all file types to workspace
      if (f.size > MAX_FILE_BYTES) {
        msg.error(`文件 "${f.name}" 大小 ${fmtSize(f.size)} 超过上限 ${fmtSize(MAX_FILE_BYTES)}`)
        continue
      }
      blobFiles.push({ blob: f, name: f.name })
    }
  }

  if (pathMetas.length > 0) addFileAttachments(pathMetas)
  if (blobFiles.length > 0) saveBlobAttachments(blobFiles)
}

function removeAttachment(index: number): void {
  attachments.value = attachments.value.filter((_, i) => i !== index)
}

function clearAttachments(): void {
  attachments.value = []
}

function startEditTitle(): void {
  titleDraft.value = sessionTitle.value
  editingTitle.value = true
}

async function commitTitle(): Promise<void> {
  editingTitle.value = false
  const t = titleDraft.value.trim()
  if (t && t !== sessionTitle.value && sessionStore.activeSessionId) {
    await sessionStore.update(sessionStore.activeSessionId, { title: t })
  }
}

async function changeModel(modelId: string): Promise<void> {
  if (sessionStore.activeSessionId) {
    const m = modelStore.getByModelId(modelId)
    await sessionStore.update(sessionStore.activeSessionId, {
      model: modelId,
      protocol: m?.protocol,
      baseUrl: (m?.baseUrl || '')
    })
  }
}

async function onModelSaved(): Promise<void> {
  showModelDialog.value = false
  await modelStore.load()
  // Select the first model for the current session
  if (modelStore.items.length > 0 && sessionStore.activeSessionId) {
    const m = modelStore.items[0]
    await sessionStore.update(sessionStore.activeSessionId, {
      model: m.modelId,
      protocol: m.protocol,
      baseUrl: m.baseUrl || ''
    })
  }
}

function submit(): void {
  if (convo.running) return
  if (!draft.value.trim() && attachments.value.length === 0) return
  convo.send(draft.value, attachments.value)
  draft.value = ''
  clearAttachments()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

function handleConfirm(req: ToolConfirmRequest): void {
  pendingConfirm.value = req
}

function respond(res: { approved: boolean; sessionAlways: boolean }): void {
  const req = pendingConfirm.value
  pendingConfirm.value = null
  if (!req) return
  window.api.tools.respondConfirm({
    confirmId: req.confirmId,
    approved: res.approved,
    sessionAlways: res.sessionAlways,
    toolName: req.toolName
  })
}

function openSaveSkill(): void {
  if (convo.running || convo.messages.length === 0) return
  showSaveSkillDialog.value = true
}

async function doSaveSkill(payload: { name: string; description: string }): Promise<void> {
  showSaveSkillDialog.value = false
  const sessionMsgs = convo.messages
    .map((m) => ({
      role: m.role,
      text: m.text,
      toolErrors: m.toolCalls.some((tc) => tc.status === 'error')
    }))
  try {
    const draft = await window.api.skills.offerFromSession({ messages: sessionMsgs })
    if (!draft) {
      msg.info('当前对话尚不满足生成技能的条件（需多轮对话且无工具错误）。')
      return
    }
    // Override name and description with user input
    await window.api.skills.pendingUpdateMeta({
      id: (draft as any).id,
      name: payload.name,
      description: payload.description
    })
    msg.success('技能草稿已保存至待审核列表，前往「技能」页面审核。')
  } catch (err) {
    msg.error(String(err))
  }
}

watch(
  () => convo.messages.map((m) => m.text + m.toolCalls.length).join(),
  () => scrollToBottom()
)

function scrollToBottom(): void {
  void nextTick(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
  })
}

onMounted(async () => {
  await modelStore.load()
  unsubConfirm = window.api.tools.onConfirmRequest(handleConfirm)
  scrollToBottom()
})
onUnmounted(() => unsubConfirm?.())
</script>

<template>
  <div ref="chatEl" class="chat">
    <!-- Session header -->
    <div class="session-header">
      <NSpace align="center" :wrap="false">
        <span
          v-if="!editingTitle"
          class="session-title-display"
          @click="startEditTitle"
          title="点击编辑标题"
        >
          {{ sessionTitle }}
        </span>
        <NInput
          v-else
          v-model:value="titleDraft"
          size="small"
          style="width: 200px"
          @blur="commitTitle"
          @keydown.enter="commitTitle"
        />
        <template v-if="hasModels">
          <NSelect
            :value="sessionModelId"
            :options="modelOptions"
            size="small"
            style="width: 200px"
            @update:value="(v) => changeModel(v)"
          />
        </template>
        <NButton v-else size="small" type="primary" @click="showModelDialog = true">
          添加模型
        </NButton>
      </NSpace>
    </div>

    <div ref="scrollEl" class="messages">
      <div v-if="!convo.messages.length" class="empty">
        开始一段对话。模型可调用内置工具与已连接的 MCP 工具。
      </div>
      <MessageBubble v-for="m in convo.messages" :key="m.id" :message="m" />
    </div>
    <div
      class="composer"
      :class="{ 'drag-over': dragOver }"
      @paste="onComposerPaste"
      @dragover="onComposerDragOver"
      @dragleave="onComposerDragLeave"
      @drop="onComposerDrop"
    >
      <!-- Attach button + attachment chips on the left above the input -->
      <div class="att-area">
        <NButton size="tiny" class="att-btn" @click="pickFiles" title="添加附件（最多9个，单个≤200MB）">
          📎 {{ attachments.length > 0 ? `(${attachments.length}/${MAX_ATTACHMENTS})` : '' }}
        </NButton>
        <div v-if="attachments.length > 0" class="att-chips">
          <div v-for="(a, i) in attachments" :key="a.path" class="att-chip">
            <span class="att-chip-icon">{{ a.mimeType.startsWith('image/') ? '🖼' : '📄' }}</span>
            <span class="att-chip-name" :title="a.path">{{ a.name }}</span>
            <span class="att-chip-size">{{ fmtSize(a.size) }}</span>
            <span class="att-chip-remove" @click="removeAttachment(i)">✕</span>
          </div>
        </div>
      </div>

      <div class="composer-row">
        <NInput
          v-model:value="draft"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 6 }"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          @keydown="onKey"
        />
        <div class="actions">
          <NButton
            v-if="convo.running"
            tertiary
            @click="convo.cancel"
          >
            停止
          </NButton>
          <template v-else>
            <NButton
              v-if="convo.messages.length >= 4"
              size="tiny"
              tertiary
              @click="openSaveSkill"
            >
              保存为技能
            </NButton>
            <NButton
              type="primary"
              :disabled="!draft.trim() && attachments.length === 0"
              @click="submit"
            >
              发送
            </NButton>
          </template>
        </div>
      </div>
    </div>

    <NModal
      :show="pendingConfirm !== null"
      :to="chatEl"
      preset="card"
      :bordered="false"
      :mask-closable="false"
      :closable="false"
      :style="{ background: 'transparent', boxShadow: 'none', padding: 0 }"
      transform-origin="center"
      @update:show="(v) => { if (!v) respond({ approved: false, sessionAlways: false }) }"
    >
      <ApprovalDialog
        v-if="pendingConfirm"
        :tool-name="pendingConfirm.toolName"
        :input="pendingConfirm.input"
        :reason="pendingConfirm.reason ?? null"
        @respond="respond"
      />
    </NModal>

    <!-- Model add/edit dialog -->
    <ModelDialog
      v-if="showModelDialog"
      :model-id="null"
      @saved="onModelSaved"
      @cancel="showModelDialog = false"
    />

    <!-- Save skill dialog -->
    <SaveSkillDialog
      v-if="showSaveSkillDialog"
      @save="doSaveSkill"
      @cancel="showSaveSkillDialog = false"
    />
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.session-header {
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}
.session-title-display {
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-title-display:hover {
  opacity: 0.7;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.empty {
  opacity: 0.5;
  text-align: center;
  margin-top: 80px;
}
.composer {
  padding: 12px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.composer.drag-over {
  background: rgba(42, 108, 240, 0.06);
  outline: 2px dashed rgba(42, 108, 240, 0.35);
  outline-offset: -6px;
  border-radius: 8px;
}
.composer-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.att-area {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}
.att-btn {
  flex-shrink: 0;
}
.att-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.att-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 12px;
  max-width: 240px;
}
.att-chip-icon { flex-shrink: 0; font-size: 14px; }
.att-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.att-chip-size { opacity: 0.45; flex-shrink: 0; font-size: 11px; }
.att-chip-remove {
  cursor: pointer;
  opacity: 0.5;
  font-size: 14px;
  padding: 0 2px;
  flex-shrink: 0;
}
.att-chip-remove:hover { opacity: 1; color: #e88080; }
.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
