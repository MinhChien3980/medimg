package com.medimg.report.application;

import java.time.Clock;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.medimg.report.application.ReportDtos.InitKeyImage;
import com.medimg.report.application.ReportDtos.KeyImageDto;
import com.medimg.report.application.ReportDtos.KeyImageUpload;
import com.medimg.report.domain.KeyImage;
import com.medimg.report.domain.Report;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.storage.ObjectNotFoundException;
import com.medimg.shared.storage.ObjectStoragePort;
import com.medimg.shared.storage.ObjectStoragePort.PresignedUrl;
import com.medimg.shared.web.ApiException;

/**
 * Key images of a draft report, captured in the browser: init (a presigned PUT, the PNG goes to object storage
 * directly) → complete (the object must exist and be a PNG of at most 5 MB) → shown in the report. Changes to the key
 * images are changes of the report and audited as such.
 */
@Service
public class KeyImageService {

    static final String PNG = "image/png";
    static final long MAX_BYTES = 5L * 1024 * 1024;
    private static final byte[] PNG_SIGNATURE = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'};

    private final Reports reports;
    private final ReportFiles files;
    private final ObjectStoragePort storage;
    private final Clock clock;

    KeyImageService(Reports reports, ReportFiles files, ObjectStoragePort storage, Clock clock) {
        this.reports = reports;
        this.files = files;
        this.storage = storage;
        this.clock = clock;
    }

    @Transactional
    @Audited(action = "REPORT_UPDATED", resource = "REPORT")
    public KeyImageUpload init(UUID reportId, InitKeyImage cmd) {
        if (!PNG.equals(cmd.contentType())) {
            throw ApiException.badRequest("A key image is a PNG (" + PNG + ")");
        }
        if (cmd.size() <= 0 || cmd.size() > MAX_BYTES) {
            throw ApiException.badRequest("A key image has 1 byte to " + MAX_BYTES / (1024 * 1024) + " MB");
        }
        Report report = reports.require(reportId);
        KeyImage added = Reports.change(() -> report.addKeyImage(cmd.caption(), clock.instant()));
        PresignedUrl put = storage.presignPut(added.getObjectKey(), PNG, cmd.size());
        return new KeyImageUpload(added.getId(), put.url(), put.expiresAt());
    }

    /**
     * Checks the uploaded object. One that is not a PNG of at most 5 MB is removed with its key image, so that the slot
     * is free again; the removal is kept although the request fails.
     */
    @Transactional(noRollbackFor = ApiException.class)
    @Audited(action = "REPORT_UPDATED", resource = "REPORT")
    public KeyImageDto complete(UUID reportId, UUID imageId) {
        Report report = reports.require(reportId);
        KeyImage image = reports.requireKeyImage(report, imageId);
        if (image.isUploaded()) {
            return reports.toDto(image); // completing twice is harmless
        }
        long size;
        try {
            size = storage.size(image.getObjectKey());
        } catch (ObjectNotFoundException e) {
            throw ApiException.conflict("Key image " + imageId + " has not been uploaded yet");
        }
        byte[] head = storage.getFirstBytes(image.getObjectKey(), PNG_SIGNATURE.length);
        if (size > MAX_BYTES || !Arrays.equals(head, PNG_SIGNATURE)) {
            Reports.change(() -> report.removeKeyImage(imageId, clock.instant()));
            files.deleteAfterCommit(List.of(image.getObjectKey()));
            throw ApiException.unprocessable("The uploaded key image is not a PNG of at most "
                    + MAX_BYTES / (1024 * 1024) + " MB; it was removed");
        }
        Reports.change(() -> report.markKeyImageUploaded(imageId, clock.instant()));
        return reports.toDto(image);
    }

    @Transactional
    @Audited(action = "REPORT_UPDATED", resource = "REPORT")
    public void delete(UUID reportId, UUID imageId) {
        Report report = reports.require(reportId);
        KeyImage image = reports.requireKeyImage(report, imageId);
        Reports.change(() -> report.removeKeyImage(imageId, clock.instant()));
        files.deleteAfterCommit(List.of(image.getObjectKey()));
    }
}
