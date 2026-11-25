package com.medimg.report.application;

import java.text.MessageFormat;
import java.util.Locale;
import java.util.Optional;
import java.util.ResourceBundle;

import org.springframework.stereotype.Component;

/**
 * The wording of reports in Vietnamese and English ({@code report/messages_*.properties}), shared by the pre-filled
 * sections and the PDF template. There is no fallback to another language: a missing key is an error.
 */
@Component
public class ReportMessages {

    private static final String BUNDLE = "report.messages";
    private static final ResourceBundle.Control NO_FALLBACK =
            ResourceBundle.Control.getNoFallbackControl(ResourceBundle.Control.FORMAT_PROPERTIES);

    /** @throws java.util.MissingResourceException for an unknown key */
    public String get(Locale locale, String key, Object... args) {
        String pattern = bundle(locale).getString(key);
        return new MessageFormat(pattern, locale).format(args);
    }

    /** The wording of an optional key (e.g. the name of a label), empty when the language has none. */
    public Optional<String> find(Locale locale, String key, Object... args) {
        return bundle(locale).containsKey(key) ? Optional.of(get(locale, key, args)) : Optional.empty();
    }

    private static ResourceBundle bundle(Locale locale) {
        return ResourceBundle.getBundle(BUNDLE, locale, NO_FALLBACK);
    }
}
