package com.medimg.prediction.infrastructure;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param pollInterval      how often the relay looks for due messages
 * @param batchSize         messages claimed per relay transaction
 * @param publishBackoff    delay before a message whose publish failed is tried again; doubles with each failure
 * @param maxPublishBackoff upper bound of that delay
 * @param retention         how long published messages are kept
 */
@ConfigurationProperties("app.ai.outbox")
public record OutboxProperties(Duration pollInterval, int batchSize, Duration publishBackoff, Duration maxPublishBackoff,
                               Duration retention) {

    /** Delay after the {@code failures}-th failed publish of a message. */
    Duration backoffAfter(int failures) {
        int doublings = Math.max(0, Math.min(failures - 1, 30));
        Duration delay = publishBackoff.multipliedBy(1L << doublings);
        return delay.compareTo(maxPublishBackoff) > 0 ? maxPublishBackoff : delay;
    }
}
