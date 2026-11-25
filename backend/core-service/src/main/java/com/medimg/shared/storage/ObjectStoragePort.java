package com.medimg.shared.storage;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Object storage abstraction over the S3 API (SeaweedFS in the provided deployment).
 * Keys are bucket-relative; {@link #uri(String)} gives the {@code s3://bucket/key} form exchanged with the AI worker.
 */
public interface ObjectStoragePort {

    record PresignedUrl(URI url, Instant expiresAt) {
    }

    /** A part of a multipart upload: its number (from 1) and the ETag the storage returned when it was uploaded. */
    record UploadedPart(int partNumber, String etag) {
    }

    PresignedUrl presignPut(String key, String contentType, long contentLength);

    /** Starts a multipart upload of {@code key}; returns its upload id. */
    String createMultipartUpload(String key, String contentType);

    /** A presigned UploadPart request for a part of exactly {@code contentLength} bytes. */
    PresignedUrl presignUploadPart(String key, String uploadId, int partNumber, long contentLength, Duration validity);

    /**
     * Assembles the object from its parts, given in ascending part number order.
     *
     * @throws MultipartUploadRejectedException if the storage rejects the parts or does not know the upload
     */
    void completeMultipartUpload(String key, String uploadId, List<UploadedPart> parts);

    /** Drops a multipart upload and the parts uploaded so far. */
    void abortMultipartUpload(String key, String uploadId);

    PresignedUrl presignGet(String key);

    byte[] get(String key);

    /** The first {@code maxBytes} bytes of the object (all of it if it is smaller), read with a ranged GET. */
    byte[] getFirstBytes(String key, int maxBytes);

    void put(String key, byte[] content, String contentType);

    long size(String key);

    /** Server-side copy of an object to another key of the bucket. */
    void copy(String sourceKey, String targetKey);

    void delete(String key);

    /** {@code s3://bucket/key} */
    String uri(String key);

    /** Inverse of {@link #uri(String)}; rejects URIs pointing at another bucket. */
    String keyOf(String uri);
}
