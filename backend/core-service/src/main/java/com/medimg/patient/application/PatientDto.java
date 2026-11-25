package com.medimg.patient.application;

import java.time.Instant;
import java.util.UUID;

public record PatientDto(UUID id, String code, Short birthYear, String sex, String note, long studyCount, Instant createdAt) {
}
