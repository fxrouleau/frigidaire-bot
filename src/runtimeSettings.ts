// Live settings: the owner asks the bot, in chat, to change one of its own environment values ("turn the gate
// off", "put birthdays on", "dream with another model") and the change applies without a redeploy. Each
// change is a config override (src/config.ts, consulted before process.env), persisted in bot.db
// (`runtime_settings`) and reapplied at startup, so it outlives restarts until it is reset, which falls back
// to the .env value again.
//
// Deliberately narrow: only the settings listed here (feature switches, thresholds, models), never secrets,
// tokens, URLs, ids or who the owner is, and every value is validated against the same rules config.ts
// parses with, so a typo is refused instead of silently falling back to the default. A few settings are read
// once at startup (the chat model is fixed when the provider is built): those say so and apply after a
// restart.
import { configSource, DREAM_REASONING_EFFORTS, setConfigOverride } from './config';
import { logger } from './logger';
import { getBotDb } from './storage/botDb';

type SettingKind =
  | { kind: 'bool' }
  | { kind: 'int' | 'number'; min: number; max?: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'model' }
  | { kind: 'models' };

export type SettingSpec = SettingKind & {
  description: string;
  /** Read once at startup: a change applies after the next restart. */
  restart?: boolean;
};

const MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** Every setting the bot may change on its own, by environment variable name. */
export const RUNTIME_SETTINGS: Record<string, SettingSpec> = {
  // Models
  CHAT_MODEL: { kind: 'model', description: 'the chat model (must read images)', restart: true },
  CHAT_FALLBACK_MODELS: { kind: 'models', description: 'csv of chat fallback models', restart: true },
  LEARNER_MODEL: { kind: 'model', description: 'memory capture model' },
  IMAGE_MODEL: { kind: 'model', description: 'generate_image model' },
  VIDEO_MODEL: { kind: 'model', description: 'the model that watches videos' },
  EMOJI_USAGE_CAPTION_MODEL: { kind: 'model', description: 'the model that re-grounds emoji meanings from usage' },
  MEMORY_DREAM_MODEL: { kind: 'model', description: 'the nightly dream model (edits and bootstrap default to it)' },
  MEMORY_DREAM_REASONING: {
    kind: 'enum',
    values: DREAM_REASONING_EFFORTS,
    description: 'reasoning effort for the dream/edits/bootstrap (off for models that only think when asked)',
  },
  MEMORY_EDIT_MODEL: { kind: 'model', description: "the owner's note edits model" },
  // Memory
  MEMORY_DREAM_ENABLED: { kind: 'bool', description: 'the nightly dream' },
  MEMORY_DREAM_HOUR: { kind: 'int', min: 0, max: 23, description: 'Eastern hour the dream runs from' },
  MEMORY_DREAM_MAX_PEOPLE_PER_NIGHT: { kind: 'int', min: 1, max: 500, description: 'people dreamed per night' },
  MEMORY_DREAM_REPORT: { kind: 'bool', description: 'the dream report line' },
  SELF_IMPROVEMENT_ENABLED: { kind: 'bool', description: 'the self-improvement pass' },
  // Gate and ramble
  GATE_ENABLED: { kind: 'bool', description: 'replying without a mention' },
  GATE_THRESHOLD: { kind: 'number', min: 0, max: 1, description: 'gate decision probability needed' },
  GATE_FOLLOWUP_SECONDS: { kind: 'int', min: 0, max: 3600, description: 'active-exchange window after an answer' },
  GATE_MAX_COLD_PER_10MIN: { kind: 'int', min: 0, max: 100, description: 'cold name-drop replies per 10 min' },
  GATE_MAX_PER_10MIN: { kind: 'int', min: 0, max: 200, description: 'unprompted replies per 10 min' },
  RAMBLE_THRESHOLD: { kind: 'number', min: 0, max: 1, description: 'ramble judge confidence needed' },
  RAMBLE_COOLDOWN_MINUTES: { kind: 'number', min: 0, max: 100_000, description: 'per-member ramble nudge cooldown' },
  // Reactions, birthdays, deleted messages
  AUTO_REACT_MODE: { kind: 'enum', values: ['off', 'shadow', 'on'], description: 'spontaneous reactions' },
  AUTO_REACT_MAX_PER_DAY: { kind: 'int', min: 0, max: 100, description: 'spontaneous reactions per 24 h' },
  AUTO_REACT_MIN_GAP_MINUTES: { kind: 'number', min: 0, max: 1440, description: 'minutes between reactions' },
  BIRTHDAY_ANNOUNCE_MODE: {
    kind: 'enum',
    values: ['off', 'shadow', 'on'],
    description: 'birthday announcements (shadow = report channel only)',
  },
  BIRTHDAY_ANNOUNCE_HOUR: { kind: 'int', min: 0, max: 23, description: 'Eastern hour birthdays are announced from' },
  DELETE_REPOST_MODE: { kind: 'enum', values: ['edgy', 'always'], description: 'deleted-message reposts' },
  DELETE_REPOST_VISION_MODEL: {
    kind: 'model',
    description: 'the model that judges what a deleted message showed (must read images)',
  },
  // Media and links
  VOICE_AUTO_TRANSCRIBE: { kind: 'bool', description: 'transcript replies to voice messages' },
  VIDEO_DAILY_BUDGET_USD: { kind: 'number', min: 0, max: 100, description: 'daily video spend cap (0 = none)' },
  LINK_PREVIEWS_ENABLED: { kind: 'bool', description: 'automatic link previews' },
  LINK_READER_WATCH_VIDEOS: { kind: 'bool', description: 'read_link watches videos' },
  LINK_FIX_VERIFY: { kind: 'bool', description: 'probe link fixers before rewriting' },
  LINK_FIX_ALERTS: { kind: 'bool', description: 'fixer outage alerts' },
  // Misc
  WRAPPED_LLM_INTRO: { kind: 'bool', description: "Wrapped's roast-y intro line" },
  REMINDERS_MAX_PER_USER: { kind: 'int', min: 1, max: 1000, description: 'pending reminders per member' },
  FEATURE_REQUEST_MAX_PER_DAY: { kind: 'int', min: 1, max: 100, description: 'feature requests per member per day' },
  LOG_DEBUG: { kind: 'bool', description: 'noisy debug logging' },
};

