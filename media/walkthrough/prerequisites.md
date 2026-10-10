# Prerequisites

- **.NET 10 SDK or later.** Run `dotnet --info` in a terminal to check. A `global.json` that pins an older SDK stops Testy for that folder.
- **Microsoft.Testing.Platform (MTP) test projects** targeting `net10.0` or later. MSTest, NUnit, xUnit v3 and TUnit all support MTP. VSTest-only projects and older target frameworks are skipped and listed in **Testy: Show Output**.
- **Optional:** the C# extension (`ms-dotnettools.csharp`) for the **Debug** test profile. C# Dev Kit is not required.

To limit Testy to part of a large repository, set `testy.solution` to a `.sln`, `.slnx` or `.slnf` file, or use `testy.projects.include` and `testy.projects.exclude`.
