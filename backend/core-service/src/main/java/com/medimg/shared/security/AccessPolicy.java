package com.medimg.shared.security;

/**
 * Method security expressions shared by the controllers. RESEARCHER is read-only; deleting a case is reserved to
 * ADMIN; clinical content (review, annotations, reports) is written by clinicians only, not by ADMIN.
 */
public final class AccessPolicy {

    public static final String READ = "hasAnyRole('ADMIN','DOCTOR','TECHNICIAN','RESEARCHER')";

    public static final String WRITE = "hasAnyRole('ADMIN','DOCTOR','TECHNICIAN')";

    public static final String ADMIN = "hasRole('ADMIN')";

    /** Reviewing AI findings and adding findings by hand. */
    public static final String REVIEW = "hasRole('DOCTOR')";

    /** Drawing annotations; only their author changes or deletes them afterwards. */
    public static final String ANNOTATE = "hasAnyRole('DOCTOR','TECHNICIAN')";

    /** Writing draft reports and their key images, signing them and amending final ones. */
    public static final String REPORT = "hasRole('DOCTOR')";

    /** Draft reports are hidden from RESEARCHER, who only sees final ones. */
    public static final String READ_DRAFT_REPORTS = "hasAnyRole('ADMIN','DOCTOR','TECHNICIAN')";

    /** {@code @PostAuthorize} on a method returning a report: final reports for every reader, drafts as above. */
    public static final String READ_RETURNED_REPORT = "returnObject.status() == 'FINAL' or " + READ_DRAFT_REPORTS;

    /** {@code @PostFilter} on a method returning reports (a mutable collection): keeps those the caller may read. */
    public static final String FILTER_READABLE_REPORTS = "filterObject.status() == 'FINAL' or " + READ_DRAFT_REPORTS;

    private AccessPolicy() {
    }
}
