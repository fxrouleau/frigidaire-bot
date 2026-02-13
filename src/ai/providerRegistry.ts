import { OpenRouterProvider } from './providers/openRouterProvider';
import type { AiProvider } from './types';

let provider: AiProvider | undefined;

function ensureProvider(): AiProvider {
  if (!provider) {
    provider = new OpenRouterProvider();
  }
  return provider;
}

export function getProvider(): AiProvider {
  return ensureProvider();
}

export function getProviderForChannel(_channelId: string): AiProvider {
  return ensureProvider();
}
