package com.medimg.imaging.application;

import java.net.URI;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.application.ImagingDtos.SeriesDto;
import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.ImagingDtos.StudyDto;
import com.medimg.imaging.domain.Series;
import com.medimg.imaging.domain.Study;
import com.medimg.imaging.infrastructure.SeriesRepository;
import com.medimg.imaging.infrastructure.StudyRepository;
import com.medimg.patient.application.PatientService;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.web.ApiException;

@Service
public class StudyService {

    private final StudyRepository studies;
    private final SeriesRepository series;
    private final PatientService patients;
    private final ObjectStoragePort storage;

    StudyService(StudyRepository studies, SeriesRepository series, PatientService patients, ObjectStoragePort storage) {
        this.studies = studies;
        this.series = series;
        this.patients = patients;
        this.storage = storage;
    }

    @Transactional(readOnly = true)
    @Audited(action = "STUDY_VIEW", resource = "STUDY")
    public StudyDto get(UUID studyId) {
        Study study = require(studyId);
        return toDto(study, series.findByStudyIdOrderByCreatedAtAsc(studyId));
    }

    @Transactional(readOnly = true)
    public List<StudyDto> listByPatient(UUID patientId) {
        patients.requireExists(patientId);
        return toDtos(studies.findByPatientIdInOrderByCreatedAtDesc(List.of(patientId)));
    }

    /** Studies of each of the given cases, newest first; for cases the caller has already checked. */
    @Transactional(readOnly = true)
    public Map<UUID, List<StudyDto>> listByPatients(Collection<UUID> patientIds) {
        return toDtos(studies.findByPatientIdInOrderByCreatedAtDesc(patientIds)).stream()
                .collect(Collectors.groupingBy(StudyDto::patientId));
    }

    /** For the prediction module: validates that the series belongs to the study. */
    @Transactional(readOnly = true)
    public SeriesRef requireSeries(UUID studyId, UUID seriesId) {
        Study study = require(studyId);
        Series s = series.findById(seriesId)
                .filter(x -> x.getStudyId().equals(studyId))
                .orElseThrow(() -> ApiException.notFound("Series", seriesId));
        return new SeriesRef(study.getId(), s.getId(), study.getPatientId(), study.getInputType().name(),
                s.getModality(), study.getBodyPart(), study.getInputType().normalized().name(), storage.uri(s.getImageKey()));
    }

    @Transactional(readOnly = true)
    public void requireExists(UUID studyId) {
        require(studyId);
    }

    /** False for unknown studies and for studies of a deleted case. */
    @Transactional(readOnly = true)
    public boolean exists(UUID studyId) {
        return find(studyId).isPresent();
    }

    private Study require(UUID id) {
        return find(id).orElseThrow(() -> ApiException.notFound("Study", id));
    }

    private Optional<Study> find(UUID id) {
        return studies.findById(id).filter(s -> patients.exists(s.getPatientId()));
    }

    private List<StudyDto> toDtos(List<Study> list) {
        Map<UUID, List<Series>> byStudy = series.findByStudyIdIn(list.stream().map(Study::getId).toList()).stream()
                .collect(Collectors.groupingBy(Series::getStudyId));
        return list.stream().map(s -> toDto(s, byStudy.getOrDefault(s.getId(), List.of()))).toList();
    }

    private StudyDto toDto(Study study, List<Series> seriesList) {
        return new StudyDto(study.getId(), study.getPatientId(), study.getInputType().name(), study.getModality(),
                study.getBodyPart(), study.getCreatedAt(),
                seriesList.stream().map(s -> toDto(s, study.getInputType().isVolume())).toList());
    }

    private SeriesDto toDto(Series s, boolean volume) {
        URI stored = url(s.getImageKey());
        return new SeriesDto(s.getId(), s.getModality(), s.getRows(), s.getCols(), s.getNumImages(),
                volume ? null : stored, url(s.getThumbnailKey()), volume ? stored : null,
                volume ? s.dims() : null, volume ? s.spacing() : null, s.isSpacingAssumed());
    }

    private URI url(String key) {
        return key == null ? null : storage.presignGet(key).url();
    }
}
