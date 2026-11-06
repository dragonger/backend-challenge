/**
 * Sends one WagerTransactionRequested message (README section 10) to the work
 * queue, for manual experiments:
 *
 *   bun scripts/send-sample-message.ts <walletId> <playerId> [amount] [kind]
 *
 * Needs an existing wallet (POST /wallets). Uses the same SQS_* / AWS_*
 * settings as the app (LocalStack by default).
 */
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';

import { sqsConfigFromEnv } from '../src/infrastructure/sqs/sqs.config.js';

const [walletId, playerId, amount = '10.00', kind = 'BET'] = process.argv.slice(2);

if (!walletId || !playerId) {
  console.error('usage: bun scripts/send-sample-message.ts <walletId> <playerId> [amount] [kind]');
  process.exit(1);
}

const config = sqsConfigFromEnv();
const client = new SQSClient({
  region: config.region,
  ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  ...(config.credentials ? { credentials: config.credentials } : {}),
});
const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: config.queueName }));
const messageId = `msg-${randomUUID()}`;
const externalTransactionId = `ext-${randomUUID()}`;

await client.send(
  new SendMessageCommand({
    QueueUrl,
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
    MessageBody: JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind,
        money: { amount, currency: 'BRL' },
      },
    }),
  }),
);

console.log(JSON.stringify({ sent: true, messageId, externalTransactionId }));
client.destroy();
