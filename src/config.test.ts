import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSTAGRAM_FIXERS,
  config,
  describeEffectiveConfig,
  envBool,
  envCsv,
  envEnum,
  envInt,
  envNumber,
  envString,
} from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envBool', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' "true" '])('reads %j as true', (value) => {
    vi.stubEnv('FLAG', value);
    expect(envBool('FLAG', false)).toBe(true);
  });

  it.each(['0', 'false', 'False', 'no', 'off', "'0'"])('reads %j as false', (value) => {
    vi.stubEnv('FLAG', value);
    expect(envBool('FLAG', true)).toBe(false);
  });

  it('falls back for unset, blank, or unrecognized values', () => {
    expect(envBool('FLAG', true)).toBe(true);
    vi.stubEnv('FLAG', '   ');
    expect(envBool('FLAG', false)).toBe(false);
    vi.stubEnv('FLAG', 'maybe');
    expect(envBool('FLAG', true)).toBe(true);
  });
});

describe('envInt / envNumber', () => {
  it('parses integers and rejects out-of-range or non-numeric values', () => {
    vi.stubEnv('N', '42');
    expect(envInt('N', 7)).toBe(42);
    vi.stubEnv('N', '0');
    expect(envInt('N', 7, { min: 1 })).toBe(7);
    expect(envInt('N', 7, { min: 0 })).toBe(0);
    vi.stubEnv('N', '4.5');
    expect(envInt('N', 7)).toBe(7);
    vi.stubEnv('N', 'lots');
    expect(envInt('N', 7)).toBe(7);
  });

  it('parses floats within bounds', () => {
    vi.stubEnv('F', '0.75');
    expect(envNumber('F', 0.5, { min: 0, max: 1 })).toBe(0.75);
    vi.stubEnv('F', '7');
    expect(envNumber('F', 0.5, { min: 0, max: 1 })).toBe(0.5);
  });
});

describe('envString / envCsv / envEnum', () => {
  it('trims strings and treats blank as unset', () => {
    vi.stubEnv('S', '  value  ');
    expect(envString('S')).toBe('value');
    vi.stubEnv('S', '');
    expect(envString('S')).toBeUndefined();
  });

  it('splits csv lists and drops empty entries', () => {
    vi.stubEnv('L', ' a, b ,,c ');
    expect(envCsv('L')).toEqual(['a', 'b', 'c']);
    expect(envCsv('MISSING')).toEqual([]);
  });

  it('accepts only listed enum values (case-insensitive)', () => {
    vi.stubEnv('M', 'ALWAYS');
    expect(envEnum('M', ['edgy', 'always'] as const, 'edgy')).toBe('always');
    vi.stubEnv('M', 'sometimes');
    expect(envEnum('M', ['edgy', 'always'] as const, 'edgy')).toBe('edgy');
  });
});

