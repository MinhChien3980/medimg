package com.medimg.prediction.infrastructure;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;

public interface PredictionJobRepository extends JpaRepository<PredictionJob, UUID> {

    Optional<PredictionJob> findByRequestedByAndIdempotencyKey(UUID requestedBy, String idempotencyKey);

    List<PredictionJob> findByStudyIdOrderByQueuedAtDesc(UUID studyId);

    @Query("""
            select j from PredictionJob j
            where j.studyId in :studyIds
              and j.queuedAt = (select max(o.queuedAt) from PredictionJob o where o.studyId = j.studyId)
            """)
    List<PredictionJob> findLatestByStudyIds(Collection<UUID> studyIds);

    @Query("select count(j) from PredictionJob j where j.status = :status and j.queuedAt <= :queuedAt")
    long countQueuedUpTo(JobStatus status, Instant queuedAt);

    List<PredictionJob> findByStatusAndStartedAtBefore(JobStatus status, Instant before);

    List<PredictionJob> findByStatusAndQueuedAtBefore(JobStatus status, Instant before);
}
