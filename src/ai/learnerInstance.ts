import { ConversationEndTrigger } from './captureTrigger';
import { getMemoryStore } from './memory';
import { PersonalityLearner } from './personalityLearner';

// Memory v2 capture: each channel's conversation is read once it ends (CAPTURE_IDLE_MINUTES of quiet, or
// CAPTURE_MAX_SPAN_MINUTES for one that never pauses), not on a fixed interval.
export const personalityLearner = new PersonalityLearner(getMemoryStore(), { trigger: new ConversationEndTrigger() });
