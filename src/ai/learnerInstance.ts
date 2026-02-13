import { MemoryStore } from './memory/memoryStore';
import { PersonalityLearner } from './personalityLearner';

const store = new MemoryStore();
export const personalityLearner = new PersonalityLearner(store);