const BOOL_VALUES = new Set(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off']);

/** The value normalized as config.ts will read it, or an error the model can relay. */
export function validateSetting(name: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const spec = RUNTIME_SETTINGS[name];
  if (!spec) return { ok: false, error: `${name} is not a setting I can change.` };
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return { ok: false, error: 'Give a value, or reset the setting instead.' };
  switch (spec.kind) {
    case 'bool':
      if (!BOOL_VALUES.has(value.toLowerCase())) return { ok: false, error: `${name} takes true or false.` };
      return { ok: true, value: value.toLowerCase() };
    case 'int':
    case 'number': {
      const n = Number(value);
      const bounds = `${spec.min}..${spec.max ?? '∞'}`;
      if (!Number.isFinite(n) || (spec.kind === 'int' && !Number.isInteger(n))) {
        return {
          ok: false,
          error: `${name} takes ${spec.kind === 'int' ? 'a whole number' : 'a number'} (${bounds}).`,
        };
      }
      if (n < spec.min || (spec.max !== undefined && n > spec.max)) {
        return { ok: false, error: `${name} must be within ${bounds}.` };
      }
      return { ok: true, value: String(n) };
    }
    case 'enum':
      if (!spec.values.includes(value.toLowerCase())) {
        return { ok: false, error: `${name} takes one of: ${spec.values.join(', ')}.` };
      }
      return { ok: true, value: value.toLowerCase() };
    case 'model':
      if (!MODEL_ID.test(value)) return { ok: false, error: `${name} takes an OpenRouter model id like vendor/model.` };
      return { ok: true, value };
    case 'models': {
      const ids = value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length === 0 || ids.some((id) => !MODEL_ID.test(id))) {
        return { ok: false, error: `${name} takes a comma-separated list of OpenRouter model ids.` };
      }
      return { ok: true, value: ids.join(',') };
    }
  }
}

// ---- Persistence (bot.db) ----

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runtime_settings (
    name       TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_by TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function db() {
  const botDb = getBotDb();
  botDb.ensureSchema('runtime_settings', SCHEMA);
  return botDb;
}

/**
 * Applies the saved overrides (at startup, before the Effective config line). A saved value that is no
 * longer allowed or valid (the list or its rules changed) is skipped with a WARN and left in place.
 * Returns the names applied.
 */
export function loadRuntimeSettings(): string[] {
  let rows: Array<{ name: string; value: string }>;
  try {
    rows = db().stmt('SELECT name, value FROM runtime_settings ORDER BY name').all() as typeof rows;
  } catch (error) {
    logger.warn('runtime settings: could not read the saved settings:', error);
    return [];
  }
  const applied: string[] = [];
  for (const row of rows) {
    const checked = validateSetting(row.name, row.value);
    if (!checked.ok) {
      logger.warn(`runtime settings: ignoring saved ${row.name}=${row.value}: ${checked.error}`);
      continue;
    }
    setConfigOverride(row.name, checked.value);
    applied.push(row.name);
  }
  if (applied.length > 0)
    logger.info(`runtime settings: applied ${applied.length} live override(s): ${applied.join(', ')}`);
  return applied;
}

export type SettingChange = { name: string; before: string; after: string; restart: boolean };

/** What a setting reads as now: the override, the .env value, or "default". */
export function describeCurrent(name: string): string {
  const source = configSource(name);
  if (source.override !== undefined) return `${source.override} (live override)`;
  if (source.env !== undefined && source.env.trim() !== '') return `${source.env} (from .env)`;
  return 'default';
}

/** Sets a live override (validated, saved, applied). `value` undefined resets it to the .env value. */
export function changeSetting(
  name: string,
  value: string | undefined,
  updatedBy: string,
  now: number = Date.now(),
): { ok: true; change: SettingChange } | { ok: false; error: string } {
  const spec = RUNTIME_SETTINGS[name];
  if (!spec) return { ok: false, error: `${name} is not a setting I can change.` };
  const before = describeCurrent(name);
  if (value === undefined) {
    db().stmt('DELETE FROM runtime_settings WHERE name = ?').run(name);
    setConfigOverride(name, undefined);
  } else {
    const checked = validateSetting(name, value);
    if (!checked.ok) return checked;
    db()
      .stmt(
        `INSERT INTO runtime_settings (name, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(name, checked.value, updatedBy, now);
    setConfigOverride(name, checked.value);
  }
  return { ok: true, change: { name, before, after: describeCurrent(name), restart: spec.restart === true } };
}

/** One line per changeable setting with its current value, for the list tool. */
export function listSettings(): string[] {
  return Object.entries(RUNTIME_SETTINGS).map(([name, spec]) => {
    const accepts =
      spec.kind === 'enum'
        ? spec.values.join('|')
        : spec.kind === 'int' || spec.kind === 'number'
          ? `${spec.min}..${spec.max ?? '∞'}`
          : spec.kind === 'bool'
            ? 'true|false'
            : spec.kind === 'model'
              ? 'model id'
              : 'csv of model ids';
    return `${name} = ${describeCurrent(name)} · ${accepts} · ${spec.description}${spec.restart ? ' (applies after a restart)' : ''}`;
  });
}
