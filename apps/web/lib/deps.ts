/**
 * Server-side service dependencies for route handlers and server actions.
 */
import { defaultDeps, type ServiceDeps } from '@app/core/deps';

let deps: ServiceDeps | undefined;

export function getDeps(): ServiceDeps {
  deps ??= defaultDeps();
  return deps;
}
