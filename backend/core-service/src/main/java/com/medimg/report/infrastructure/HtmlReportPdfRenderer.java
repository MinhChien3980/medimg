package com.medimg.report.infrastructure;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.UncheckedIOException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.MissingResourceException;
import java.util.Objects;

import org.springframework.stereotype.Component;
import org.thymeleaf.TemplateEngine;
import org.thymeleaf.context.Context;
import org.thymeleaf.context.ITemplateContext;
import org.thymeleaf.messageresolver.AbstractMessageResolver;
import org.thymeleaf.templatemode.TemplateMode;
import org.thymeleaf.templateresolver.ClassLoaderTemplateResolver;

import com.medimg.report.application.ReportDocument;
import com.medimg.report.application.ReportDocument.Figure;
import com.medimg.report.application.ReportMessages;
import com.medimg.report.application.ReportPdfRenderer;
import com.openhtmltopdf.extend.FSStream;
import com.openhtmltopdf.extend.FSStreamFactory;
import com.openhtmltopdf.outputdevice.helper.BaseRendererBuilder.FontStyle;
import com.openhtmltopdf.pdfboxout.PdfRendererBuilder;

/**
 * Renders a report with the Thymeleaf template {@code report/report.html} (and its stylesheet {@code report.css}) to
 * XHTML, which openhtmltopdf lays out as a PDF with Noto Sans embedded (subset), so that Vietnamese text renders in any
 * viewer. Values are inserted by the template engine, HTML-escaped; key images are served to the renderer from memory
 * under {@code figure:<index>} URLs.
 */
@Component
class HtmlReportPdfRenderer implements ReportPdfRenderer {

    private static final String TEMPLATE = "report/report";
    private static final String FONT_FAMILY = "Noto Sans";
    private static final String FIGURE_SCHEME = "figure";

    private final TemplateEngine templates;
    private final String baseUri;

    HtmlReportPdfRenderer(ReportMessages messages) {
        ClassLoaderTemplateResolver resolver = new ClassLoaderTemplateResolver();
        resolver.setTemplateMode(TemplateMode.HTML);
        resolver.setSuffix(".html");
        resolver.setCharacterEncoding(StandardCharsets.UTF_8.name());
        templates = new TemplateEngine();
        templates.setTemplateResolver(resolver);
        templates.setMessageResolver(new BundleMessageResolver(messages));
        URL template = Objects.requireNonNull(getClass().getResource("/" + TEMPLATE + ".html"), "report template");
        baseUri = template.toExternalForm();
    }

    @Override
    public byte[] render(ReportDocument document) {
        String html = templates.process(TEMPLATE, new Context(document.locale(), Map.of("doc", document)));
        ByteArrayOutputStream pdf = new ByteArrayOutputStream();
        PdfRendererBuilder builder = new PdfRendererBuilder();
        builder.withHtmlContent(html, baseUri);
        builder.useFont(() -> font("NotoSans-Regular.ttf"), FONT_FAMILY, 400, FontStyle.NORMAL, true);
        builder.useFont(() -> font("NotoSans-Bold.ttf"), FONT_FAMILY, 700, FontStyle.NORMAL, true);
        builder.useProtocolsStreamImplementation(new FigureStreams(document.figures()), FIGURE_SCHEME);
        builder.toStream(pdf);
        try {
            builder.run();
        } catch (IOException e) {
            throw new UncheckedIOException("Could not render the report PDF", e);
        }
        return pdf.toByteArray();
    }

    private static InputStream font(String file) {
        return HtmlReportPdfRenderer.class.getResourceAsStream("/report/fonts/" + file);
    }

    /** {@code figure:<index>} is the PNG of the key image at that index of the document. */
    private record FigureStreams(List<Figure> figures) implements FSStreamFactory {

        @Override
        public FSStream getUrl(String url) {
            byte[] png = figures.get(Integer.parseInt(url.substring(FIGURE_SCHEME.length() + 1))).png();
            return new FSStream() {
                @Override
                public InputStream getStream() {
                    return new ByteArrayInputStream(png);
                }

                @Override
                public Reader getReader() {
                    return new InputStreamReader(getStream(), StandardCharsets.UTF_8);
                }
            };
        }
    }

    /** {@code #{key(args)}} in the template reads the report wording; an unknown key shows as {@code ??key_locale??}. */
    private static final class BundleMessageResolver extends AbstractMessageResolver {

        private final ReportMessages messages;

        BundleMessageResolver(ReportMessages messages) {
            this.messages = messages;
        }

        @Override
        public String resolveMessage(ITemplateContext context, Class<?> origin, String key, Object[] parameters) {
            try {
                return messages.get(context.getLocale(), key, parameters == null ? new Object[0] : parameters);
            } catch (MissingResourceException e) {
                return null;
            }
        }

        @Override
        public String createAbsentMessageRepresentation(ITemplateContext context, Class<?> origin, String key,
                                                        Object[] parameters) {
            Locale locale = context.getLocale();
            return "??" + key + "_" + locale + "??";
        }
    }
}
