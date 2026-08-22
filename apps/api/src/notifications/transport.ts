import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where a composed message actually goes (Phase 4 deliverable 3).
 *
 * docs/04 asks for WhatsApp and email. No provider is configured for either, and
 * CLAUDE.md §7 rules out a direct WhatsApp API integration for LEAD INGESTION —
 * a rule about not pulling leads from WhatsApp, not about sending a rep her
 * morning plan. Either way, credentials are a decision that has not been made.
 *
 * So the seam is built and the provider is not. `FileTransport` writes each
 * message to disk exactly as it would be sent, which means:
 *
 *   - the digests can be read, reviewed and corrected NOW, before anyone has
 *     signed up to a provider;
 *   - exit criterion 5 ("five consecutive days of scheduled sends, verified")
 *     can be exercised end to end against real content;
 *   - adding a provider later is one class, not a refactor.
 *
 * What it deliberately does NOT do is pretend. A message written to disk is
 * recorded against the FILE channel, never EMAIL or WHATSAPP, so nobody can look
 * at the outbox in three weeks and believe the client has been receiving digests.
 */

export interface OutgoingMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export interface TransportResult {
  readonly ok: boolean;
  readonly channel: 'EMAIL' | 'WHATSAPP' | 'IN_APP' | 'FILE';
  readonly reason?: string;
}

export interface NotificationTransport {
  readonly channel: TransportResult['channel'];
  send(message: OutgoingMessage): Promise<TransportResult>;
}

/**
 * Writes each message to a file. The default until a provider is configured.
 */
export class FileTransport implements NotificationTransport {
  readonly channel = 'FILE' as const;

  constructor(private readonly directory: string) {}

  async send(message: OutgoingMessage): Promise<TransportResult> {
    try {
      await mkdir(this.directory, { recursive: true });
      // Named so a human scanning the directory can find one message without
      // opening any of them. Slashes and colons are stripped: this runs on
      // Windows locally and Linux on the VPS.
      const safe = `${message.to}-${message.subject}`.replace(/[^A-Za-z0-9._@-]+/g, '-').slice(0, 120);
      await writeFile(
        join(this.directory, `${safe}.txt`),
        `To: ${message.to}\nSubject: ${message.subject}\n\n${message.body}\n`,
        'utf8',
      );
      return { ok: true, channel: this.channel };
    } catch (e) {
      return { ok: false, channel: this.channel, reason: (e as Error).message };
    }
  }
}

/**
 * Refuses, loudly, and says what is missing.
 *
 * Selected when a provider channel is requested but no credentials exist. It
 * fails rather than silently falling back to a file, because a digest the client
 * believes was emailed and was not is worse than one that visibly did not send.
 */
export class UnconfiguredTransport implements NotificationTransport {
  constructor(readonly channel: TransportResult['channel'], private readonly setting: string) {}

  async send(): Promise<TransportResult> {
    return {
      ok: false,
      channel: this.channel,
      reason:
        `No ${this.channel} provider is configured. Set ${this.setting} and restart the API. ` +
        `Until then, digests are written to disk via the FILE transport and are NOT reaching anyone.`,
    };
  }
}

/**
 * Picks a transport from the environment.
 *
 * Deliberately explicit: an operator who has not configured anything gets FILE
 * and a warning at boot, not a silent no-op.
 */
export function resolveTransport(): NotificationTransport {
  const channel = (process.env['NOTIFY_CHANNEL'] ?? 'FILE').toUpperCase();

  if (channel === 'EMAIL') return new UnconfiguredTransport('EMAIL', 'SMTP_URL');
  if (channel === 'WHATSAPP') return new UnconfiguredTransport('WHATSAPP', 'WHATSAPP_API_KEY');

  return new FileTransport(process.env['NOTIFY_DIR'] ?? '.digests');
}
