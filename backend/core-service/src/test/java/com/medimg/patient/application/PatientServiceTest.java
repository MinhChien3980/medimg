package com.medimg.patient.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import com.medimg.patient.application.PatientService.CreatePatient;
import com.medimg.patient.domain.Patient;
import com.medimg.patient.infrastructure.PatientRepository;
import com.medimg.shared.web.ApiException;

class PatientServiceTest {

    private final PatientRepository patients = mock(PatientRepository.class);
    private final PatientService service = new PatientService(patients, mock(StudyCountPort.class),
            Clock.fixed(Instant.parse("2026-11-25T10:00:00Z"), ZoneOffset.UTC));

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
}
