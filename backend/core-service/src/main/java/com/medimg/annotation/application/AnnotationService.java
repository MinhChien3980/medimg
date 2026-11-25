package com.medimg.annotation.application;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.annotation.application.AnnotationDtos.AnnotationDto;
import com.medimg.annotation.application.AnnotationDtos.CreateAnnotation;
import com.medimg.annotation.application.AnnotationDtos.MeasurementDto;
import com.medimg.annotation.application.AnnotationDtos.UpdateAnnotation;
import com.medimg.annotation.application.AnnotationShapes.Shape;
import com.medimg.annotation.domain.Annotation;
import com.medimg.annotation.domain.AnnotationKind;
import com.medimg.annotation.domain.SeriesFrame;
import com.medimg.annotation.infrastructure.AnnotationRepository;
import com.medimg.identity.application.UserDirectory;
import com.medimg.identity.application.UserRef;
import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.StudyService;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.ExpectedVersion;

import tools.jackson.databind.ObjectMapper;

@Service
public class AnnotationService {

    private final AnnotationRepository annotations;
    private final StudyService studies;
    private final UserDirectory users;
    private final AnnotationShapes shapes;
    private final ObjectMapper json;
    private final Clock clock;

    AnnotationService(AnnotationRepository annotations, StudyService studies, UserDirectory users,
                      AnnotationShapes shapes, ObjectMapper json, Clock clock) {
        this.annotations = annotations;
        this.studies = studies;
        this.users = users;
        this.shapes = shapes;
        this.json = json;
        this.clock = clock;
    }

    /** The annotations of all series of the study, oldest first. */
    @Transactional(readOnly = true)
    public List<AnnotationDto> listByStudy(UUID studyId) {
        studies.requireExists(studyId);
        return toDtos(annotations.findByStudyIdOrderByCreatedAtAsc(studyId));
    }

    @Transactional
    @Audited(action = "ANNOTATION_CREATED", resource = "ANNOTATION")
    public AnnotationDto create(CreateAnnotation cmd) {
        SeriesRef series = studies.requireSeries(cmd.studyId(), cmd.seriesId());
        AnnotationKind kind = kind(cmd.kind());
        Shape shape = shapes.read(kind, frame(series), cmd.geometry(), cmd.measurement());
        Annotation annotation = annotations.save(new Annotation(series.studyId(), series.seriesId(), CurrentUser.id(),
                kind, shape.geometryJson(), trimToNull(cmd.label()), trimToNull(cmd.note()), shape.measurementJson(),
                clock.instant()));
        return toDtos(List.of(annotation)).getFirst();
    }

    @Transactional
    @Audited(action = "ANNOTATION_UPDATED", resource = "ANNOTATION")
    public AnnotationDto update(UUID id, UpdateAnnotation cmd) {
        Annotation annotation = requireOwn(id);
        ExpectedVersion.check("Annotation", id, cmd.version(), annotation.getVersion());
        SeriesRef series = studies.requireSeries(annotation.getStudyId(), annotation.getSeriesId());
        Shape shape = shapes.read(annotation.getKind(), frame(series), cmd.geometry(), cmd.measurement());
        annotation.update(shape.geometryJson(), trimToNull(cmd.label()), trimToNull(cmd.note()), shape.measurementJson(),
                clock.instant());
        annotations.flush(); // the returned version is the one after this change
        return toDtos(List.of(annotation)).getFirst();
    }

    @Transactional
    @Audited(action = "ANNOTATION_DELETED", resource = "ANNOTATION")
    public void delete(UUID id) {
        annotations.delete(requireOwn(id));
    }

    /** For the prediction module: a finding added by hand may point at an annotation of its series. */
    @Transactional(readOnly = true)
    public void requireOnSeries(UUID annotationId, UUID seriesId) {
        Annotation annotation = require(annotationId);
        if (!annotation.getSeriesId().equals(seriesId)) {
            throw ApiException.unprocessable("Annotation " + annotationId + " is not on series " + seriesId);
        }
    }

    private Annotation requireOwn(UUID id) {
        Annotation annotation = require(id);
        if (!annotation.isAuthoredBy(CurrentUser.id())) {
            throw ApiException.forbidden("Only the author of an annotation can change or delete it");
        }
        return annotation;
    }

    /** Annotations of a study that is no longer visible (its case was deleted) are not found either. */
    private Annotation require(UUID id) {
        return annotations.findById(id)
                .filter(a -> studies.exists(a.getStudyId()))
                .orElseThrow(() -> ApiException.notFound("Annotation", id));
    }

    private static SeriesFrame frame(SeriesRef series) {
        List<Integer> dims = series.dims();
        return series.isVolume() ? SeriesFrame.volume(dims) : SeriesFrame.image(dims.get(0), dims.get(1), series.spacing());
    }

    private static AnnotationKind kind(String value) {
        try {
            return AnnotationKind.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw ApiException.badRequest("Unknown annotation kind " + value);
        }
    }

    private List<AnnotationDto> toDtos(List<Annotation> list) {
        Map<UUID, UserRef> authors = users.find(list.stream().map(Annotation::getAuthorId).toList());
        return list.stream().map(a -> new AnnotationDto(a.getId(), a.getStudyId(), a.getSeriesId(), a.getKind().name(),
                json.readTree(a.getGeometry()), a.getLabel(), a.getNote(),
                a.getMeasurement() == null ? null : json.readValue(a.getMeasurement(), MeasurementDto.class),
                authors.get(a.getAuthorId()), a.getCreatedAt(), a.getUpdatedAt(), a.getVersion())).toList();
    }

    private static String trimToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
