package com.medimg.imaging.application;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.imaging.domain.UploadSession;
import com.medimg.shared.outbox.Outbox;
import com.medimg.shared.storage.ObjectStoragePort;

import tools.jackson.databind.ObjectMapper;

/**
 * Hands one attempt of an upload to the ingest worker, through the outbox ({@code imaging.jobs}). {@code sliceSpacingMm}
 * is the requested voxel spacing as a JSON array, or empty.
 */
@Component
public class IngestDispatcher {

    /** Outbox message type of an ingest dispatch. */
    public static final String MESSAGE_TYPE = "INGEST_DISPATCH";

    private final Outbox outbox;
    private final ObjectStoragePort storage;
    private final ObjectMapper json;

    IngestDispatcher(Outbox outbox, ObjectStoragePort storage, ObjectMapper json) {
        this.outbox = outbox;
        this.storage = storage;
        this.json = json;
    }

    /** Schedules the upload's current attempt for publication at {@code availableAt}. */
    @Transactional(propagation = Propagation.MANDATORY)
    void dispatch(UploadSession upload, Instant availableAt) {
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("uploadId", upload.getId().toString());
        fields.put("attempt", Integer.toString(upload.getAttempt()));
        fields.put("inputType", upload.getIngestInput().name());
        fields.put("inputUri", storage.uri(upload.getFiles().getFirst().getStorageKey()));
        fields.put("outputPrefix", storage.uri(upload.outputPrefix()));
        fields.put("modalityHint", nullToEmpty(upload.getModalityHint()));
        fields.put("bodyPartHint", nullToEmpty(upload.getBodyPartHint()));
        List<Double> spacing = upload.requestedSpacing();
        fields.put("sliceSpacingMm", spacing == null ? "" : json.writeValueAsString(spacing));
        outbox.enqueue(MESSAGE_TYPE, upload.getId(), fields, availableAt);
    }

    /** Drops the dispatch of an upload that will not be ingested any more, if it has not been published yet. */
    @Transactional(propagation = Propagation.MANDATORY)
    void discardPending(UUID uploadId) {
        outbox.discardPending(MESSAGE_TYPE, uploadId);
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
