import { log } from '../logger.js';

// Notification channels — extend with Telegram/Discord webhooks
type NotificationType = 'position_opened' | 'position_closed' | 'circuit_breaker' | 'thesis_generated' | 'evaluator_verdict';

interface Notification {
  type: NotificationType;
  title: string;
  body: string;
  timestamp: string;
}

export async function notify(type: NotificationType, title: string, body: string): Promise<void> {
  const notification: Notification = {
    type,
    title,
    body,
    timestamp: new Date().toISOString(),
  };

  // Always log
  log({ level: 'info', event: 'notification', data: notification });

  // Console notification (visible in terminal)
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📢 ${type.toUpperCase()}: ${title}`);
  console.log(body);
  console.log(`${'='.repeat(60)}\n`);

  // Telegram webhook (if configured)
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (telegramToken && telegramChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: `*${title}*\n${body}`,
          parse_mode: 'Markdown',
        }),
      });
    } catch (e: any) {
      log({ level: 'warn', event: 'telegram_failed', data: { error: e.message } });
    }
  }

  // Discord webhook (if configured)
  const discordWebhook = process.env.DISCORD_WEBHOOK_URL;

  if (discordWebhook) {
    try {
      await fetch(discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `**${title}**\n${body}`,
        }),
      });
    } catch (e: any) {
      log({ level: 'warn', event: 'discord_failed', data: { error: e.message } });
    }
  }
}
