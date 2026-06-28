<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import type { DisplayMessage } from '../stores/conversation'
import type { AttachmentMeta } from '@shared/ipc'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ message: DisplayMessage }>()

const md = new MarkdownIt({
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value
      } catch {
        /* fall through */
      }
    }
    return ''
  }
})

const rendered = computed(() => md.render(props.message.text || ''))
const isUser = computed(() => props.message.role === 'user')

const imageAtts = computed(() => props.message.attachments.filter(a => a.mimeType.startsWith('image/')))
const otherAtts = computed(() => props.message.attachments.filter(a => !a.mimeType.startsWith('image/')))

// Load image data URLs lazily (Electron renderer can't use file:// protocol)
const imageDataUrls = ref<Record<string, string>>({})

const hovered = ref(false)

onMounted(async () => {
  for (const a of imageAtts.value) {
    try {
      const url = await window.api.files.readAsDataUrl(a.path)
      if (url) imageDataUrls.value[a.path] = url
    } catch { /* ignore */ }
  }
})

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  return `${(n / 1000).toFixed(1)}k`
}

async function openFile(path: string): Promise<void> {
  await window.api.shell.openPath(path)
}

async function copyText(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.text)
  } catch { /* clipboard API may not be available */ }
}
</script>

<template>
  <div
    class="bubble-row"
    :class="{ user: isUser }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <div class="bubble" :class="{ user: isUser }">
      <!-- Copy button: absolute, never affects bubble size -->
      <button
        v-if="message.text && hovered"
        class="copy-btn"
        title="复制"
        @click="copyText"
      >
        📋
      </button>

      <!-- Attachments (user messages only) -->
      <div v-if="isUser && message.attachments.length > 0" class="attachments">
        <div v-for="a in imageAtts" :key="a.path" class="att-thumb" title="点击打开" @click="openFile(a.path)">
          <img v-if="imageDataUrls[a.path]" :src="imageDataUrls[a.path]" />
          <span v-else class="att-loading">加载中…</span>
          <span class="att-name">{{ a.name }}</span>
        </div>
        <div v-for="a in otherAtts" :key="a.path" class="att-file" title="点击打开" @click="openFile(a.path)">
          <span class="att-icon">📄</span>
          <span class="att-name">{{ a.name }}</span>
          <span class="att-size">{{ fmtSize(a.size) }}</span>
        </div>
      </div>

      <div v-if="message.thinking" class="thinking">
        <details>
          <summary>思考过程</summary>
          <pre>{{ message.thinking }}</pre>
        </details>
      </div>

      <ToolCallCard
        v-for="tc in message.toolCalls"
        :key="tc.id"
        :tool-call="tc"
      />

      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="message.text" class="md" v-html="rendered"></div>
      <div v-else-if="message.streaming && !message.toolCalls.length" class="dots">
        ●●●
      </div>

      <!-- Token usage (assistant messages only) -->
      <div v-if="!isUser && message.usage" class="usage-info">
        <span v-if="message.usage.inputTokens > 0">输入 {{ fmtTokens(message.usage.inputTokens) }}</span>
        <span v-if="message.usage.inputTokens > 0 && message.usage.outputTokens > 0"> · </span>
        <span v-if="message.usage.outputTokens > 0">输出 {{ fmtTokens(message.usage.outputTokens) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bubble-row {
  display: flex;
  margin: 10px 0;
}
.bubble-row.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  line-height: 1.55;
  word-break: break-word;
  position: relative;
}
.bubble.user {
  background: #2a6cf0;
  color: #fff;
}
.copy-btn {
  position: absolute;
  bottom: 0;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  line-height: 1;
  opacity: 0.7;
  transition: opacity 0.15s;
  color: inherit;
  z-index: 1;
}
/* Assistant: button on the right outside edge (no layout shift — absolute + translateX) */
.bubble:not(.user) .copy-btn {
  left: 100%;
  transform: translateX(4px);
}
/* User: button on the left outside edge */
.bubble.user .copy-btn {
  right: 100%;
  transform: translateX(-4px);
}
.copy-btn:hover { opacity: 1; }
.usage-info {
  margin-top: 8px;
  font-size: 11px;
  opacity: 0.45;
  border-top: 1px solid rgba(255,255,255,0.06);
  padding-top: 6px;
}
.thinking {
  font-size: 12px;
  opacity: 0.7;
  margin-bottom: 6px;
}
.thinking pre {
  white-space: pre-wrap;
}
.md :deep(pre) {
  background: #0d1117;
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
}
.md :deep(code) {
  font-family: 'Cascadia Code', Consolas, monospace;
}
.dots {
  letter-spacing: 3px;
  opacity: 0.5;
  animation: blink 1.2s infinite;
}
@keyframes blink {
  50% {
    opacity: 0.2;
  }
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.att-thumb {
  cursor: pointer;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.12);
  position: relative;
  max-width: 180px;
}
.att-thumb img {
  display: block;
  max-height: 140px;
  max-width: 100%;
  object-fit: cover;
}
.att-thumb .att-name {
  display: block;
  font-size: 10px;
  padding: 2px 6px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80px;
  min-width: 120px;
  font-size: 11px;
  opacity: 0.4;
}
.att-file {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  font-size: 12px;
  max-width: 260px;
}
.att-file:hover { background: rgba(255,255,255,0.1); }
.att-file .att-icon { font-size: 16px; flex-shrink: 0; }
.att-file .att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.att-file .att-size {
  opacity: 0.5;
  font-size: 11px;
  flex-shrink: 0;
}
</style>
