package com.medimg.imaging.infrastructure;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.imaging.domain.Series;

public interface SeriesRepository extends JpaRepository<Series, UUID> {

    List<Series> findByStudyIdOrderByCreatedAtAsc(UUID studyId);

    List<Series> findByStudyIdIn(Collection<UUID> studyIds);
}
