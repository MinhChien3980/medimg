package com.medimg.prediction.application;

import java.time.Clock;
import java.util.Collection;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.annotation.application.AnnotationService;
import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.prediction.application.PredictionDtos.AddFinding;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.ReviewFinding;
import com.medimg.prediction.domain.Finding;
import com.medimg.prediction.domain.Finding.ReviewStatus;
import com.medimg.prediction.infrastructure.FindingRepository;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.ExpectedVersion;

/** Review of AI findings and findings added by hand, across all jobs of a study. */
@Service
public class FindingService {

    private final FindingRepository findings;
    private final StudyService studies;
    private final AnnotationService annotations;
    private final FindingCitations citations;
    private final FindingMapper mapper;
    private final Clock clock;

    FindingService(FindingRepository findings, StudyService studies, AnnotationService annotations,
                   FindingCitations citations, FindingMapper mapper, Clock clock) {
        this.findings = findings;
        this.studies = studies;
        this.annotations = annotations;
        this.citations = citations;
        this.mapper = mapper;
        this.clock = clock;
    }

    /** The findings of the study (of all its DONE jobs, and those added by hand) with one of the review statuses. */
    @Transactional(readOnly = true)
    public List<FindingDto> listByStudy(UUID studyId, Collection<String> statuses) {
        studies.requireExists(studyId);
        Set<ReviewStatus> wanted = statuses == null || statuses.isEmpty() ? EnumSet.allOf(ReviewStatus.class)
                : statuses.stream().map(FindingService::status).collect(Collectors.toCollection(() -> EnumSet.noneOf(ReviewStatus.class)));
        return mapper.toDtos(findings.findByStudy(studyId, wanted));
    }

    @Transactional
    @Audited(action = "FINDING_REVIEWED", resource = "FINDING")
    public FindingDto review(UUID id, ReviewFinding cmd) {
        Finding finding = require(id);
        ExpectedVersion.check("Finding", id, cmd.version(), finding.getVersion());
        try {
            finding.review(status(cmd.status()), cmd.label(), cmd.note(), CurrentUser.id(), clock.instant());
        } catch (IllegalStateException e) {
            throw ApiException.conflict(e.getMessage());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage());
        }
        findings.flush(); // the returned version is the one after this review
        return mapper.toDtos(List.of(finding)).getFirst();
    }

    @Transactional
    @Audited(action = "FINDING_ADDED", resource = "FINDING")
    public FindingDto add(AddFinding cmd) {
        SeriesRef series = studies.requireSeries(cmd.studyId(), cmd.seriesId());
        if (cmd.annotationId() != null) {
            annotations.requireOnSeries(cmd.annotationId(), series.seriesId());
        }
        Finding finding;
        try {
            finding = Finding.manual(series.studyId(), series.seriesId(), cmd.label(), cmd.note(), cmd.annotationId(),
                    CurrentUser.id(), clock.instant());
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest(e.getMessage());
        }
        return mapper.toDtos(List.of(findings.save(finding))).getFirst();
    }

    /** Only a finding added by hand, by its author, and not once a final report cites it. */
    @Transactional
    @Audited(action = "FINDING_DELETED", resource = "FINDING")
    public void delete(UUID id) {
        Finding finding = require(id);
        if (!finding.isManualBy(CurrentUser.id())) {
            throw ApiException.forbidden("Only a finding added by hand can be deleted, by the doctor who added it");
        }
        if (citations.isCitedByFinalReport(id)) {
            throw ApiException.conflict("The finding is part of a final report; amend the report instead");
        }
        findings.delete(finding);
    }

    /** Findings of a study that is no longer visible (its case was deleted) are not found either. */
    private Finding require(UUID id) {
        return findings.findById(id)
                .filter(f -> studies.exists(f.getStudyId()))
                .orElseThrow(() -> ApiException.notFound("Finding", id));
    }

    private static ReviewStatus status(String value) {
        try {
            return ReviewStatus.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("Unknown review status " + value);
        }
    }
}
