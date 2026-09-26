// Live, paid, opt-in check of the ramble judge against the real OpenRouter API (the configured
// CHAT_MODEL, ZDR-only routing, reasoning effort 'low'). SKIPPED unless RUN_LIVE=1 and OPENROUTER_API_KEY
// are set.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// Two judge calls on synthetic, fictional chat: a fraction of a cent. It checks that the model answers
// in the JSON shape the parser reads (a verdict, not prose or an empty reasoning-only reply) and that an
// obvious ramble and an obvious normal exchange land on opposite sides; the logged confidences are what
// RAMBLE_THRESHOLD is tuned against.
import { describe, expect, it } from 'vitest';
import type { RambleExamples } from './rambleExamples';
import { createChatRambleJudge } from './rambleJudge';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;

const EXAMPLES: RambleExamples = {
  rambles: [
    'ok so what if clouds are just sky sheep\nand the sun is the shepherd\nand rain is when the sheep get sheared\nnobody talks about this',
    "you ever think about how spoons have been the same shape for 2000 years\nlike we went to the moon but the spoon? untouched\nthe spoon is finished technology\nthe spoon cartel doesn't want you to know",
  ],
  ramblesAreTheirs: true,
  normal: ['down for ranked at 9', 'lmao kev you are washed', 'who has the aux tonight', 'the new patch is fine tbh'],
};

describe.skipIf(!RUN_LIVE)('ramble judge live (paid, opt-in)', () => {
  const judge = createChatRambleJudge();

  it('calls a stream-of-consciousness run a ramble and a normal exchange not one', async () => {
    const ramble = await judge({
      author: 'Gus',
      before: [{ author: 'Kev', text: 'anyone up for ranked' }],
      run: [
        { text: 'ok hear me out' },
        { text: 'pigeons. nobody has ever seen a baby pigeon' },
        { text: 'and the moon landing happened the same year the first pigeon census stopped. coincidence?' },
        { text: 'i think the pigeons were the cameramen' },
        { text: "that's why they bob their heads. they're still filming" },
      ],
      examples: EXAMPLES,
    });
    const normal = await judge({
      author: 'Gus',
      before: [{ author: 'Kev', text: 'who is down for ranked at 9?' }],
      run: [{ text: 'me' }, { text: 'but only if we duo' }, { text: 'i am not playing support again' }],
      examples: EXAMPLES,
    });
    console.log(`CALIBRATION ramble judge: ramble=${JSON.stringify(ramble)} normal=${JSON.stringify(normal)}`);

    expect(ramble?.ramble).toBe(true);
    expect(normal?.ramble).toBe(false);
  }, 90_000);
});
