package com.medimg.shared.storage;

import java.net.URI;
import java.time.Instant;

/**
 * Object storage abstraction over the S3 API (SeaweedFS in the provided deployment).
 * Keys are bucket-relative; {@link #uri(String)} gives the {@code s3://bucket/key} form exchanged with the AI worker.
 */
public interface ObjectStoragePort {

    record PresignedUrl(URI url, Instant expiresAt) {
    }

    PresignedUrl presignPut(String key, String contentType, long contentLength);

    PresignedUrl presignGet(String key);

    byte[] get(String key);

    /** The first {@code maxBytes} bytes of the object (all of it if it is smaller), read with a ranged GET. */
    byte[] getFirstBytes(String key, int maxBytes);

    void put(String key, byte[] content, String contentType);

    long size(String key);

    void delete(String key);

    /** {@code s3://bucket/key} */
    String uri(String key);

    /** Inverse of {@link #uri(String)}; rejects URIs pointing at another bucket. */
    String keyOf(String uri);
}
