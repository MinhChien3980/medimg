package com.medimg.patient.api;

import java.time.Clock;
import java.time.Year;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

/** Instantiated by Spring, so the current year comes from the application {@link Clock}. */
class BirthYearValidator implements ConstraintValidator<BirthYear, Short> {

    static final int MIN = 1900;

    private final Clock clock;

    BirthYearValidator(Clock clock) {
        this.clock = clock;
    }

    @Override
    public boolean isValid(Short value, ConstraintValidatorContext context) {
        return value == null || (value >= MIN && value <= Year.now(clock).getValue());
    }
}
