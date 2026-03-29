import { PersonalityLearner } from './personalityLearner';
import { getMemoryStore } from './tools';

export const personalityLearner = new PersonalityLearner(getMemoryStore());
