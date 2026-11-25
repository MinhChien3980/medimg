package com.medimg.report.api;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PostAuthorize;
import org.springframework.security.access.prepost.PostFilter;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.report.application.KeyImageService;
import com.medimg.report.application.ReportDtos.CreateReport;
import com.medimg.report.application.ReportDtos.InitKeyImage;
import com.medimg.report.application.ReportDtos.KeyImageDto;
import com.medimg.report.application.ReportDtos.KeyImageOrder;
import com.medimg.report.application.ReportDtos.KeyImageUpload;
import com.medimg.report.application.ReportDtos.PdfLink;
import com.medimg.report.application.ReportDtos.ReportDto;
import com.medimg.report.application.ReportDtos.ReportSummaryDto;
import com.medimg.report.application.ReportDtos.UpdateReport;
import com.medimg.report.application.ReportService;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Reports")
@PreAuthorize(AccessPolicy.READ)
class ReportController {

    /** {@code template} CXR or CT, by default CXR for a 2D image and CT for a volume. */
    record CreateRequest(@Pattern(regexp = "CXR|CT") String template, @NotNull @Pattern(regexp = "vi|en") String language) {
    }

    record KeyImageRequest(@NotNull UUID id, @Size(max = 200) String caption) {
    }

    /** {@code keyImages}, when given, lists every key image once, in the new order; {@code rowVersion} as last read. */
    record UpdateRequest(@Size(max = 2000) String clinicalInfo, @Size(max = 4000) String technique,
                         @Size(max = 10_000) String findingsText, @Size(max = 4000) String impression,
                         @Size(max = 6) List<@Valid KeyImageRequest> keyImages, @NotNull Long rowVersion) {
    }

    record InitKeyImageRequest(@NotBlank String contentType, @Positive long size, @Size(max = 200) String caption) {
    }

    /** The version of the draft the doctor signs, as last read: a draft changed since is not signed. */
    record FinalizeRequest(@NotNull Long rowVersion) {
    }

    /** The version of the draft whose technique and findings are rewritten, as last read. */
    record RefillRequest(@NotNull Long rowVersion) {
    }

    private final ReportService reports;
    private final KeyImageService keyImages;

    ReportController(ReportService reports, KeyImageService keyImages) {
        this.reports = reports;
        this.keyImages = keyImages;
    }

    @PostMapping("/studies/{studyId}/reports")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.REPORT)
    ReportDto create(@PathVariable UUID studyId, @Valid @RequestBody CreateRequest req) {
        return reports.create(new CreateReport(studyId, req.template(), req.language()));
    }

    /** The versions of the study's report, latest first; drafts only for the roles that may read them. */
    @GetMapping("/studies/{studyId}/reports")
    @PostFilter(AccessPolicy.FILTER_READABLE_REPORTS)
    List<ReportSummaryDto> byStudy(@PathVariable UUID studyId) {
        return new ArrayList<>(reports.listByStudy(studyId)); // filtered in place
    }

    @GetMapping("/reports/{id}")
    @PostAuthorize(AccessPolicy.READ_RETURNED_REPORT)
    ReportDto get(@PathVariable UUID id) {
        return reports.get(id);
    }

    @PutMapping("/reports/{id}")
    @PreAuthorize(AccessPolicy.REPORT)
    ReportDto update(@PathVariable UUID id, @Valid @RequestBody UpdateRequest req) {
        List<KeyImageOrder> order = req.keyImages() == null ? null
                : req.keyImages().stream().map(k -> new KeyImageOrder(k.id(), k.caption())).toList();
        return reports.update(id, new UpdateReport(req.clinicalInfo(), req.technique(), req.findingsText(),
                req.impression(), order, req.rowVersion()));
    }

    @DeleteMapping("/reports/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(AccessPolicy.REPORT)
    void delete(@PathVariable UUID id) {
        reports.delete(id);
    }

    @PostMapping("/reports/{id}/key-images/init")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.REPORT)
    KeyImageUpload initKeyImage(@PathVariable UUID id, @Valid @RequestBody InitKeyImageRequest req) {
        return keyImages.init(id, new InitKeyImage(req.contentType(), req.size(), req.caption()));
    }

    @PostMapping("/reports/{id}/key-images/{imageId}/complete")
    @PreAuthorize(AccessPolicy.REPORT)
    KeyImageDto completeKeyImage(@PathVariable UUID id, @PathVariable UUID imageId) {
        return keyImages.complete(id, imageId);
    }

    @DeleteMapping("/reports/{id}/key-images/{imageId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(AccessPolicy.REPORT)
    void deleteKeyImage(@PathVariable UUID id, @PathVariable UUID imageId) {
        keyImages.delete(id, imageId);
    }

    /** The draft as a PDF with a DRAFT watermark. */
    @GetMapping(path = "/reports/{id}/preview.pdf", produces = MediaType.APPLICATION_PDF_VALUE)
    @PreAuthorize(AccessPolicy.READ_DRAFT_REPORTS)
    byte[] preview(@PathVariable UUID id) {
        return reports.preview(id);
    }

    @PostMapping("/reports/{id}/finalize")
    @PreAuthorize(AccessPolicy.REPORT)
    ReportDto finalizeReport(@PathVariable UUID id, @Valid @RequestBody FinalizeRequest req) {
        return reports.sign(id, req.rowVersion());
    }

    /**
     * Rewrites the technique and findings sections of a draft from the study's current findings and annotations (the
     * other sections are kept); 409 when the draft has changed since {@code rowVersion} or is final.
     */
    @PostMapping("/reports/{id}/refill")
    @PreAuthorize(AccessPolicy.REPORT)
    ReportDto refill(@PathVariable UUID id, @Valid @RequestBody RefillRequest req) {
        return reports.refill(id, req.rowVersion());
    }

    @PostMapping("/reports/{id}/amend")
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AccessPolicy.REPORT)
    ReportDto amend(@PathVariable UUID id) {
        return reports.amend(id);
    }

    /** A short-lived link to the signed PDF of a final report. */
    @GetMapping("/reports/{id}/pdf")
    PdfLink pdf(@PathVariable UUID id) {
        return reports.pdf(id);
    }
}
