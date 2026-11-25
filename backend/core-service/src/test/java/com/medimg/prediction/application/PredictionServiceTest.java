package com.medimg.prediction.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.PredictionDtos.CreatePrediction;
import com.medimg.prediction.application.PredictionDtos.CreatedJob;
import com.medimg.prediction.application.PredictionDtos.PredictionDto;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.domain.JobStatus;
import com.medimg.prediction.domain.PredictionJob;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.FindingRepository;
import com.medimg.prediction.infrastructure.PredictionJobRepository;
import com.medimg.prediction.infrastructure.PredictionResultRepository;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.web.ApiException;

import tools.jackson.databind.json.JsonMapper;

class PredictionServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");
    private static final UUID USER = UUID.randomUUID();

    private final PredictionJobRepository jobs = mock(PredictionJobRepository.class);
    private final AiModelRepository models = mock(AiModelRepository.class);
    private final StudyService studies = mock(StudyService.class);
    private final JobOutbox outbox = mock(JobOutbox.class);
    private final JobQueuePort queue = mock(JobQueuePort.class);
    private final PredictionService service = new PredictionService(jobs, mock(PredictionResultRepository.class),
            mock(FindingRepository.class), models, studies, outbox, queue,
            mock(ObjectStoragePort.class), JsonMapper.builder().build(), mock(ApplicationEventPublisher.class),
            new TransactionTemplate(mock(PlatformTransactionManager.class)), Clock.fixed(NOW, ZoneOffset.UTC));

    private final UUID studyId = UUID.randomUUID();
    private final UUID seriesId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(USER.toString()).build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));

        AiModel model = mock(AiModel.class);
        when(model.getId()).thenReturn(UUID.randomUUID());
        when(model.accepts("IMAGE_2D")).thenReturn(true);
        when(model.supportsModality("CR")).thenReturn(true);
        when(models.findFirstByCodeAndStatusOrderByCreatedAtDesc("cxr", AiModel.Status.ACTIVE)).thenReturn(Optional.of(model));
        when(studies.requireSeries(studyId, seriesId))
                .thenReturn(new SeriesRef(studyId, seriesId, UUID.randomUUID(), "IMAGE_2D", "CR", "CHEST", "IMAGE_2D", "s3://b/k"));
        when(jobs.saveAndFlush(any(PredictionJob.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key value violates unique constraint"));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void concurrentRequestWithTheSameIdempotencyKeyReturnsTheExistingJob() {
        PredictionJob winner = new PredictionJob(studyId, seriesId, UUID.randomUUID(), "{}", "key-1", USER, NOW);
        // not visible when this request checks, committed by the time its insert fails
        when(jobs.findByRequestedByAndIdempotencyKey(USER, "key-1")).thenReturn(Optional.empty()).thenReturn(Optional.of(winner));
        when(jobs.countQueuedUpTo(eq(JobStatus.QUEUED), any())).thenReturn(1L);

        CreatedJob created = service.create(new CreatePrediction(studyId, seriesId, "cxr", Map.of(), "key-1"));

        assertThat(created.jobId()).isEqualTo(winner.getId());
        assertThat(created.status()).isEqualTo("QUEUED");
        assertThat(created.queuePosition()).isEqualTo(1);
        verify(outbox, never()).dispatch(any(), any());
    }

    @Test
    void integrityViolationWithoutIdempotencyKeyIsNotMasked() {
        assertThatThrownBy(() -> service.create(new CreatePrediction(studyId, seriesId, "cxr", Map.of(), null)))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void createStoresTheDispatchAfterTheJobRow() {
        doAnswer(i -> i.getArgument(0)).when(jobs).saveAndFlush(any(PredictionJob.class));

        CreatedJob created = service.create(new CreatePrediction(studyId, seriesId, "cxr", Map.of(), null));

        var order = inOrder(jobs, outbox);
        order.verify(jobs).saveAndFlush(any(PredictionJob.class));
        order.verify(outbox).dispatch(any(PredictionJob.class), eq(NOW));
        assertThat(created.status()).isEqualTo("QUEUED");
    }

    @Test
    void modelForAnotherInputTypeOrModalityIsRejected() {
        AiModel ct = mock(AiModel.class);
        when(ct.getCode()).thenReturn("ct-totalseg");
        when(ct.getModality()).thenReturn("CT");
        when(ct.accepts("IMAGE_2D")).thenReturn(true);
        when(models.findFirstByCodeAndStatusOrderByCreatedAtDesc("ct", AiModel.Status.ACTIVE)).thenReturn(Optional.of(ct));

        assertThatThrownBy(() -> service.create(new CreatePrediction(studyId, seriesId, "ct", Map.of(), null)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
                    assertThat(e.getMessage()).isEqualTo("Model ct-totalseg is for CT images, the series is CR");
                });

        when(ct.accepts("IMAGE_2D")).thenReturn(false);
        assertThatThrownBy(() -> service.create(new CreatePrediction(studyId, seriesId, "ct", Map.of(), null)))
                .hasMessage("Model ct-totalseg does not accept IMAGE_2D input");
        verify(outbox, never()).dispatch(any(), any());
    }

    @Test
    void manualRetryDispatchesTheNextAttemptRightAway() {
        PredictionJob job = existingJob();
        job.fail("bad image", false, 3, NOW.minusSeconds(60));

        PredictionDto retried = service.retry(job.getId());

        assertThat(retried.status()).isEqualTo("QUEUED");
        assertThat(retried.attempt()).isEqualTo(2);
        verify(outbox).dispatch(job, NOW);
    }

    @Test
    void cancelDropsThePendingDispatchAndFlagsTheJobAfterCommit() {
        PredictionJob job = existingJob();
        TransactionSynchronizationManager.initSynchronization();

        assertThat(service.cancel(job.getId()).status()).isEqualTo("CANCELLED");

        verify(outbox).discardPending(job.getId());
        verify(queue, never()).markCancelled(any());
        TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
        verify(queue).markCancelled(job.getId());
    }

    @Test
    void cancelSucceedsWhenTheCancelFlagCannotBeSet() {
        PredictionJob job = existingJob();
        doThrow(new IllegalStateException("Redis is down")).when(queue).markCancelled(job.getId());
        TransactionSynchronizationManager.initSynchronization();

        service.cancel(job.getId());

        TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
        verify(queue).markCancelled(job.getId());
    }

    private PredictionJob existingJob() {
        PredictionJob job = new PredictionJob(studyId, seriesId, UUID.randomUUID(), "{}", null, USER, NOW.minusSeconds(120));
        when(jobs.findById(job.getId())).thenReturn(Optional.of(job));
        when(studies.exists(studyId)).thenReturn(true);
        return job;
    }
}
