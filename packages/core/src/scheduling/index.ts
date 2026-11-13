/**
 * Scheduling: posting slots, schedule/reschedule services used by the UI, and the publishing
 * engine used by the worker. (Module owner: scheduler.)
 */
export {
  schedulePosts,
  reschedulePost,
  moveToDrafts,
  deletePost,
  retryTarget,
  updateTargetText,
  nextFreeSlots,
  type ScheduleRequest,
  type ScheduleResult,
} from './services';
export { createEngine, type Engine } from './engine';
export { SchedulingError, isSchedulingError, type SchedulingErrorCode } from './errors';
export { SCHEDULING, backoffSec } from './config';
export { lateDecision, isHandedOver, hasRemote, type LateDecision } from './model';
export { slotInstants, defaultSlotRules, type SlotRule } from './slots';
