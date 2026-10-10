# Coverage

Coverage collection is on by default. On first use, Testy installs a pinned version of Microsoft's `dotnet-coverage` tool from NuGet into its own storage; it never adds packages to your projects. Point `testy.coverageToolPath` at an existing collector for offline machines.

Coverage appears in Test Explorer's coverage view and editor overlays. Enable `testy.showCoverage` to also show gutter markers, including **stale** markers while the affected tests rerun. Use **Testy: Clear Coverage** to hide coverage until the next run. Use **Testy: Export Coverage…** to write the current coverage as LCOV or Cobertura XML for other tools.
