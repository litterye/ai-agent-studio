/**
 * YOLO mode is read once at module import time and frozen for the lifetime of
 * the process. This matches Hermes's `HERMES_YOLO_MODE` semantics — a skill
 * or tool cannot flip YOLO on mid-loop, only an environment change at the
 * next process restart can.
 */
const RAW = (process.env['HERMES_YOLO_MODE'] ?? process.env['AI_AGENT_STUDIO_YOLO'] ?? '')
  .trim()
  .toLowerCase()

export const YOLO_FROZEN: boolean = RAW === '1' || RAW === 'true' || RAW === 'yes'
