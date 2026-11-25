package com.medimg.prediction.application;

import java.util.UUID;

/** Whether a final report cites a finding; implemented by the report module, which depends on this one. */
public interface FindingCitations {

    boolean isCitedByFinalReport(UUID findingId);
}
