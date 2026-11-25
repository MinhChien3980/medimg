package com.medimg.report.application;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.annotation.application.AnnotationService;
import com.medimg.identity.application.UserRef;
import com.medimg.imaging.application.ImagingDtos.StudyRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.FindingService;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionService;
import com.medimg.report.application.ReportDtos.CreateReport;
import com.medimg.report.application.ReportDtos.KeyImageOrder;
import com.medimg.report.application.ReportDtos.PdfLink;
import com.medimg.report.application.ReportDtos.ReportDto;
import com.medimg.report.application.ReportDtos.ReportSummaryDto;
import com.medimg.report.application.ReportDtos.UpdateReport;
import com.medimg.report.domain.KeyImage;
import com.medimg.report.domain.Report;
import com.medimg.report.domain.ReportContent;
import com.medimg.report.domain.ReportLanguage;
import com.medimg.report.domain.ReportTemplate;
import com.medimg.report.infrastructure.ReportRepository;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.storage.ObjectStoragePort.PresignedUrl;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.ExpectedVersion;

/**
 * Reports of a study: version 1 is created with its technique and findings pre-filled from the study, the AI models
 * that ran and the confirmed findings and annotations (a draft is refilled from them on request, as they are then); a
 * draft is edited, previewed as a watermarked PDF, and signed, which renders and stores the final PDF; a final report
 * is amended by a new version.
 */
@Service
public class ReportService {

    /** The review statuses of the findings a report states. */
    static final List<String> CONFIRMED = List.of("ACCEPTED", "EDITED");

    private final ReportRepository repository;
    private final Reports reports;
    private final StudyService studies;
    private final FindingService findings;
    private final AnnotationService annotations;
    private final PredictionService predictions;
    private final ReportComposer composer;
    private final ReportDocuments documents;
    private final ReportPdfRenderer renderer;
    private final ReportFiles files;
    private final ObjectStoragePort storage;
    private final Clock clock;

    ReportService(ReportRepository repository, Reports reports, StudyService studies, FindingService findings,
                  AnnotationService annotations, PredictionService predictions, ReportComposer composer,
                  ReportDocuments documents, ReportPdfRenderer renderer, ReportFiles files, ObjectStoragePort storage,
                  Clock clock) {
        this.repository = repository;
        this.reports = reports;
        this.studies = studies;
        this.findings = findings;
        this.annotations = annotations;
        this.predictions = predictions;
        this.composer = composer;
        this.documents = documents;
        this.renderer = renderer;
        this.files = files;
        this.storage = storage;
        this.clock = clock;
    }

    /** Version 1 of the study's report; a study that already has one goes on with its draft or amends it. */
    @Transactional
    @Audited(action = "REPORT_CREATED", resource = "REPORT")
    public ReportDto create(CreateReport cmd) {
        StudyRef study = studies.describe(cmd.studyId());
        if (repository.existsByStudyId(study.id())) {
            throw ApiException.conflict("The study already has a report; edit its draft or amend its final version");
        }
        ReportLanguage language = parse(() -> ReportLanguage.of(cmd.language()));
        ReportTemplate template = cmd.template() == null ? ReportTemplate.defaultFor(study.isVolume())
                : parse(() -> ReportTemplate.valueOf(cmd.template().trim().toUpperCase(Locale.ROOT)));
        ReportContent content = new ReportContent(null, technique(template, language, study),
                findingsText(language, study), null);
        // flushed now, so that a concurrent create fails here on the unique version / single draft of the study
        return reports.toDto(repository.saveAndFlush(
                Report.first(study.id(), template, language, content, CurrentUser.id(), clock.instant())));
    }

    @Transactional(readOnly = true)
    public ReportDto get(UUID id) {
        return reports.toDto(reports.require(id));
    }

    /** The versions of the study's report, latest first. */
    @Transactional(readOnly = true)
    public List<ReportSummaryDto> listByStudy(UUID studyId) {
        studies.requireExists(studyId);
        List<Report> versions = repository.findByStudyIdOrderByVersionDesc(studyId);
        Map<UUID, UserRef> people = reports.people(versions);
        return versions.stream().map(r -> new ReportSummaryDto(r.getId(), r.getVersion(), r.getStatus().name(),
                r.getTemplate().name(), r.getLanguage().tag(), people.get(r.getAuthorId()),
                r.getSignedBy() == null ? null : people.get(r.getSignedBy()), r.getSignedAt(), r.getAmendsReportId(),
                r.getCreatedAt(), r.getUpdatedAt())).toList();
    }

    @Transactional
    @Audited(action = "REPORT_UPDATED", resource = "REPORT")
    public ReportDto update(UUID id, UpdateReport cmd) {
        Report report = reports.require(id);
        ExpectedVersion.check("Report", id, cmd.rowVersion(), report.getRowVersion());
        Instant now = clock.instant();
        Reports.change(() -> {
            report.edit(new ReportContent(cmd.clinicalInfo(), cmd.technique(), cmd.findingsText(), cmd.impression()), now);
            if (cmd.keyImages() != null) {
                report.arrangeKeyImages(cmd.keyImages().stream().map(KeyImageOrder::id).toList(),
                        cmd.keyImages().stream().filter(k -> k.caption() != null)
                                .collect(Collectors.toMap(KeyImageOrder::id, KeyImageOrder::caption, (a, b) -> b)),
                        now);
            }
        });
        repository.flush(); // the returned row version is the one after this change
        return reports.toDto(report);
    }

