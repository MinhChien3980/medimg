package com.medimg.imaging.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.imaging.domain.UploadSession;
import com.medimg.imaging.infrastructure.ImageFileRepository;
import com.medimg.imaging.infrastructure.SeriesRepository;
import com.medimg.imaging.infrastructure.StudyRepository;
import com.medimg.imaging.infrastructure.UploadSessionRepository;
import com.medimg.shared.storage.ObjectStoragePort;

class UploadProcessorTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final UploadSessionRepository uploads = mock(UploadSessionRepository.class);
    private final ObjectStoragePort storage = mock(ObjectStoragePort.class);
    private final UploadProcessor processor = new UploadProcessor(uploads, mock(StudyRepository.class),
            mock(SeriesRepository.class), mock(ImageFileRepository.class), storage,
            new ImagingProperties(50_000_000, 256, Duration.ofMinutes(10)),
            new TransactionTemplate(mock(PlatformTransactionManager.class)), Clock.fixed(NOW, ZoneOffset.UTC));

    private UploadSession session;

    @BeforeEach
    void uploadedSession() {
        session = new UploadSession(UUID.randomUUID(), "CR", "CHEST", UUID.randomUUID(), NOW);
        session.addFile("x.png", 10, "image/png");
        session.markUploaded(NOW);
        when(uploads.findById(session.getId())).thenReturn(Optional.of(session));
    }

    @Test
    void errorMarksUploadFailedAndIsRethrown() {
        when(storage.get(anyString())).thenThrow(new OutOfMemoryError("Java heap space"));

        assertThatThrownBy(() -> processor.process(session.getId())).isInstanceOf(OutOfMemoryError.class);

        assertThat(session.getStatus()).isEqualTo(UploadSession.Status.FAILED);
        assertThat(session.getError()).isEqualTo("Processing failed, please try again");
    }

    @Test
    void unexpectedExceptionMarksUploadFailed() {
        when(storage.get(anyString())).thenThrow(new IllegalStateException("storage down"));

        processor.process(session.getId());

        assertThat(session.getStatus()).isEqualTo(UploadSession.Status.FAILED);
        assertThat(session.getUpdatedAt()).isEqualTo(NOW);
    }
}