describe('config', () => {
  it('turns features off with either spelling of false (regression: DEBUG_CAPTURE=false used to be ignored)', () => {
    vi.stubEnv('DEBUG_CAPTURE', 'false');
    expect(config.debugCapture.enabled).toBe(false);
    vi.stubEnv('DIGEST_ENABLED', '0');
    expect(config.report.digestEnabled).toBe(false);
    vi.stubEnv('SELF_IMPROVEMENT_ENABLED', 'no');
    expect(config.learner.selfImprovementEnabled).toBe(false);
  });

  it('applies defaults when nothing is set', () => {
    vi.stubEnv('LINK_FIX_VERIFY', undefined);
    expect(config.links.verify).toBe(true);
    expect(config.links.instagramFixers).toEqual(DEFAULT_INSTAGRAM_FIXERS);
    expect(config.deleteRepost.mode).toBe('edgy');
    expect(config.deleteRepost.userIds).toEqual([]);
    expect(config.agent.maxToolRounds).toBe(25);
    expect(config.agent.maxToolInvocations).toBe(200);
    expect(config.agent.chatContextTokens).toBe(131_072);
    expect(config.agent.historyTokenBudget).toBeUndefined();
    expect(config.agent.channelNotes).toEqual({ notes: {}, invalid: false });
    expect(config.models.chatFallbacks).toEqual([]);
  });

  it('defaults the models to what prod runs (an image-capable chat and learner model)', () => {
    for (const name of ['CHAT_MODEL', 'LEARNER_MODEL', 'IMAGE_MODEL', 'SELF_IMPROVEMENT_MODEL', 'DELETE_REPOST_MODEL']) {
      vi.stubEnv(name, undefined);
    }
    // Regression: the old default chat model (deepseek/deepseek-v3.2) was text-only, so a deploy without
    // CHAT_MODEL failed every turn that carried an image, custom emoji or sticker.
    expect(config.models.chat).toBe('z-ai/glm-5.3-flash');
    expect(config.models.learner).toBe('z-ai/glm-5.3-flash');
    expect(config.models.selfImprovement).toBe('z-ai/glm-5.3-flash');
    expect(config.models.image).toBe('google/gemini-3.1-flash-image');
    // The deleted-message judge is the decision model; the chat model is only its fallback.
    expect(config.models.messageJudge).toBe('typesafe/jev-1.13');
  });

  it('reads CHAT_FALLBACK_MODELS in order, without duplicates or the primary', () => {
    vi.stubEnv('CHAT_MODEL', 'primary/model');
    vi.stubEnv('CHAT_FALLBACK_MODELS', ' backup/one, primary/model ,backup/two,backup/one ');
    expect(config.models.chatFallbacks).toEqual(['backup/one', 'backup/two']);
  });

  it('takes HISTORY_TOKEN_BUDGET and CHAT_CONTEXT_TOKENS only when they are sane', () => {
    vi.stubEnv('HISTORY_TOKEN_BUDGET', '200000');
    expect(config.agent.historyTokenBudget).toBe(200_000);
    vi.stubEnv('HISTORY_TOKEN_BUDGET', '12');
    expect(config.agent.historyTokenBudget).toBeUndefined();
    vi.stubEnv('HISTORY_TOKEN_BUDGET', 'lots');
    expect(config.agent.historyTokenBudget).toBeUndefined();
    vi.stubEnv('CHAT_CONTEXT_TOKENS', '1310720');
    expect(config.agent.chatContextTokens).toBe(1_310_720);
    vi.stubEnv('CHAT_CONTEXT_TOKENS', '0');
    expect(config.agent.chatContextTokens).toBe(131_072);
  });

  it('parses CHANNEL_NOTES as a JSON object of channel id to note', () => {
    vi.stubEnv('CHANNEL_NOTES', '{"900000000000000042":" bagel-bar: the main hangout ","1":42,"2":""}');
    expect(config.agent.channelNotes).toEqual({
      notes: { '900000000000000042': 'bagel-bar: the main hangout' },
      invalid: false,
    });
    // A single-quoted .env value still parses (config strips surrounding quotes).
    vi.stubEnv('CHANNEL_NOTES', `'{"3":"clips"}'`);
    expect(config.agent.channelNotes.notes).toEqual({ '3': 'clips' });
  });

  it('flags CHANNEL_NOTES that is not a JSON object instead of throwing', () => {
    for (const bad of ['{not json', '["a","b"]', '"just a string"', 'null']) {
      vi.stubEnv('CHANNEL_NOTES', bad);
      expect(config.agent.channelNotes).toEqual({ notes: {}, invalid: true });
    }
  });

  it('reads the values lazily, so a change is visible on the next access', () => {
    vi.stubEnv('CHAT_MODEL', 'first/model');
    expect(config.models.chat).toBe('first/model');
    vi.stubEnv('CHAT_MODEL', 'second/model');
    expect(config.models.chat).toBe('second/model');
  });

  it('derives the self-improvement model from the learner model; the judge does not follow CHAT_MODEL', () => {
    vi.stubEnv('LEARNER_MODEL', 'learner/model');
    vi.stubEnv('SELF_IMPROVEMENT_MODEL', undefined);
    expect(config.models.selfImprovement).toBe('learner/model');
    vi.stubEnv('CHAT_MODEL', 'chat/model');
    vi.stubEnv('DELETE_REPOST_MODEL', undefined);
    expect(config.models.messageJudge).toBe('typesafe/jev-1.13');
    vi.stubEnv('DELETE_REPOST_MODEL', 'judge/chat-model');
    expect(config.models.messageJudge).toBe('judge/chat-model');
  });

  it('never prints the API key in the startup summary', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-super-secret');
    const summary = describeEffectiveConfig();
    expect(summary).toContain('openRouter=key:set');
    expect(summary).not.toContain('super-secret');
  });
});

