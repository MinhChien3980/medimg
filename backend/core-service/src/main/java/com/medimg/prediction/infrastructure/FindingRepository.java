package com.medimg.prediction.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.medimg.prediction.domain.Finding;
import com.medimg.prediction.domain.Finding.ReviewStatus;

public interface FindingRepository extends JpaRepository<Finding, UUID> {

    /** Most confident first; segmentation findings (no confidence) largest first. */
    @Query("""
            select f from Finding f where f.resultId in :resultIds
            order by f.confidence desc nulls last, f.volumeMl desc nulls last, f.label
            """)
    List<Finding> findByResultIds(Collection<UUID> resultIds);

    /** AI findings first (most confident, then largest), then those added by hand in the order they were added. */
    @Query("""
            select f from Finding f where f.studyId = :studyId and f.reviewStatus in :statuses
            order by f.source, f.confidence desc nulls last, f.volumeMl desc nulls last, f.reviewedAt, f.label
            """)
    List<Finding> findByStudy(UUID studyId, Collection<ReviewStatus> statuses);

    @Modifying
    @Query("delete from Finding f where f.resultId = :resultId")
    void deleteByResultId(UUID resultId);
}
