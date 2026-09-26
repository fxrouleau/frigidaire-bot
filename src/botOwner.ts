// Who owns the bot: the people allowed to do owner-only things (editing someone's notes, undoing a note
// version). BOT_OWNER_USER_IDS when it is set; otherwise the Discord application's owner, or the owner and
// every accepted member of the team that owns it, fetched once through the client. Never hardcoded (the
// repo is public), and fail closed: while the owner can't be determined, nobody is the owner.
import { type Client, TeamMemberMembershipState } from 'discord.js';
import { config } from './config';
import { canonicalUserId } from './linkedAccounts';
import { logger } from './logger';

/** Fetches the application owner's user ids (a team's owner and accepted members for a team-owned application). */
export type ApplicationOwnerSource = () => Promise<string[]>;

/** The application owner as the Discord client reports it. */
export function applicationOwnerSource(client: Client): ApplicationOwnerSource {
  return async () => {
    const application = client.application;
    if (!application) throw new Error('the client has no application yet (not ready)');
    const fetched = await application.fetch();
    const owner = fetched.owner;
    if (!owner) return [];
    // A User is the owner itself. A Team: its owner and every member who accepted (Discord lists people
    // only invited to the team among its members too; they aren't members yet).
    if (!('members' in owner)) return [owner.id];
    const accepted = [...owner.members.values()]
      .filter((member) => member.membershipState === TeamMemberMembershipState.Accepted)
      .map((member) => member.user.id);
    return [...new Set([...(owner.ownerId ? [owner.ownerId] : []), ...accepted])];
  };
}

export type BotOwnersOptions = {
  source: ApplicationOwnerSource;
  /** BOT_OWNER_USER_IDS by default. */
  configured?: () => string[];
};

/**
 * The owner ids, resolved once: the configured ids as they are, else the application owner (fetched on
 * first use and cached; a failed fetch is logged, answers "nobody" and is retried on the next check).
 * A linked side account (LINKED_ACCOUNTS) of an owner counts as the owner.
 */
export class BotOwners {
  private readonly source: ApplicationOwnerSource;
  private readonly configured: () => string[];
  private cached: ReadonlySet<string> | undefined;
  private inFlight: Promise<ReadonlySet<string>> | undefined;

  constructor(opts: BotOwnersOptions) {
    this.source = opts.source;
    this.configured = opts.configured ?? (() => config.server.ownerUserIds);
  }

  /** The owners' main account ids (empty while they can't be determined). */
  async ids(): Promise<ReadonlySet<string>> {
    const configured = this.configured();
    if (configured.length > 0) return new Set(configured.map((id) => canonicalUserId(id)));
    if (this.cached) return this.cached;
    this.inFlight ??= this.fetchOwners().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async isOwner(userId: string): Promise<boolean> {
    return (await this.ids()).has(canonicalUserId(userId));
  }

  private async fetchOwners(): Promise<ReadonlySet<string>> {
    try {
      const ids = new Set((await this.source()).map((id) => canonicalUserId(id)));
      this.cached = ids;
      if (ids.size === 0) logger.warn('Bot owner: the Discord application has no owner; owner-only actions are off.');
      else logger.info(`Bot owner: ${ids.size} owner id(s) from the Discord application.`);
      return ids;
    } catch (error) {
      logger.warn('Bot owner: could not fetch the application owner (owner-only actions refused for now):', error);
      return new Set();
    }
  }
}

const perClient = new WeakMap<Client, BotOwners>();

/** The shared owner lookup for a client (one application fetch per process). */
export function botOwnersFor(client: Client): BotOwners {
  let owners = perClient.get(client);
  if (!owners) {
    owners = new BotOwners({ source: applicationOwnerSource(client) });
    perClient.set(client, owners);
  }
  return owners;
}

/** Whether `userId` (any of their linked accounts) is the bot's owner. Never throws; false when unsure. */
export async function isBotOwner(client: Client, userId: string): Promise<boolean> {
  try {
    return await botOwnersFor(client).isOwner(userId);
  } catch (error) {
    logger.warn('Bot owner: owner check failed:', error);
    return false;
  }
}
