package com.medimg.report.domain;

/** The sections of a report written by the doctor (pre-filled from the reviewed findings); blank sections are null. */
public record ReportContent(String clinicalInfo, String technique, String findingsText, String impression) {

    public ReportContent {
        clinicalInfo = trimToNull(clinicalInfo);
        technique = trimToNull(technique);
        findingsText = trimToNull(findingsText);
        impression = trimToNull(impression);
    }

    private static String trimToNull(String value) {
        return value == null || value.isBlank() ? null : value.strip();
    }
}
