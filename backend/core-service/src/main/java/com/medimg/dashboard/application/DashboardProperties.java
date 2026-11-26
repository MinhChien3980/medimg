package com.medimg.dashboard.application;

import java.time.ZoneId;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** {@code zone}: where the days of the dashboard (and of date-only audit filters) begin and end. */
@ConfigurationProperties("app.dashboard")
public record DashboardProperties(@DefaultValue("Asia/Ho_Chi_Minh") ZoneId zone) {
}
