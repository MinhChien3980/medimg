package com.medimg.shared.web;

import org.springframework.dao.OptimisticLockingFailureException;

/**
 * Optimistic locking across requests: a change carries the version of the resource the client last read, and is
 * rejected (409, like a concurrent update caught by JPA) when the resource has changed since.
 */
public final class ExpectedVersion {

    private ExpectedVersion() {
    }

    public static void check(String resource, Object id, long expected, long actual) {
        if (expected != actual) {
            throw new OptimisticLockingFailureException(
                    resource + " " + id + " is at version " + actual + ", the change was made on version " + expected);
        }
    }
}
