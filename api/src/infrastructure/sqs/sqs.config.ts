import { intFromEnv, optionalStringFromEnv, stringFromEnv } from '../../config/env.js';

export const SQS_CONFIG = Symbol('SQS_CONFIG');

export interface SqsConfig {
  region: string;
  /** Custom endpoint (LocalStack). Undefined means the real AWS endpoint. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  queueName: string;
  dlqName: string;
  /** FIFO queue where the outbox publisher sends integration events. */
  eventsQueueName: string;
  /** Optional shortcut; otherwise the URL is resolved by queue name. */
  queueUrl?: string;
  /** Per-request timeout, kept short so readiness never hangs. */
  requestTimeoutMs: number;
}

const LOCALSTACK_ENDPOINT = 'http://localhost:4566';

/**
 * Reads the SQS settings from the environment. Safe local defaults: outside
 * production the endpoint is the compose LocalStack and, when no keys are set,
 * LocalStack's fictitious "test" credentials are used (they never reach a real
 * AWS account). In production (NODE_ENV=production) there is no default
 * endpoint and the AWS default credential chain applies.
 * Shared by the readiness probe, the consumer and the outbox publisher.
 */
export function sqsConfigFromEnv(): SqsConfig {
  const isProduction = process.env.NODE_ENV === 'production';
  const endpoint =
    optionalStringFromEnv('AWS_ENDPOINT_URL') ??
    (isProduction ? undefined : LOCALSTACK_ENDPOINT);
  const accessKeyId = optionalStringFromEnv('AWS_ACCESS_KEY_ID');
  const secretAccessKey = optionalStringFromEnv('AWS_SECRET_ACCESS_KEY');

  return {
    region: stringFromEnv('AWS_REGION', 'us-east-1'),
    endpoint,
    credentials:
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : endpoint
          ? { accessKeyId: 'test', secretAccessKey: 'test' }
          : undefined,
    queueName: stringFromEnv('SQS_QUEUE_NAME', 'wager-transactions.fifo'),
    dlqName: stringFromEnv('SQS_DLQ_NAME', 'wager-transactions-dlq.fifo'),
    eventsQueueName: stringFromEnv('SQS_EVENTS_QUEUE_NAME', 'wagering-events.fifo'),
    queueUrl: optionalStringFromEnv('SQS_QUEUE_URL'),
    requestTimeoutMs: intFromEnv('SQS_REQUEST_TIMEOUT_MS', 2000),
  };
}