    /**
     * Rewrites the technique and findings of the draft, as at {@code rowVersion}, from the study as it is now: the AI
     * models that ran, the findings confirmed and the annotations made since the draft was written. The doctor's
     * clinical information and impression are kept; whatever the doctor wrote in the two rewritten sections is not.
     */
    @Transactional
    @Audited(action = "REPORT_REFILLED", resource = "REPORT")
    public ReportDto refill(UUID id, long rowVersion) {
        Report report = reports.require(id);
        ExpectedVersion.check("Report", id, rowVersion, report.getRowVersion());
        StudyRef study = studies.describe(report.getStudyId());
        String technique = technique(report.getTemplate(), report.getLanguage(), study);
        String findingsText = findingsText(report.getLanguage(), study);
        Reports.change(() -> report.refill(technique, findingsText, clock.instant()));
        repository.flush(); // the returned row version is the one after this change
        return reports.toDto(report);
    }

    /** Only a draft, by its author; its key images are deleted with it. */
    @Transactional
    @Audited(action = "REPORT_DELETED", resource = "REPORT")
    public void delete(UUID id) {
        Report report = reports.require(id);
        if (report.isFinal()) {
            throw ApiException.conflict("A final report cannot be deleted; amend it instead");
        }
        if (!report.isAuthoredBy(CurrentUser.id())) {
            throw ApiException.forbidden("Only the author of a draft report can delete it");
        }
        files.deleteAfterCommit(report.getKeyImages().stream().map(KeyImage::getObjectKey).toList());
        repository.delete(report);
    }

    /**
     * Signs the draft as it was at {@code rowVersion}: it becomes final, citing the study's confirmed findings, and its
     * PDF is rendered and stored. The report is locked meanwhile, so the stored PDF is the one of the signature.
     */
    @Transactional
    @Audited(action = "REPORT_FINALIZED", resource = "REPORT")
    public ReportDto sign(UUID id, long rowVersion) {
        Report report = reports.requireForUpdate(id);
        ExpectedVersion.check("Report", id, rowVersion, report.getRowVersion());
        List<FindingDto> confirmed = findings.listByStudy(report.getStudyId(), CONFIRMED);
        Reports.change(() -> report.sign(CurrentUser.id(), confirmed.stream().map(FindingDto::id).toList(),
                clock.instant()));
        storage.put(report.getPdfKey(), renderer.render(documents.assemble(report, confirmed)), "application/pdf");
        repository.flush();
        return reports.toDto(report);
    }

    /** A new draft version amending the latest version of the study's report, which must be final. */
    @Transactional
    @Audited(action = "REPORT_AMENDED", resource = "REPORT")
    public ReportDto amend(UUID id) {
        Report amended = reports.require(id);
        Report latest = repository.findFirstByStudyIdOrderByVersionDesc(amended.getStudyId()).orElseThrow();
        if (!latest.getId().equals(amended.getId())) {
            throw ApiException.conflict(latest.isFinal() ? "Only the latest version (v" + latest.getVersion()
                    + ") of the report can be amended" : "The report already has a draft (v" + latest.getVersion() + ")");
        }
        Report draft = Reports.change(() -> amended.amend(CurrentUser.id(), clock.instant()));
        List<KeyImage> sources = amended.getKeyImages();
        for (int i = 0; i < sources.size(); i++) {
            storage.copy(sources.get(i).getObjectKey(), draft.getKeyImages().get(i).getObjectKey());
        }
        return reports.toDto(repository.saveAndFlush(draft));
    }

    /** The draft as a watermarked PDF, with the study's findings as they are now. */
    @Transactional(readOnly = true)
    public byte[] preview(UUID id) {
        Report report = reports.require(id);
        if (report.isFinal()) {
            throw ApiException.conflict("The report is final; download its signed PDF");
        }
        return renderer.render(documents.assemble(report, findings.listByStudy(report.getStudyId(), CONFIRMED)));
    }

    @Transactional(readOnly = true)
    @Audited(action = "REPORT_PDF_DOWNLOADED", resource = "REPORT")
    public PdfLink pdf(UUID id) {
        Report report = reports.require(id);
        if (!report.isFinal()) {
            throw ApiException.conflict("A draft has no signed PDF; preview it instead");
        }
        PresignedUrl url = storage.presignGet(report.getPdfKey());
        return new PdfLink(url.url(), url.expiresAt());
    }

    /** The template's technique line for the study and the AI models that ran on it. */
    private String technique(ReportTemplate template, ReportLanguage language, StudyRef study) {
        return composer.technique(template, language, study, predictions.modelsOfDoneJobs(study.id()));
    }

    /** The study's confirmed findings, then its annotations. */
    private String findingsText(ReportLanguage language, StudyRef study) {
        return composer.findings(language, findings.listByStudy(study.id(), CONFIRMED),
                annotations.listByStudy(study.id()));
    }

    private static <T> T parse(Supplier<T> parser) {
        try {
            return parser.get();
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage());
        }
    }
}
