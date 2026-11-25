package com.medimg.report.application;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Stream;

import org.springframework.stereotype.Component;

import com.medimg.identity.application.UserDirectory;
import com.medimg.identity.application.UserRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.report.application.ReportDtos.KeyImageDto;
import com.medimg.report.application.ReportDtos.ReportDto;
import com.medimg.report.domain.KeyImage;
import com.medimg.report.domain.Report;
import com.medimg.report.infrastructure.ReportRepository;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.web.ApiException;

/** Loading reports for the services of this module and showing them in the API. */
@Component
class Reports {

    private final ReportRepository reports;
    private final StudyService studies;
    private final UserDirectory users;
    private final ObjectStoragePort storage;

    Reports(ReportRepository reports, StudyService studies, UserDirectory users, ObjectStoragePort storage) {
        this.reports = reports;
        this.studies = studies;
        this.users = users;
        this.storage = storage;
    }

    /** Reports of a study that is no longer visible (its case was deleted) are not found either. */
    Report require(UUID id) {
        return reports.findById(id).filter(r -> studies.exists(r.getStudyId()))
                .orElseThrow(() -> ApiException.notFound("Report", id));
    }

    /** As {@link #require(UUID)}, holding a lock on the report until the transaction ends. */
    Report requireForUpdate(UUID id) {
        return reports.findForUpdate(id).filter(r -> studies.exists(r.getStudyId()))
                .orElseThrow(() -> ApiException.notFound("Report", id));
    }

    KeyImage requireKeyImage(Report report, UUID imageId) {
        return report.findKeyImage(imageId).orElseThrow(() -> ApiException.notFound("Key image", imageId));
    }

    /**
     * Applies a change to a report, turning a broken rule into an API error: a change the report's state does not
     * allow (e.g. it is final) is a conflict, content that breaks a rule (e.g. no impression) is unprocessable.
     */
    static <T> T change(Supplier<T> action) {
        try {
            return action.get();
        } catch (IllegalStateException e) {
            throw ApiException.conflict(e.getMessage());
        } catch (IllegalArgumentException e) {
            throw ApiException.unprocessable(e.getMessage());
        }
    }

    static void change(Runnable action) {
        change(() -> {
            action.run();
            return null;
        });
    }

    ReportDto toDto(Report r) {
        Map<UUID, UserRef> people = people(List.of(r));
        return new ReportDto(r.getId(), r.getStudyId(), r.getVersion(), r.getStatus().name(), r.getTemplate().name(),
                r.getLanguage().tag(), r.getClinicalInfo(), r.getTechnique(), r.getFindingsText(), r.getImpression(),
                people.get(r.getAuthorId()), r.getSignedBy() == null ? null : people.get(r.getSignedBy()),
                r.getSignedAt(), r.getAmendsReportId(), r.getKeyImages().stream().map(this::toDto).toList(),
                r.getCreatedAt(), r.getUpdatedAt(), r.getRowVersion());
    }

    KeyImageDto toDto(KeyImage image) {
        return new KeyImageDto(image.getId(), image.getPosition(), image.getCaption(), image.isUploaded(),
                image.isUploaded() ? storage.presignGet(image.getObjectKey()).url() : null);
    }

    /** The authors and signers of the reports. */
    Map<UUID, UserRef> people(Collection<Report> list) {
        return users.find(list.stream().flatMap(r -> Stream.of(r.getAuthorId(), r.getSignedBy()))
                .filter(Objects::nonNull).toList());
    }
}
