/**
 * @app/core root: shared, mostly pure helpers. Feature modules are imported by subpath:
 *   @app/core/media, /stt, /ai, /youtube, /meta, /scheduling, /notify, /storage, /posts, ...
 */
export * from './env';
export * from './status';
export * from './text';
export * from './time';
export * from './platforms/rules';
export { PlatformError, isPlatformError } from './platforms';
export type * from './platforms';
