package com.medimg.identity.api;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.medimg.identity.application.AuthService;
import com.medimg.identity.application.TokenResponse;
import com.medimg.identity.application.UserDto;
import com.medimg.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/v1")
@Tag(name = "Identity")
class AuthController {

    record LoginRequest(@NotBlank @Size(max = 100) String username, @NotBlank @Size(max = 200) String password) {
    }

    record RefreshRequest(@NotBlank @Size(max = 200) String refreshToken) {
    }

    private final AuthService auth;

    AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/auth/login")
    TokenResponse login(@Valid @RequestBody LoginRequest req) {
        return auth.login(req.username(), req.password());
    }

    @PostMapping("/auth/refresh")
    TokenResponse refresh(@Valid @RequestBody RefreshRequest req) {
        return auth.refresh(req.refreshToken());
    }

    @PostMapping("/auth/logout")
    ResponseEntity<Void> logout(@Valid @RequestBody RefreshRequest req) {
        auth.logout(req.refreshToken());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me")
    UserDto me() {
        return auth.me(CurrentUser.id());
    }
}
