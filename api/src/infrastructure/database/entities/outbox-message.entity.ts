import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * The table also has an identity `sequence` column (global insertion order)
 * filled by the database; not mapped on purpose.
 */
@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  /** Equals the eventId of the integration event. */
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 150 })
  aggregateId!: string;

  @Property({ type: 'string', length: 100 })
  eventType!: string;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'integer', default: 0 })
  attempts: number = 0;

  @Property({ columnType: 'timestamptz', defaultRaw: 'now()' })
  nextAttemptAt!: Date;

  @Property({ columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Property({ type: 'text', nullable: true })
  lastError?: string;

  @Property({ columnType: 'timestamptz', defaultRaw: 'now()' })
  createdAt!: Date;
}
