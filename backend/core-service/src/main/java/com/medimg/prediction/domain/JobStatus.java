package com.medimg.prediction.domain;

public enum JobStatus {
    QUEUED, RUNNING, DONE, FAILED, CANCELLED;

    public boolean isTerminal() {
        return this == DONE || this == FAILED || this == CANCELLED;
    }
}
