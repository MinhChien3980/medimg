package com.medimg.shared.storage;

import java.net.URI;
import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("app.storage")
public record StorageProperties(
        String bucket,
        URI endpoint,
        URI publicEndpoint,
        String region,
        String accessKey,
        String secretKey,
        Duration presignTtl) {
}
