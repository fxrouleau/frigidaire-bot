import { describe, expect, it } from 'vitest';
import type { GitHubIssue } from './client';
import { MAX_CANDIDATES, closedResolution, isEligible, matchIssues, searchTerms } from './issueMatching';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK = 90 * DAY_MS;

function issue(number: number, title: string, extra: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number,
    title,
    htmlUrl: `https://github.com/owner/repo/issues/${number}`,
    labels: [],
    state: 'open',
    body: '',
    locked: false,
    isPullRequest: false,
    ...extra,
  };
}

function closed(number: number, title: string, reason: string | undefined, daysAgo: number, body = ''): GitHubIssue {
  return issue(number, title, { state: 'closed', stateReason: reason, closedAt: NOW - daysAgo * DAY_MS, body });
}

const opts = { now: NOW, closedLookbackMs: LOOKBACK };

describe('searchTerms', () => {
  it('sends the title’s content words, not the request filler', () => {
    expect(searchTerms('Add a remindme command for the bot')).toBe('remindme command');
    expect(searchTerms('Please add')).toBe('');
  });
});

describe('isEligible / closedResolution', () => {
  it('keeps open issues and issues closed within the lookback, never duplicates or pull requests', () => {
    expect(isEligible(issue(1, 'a'), NOW, LOOKBACK)).toBe(true);
    expect(isEligible(closed(2, 'a', 'completed', 89), NOW, LOOKBACK)).toBe(true);
    expect(isEligible(closed(3, 'a', 'completed', 91), NOW, LOOKBACK)).toBe(false);
    expect(isEligible(closed(4, 'a', 'duplicate', 1), NOW, LOOKBACK)).toBe(false);
    expect(isEligible(issue(5, 'a', { isPullRequest: true }), NOW, LOOKBACK)).toBe(false);
    expect(isEligible(issue(6, 'a', { state: 'closed', stateReason: 'completed' }), NOW, LOOKBACK)).toBe(false);
    // A lookback of 0 turns the closed-issue check off.
    expect(isEligible(closed(7, 'a', 'completed', 1), NOW, 0)).toBe(false);
  });

  it('maps GitHub’s close reasons to what the member is told', () => {
    expect(closedResolution(closed(1, 'a', 'completed', 1))).toBe('done');
    expect(closedResolution(closed(1, 'a', 'not_planned', 1))).toBe('declined');
    expect(closedResolution(closed(1, 'a', 'duplicate', 1))).toBe('duplicate');
    expect(closedResolution(closed(1, 'a', undefined, 1))).toBe('closed');
  });
});

describe('matchIssues', () => {
  it('takes a near-identical open title as an automatic duplicate', () => {
    const result = matchIssues('Add a reminder command', { open: [issue(7, 'Reminder command')], searchHits: [] }, opts);
    expect(result.automatic?.number).toBe(7);
    expect(result.candidates).toEqual([]);
  });

  it('only a clear title match is automatic, and the closest one wins', () => {
    const open = [issue(1, 'Voice message transcription'), issue(2, 'Add reminder command'), issue(3, 'Reminder')];
    expect(matchIssues('Reminders', { open, searchHits: [] }, opts).automatic?.number).toBe(3);
    // Similar but not near-identical: a candidate for the model, not an automatic match.
    const voice = matchIssues('Transcribe voice messages', { open, searchHits: [] }, opts);
    expect(voice.automatic).toBeUndefined();
    expect(voice.candidates.map((c) => c.issue.number)).toEqual([1]);
    expect(matchIssues('Weather command', { open, searchHits: [] }, opts).automatic).toBeUndefined();
  });

  it('prefers a near-identical open issue over a closed one, and falls back to a recently closed one', () => {
    const done = closed(3, 'Reminder command', 'completed', 10);
    const open = issue(9, 'Reminders command');
    expect(matchIssues('Reminder command', { open: [open], searchHits: [done, open] }, opts).automatic?.number).toBe(9);
    expect(matchIssues('Reminder command', { open: [], searchHits: [done] }, opts).automatic?.number).toBe(3);
    // Too old to count: it is neither automatic nor a candidate.
    const old = closed(2, 'Reminder command', 'completed', 200);
    expect(matchIssues('Reminder command', { open: [], searchHits: [old] }, opts)).toEqual({ automatic: undefined, candidates: [] });
  });

  it('offers search hits that share a word with the request, and open issues with some title overlap', () => {
    const result = matchIssues(
      'Add polls with anonymous votes',
      {
        // #1 is not in the search results yet (the index lags a just-filed issue); #3 only shares one word.
        open: [issue(1, 'Anonymous polls'), issue(2, 'Weather command'), issue(3, 'Anonymous confessions channel')],
        searchHits: [issue(5, 'Voting feature', { body: '### What\nLet members run a poll.\n\n---\nfooter' })],
      },
      opts,
    );
    expect(result.automatic).toBeUndefined();
    expect(result.candidates.map((c) => c.issue.number).sort()).toEqual([1, 5]);
  });

  it('drops semantic neighbours that share no word with the request (semantic search always returns something)', () => {
    const result = matchIssues(
      'Add polls',
      { open: [], searchHits: [issue(4, 'Birthday announcements', { body: 'Post a message on birthdays.' })] },
      opts,
    );
    expect(result.candidates).toEqual([]);
  });

  it('does not count words from the bot’s own issue template as overlap', () => {
    const templated = issue(4, 'Birthday announcements', {
      body: '### What\nPost on birthdays.\n\n### Why\n_Not stated._\n\n---\nRequested by **X** on Discord · [jump to the request](https://discord.com/channels/1/2/3)',
    });
    expect(matchIssues('Discord jump links', { open: [], searchHits: [templated] }, opts).candidates).toEqual([]);
  });

  it('ranks by agreement between the search order and title similarity, top three only', () => {
    const hits = [
      issue(10, 'Poll results chart', { body: 'poll' }),
      issue(11, 'Scheduled poll reminders', { body: 'poll' }),
      issue(12, 'Polls', { body: 'poll' }),
      issue(13, 'Poll exports', { body: 'poll' }),
      issue(14, 'Emoji poll', { body: 'poll' }),
    ];
    const result = matchIssues('Anonymous polls', { open: [], searchHits: hits }, opts);
    expect(result.candidates).toHaveLength(MAX_CANDIDATES);
    // #12 is third in the search but by far the closest title, so it rises to the top.
    expect(result.candidates[0].issue.number).toBe(12);
    expect(result.candidates[0]).toMatchObject({ searchRank: 2 });
  });

  it('includes recently closed issues as candidates, but not closed duplicates', () => {
    const result = matchIssues(
      'Reminder snooze button',
      {
        open: [],
        searchHits: [closed(3, 'Reminder command', 'completed', 5), closed(4, 'Reminder snooze', 'duplicate', 5)],
      },
      opts,
    );
    expect(result.candidates.map((c) => c.issue.number)).toEqual([3]);
  });

  it('merges an issue found by both sources once, keeping its search rank', () => {
    const shared = issue(8, 'Poll command', { body: 'poll' });
    const result = matchIssues('Poll command options', { open: [shared], searchHits: [shared] }, opts);
    expect(result.automatic).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ searchRank: 0 });
  });
});
