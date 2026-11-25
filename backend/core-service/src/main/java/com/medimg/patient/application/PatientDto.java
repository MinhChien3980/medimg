package com.medimg.patient.application;

import java.time.Instant;
import java.util.UUID;

/** {@code sample} is null unless the case is a sample case. */
public record PatientDto(UUID id, String code, Short birthYear, String sex, String note, long studyCount, Instant createdAt,
                         Sample sample) {

    public record Sample(String title, String description, String source) {
    }
}
