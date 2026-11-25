package com.medimg.architecture;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import java.util.List;

import com.medimg.shared.messaging.StreamPublisher;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.CompositeArchRule;

/**
 * Modular-monolith rules: modules use each other only through their application layer, the shared kernel depends
 * on no module, and module dependencies are free of cycles.
 */
@AnalyzeClasses(packages = "com.medimg", importOptions = ImportOption.DoNotIncludeTests.class)
class ModuleBoundariesTest {

    private static final List<String> MODULES = List.of("identity", "patient", "imaging", "prediction", "sample", "audit");

    /** Other modules may only use a module's {@code application} package (services, ports, DTOs). */
    @ArchTest
    static final ArchRule modulesOnlyTalkThroughApplicationLayer = CompositeArchRule.of(
            MODULES.stream().map(m -> noClasses()
                    .that().resideOutsideOfPackage("com.medimg." + m + "..")
                    .should().dependOnClassesThat().resideInAnyPackage(
                            "com.medimg." + m + ".api..",
                            "com.medimg." + m + ".domain..",
                            "com.medimg." + m + ".infrastructure..")
                    .as("only module '" + m + "' may use its api/domain/infrastructure"))
                    .map(ArchRule.class::cast).toList());

    @ArchTest
    static final ArchRule sharedKernelIsIndependent = noClasses()
            .that().resideInAPackage("com.medimg.shared..")
            .should().dependOnClassesThat().resideInAnyPackage(
                    MODULES.stream().map(m -> "com.medimg." + m + "..").toArray(String[]::new));

    @ArchTest
    static final ArchRule domainIsInnermost = noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAnyPackage("..api..", "..application..", "..infrastructure..");

    @ArchTest
    static final ArchRule applicationDoesNotDependOnWebLayer = noClasses()
            .that().resideInAPackage("..application..")
            .should().dependOnClassesThat().resideInAPackage("..api..");

    /** Streams are written only by the outbox relay, so every published message is backed by a committed outbox row. */
    @ArchTest
    static final ArchRule onlyTheOutboxRelayPublishesToStreams = noClasses()
            .that().resideOutsideOfPackages("com.medimg.shared.outbox..", "com.medimg.shared.messaging..")
            .should().dependOnClassesThat().areAssignableTo(StreamPublisher.class);

    @ArchTest
    static final ArchRule noCyclesBetweenModules = slices().matching("com.medimg.(*)..").should().beFreeOfCycles();
}
