import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { ChannelAdapter, InboundImage, InboundMessage, InboundVoice } from './types.js';

const DISCORD_LIMIT = 2000;

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  if (remaining === '') return [''];
  while (remaining.length > limit) {
    let idx = remaining.lastIndexOf('\n', limit);
    if (idx <= 0) idx = limit;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  if (remaining.length > 0 || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

export class DiscordAdapter implements ChannelAdapter {
  name = 'discord';
  client: Client;
  private allowedUserId: string;
  private ready: Promise<void>;

  constructor(token: string, allowedUserId?: string) {
    if (!allowedUserId) throw new Error('DiscordAdapter requires an allowed user id (fail-closed)');
    this.allowedUserId = String(allowedUserId);
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.ready = this.client.login(token).then(() => undefined);
    void this.ready.catch(() => {});
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    await this.ready;
    this.client.on(Events.MessageCreate, async (msg: any) => {
      try {
        if (msg?.author?.bot) return;
        const uid = String(msg?.author?.id ?? '');
        if (uid !== this.allowedUserId) return;
        if (msg?.guild) return; // ignore guild channels
        const isDm = typeof msg?.channel?.isDMBased === 'function' ? msg.channel.isDMBased() : !msg?.guild;
        if (!isDm) return;

        const images: InboundImage[] = [];
        let voice: InboundVoice | undefined;
        const attachments = Array.from(msg?.attachments?.values?.() || []);
        for (const raw of attachments) {
          const att: any = raw;
          const ct = String(att?.contentType || '').toLowerCase();
          if (ct.startsWith('image/')) {
            try {
              const res = await fetch(att.url);
              if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                images.push({ mimeType: att.contentType, data: buf.toString('base64') });
              }
            } catch (e) { console.error('discord image download', e); }
          } else if (ct.startsWith('audio/') && !voice) {
            try {
              const res = await fetch(att.url);
              if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                voice = { mimeType: att.contentType, data: buf.toString('base64') };
              }
            } catch (e) { console.error('discord voice download', e); }
          }
        }

        const inbound: InboundMessage = {
          channel: 'discord',
          userId: uid,
          chatId: String(msg.channelId),
          text: msg?.content ?? '',
          images: images.length ? images : undefined,
          voice,
        };
        await handler(inbound);
      } catch (e) {
        console.error('discord handle error', e);
      }
    });
  }

  async send(target: string, text: string): Promise<void> {
    await this.ready;
    for (const part of splitText(text, DISCORD_LIMIT)) {
      // try channel first
      try {
        const ch: any = await this.client.channels.fetch(target);
        if (ch && typeof ch.send === 'function') {
          await ch.send(part);
          continue;
        }
      } catch {}
      // fallback: treat target as user id -> DM
      const user: any = await this.client.users.fetch(target);
      const dm = await user.createDM();
      await dm.send(part);
    }
  }

  async stop(): Promise<void> {
    try { this.client.destroy(); } catch {}
  }
}