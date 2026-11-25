package com.medimg.sample.application;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.ImagingDtos.SeriesDto;
import com.medimg.imaging.application.ImagingDtos.StudyDto;
import com.medimg.imaging.application.StudyService;
import com.medimg.patient.application.PatientDto;
import com.medimg.patient.application.PatientService;
import com.medimg.prediction.application.PredictionDtos.JobSummary;
import com.medimg.prediction.application.PredictionService;

/** The samples page: sample cases with their studies, open to every role. Read-only, it composes the other modules. */
@Service
public class SampleService {

    /** {@code thumbnailUrl} is that of the study's first series; {@code latestPrediction} is null without any job. */
    public record SampleStudy(UUID studyId, String inputType, String modality, URI thumbnailUrl,
                              JobSummary latestPrediction) {
    }

    public record SampleCase(UUID patientId, String code, String title, String description, String source,
                             List<SampleStudy> studies) {
    }

    private final PatientService patients;
    private final StudyService studies;
    private final PredictionService predictions;

    SampleService(PatientService patients, StudyService studies, PredictionService predictions) {
        this.patients = patients;
        this.studies = studies;
        this.predictions = predictions;
    }

    /** Sample cases by title, each with its studies newest first. */
    @Transactional(readOnly = true)
    public List<SampleCase> list() {
        List<PatientDto> samples = patients.listSamples();
        Map<UUID, List<StudyDto>> studiesByCase = studies.listByPatients(samples.stream().map(PatientDto::id).toList());
        Map<UUID, JobSummary> latest = predictions.latestByStudy(studiesByCase.values().stream()
                .flatMap(List::stream).map(StudyDto::id).toList());
        return samples.stream().map(p -> new SampleCase(p.id(), p.code(), p.sample().title(), p.sample().description(),
                p.sample().source(), studiesByCase.getOrDefault(p.id(), List.of()).stream()
                        .map(s -> new SampleStudy(s.id(), s.inputType(), s.modality(), thumbnail(s), latest.get(s.id())))
                        .toList()))
                .toList();
    }

    private static URI thumbnail(StudyDto study) {
        return study.series().stream().map(SeriesDto::thumbnailUrl).filter(Objects::nonNull).findFirst().orElse(null);
    }
}
