package com.medimg.patient.application;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import com.medimg.patient.domain.Patient;
import com.medimg.patient.domain.Sample;
import com.medimg.patient.infrastructure.PatientRepository;
import com.medimg.shared.audit.Audited;
import com.medimg.shared.persistence.LikePatterns;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.web.ApiException;
import com.medimg.shared.web.PageResponse;

@Service
public class PatientService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final String CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public record CreatePatient(String code, Short birthYear, String sex, String note) {
    }

    public record UpdatePatient(Short birthYear, String sex, String note) {
    }

    public record MarkSample(String title, String description, String source) {
    }

    /** What other modules may show about a case: its pseudonymous code, birth year and sex. */
    public record CaseRef(UUID id, String code, Short birthYear, String sex) {
    }

    private final PatientRepository patients;
    private final StudyCountPort studyCounts;
    private final Clock clock;

    PatientService(PatientRepository patients, StudyCountPort studyCounts, Clock clock) {
        this.patients = patients;
        this.studyCounts = studyCounts;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public PageResponse<PatientDto> search(String q, Pageable pageable) {
        String pattern = LikePatterns.contains(q);
        Page<Patient> page = pattern == null ? patients.findLive(pageable) : patients.search(pattern, pageable);
        Map<UUID, Long> counts = studyCounts.countByPatient(page.map(Patient::getId).getContent());
        return PageResponse.of(page, p -> toDto(p, counts.getOrDefault(p.getId(), 0L)));
    }

    @Transactional(readOnly = true)
    @Audited(action = "PATIENT_VIEW", resource = "PATIENT")
    public PatientDto get(UUID id) {
        Patient p = require(id);
        return toDto(p, studyCounts.countByPatient(List.of(id)).getOrDefault(id, 0L));
    }

    @Transactional
    @Audited(action = "PATIENT_CREATE", resource = "PATIENT")
    public PatientDto create(CreatePatient cmd) {
        String code = StringUtils.hasText(cmd.code()) ? cmd.code().trim().toUpperCase() : generateCode();
        if (patients.existsByCode(code)) {
            throw duplicateCode(code);
        }
        Patient p = new Patient(code, cmd.birthYear(), cmd.sex(), cmd.note(), CurrentUser.id(), clock.instant());
        try {
            // flush now so that a concurrent insert of the same code fails here and not at commit
            return toDto(patients.saveAndFlush(p), 0);
        } catch (DataIntegrityViolationException e) {
            throw duplicateCode(code);
        }
    }

    @Transactional
    @Audited(action = "PATIENT_UPDATE", resource = "PATIENT")
    public PatientDto update(UUID id, UpdatePatient cmd) {
        Patient p = require(id);
        p.update(cmd.birthYear(), cmd.sex(), cmd.note(), clock.instant());
        return toDto(p, studyCounts.countByPatient(List.of(id)).getOrDefault(id, 0L));
    }

    @Transactional
    @Audited(action = "PATIENT_DELETE", resource = "PATIENT")
    public void delete(UUID id) {
        require(id).softDelete(clock.instant());
    }

    @Transactional
    @Audited(action = "SAMPLE_MARKED", resource = "PATIENT")
    public PatientDto markSample(UUID id, MarkSample cmd) {
        Patient p = require(id);
        p.markAsSample(new Sample(cmd.title().trim(), StringUtils.hasText(cmd.description()) ? cmd.description().trim() : null,
                cmd.source().trim()), clock.instant());
        return toDto(p, studyCounts.countByPatient(List.of(id)).getOrDefault(id, 0L));
    }

    @Transactional
    @Audited(action = "SAMPLE_UNMARKED", resource = "PATIENT")
    public void unmarkSample(UUID id) {
        require(id).unmarkAsSample(clock.instant());
    }

    /** The sample cases, by title. */
    @Transactional(readOnly = true)
    public List<PatientDto> listSamples() {
        List<Patient> samples = patients.findSamples();
        Map<UUID, Long> counts = studyCounts.countByPatient(samples.stream().map(Patient::getId).toList());
        return samples.stream().map(p -> toDto(p, counts.getOrDefault(p.getId(), 0L))).toList();
    }

    /** For other modules, e.g. the header of a report; not audited as a view of the case. */
    @Transactional(readOnly = true)
    public CaseRef describe(UUID id) {
        Patient p = require(id);
        return new CaseRef(p.getId(), p.getCode(), p.getBirthYear(), p.getSex());
    }

    /** Used by other modules (e.g. imaging) to validate a case reference. */
    @Transactional(readOnly = true)
    public void requireExists(UUID id) {
        require(id);
    }

    /** False for unknown and for deleted cases; other modules hide data that belongs to such cases. */
    @Transactional(readOnly = true)
    public boolean exists(UUID id) {
        return patients.findByIdAndDeletedAtIsNull(id).isPresent();
    }

    private Patient require(UUID id) {
        return patients.findByIdAndDeletedAtIsNull(id).orElseThrow(() -> ApiException.notFound("Case", id));
    }

    private String generateCode() {
        for (int i = 0; i < 5; i++) {
            StringBuilder sb = new StringBuilder("CASE-");
            for (int j = 0; j < 6; j++) {
                sb.append(CODE_ALPHABET.charAt(RANDOM.nextInt(CODE_ALPHABET.length())));
            }
            if (!patients.existsByCode(sb.toString())) {
                return sb.toString();
            }
        }
        throw new IllegalStateException("Could not generate a unique case code");
    }

    private static ApiException duplicateCode(String code) {
        return ApiException.conflict("Case code " + code + " already exists");
    }

    private static PatientDto toDto(Patient p, long studyCount) {
        Sample sample = p.getSample();
        return new PatientDto(p.getId(), p.getCode(), p.getBirthYear(), p.getSex(), p.getNote(), studyCount, p.getCreatedAt(),
                sample == null ? null : new PatientDto.Sample(sample.title(), sample.description(), sample.source()));
    }
}