describe('describeEffectiveConfig', () => {
  // Every variable the summary reads that could hold a secret or an identifier, set to a recognizable value.
  const SENSITIVE: Record<string, string> = {
    CLIENT_SECRET: 'discord-token-SENTINEL',
    OPENROUTER_API_KEY: 'sk-or-SENTINEL',
    GITHUB_TOKEN: 'github_pat_SENTINEL',
    GITHUB_REPO: 'sentinel-owner/sentinel-repo',
    SANDBOX_URL: 'http://sandboxuser:sandboxpass@sandbox-host-sentinel:8080',
    SANDBOX_TOKEN: 'sandbox-token-SENTINEL',
    MAIN_CHANNEL_ID: '111111111111111111',
    REPORT_CHANNEL_ID: '222222222222222222',
    BIRTHDAY_CHANNEL_ID: '333333333333333333',
    WRAPPED_CHANNEL_ID: '444444444444444444',
    RAMBLE_CHANNEL_ID: '555555555555555555',
    RAMBLE_USER_IDS: '666666666666666666',
    RAMBLE_WATCH_CHANNELS: '777777777777777777',
    GATE_CHANNELS: '888888888888888888,999999999999999999',
    LEARNER_IGNORE_CHANNELS: '121212121212121212',
    ARCHIVE_IGNORE_CHANNELS: '131313131313131313',
    ARCHIVE_BACKFILL_CHANNELS: '141414141414141414',
    VOICE_TRANSCRIBE_CHANNELS: '151515151515151515',
    DELETE_REPOST_USER_IDS: '161616161616161616',
    FEATURE_REQUEST_USER_IDS: '171717171717171717',
    LINKED_ACCOUNTS: '181818181818181818:191919191919191919',
    BIRTHDAYS_SEED: '202020202020202020:03-29',
    CHANNEL_NOTES: '{"212121212121212121":"note-SENTINEL"}',
    GIT_SHA: 'deadbeefSENTINEL',
    AUTO_REACT_CHANNELS: '232323232323232323',
  };

  function stubAll(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  }

  // Maps each config section to the summary token that covers it. A section added to `config` without a
  // line in the summary fails the first test below: add it to describeEffectiveConfig() and here.
  const SECTION_TOKENS: Record<string, RegExp> = {
    discord: /(^| )discordToken=/,
    openRouter: /(^| )openRouter=key:/,
    models: /(^| )chat=.* learner=.* image=.* embedding=/,
    agent: /(^| )agent=/,
    learner: /(^| )learning=/,
    emoji: /(^| )forceRecaption=.* usageCaptions=.* recaptionFromUsage=/,
    memory: /(^| )semanticMemory=/,
    debugCapture: /(^| )debugCapture=/,
    report: /(^| )reportChannel=/,
    links: /(^| )links=/,
    deleteRepost: /(^| )deleteRepost=/,
    logging: /(^| )logFile=/,
    server: /(^| )mainChannel=.* linkedAccounts=/,
    reminders: /(^| )reminders=/,
    birthdays: /(^| )birthdays=/,
    archive: /(^| )archive=/,
    media: /(^| )media=/,
    linkReader: /(^| )linkReader=/,
    gate: /(^| )gate=/,
    ramble: /(^| )ramble=/,
    sandbox: /(^| )sandbox=/,
    featureRequests: /(^| )featureRequests=/,
    costs: /(^| )usageLedger=/,
    commands: /(^| )commands=/,
    autoReact: /(^| )autoReact=/,
  };
  // Not bot configuration: the eval harness's own settings, and the Vitest guard.
  const NOT_SUMMARIZED = ['evals', 'isTest'];

  it('has a token for every config section', () => {
    const sections = Object.keys(config).filter((name) => !NOT_SUMMARIZED.includes(name));
    expect(sections.sort()).toEqual(Object.keys(SECTION_TOKENS).sort());
    const summary = describeEffectiveConfig();
    for (const [section, token] of Object.entries(SECTION_TOKENS)) {
      expect(summary, `section ${section}`).toMatch(token);
    }
  });

  it('is one line of key=value tokens', () => {
    stubAll(SENSITIVE);
    const summary = describeEffectiveConfig();
    expect(summary).not.toMatch(/\n/);
    for (const token of summary.split(' ')) expect(token).toMatch(/^[A-Za-z]+=\S+$/);
  });

  it('prints no secret, URL, repo or Discord id: only set/missing flags and counts', () => {
    stubAll(SENSITIVE);
    const summary = describeEffectiveConfig();
    for (const [name, value] of Object.entries(SENSITIVE)) {
      for (const piece of value.split(/[,:/@{}"]+/).filter((part) => part.length >= 6)) {
        expect(summary, `${name} leaked "${piece}"`).not.toContain(piece);
      }
    }
    expect(summary).not.toMatch(/\d{15,}/);
    expect(summary).toContain('discordToken=set');
    expect(summary).toContain('openRouter=key:set,');
    expect(summary).toContain('sandbox=on(token:set,');
    expect(summary).toContain('featureRequests=on(max:3/day,users:1)');
  });

  it('summarizes a prod-like configuration', () => {
    stubAll({
      CHAT_MODEL: 'z-ai/glm-5.3-flash',
      LEARNER_MODEL: 'z-ai/glm-5.3-flash',
      IMAGE_MODEL: 'google/gemini-3.1-flash-image',
      OPENROUTER_API_KEY: 'sk-or-x',
      CLIENT_SECRET: 'token',
      MAIN_CHANNEL_ID: '111111111111111111',
      REPORT_CHANNEL_ID: '222222222222222222',
      GIT_SHA: 'abc1234',
      LEARNER_IGNORE_CHANNELS: '121212121212121212,131313131313131313',
      LINKED_ACCOUNTS: '181818181818181818:191919191919191919',
      BIRTHDAYS_SEED: '202020202020202020:03-29,212121212121212121:12-01',
      SANDBOX_URL: 'http://sandbox:8080',
    });
    for (const name of [
      'SANDBOX_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_REPO',
      'BIRTHDAY_CHANNEL_ID',
      'RAMBLE_USER_IDS',
      'AUTO_REACT_CHANNELS',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const tokens = describeEffectiveConfig().split(' ');

    expect(tokens).toEqual(
      expect.arrayContaining([
        'chat=z-ai/glm-5.3-flash',
        'chatFallbacks=none',
        'learner=z-ai/glm-5.3-flash',
        'image=google/gemini-3.1-flash-image',
        'discordToken=set',
        'openRouter=key:set,timeout:2m,retries:2',
        'mainChannel=set',
        'linkedAccounts=1',
        'reportChannel=set(digest:on@7d,deploy:on)',
        'learning=every:30m,ignore:2,selfImprovement:on',
        'links=verify:on,fixers:x3/ig3/tt3/rd2/bsky3,translate:en,alerts:on',
        'deleteRepost=off',
        'birthdays=announce:15h,channel:main,seed:2',
        'archive=on(backfill:1,ignore:0,wrapped:on)',
        'media=transcribe:openai/whisper-large-v3,video:google/gemini-3.5-flash-lite,videoBudget:$0.50/day,voiceAuto:all',
        'gate=on(channels:1,max:30/10m,cold:3/10m)',
        'ramble=off',
        'sandbox=on(token:none,timeout:20s)',
        'featureRequests=off',
        'commands=on',
        'autoReact=on(mode:shadow,channels:1,max:3/day,gap:45m)',
        'usageCaptions=on',
        'recaptionFromUsage=off',
        'usageLedger=on',
      ]),
    );
    // SELF_IMPROVEMENT_MODEL only shows up when it differs from the learner.
    expect(tokens.some((token) => token.startsWith('selfImprovement='))).toBe(false);
  });

  it('shows the ramble prefilter, the linked-video switch and the deleted-message judge', () => {
    stubAll({
      MAIN_CHANNEL_ID: '111111111111111111',
      RAMBLE_USER_IDS: '666666666666666666',
      RAMBLE_CHANNEL_ID: '777777777777777777',
      RAMBLE_LONG_MESSAGE_CHARS: '900',
      LINK_READER_WATCH_VIDEOS: 'false',
      DELETE_REPOST_USER_IDS: '161616161616161616',
    });
    for (const name of ['RAMBLE_WATCH_CHANNELS', 'RAMBLE_MIN_MESSAGES', 'DELETE_REPOST_MODE', 'DELETE_REPOST_MODEL']) {
      vi.stubEnv(name, undefined);
    }
    const tokens = describeEffectiveConfig().split(' ');
    expect(tokens).toContain('ramble=on(users:1,channels:1,run:3,long:900)');
    expect(tokens).toContain('linkReader=on(previews:on,videos:off)');
    expect(tokens).toContain('deleteRepost=on(users:1,mode:edgy,judge:typesafe/jev-1.13)');
  });

  it('shows an uncapped video budget as unlimited', () => {
    vi.stubEnv('VIDEO_DAILY_BUDGET_USD', '0');
    expect(describeEffectiveConfig()).toMatch(/(^| )media=\S*videoBudget:unlimited[,\s]/);
  });

  it('names what is missing when a feature is half configured', () => {
    stubAll({
      GITHUB_TOKEN: 'github_pat_x',
      RAMBLE_USER_IDS: '666666666666666666',
      REPORT_CHANNEL_ID: '222222222222222222',
      DEPLOY_ANNOUNCE_ENABLED: 'true',
      CHANNEL_NOTES: '{not json',
      DELETE_REPOST_USER_IDS: '161616161616161616,171717171717171717',
      DELETE_REPOST_MODE: 'always',
    });
    for (const name of [
      'GITHUB_REPO',
      'RAMBLE_CHANNEL_ID',
      'GIT_SHA',
      'MAIN_CHANNEL_ID',
      'GATE_CHANNELS',
      'AUTO_REACT_CHANNELS',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const summary = describeEffectiveConfig();

    expect(summary).toContain('featureRequests=off(no-repo)');
    expect(summary).toContain('ramble=off(no-channel)');
    expect(summary).toContain('gate=off(no-channel)');
    expect(summary).toContain('autoReact=off(no-channel)');
    expect(summary).toContain('birthdays=announce:no-channel,');
    expect(summary).toContain('reportChannel=set(digest:on@7d,deploy:no-sha)');
    expect(summary).toContain('mainChannel=off');
    expect(summary).toContain('notes:INVALID');
    expect(summary).toContain('deleteRepost=on(users:2,mode:always)');

    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GITHUB_REPO', 'owner/repo');
    vi.stubEnv('GATE_ENABLED', 'false');
    expect(describeEffectiveConfig()).toContain('featureRequests=off(no-token)');
    expect(describeEffectiveConfig()).toContain('gate=off ');
  });
});
