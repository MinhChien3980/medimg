package com.medimg.shared.security;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("app.security.cors")
public record CorsProperties(List<String> allowedOrigins) {
}
