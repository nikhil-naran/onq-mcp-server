import type { Config } from '@/shared-kernel/config/schema.js';
import type { FileDelivery } from '@/contexts/onq/domain/FileDelivery.js';
import { WindowsFileDelivery } from '@/contexts/onq/infrastructure/WindowsFileDelivery.js';
import { MAX_DOWNLOAD_BYTES } from '@/contexts/http-api/D2lApiClient.js';

export function buildFileDelivery(config: Config): FileDelivery | undefined {
  const settings = config.file_delivery;
  if (!settings || settings.mode === 'embedded') return undefined;
  return new WindowsFileDelivery({
    publicBaseUrl: settings.public_base_url!,
    port: settings.port,
    ttlSeconds: settings.ttl_seconds,
    maxBytes: settings.max_cache_bytes,
    maxEntries: settings.max_entries,
    maxFileBytes: MAX_DOWNLOAD_BYTES,
    maxConcurrentRetrievals: settings.max_concurrent_retrievals,
    maxConcurrentResponses: settings.max_concurrent_responses,
  });
}
