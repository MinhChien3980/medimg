package com.medimg.imaging.application;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param processingTimeout uploads still UPLOADED or PROCESSING after this long (e.g. the instance died while
 *                          processing them) are marked FAILED
 */
@ConfigurationProperties("app.imaging")
public record ImagingProperties(long maxUploadBytes, int minImageDimension, Duration processingTimeout) {
}
