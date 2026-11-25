package com.medimg.imaging.infrastructure;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.medimg.imaging.domain.UploadSession;

public interface UploadSessionRepository extends JpaRepository<UploadSession, UUID> {

    List<UploadSession> findByStatusInAndUpdatedAtBefore(Collection<UploadSession.Status> statuses, Instant before);

    @Query("""
            select distinct s from UploadSession s join s.files f
            where s.status = :status and s.createdAt < :before and f.multipartUploadId is not null
            """)
    List<UploadSession> findMultipartByStatusAndCreatedAtBefore(UploadSession.Status status, Instant before);
}
