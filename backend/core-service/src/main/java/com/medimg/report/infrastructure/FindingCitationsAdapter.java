package com.medimg.report.infrastructure;

import java.util.UUID;

import org.springframework.stereotype.Component;

import com.medimg.prediction.application.FindingCitations;

/** Only final reports cite findings: the cited findings are recorded when a report is signed. */
@Component
class FindingCitationsAdapter implements FindingCitations {

    private final ReportRepository reports;

    FindingCitationsAdapter(ReportRepository reports) {
        this.reports = reports;
    }

    @Override
    public boolean isCitedByFinalReport(UUID findingId) {
        return reports.citesFinding(findingId);
    }
}
