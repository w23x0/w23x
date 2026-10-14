import { Telegraf } from 'telegraf';
import type { ChannelAdapter, InboundImage, InboundMessage, InboundVoice } from './types.js';

const TELEGRAM_LIMIT = 4096;

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

export class TelegramAdapter implements ChannelAdapter {
  name = 'telegram';
  bot: Telegraf;
  private allowedUserId: string;

  constructor(token: string, allowedUserId?: string) {
    if (!allowedUserId) throw new Error('TelegramAdapter requires an allowed user id (fail-closed)');
    this.allowedUserId = String(allowedUserId);
    this.bot = new Telegraf(token, { handlerTimeout: Infinity });
  }

  private isAllowed(ctx: any): boolean {
    const uid = String(ctx?.from?.id ?? '');
    const chatType = ctx?.chat?.type;
    if (chatType !== 'private') return false;
    return uid !== '' && uid === this.allowedUserId;
  }

  private async download(fileId: string, fallbackMime: string): Promise<{ data: string; mimeType: string }> {
    const link = await (this.bot as any).telegram.getFileLink(fileId);
    const url = typeof link === 'string' ? link : String(link?.href ?? link);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rawCt = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ct = (rawCt && rawCt !== 'application/octet-stream') ? rawCt : fallbackMime;
    return { data: buf.toString('base64'), mimeType: ct || fallbackMime };
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const run = async (ctx: any, build: () => Promise<InboundMessage | null>) => {
      try {
        if (!this.isAllowed(ctx)) return;
        const msg = await build();
        if (!msg) return;
        handler(msg).catch((e) => console.error('telegram handle error', e));
      } catch (e) {
        console.error('telegram handle error', e);
      }
    };

    this.bot.on('text', async (ctx: any) => {
      await run(ctx, async () => ({
        channel: 'telegram',
        userId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
        text: ctx.message?.text ?? '',
      }));
    });

    this.bot.on('photo', async (ctx: any) => {
      await run(ctx, async () => {
        const photos = ctx.message?.photo || [];
        const largest = photos[photos.length - 1];
        const images: InboundImage[] = [];
        if (largest?.file_id) {
          const { data, mimeType } = await this.download(largest.file_id, 'image/jpeg');
          images.push({ mimeType, data });
        }
        return {
          channel: 'telegram',
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          text: ctx.message?.caption ?? '',
          images: images.length ? images : undefined,
        };
      });
    });

    this.bot.on('voice', async (ctx: any) => {
      await run(ctx, async () => {
        const v = ctx.message?.voice;
        if (!v?.file_id) return null;
        const { data, mimeType } = await this.download(v.file_id, v.mime_type || 'audio/ogg');
        const voice: InboundVoice = { mimeType: v.mime_type || mimeType, data };
        return {
          channel: 'telegram',
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          text: ctx.message?.caption ?? '',
          voice,
        };
      });
    });

    this.bot.on('audio', async (ctx: any) => {
      await run(ctx, async () => {
        const a = ctx.message?.audio;
        if (!a?.file_id) return null;
        const { data, mimeType } = await this.download(a.file_id, a.mime_type || 'audio/mpeg');
        const voice: InboundVoice = { mimeType: a.mime_type || mimeType, data };
        return {
          channel: 'telegram',
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          text: ctx.message?.caption ?? '',
          voice,
        };
      });
    });

    this.bot.launch().catch((e) => console.error('telegram launch', e));
  }

  async send(target: string, text: string): Promise<void> {
    for (const part of splitText(text, TELEGRAM_LIMIT)) {
      await this.bot.telegram.sendMessage(target, part);
    }
  }

  async stop(): Promise<void> {
    try { this.bot.stop(); } catch {}
  }
}