package com.medimg.prediction.infrastructure;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param consumerName    name of this instance in the {@code core} consumer group
 * @param maxDeliveries   deliveries after which a result that still cannot be applied is dead-lettered
 * @param reclaimIdle     how long a delivered result may stay unacknowledged before it is delivered again
 * @param reclaimInterval how often unacknowledged results are checked
 */
@ConfigurationProperties("app.ai.result-stream")
public record ResultStreamProperties(String consumerName, int maxDeliveries, Duration reclaimIdle, Duration reclaimInterval) {
}
