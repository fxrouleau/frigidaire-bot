// Live, paid, opt-in checks of the auto-react judge on the real chat model (CHAT_MODEL, ZDR) and of the
// usage-grounded caption call on the caption model (EMOJI_CAPTION_MODEL). SKIPPED unless both RUN_LIVE=1
// and OPENROUTER_API_KEY are set. Three short calls: about a cent per run, mostly the caption model.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// The judge's bar is a judgement call, so these only pin what must hold for any sane model: a parseable
// verdict, "no" for plain logistics, and a usable "for …" phrase. Grep LIVE-AUTOREACT for what it said.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { describeEmojiUsage } from '../ai/emojiCaptioner';
import type { ReactionGuide } from './guide';
import { createAutoReactJudge } from './judge';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const LIVE_TIMEOUT = 90_000;

const GUIDE: ReactionGuide = {
  messages: 20_000,
  reactedMessages: 2_400,
  baseRate: 0.12,
  emojis: [],
  text: [
    'About 12% of member posts here get any reaction at all (2400 of 20000).',
    'Their reactions, most used first — emoji (times used): posts it landed on',
    '- 😂 (900×) — "I tried to parallel park and hit the same hydrant twice" · "my cat just knocked my laptop into the bath"',
    '- 💀 (500×) — "he asked the waiter for a to-go box for his drink"',
    '- 🔥 (200×) — "got the job!!!"',
  ].join('\n'),
  builtAt: 0,
};

describe.skipIf(!RUN_LIVE)('auto-react and usage captions (live, paid, opt-in)', () => {
  const judge = createAutoReactJudge();

  it(
    'does not react to plain logistics',
    async () => {
      const verdict = await judge({
        guide: GUIDE,
        context: [{ author: 'Dale', text: 'who is bringing chairs saturday' }],
        post: { author: 'Remi', text: 'I can bring 2 chairs, leaving around 6', notes: [], images: [] },
      });
      console.log('LIVE-AUTOREACT logistics:', JSON.stringify(verdict));
      expect(verdict).toBeDefined();
      expect(verdict?.react).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    'returns a parseable verdict for a standout post',
    async () => {
      const verdict = await judge({
        guide: GUIDE,
        context: [{ author: 'Dale', text: 'how did the driving test go' }],
        post: {
          author: 'Remi',
          text: 'failed the driving test before leaving the parking lot. reversed into the examiner’s own car',
          notes: ['[reactions so far: 😂×2]'],
          images: [],
        },
      });
      console.log('LIVE-AUTOREACT standout:', JSON.stringify(verdict));
      expect(verdict).toBeDefined();
      if (verdict?.react) expect(verdict.emoji).toBeTruthy();
    },
    LIVE_TIMEOUT,
  );

  it(
    'writes a "for …" usage phrase from real-looking uses',
    async () => {
      // A drawn stand-in for the emoji image: no real server emoji in a public repo.
      const face = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#f5c542' } })
        .png()
        .toBuffer();
      const phrase = await describeEmojiUsage({
        id: '1000000000000000000',
        imageUrl: `data:image/png;base64,${face.toString('base64')}`,
        name: 'sadcat',
        animated: false,
        caption: 'crying cat with big eyes; for sadness, pleading',
        uses: [
          '- replying to "my flight got cancelled for the third time today": ":sadcat:"',
          '- replying to "the printer is on fire. again.": ":sadcat:"',
          '- reacted to: "they renamed the team for the fourth time this year"',
          '- in a message: "of course the one day I forget my umbrella :sadcat:"',
        ],
      });
      console.log('LIVE-AUTOREACT usage phrase:', phrase);
      expect(phrase).toMatch(/^for /);
    },
    LIVE_TIMEOUT,
  );
});
