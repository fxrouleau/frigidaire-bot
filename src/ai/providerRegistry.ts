import * as process from 'node:process';
import { logger } from '../logger';
import { OpenAIProvider } from './providers/openaiProvider';
import type { AiProvider } from './types';

const providers = new Map<string, AiProvider>();
const channelProviders = new Map<string, string>();

const defaultProviderId = process.env.AI_PROVIDER || 'openai';

function ensureProvidersRegistered() {
  if (providers.size > 0) return;

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.set(
      'openai',
      new OpenAIProvider({
        apiKey: openaiKey,
      }),
    );
  } else {
    logger.warn('OPENAI_API_KEY is missing; OpenAI provider will not be registered.');
  }
}

export function listProviders(): AiProvider[] {
  ensureProvidersRegistered();
  return Array.from(providers.values());
}

export function getProvider(providerId: string | undefined): AiProvider | undefined {
  ensureProvidersRegistered();
  if (!providerId) return providers.get(defaultProviderId);
  return providers.get(providerId) ?? providers.get(defaultProviderId);
}

export function getProviderForChannel(channelId: string): AiProvider | undefined {
  const providerId = channelProviders.get(channelId) ?? defaultProviderId;
  return getProvider(providerId);
}

export function setProviderForChannel(
  channelId: string,
  providerId: string,
): { provider?: AiProvider; error?: string } {
  ensureProvidersRegistered();
  if (!providers.has(providerId)) {
    return { error: `Provider "${providerId}" is not registered.` };
  }
  channelProviders.set(channelId, providerId);
  return { provider: providers.get(providerId) };
}

export function getActiveProviderId(channelId: string): string {
  return channelProviders.get(channelId) ?? defaultProviderId;
}
