package com.medimg.imaging.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.medimg.imaging.domain.Study;

public interface StudyRepository extends JpaRepository<Study, UUID> {

    List<Study> findByPatientIdOrderByCreatedAtDesc(UUID patientId);

    @Query("select s.patientId as patientId, count(s) as total from Study s where s.patientId in :ids group by s.patientId")
    List<PatientStudyCount> countByPatientIds(Collection<UUID> ids);

    interface PatientStudyCount {
        UUID getPatientId();

        long getTotal();
    }
}
