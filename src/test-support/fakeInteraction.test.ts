// The fakes' reply state machine is what keeps command and viewer tests honest: a handler that would
// crash against Discord must crash against the fake too.
import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  createFakeButtonInteraction,
  createFakeModalSubmitInteraction,
  createFakeSelectInteraction,
  createFakeUserCommandInteraction,
} from './fakeInteraction';

const modal = { custom_id: 'nv:m:g:h', title: 'Edit', components: [] };

describe('component interactions', () => {
  it('update the message they are on, then allow edits and follow-ups', async () => {
    const { interaction, responses } = createFakeButtonInteraction({ customId: 'nv:pn:g:h:1:abc' });
    expect(interaction.isButton()).toBe(true);
    await interaction.update({ content: 'page 2' });
    await interaction.editReply({ content: 'page 2, edited' });
    await interaction.followUp({ content: 'psst', flags: MessageFlags.Ephemeral });
    expect(responses.map((r) => [r.method, r.content, r.ephemeral])).toEqual([
      ['update', 'page 2', true],
      ['editReply', 'page 2, edited', true],
      ['followUp', 'psst', true],
    ]);
  });

  it('respond only once', async () => {
    const { interaction } = createFakeSelectInteraction({ customId: 'nv:s:g:abc', values: ['j'] });
    expect(interaction.values).toEqual(['j']);
    await interaction.deferUpdate();
    await expect(interaction.update({ content: 'late' })).rejects.toMatchObject({ code: 'InteractionAlreadyReplied' });
    await expect(interaction.showModal(modal)).rejects.toMatchObject({ code: 'InteractionAlreadyReplied' });
    await expect(interaction.reply({ content: 'late' })).rejects.toMatchObject({ code: 'InteractionAlreadyReplied' });
  });

  it('have nothing to edit or follow up after showing a modal', async () => {
    const { interaction, responses } = createFakeButtonInteraction({ customId: 'nv:e:g:h:abc' });
    await interaction.showModal(modal);
    expect(responses[0]).toMatchObject({ method: 'showModal', options: modal });
    await expect(interaction.editReply({ content: 'x' })).rejects.toMatchObject({ code: 10008 });
    await expect(interaction.followUp({ content: 'x' })).rejects.toMatchObject({ code: 10008 });
  });

  it('need a response before editing', async () => {
    const { interaction } = createFakeButtonInteraction({ customId: 'nv:s:g:abc' });
    await expect(interaction.editReply({ content: 'x' })).rejects.toMatchObject({ code: 'InteractionNotReplied' });
  });
});

describe('modal submits', () => {
  it('read their fields and update the message the modal was opened from', async () => {
    const { interaction, responses } = createFakeModalSubmitInteraction({
      customId: 'nv:m:g:h',
      fields: { instruction: 'fix the lore' },
    });
    expect(interaction.isModalSubmit()).toBe(true);
    if (!interaction.isFromMessage()) throw new Error('expected a modal opened from a message');
    expect(interaction.fields.getTextInputValue('instruction')).toBe('fix the lore');
    expect(() => interaction.fields.getTextInputValue('missing')).toThrow(/not found/);
    await interaction.update({ content: 'drafting' });
    await interaction.editReply({ content: 'preview' });
    expect(responses.map((r) => r.method)).toEqual(['update', 'editReply']);
  });

  it('cannot update a message when the modal did not come from one, and never show another modal', async () => {
    const { interaction } = createFakeModalSubmitInteraction({ customId: 'nv:m:g:h', fields: {}, fromMessage: false });
    expect(interaction.isFromMessage()).toBe(false);
    const loose = interaction as unknown as { update: (o: unknown) => Promise<void>; showModal: (m: unknown) => Promise<void> };
    await expect(async () => loose.update({ content: 'x' })).rejects.toThrow(TypeError);
    await expect(async () => loose.showModal(modal)).rejects.toThrow(TypeError);
  });
});

describe('command interactions', () => {
  it('can show a modal but have no message to update', async () => {
    const { interaction } = createFakeUserCommandInteraction({ id: 'u1' }, { commandName: 'x' });
    const loose = interaction as unknown as { update: (o: unknown) => Promise<void> };
    await expect(async () => loose.update({ content: 'x' })).rejects.toThrow(TypeError);
    await interaction.showModal(modal);
    await expect(interaction.reply({ content: 'x' })).rejects.toMatchObject({ code: 'InteractionAlreadyReplied' });
  });
});
