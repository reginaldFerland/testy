using System.Text.Json;
using System.Xml.Linq;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// SafeCustomEvaluation and the allowlist regexes decide whether a saved project graph
// may be reused. Anything not provably confined to bin/obj-independent evaluation must
// be rejected, so the cases below pair every accepted shape with its nearest rejection.
public class EvaluationInputsTests
{
    private static XDocument Project(string body, string sdk = "Microsoft.NET.Sdk") => XDocument.Parse($"<Project Sdk=\"{sdk}\">{body}</Project>");

    public static TheoryData<string, bool> Documents => new()
    {
        { "<PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup>", true },
        { "<ItemGroup><PackageReference Include=\"xunit\" Version=\"2.9.3\" /></ItemGroup>", true },
        { "<ItemGroup><Compile Include=\"src/**/*.cs\" /></ItemGroup>", true },
        { "<ItemGroup><ProjectReference Include=\"../Lib/Lib.csproj\" /></ItemGroup>", true },
        { "<PropertyGroup><Root>$([System.IO.Path]::Combine('$(MSBuildThisFileDirectory)', 'x'))</Root></PropertyGroup>", true },
        { "<PropertyGroup><V>$([MSBuild]::VersionGreaterThanOrEquals($(NETCoreSdkVersion), '10.0'))</V></PropertyGroup>", true },
        { "<PropertyGroup><Pattern>$([System.Text.RegularExpressions.Regex]::Replace('$(A)', 'a', 'b'))</Pattern></PropertyGroup>", true },
        // Property functions outside the allowlist can read arbitrary files or the environment.
        { "<PropertyGroup><X>$([System.IO.File]::ReadAllText('/etc/hosts'))</X></PropertyGroup>", false },
        { "<PropertyGroup><X>$([System.Environment]::GetEnvironmentVariable('HOME'))</X></PropertyGroup>", false },
        { "<PropertyGroup><X>$([MSBuild]::GetRegistryValue('a', 'b'))</X></PropertyGroup>", false },
        { "<PropertyGroup><X>$([System.IO.Path]::Combine('a', 'b')) $([System.IO.Directory]::GetFiles('.'))</X></PropertyGroup>", false },
        { "<ItemGroup><Compile Include=\"$([System.IO.Directory]::GetFiles('.'))\" /></ItemGroup>", false },
        // Settings that move or widen the default globs and the output directories.
        { "<PropertyGroup><EnableDefaultItems>false</EnableDefaultItems></PropertyGroup>", false },
        { "<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>", false },
        { "<PropertyGroup><DefaultItemExcludes>$(DefaultItemExcludes);x/**</DefaultItemExcludes></PropertyGroup>", false },
        { "<PropertyGroup><BaseOutputPath>out/</BaseOutputPath></PropertyGroup>", false },
        { "<PropertyGroup><OutputPath>out/</OutputPath></PropertyGroup>", false },
        { "<PropertyGroup><IntermediateOutputPath>out/</IntermediateOutputPath></PropertyGroup>", false },
        { "<PropertyGroup><MSBuildProjectExtensionsPath>out/</MSBuildProjectExtensionsPath></PropertyGroup>", false },
        { "<PropertyGroup><ArtifactsPath>$(MSBuildThisFileDirectory)artifacts</ArtifactsPath></PropertyGroup>", false },
        { "<PropertyGroup><UseArtifactsOutput>true</UseArtifactsOutput></PropertyGroup>", false },
        { "<PropertyGroup><PublishDir>pub/</PublishDir></PropertyGroup>", false },
        { "<ItemGroup><Compile Remove=\"bin/**\" /></ItemGroup>", false },
        { "<ItemGroup><None Include=\"obj\\foo.txt\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"$(OutputPath)gen.cs\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"$(IntermediateOutputPath)gen.cs\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"$(TargetDir)gen.cs\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"$(Gen)/*.cs\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"$(Gen)/?.cs\" /></ItemGroup>", false },
        { "<ItemGroup><Compile Include=\"/work/out/gen.cs\" /></ItemGroup>", false },
        // Targets and tasks run at build time, not during evaluation.
        { "<Target Name=\"T\"><PropertyGroup><OutputPath>x</OutputPath></PropertyGroup></Target>", true },
        { "<UsingTask TaskName=\"T\" AssemblyFile=\"$(OutputPath)t.dll\" />", true },
    };

