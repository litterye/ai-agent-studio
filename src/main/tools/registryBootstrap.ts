import { toolRegistry } from './registry'
import { createReadFileTool } from './builtin/readFile'
import { createWriteFileTool } from './builtin/writeFile'
import { createPatchFileTool } from './builtin/patchFile'
import { createSearchFilesTool } from './builtin/searchFiles'
import { createListDirectoryTool } from './builtin/listDirectory'
import { createTerminalTool } from './builtin/terminal'
import { createSkillViewTool, createSkillManageTool } from '../skills/tools'
import { createWebFetchTool } from './builtin/webFetch'
import { createWebSearchTool } from './builtin/webSearch'
import { createBrowserNavigateTool } from './browser/navigate'
import { createBrowserSnapshotTool } from './browser/snapshot'
import { createBrowserClickTool } from './browser/click'
import { createBrowserTypeTool } from './browser/type'
import { createBrowserScrollTool } from './browser/scroll'
import { createBrowserPressTool } from './browser/press'
import { createBrowserBackTool } from './browser/back'
import { createBrowserConsoleTool } from './browser/console'
import { createBrowserGetImagesTool } from './browser/getImages'
import { createBrowserVisionTool } from './browser/vision'
import { createTodoTool } from './builtin/todo'
import { createDelegateTaskTool } from './builtin/delegateTask'
import { createExecuteCodeTool } from './builtin/executeCode'
import { createOcrImageTool } from './builtin/ocrImage'
import { createCronManageTool } from './builtin/cronManage'

/**
 * Register all builtin tools with the registry. Importing this module is
 * the equivalent of Hermes's `discover_builtin_tools()` glob+AST step.
 *
 * Idempotent: each `register()` call is a no-op if the tool is already
 * registered in the same toolset.
 */
export function registerBuiltinTools(): void {
  toolRegistry.register(createReadFileTool())
  toolRegistry.register(createWriteFileTool())
  toolRegistry.register(createPatchFileTool())
  toolRegistry.register(createSearchFilesTool())
  toolRegistry.register(createListDirectoryTool())
  toolRegistry.register(createTerminalTool())
  toolRegistry.register(createSkillViewTool())
  toolRegistry.register(createSkillManageTool())
  toolRegistry.register(createWebFetchTool())
  toolRegistry.register(createWebSearchTool())
  toolRegistry.register(createBrowserNavigateTool())
  toolRegistry.register(createBrowserSnapshotTool())
  toolRegistry.register(createBrowserClickTool())
  toolRegistry.register(createBrowserTypeTool())
  toolRegistry.register(createBrowserScrollTool())
  toolRegistry.register(createBrowserPressTool())
  toolRegistry.register(createBrowserBackTool())
  toolRegistry.register(createBrowserConsoleTool())
  toolRegistry.register(createBrowserGetImagesTool())
  toolRegistry.register(createBrowserVisionTool())
  toolRegistry.register(createTodoTool())
  toolRegistry.register(createDelegateTaskTool())
  toolRegistry.register(createExecuteCodeTool())
  toolRegistry.register(createOcrImageTool())
  toolRegistry.register(createCronManageTool())
}

registerBuiltinTools()