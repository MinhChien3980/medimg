package com.medimg.prediction.application;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;

import org.springframework.stereotype.Component;

import com.medimg.identity.application.UserDirectory;
import com.medimg.identity.application.UserRef;
import com.medimg.prediction.application.PredictionDtos.FindingDto;
import com.medimg.prediction.application.PredictionDtos.ReviewDto;
import com.medimg.prediction.domain.Finding;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/** Findings as the API shows them, with the names of their reviewers. */
@Component
class FindingMapper {

    private static final TypeReference<List<Double>> DOUBLE_LIST = new TypeReference<>() { };

    private final UserDirectory users;
    private final ObjectMapper json;

    FindingMapper(UserDirectory users, ObjectMapper json) {
        this.users = users;
        this.json = json;
    }

    List<FindingDto> toDtos(List<Finding> findings) {
        return findings.stream().map(converterFor(findings)).toList();
    }

    /** Converts any of the given findings; their reviewers are looked up once. */
    Function<Finding, FindingDto> converterFor(Collection<Finding> findings) {
        Map<UUID, UserRef> reviewers = users.find(findings.stream().map(Finding::getReviewedBy)
                .filter(Objects::nonNull).toList());
        return f -> new FindingDto(f.getId(), f.getSeriesId(), f.getSource().name(), f.getLabel(), f.getConfidence(),
                f.getVolumeMl(), f.getBbox() == null ? null : json.readValue(f.getBbox(), DOUBLE_LIST),
                f.getReviewStatus().name(),
                f.getReviewedBy() == null ? null : new ReviewDto(f.getReviewStatus().name(), f.getReviewLabel(),
                        f.getReviewNote(), reviewers.get(f.getReviewedBy()), f.getReviewedAt()),
                f.getAnnotationId(), f.getVersion());
    }
}
