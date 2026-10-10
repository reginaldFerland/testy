using Xunit;

namespace Testy.Backend.Tests;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessState
{
    public const string Name = "Process-wide state (PATH, current directory)";
}

// A bare command name is looked up on PATH alone: never in the current directory (the
// workspace), never through a relative PATH entry. Explicit paths are used as given.
[Collection(ProcessState.Name)]
public sealed class ApplicationResolutionTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("testy-path-").FullName;
    private readonly string? path = Environment.GetEnvironmentVariable("PATH");
    private readonly string directory = Directory.GetCurrentDirectory();

    public void Dispose()
    {
        Directory.SetCurrentDirectory(directory);
        Environment.SetEnvironmentVariable("PATH", path);
        Directory.Delete(root, recursive: true);
    }

    private string Tool(string folder, string name)
    {
        var parent = Path.Combine(root, folder);
        Directory.CreateDirectory(parent);
        var file = Path.Combine(parent, name);
        File.WriteAllText(file, "");
        return file;
    }

    private static void SetPath(params string[] directories) => Environment.SetEnvironmentVariable("PATH", string.Join(';', directories));

    [Fact]
    public void FindsABareNameWithAnExecutableExtension()
    {
        var tool = Tool("bin", "tool.exe");
        SetPath(Path.GetDirectoryName(tool)!);
        Assert.Equal(tool, ProcessOwner.ResolveApplication("tool"));
    }

    [Fact]
    public void PrefersComOverExeInTheSameDirectory()
    {
        Tool("bin", "tool.exe");
        var com = Tool("bin", "tool.com");
        SetPath(Path.Combine(root, "bin"));
        Assert.Equal(com, ProcessOwner.ResolveApplication("tool"));
    }

    [Fact]
    public void TakesTheFirstPathEntryThatHasTheFile()
    {
        var first = Tool("first", "tool.exe");
        Tool("second", "tool.exe");
        Directory.CreateDirectory(Path.Combine(root, "empty"));
        SetPath(Path.Combine(root, "missing"), Path.Combine(root, "empty"), Path.GetDirectoryName(first)!, Path.Combine(root, "second"));
        Assert.Equal(first, ProcessOwner.ResolveApplication("tool"));
    }

    [Fact]
    public void IgnoresEmptyPathSegments()
    {
        var tool = Tool("bin", "tool.exe");
        Environment.SetEnvironmentVariable("PATH", ";;" + Path.GetDirectoryName(tool) + ";");
        Assert.Equal(tool, ProcessOwner.ResolveApplication("tool"));
    }

    [Fact]
    public void ADottedNameIsOnlyLookedUpAsGiven()
    {
        var script = Tool("bin", "tool.cmd");
        Tool("bin", "tool.cmd.exe");
        SetPath(Path.Combine(root, "bin"));
        Assert.Equal(script, ProcessOwner.ResolveApplication("tool.cmd"));
        Assert.Throws<FileNotFoundException>(() => ProcessOwner.ResolveApplication("tool"));
    }

    [Fact]
    public void ReportsABareNameThatIsNotOnPath()
    {
        Tool("bin", "other.exe");
        SetPath(Path.Combine(root, "bin"));
        var error = Assert.Throws<FileNotFoundException>(() => ProcessOwner.ResolveApplication("tool"));
        Assert.Contains("'tool'", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NeverSearchesTheCurrentDirectory()
    {
        Tool("workspace", "tool.exe");
        Directory.SetCurrentDirectory(Path.Combine(root, "workspace"));
        Environment.SetEnvironmentVariable("PATH", null);
        Assert.Throws<FileNotFoundException>(() => ProcessOwner.ResolveApplication("tool"));
        SetPath(Path.Combine(root, "elsewhere"));
        Assert.Throws<FileNotFoundException>(() => ProcessOwner.ResolveApplication("tool"));
    }

    [Theory]
    [InlineData(".")]
    [InlineData("")]
    [InlineData("relative")]
    [InlineData("..")]
    public void SkipsRelativePathEntries(string entry)
    {
        Tool("workspace", "tool.exe");
        Directory.CreateDirectory(Path.Combine(root, "workspace", "relative"));
        File.WriteAllText(Path.Combine(root, "workspace", "relative", "tool.exe"), "");
        Directory.CreateDirectory(Path.Combine(root, "workspace", "child"));
        Directory.SetCurrentDirectory(Path.Combine(root, "workspace", string.Equals(entry, "..", StringComparison.Ordinal) ? "child" : ""));
        SetPath(entry);
        Assert.Throws<FileNotFoundException>(() => ProcessOwner.ResolveApplication("tool"));
    }

    [Theory]
    [InlineData("sub/tool.exe")]
    [InlineData("./tool")]
    [InlineData("../tool.exe")]
    [InlineData("c:tool")]
    public void UsesExplicitPathsAsGivenWithoutSearching(string command)
    {
        var tool = Tool("bin", "tool.exe");
        SetPath(Path.GetDirectoryName(tool)!);
        Assert.Equal(Path.GetFullPath(command), ProcessOwner.ResolveApplication(command));
    }

    [Fact]
    public void UsesAnAbsolutePathEvenWhenItDoesNotExist()
    {
        var missing = Path.Combine(root, "nowhere", "tool.exe");
        Assert.Equal(missing, ProcessOwner.ResolveApplication(missing));
    }
}
