using System.Diagnostics;
using Xunit;

namespace Testy.Backend.Tests;

// The extension starts test processes through the process host on Windows only. Its exit
// code and failure prefix are matched by ProcessHostFailure in src/services/process.ts.
public sealed class ProcessHostTests : IDisposable
{
    private const int HostFailure = 125;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);
    private readonly string directory = Directory.CreateTempSubdirectory("testy-host-").FullName;

    public void Dispose()
    {
        // A test process that is still starting can briefly hold an inheritable handle to the probe file.
        try { Directory.Delete(directory, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static string[] PowerShell(string script) => ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];

    // The process is gone, or gone soon: termination is asynchronous with the host's exit.
    private static async Task AssertGone(int pid)
    {
        var deadline = DateTime.UtcNow + Timeout;
        while (true)
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                if (process.HasExited) { return; }
            }
            catch (ArgumentException) { return; }
            Assert.True(DateTime.UtcNow < deadline, $"Process {pid} is still running.");
            await Task.Delay(100, TestContext.Current.CancellationToken);
        }
    }

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

    // The job is the ownership boundary: whatever the command left running dies with it. The
    // command here starts a long-lived grandchild, prints its id and exits at once.
    [Fact]
    public async Task AGrandchildIsKilledWhenTheCommandExits()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        var (exitCode, output, error) = await HelperProcess.Run("Testy.ProcessHost.dll",
            PowerShell("(Start-Process ping.exe -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru).Id"));
        Assert.True(exitCode == 0, error);
        await AssertGone(int.Parse(output.Trim(), System.Globalization.CultureInfo.InvariantCulture));
    }

    // Standard input carries the owner protocol: the extension host closing it (or dying) must end the job.
    [Fact]
    public async Task ClosingTheHostsInputTearsDownTheJob()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        using var host = HelperProcess.Start(HelperProcess.Output("Testy.ProcessHost.dll"),
            PowerShell("[Console]::WriteLine($PID); Start-Sleep -Seconds 300"));
        var first = await host.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask().WaitAsync(Timeout, TestContext.Current.CancellationToken);
        var command = int.Parse(first!, System.Globalization.CultureInfo.InvariantCulture);
        using (var running = Process.GetProcessById(command)) { Assert.False(running.HasExited); }
        host.StandardInput.Close();
        await host.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(Timeout, TestContext.Current.CancellationToken);
        // TerminateJobObject's exit code, not the command's own.
        Assert.Equal(1, host.ExitCode);
        await AssertGone(command);
    }

    // The command receives the three standard handles and nothing else the host itself inherited.
    // The test holds an inheritable handle on a file, which every process it starts inherits
    // (Process.Start passes no handle list); the probe tells whether a process can read through it.
    [Fact]
    public async Task OnlyTheStandardHandlesAreInherited()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "The process host requires Windows.");
        const string Marker = "testy-inherit-probe";
        var file = Path.Combine(directory, "probe.txt");
        await File.WriteAllTextAsync(file, Marker, TestContext.Current.CancellationToken);
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Inheritable);
        var handle = stream.SafeFileHandle.DangerousGetHandle().ToInt64();
        var probe = "try { $h = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new([IntPtr]" + handle + ", $false); $s = [IO.FileStream]::new($h, [IO.FileAccess]::Read, 1, $false); "
            + "$b = New-Object byte[] " + Marker.Length + "; $n = $s.Read($b, 0, $b.Length); [Console]::WriteLine([Text.Encoding]::ASCII.GetString($b, 0, $n)) } catch { [Console]::WriteLine('closed') }";
        // Without the host the probe sees the handle, so a "closed" below means something.
        using (var direct = Process.Start(new ProcessStartInfo(PowerShell(probe)[0], PowerShell(probe)[1..]) { RedirectStandardOutput = true, UseShellExecute = false })!)
        {
            Assert.Equal(Marker, (await direct.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken)).Trim());
            await direct.WaitForExitAsync(TestContext.Current.CancellationToken);
        }
        var (exitCode, output, error) = await HelperProcess.Run("Testy.ProcessHost.dll", PowerShell(probe));
        Assert.True(exitCode == 0, error);
        Assert.Equal("closed", output.Trim());
    }
}
