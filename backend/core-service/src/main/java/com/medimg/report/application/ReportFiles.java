package com.medimg.report.application;

import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.medimg.shared.storage.ObjectStoragePort;

/** Removal of the files of draft reports (key images) once the change that drops them has committed. */
@Component
class ReportFiles {

    private static final Logger log = LoggerFactory.getLogger(ReportFiles.class);

    private final ObjectStoragePort storage;

    ReportFiles(ObjectStoragePort storage) {
        this.storage = storage;
    }

    /** Best effort: a failure is logged and leaves the object behind. */
    void deleteAfterCommit(List<String> keys) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                for (String key : keys) {
                    try {
                        storage.delete(key);
                    } catch (RuntimeException e) {
                        log.warn("Could not delete report file {}: {}", key, e.getMessage());
                    }
                }
            }
        });
    }
}
