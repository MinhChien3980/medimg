package com.medimg.sample.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.medimg.imaging.application.ImagingDtos.SeriesDto;
import com.medimg.imaging.application.ImagingDtos.StudyDto;
import com.medimg.imaging.application.StudyService;
import com.medimg.patient.application.PatientDto;
import com.medimg.patient.application.PatientService;
import com.medimg.prediction.application.PredictionDtos.JobSummary;
import com.medimg.prediction.application.PredictionService;
import com.medimg.sample.application.SampleService.SampleCase;
import com.medimg.sample.application.SampleService.SampleStudy;

class SampleServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-25T10:00:00Z");

    private final PatientService patients = mock(PatientService.class);
    private final StudyService studies = mock(StudyService.class);
    private final PredictionService predictions = mock(PredictionService.class);
    private final SampleService service = new SampleService(patients, studies, predictions);

    @Test
    void samplesComeWithTheirStudiesThumbnailsAndLatestPrediction() {
        PatientDto abdomen = sample("Abdomen CT");
        PatientDto empty = sample("Empty");
        UUID segmented = UUID.randomUUID();
        UUID plain = UUID.randomUUID();
        URI thumb = URI.create("http://s3/thumb.png");
        when(patients.listSamples()).thenReturn(List.of(abdomen, empty));
        when(studies.listByPatients(List.of(abdomen.id(), empty.id()))).thenReturn(Map.of(abdomen.id(), List.of(
                study(segmented, abdomen.id(), series(null), series(thumb)),
                study(plain, abdomen.id()))));
        JobSummary job = new JobSummary(UUID.randomUUID(), "ct-totalseg", "DONE");
        when(predictions.latestByStudy(List.of(segmented, plain))).thenReturn(Map.of(segmented, job));

        List<SampleCase> samples = service.list();

        assertThat(samples).extracting(SampleCase::title).containsExactly("Abdomen CT", "Empty");
        SampleCase first = samples.getFirst();
        assertThat(first.patientId()).isEqualTo(abdomen.id());
        assertThat(first.code()).isEqualTo("CASE-1");
        assertThat(first.description()).isEqualTo("Abdomen CT, described");
        assertThat(first.source()).isEqualTo("Zenodo, CC BY 4.0");
        assertThat(first.studies()).containsExactly(
                new SampleStudy(segmented, "NIFTI", "CT", thumb, job),
                new SampleStudy(plain, "NIFTI", "CT", null, null));
        assertThat(samples.get(1).studies()).isEmpty();
    }

    private static PatientDto sample(String title) {
        return new PatientDto(UUID.randomUUID(), "CASE-1", null, null, null, 0, NOW,
                new PatientDto.Sample(title, title + ", described", "Zenodo, CC BY 4.0"));
    }

    private static StudyDto study(UUID id, UUID patientId, SeriesDto... series) {
        return new StudyDto(id, patientId, "NIFTI", "CT", null, NOW, List.of(series));
    }

    private static SeriesDto series(URI thumbnail) {
        return new SeriesDto(UUID.randomUUID(), "CT", 512, 512, 100, null, thumbnail, null, null, null, false);
    }
}
