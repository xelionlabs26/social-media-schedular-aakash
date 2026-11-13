/**
 * The publishing engine used by the worker (PLAN.md §5). Every method is safe to run more than
 * once and concurrently: state changes are compare-and-set on post_targets.
 */
import type { ServiceDeps } from '../../deps';
import type { Integrations } from '../../platforms';
import type { EngineCtx } from './context';
import { dispatch } from './dispatch';
import { dailyDigest, purgeMedia, tokenHealth, watchdog } from './maintenance';
import { cancelTarget, prepareTarget, publishTarget, reconcileTarget } from './steps';

export interface Engine {
  /** Every minute: queue prepare/publish for due targets, detect missed posts. */
  dispatch(): Promise<void>;
  prepareTarget(targetId: string): Promise<void>;
  publishTarget(targetId: string): Promise<void>;
  reconcileTarget(targetId: string): Promise<void>;
  cancelTarget(targetId: string): Promise<void>;
  /** Every 5 minutes: unstick targets whose lock expired. */
  watchdog(): Promise<void>;
  /** Daily: token health / refresh, expiry warnings. */
  tokenHealth(): Promise<void>;
  /** Daily: delete media N days after everything published. */
  purgeMedia(): Promise<void>;
  dailyDigest(): Promise<void>;
}

export function createEngine(deps: ServiceDeps, integrations: Integrations): Engine {
  const ctx: EngineCtx = { deps, integrations, log: deps.log.child('engine') };
  return {
    dispatch: () => dispatch(ctx),
    prepareTarget: (id) => prepareTarget(ctx, id),
    publishTarget: (id) => publishTarget(ctx, id),
    reconcileTarget: (id) => reconcileTarget(ctx, id),
    cancelTarget: (id) => cancelTarget(ctx, id),
    watchdog: () => watchdog(ctx),
    tokenHealth: () => tokenHealth(ctx),
    purgeMedia: () => purgeMedia(ctx),
    dailyDigest: () => dailyDigest(ctx),
  };
}
