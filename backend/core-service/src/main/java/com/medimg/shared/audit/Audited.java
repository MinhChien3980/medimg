package com.medimg.shared.audit;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks an application-service method whose invocation must be written to the audit log.
 * The resource id is taken from the first {@code UUID} argument, or from the returned object's {@code id()}
 * / {@code jobId()} / {@code uploadId()} accessor when the method creates the resource.
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Audited {

    String action();

    String resource();
}
