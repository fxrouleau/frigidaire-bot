// A cheap regression guard for two hard rules: every OpenRouter call is attributed to a feature in the
// usage ledger (featureRequestOptions() on SDK calls, recordUsage() on raw requests), and every call that
// sends member content to a model is ZDR-routed (`provider: { zdr: true }`). It also pins one soft rule:
// a call that caps `max_tokens` either says its reasoning effort or has a cap big enough for an unasked
// reasoning pass (the default chat model reasons at 'max' unless told otherwise, and reasoning counts
// toward max_tokens, so a small cap comes back empty with finish_reason 'length'). It parses every production
// source file with TypeScript's own parser (so strings, comments and regexes can't fool it) and checks
// each OpenAI-SDK call site and each raw request to OpenRouter. When it fails, fix the call site; don't
// loosen the check.
// The parser comes from TypeScript 6's side-by-side package: TypeScript 7 (the `typescript` dependency, which
// builds and type-checks the project) ships no JavaScript API yet.
import fs from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.join(__dirname, '..');

// SDK methods that send member content to a model: tagged AND ZDR-routed.
const CONTENT_CALL = /\.(?:chat\.completions|completions|embeddings|responses)\.(?:create|parse|stream)$/;
// Any other SDK call that reaches OpenRouter: tagged (so the ledger never grows an "other" blind spot).
const OTHER_SDK_CALL =
  /\.(?:moderations|images|audio\.transcriptions|audio\.translations|audio\.speech)\.(?:create|generate|edit)$/;
// The OpenAI client's raw HTTP helpers (client.get('/models'), client.post('/audio/…')).
const RAW_CLIENT_CALL = /^(?:[\w.]+\.)?(?:client|openai)\.(?:get|post|put|patch|delete)$/i;
// Helpers that attribute a call's usage.
const USAGE_HELPERS = new Set(['featureRequestOptions', 'recordUsage', 'createUsageTrackingFetch']);
// Code that references OpenRouter's endpoints directly.
const OPENROUTER_IDENTIFIERS = new Set(['OPENROUTER_BASE_URL', 'DECISIONS_ENDPOINT']);
// Files that talk to OpenRouter without recording usage, and why that is fine.
const USAGE_EXEMPT: Record<string, string> = {
  'ai/modelCatalog.ts':
    'GET /models, /models/<id>/endpoints and /endpoints/zdr: public model metadata, free, no member content',
};
// The one file allowed to construct an OpenAI client: it installs the usage-tracking fetch.
const CLIENT_FACTORY = 'ai/openRouterClient.ts';
// A content call whose body caps max_tokens below this must send `reasoning` (e.g. { effort: 'low' }).
const UNREASONED_MIN_MAX_TOKENS = 4000;
// Files whose capped calls send no reasoning override, and why that is fine.
const REASONING_EXEMPT: Record<string, string> = {
  'ai/emojiCaptioner.ts':
    "EMOJI_CAPTION_MODEL defaults to Claude Opus, which doesn't reason unless asked: an effort would switch paid thinking on",
};

type CallSite = { file: string; line: number; callee: string; kind: 'content' | 'sdk' | 'raw' };
type Audit = { calls: CallSite[]; problems: string[]; referencesOpenRouter: boolean; recordsUsage: boolean };

function productionFiles(dir = SRC_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-support' ? [] : productionFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

const ZDR_OBJECT = /^\{[^}]*\bzdr\s*:\s*true\b/;

/** Whether a request body (the first argument of a content call) routes with `provider: { zdr: true }`. */
function bodyIsZdr(body: ts.Expression | undefined, sourceFile: ts.SourceFile): boolean {
  if (!body) return false;
  const expr = unwrap(body);
  if (ts.isObjectLiteralExpression(expr)) {
    const provider = expr.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sourceFile) === 'provider',
    );
    if (!provider) return false;
    const value = unwrap(provider.initializer);
    if (ts.isObjectLiteralExpression(value)) return ZDR_OBJECT.test(value.getText(sourceFile));
    // `provider: this.routing`: the field's default must be ZDR (`this.routing = opts.routing ?? { zdr: true }`).
    const name = ts.isPropertyAccessExpression(value) ? value.name.text : ts.isIdentifier(value) ? value.text : undefined;
    return name !== undefined && defaultsToZdr(name, sourceFile);
  }
  // A body built elsewhere in the file (`create(body as …)`): its declaration must be ZDR-routed.
  if (ts.isIdentifier(expr)) {
    const declaration = findDeclaration(expr.text, sourceFile);
    return declaration?.initializer !== undefined && bodyIsZdr(declaration.initializer, sourceFile);
  }
  return false;
}

