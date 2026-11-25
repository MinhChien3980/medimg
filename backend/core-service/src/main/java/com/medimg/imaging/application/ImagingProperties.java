package com.medimg.imaging.application;

import java.time.Duration;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;

/**
 * @param maxUploadBytes    size limit of a 2D image (PNG, JPEG, DICOM)
 * @param processingTimeout PNG/JPEG uploads still UPLOADED or PROCESSING after this long (e.g. the instance died while
 *                          processing them) are marked FAILED
 * @param volume            uploads processed by the ingest worker (DICOM file, ZIP, NIfTI)
 * @param multipart         uploads of large files in parts
 */
@ConfigurationProperties("app.imaging")
public record ImagingProperties(long maxUploadBytes, int minImageDimension, Duration processingTimeout, Volume volume,
                                Multipart multipart) {

    /**
     * @param maxUploadBytes    size limit of a volume file (ZIP, NIfTI)
     * @param processingTimeout uploads without any news from the ingest worker for this long are marked FAILED
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

    /**
     * @param threshold    files larger than this are uploaded in parts
     * @param partSize     size of every part but the last
     * @param urlValidity  how long the presigned part URLs are valid
     * @param abandonAfter a multipart upload not completed this long after init is aborted and the upload FAILED
     */
    public record Multipart(DataSize threshold, DataSize partSize, Duration urlValidity, Duration abandonAfter) {

        /** S3 rejects parts below 5 MiB, except the last one. */
        private static final DataSize MIN_PART_SIZE = DataSize.ofMegabytes(5);

        public Multipart {
            if (partSize.compareTo(MIN_PART_SIZE) < 0) {
                throw new IllegalArgumentException("app.imaging.multipart.part-size must be at least " + MIN_PART_SIZE);
            }
            if (abandonAfter.compareTo(urlValidity) <= 0) {
                throw new IllegalArgumentException(
                        "app.imaging.multipart.abandon-after must be longer than app.imaging.multipart.url-validity");
            }
        }

        /** Number of parts of a file of {@code size} bytes. */
        public int partCount(long size) {
            return Math.toIntExact(Math.ceilDiv(size, partSize.toBytes()));
        }

        /** Size of part {@code partNumber} (from 1) of a file of {@code size} bytes. */
        public long partLength(long size, int partNumber) {
            return Math.min(partSize.toBytes(), size - (partNumber - 1) * partSize.toBytes());
        }
    }
}
