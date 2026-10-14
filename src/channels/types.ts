export interface InboundImage { mimeType: string; data: string /* base64 */ }
export interface InboundVoice { mimeType: string; data: string /* base64 */ }
export interface InboundMessage { channel: string; userId: string; chatId: string; text: string; images?: InboundImage[]; voice?: InboundVoice }
export interface ChannelAdapter {
  name: string;
  start(handler: (msg: InboundMessage) => Promise<void>): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}