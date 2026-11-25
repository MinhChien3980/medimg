package com.medimg.imaging.infrastructure;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

import com.medimg.imaging.domain.UploadSession;

public interface UploadSessionRepository extends JpaRepository<UploadSession, UUID> {

    List<UploadSession> findByStatusInAndUpdatedAtBefore(Collection<UploadSession.Status> statuses, Instant before);
}
