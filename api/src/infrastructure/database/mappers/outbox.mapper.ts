import type { IntegrationEvent } from '../../../application/events/integration-event.js';

export const OutboxMapper = {
  /** Row for a pending outbox message (payload = serialized envelope). */
  toEntityData(event: IntegrationEvent<unknown>, now: Date) {
    return {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
  },
};
