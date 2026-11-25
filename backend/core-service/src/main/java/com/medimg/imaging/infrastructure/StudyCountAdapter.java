package com.medimg.imaging.infrastructure;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import com.medimg.imaging.infrastructure.StudyRepository.PatientStudyCount;
import com.medimg.patient.application.StudyCountPort;

@Component
class StudyCountAdapter implements StudyCountPort {

    private final StudyRepository studies;

    StudyCountAdapter(StudyRepository studies) {
        this.studies = studies;
    }

    @Override
    public Map<UUID, Long> countByPatient(Collection<UUID> patientIds) {
        if (patientIds.isEmpty()) {
            return Map.of();
        }
        return studies.countByPatientIds(patientIds).stream()
                .collect(Collectors.toMap(PatientStudyCount::getPatientId, PatientStudyCount::getTotal));
    }
}
