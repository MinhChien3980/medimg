package com.medimg.imaging.application;

import java.time.Duration;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param maxUploadBytes    size limit of a 2D image
 * @param processingTimeout 2D uploads still UPLOADED or PROCESSING after this long (e.g. the instance died while
 *                          processing them) are marked FAILED
 * @param volume            volume uploads (ZIP of DICOM files, NIfTI), processed by the ingest worker
 */
@ConfigurationProperties("app.imaging")
public record ImagingProperties(long maxUploadBytes, int minImageDimension, Duration processingTimeout, Volume volume) {

    /**
     * @param maxUploadBytes    size limit of a volume file
     * @param processingTimeout volume uploads without any news from the ingest worker for this long are marked FAILED
     * @param maxAttempts       ingest attempts, including retries of retryable failures
     * @param retryBackoff      delay before attempt 2, 3, ... (the last entry repeats)
     */
    public record Volume(long maxUploadBytes, Duration processingTimeout, int maxAttempts, List<Duration> retryBackoff) {

        /** Backoff before attempt {@code attempt} (2 → first entry, 3 → second, ...). */
        public Duration backoffBefore(int attempt) {
            int idx = Math.max(0, Math.min(retryBackoff.size() - 1, attempt - 2));
            return retryBackoff.get(idx);
        }
    }
}
