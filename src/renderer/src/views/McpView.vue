<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NDataTable, NButton, NTag, NSpace, NModal, NForm,
  NFormItem, NInput, NInputNumber, NDynamicTags,
  useMessage
} from 'naive-ui'
import type { DataTableColumns, FormInst, FormRules } from 'naive-ui'
import type { McpServerStatusDTO, McpServerConfigDTO } from '@shared/ipc'

const msg = useMessage()
const servers = ref<McpServerStatusDTO[]>([])
const loading = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const formRef = ref<FormInst | null>(null)

const newServer = ref({
  name: '',
  command: '',
  args: '',
  env: ''
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入服务器名称' }],
  command: [{ required: true, message: '请输入启动命令' }]
}

async function load(): Promise<void> {
  loading.value = true
  try {
    servers.value = await window.api.mcp.list()
  } catch (err) {
    msg.error(String(err))
  } finally {
    loading.value = false
  }
}

async function connect(): Promise<void> {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  creating.value = true
  try {
    const env = parseEnv(newServer.value.env)
    const config: McpServerConfigDTO = {
      name: newServer.value.name.trim(),
      command: newServer.value.command.trim(),
      args: newServer.value.args
        .split(/\s+/)
        .filter(Boolean)
    }
    if (Object.keys(env).length > 0) config.env = env
    servers.value = await window.api.mcp.connect(config)
    showCreate.value = false
    msg.success('MCP 服务器已连接')
    resetForm()
  } catch (err) {
    msg.error(String(err))
  } finally {
    creating.value = false
  }
}

async function disconnect(name: string): Promise<void> {
  try {
    servers.value = await window.api.mcp.disconnect(name)
    msg.success(`已断开 ${name}`)
  } catch (err) {
    msg.error(String(err))
  }
}

function resetForm(): void {
  newServer.value = { name: '', command: '', args: '', env: '' }
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (!raw.trim()) return env
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
  return env
}

const columns: DataTableColumns<McpServerStatusDTO> = [
  { title: '名称', key: 'name', width: 160 },
  {
    title: '状态',
    key: 'connected',
    width: 80,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.connected ? 'success' : 'error' },
        () => (row.connected ? '已连接' : '已断开')
      )
  },
  { title: '命令', key: 'config.command', width: 200 },
  {
    title: '参数',
    key: 'config.args',
    width: 180,
    render: (row) =>
      h(
        NSpace,
        { size: 'tiny' },
        () => (row.config.args?.length
          ? row.config.args.map((a) => h(NTag, { size: 'tiny' }, () => a))
          : [h('span', { style: { opacity: 0.5 } }, '—')]
        )
      )
  },
  {
    title: '工具数',
    key: 'toolCount',
    width: 80,
    render: (row) => (row.connected ? String(row.toolCount) : '—')
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', type: 'error', onClick: () => disconnect(row.name) },
        () => '断开'
      )
  }
]

onMounted(load)
</script>

<template>
  <div class="mcp">
    <NSpace justify="space-between" align="center" style="margin-bottom: 12px">
      <h2 style="margin: 0">MCP 服务器</h2>
      <NSpace>
        <NButton :loading="loading" @click="load">刷新</NButton>
        <NButton type="primary" @click="showCreate = true">添加服务器</NButton>
      </NSpace>
    </NSpace>

    <p class="hint">
      MCP (Model Context Protocol) 服务器通过 stdio 协议提供额外的工具能力。连接后，服务器提供的工具将自动加入对话的可用工具列表，工具集标记为 <code>mcp</code>。
    </p>

    <NDataTable
      :columns="columns"
      :data="servers"
      :bordered="false"
      size="small"
    />

    <div v-if="servers.length === 0 && !loading" class="empty">
      暂无 MCP 服务器连接。点击"添加服务器"通过 stdio 连接一个。
    </div>

    <!-- Create modal -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      title="添加 MCP 服务器"
      style="width: 520px; max-width: 94vw"
      :mask-closable="false"
      @update:show="(v) => { if (!v) resetForm() }"
    >
      <NForm ref="formRef" :model="newServer" :rules="rules">
        <NFormItem label="名称" path="name">
          <NInput v-model:value="newServer.name" placeholder="例如：filesystem" />
        </NFormItem>
        <NFormItem label="命令" path="command">
          <NInput v-model:value="newServer.command" placeholder="例如：npx -y @modelcontextprotocol/server-filesystem" />
        </NFormItem>
        <NFormItem label="参数">
          <NInput v-model:value="newServer.args" placeholder="空格分隔，例如：/path/to/allowed/dir" />
        </NFormItem>
        <NFormItem label="环境变量">
          <NInput
            v-model:value="newServer.env"
            type="textarea"
            placeholder="每行一个 KEY=value，可选"
            :autosize="{ minRows: 2, maxRows: 6 }"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="connect">
            连接
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.mcp {
  padding: 20px;
  height: 100vh;
  overflow-y: auto;
}
.hint {
  opacity: 0.6;
  font-size: 13px;
  margin-bottom: 12px;
  line-height: 1.6;
}
.hint :deep(code) {
  background: rgba(255,255,255,0.08);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.empty {
  text-align: center;
  padding: 40px;
  opacity: 0.5;
}
</style>
