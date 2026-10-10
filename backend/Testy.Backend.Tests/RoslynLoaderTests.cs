using System.Reflection;
using System.Runtime.Loader;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// Roslyn is loaded from an installed SDK. Among several SDKs, the analyzer prefers the line
// it was built against, then stable SDKs, then the newest Roslyn, then the newest SDK.
[Collection(ProcessState.Name)]
public sealed class RoslynLoaderTests : IDisposable
{
    private static readonly Version Minimum = new(5, 0, 0, 0);
    private readonly string directory = Directory.CreateTempSubdirectory("testy-roslyn-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private static RoslynLoader.Candidate Candidate(string sdk, string roslyn) => new($"/sdk/{sdk}", Version.Parse(roslyn), sdk);

    public static TheoryData<string[], string> Choices => new()
    {
        // Same major first, even when another major is newer.
        { ["10.0.100=5.0.0.0", "11.0.100=6.0.0.0"], "10.0.100" },
        // Stable before preview, even when the preview has a newer Roslyn.
        { ["10.0.100=5.0.0.0", "10.0.200-preview.1=5.3.0.0"], "10.0.100" },
        // Newest Roslyn before newest SDK.
        { ["10.0.300=5.0.0.0", "10.0.200=5.3.0.0"], "10.0.200" },
        // Newest SDK by version, not by text.
        { ["10.0.99=5.0.0.0", "10.0.100=5.0.0.0"], "10.0.100" },
        // Only another major is still a choice.
        { ["11.0.100=6.0.0.0"], "11.0.100" },
        // Previews alone: the newest Roslyn.
        { ["10.0.200-preview.1=5.1.0.0", "10.0.200-preview.2=5.2.0.0"], "10.0.200-preview.2" },
    };

    [Theory]
    [MemberData(nameof(Choices))]
    public void SelectionOrder(string[] installed, string expected)
    {
        var candidates = installed.Select(entry => entry.Split('=')).Select(parts => Candidate(parts[0], parts[1]));
        Assert.Equal(expected, RoslynLoader.Best(candidates, Minimum)?.Sdk);
        Assert.Equal(expected, RoslynLoader.Best(candidates.Reverse(), Minimum)?.Sdk);
    }

    [Fact]
    public void NoCandidateNoChoice()
    {
        Assert.Null(RoslynLoader.Best([], Minimum));
    }

    // The tests carry a real, Microsoft-signed Roslyn beside them.
    [Fact]
    public void InspectAcceptsASignedRoslynThatIsNewEnough()
    {
        var problems = new List<string>();
        var candidate = RoslynLoader.Inspect(AppContext.BaseDirectory, Minimum, problems);
        Assert.NotNull(candidate);
        Assert.True(candidate.Roslyn >= Minimum);
        Assert.Empty(problems);
    }

    [Fact]
    public void InspectRejectsAnOlderRoslyn()
    {
        var problems = new List<string>();
        Assert.Null(RoslynLoader.Inspect(AppContext.BaseDirectory, new Version(999, 0), problems));
        Assert.Contains("is older than 999.0", Assert.Single(problems), StringComparison.Ordinal);
    }

    [Fact]
    public void InspectRejectsMissingOrMismatchedAssemblies()
    {
        var problems = new List<string>();
        Assert.Null(RoslynLoader.Inspect(directory, Minimum, problems));
        // An assembly that is not Roslyn stands in for a mismatched Microsoft.CodeAnalysis.CSharp.
        File.Copy(Path.Combine(AppContext.BaseDirectory, "Microsoft.CodeAnalysis.dll"), Path.Combine(directory, "Microsoft.CodeAnalysis.dll"));
        File.Copy(typeof(RoslynLoaderTests).Assembly.Location, Path.Combine(directory, "Microsoft.CodeAnalysis.CSharp.dll"));
        Assert.Null(RoslynLoader.Inspect(directory, Minimum, problems));
        Assert.Equal(2, problems.Count);
        Assert.Contains("mismatched Roslyn assemblies", problems[1], StringComparison.Ordinal);
    }

    // The resolver reports a failure through RoslynLoader.Failure and returns null instead of throwing,
    // so the runtime's own load error can be printed beside the reasons. (FileLoadException and
    // BadImageFormatException take the same path; a load failure after inspection cannot be forced.)
    [Fact]
    public void AMissingRoslynIsRecordedAsTheFailure()
    {
        var configured = Environment.GetEnvironmentVariable("TESTY_ROSLYN_DIR");
        Environment.SetEnvironmentVariable("TESTY_ROSLYN_DIR", directory);
        try
        {
            Assert.Null(RoslynLoader.Resolve(AssemblyLoadContext.Default, new AssemblyName("Microsoft.CodeAnalysis") { Version = Minimum }));
            Assert.Contains(directory, RoslynLoader.Failure, StringComparison.Ordinal);
            // Other assemblies are none of its business.
            Assert.Null(RoslynLoader.Resolve(AssemblyLoadContext.Default, new AssemblyName("Unrelated")));
        }
        finally { Environment.SetEnvironmentVariable("TESTY_ROSLYN_DIR", configured); }
    }
}
