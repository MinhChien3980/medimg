package com.medimg.identity.api;

import java.util.Set;
import java.util.UUID;

import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.identity.application.AdminUserDtos.AdminUserDto;
import com.medimg.identity.application.AdminUserDtos.CreateUser;
import com.medimg.identity.application.AdminUserDtos.CreatedUser;
import com.medimg.identity.application.AdminUserDtos.TemporaryPassword;
import com.medimg.identity.application.AdminUserDtos.UpdateUser;
import com.medimg.identity.application.AdminUserDtos.UserFilter;
import com.medimg.identity.application.UserAdminService;
import com.medimg.identity.domain.Role;
import com.medimg.identity.domain.UserStatus;
import com.medimg.shared.security.AccessPolicy;
import com.medimg.shared.web.PageResponse;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** User administration (ADMIN only). Accounts are locked, never deleted. */
@RestController
@RequestMapping("/api/v1/admin/users")
@Tag(name = "Administration – users")
@PreAuthorize(AccessPolicy.ADMIN)
class AdminUserController {

    /** The username is stored in lower case: {@code Doctor} and {@code doctor} are the same name. */
    record CreateRequest(
            @NotBlank @Size(min = 3, max = 50)
            @Pattern(regexp = "^[A-Za-z0-9._-]*$", message = "letters, digits, '.', '_' and '-' only") String username,
            @NotBlank @Size(max = 100) String fullName,
            @Email @Size(max = 200) String email,
            @NotEmpty Set<@NotNull Role> roles) {
    }

    record UpdateRequest(
            @NotBlank @Size(max = 100) String fullName,
            @Email @Size(max = 200) String email,
            @NotEmpty Set<@NotNull Role> roles,
            @NotNull Long version) {
    }

    private final UserAdminService service;

    AdminUserController(UserAdminService service) {
        this.service = service;
    }

    @GetMapping
    PageResponse<AdminUserDto> search(@RequestParam(required = false) @Size(max = 100) String q,
                                      @RequestParam(required = false) Role role,
                                      @RequestParam(required = false) UserStatus status,
                                      @RequestParam(defaultValue = "0") @Min(0) int page,
                                      @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return service.search(new UserFilter(q, role, status), PageRequest.of(page, size));
    }

    @GetMapping("/{id}")
    AdminUserDto get(@PathVariable UUID id) {
        return service.get(id);
    }

    /** 201 with the temporary password, shown this once; 409 {@code /problems/username-taken}. */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    CreatedUser create(@Valid @RequestBody CreateRequest req) {
        return service.create(new CreateUser(req.username(), req.fullName(), req.email(), req.roles()));
    }

    /** 409 on a stale version or for the last active admin; 422 {@code /problems/self-demote}. */
    @PutMapping("/{id}")
    AdminUserDto update(@PathVariable UUID id, @Valid @RequestBody UpdateRequest req) {
        return service.update(id, new UpdateUser(req.fullName(), req.email(), req.roles(), req.version()));
    }

    /** 422 {@code /problems/self-lock}; 409 {@code /problems/last-admin}. */
    @PostMapping("/{id}/lock")
    AdminUserDto lock(@PathVariable UUID id) {
        return service.lock(id);
    }

    @PostMapping("/{id}/unlock")
    AdminUserDto unlock(@PathVariable UUID id) {
        return service.unlock(id);
    }

    /** The new temporary password, shown this once; 422 {@code /problems/self-reset}. */
    @PostMapping("/{id}/reset-password")
    TemporaryPassword resetPassword(@PathVariable UUID id) {
        return service.resetPassword(id);
    }
}
