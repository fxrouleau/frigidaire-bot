import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearConfigOverrides, config } from '../../config';
import { changeSetting, loadRuntimeSettings, RUNTIME_SETTINGS, validateSetting } from '../../runtimeSettings';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { FakeProvider } from '../../test-support/fakeProvider';
import { toolDefinitions } from '../tools';
import { createTurnEffects, type ToolHandlerContext } from '../types';
import { settingsTools } from './settings';

const OWNER = '500000000000000001';
const MEMBER = '500000000000000002';
const [listTool, changeTool] = settingsTools;

function ctx(authorId: string): ToolHandlerContext {
  return {
    message: createFakeMessage({ authorId }).message,
    provider: new FakeProvider([]),
    channelId: 'channel-1',
    turn: createTurnEffects(),
  };
}

let botDb: BotDb;

beforeEach(() => {
  botDb = new BotDb(':memory:');
  setBotDbForTesting(botDb);
  vi.stubEnv('BOT_OWNER_USER_IDS', OWNER);
  vi.stubEnv('GATE_ENABLED', '');
  vi.stubEnv('GATE_THRESHOLD', '');
  vi.stubEnv('MEMORY_DREAM_MODEL', '');
});

afterEach(() => {
  clearConfigOverrides();
  setBotDbForTesting(undefined);
  vi.unstubAllEnvs();
});

describe('runtime settings', () => {
  it('only lists settings config.ts actually reads, and never secrets, urls or owners', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../config.ts'), 'utf8');
    for (const name of Object.keys(RUNTIME_SETTINGS)) expect(source).toContain(`'${name}'`);
    for (const forbidden of [
      'CLIENT_SECRET',
      'OPENROUTER_API_KEY',
      'GITHUB_TOKEN',
      'GITHUB_REPO',
      'SANDBOX_URL',
      'SANDBOX_TOKEN',
      'BOT_OWNER_USER_IDS',
      'LINKED_ACCOUNTS',
      'LOG_FILE',
      'DEBUG_CAPTURE_DIR',
    ]) {
      expect(RUNTIME_SETTINGS[forbidden]).toBeUndefined();
    }
  });

  it('validates values with the rules config.ts parses by', () => {
    expect(validateSetting('GATE_ENABLED', ' Off ')).toEqual({ ok: true, value: 'off' });
    expect(validateSetting('GATE_ENABLED', 'maybe').ok).toBe(false);
    expect(validateSetting('GATE_THRESHOLD', '0.8')).toEqual({ ok: true, value: '0.8' });
    expect(validateSetting('GATE_THRESHOLD', '1.5').ok).toBe(false);
    expect(validateSetting('MEMORY_DREAM_HOUR', '3.5').ok).toBe(false);
    expect(validateSetting('AUTO_REACT_MODE', 'ON')).toEqual({ ok: true, value: 'on' });
    expect(validateSetting('AUTO_REACT_MODE', 'loud').ok).toBe(false);
    expect(validateSetting('MEMORY_DREAM_MODEL', 'anthropic/claude-opus-5.5').ok).toBe(true);
    expect(validateSetting('MEMORY_DREAM_MODEL', 'not a model').ok).toBe(false);
    expect(validateSetting('CHAT_FALLBACK_MODELS', 'a/b, c/d')).toEqual({ ok: true, value: 'a/b,c/d' });
    expect(validateSetting('OPENROUTER_API_KEY', 'sk-x').ok).toBe(false);
  });

  it('applies a change live over .env, persists it, and resets back to .env', () => {
    vi.stubEnv('GATE_THRESHOLD', '0.6');
    expect(config.gate.threshold).toBe(0.6);

    const changed = changeSetting('GATE_THRESHOLD', '0.9', OWNER, 1);
    expect(changed).toMatchObject({ ok: true, change: { before: '0.6 (from .env)', after: '0.9 (live override)' } });
    expect(config.gate.threshold).toBe(0.9);

    // A restart: the override comes back from bot.db.
    clearConfigOverrides();
    expect(config.gate.threshold).toBe(0.6);
    expect(loadRuntimeSettings()).toEqual(['GATE_THRESHOLD']);
    expect(config.gate.threshold).toBe(0.9);

    changeSetting('GATE_THRESHOLD', undefined, OWNER);
    expect(config.gate.threshold).toBe(0.6);
    clearConfigOverrides();
    expect(loadRuntimeSettings()).toEqual([]);
  });

  it('skips a saved value that is no longer valid', () => {
    changeSetting('GATE_ENABLED', 'false', OWNER);
    botDb.stmt("UPDATE runtime_settings SET value = 'garbage'").run();
    clearConfigOverrides();
    expect(loadRuntimeSettings()).toEqual([]);
    expect(config.gate.enabled).toBe(true);
  });
});

describe('settings tools', () => {
  it('are registered in the chat tool surface', () => {
    expect(toolDefinitions.some((t) => t.name === 'change_setting')).toBe(true);
    expect(toolDefinitions.some((t) => t.name === 'list_settings')).toBe(true);
  });

  it('refuses anyone but the owner', async () => {
    expect(await changeTool.handler(ctx(MEMBER), { name: 'GATE_ENABLED', value: 'false' })).toMatch(/^Refused/);
    expect(await listTool.handler(ctx(MEMBER), {})).toMatch(/^Refused/);
    expect(config.gate.enabled).toBe(true);
  });

  it('lets the owner list and change settings', async () => {
    expect(await listTool.handler(ctx(OWNER), {})).toContain('GATE_ENABLED = default');

    const answer = await changeTool.handler(ctx(OWNER), { name: 'gate_enabled', value: 'false' });
    expect(answer).toContain('Changed GATE_ENABLED: default → false (live override)');
    expect(answer).toContain('applies right away');
    expect(config.gate.enabled).toBe(false);

    expect(await changeTool.handler(ctx(OWNER), { name: 'MEMORY_DREAM_MODEL', value: 'x' })).toMatch(/^Not changed/);
    expect(await changeTool.handler(ctx(OWNER), { name: 'CHAT_MODEL', value: 'a/b' })).toContain('after the next restart');

    expect(await changeTool.handler(ctx(OWNER), { name: 'GATE_ENABLED', reset: true })).toContain('→ default');
    expect(config.gate.enabled).toBe(true);
  });
});
