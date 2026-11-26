package com.medimg.prediction.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;

import com.medimg.prediction.application.ModelAdminService.AdminModelDto;
import com.medimg.prediction.domain.AiModel;
import com.medimg.prediction.infrastructure.AiModelRepository;
import com.medimg.prediction.infrastructure.ModelUsageQueries;
import com.medimg.prediction.infrastructure.ModelUsageQueries.ModelUsage;
import com.medimg.shared.audit.AuditEvent;
import com.medimg.shared.web.ApiException;

class ModelAdminServiceTest {

    private final AiModelRepository models = mock(AiModelRepository.class);
    private final ModelUsageQueries usage = mock(ModelUsageQueries.class);
    private final ApplicationEventPublisher events = mock(ApplicationEventPublisher.class);
    private final ModelAdminService service = new ModelAdminService(models, usage, events);

    private static AiModel model(String code, AiModel.Status status) {
        AiModel m = org.springframework.beans.BeanUtils.instantiateClass(AiModel.class);
        ReflectionTestUtils.setField(m, "id", UUID.randomUUID());
        ReflectionTestUtils.setField(m, "code", code);
        ReflectionTestUtils.setField(m, "version", "1.0");
        ReflectionTestUtils.setField(m, "task", AiModel.Task.CLASSIFICATION_2D);
        ReflectionTestUtils.setField(m, "inputTypes", "IMAGE_2D, DICOM_2D");
        ReflectionTestUtils.setField(m, "modality", "CR,DX");
        ReflectionTestUtils.setField(m, "status", status);
        return m;
    }

    @Test
    void listsEveryModelWithItsUsageAndZerosForAnUnusedOne() {
        AiModel used = model("cxr", AiModel.Status.ACTIVE);
        AiModel unused = model("ct", AiModel.Status.RETIRED);
        when(models.findAllByOrderByCodeAscVersionAsc()).thenReturn(List.of(unused, used));
        OffsetDateTime last = OffsetDateTime.of(2026, 11, 20, 9, 0, 0, 0, ZoneOffset.UTC);
        when(usage.usageByModel()).thenReturn(Map.of(used.getId(), new ModelUsage(10, 7, 2, 812.4, 1499.6, last)));

        List<AdminModelDto> list = service.list();

        assertThat(list).extracting(AdminModelDto::code).containsExactly("ct", "cxr");
        assertThat(list.get(0).stats()).isEqualTo(new ModelAdminService.StatsDto(0, 0, 0, null, null, null));
        AdminModelDto cxr = list.get(1);
        assertThat(cxr.inputTypes()).containsExactly("IMAGE_2D", "DICOM_2D");
        assertThat(cxr.stats().avgInferenceMs()).isEqualTo(812);
        assertThat(cxr.stats().p95InferenceMs()).isEqualTo(1500);
        assertThat(cxr.stats().lastUsedAt()).isEqualTo(last.toInstant());
        assertThat(cxr.stats().failed()).isEqualTo(2);
    }

    @Test
    void disablingIsAuditedOnceAndRepeatingItChangesNothing() {
        AiModel m = model("cxr", AiModel.Status.ACTIVE);
        when(models.findById(m.getId())).thenReturn(Optional.of(m));

        assertThat(service.disable(m.getId()).status()).isEqualTo("DISABLED");
        assertThat(service.disable(m.getId()).status()).isEqualTo("DISABLED");

        verify(models).saveAndFlush(m);
        ArgumentCaptor<AuditEvent> audit = ArgumentCaptor.forClass(AuditEvent.class);
        verify(events).publishEvent(audit.capture());
        assertThat(audit.getValue().action()).isEqualTo("MODEL_DISABLED");
        assertThat(audit.getValue().detail()).isEqualTo(Map.of("code", "cxr", "version", "1.0"));

        assertThat(service.enable(m.getId()).status()).isEqualTo("ACTIVE");
        verify(events, org.mockito.Mockito.times(2)).publishEvent(audit.capture());
        assertThat(audit.getValue().action()).isEqualTo("MODEL_ENABLED");
    }

    @Test
    void aRetiredModelCannotBeEnabled() {
        AiModel m = model("old", AiModel.Status.RETIRED);
        when(models.findById(m.getId())).thenReturn(Optional.of(m));
        assertThatThrownBy(() -> service.enable(m.getId())).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(e.getBody().getType().toString()).isEqualTo("/problems/model-status");
        });
        verify(models, never()).saveAndFlush(any());
    }

    @Test
    void anUnknownModelIsNotFound() {
        assertThatThrownBy(() -> service.disable(UUID.randomUUID())).isInstanceOfSatisfying(ApiException.class,
                e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }
}