function defaultsToZdr(field: string, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === field
    ) {
      const right = unwrap(node.right);
      const fallback =
        ts.isBinaryExpression(right) && right.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
          ? unwrap(right.right)
          : right;
      if (ts.isObjectLiteralExpression(fallback) && ZDR_OBJECT.test(fallback.getText(sourceFile))) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findDeclaration(name: string, sourceFile: ts.SourceFile): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** A request body as an object literal, following `create(body as …)` to the body's declaration. */
function bodyObject(body: ts.Expression | undefined, sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  if (!body) return undefined;
  const expr = unwrap(body);
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) return bodyObject(findDeclaration(expr.text, sourceFile)?.initializer, sourceFile);
  return undefined;
}

/** A numeric literal, or a file-level constant holding one (`const MAX_TOKENS = 4_000`). */
function numericValue(node: ts.Expression, sourceFile: ts.SourceFile): number | undefined {
  const expr = unwrap(node);
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ''));
  if (ts.isIdentifier(expr)) {
    const initializer = findDeclaration(expr.text, sourceFile)?.initializer;
    return initializer ? numericValue(initializer, sourceFile) : undefined;
  }
  return undefined;
}

/**
 * Why a body's max_tokens cap is unsafe on a reasoning model, or undefined: no cap, a `reasoning` field
 * (directly or in a spread, as in `...(effort ? { reasoning: { effort } } : {})`), or a cap known to be at
 * least UNREASONED_MIN_MAX_TOKENS. A cap the scanner can't read counts as small.
 */
function unreasonedCap(body: ts.Expression | undefined, sourceFile: ts.SourceFile): string | undefined {
  const object = bodyObject(body, sourceFile);
  if (!object) return undefined;
  let cap: ts.PropertyAssignment | undefined;
  let reasoning = false;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = property.name.getText(sourceFile);
      if (name === 'max_tokens') cap = property;
      if (name === 'reasoning') reasoning = true;
    } else if (ts.isSpreadAssignment(property) && /\breasoning\s*:/.test(property.expression.getText(sourceFile))) {
      reasoning = true;
    }
  }
  if (!cap || reasoning) return undefined;
  const value = numericValue(cap.initializer, sourceFile);
  if (value !== undefined && value >= UNREASONED_MIN_MAX_TOKENS) return undefined;
  return value !== undefined ? String(value) : cap.initializer.getText(sourceFile);
}

function calleeName(call: ts.CallExpression, sourceFile: ts.SourceFile): string {
  return call.expression.getText(sourceFile).replace(/\s+/g, '');
}

