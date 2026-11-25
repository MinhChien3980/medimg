package com.medimg.report.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A version of the report of a study, and its state machine.
 * <pre>
 * DRAFT ─(edit, refill, key images)─► DRAFT ─(sign)─► FINAL ─(amend)─► new DRAFT, version + 1, amending it
 *   └─(delete)
 * </pre>
 * Version 1 is written from scratch; each later version amends the final one before it, starting from a copy of its
 * content. A final report never changes again (the database rejects it too).
 */
@Entity
@Table(name = "report")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Report {

    public static final int MAX_KEY_IMAGES = 6;

    @Id
    private UUID id;

    @Column(name = "study_id", nullable = false)
    private UUID studyId;

    @Column(nullable = false)
    private int version;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ReportStatus status;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ReportTemplate template;

    @Convert(converter = ReportLanguage.Converter.class)
    @Column(nullable = false)
    private ReportLanguage language;

    @Column(name = "clinical_info")
    private String clinicalInfo;

    private String technique;

    @Column(name = "findings_text")
    private String findingsText;

    private String impression;

    @Column(name = "author_id", nullable = false)
    private UUID authorId;

    @Column(name = "signed_by")
    private UUID signedBy;

    @Column(name = "signed_at")
    private Instant signedAt;

    @Column(name = "amends_report_id")
    private UUID amendsReportId;

    /** The signed PDF, set when the report is signed. */
    @Column(name = "pdf_key")
    private String pdfKey;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(name = "row_version")
    private long rowVersion;

    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)
    @JoinColumn(name = "report_id", nullable = false, updatable = false)
    @OrderBy("position")
    private List<KeyImage> keyImages = new ArrayList<>();

    /** The findings the report was signed with; empty while it is a draft. */
    @ElementCollection
    @CollectionTable(name = "report_finding", joinColumns = @JoinColumn(name = "report_id"))
    @Column(name = "finding_id")
    private Set<UUID> citedFindings = new HashSet<>();

    private Report(UUID studyId, int version, ReportTemplate template, ReportLanguage language, ReportContent content,
                   UUID authorId, UUID amendsReportId, Instant now) {
        this.id = UUID.randomUUID();
        this.studyId = studyId;
        this.version = version;
        this.status = ReportStatus.DRAFT;
        this.template = template;
        this.language = language;
        this.authorId = authorId;
        this.amendsReportId = amendsReportId;
        this.createdAt = now;
        apply(content, now);
    }

    /** Version 1 of the report of a study. */
    public static Report first(UUID studyId, ReportTemplate template, ReportLanguage language, ReportContent content,
                               UUID authorId, Instant now) {
        return new Report(studyId, 1, template, language, content, authorId, null, now);
    }

    /**
     * The next version, amending this final report: a draft with its template, language, content and key images. The
     * caller copies each key image object to the key of its copy (same position).
     */
    public Report amend(UUID authorId, Instant now) {
        if (status != ReportStatus.FINAL) {
            throw new IllegalStateException("Only a final report can be amended; edit the draft instead");
        }
        Report next = new Report(studyId, version + 1, template, language, content(), authorId, id, now);
        keyImages.forEach(image -> next.keyImages.add(image.copyFor(next.id, now)));
        return next;
    }

    public ReportContent content() {
        return new ReportContent(clinicalInfo, technique, findingsText, impression);
    }

    public void edit(ReportContent content, Instant now) {
        requireDraft();
        apply(content, now);
    }

    /**
     * Rewrites the sections pre-filled from the study (technique, findings) with new wording; the doctor's clinical
     * information and impression are kept.
     */
    public void refill(String technique, String findingsText, Instant now) {
        requireDraft();
        apply(new ReportContent(clinicalInfo, technique, findingsText, impression), now);
    }

    public KeyImage addKeyImage(String caption, Instant now) {
        requireDraft();
        if (keyImages.size() >= MAX_KEY_IMAGES) {
            throw new IllegalStateException("A report has at most " + MAX_KEY_IMAGES + " key images");
        }
        KeyImage image = new KeyImage(id, caption, keyImages.size() + 1);
        keyImages.add(image);
        updatedAt = now;
        return image;
    }

    public Optional<KeyImage> findKeyImage(UUID imageId) {
        return keyImages.stream().filter(i -> i.getId().equals(imageId)).findFirst();
    }

    public void markKeyImageUploaded(UUID imageId, Instant now) {
        requireDraft();
        keyImage(imageId).markUploaded(now);
        updatedAt = now;
    }

    /** Removes the key image; the following ones move up. Returns it, so that its object can be deleted. */
    public KeyImage removeKeyImage(UUID imageId, Instant now) {
        requireDraft();
        KeyImage image = keyImage(imageId);
        keyImages.remove(image);
        renumber(keyImages.stream().map(KeyImage::getId).toList(), Map.of());
        updatedAt = now;
        return image;
    }

    /**
     * Puts the key images in the given order with the given captions; {@code order} lists each key image once.
     *
     * @throws IllegalArgumentException if it does not
     */
    public void arrangeKeyImages(List<UUID> order, Map<UUID, String> captions, Instant now) {
        requireDraft();
        Set<UUID> current = new HashSet<>(keyImages.stream().map(KeyImage::getId).toList());
        if (order.size() != current.size() || !current.equals(new HashSet<>(order))) {
            throw new IllegalArgumentException("keyImages must list each key image of the report once");
        }
        renumber(order, captions);
        keyImages.sort((a, b) -> Short.compare(a.getPosition(), b.getPosition()));
        updatedAt = now;
    }

    /**
     * Signs the draft: it becomes final, citing {@code findings}, with its PDF at {@link #pdfKeyOf(UUID)}.
     *
     * @throws IllegalArgumentException if the impression is empty
     * @throws IllegalStateException if the report is not a draft or a key image has not been uploaded
     */
    public void sign(UUID signerId, Collection<UUID> findings, Instant now) {
        requireDraft();
        if (impression == null) {
            throw new IllegalArgumentException("The impression must be written before the report is signed");
        }
        if (keyImages.stream().anyMatch(image -> !image.isUploaded())) {
            throw new IllegalStateException("A key image has not been uploaded; upload or remove it before signing");
        }
        status = ReportStatus.FINAL;
        signedBy = signerId;
        signedAt = now;
        pdfKey = pdfKeyOf(id);
        citedFindings.addAll(findings);
        updatedAt = now;
    }

    public boolean isFinal() {
        return status == ReportStatus.FINAL;
    }

    public boolean isAuthoredBy(UUID userId) {
        return authorId.equals(userId);
    }

    public static String pdfKeyOf(UUID reportId) {
        return "reports/" + reportId + "/report.pdf";
    }

    private void apply(ReportContent content, Instant now) {
        this.clinicalInfo = content.clinicalInfo();
        this.technique = content.technique();
        this.findingsText = content.findingsText();
        this.impression = content.impression();
        this.updatedAt = now;
    }

    /** Positions follow {@code order} from 1; a caption is replaced when {@code captions} has the image. */
    private void renumber(List<UUID> order, Map<UUID, String> captions) {
        for (int i = 0; i < order.size(); i++) {
            KeyImage image = keyImage(order.get(i));
            image.place(i + 1, captions.containsKey(image.getId()) ? captions.get(image.getId()) : image.getCaption());
        }
    }

    private KeyImage keyImage(UUID imageId) {
        return findKeyImage(imageId)
                .orElseThrow(() -> new IllegalArgumentException("Key image " + imageId + " is not part of report " + id));
    }

    private void requireDraft() {
        if (status != ReportStatus.DRAFT) {
            throw new IllegalStateException("Report " + id + " is final and cannot be changed; amend it instead");
        }
    }
}
