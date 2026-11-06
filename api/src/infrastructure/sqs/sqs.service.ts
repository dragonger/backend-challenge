import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { SQS_CONFIG, type SqsConfig } from './sqs.config.js';

/** Owns the SQSClient and resolves queue URLs (cached). */
@Injectable()
export class SqsService implements OnApplicationShutdown {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(@Inject(SQS_CONFIG) readonly config: SqsConfig) {
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.credentials ? { credentials: config.credentials } : {}),
      // Fail fast instead of retrying for a long time: callers (readiness,
      // consumers) own their retry policy.
      maxAttempts: 1,
    });
  }

  /** Signal that aborts a request after the configured timeout. */
  timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.config.requestTimeoutMs);
  }

  async queueUrl(queueName: string): Promise<string> {
    const configured =
      queueName === this.config.queueName ? this.config.queueUrl : undefined;

    if (configured) {
      return configured;
    }

    const cached = this.urls.get(queueName);

    if (cached) {
      return cached;
    }

    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
      { abortSignal: this.timeoutSignal() },
    );

    if (!QueueUrl) {
      throw new Error(`Queue ${queueName} has no URL`);
    }

    this.urls.set(queueName, QueueUrl);

    return QueueUrl;
  }

  /** Cheap reachability probe: GetQueueAttributes on the main queue. */
  async probeMainQueue(): Promise<void> {
    const QueueUrl = await this.queueUrl(this.config.queueName);

    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: this.timeoutSignal() },
    );
  }

  /**
   * Closed at the very end of the shutdown (after the consumer and publishers
   * drained in onModuleDestroy, which they still need this client for).
   */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
