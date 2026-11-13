import type { Integrations } from '@app/core/platforms';
import { youtubeIntegration } from '@app/core/youtube';
import { facebookIntegration, instagramIntegration } from '@app/core/meta';

/** The platform integrations the engine publishes with. */
export function createIntegrations(): Integrations {
  return {
    youtube: youtubeIntegration,
    facebook: facebookIntegration,
    instagram: instagramIntegration,
  };
}
