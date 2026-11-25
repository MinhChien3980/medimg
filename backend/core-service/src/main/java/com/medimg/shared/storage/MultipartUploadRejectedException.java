package com.medimg.shared.storage;

/** The storage refused to complete a multipart upload: a part is missing or does not match, or the upload is gone. */
public class MultipartUploadRejectedException extends RuntimeException {

    public MultipartUploadRejectedException(String key, String reason) {
        super("Multipart upload of " + key + " rejected: " + reason);
    }
}
