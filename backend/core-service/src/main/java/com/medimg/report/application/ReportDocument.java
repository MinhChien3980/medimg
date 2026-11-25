package com.medimg.report.application;

import java.util.List;
import java.util.Locale;

/**
 * Everything the PDF of a report shows, already worded and formatted in its language; the renderer only lays it out.
 * {@code draft} adds the watermark; {@code amendment} and {@code signature} are null when they do not apply.
 */
public record ReportDocument(Locale locale, String title, boolean draft, int version, Amendment amendment,
                             CaseInfo patient, StudyInfo study, String clinicalInfo, String technique,
                             String findingsText, String impression, List<FindingRow> findings, List<Figure> figures,
                             Signature signature) {

    public String languageTag() {
        return locale.toLanguageTag();
    }

    /** The report this version amends: its version and the day it was signed. */
    public record Amendment(int version, String signedOn) {
    }

    public record CaseInfo(String code, String birthYear, String sex) {
    }

    public record StudyInfo(String modality, String date, String size) {
    }

    public record FindingRow(String label, String source, String value, String note) {
    }

    /** A key image: PNG bytes and caption. */
    public record Figure(String caption, byte[] png) {
    }

    public record Signature(String signer, String signedAt) {
    }
}
