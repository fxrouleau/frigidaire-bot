// A cheap regression guard for two hard rules: every OpenRouter call is attributed to a feature in the
// usage ledger (featureRequestOptions() on SDK calls, recordUsage() on raw requests), and every call that
// sends member content to a model is ZDR-routed (`provider: { zdr: true }`). It parses every production
// source file with TypeScript's own parser (so strings, comments and regexes can't fool it) and checks
// each OpenAI-SDK call site and each raw request to OpenRouter. When it fails, fix the call site; don't
// loosen the check.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
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

  it('are all tagged with a feature and ZDR-routed', () => {
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
