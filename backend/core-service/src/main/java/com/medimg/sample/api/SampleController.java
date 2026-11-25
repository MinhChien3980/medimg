package com.medimg.sample.api;

import java.util.List;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.sample.application.SampleService;
import com.medimg.sample.application.SampleService.SampleCase;
import com.medimg.shared.security.AccessPolicy;

import io.swagger.v3.oas.annotations.tags.Tag;

@RestController
@RequestMapping("/api/v1/samples")
@Tag(name = "Sample cases")
@PreAuthorize(AccessPolicy.READ)
class SampleController {

    private final SampleService samples;

    SampleController(SampleService samples) {
        this.samples = samples;
    }

    @GetMapping
    List<SampleCase> list() {
        return samples.list();
    }
}
