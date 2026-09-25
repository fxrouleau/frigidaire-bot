// A purge (a moderator's bulk delete) comes as one MessageBulkDelete, not a MessageDelete per message:
// the purged posts waiting out the auto-react delay are dropped like single deletions, instead of each
// spending a judge call on a message that is gone. See src/reactions/.
import { Events } from 'discord.js';
import { config } from '../config';
import { defineEvent } from '../eventModule';
import { getAutoReactor } from '../reactions';

export default defineEvent(Events.MessageBulkDelete, {
  execute(messages, channel) {
    if (config.autoReact.mode === 'off') return;
    const reactor = getAutoReactor(channel.client);
    for (const id of messages.keys()) reactor.cancel(id);
  },
});
