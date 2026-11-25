package com.medimg.report.application;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.springframework.stereotype.Component;

import com.medimg.identity.application.UserDirectory;
import com.medimg.imaging.application.ImagingDtos.StudyRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.patient.application.PatientService;
import com.medimg.patient.application.PatientService.CaseRef;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.report.application.ReportDocument.Amendment;
import com.medimg.report.application.ReportDocument.CaseInfo;
import com.medimg.report.application.ReportDocument.Figure;
import com.medimg.report.application.ReportDocument.FindingRow;
import com.medimg.report.application.ReportDocument.Signature;
import com.medimg.report.application.ReportDocument.StudyInfo;
import com.medimg.report.domain.KeyImage;
import com.medimg.report.domain.Report;
import com.medimg.report.domain.ReportLanguage;
import com.medimg.report.infrastructure.ReportRepository;
import com.medimg.shared.storage.ObjectStoragePort;

/** Gathers what the PDF of a report shows: the case (pseudonymous), the study, the findings, the key images. */
@Component
class ReportDocuments {

    private final ReportRepository reports;
    private final StudyService studies;
    private final PatientService patients;
    private final UserDirectory users;
    private final ObjectStoragePort storage;
    private final ReportComposer composer;

    ReportDocuments(ReportRepository reports, StudyService studies, PatientService patients, UserDirectory users,
                    ObjectStoragePort storage, ReportComposer composer) {
        this.reports = reports;
        this.studies = studies;
        this.patients = patients;
        this.users = users;
        this.storage = storage;
        this.composer = composer;
    }

    /** {@code findings} are the confirmed findings of the study; key images not uploaded yet are left out. */
    ReportDocument assemble(Report report, List<FindingDto> findings) {
        ReportLanguage language = report.getLanguage();
        Locale locale = language.locale();
        StudyRef study = studies.describe(report.getStudyId());
        CaseRef patient = patients.describe(study.patientId());
        return new ReportDocument(locale, composer.title(report.getTemplate(), locale), !report.isFinal(),
                report.getVersion(), amendment(report),
                new CaseInfo(patient.code(), composer.orUnknown(locale, patient.birthYear()),
                        composer.sex(locale, patient.sex())),
                new StudyInfo(composer.orUnknown(locale, study.modality()), composer.date(language, study.createdAt()),
                        composer.size(locale, study.series().getFirst())),
                report.getClinicalInfo(), report.getTechnique(), report.getFindingsText(), report.getImpression(),
                findings.stream().map(f -> new FindingRow(composer.label(locale, f), composer.source(locale, f),
                        composer.tableValue(locale, f), f.review() == null ? null : f.review().note())).toList(),
                report.getKeyImages().stream().filter(KeyImage::isUploaded)
                        .map(image -> new Figure(image.getCaption(), storage.get(image.getObjectKey()))).toList(),
                report.isFinal() ? new Signature(signer(report.getSignedBy()),
                        composer.dateTime(language, report.getSignedAt())) : null);
    }

    private Amendment amendment(Report report) {
        if (report.getAmendsReportId() == null) {
            return null;
        }
        Report amended = reports.findById(report.getAmendsReportId()).orElseThrow();
        return new Amendment(amended.getVersion(), composer.date(report.getLanguage(), amended.getSignedAt()));
    }

    private String signer(UUID userId) {
        var signer = users.find(List.of(userId)).get(userId);
        return signer == null ? null : signer.fullName();
    }
}
