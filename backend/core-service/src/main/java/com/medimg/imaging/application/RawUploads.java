package com.medimg.imaging.application;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.medimg.shared.storage.ObjectStoragePort;

/**
 * Removal of raw uploads, which may still carry identifying metadata, once they are no longer needed. Best effort: a
 * failure is logged and leaves the object behind.
 */
@Component
class RawUploads {

    private static final Logger log = LoggerFactory.getLogger(RawUploads.class);

    private final ObjectStoragePort storage;

    RawUploads(ObjectStoragePort storage) {
        this.storage = storage;
    }

    void delete(String key) {
        try {
            storage.delete(key);
        } catch (RuntimeException e) {
            log.warn("Could not delete raw upload {}: {}", key, e.getMessage());
        }
    }

    /** Deletes the object once the current transaction has committed, so a rolled-back change can be applied again. */
    void deleteAfterCommit(String key) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                delete(key);
            }
        });
    }
}