    [Theory]
    [MemberData(nameof(Documents))]
    public void ClassifiesCustomEvaluation(string body, bool safe)
    {
        Assert.Equal(safe, EvaluationInputs.SafeCustomEvaluation(Project(body), ["/work/out"]));
    }

    [Theory]
    [InlineData("Microsoft.NET.Sdk", true)]
    [InlineData("Microsoft.NET.Sdk.Web", true)]
    [InlineData("Microsoft.NET.Sdk.Razor", true)]
    [InlineData("Microsoft.NET.Sdk.Worker", true)]
    [InlineData("Microsoft.NET.Sdk.WindowsDesktop", true)]
    [InlineData("MSTest.Sdk", true)]
    [InlineData("MSTest.Sdk/3.6.0", true)]
    [InlineData("MSTest.Sdk/4.0.0-preview.25372.6", true)]
    [InlineData("Microsoft.NET.Sdk;MSTest.Sdk/3.6.0", true)]
    [InlineData("MSTest.Sdk/3.6", false)]
    [InlineData("MSTest.Sdk/latest", false)]
    [InlineData("Aspire.AppHost.Sdk/9.0.0", false)]
    [InlineData("Microsoft.NET.Sdk;Evil.Sdk", false)]
    [InlineData("Microsoft.NET.Sdk.Unknown", false)]
    [InlineData("microsoft.net.sdk", false)]
    public void OnlyKnownSdksAreSafe(string sdk, bool safe)
    {
        Assert.Equal(safe, EvaluationInputs.SafeCustomEvaluation(Project("", sdk), []));
    }

    [Fact]
    public void ChecksSdkImportsAndSdkElements()
    {
        Assert.True(EvaluationInputs.SafeCustomEvaluation(XDocument.Parse("<Project><Sdk Name=\"Microsoft.NET.Sdk\" /></Project>"), []));
        Assert.False(EvaluationInputs.SafeCustomEvaluation(XDocument.Parse("<Project><Sdk Name=\"Evil.Sdk\" /></Project>"), []));
        Assert.False(EvaluationInputs.SafeCustomEvaluation(XDocument.Parse("<Project><Import Project=\"Sdk.props\" Sdk=\"Evil.Sdk\" /></Project>"), []));
        Assert.True(EvaluationInputs.SafeCustomEvaluation(XDocument.Parse("<Project><Import Project=\"Sdk.props\" Sdk=\"Microsoft.NET.Sdk\" /></Project>"), []));
    }

    [Fact]
    public void RejectsValuesNamingARecordedOutputDirectory()
    {
        var item = Project("<ItemGroup><Compile Include=\"/work/Out/gen/a.cs\" /></ItemGroup>");
        Assert.False(EvaluationInputs.SafeCustomEvaluation(item, ["/work/out"]));
        Assert.True(EvaluationInputs.SafeCustomEvaluation(item, ["/elsewhere/out"]));
    }

    [Theory]
    [InlineData("*.cs", true)]
    [InlineData("*.json", true)]
    [InlineData("*.C0", true)]
    [InlineData("*", false)]
    [InlineData("*.", false)]
    [InlineData("*.c*", false)]
    [InlineData("a*.cs", false)]
    [InlineData("*.cs;*.vb", false)]
    [InlineData("*.c s", false)]
    [InlineData("**/*.cs", false)]
    public void ExtensionPatternAcceptsOnlyAWildcardAndAnExtension(string pattern, bool expected)
    {
        Assert.Equal(expected, EvaluationInputs.ExtensionPattern().IsMatch(pattern));
    }

