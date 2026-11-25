package com.medimg.prediction.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

import com.medimg.prediction.domain.Finding;

public interface FindingRepository extends JpaRepository<Finding, UUID> {

    /** Most confident first; segmentation findings (no confidence) largest first. */
    @Query("""
            select f from Finding f where f.resultId in :resultIds
            order by f.confidence desc nulls last, f.volumeMl desc nulls last, f.label
            """)
    List<Finding> findByResultIds(Collection<UUID> resultIds);

    @Modifying
    @Query("delete from Finding f where f.resultId = :resultId")
    void deleteByResultId(UUID resultId);
}
