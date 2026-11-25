package com.medimg.patient.api;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;

/** A year between {@value BirthYearValidator#MIN} and the current year (UTC); null is valid. */
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = BirthYearValidator.class)
@interface BirthYear {

    String message() default "must be between 1900 and the current year";

    Class<?>[] groups() default { };

    Class<? extends Payload>[] payload() default { };
}