    [Theory]
    [InlineData("MSTest.Sdk/3.6.0", true)]
    [InlineData("MSTest.Sdk/10.20.30", true)]
    [InlineData("MSTest.Sdk/3.6.0-preview.1", true)]
    [InlineData("MSTest.Sdk/3.6.0+build.5", true)]
    [InlineData("MSTest.Sdk", false)]
    [InlineData("MSTest.Sdk/", false)]
    [InlineData("MSTest.Sdk/3.6", false)]
    [InlineData("MSTest.Sdk/3.6.0.1", false)]
    [InlineData("MSTest.Sdk/3.6.0-", false)]
    [InlineData("MSTest.Sdk/3.6.0-a b", false)]
    [InlineData("xMSTest.Sdk/3.6.0", false)]
    [InlineData("Evil.Sdk/3.6.0", false)]
    public void MSTestSdkNameNeedsAFullVersion(string name, bool expected)
    {
        Assert.Equal(expected, EvaluationInputs.MSTestSdkName().IsMatch(name));
    }

    [Theory]
    [InlineData("$([System.IO.Path]::Combine(", true)]
    [InlineData("$([System.IO.Path]::GetFullPath(", true)]
    [InlineData("$([System.IO.Path]::IsPathRooted (", true)]
    [InlineData("$([MSBuild]::NormalizePath(", true)]
    [InlineData("$([MSBuild]::EnsureTrailingSlash(", true)]
    [InlineData("$([MSBuild]::VersionLessThan(", true)]
    [InlineData("$([System.Version]::Parse(", true)]
    [InlineData("$([System.Text.RegularExpressions.Regex]::IsMatch(", true)]
    [InlineData("$([System.IO.Path]::GetTempPath(", false)]
    [InlineData("$([System.IO.File]::ReadAllText(", false)]
    [InlineData("$([System.IO.Directory]::GetFiles(", false)]
    [InlineData("$([System.Environment]::GetEnvironmentVariable(", false)]
    [InlineData("$([MSBuild]::GetRegistryValue(", false)]
    [InlineData("$([MSBuild]::NormalizePathX(", false)]
    [InlineData("$([System.IO.Path]::Combine", false)]
    [InlineData("$(System.IO.Path]::Combine(", false)]
    public void SafePropertyFunctionIsAnAllowlist(string text, bool expected)
    {
        Assert.Equal(expected, EvaluationInputs.SafePropertyFunction().IsMatch(text));
    }

    [Theory]
    [InlineData("$(OutputPath)", true)]
    [InlineData("$(outputpath)", true)]
    [InlineData("$(BaseOutputPath)", true)]
    [InlineData("$(IntermediateOutputPath)", true)]
    [InlineData("$(BaseIntermediateOutputPath)", true)]
    [InlineData("$(TargetDir)x/y.cs", true)]
    [InlineData("a/$(OutDir)", false)]
    [InlineData("$(TargetDirX)", false)]
    [InlineData("$(MyOutputPath)", false)]
    [InlineData("OutputPath", false)]
    public void OutputPropertyNamesTheOutputProperties(string text, bool expected)
    {
        Assert.Equal(expected, EvaluationInputs.OutputProperty().IsMatch(text));
    }

    [Theory]
    [InlineData("bin", true)]
    [InlineData("obj", true)]
    [InlineData("BIN/Debug", true)]
    [InlineData("src/obj/x.cs", true)]
    [InlineData("src\\bin\\x.cs", true)]
    [InlineData("$(X)/obj", true)]
    [InlineData("binary", false)]
    [InlineData("cabin/x", false)]
    [InlineData("objects/x", false)]
    [InlineData("src/robin", false)]
    public void OutputNameMatchesWholeBinAndObjSegments(string text, bool expected)
    {
        Assert.Equal(expected, EvaluationInputs.OutputName().IsMatch(text));
    }

