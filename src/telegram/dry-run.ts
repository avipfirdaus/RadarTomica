/**
 * Implementasi TelegramPort tanpa jaringan untuk pengujian dan mode TELEGRAM_DRY_RUN=1.
 * Menyimpan semua pesan keluar di memori.
 */
import type { TelegramPort } from '../shared/types.js';

export interface RecordedMessage {
  target: 'operator' | 'channel';
  messageId: string;
  text: string;
  buttons?: { text: string; data: string }[][];
  sentAt: Date;
}

export class DryRunTelegram implements TelegramPort {
  readonly messages: RecordedMessage[] = [];
  private seq = 0;
  private failNextOperatorError: Error | null = null;
  private failNextChannelError: Error | null = null;

  get operatorMessages(): RecordedMessage[] {
    return this.messages.filter((m) => m.target === 'operator');
  }

  get channelMessages(): RecordedMessage[] {
    return this.messages.filter((m) => m.target === 'channel');
  }

  /** Simulasikan kegagalan pengiriman berikutnya ke operator (untuk tes idempotensi). */
  failNextOperator(err: Error = new Error('Simulated Telegram operator send failure')): void {
    this.failNextOperatorError = err;
  }

  /** Simulasikan kegagalan pengiriman berikutnya ke channel. */
  failNextChannel(err: Error = new Error('Simulated Telegram channel send failure')): void {
    this.failNextChannelError = err;
  }

  async sendToOperator(
    text: string,
    opts?: { buttons?: { text: string; data: string }[][] },
  ): Promise<{ messageId: string }> {
    if (this.failNextOperatorError) {
      const err = this.failNextOperatorError;
      this.failNextOperatorError = null;
      throw err;
    }
    this.seq += 1;
    const messageId = `dry-op-${this.seq}`;
    this.messages.push({
      target: 'operator',
      messageId,
      text,
      buttons: opts?.buttons,
      sentAt: new Date(),
    });
    return { messageId };
  }

  async sendToChannel(text: string): Promise<{ messageId: string }> {
    if (this.failNextChannelError) {
      const err = this.failNextChannelError;
      this.failNextChannelError = null;
      throw err;
    }
    this.seq += 1;
    const messageId = `dry-ch-${this.seq}`;
    this.messages.push({
      target: 'channel',
      messageId,
      text,
      sentAt: new Date(),
    });
    return { messageId };
  }

  clear(): void {
    this.messages.length = 0;
    this.seq = 0;
    this.failNextOperatorError = null;
    this.failNextChannelError = null;
  }
}
