import { AgentOrchestrator } from './agent';
import { getConversationPersistence } from './conversationPersistence';

export const agent = new AgentOrchestrator({ persistence: getConversationPersistence() });
