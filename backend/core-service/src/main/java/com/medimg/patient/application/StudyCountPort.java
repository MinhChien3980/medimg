package com.medimg.patient.application;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;

/** Implemented by the imaging module (dependency inversion keeps patient free of imaging). */
public interface StudyCountPort {

    Map<UUID, Long> countByPatient(Collection<UUID> patientIds);
}
