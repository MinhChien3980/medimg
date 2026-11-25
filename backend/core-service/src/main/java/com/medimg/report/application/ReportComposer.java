package com.medimg.report.application;

import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import com.medimg.annotation.application.AnnotationDtos.AnnotationDto;
import com.medimg.annotation.application.AnnotationDtos.MeasurementDto;
import com.medimg.imaging.application.ImagingDtos.SeriesRef;
import com.medimg.imaging.application.ImagingDtos.StudyRef;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.ModelRef;
import com.medimg.report.domain.ReportLanguage;
import com.medimg.report.domain.ReportTemplate;

/**
 * The wording of reports: the sections pre-filled when a report is created (technique, findings) and the values the
 * PDF shows, in the report's language.
 */
@Component
class ReportComposer {

    private static final String AI = "AI";
    /** Message key prefix of the names of segmented structures ({@code structure.liver}). */
    private static final String STRUCTURE = "structure.";

    private final ReportMessages messages;

    ReportComposer(ReportMessages messages) {
        this.messages = messages;
    }

    /** The template's technique line from the study's metadata, then the AI models (code and version) that ran. */
    String technique(ReportTemplate template, ReportLanguage language, StudyRef study, List<ModelRef> models) {
        Locale locale = language.locale();
        SeriesRef series = study.series().getFirst();
        String modality = study.modality() == null ? msg(locale, "modality.unknown") : study.modality();
        String ai = models.isEmpty() ? msg(locale, "technique.noAi") : msg(locale, "technique.ai",
                models.stream().map(m -> m.code() + " " + m.version()).collect(Collectors.joining(", ")));
        return msg(locale, "technique." + template.name(), modality, size(locale, series), spacing(locale, series))
                + "\n" + ai;
    }

    /**
     * One line per confirmed finding (AI and added by hand, with confidence or volume and the review note), then one
     * per annotation that carries a label, a note or a measurement.
     */
    String findings(ReportLanguage language, List<FindingDto> confirmed, List<AnnotationDto> annotations) {
        Locale locale = language.locale();
        List<String> lines = new ArrayList<>();
        for (FindingDto f : confirmed) {
            String value = value(locale, f, "finding.confidence", "finding.volume");
            String detail = !AI.equals(f.source()) ? msg(locale, "finding.manual")
                    : value.isEmpty() ? AI : AI + ", " + value;
            lines.add(withNote(locale, msg(locale, "finding.item", label(locale, f), detail),
                    f.review() == null ? null : f.review().note()));
        }
        if (lines.isEmpty()) {
            lines.add(msg(locale, "findings.none"));
        }
        List<String> marks = annotations.stream()
                .filter(a -> a.label() != null || a.note() != null || a.measurement() != null)
                .map(a -> annotation(locale, a))
                .toList();
        if (!marks.isEmpty()) {
            lines.add("");
            lines.add(msg(locale, "annotations.heading"));
            lines.addAll(marks);
        }
        return String.join("\n", lines);
    }

    String title(ReportTemplate template, Locale locale) {
        return msg(locale, "report.title." + template.name());
    }

    /** {@code [x, y]} px of a 2D image, {@code [x, y, z]} voxels of a volume. */
    String size(Locale locale, SeriesRef series) {
        List<Integer> d = series.dims();
        return series.isVolume() ? msg(locale, "size.volume", d.get(0), d.get(1), d.get(2))
                : msg(locale, "size.image", d.get(0), d.get(1));
    }

    String sex(Locale locale, String sex) {
        return sex == null ? orUnknown(locale, null) : msg(locale, "sex." + sex);
    }

    /** The value, or a dash when it is not known. */
    String orUnknown(Locale locale, Object value) {
        return value == null ? msg(locale, "value.unknown") : value.toString();
    }

    /**
     * The label a report states. The doctor's words are kept as written: the corrected label of an EDITED finding, the
     * label of a finding added by hand. A model's label is named in the report's language when it is a segmented
     * structure ({@code liver} → "Gan" / "Liver"); any other (a chest X-ray finding such as "Pneumonia") is kept.
     */
    String label(Locale locale, FindingDto f) {
        if (f.review() != null && f.review().label() != null) {
            return f.review().label();
        }
        return AI.equals(f.source()) ? messages.find(locale, STRUCTURE + f.label()).orElse(f.label()) : f.label();
    }

    String source(Locale locale, FindingDto f) {
        String key = !AI.equals(f.source()) ? "source.MANUAL"
                : "EDITED".equals(f.reviewStatus()) ? "source.AI_EDITED" : "source.AI";
        return msg(locale, key);
    }

    /** Confidence of a classification, volume of a segmentation, empty for a finding added by hand. */
    String tableValue(Locale locale, FindingDto f) {
        return value(locale, f, "table.confidence", "table.volume");
    }

    String date(ReportLanguage language, Instant instant) {
        return formatter(language, "format.date").format(instant);
    }

    /** Date and time in the language's time zone, which is named. */
    String dateTime(ReportLanguage language, Instant instant) {
        return msg(language.locale(), "signature.time", formatter(language, "format.dateTime").format(instant));
    }

    private DateTimeFormatter formatter(ReportLanguage language, String key) {
        return DateTimeFormatter.ofPattern(msg(language.locale(), key), language.locale()).withZone(language.zone());
    }

    private String value(Locale locale, FindingDto f, String confidenceKey, String volumeKey) {
        if (f.confidence() != null) {
            return msg(locale, confidenceKey, f.confidence());
        }
        return f.volumeMl() == null ? "" : msg(locale, volumeKey, f.volumeMl());
    }

    private String spacing(Locale locale, SeriesRef series) {
        List<Double> s = series.spacing();
        if (s == null) {
            return msg(locale, "spacing.none");
        }
        return s.size() == 3 ? msg(locale, "spacing.volume", s.get(0), s.get(1), s.get(2))
                : msg(locale, "spacing.image", s.get(0), s.get(1));
    }

    private String annotation(Locale locale, AnnotationDto a) {
        String kind = msg(locale, "kind." + a.kind());
        List<String> details = new ArrayList<>();
        if (a.label() != null) {
            details.add(kind);
        }
        MeasurementDto m = a.measurement();
        if (m != null) {
            addMeasure(details, locale, "measure.lengthMm", m.lengthMm());
            addMeasure(details, locale, "measure.lengthPx", m.lengthPx());
            addMeasure(details, locale, "measure.areaMm2", m.areaMm2());
            addMeasure(details, locale, "measure.areaPx2", m.areaPx2());
            addMeasure(details, locale, "measure.meanHu", m.meanHu());
            addMeasure(details, locale, "measure.stdHu", m.stdHu());
        }
        String name = a.label() != null ? a.label() : kind;
        String line = details.isEmpty() ? "- " + name : msg(locale, "annotation.item", name, String.join(", ", details));
        return withNote(locale, line, a.note());
    }

    private void addMeasure(List<String> details, Locale locale, String key, Double value) {
        if (value != null) {
            details.add(msg(locale, key, value));
        }
    }

    private String withNote(Locale locale, String line, String note) {
        return note == null ? line : msg(locale, "finding.withNote", line, note);
    }

    private String msg(Locale locale, String key, Object... args) {
        return messages.get(locale, key, args);
    }
}
