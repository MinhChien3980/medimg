package com.medimg.report.domain;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A PNG captured from the viewer and shown in a report, stored at {@code reports/{reportId}/key-images/{id}.png}.
 * It is uploaded by the browser after it was added; {@code uploadedAt} is set once the upload has been checked.
 */
@Entity
@Table(name = "report_key_image")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class KeyImage {

    private static final int MAX_CAPTION = 200;

    @Id
    private UUID id;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    private String caption;

    @Column(nullable = false)
    private short position;

    @Column(name = "uploaded_at")
    private Instant uploadedAt;

    KeyImage(UUID reportId, String caption, int position) {
        this.id = UUID.randomUUID();
        this.objectKey = "reports/" + reportId + "/key-images/" + id + ".png";
        this.caption = checkCaption(caption);
        this.position = (short) position;
    }

    public boolean isUploaded() {
        return uploadedAt != null;
    }

    void markUploaded(Instant now) {
        uploadedAt = now;
    }

    void place(int newPosition, String newCaption) {
        position = (short) newPosition;
        caption = checkCaption(newCaption);
    }

    /** The same image for an amending report, uploaded once its object has been copied to the new key. */
    KeyImage copyFor(UUID reportId, Instant now) {
        KeyImage copy = new KeyImage(reportId, caption, position);
        copy.uploadedAt = now;
        return copy;
    }

    private static String checkCaption(String caption) {
        String value = caption == null || caption.isBlank() ? null : caption.trim();
        if (value != null && value.length() > MAX_CAPTION) {
            throw new IllegalArgumentException("A caption has at most " + MAX_CAPTION + " characters");
        }
        return value;
    }
}