/** Audits one file's source. Exported shape kept small so the scanner itself can be tested below. */
function auditSource(file: string, text: string): Audit {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const audit: Audit = { calls: [], problems: [], referencesOpenRouter: false, recordsUsage: false };
  const where = (node: ts.Node) => `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node, sourceFile);
      if (USAGE_HELPERS.has(callee)) audit.recordsUsage = true;
      const kind = CONTENT_CALL.test(callee)
        ? 'content'
        : OTHER_SDK_CALL.test(callee)
          ? 'sdk'
          : RAW_CLIENT_CALL.test(callee)
            ? 'raw'
            : undefined;
      if (kind) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        audit.calls.push({ file, line, callee, kind });
        const args = node.arguments.map((a) => a.getText(sourceFile)).join('\n');
        if (!/\bfeatureRequestOptions\s*\(/.test(args)) {
          audit.problems.push(
            `${where(node)} ${callee}(…) has no featureRequestOptions('<feature>') in its arguments: its spend would land in the ledger as 'other'.`,
          );
        }
        if (kind === 'content' && !bodyIsZdr(node.arguments[0], sourceFile)) {
          audit.problems.push(`${where(node)} ${callee}(…) is not visibly routed with provider: { zdr: true }.`);
        }
        const cap = kind === 'content' && !(file in REASONING_EXEMPT) && unreasonedCap(node.arguments[0], sourceFile);
        if (cap) {
          audit.problems.push(
            `${where(node)} ${callee}(…) caps max_tokens at ${cap} without a reasoning override: a model that reasons at 'max' by default can spend it all before answering. Send reasoning: { effort: 'low' } (bridged through the body type) or a cap of at least ${UNREASONED_MIN_MAX_TOKENS}.`,
          );
        }
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === 'OpenAI' && file !== CLIENT_FACTORY) {
      audit.problems.push(
        `${where(node)} builds its own OpenAI client: use getOpenRouterClient()/createOpenRouterClient() (usage tracking, house timeouts).`,
      );
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) &&
      node.text.includes('openrouter.ai')
    ) {
      audit.referencesOpenRouter = true;
    }
    if (ts.isIdentifier(node) && OPENROUTER_IDENTIFIERS.has(node.text)) audit.referencesOpenRouter = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (audit.referencesOpenRouter && !audit.recordsUsage && !(file in USAGE_EXEMPT)) {
    audit.problems.push(
      `${file} calls OpenRouter directly without recording usage: report each response through recordUsage() (see src/ai/decisions.ts).`,
    );
  }
  return audit;
}

function auditTree(): { calls: CallSite[]; problems: string[] } {
  const calls: CallSite[] = [];
  const problems: string[] = [];
  for (const full of productionFiles()) {
    const file = path.relative(SRC_DIR, full).split(path.sep).join('/');
    const audit = auditSource(file, fs.readFileSync(full, 'utf8'));
    calls.push(...audit.calls);
    problems.push(...audit.problems);
  }
  return { calls, problems };
}

describe('OpenRouter call sites', () => {
  const { calls, problems } = auditTree();

  it('are all tagged with a feature, ZDR-routed, and leave room for reasoning under a max_tokens cap', () => {
    expect(problems).toEqual([]);
  });

  it('are actually found (the scanner is not silently matching nothing)', () => {
    const files = new Set(calls.map((c) => c.file));
    for (const known of [
      'ai/providers/openRouterProvider.ts',
      'ai/memory/embeddingProvider.ts',
      'ai/tools/summary.ts',
      'ai/media/modelCall.ts',
      'archive/wrapped.ts',
      'commands/completion.ts',
    ]) {
      expect(files, known).toContain(known);
    }
    expect(calls.filter((c) => c.kind === 'content').length).toBeGreaterThanOrEqual(10);
    expect(calls.some((c) => c.kind === 'raw')).toBe(true);
  });
});

/** The members of the `UsageFeature` union in usage.ts. */
function usageFeatures(): string[] {
  const text = fs.readFileSync(path.join(SRC_DIR, 'ai/usage.ts'), 'utf8');
  const sourceFile = ts.createSourceFile('ai/usage.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alias = sourceFile.statements.find(
    (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'UsageFeature',
  );
  if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error('UsageFeature is no longer a union in ai/usage.ts');
  return alias.type.types.flatMap((t) =>
    ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : [],
  );
}

/** Every string literal in value position (not in a type) across the production files. */
function valueStrings(): Set<string> {
  const found = new Set<string>();
  for (const full of productionFiles()) {
    const sourceFile = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isLiteralTypeNode(node.parent)) {
        found.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

describe('usage features', () => {
  it('are each used by some code (a feature nothing tags with is dead weight in the ledger and the digest)', () => {
    const features = usageFeatures();
    expect(features).toContain('chat');
    const used = valueStrings();
    expect(features.filter((f) => !used.has(f))).toEqual([]);
  });
});

describe('the call-site scanner', () => {
  it('flags an untagged call, a non-ZDR body, a hand-built client and an unrecorded raw request', () => {
    const audit = auditSource(
      'ai/example.ts',
      `
      const client = new OpenAI({ apiKey: 'k' });
      // featureRequestOptions('chat') in a comment does not count
      await client.chat.completions.create({ model, messages, provider: { zdr: true } });
      await client.chat.completions.create({ model, messages }, featureRequestOptions('chat'));
      await client.embeddings.create({ model, input, provider: { sort: 'price' } }, featureRequestOptions('embedding'));
      `,
    );
    expect(audit.calls.map((c) => c.kind)).toEqual(['content', 'content', 'content']);
    expect(audit.problems).toHaveLength(4);
    expect(audit.problems[0]).toMatch(/builds its own OpenAI client/);
    expect(audit.problems[1]).toMatch(/:4 client\.chat\.completions\.create\(…\) has no featureRequestOptions/);
    expect(audit.problems[2]).toMatch(/:5 .* is not visibly routed with provider: \{ zdr: true \}/);
    expect(audit.problems[3]).toMatch(/:6 client\.embeddings\.create\(…\) is not visibly routed/);

    const raw = auditSource(
      'ai/rawExample.ts',
      "await fetch(`${OPENROUTER_BASE_URL}/whatever`, { method: 'POST' });\nawait fetch('https://openrouter.ai/api/v1/x');",
    );
    expect(raw.problems).toEqual([
      'ai/rawExample.ts calls OpenRouter directly without recording usage: report each response through recordUsage() (see src/ai/decisions.ts).',
    ]);
  });

  it('flags a small or unreadable max_tokens cap without a reasoning override', () => {
    const audit = auditSource(
      'ai/example.ts',
      `
      const SMALL = 600;
      await client.chat.completions.create({ model, max_tokens: 200, provider: { zdr: true } }, featureRequestOptions('x'));
      await client.chat.completions.create({ model, max_tokens: SMALL, provider: { zdr: true } }, featureRequestOptions('x'));
      await client.chat.completions.create({ model, max_tokens: opts.cap, provider: { zdr: true } }, featureRequestOptions('x'));
      `,
    );
    expect(audit.problems).toHaveLength(3);
    expect(audit.problems[0]).toMatch(/:3 client\.chat\.completions\.create\(…\) caps max_tokens at 200 without a reasoning override/);
    expect(audit.problems[1]).toMatch(/:4 .* caps max_tokens at 600 without/);
    expect(audit.problems[2]).toMatch(/:5 .* caps max_tokens at opts\.cap without/);
  });

  it('accepts a capped call that sets reasoning (directly, through its body, or in a spread) or a big cap', () => {
    const audit = auditSource(
      'ai/example.ts',
      `
      const BIG = 4_000;
      const body: Body = { model, max_tokens: 200, reasoning: { effort: 'low' }, provider: { zdr: true } };
      await client.chat.completions.create(body as unknown as Params, featureRequestOptions('x'));
      await client.chat.completions.create(
        { model, max_tokens: req.max, ...(effort ? { reasoning: { effort } } : {}), provider: { zdr: true } },
        featureRequestOptions('x'),
      );
      await client.chat.completions.create({ model, max_tokens: BIG, provider: { zdr: true } }, featureRequestOptions('x'));
      await client.chat.completions.create({ model, provider: { zdr: true } }, featureRequestOptions('x'));
      `,
    );
    expect(audit.problems).toEqual([]);
    expect(auditSource('ai/emojiCaptioner.ts', "await o.chat.completions.create({ max_tokens: 1, provider: { zdr: true } }, featureRequestOptions('x'));").problems).toEqual([]);
  });

  it('accepts the shapes the code base uses', () => {
    const audit = auditSource(
      'ai/example.ts',
      `
      class P {
        constructor(opts) { this.routing = opts.routing ?? { zdr: true, sort: 'throughput' }; }
        run() { return this.client.chat.completions.create({ model, provider: this.routing }, featureRequestOptions('chat')); }
      }
      const body: Body = { model, messages, provider: { zdr: true } };
      await req.client.chat.completions.create(body as unknown as Params, { ...featureRequestOptions('video'), timeout: 1 });
      await client.get<{ data?: unknown }>('/models', { ...featureRequestOptions('other') });
      await fetch(DECISIONS_ENDPOINT, { body: JSON.stringify({ provider: { zdr: true } }) });
      recordUsage(entry);
      `,
    );
    expect(audit.calls.map((c) => c.kind)).toEqual(['content', 'content', 'raw']);
    expect(audit.problems).toEqual([]);
  });
});
