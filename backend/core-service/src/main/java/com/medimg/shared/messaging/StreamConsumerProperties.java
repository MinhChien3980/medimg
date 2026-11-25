package com.medimg.shared.messaging;

import java.time.Duration;

/** Settings of a {@link StreamConsumer}; implemented by the configuration properties of each consumer. */
public interface StreamConsumerProperties {

    /** Name of this instance in the consumer group. */
    String consumerName();

    /** Deliveries after which a message that still cannot be applied is dead-lettered. */
    int maxDeliveries();

    /** How long a delivered message may stay unacknowledged before it is delivered again. */
    Duration reclaimIdle();
}
