package com.medimg.identity.api;

import java.util.Set;
import java.util.UUID;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import com.medimg.identity.application.AccountAccess;
import com.medimg.identity.application.AuthService;
import com.medimg.shared.security.CurrentUser;
import com.medimg.shared.web.ApiException;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Checks the account behind an access token on every API request (one primary-key lookup), so that a lock or a
 * password reset applies at once instead of when the token expires:
 * <ul>
 * <li>locked account: 401 {@code /problems/session-revoked}; the client's refresh then fails as well;</li>
 * <li>password change required: 403 {@code /problems/password-change-required}, except for {@code /me} and
 * {@code /me/password}.</li>
 * </ul>
 * {@code /auth/*} is not checked: it is not called with an access token. Roles are still those of the token, so a
 * role change applies at the next refresh (at most the access token lifetime).
 */
@Configuration(proxyBeanMethods = false)
class AccountAccessInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    private static final Set<String> ALLOWED_DURING_PASSWORD_CHANGE = Set.of("/api/v1/me", "/api/v1/me/password");

    private final AuthService auth;

    AccountAccessInterceptor(AuthService auth) {
        this.auth = auth;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/**").excludePathPatterns("/api/v1/auth/**");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        UUID userId = CurrentUser.idIfPresent().orElse(null);
        if (userId == null) {
            return true; // not authenticated: the security filter chain already decided
        }
        AccountAccess access = auth.access(userId);
        if (access == AccountAccess.NONE) {
            throw ApiException.unauthorized("The session is no longer valid, please log in again").type("session-revoked");
        }
        if (access == AccountAccess.PASSWORD_CHANGE_ONLY
                && !ALLOWED_DURING_PASSWORD_CHANGE.contains(request.getRequestURI().substring(request.getContextPath().length()))) {
            throw ApiException.forbidden("You must change your password before using the application")
                    .type("password-change-required");
        }
        return true;
    }
}
