package com.medimg.report.domain;

/** The two fixed report templates: chest X-ray (2D input) and CT (volume input). */
public enum ReportTemplate {
    CXR, CT;

    public static ReportTemplate defaultFor(boolean volume) {
        return volume ? CT : CXR;
    }
}
