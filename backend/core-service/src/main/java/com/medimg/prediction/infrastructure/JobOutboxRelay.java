package com.medimg.prediction.infrastructure;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.prediction.application.JobQueuePort;
import com.medimg.prediction.application.JobQueuePort.JobMessage;

import tools.jackson.databind.ObjectMapper;

/**
 * Publishes the job dispatches of the outbox to the Redis job streams. Each pass claims due rows with
 * {@code FOR UPDATE SKIP LOCKED}, so several core-service instances can relay side by side; a row whose publish fails
 * is backed off on its own and does not hold up the others.
 * <p>
 * Delivery is at-least-once: if the commit fails after the XADD, the message is published again. Workers then run the
 * same attempt twice, which is harmless because core applies a result only once and only for the job's current attempt.
 */
@Component
class JobOutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(JobOutboxRelay.class);

    private final OutboxMessageRepository messages;
    private final JobQueuePort queue;
    private final TransactionTemplate tx;
    private final ObjectMapper json;
    private final OutboxProperties props;
    private final Clock clock;

    JobOutboxRelay(OutboxMessageRepository messages, JobQueuePort queue, TransactionTemplate tx, ObjectMapper json,
                   OutboxProperties props, Clock clock) {
        this.messages = messages;
        this.queue = queue;
        this.tx = tx;
        this.json = json;
        this.props = props;
        this.clock = clock;
    }

    /** Drains due messages batch by batch; stops at the first batch that was not full or not fully published. */
    @Scheduled(initialDelayString = "${app.ai.outbox.poll-interval}", fixedDelayString = "${app.ai.outbox.poll-interval}")
    void relay() {
        try {
            while (publishDue() == props.batchSize()) {
                log.debug("Outbox batch full, relaying the next one");
            }
        } catch (RuntimeException e) {
            log.error("Outbox relay pass failed", e);
        }
    }

    /** Publishes one batch of due messages in one transaction; returns how many were published. */
    int publishDue() {
        Integer published = tx.execute(s -> {
            List<OutboxMessage> due = messages.lockDue(clock.instant(), props.batchSize());
            if (due.isEmpty()) {
                return 0;
            }
            String stream;
            try {
                stream = queue.chooseQueue();
            } catch (RuntimeException e) {
                due.forEach(m -> backOff(m, e));
                return 0;
            }
            int count = 0;
            for (OutboxMessage m : due) {
                try {
                    queue.publish(stream, json.readValue(m.getPayload(), JobMessage.class));
                    m.markPublished(stream, clock.instant());
                    count++;
                } catch (RuntimeException e) {
                    backOff(m, e);
                }
            }
            return count;
        });
        return published == null ? 0 : published;
    }

    /** Deletes published messages older than the retention period; returns how many were deleted. */
    @Scheduled(initialDelay = 1, fixedDelay = 1, timeUnit = TimeUnit.HOURS)
    int deletePublished() {
        Instant before = clock.instant().minus(props.retention());
        Integer deleted = tx.execute(s -> messages.deletePublishedBefore(before));
        if (deleted != null && deleted > 0) {
            log.info("Deleted {} outbox messages published before {}", deleted, before);
        }
        return deleted == null ? 0 : deleted;
    }

    private void backOff(OutboxMessage m, RuntimeException e) {
        Instant retryAt = clock.instant().plus(props.backoffAfter(m.getAttempts() + 1));
        m.markFailed(e.toString(), retryAt);
        log.warn("Could not publish outbox message {} of job {} (failure {}), next try at {}: {}",
                m.getId(), m.getJobId(), m.getAttempts(), retryAt, e.toString());
    }
}
