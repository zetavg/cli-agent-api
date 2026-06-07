export { chatCompletionsHandler } from './apis/chat-completions.js';
export type { ApiHandler } from './apis/types.js';
export type { ToolMode } from './config.js';
export { parseToolMode, resolveServeConfig } from './config.js';
export {
  ensureAgentWorkspaceDir,
  ensureServeConfigDirectories,
  resolveAgentWorkspaceDir,
  resolveDataDir,
  resolveXdgDataHome,
} from './config.js';
export { FileSystemKvStore } from './file-system-kv-store.js';
export type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
  ConversationMessage,
  LatestTurn,
} from './messages.js';
export {
  extractConversationHistory,
  extractLatestTurn,
  extractSystemPrompt,
  toNativeProviderHistory,
} from './messages.js';
export type {
  AgentProvider,
  ProviderChatCompletionInput,
  ProviderChatCompletionRun,
} from './providers.js';
export {
  buildClaudeArgs,
  claimClaudeResumeSession,
  CLAUDE_SESSION_MAPPING_STORE_ID,
  CLAUDE_SESSION_MAPPING_STORE_VERSION,
  ClaudeProvider,
  createClaudeResumeSession,
  createClaudeSessionHistoryHash,
  DEFAULT_CLAUDE_TOOLS,
  encodeClaudeProjectPath,
  ensureClaudeWorkingDirectory,
  normalizeClaudeResumeHistory,
  normalizeClaudeUsage,
  parseClaudeLine,
  parseClaudeSessionHistory,
  prepareClaudeResumeSession,
  resolveClaudeCommand,
  resolveClaudeProjectsDirectory,
  resolveClaudeSessionFilePath,
  resolveClaudeWorkingDirectory,
  seedClaudeResumeSession,
  updateClaudeSessionMapping,
} from './providers/claude.js';
export {
  buildCursorArgs,
  createCursorSessionHistoryHash,
  CURSOR_REASONING_FORMAT,
  CURSOR_SESSION_MAPPING_STORE_ID,
  CURSOR_SESSION_MAPPING_STORE_VERSION,
  CursorProvider,
  ensureCursorWorkingDirectory,
  extractCursorToolName,
  flattenCursorHistory,
  normalizeCursorResumeHistory,
  normalizeCursorUsage,
  parseCursorLine,
  prepareCursorResumeSession,
  resolveCursorCommand,
  resolveCursorWorkingDirectory,
  streamCursorChatCompletion,
  transformCursorLines,
  updateCursorSessionMapping,
} from './providers/cursor.js';
export type { ServerOptions } from './server.js';
export { createServer, HttpError } from './server.js';
export type {
  BridgeToolDefinition,
  BridgeVariant,
  ToolBridgeParserEvent,
  ToolCallStreamParser,
} from './tool-bridge.js';
export {
  buildToolSystemPromptSection,
  createToolCallStreamParser,
  formatHistoryForBridge,
  formatToolResultsForPrompt,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_RESULT_OPEN_PREFIX,
  TOOL_RESULT_OPEN_SUFFIX,
} from './tool-bridge.js';
