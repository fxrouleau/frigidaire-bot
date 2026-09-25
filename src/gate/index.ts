// Shared instances: the gate's conversation tracking and rate limit, and the ramble buffers, must be the
// same objects across every message the event handlers see.
import { AddressedGate } from './addressedGate';
import { RambleWatcher } from './ramble';

export const addressedGate = new AddressedGate();
export const rambleWatcher = new RambleWatcher();
