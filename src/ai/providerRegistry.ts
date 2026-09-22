import { OpenRouterProvider } from './providers/openRouterProvider';
import type { AiProvider } from './types';

let provider: AiProvider | undefined;

/** The process-wide chat provider (OpenRouter), constructed on first use. */
export function getProvider(): AiProvider {
  if (!provider) {
    provider = new OpenRouterProvider();
  }
  return provider;
}
