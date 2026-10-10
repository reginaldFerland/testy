using Xunit;

namespace Testy.Backend.Tests;

// The extension starts test processes through the process host on Windows only. Its exit
// code and failure prefix are matched by ProcessHostFailure in src/services/process.ts.
public sealed class ProcessHostTests
{
    private const int HostFailure = 125;

    [Fact]
    public async Task OutsideWindowsTheHostRefusesToRun()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "The process host runs commands on Windows.");
        var (exitCode, _, error) = await HelperProcess.Run("Testy.ProcessHost.dll", ["dotnet", "--version"]);
        Assert.Equal(HostFailure, exitCode);
        Assert.StartsWith("Testy could not own the process tree: System.PlatformNotSupportedException", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheCommandsExitCodeAndOutputPassThrough()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        var (exitCode, output, _) = await HelperProcess.Run("Testy.ProcessHost.dll", ["cmd.exe", "/c", "echo owned& exit 7"]);
        Assert.Equal(7, exitCode);
        Assert.Equal("owned", output.Trim());
    }

    [Fact]
    public async Task RestoredVariablesReachTheCommand()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        var (exitCode, output, _) = await HelperProcess.Run("Testy.ProcessHost.dll", ["cmd.exe", "/c", "echo %TESTY_PROBE%"],
            new Dictionary<string, string?> { ["TESTY_CHILD_ENV_TESTY_PROBE"] = "restored", ["TESTY_PROBE"] = "host" });
        Assert.Equal(0, exitCode);
        Assert.Equal("restored", output.Trim());
    }

    [Fact]
    public async Task AMissingCommandIsAHostFailure()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        var (exitCode, _, error) = await HelperProcess.Run("Testy.ProcessHost.dll", ["testy-no-such-command"]);
        Assert.Equal(HostFailure, exitCode);
        Assert.StartsWith("Testy could not own the process tree:", error, StringComparison.Ordinal);
        Assert.Contains("was not found on PATH", error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NoCommandIsAHostFailure()
    {
        var (exitCode, _, error) = await HelperProcess.Run("Testy.ProcessHost.dll", []);
        Assert.Equal(HostFailure, exitCode);
        Assert.StartsWith("Testy could not own the process tree:", error, StringComparison.Ordinal);
    }
}
