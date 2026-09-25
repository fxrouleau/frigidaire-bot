// Fakes for the scheduling tests (reminders, birthdays, polls): a sendable channel that records the
// full MessageCreateOptions it was given and resolves to a message id like discord.js does, and a
// ready client that fetches those channels. Guild members can be attached for the birthday
// announcer's membership check.
import { ChannelType, type Client, type MessageCreateOptions } from 'discord.js';
import { type Recorder, createRecorder } from './recorder';

export type FakeGuildMember = { id: string; displayName: string };

export type FakePostableChannel = {
  channel: {
    id: string;
    type: ChannelType;
    isTextBased: () => boolean;
    send: Recorder<[MessageCreateOptions], Promise<{ id: string }>>;
    guild?: { members: { fetch: Recorder<[string], Promise<FakeGuildMember>> } };
  };
  sent: MessageCreateOptions[];
};

let sentCounter = 0;

export function createPostableChannel(
  opts: {
    id?: string;
    sendImpl?: (options: MessageCreateOptions) => Promise<{ id: string }>;
    /** Members of the channel's guild; a fetch for anyone else rejects with Unknown Member (10007). */
    members?: FakeGuildMember[];
  } = {},
): FakePostableChannel {
  const sent: MessageCreateOptions[] = [];
  const send = createRecorder<[MessageCreateOptions], Promise<{ id: string }>>(async (options) => {
    if (opts.sendImpl) {
      const result = await opts.sendImpl(options);
      sent.push(options);
      return result;
    }
    sent.push(options);
    return { id: `sent-${++sentCounter}` };
  });
  const members = opts.members;
  const guild = members
    ? {
        members: {
          fetch: createRecorder<[string], Promise<FakeGuildMember>>(async (userId) => {
            const found = members.find((m) => m.id === userId);
            if (!found) throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
            return found;
          }),
        },
      }
    : undefined;
  return {
    channel: { id: opts.id ?? 'channel-1', type: ChannelType.GuildText, isTextBased: () => true, send, guild },
    sent,
  };
}

/** A Discord REST error shaped like DiscordAPIError (code + status). */
export function discordError(code: number, message = `Discord error ${code}`): Error {
  return Object.assign(new Error(message), { code, status: code === 10003 ? 404 : 403 });
}

export function createSchedulingClient(
  channels: Record<string, FakePostableChannel['channel']>,
  opts: { botName?: string } = {},
): { client: Client<true>; channelsFetch: Recorder<[string], Promise<unknown>> } {
  const channelsFetch = createRecorder<[string], Promise<unknown>>(async (id) => {
    const found = channels[id];
    if (!found) throw discordError(10003, 'Unknown Channel');
    return found;
  });
  const built = {
    channels: { fetch: channelsFetch },
    user: { id: 'bot-1', displayName: opts.botName ?? 'Frigidaire' },
    users: {
      fetch: async (id: string) => {
        throw discordError(10013, `Unknown User ${id}`);
      },
    },
  };
  return { client: built as unknown as Client<true>, channelsFetch };
}
