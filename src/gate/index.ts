// Shared instances: the gate's conversation tracking and rate limit, and the ramble buffers, must be the
// same objects across every message the event handlers see.
import { AddressedGate } from './addressedGate';
import { RambleWatcher } from './ramble';

export const addressedGate = new AddressedGate();
// A message the gate hands to the agent gets an answer, never also a ramble nudge.
export const rambleWatcher = new RambleWatcher({ wasRouted: (messageId) => addressedGate.wasRouted(messageId) });
