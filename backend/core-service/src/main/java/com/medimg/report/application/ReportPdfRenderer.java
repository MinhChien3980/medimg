package com.medimg.report.application;

/** Lays a report out as a PDF. */
public interface ReportPdfRenderer {

    byte[] render(ReportDocument document);
}
