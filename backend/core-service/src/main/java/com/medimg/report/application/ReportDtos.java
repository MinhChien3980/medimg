package com.medimg.report.application;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.medimg.identity.application.UserRef;

/** Public contract of the report module. */
public final class ReportDtos {

    private ReportDtos() {
    }

    /**
     * A version of the report of a study. {@code status} DRAFT or FINAL; {@code template} CXR or CT; {@code language}
     * vi or en. {@code signedBy}, {@code signedAt} are set once FINAL; {@code amendsReportId} from version 2 on.
     * {@code rowVersion} is sent back with a change.
     */
    public record ReportDto(UUID id, UUID studyId, int version, String status, String template, String language,
                            String clinicalInfo, String technique, String findingsText, String impression,
                            UserRef author, UserRef signedBy, Instant signedAt, UUID amendsReportId,
                            List<KeyImageDto> keyImages, Instant createdAt, Instant updatedAt, long rowVersion) {
    }

    /** A version in the history of a study's report. */
    public record ReportSummaryDto(UUID id, int version, String status, String template, String language,
                                   UserRef author, UserRef signedBy, Instant signedAt, UUID amendsReportId,
                                   Instant createdAt, Instant updatedAt) {
    }

    /** {@code url} (to view the PNG) is set once the image has been uploaded. */
    public record KeyImageDto(UUID id, int position, String caption, boolean uploaded, URI url) {
    }

    /** The image is uploaded with a PUT of {@code size} bytes of {@code image/png} to {@code putUrl}, then completed. */
    public record KeyImageUpload(UUID imageId, URI putUrl, Instant expiresAt) {
    }

    /** A short-lived link to the signed PDF. */
    public record PdfLink(URI url, Instant expiresAt) {
    }

    /** {@code template} is null for the default of the study (CXR for a 2D image, CT for a volume). */
    public record CreateReport(UUID studyId, String template, String language) {
    }

    /** {@code keyImages}, when given, lists every key image once, in the new order, with its caption. */
    public record UpdateReport(String clinicalInfo, String technique, String findingsText, String impression,
                               List<KeyImageOrder> keyImages, long rowVersion) {
    }

    /** A null {@code caption} keeps the caption of the image, a blank one removes it. */
    public record KeyImageOrder(UUID id, String caption) {
    }

    public record InitKeyImage(String contentType, long size, String caption) {
    }
}
