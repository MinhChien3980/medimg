package com.medimg.imaging.infrastructure;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

import com.medimg.shared.messaging.StreamConsumerProperties;

/**
 * @param consumerName    name of this instance in the {@code core-imaging} consumer group
 * @param maxDeliveries   deliveries after which a result that still cannot be applied is dead-lettered
 * @param reclaimIdle     how long a delivered result may stay unacknowledged before it is delivered again
 * @param reclaimInterval how often unacknowledged results are checked
 */
@ConfigurationProperties("app.imaging.result-stream")
public record IngestResultStreamProperties(String consumerName, int maxDeliveries, Duration reclaimIdle,
                                           Duration reclaimInterval) implements StreamConsumerProperties {
}
