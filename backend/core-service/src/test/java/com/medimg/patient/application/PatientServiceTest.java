package com.medimg.patient.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import com.medimg.patient.application.PatientService.CreatePatient;
import com.medimg.patient.application.PatientService.MarkSample;
import com.medimg.patient.domain.Patient;
import com.medimg.patient.domain.Sample;
import com.medimg.patient.infrastructure.PatientRepository;
import com.medimg.shared.web.ApiException;

class PatientServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final PatientRepository patients = mock(PatientRepository.class);
    private final StudyCountPort studyCounts = mock(StudyCountPort.class);
    private final PatientService service = new PatientService(patients, studyCounts, Clock.fixed(NOW, ZoneOffset.UTC));

    @BeforeEach
    void authenticate() {
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "none").subject(UUID.randomUUID().toString()).build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void concurrentInsertOfTheSameCodeIsAConflict() {
        when(patients.existsByCode("CASE-1")).thenReturn(false); // the other request has not committed yet
        when(patients.saveAndFlush(any(Patient.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key value violates unique constraint"));

        assertThatThrownBy(() -> service.create(new CreatePatient("case-1", null, null, null)))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getStatusCode().value()).isEqualTo(409);
                    assertThat(e.getMessage()).isEqualTo("Case code CASE-1 already exists");
                });
    }

    @Test
    void caseIsMarkedAndUnmarkedAsASample() {
        Patient p = existing();
        when(studyCounts.countByPatient(List.of(p.getId()))).thenReturn(Map.of(p.getId(), 2L));

        PatientDto marked = service.markSample(p.getId(), new MarkSample(" Abdomen CT ", "  ", " TotalSegmentator, CC BY 4.0 "));

        assertThat(marked.sample()).isEqualTo(new PatientDto.Sample("Abdomen CT", null, "TotalSegmentator, CC BY 4.0"));
        assertThat(marked.studyCount()).isEqualTo(2);
        assertThat(p.getUpdatedAt()).isEqualTo(NOW);

        service.unmarkSample(p.getId());
        assertThat(p.getSample()).isNull();
        service.unmarkSample(p.getId()); // not a sample any more: nothing to do
        assertThat(p.getSample()).isNull();
    }

    @Test
    void sampleNeedsATitleAndASource() {
        Patient p = existing();

        assertThatThrownBy(() -> service.markSample(p.getId(), new MarkSample(" ", null, "source")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(p.getSample()).isNull();
    }

    @Test
    void samplesAreListedWithTheirStudyCount() {
        Patient p = existing();
        p.markAsSample(new Sample("Chest CT", "Lungs", "Zenodo"), NOW);
        when(patients.findSamples()).thenReturn(List.of(p));
        when(studyCounts.countByPatient(List.of(p.getId()))).thenReturn(Map.of());

        assertThat(service.listSamples()).singleElement().satisfies(dto -> {
            assertThat(dto.sample().title()).isEqualTo("Chest CT");
            assertThat(dto.sample().description()).isEqualTo("Lungs");
            assertThat(dto.studyCount()).isZero();
        });
    }

    private Patient existing() {
        Patient p = new Patient("CASE-1", null, null, null, UUID.randomUUID(), NOW.minusSeconds(60));
        when(patients.findByIdAndDeletedAtIsNull(p.getId())).thenReturn(Optional.of(p));
        return p;
    }
}
