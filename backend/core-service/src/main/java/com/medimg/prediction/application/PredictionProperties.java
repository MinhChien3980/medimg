package com.medimg.prediction.application;

import java.time.Duration;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("app.ai")
public record PredictionProperties(
        int maxAttempts,
        List<Duration> retryBackoff,
        Duration timeout2d,
        Duration timeout3d,
        Duration queuedTimeout,
        Duration sseHeartbeat,
        Duration sseTimeout) {

    /** Backoff before attempt {@code attempt} (2 → first entry, 3 → second, ...). */
    public Duration backoffBefore(int attempt) {
        int idx = Math.max(0, Math.min(retryBackoff.size() - 1, attempt - 2));
        return retryBackoff.get(idx);
    }
}
