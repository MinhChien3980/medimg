package com.medimg.audit.application;

import java.time.ZoneId;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** {@code zone}: the time zone of date-only bounds of an audit query ({@code from=2026-11-26}). */
@ConfigurationProperties("app.audit")
public record AuditProperties(@DefaultValue("Asia/Ho_Chi_Minh") ZoneId zone) {
}
