package com.medimg.shared.security;

/**
 * {@code @PreAuthorize} expressions shared by the controllers. RESEARCHER is read-only; deleting a case is
 * reserved to ADMIN.
 */
public final class AccessPolicy {

    public static final String READ = "hasAnyRole('ADMIN','DOCTOR','TECHNICIAN','RESEARCHER')";

    public static final String WRITE = "hasAnyRole('ADMIN','DOCTOR','TECHNICIAN')";

    public static final String ADMIN = "hasRole('ADMIN')";

    private AccessPolicy() {
    }
}
