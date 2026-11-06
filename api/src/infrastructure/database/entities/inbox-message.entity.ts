import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', length: 100 })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 255 })
  messageId!: string;

  @Property({ type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ columnType: 'timestamptz', defaultRaw: 'now()' })
  receivedAt!: Date;

  @Property({ columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
