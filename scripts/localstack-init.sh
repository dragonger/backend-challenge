#!/bin/bash
# Runs inside LocalStack when it reaches the READY stage.
# Creates the FIFO work queue and its dead-letter queue with a redrive policy,
# plus the FIFO queue where the outbox publisher sends integration events.
set -euo pipefail

MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
QUEUE="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
EVENTS_QUEUE="wagering-events.fifo"

awslocal sqs create-queue \
  --queue-name "$DLQ" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600"}'

DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/$DLQ" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

REDRIVE="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"$MAX_RECEIVE_COUNT\"}"

awslocal sqs create-queue \
  --queue-name "$QUEUE" \
  --attributes "$(printf '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"60","RedrivePolicy":"%s"}' "$(echo "$REDRIVE" | sed 's/"/\\"/g')")"

awslocal sqs create-queue \
  --queue-name "$EVENTS_QUEUE" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false","MessageRetentionPeriod":"1209600"}'

echo "SQS queues ready: $QUEUE (redrive after $MAX_RECEIVE_COUNT receives) -> $DLQ; events: $EVENTS_QUEUE"