    [Fact]
    public void AListingDigestIgnoresOrderAndNamesTheCount()
    {
        // The TypeScript side computes the same string (listingDigest in projectEvaluationCache.ts).
        Assert.Equal("0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", EvaluationInputs.Listing([]));
        var names = new[] { "/p/b.cs", "/p/a.cs", "/p/c.cs" };
        Assert.Equal(EvaluationInputs.Listing(names), EvaluationInputs.Listing(names.Reverse()));
        Assert.Equal("3:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData("/p/a.cs\n/p/b.cs\n/p/c.cs"u8)).ToLowerInvariant(), EvaluationInputs.Listing(names));
        Assert.NotEqual(EvaluationInputs.Listing(names), EvaluationInputs.Listing(["/p/a.cs", "/p/b.cs"]));
        Assert.NotEqual(EvaluationInputs.Listing(["/p/a.cs\n/p/b.cs"]), EvaluationInputs.Listing(["/p/a.cs", "/p/b.cs"]));
    }

    [Fact]
    public void ReportsEvaluationInputsWithLowerCaseFields()
    {
        var snapshot = new EvaluationInputs.Snapshot(true, ["a"], new Dictionary<string, string> { ["a"] = "h" },
            [new EvaluationInputs.Query("files", "/p", "*", true, ["x"])], ["/o"], "/sdk", null);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(snapshot, GraphJson.Default.Snapshot));
        Assert.Equal(["reusable", "files", "hashes", "queries", "excludedDirectories", "sdkDirectory", "reason"], json.RootElement.EnumerateObject().Select(property => property.Name));
        Assert.Equal(["kind", "path", "pattern", "recursive", "values"], json.RootElement.GetProperty("queries")[0].EnumerateObject().Select(property => property.Name));
    }
}

// MSBuildThisFile* belongs to the file containing the expression (an imported props
// file), not to the project being evaluated.
public class ImportExpansionTests
{
    private static readonly string Separator = Path.DirectorySeparatorChar.ToString();
    private static readonly string Root = OperatingSystem.IsWindows() ? "C:\\" : "/";
    private static readonly string Imported = Path.Combine(Root, "repo", "build", "Common.props");
    private static readonly string ImportedDirectory = Path.Combine(Root, "repo", "build") + Separator;
    private static readonly string DirectoryNoRoot = Path.Combine("repo", "build") + Separator;

    public static TheoryData<string, string> Expansions => new()
    {
        { "$(MSBuildThisFile)", "Common.props" },
        { "$(MSBuildThisFileName)", "Common" },
        { "$(MSBuildThisFileExtension)", ".props" },
        { "$(MSBuildThisFileFullPath)", Imported },
        { "$(MSBuildThisFileDirectory)", ImportedDirectory },
        { "$(MSBuildThisFileDirectoryNoRoot)", DirectoryNoRoot },
        { "$(MSBuildThisFileDirectory)gen/*.props", ImportedDirectory + "gen/*.props" },
        { "$(msbuildthisfiledirectory)*.targets", ImportedDirectory + "*.targets" },
        { "$(MSBUILDTHISFILENAME).$(MSBuildThisFileExtension)", "Common..props" },
        { "$(MSBuildThisFileDirectory)../$(MSBuildThisFileName)/*.props", ImportedDirectory + "../Common/*.props" },
        // Other properties, including near misses, are left for MSBuild to expand against the root project.
        { "$(MSBuildProjectDirectory)/*.props", "$(MSBuildProjectDirectory)/*.props" },
        { "$(MSBuildThisFileDirectoryX)", "$(MSBuildThisFileDirectoryX)" },
        { "$(MSBuildThisFileOther)", "$(MSBuildThisFileOther)" },
        { "$(MSBuildThisFile", "$(MSBuildThisFile" },
        { "MSBuildThisFileDirectory", "MSBuildThisFileDirectory" },
        { "src/*.props", "src/*.props" },
        { "", "" },
    };

    [Theory]
    [MemberData(nameof(Expansions))]
    public void ExpandsAgainstTheImportedFile(string expression, string expected)
    {
        Assert.Equal(expected, EvaluationInputs.ExpandThisFile(expression, Imported));
    }

    [Fact]
    public void DifferentImportsExpandDifferently()
    {
        var other = Path.Combine(Root, "other", "Extra.targets");
        Assert.Equal(Path.Combine(Root, "other") + Separator + "*.props", EvaluationInputs.ExpandThisFile("$(MSBuildThisFileDirectory)*.props", other));
        Assert.Equal("Extra", EvaluationInputs.ExpandThisFile("$(MSBuildThisFileName)", other));
        Assert.Equal(".targets", EvaluationInputs.ExpandThisFile("$(MSBuildThisFileExtension)", other));
    }

    [Fact]
    public void ADirectoryAtTheRootHasNoRootRemainder()
    {
        Assert.Equal(Separator, EvaluationInputs.ExpandThisFile("$(MSBuildThisFileDirectoryNoRoot)", Path.Combine(Root, "Top.props")));
    }
}
