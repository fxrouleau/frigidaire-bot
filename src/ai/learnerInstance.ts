import { getMemoryStore } from './memory';
import { PersonalityLearner } from './personalityLearner';

export const personalityLearner = new PersonalityLearner(getMemoryStore());
