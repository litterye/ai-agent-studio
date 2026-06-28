import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from '../views/ChatView.vue'
import ToolsView from '../views/ToolsView.vue'
import SettingsView from '../views/SettingsView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', name: 'chat', component: ChatView },
    { path: '/workspace', name: 'workspace', component: () => import('../views/WorkspaceView.vue') },
    { path: '/tools', name: 'tools', component: ToolsView },
    { path: '/skills', name: 'skills', component: () => import('../views/SkillsView.vue') },
    { path: '/cron', name: 'cron', component: () => import('../views/CronView.vue') },
    { path: '/mcp', name: 'mcp', component: () => import('../views/McpView.vue') },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
