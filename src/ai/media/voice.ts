// Which attachments on a Discord message are audio or video, and the small formatting helpers the
// enricher and the auto-transcript reply share.
import { type Attachment, type Message, MessageFlags } from 'discord.js';
import { attributeMessage } from '../../relay';
import { isAudioContentType, isVideoContentType } from './formats';

/** Discord's native voice message (the hold-to-record kind): one Ogg/Opus attachment with a duration. */
export function isVoiceMessage(message: Message): boolean {
  return message.flags?.has(MessageFlags.IsVoiceMessage) ?? false;
}

/**
 * Audio attachments: anything typed audio/*, plus — on a voice message — its attachment even when
 * Discord left the content type off.
 */
export function audioAttachments(message: Message): Attachment[] {
  const all = [...message.attachments.values()];
  if (isVoiceMessage(message)) {
    return all.filter((a) => isAudioContentType(a.contentType) || !a.contentType);
  }
  return all.filter((a) => isAudioContentType(a.contentType));
}

export function videoAttachments(message: Message): Attachment[] {
  return [...message.attachments.values()].filter((a) => isVideoContentType(a.contentType));
}

/**
 * The transcript cache key for an audio attachment. A voice message (and the common single-file case)
 * is keyed by the message id alone, which is what getCachedTranscript(messageId) reads; further audio
 * files on the same message get their own keys.
 */
export function transcriptKey(messageId: string, attachmentId: string, index: number): string {
  return index === 0 ? messageId : `${messageId}:${attachmentId}`;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatClock(totalSecs: number): string {
  const secs = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Who to credit for a recording: relays resolve to the member they were posted for. */
export function speakerName(message: Message): string {
  return (
    attributeMessage(message)?.authorName ??
    message.member?.displayName ??
    message.author.displayName ??
    message.author.username
  );
}
