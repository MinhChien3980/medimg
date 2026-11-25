package com.medimg.shared.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.ProblemDetail;

class GlobalExceptionHandlerTest {

    @Test
    void integrityViolationIsAConflictWithoutDatabaseDetails() {
        ProblemDetail pd = new GlobalExceptionHandler().dataIntegrityViolation(new DataIntegrityViolationException(
                "ERROR: duplicate key value violates unique constraint \"patient_code_key\""));

        assertThat(pd.getStatus()).isEqualTo(409);
        assertThat(pd.getTitle()).isEqualTo("Conflict");
        assertThat(pd.getDetail()).doesNotContain("patient_code_key").doesNotContain("duplicate key");
    }
}
