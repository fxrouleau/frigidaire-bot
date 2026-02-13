import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import { extractImageFromResponse } from './localImageGenerator';

function makeResponse(overrides: Partial<OpenAI.ChatCompletion['choices'][0]['message']>): OpenAI.ChatCompletion {
  return {
    id: 'test',
    object: 'chat.completion',
    created: Date.now(),
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          ...overrides,
        },
      },
    ],
  };
}

describe('extractImageFromResponse', () => {
  it('extracts base64 from data URL in content string', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
    const result = extractImageFromResponse(
      makeResponse({ content: `data:image/png;base64,${base64}` }),
    );
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('extracts from images array field', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({ content: 'Here is your image' });
    // Attach custom images field
    (response.choices[0].message as unknown as Record<string, unknown>).images = [base64];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
    expect(result!.text).toBe('Here is your image');
  });

  it('extracts from content blocks with image_url type', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({});
    (response.choices[0].message as unknown as Record<string, unknown>).content = [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('extracts from content blocks with image type + data field', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAE=';
    const response = makeResponse({});
    (response.choices[0].message as unknown as Record<string, unknown>).content = [
      { type: 'image', data: base64 },
    ];
    const result = extractImageFromResponse(response);
    expect(result).toBeDefined();
    expect(result!.base64).toBe(base64);
  });

  it('returns undefined for text-only content', () => {
    const result = extractImageFromResponse(
      makeResponse({ content: 'Just some text, no image here.' }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty/missing message', () => {
    const response: OpenAI.ChatCompletion = {
      id: 'test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'test-model',
      choices: [],
    };
    expect(extractImageFromResponse(response)).toBeUndefined();
  });
});
